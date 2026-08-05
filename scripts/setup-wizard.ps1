$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$envExamplePath = Join-Path $projectRoot '.env.example'

function Write-Step([int]$Number, [string]$Title) {
    Write-Host "`n============================================================"
    Write-Host "[$Number] $Title" -ForegroundColor Cyan
    Write-Host "============================================================"
}

function Confirm-Choice([string]$Prompt, [bool]$DefaultYes = $true) {
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $answer = (Read-Host "$Prompt $hint").Trim().ToLowerInvariant()
        if (-not $answer) { return $DefaultYes }
        if ($answer -in @('y', 'yes')) { return $true }
        if ($answer -in @('n', 'no')) { return $false }
        Write-Host 'Please enter Y or N.' -ForegroundColor Yellow
    }
}

function Stop-Wizard([string]$Message) {
    throw $Message
}

function Read-DotEnv([string]$Path) {
    $result = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $result }
    foreach ($originalLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $originalLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $result[$key] = $value
    }
    return $result
}

function Set-DotEnvValue([string]$Key, [string]$Value) {
    if ($Value -match "[\r\n]") { Stop-Wizard "$Key cannot contain a line break." }
    $source = [IO.File]::ReadAllText($envPath)
    $line = "$Key=$Value"
    $pattern = "(?m)^" + [Regex]::Escape($Key) + "=.*$"
    if ([Regex]::IsMatch($source, $pattern)) {
        $regex = New-Object Text.RegularExpressions.Regex($pattern)
        $source = $regex.Replace($source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $line }, 1)
    } else {
        if ($source -and -not $source.EndsWith("`n")) { $source += "`r`n" }
        $source += "$line`r`n"
    }
    [IO.File]::WriteAllText($envPath, $source, (New-Object Text.UTF8Encoding($false)))
    $script:envValues[$Key] = $Value
}

function Read-Value([string]$Label, [string]$Default = '') {
    $suffix = if ($Default) { " [$Default]" } else { '' }
    $value = (Read-Host "$Label$suffix").Trim()
    if ($value) { return $value }
    return $Default
}

function Read-RequiredValue([string]$Label, [string]$Default = '') {
    while ($true) {
        $value = Read-Value $Label $Default
        if ($value) { return $value }
        Write-Host 'A value is required.' -ForegroundColor Yellow
    }
}

