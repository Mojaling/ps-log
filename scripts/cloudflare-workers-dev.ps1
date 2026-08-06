function Get-LocalWranglerCli {
    $cliPath = Join-Path $projectRoot 'node_modules\wrangler\bin\wrangler.js'
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw 'The local Wrangler CLI was not found. Run "npm.cmd install" and try again.'
    }
    return $cliPath
}

function Get-WranglerWhoAmI {
    # `wrangler whoami` fetches accounts and memberships concurrently. On Windows with
    # Node 24 its shutdown/error path can hit libuv's UV_HANDLE_CLOSING assertion even
    # after OAuth succeeds. Read the credential once, then query the same account API
    # from PowerShell so the unstable Node fetch path is not involved.
    $token = Get-WranglerBearerToken
    try {
        $response = Invoke-RestMethod -Method Get `
            -Uri 'https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50' `
            -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'ps-log-setup-wizard' }
    } catch {
        $statusCode = 0
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = 0 }
        throw "Cloudflare account lookup failed (HTTP $statusCode). Run `"npx.cmd wrangler login`" and try again."
    }
    if (-not $response.success -or -not $response.result -or @($response.result).Count -eq 0) {
        throw 'Wrangler is logged in, but no usable Cloudflare account was found.'
    }
    return [pscustomobject]@{
        loggedIn = $true
        accounts = @($response.result | ForEach-Object {
            [pscustomobject]@{ id = [string]$_.id; name = [string]$_.name }
        })
    }
}

function Resolve-WranglerAccount($WhoAmI, [string]$PreferredAccountId = '') {
    $accounts = @($WhoAmI.accounts)
    if ($PreferredAccountId) {
        $matched = @($accounts | Where-Object { [string]$_.id -eq $PreferredAccountId })
        if ($matched.Count -eq 1) { return $matched[0] }
        throw 'DEPLOY_CF_ACCOUNT_ID does not belong to the currently authenticated Cloudflare user.'
    }
    if ($accounts.Count -eq 1) { return $accounts[0] }
    throw 'Multiple Cloudflare accounts are available. Select an account in the setup wizard or set DEPLOY_CF_ACCOUNT_ID in .env.'
}

function Get-WranglerBearerToken {
    if ($script:wranglerBearerToken) { return [string]$script:wranglerBearerToken }
    $authOutput = @(& node.exe (Get-LocalWranglerCli) auth token --json 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw 'Wrangler could not provide the active Cloudflare credential.'
    }
    try {
        $authResult = (($authOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
    } catch {
        throw 'Wrangler returned an unreadable authentication response.'
    }
    if (-not $authResult.token) {
        throw 'Wrangler did not return a usable Cloudflare credential.'
    }
    $script:wranglerBearerToken = [string]$authResult.token
    return [string]$script:wranglerBearerToken
}

function Get-WorkersDevRegistration([string]$AccountId) {
    if ($AccountId -notmatch '^[a-fA-F0-9]{32}$') {
        throw 'Cloudflare Account ID must contain 32 hexadecimal characters.'
    }

    $token = Get-WranglerBearerToken
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/subdomain"
    $registered = $false
    $subdomain = ''
    try {
        $response = Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Authorization = "Bearer $token" }
        $registered = [bool]($response.success -and $response.result -and [string]$response.result.subdomain)
        if ($registered) { $subdomain = [string]$response.result.subdomain }
    } catch {
        $statusCode = 0
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = 0 }
        if ($statusCode -notin @(400, 404)) {
            throw "Could not check the workers.dev subdomain (HTTP $statusCode)."
        }
    } finally {
        $token = $null
    }

    return [pscustomobject]@{
        Registered = $registered
        Subdomain = $subdomain
        OnboardingUrl = "https://dash.cloudflare.com/$AccountId/workers/onboarding"
    }
}
