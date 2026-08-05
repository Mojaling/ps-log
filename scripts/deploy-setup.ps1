param(
    [switch]$ValidateOnly,
    [switch]$NoVersionBump
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'

function Stop-Setup([string]$Message) {
    throw $Message
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
    if ($null -eq $InputValue) {
        & npx.cmd @Arguments
    } else {
        $InputValue | & npx.cmd @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        Stop-Setup "Wrangler failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        Stop-Setup 'The project root does not contain .env. Copy .env.example and fill it in.'
    }
    if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
        Stop-Setup 'npx.cmd was not found. Install Node.js and run npm.cmd install first.'
    }

    $envValues = Read-DotEnv $envPath
    $defaults = @{
        GITHUB_BRANCH = 'master'
        GITHUB_PATH = 'data.json'
        WORKER_NAME = 'ps-log'
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
    if ($ValidateOnly) {
        Write-Host '.env and deployment script validation passed.'
        exit 0
    }

    # Wrangler automatically reads a root .env file and treats CF_API_TOKEN as
    # its own deployment credential. These values belong to the deployed Worker
    # analytics feature, so keep them away from Wrangler authentication and use
    # the OAuth login created by `wrangler login` instead.
    $env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CF_ACCOUNT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue

    Push-Location $projectRoot
    try {
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
        $deployArguments = @('--no-install', 'wrangler', 'deploy')
        foreach ($key in @('GITHUB_REPO', 'GITHUB_BRANCH', 'GITHUB_PATH', 'WORKER_NAME')) {
            $deployArguments += '--var'
            $deployArguments += "${key}:$($envValues[$key])"
        }
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
            $secretArguments = @('--no-install', 'wrangler', 'secret', 'put', $secretName)
            Invoke-Wrangler -Arguments $secretArguments -InputValue ([string]$secretValue)
        }
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
