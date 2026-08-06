param(
    [switch]$ValidateOnly,
    [switch]$CheckOnly,
    [switch]$NoVersionBump
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
. (Join-Path $PSScriptRoot 'cloudflare-workers-dev.ps1')

function Stop-Setup([string]$Message) {
    throw $Message
}

# The version number is a product of deploying. Bumping it without committing left the
# working tree dirty after every deploy, so the next `git pull` refused to run. Commit
# just this one file once the deploy has actually succeeded.
#
# Committing must never fail the deploy: the Worker is already live by this point, and a
# missing git identity or an in-progress rebase is the user's business, not a deploy error.
function Save-VersionBumpCommit([string]$VersionPath) {
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { return }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git.exe -C $projectRoot rev-parse --is-inside-work-tree 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { return }

        # No output means the file matches HEAD and there is nothing to record.
        $status = & git.exe -C $projectRoot status --porcelain -- $VersionPath 2>&1
        if ($LASTEXITCODE -ne 0 -or -not ($status -join '').Trim()) { return }

        $version = 'unknown'
        $source = [IO.File]::ReadAllText($VersionPath)
        if ($source -match 'APP_VERSION\s*=\s*[''"]([^''"]+)[''"]') { $version = $Matches[1] }

        # --only <path> commits this file alone, so work in progress elsewhere is left
        # untouched even if the user already staged something else.
        $output = & git.exe -C $projectRoot commit --only -m "chore: deploy web version $version" -- $VersionPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "- version.js: bumped to $version but could not be committed. Commit it yourself to keep git pull working." -ForegroundColor Yellow
            Write-Host "  git reason: $(($output -join ' ').Trim())" -ForegroundColor DarkGray
            return
        }
        Write-Host "- version.js: committed as web version $version (not pushed)." -ForegroundColor Green
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Read-DotEnv([string]$Path) {
    $values = @{}
    $lineNumber = 0

    foreach ($originalLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $lineNumber++
        $line = $originalLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }

        $separator = $line.IndexOf('=')
        if ($separator -lt 1) {
            Stop-Setup ".env line $lineNumber must use KEY=VALUE format."
        }

        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($key -notmatch '^[A-Z_][A-Z0-9_]*$') {
            Stop-Setup ".env line $lineNumber has an invalid key: $key"
        }

        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $values[$key] = $value
    }
    return $values
}

function Invoke-Wrangler([string[]]$Arguments, [AllowNull()][string]$InputValue = $null) {
    $wranglerCli = Get-LocalWranglerCli
    if ($null -eq $InputValue) {
        & node.exe $wranglerCli @Arguments
    } else {
        $InputValue | & node.exe $wranglerCli @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        Stop-Setup "Wrangler failed with exit code $LASTEXITCODE."
    }
}