function Read-SecretValue([string]$Label) {
    $secure = Read-Host $Label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Ensure-Secret([string]$Key, [string]$Label) {
    $current = if ($script:envValues.ContainsKey($Key)) { [string]$script:envValues[$Key] } else { '' }
    if ($current -and (Confirm-Choice "$Key is already set. Keep it?" $true)) {
        Write-Host "- ${Key}: kept"
        return
    }
    while ($true) {
        $value = Read-SecretValue $Label
        if ($value) {
            Set-DotEnvValue $Key $value
            Write-Host "- ${Key}: saved to .env"
            return
        }
        Write-Host 'A value is required.' -ForegroundColor Yellow
    }
}

function Open-HelpPage([string]$Name, [string]$Url) {
    if (Confirm-Choice "Open the $Name page in your browser?" $true) {
        Start-Process $Url
    }
}

function Get-ExistingOrDefault([string]$Key, [string]$Fallback) {
    if (-not $script:envValues.ContainsKey($Key)) { return $Fallback }
    $value = [string]$script:envValues[$Key]
    if (-not $value -or $value -match 'YOUR_|your-github-id|본인아이디|레포이름|본인메일') { return $Fallback }
    return $value
}

function New-CronKey {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

try {
    Set-Location $projectRoot
    Write-Host 'PS Log first-time setup wizard' -ForegroundColor Green
    Write-Host 'This wizard writes secrets only to the git-ignored .env file.'

    Write-Step 1 'Prepare .env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $envExamplePath -PathType Leaf)) {
            Stop-Wizard '.env.example was not found.'
        }
        if (-not (Confirm-Choice '.env does not exist. Create it from .env.example?' $true)) {
            Stop-Wizard 'Setup cannot continue without .env.'
        }
        Copy-Item -LiteralPath $envExamplePath -Destination $envPath
        Write-Host 'Created .env.' -ForegroundColor Green
    } else {
        Write-Host '.env found.' -ForegroundColor Green
    }
    $script:envValues = Read-DotEnv $envPath

    Write-Step 2 'Check required programs'
    foreach ($command in @('git.exe', 'node.exe', 'npm.cmd', 'npx.cmd')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            Stop-Wizard "$command was not found. Install Git and Node.js LTS, then run settings.bat again."
        }
    }
    Write-Host "- $(& git.exe --version)"
    Write-Host "- node $(& node.exe --version)"
    Write-Host "- npm $(& npm.cmd --version)"

    $localWrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'
    if (-not (Test-Path -LiteralPath $localWrangler -PathType Leaf)) {
        if (-not (Confirm-Choice 'Project packages are missing. Run npm install now?' $true)) {
            Stop-Wizard 'npm install is required before deployment.'
        }
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { Stop-Wizard "npm install failed with exit code $LASTEXITCODE." }
    }
    & npx.cmd --no-install wrangler --version
    if ($LASTEXITCODE -ne 0) { Stop-Wizard 'Wrangler version check failed.' }
    Write-Host 'Required programs are ready.' -ForegroundColor Green

    Write-Step 3 'Configure the private data repository'
    $existingRepo = Get-ExistingOrDefault 'GITHUB_REPO' ''
    $existingOwner = ''
    $existingRepoName = 'ps-log-data'
    if ($existingRepo -match '^([^/]+)/(.+)$') {
        $existingOwner = $Matches[1]
        $existingRepoName = $Matches[2]
    }
    if ($existingOwner -and (Confirm-Choice 'A private GitHub data repository is already configured in .env. Keep it without displaying the value?' $true)) {
        $owner = $existingOwner
        $repoName = $existingRepoName
    } else {
        $owner = Read-RequiredValue 'GitHub user or organization name' ''
        $repoName = Read-RequiredValue 'Private data repository name' 'ps-log-data'
    }
    $branch = Read-RequiredValue 'Data repository branch' (Get-ExistingOrDefault 'GITHUB_BRANCH' 'master')
    $dataPath = Read-RequiredValue 'Data file path' (Get-ExistingOrDefault 'GITHUB_PATH' 'data.json')
    $workerName = Read-RequiredValue 'Cloudflare Worker name' (Get-ExistingOrDefault 'WORKER_NAME' 'ps-log')
    if ($owner -match '[\s/]' -or $repoName -match '[\s/]') {
        Stop-Wizard 'GitHub owner and repository name cannot contain spaces or slashes.'
    }
    Set-DotEnvValue 'GITHUB_REPO' "$owner/$repoName"
    Set-DotEnvValue 'GITHUB_BRANCH' $branch
    Set-DotEnvValue 'GITHUB_PATH' $dataPath
    Set-DotEnvValue 'WORKER_NAME' $workerName

    Write-Host "`nCreate the PRIVATE data repository you entered."
    Write-Host "Upload data.example.json as '$dataPath' on branch '$branch'."
    Open-HelpPage 'GitHub new repository' 'https://github.com/new'
    if (-not (Confirm-Choice "Is the configured data repository private and does it contain $dataPath?" $false)) {
        Stop-Wizard 'Create the private data repository and data.json, then run settings.bat again.'
    }

    Write-Step 4 'Create two GitHub fine-grained tokens'
    Write-Host 'Both tokens must be limited to the configured PRIVATE data repository.' -ForegroundColor Yellow
    Write-Host 'A. Browser token: Repository permissions > Contents = Read and write.'
    Write-Host '   Do not put this token in .env. Paste it into the deployed web app Settings page.'
    Write-Host 'B. Worker token: Repository permissions > Contents = Read-only.'
    Write-Host '   Paste this token below; it will be stored as GITHUB_TOKEN in .env.'
    Open-HelpPage 'GitHub fine-grained token' 'https://github.com/settings/personal-access-tokens/new'
    if (-not (Confirm-Choice 'Have you created and safely copied the browser Read/Write token?' $false)) {
        Stop-Wizard 'Create the browser Read/Write token, then continue setup.'
    }
    Ensure-Secret 'GITHUB_TOKEN' 'Paste the Worker Read-only GitHub token'

    Write-Step 5 'Configure Resend email'
    Open-HelpPage 'Resend API keys' 'https://resend.com/api-keys'
    Ensure-Secret 'RESEND_API_KEY' 'Paste the Resend API key'
    $mailDefault = Get-ExistingOrDefault 'MAIL_TO' ''
    $mailTo = if ($mailDefault -and (Confirm-Choice 'A recipient email is already configured in .env. Keep it without displaying the value?' $true)) {
        $mailDefault
    } else {
        Read-RequiredValue 'Email address that receives review mail' ''
    }
    Set-DotEnvValue 'MAIL_TO' $mailTo
    $mailFromDefault = Get-ExistingOrDefault 'MAIL_FROM' ''
    $mailFrom = if ($mailFromDefault -and (Confirm-Choice 'MAIL_FROM is already configured. Keep it without displaying the value?' $true)) {
        $mailFromDefault
    } else {
        Read-Value 'MAIL_FROM (leave empty to use the Worker default)' ''
    }
    Set-DotEnvValue 'MAIL_FROM' $mailFrom

    Write-Step 6 'Create the CRON admin key'
    $existingCron = if ($script:envValues.ContainsKey('CRON_KEY')) { [string]$script:envValues['CRON_KEY'] } else { '' }
    if ($existingCron -and (Confirm-Choice 'CRON_KEY is already set. Keep it?' $true)) {
        Write-Host '- CRON_KEY: kept'
    } else {
        if (Confirm-Choice 'Generate a secure CRON_KEY automatically?' $true) {
            $cronKey = New-CronKey
        } else {
            $cronKey = Read-SecretValue 'Enter CRON_KEY'
            if (-not $cronKey) { Stop-Wizard 'CRON_KEY cannot be empty.' }
        }
        Set-DotEnvValue 'CRON_KEY' $cronKey
        Write-Host "CRON_KEY: $cronKey" -ForegroundColor Yellow
        Write-Host 'Copy this key safely. Enter it in the web app Settings page to view usage.'
    }

    Write-Step 7 'Connect Wrangler to Cloudflare'
    $env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CF_ACCOUNT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    & npx.cmd --no-install wrangler whoami *> $null
    if ($LASTEXITCODE -ne 0) {
        if (-not (Confirm-Choice 'Wrangler is not logged in. Start browser login now?' $true)) {
            Stop-Wizard 'Cloudflare login is required for deployment.'
        }
        & npx.cmd --no-install wrangler login
        if ($LASTEXITCODE -ne 0) { Stop-Wizard "Cloudflare login failed with exit code $LASTEXITCODE." }
    } else {
        Write-Host 'Cloudflare authentication confirmed (account details hidden).' -ForegroundColor Green
    }

    Write-Host "`nOptional: Cloudflare usage counts need an API token with Account Analytics Read."
    if (Confirm-Choice 'Configure optional Cloudflare usage API access? (N recommended)' $false) {
        Open-HelpPage 'Cloudflare API tokens' 'https://dash.cloudflare.com/profile/api-tokens'
        Ensure-Secret 'WORKER_CF_API_TOKEN' 'Paste the Cloudflare analytics API token'
        $accountDefault = Get-ExistingOrDefault 'WORKER_CF_ACCOUNT_ID' ''
        Set-DotEnvValue 'WORKER_CF_ACCOUNT_ID' (Read-RequiredValue 'Cloudflare Account ID' $accountDefault)
    }

    Write-Step 8 'Validate and deploy'
    Write-Host 'GitHub data repository : configured (value hidden)'
    Write-Host "Branch / path          : $($script:envValues['GITHUB_BRANCH']) / $($script:envValues['GITHUB_PATH'])"
    Write-Host "Worker name            : $($script:envValues['WORKER_NAME'])"
    Write-Host "Web version            : 1.0.0 (initial deployment keeps this version)"
    Write-Host "`nChecking Cloudflare authentication and the Worker bundle through the same path as deployment."
    Write-Host 'This preflight does not deploy, increase the version, or update secrets.'
    $deployBat = Join-Path $projectRoot 're_settings.bat'
    $checkCommand = '"' + $deployBat + '" --check --no-pause'
    & cmd.exe /d /c $checkCommand
    if ($LASTEXITCODE -ne 0) { Stop-Wizard 'Deployment preflight failed. Resolve the error above before deploying.' }
    Write-Host 'Deployment preflight passed. Cloudflare authentication and the Worker build are ready.' -ForegroundColor Green
    if (-not (Confirm-Choice 'Run re_settings.bat and deploy now?' $true)) {
        Write-Host 'Settings were saved. Run re_settings.bat when you are ready.'
        exit 0
    }
    $deployCommand = '"' + $deployBat + '" --no-bump --no-pause'
    & cmd.exe /d /c $deployCommand
    if ($LASTEXITCODE -ne 0) { Stop-Wizard "Deployment failed with exit code $LASTEXITCODE." }

    Write-Host "`nSetup completed." -ForegroundColor Green
    Write-Host 'Next: open the deployed app Settings and enter the browser Read/Write token.'
    Write-Host 'For future deployments, run re_settings.bat. It automatically increases the web version.'
    exit 0
} catch {
    [Console]::Error.WriteLine("[ERROR] $($_.Exception.Message)")
    exit 1
}