function Get-WranglerAuthenticationType {
    # Wrangler prints the active credential with this command. Keep the full
    # response in memory and return only its non-secret authentication type.
    $authOutput = @(& node.exe (Get-LocalWranglerCli) auth token --json 2>$null)
    if ($LASTEXITCODE -ne 0) {
        Stop-Setup 'Cloudflare authentication was not found. Run "npx.cmd wrangler login" or set DEPLOY_CF_API_TOKEN and DEPLOY_CF_ACCOUNT_ID in .env.'
    }

    try {
        $authResult = (($authOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
    } catch {
        Stop-Setup 'Wrangler returned an unreadable authentication response. Run "npx.cmd wrangler login" and try again.'
    }
    if (-not $authResult.type -or -not $authResult.token) {
        Stop-Setup 'Wrangler did not return a usable Cloudflare credential. Run "npx.cmd wrangler login" and try again.'
    }

    $authenticationType = [string]$authResult.type
    $script:wranglerBearerToken = [string]$authResult.token
    $authResult = $null
    $authOutput = $null
    return $authenticationType
}

try {
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        Stop-Setup 'The project root does not contain .env. Copy .env.example and fill it in.'
    }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Stop-Setup 'node.exe was not found. Install Node.js and run npm.cmd install first.'
    }
    $null = Get-LocalWranglerCli

    $envValues = Read-DotEnv $envPath
    $defaults = @{
        GITHUB_BRANCH = 'master'
        GITHUB_PATH = 'data.json'
        WORKER_NAME = 'ps-log'
        TEAM_API_BASE = ''
    }
    foreach ($key in $defaults.Keys) {
        if (-not $envValues.ContainsKey($key) -or -not $envValues[$key]) {
            $envValues[$key] = $defaults[$key]
        }
    }

    $required = @('GITHUB_REPO', 'GITHUB_TOKEN', 'RESEND_API_KEY', 'MAIL_TO', 'CRON_KEY')
    $missing = @($required | Where-Object { -not $envValues.ContainsKey($_) -or -not $envValues[$_] })
    if ($missing.Count -gt 0) {
        Stop-Setup "Required .env values are missing: $($missing -join ', ')"
    }
    if ($envValues['GITHUB_REPO'] -notmatch '^[^/\s]+/[^/\s]+$') {
        Stop-Setup 'GITHUB_REPO must use owner/repository format.'
    }
    $hasDeployToken = $envValues.ContainsKey('DEPLOY_CF_API_TOKEN') -and $envValues['DEPLOY_CF_API_TOKEN']
    $hasDeployAccount = $envValues.ContainsKey('DEPLOY_CF_ACCOUNT_ID') -and $envValues['DEPLOY_CF_ACCOUNT_ID']
    if ($hasDeployToken -and -not $hasDeployAccount) {
        Stop-Setup 'DEPLOY_CF_ACCOUNT_ID is required when DEPLOY_CF_API_TOKEN is set.'
    }
    if ($ValidateOnly) {
        Write-Host '.env and deployment script validation passed.'
        exit 0
    }

    # Do not let Wrangler interpret Worker analytics secrets as deployment
    # credentials. Deployment tokens use separate DEPLOY_CF_* names.
    $env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CF_ACCOUNT_ID -ErrorAction SilentlyContinue
    $deployApiToken = if ($envValues.ContainsKey('DEPLOY_CF_API_TOKEN')) { [string]$envValues['DEPLOY_CF_API_TOKEN'] } else { '' }
    $deployAccountId = if ($envValues.ContainsKey('DEPLOY_CF_ACCOUNT_ID')) { [string]$envValues['DEPLOY_CF_ACCOUNT_ID'] } else { '' }
    if ($deployApiToken) {
        if (-not $deployAccountId) {
            Stop-Setup 'DEPLOY_CF_ACCOUNT_ID is required when DEPLOY_CF_API_TOKEN is set.'
        }
        $env:CLOUDFLARE_API_TOKEN = $deployApiToken
        $env:CLOUDFLARE_ACCOUNT_ID = $deployAccountId
        Write-Host 'Wrangler authentication: Cloudflare deployment API token'
    } else {
        Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
        if ($deployAccountId) {
            $env:CLOUDFLARE_ACCOUNT_ID = $deployAccountId
        } else {
            Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
        }
        Write-Host 'Wrangler authentication: OAuth login'
    }

    $authenticationType = Get-WranglerAuthenticationType
    Write-Host "Cloudflare authentication verified: $authenticationType (credential hidden)"

    $whoAmI = Get-WranglerWhoAmI
    $cloudflareAccount = Resolve-WranglerAccount -WhoAmI $whoAmI -PreferredAccountId $deployAccountId
    $workersDev = Get-WorkersDevRegistration -AccountId ([string]$cloudflareAccount.id)
    if (-not $workersDev.Registered) {
        Stop-Setup "The Cloudflare account does not have a workers.dev subdomain. Register it first: $($workersDev.OnboardingUrl)"
    }
    Write-Host 'Cloudflare workers.dev subdomain verified (address hidden)'

    Push-Location $projectRoot
    try {
        $deployArguments = @('deploy', '--name', [string]$envValues['WORKER_NAME'])
        foreach ($key in @('GITHUB_REPO', 'GITHUB_BRANCH', 'GITHUB_PATH', 'WORKER_NAME', 'TEAM_API_BASE')) {
            $deployArguments += '--var'
            $deployArguments += "${key}:$($envValues[$key])"
        }

        if ($CheckOnly) {
            Write-Host 'Checking the Worker bundle without deploying...'
            $deployArguments += '--dry-run'
            Invoke-Wrangler -Arguments $deployArguments
            Write-Host 'Cloudflare authentication and Worker dry-run passed. No deployment, version, or secret changes were made.'
            exit 0
        }

        $versionPath = Join-Path $projectRoot 'public\version.js'
        $originalVersionSource = $null
        $codeWasDeployed = $false
        if (-not $NoVersionBump) {
            if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) {
                Stop-Setup 'public/version.js was not found.'
            }
            $originalVersionSource = [IO.File]::ReadAllText($versionPath)
            Write-Host '[1/3] Increasing the web version...'
            & node (Join-Path $projectRoot 'scripts\bump-version.mjs') $versionPath
            if ($LASTEXITCODE -ne 0) {
                Stop-Setup "Version update failed with exit code $LASTEXITCODE."
            }
        } else {
            Write-Host '[1/3] Keeping the initial web version...'
        }

        Write-Host "`n[2/3] Deploying Worker code and variables..."
        Invoke-Wrangler -Arguments $deployArguments
        $codeWasDeployed = $true

        Write-Host "`n[3/3] Updating Worker secrets..."
        $secretMappings = @(
            @{ Secret = 'GITHUB_TOKEN'; Source = 'GITHUB_TOKEN' },
            @{ Secret = 'RESEND_API_KEY'; Source = 'RESEND_API_KEY' },
            @{ Secret = 'MAIL_TO'; Source = 'MAIL_TO' },
            @{ Secret = 'CRON_KEY'; Source = 'CRON_KEY' },
            @{ Secret = 'MAIL_FROM'; Source = 'MAIL_FROM' },
            @{ Secret = 'CF_API_TOKEN'; Source = 'WORKER_CF_API_TOKEN'; Legacy = 'CF_API_TOKEN' },
            @{ Secret = 'CF_ACCOUNT_ID'; Source = 'WORKER_CF_ACCOUNT_ID'; Legacy = 'CF_ACCOUNT_ID' }
        )
        foreach ($mapping in $secretMappings) {
            $secretName = $mapping.Secret
            $sourceName = $mapping.Source
            $secretValue = if ($envValues.ContainsKey($sourceName)) { $envValues[$sourceName] } else { '' }
            if (-not $secretValue -and $mapping.Legacy -and $envValues.ContainsKey($mapping.Legacy)) {
                $secretValue = $envValues[$mapping.Legacy]
            }
            if (-not $secretValue) {
                Write-Host "- ${secretName}: skipped (empty)"
                continue
            }
            Write-Host "- ${secretName}: updating"
            $secretArguments = @('secret', 'put', $secretName, '--name', [string]$envValues['WORKER_NAME'])
            Invoke-Wrangler -Arguments $secretArguments -InputValue ([string]$secretValue)
        }

        if (-not $NoVersionBump) { Save-VersionBumpCommit $versionPath }
    } catch {
        if ($originalVersionSource -and -not $codeWasDeployed) {
            [IO.File]::WriteAllText($versionPath, $originalVersionSource, [Text.UTF8Encoding]::new($false))
            Write-Host 'Deployment failed before publishing; the version number was restored.'
        }
        throw
    } finally {
        Pop-Location
    }

    Write-Host "`nAll deployment tasks completed."
    exit 0
} catch {
    [Console]::Error.WriteLine("[ERROR] $($_.Exception.Message)")
    exit 1
}
