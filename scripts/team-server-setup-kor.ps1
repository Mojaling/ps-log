$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$teamEnvPath = Join-Path $projectRoot '.team.env'
$teamEnvExamplePath = Join-Path $projectRoot '.team.env.example'
$generatedConfigPath = Join-Path $projectRoot 'wrangler.team.local.jsonc'
. (Join-Path $PSScriptRoot 'cloudflare-workers-dev.ps1')

function Stop-TeamSetup([string]$Message) { throw $Message }

function Confirm-Choice([string]$Prompt, [bool]$DefaultYes = $true) {
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $answer = (Read-Host "$Prompt $hint").Trim().ToLowerInvariant()
        if (-not $answer) { return $DefaultYes }
        if ($answer -in @('y', 'yes')) { return $true }
        if ($answer -in @('n', 'no')) { return $false }
        Write-Host 'Y 또는 N을 입력해 주세요.' -ForegroundColor Yellow
    }
}

function Read-Values([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }
    foreach ($sourceLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $sourceLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
    return $values
}

function Set-Value([string]$Key, [string]$Value) {
    if ($Value -match "[\r\n]") { Stop-TeamSetup "$Key 값에 줄바꿈을 넣을 수 없습니다." }
    $source = [IO.File]::ReadAllText($teamEnvPath)
    $line = "$Key=$Value"
    $pattern = '(?m)^' + [Regex]::Escape($Key) + '=.*$'
    if ([Regex]::IsMatch($source, $pattern)) {
        $source = ([Regex]$pattern).Replace($source, $line, 1)
    } else {
        if ($source -and -not $source.EndsWith("`n")) { $source += "`r`n" }
        $source += "$line`r`n"
    }
    [IO.File]::WriteAllText($teamEnvPath, $source, [Text.UTF8Encoding]::new($false))
    $script:teamValues[$Key] = $Value
}

function Existing([string]$Key, [string]$Fallback = '') {
    if ($script:teamValues.ContainsKey($Key) -and [string]$script:teamValues[$Key]) { return [string]$script:teamValues[$Key] }
    return $Fallback
}

function Required([string]$Label, [string]$Default = '') {
    while ($true) {
        $suffix = if ($Default) { " [$Default]" } else { '' }
        $value = (Read-Host "$Label$suffix").Trim()
        if ($value) { return $value }
        if ($Default) { return $Default }
        Write-Host '필수 입력값입니다.' -ForegroundColor Yellow
    }
}

function Secret([string]$Label) {
    $secure = Read-Host $Label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Random-Hex([int]$Length = 64) {
    $bytes = New-Object byte[] ([Math]::Ceiling($Length / 2))
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, $Length)
}

function Invoke-Wrangler([string[]]$Arguments, [AllowNull()][string]$InputValue = $null, [switch]$Capture) {
    $cli = Get-LocalWranglerCli
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($null -eq $InputValue) { $output = @(& node.exe $cli @Arguments 2>&1) }
        else { $output = @($InputValue | & node.exe $cli @Arguments 2>&1) }
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($exitCode -ne 0) {
        $safeOutput = ($output | ForEach-Object { [string]$_ }) -join "`n"
        Stop-TeamSetup "Wrangler 실패 (종료 코드 $exitCode):`n$safeOutput"
    }
    if ($Capture) { return ($output | ForEach-Object { [string]$_ }) -join "`n" }
    $output | Out-Host
}

function Select-Account($WhoAmI, [string]$Preferred) {
    $accounts = @($WhoAmI.accounts)
    if ($Preferred) {
        $match = @($accounts | Where-Object { [string]$_.id -eq $Preferred })
        if ($match.Count -eq 1) { return $match[0] }
    }
    if ($accounts.Count -eq 1) { return $accounts[0] }
    for ($index = 0; $index -lt $accounts.Count; $index++) {
        Write-Host ("{0}. {1}" -f ($index + 1), [string]$accounts[$index].name)
    }
    while ($true) {
        $choice = 0
        if ([int]::TryParse((Read-Host 'Cloudflare 계정 번호'), [ref]$choice) -and $choice -ge 1 -and $choice -le $accounts.Count) {
            return $accounts[$choice - 1]
        }
    }
}

try {
    Set-Location $projectRoot
    Write-Host 'PS Log 팀장용 중앙 랭킹 서버 설정' -ForegroundColor Green
    Write-Host '이 작업은 개인 PS Log Worker와 별도의 Worker + D1을 만듭니다.'

    if (-not (Test-Path -LiteralPath $teamEnvPath -PathType Leaf)) {
        if (-not (Confirm-Choice '.team.env를 새로 만들까요?' $true)) { Stop-TeamSetup '.team.env가 필요합니다.' }
        Copy-Item -LiteralPath $teamEnvExamplePath -Destination $teamEnvPath
    }
    $script:teamValues = Read-Values $teamEnvPath
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Stop-TeamSetup 'Node.js가 필요합니다.' }
    $null = Get-LocalWranglerCli

    $whoAmI = $null
    try { $whoAmI = Get-WranglerWhoAmI } catch { $whoAmI = $null }
    if (-not $whoAmI) {
        if (-not (Confirm-Choice 'Cloudflare 브라우저 로그인을 실행할까요?' $true)) { Stop-TeamSetup 'Cloudflare 로그인이 필요합니다.' }
        # Node 24/Windows에서 OAuth가 저장된 뒤 프로세스 종료 중 libuv assertion이 날 수 있다.
        # login 종료 코드가 아니라, 기존 개인 설정 마법사와 같은 안전한 계정 API로 실제 인증을 재확인한다.
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & node.exe (Get-LocalWranglerCli) login | Out-Host; $loginExitCode = $LASTEXITCODE }
        finally { $ErrorActionPreference = $previous }
        try { $whoAmI = Get-WranglerWhoAmI }
        catch { Stop-TeamSetup "Cloudflare 로그인 실패: 종료 코드 $loginExitCode. 브라우저 인증을 완료한 뒤 다시 실행하세요." }
    }
    $account = Select-Account $whoAmI (Existing 'DEPLOY_CF_ACCOUNT_ID')
    Set-Value 'DEPLOY_CF_ACCOUNT_ID' ([string]$account.id)
    $env:CLOUDFLARE_ACCOUNT_ID = [string]$account.id
    $workersDev = Get-WorkersDevRegistration -AccountId ([string]$account.id)
    if (-not $workersDev.Registered) {
        Start-Process $workersDev.OnboardingUrl
        Stop-TeamSetup '브라우저에서 workers.dev 서브도메인을 등록한 뒤 다시 실행하세요.'
    }

    $workerName = Required '중앙 팀 Worker 이름' (Existing 'TEAM_WORKER_NAME' 'ps-log-team')
    $dbName = Required 'D1 데이터베이스 이름' (Existing 'TEAM_DB_NAME' 'ps-log-team')
    $teamName = Required '랭킹 화면에 표시할 팀 이름' (Existing 'TEAM_NAME' 'PS Log Team')
    $seasonKey = Required '시즌 식별자' (Existing 'SEASON_KEY' 'season-1')
    if ($workerName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') { Stop-TeamSetup 'Worker 이름 형식이 올바르지 않습니다.' }
    Set-Value 'TEAM_WORKER_NAME' $workerName
    Set-Value 'TEAM_DB_NAME' $dbName
    Set-Value 'TEAM_NAME' $teamName
    Set-Value 'SEASON_KEY' $seasonKey
    $teamUrl = "https://$($workerName.ToLowerInvariant()).$($workersDev.Subdomain).workers.dev"

    $databaseId = Existing 'TEAM_D1_DATABASE_ID'
    if (-not $databaseId) {
        Write-Host "`nD1 데이터베이스를 생성합니다."
        $bootstrapConfig = [ordered]@{
            name = $workerName; main = 'team-worker/index.js'; compatibility_date = '2026-07-01'; workers_dev = $true
        }
        [IO.File]::WriteAllText($generatedConfigPath, ($bootstrapConfig | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        Invoke-Wrangler @('d1', 'create', $dbName, '--binding', 'DB', '--update-config', '--config', $generatedConfigPath)
        $createdConfig = [IO.File]::ReadAllText($generatedConfigPath) | ConvertFrom-Json
        $databaseId = [string]$createdConfig.d1_databases[0].database_id
        if ($databaseId -notmatch '^[a-fA-F0-9-]{36}$') { Stop-TeamSetup 'D1 생성 결과에서 database_id를 찾지 못했습니다.' }
        Set-Value 'TEAM_D1_DATABASE_ID' $databaseId
    }
    if ($databaseId -notmatch '^[a-fA-F0-9-]{36}$') { Stop-TeamSetup 'TEAM_D1_DATABASE_ID 형식이 올바르지 않습니다.' }

    Write-Host "`nGitHub OAuth App을 중앙 서버 전용으로 하나 만듭니다." -ForegroundColor Cyan
    Write-Host "Homepage URL              : $teamUrl"
    Write-Host "Authorization callback URL: $teamUrl/v1/auth/callback" -ForegroundColor Yellow
    if (Confirm-Choice 'GitHub OAuth App 생성 페이지를 열까요?' $true) {
        Start-Process 'https://github.com/settings/applications/new'
    }
    $clientId = Existing 'GITHUB_CLIENT_ID'
    if (-not $clientId -or -not (Confirm-Choice '기존 GITHUB_CLIENT_ID를 사용할까요?' $true)) {
        $clientId = Required 'OAuth App Client ID' ''
        Set-Value 'GITHUB_CLIENT_ID' $clientId
    }
    $clientSecret = Existing 'GITHUB_CLIENT_SECRET'
    if (-not $clientSecret -or -not (Confirm-Choice '기존 GITHUB_CLIENT_SECRET을 사용할까요?' $true)) {
        $clientSecret = Secret 'OAuth App Client secret을 붙여넣으세요'
        if (-not $clientSecret) { Stop-TeamSetup 'Client secret은 필수입니다.' }
        Set-Value 'GITHUB_CLIENT_SECRET' $clientSecret
    }
    $adminKey = Existing 'ADMIN_KEY'
    if (-not $adminKey) { $adminKey = Random-Hex 64; Set-Value 'ADMIN_KEY' $adminKey }
    $pepper = Existing 'SESSION_PEPPER'
    if (-not $pepper) { $pepper = Random-Hex 64; Set-Value 'SESSION_PEPPER' $pepper }

    $config = [ordered]@{
        name = $workerName
        main = 'team-worker/index.js'
        compatibility_date = '2026-07-01'
        workers_dev = $true
        triggers = @{ crons = @('10 15 * * *') }
        d1_databases = @(@{
            binding = 'DB'; database_name = $dbName; database_id = $databaseId; migrations_dir = 'migrations/team'
        })
        vars = @{ TEAM_NAME = $teamName; SEASON_KEY = $seasonKey; MAX_MEMBERS = '30'; TEAM_PUBLIC_URL = $teamUrl; GITHUB_CLIENT_ID = $clientId }
        observability = @{ enabled = $true }
    }
    [IO.File]::WriteAllText($generatedConfigPath, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))

    Write-Host "`n[1/3] D1 마이그레이션 적용"
    Invoke-Wrangler @('d1', 'migrations', 'apply', $dbName, '--remote', '--config', $generatedConfigPath)
    Write-Host "`n[2/3] 중앙 Worker 배포"
    Invoke-Wrangler @('deploy', '--config', $generatedConfigPath)
    Write-Host "`n[3/3] 중앙 Worker 비밀키 등록"
    foreach ($secret in @(
        @{Name='GITHUB_CLIENT_SECRET'; Value=$clientSecret},
        @{Name='ADMIN_KEY'; Value=$adminKey},
        @{Name='SESSION_PEPPER'; Value=$pepper}
    )) {
        Invoke-Wrangler @('secret', 'put', $secret.Name, '--config', $generatedConfigPath) ([string]$secret.Value)
    }

    $health = Invoke-RestMethod -Method Get -Uri "$teamUrl/v1/health"
    if (-not $health.ok) { Stop-TeamSetup '배포 후 health 확인에 실패했습니다.' }
    $headers = @{ Authorization = "Bearer $adminKey"; 'Content-Type' = 'application/json' }
    $invite = Invoke-RestMethod -Method Post -Uri "$teamUrl/v1/admin/invites" -Headers $headers `
        -Body '{"label":"leader","maxUses":1,"expiresInHours":24}'

    Write-Host "`n중앙 랭킹 서버 배포가 완료됐습니다." -ForegroundColor Green
    Write-Host "팀 서버 주소: $teamUrl" -ForegroundColor Cyan
    Write-Host "팀장 참가용 일회용 초대 코드: $($invite.code)" -ForegroundColor Yellow
    Write-Host '추가 팀원 초대 코드는 README의 관리자 명령으로 한 명씩 발급하세요.'

    $personalEnvPath = Join-Path $projectRoot '.env'
    if ((Test-Path -LiteralPath $personalEnvPath) -and (Confirm-Choice '이 프로젝트의 개인 Worker도 지금 만든 팀 서버에 연결하도록 .env를 갱신할까요?' $true)) {
        $originalTeamPath = $teamEnvPath
        $teamEnvPath = $personalEnvPath
        Set-Value 'TEAM_API_BASE' $teamUrl
        Set-Value 'TEAM_JOIN_INVITE' ([string]$invite.code)
        $teamEnvPath = $originalTeamPath
        Write-Host '개인 Worker 연결값을 저장했습니다. re_settings.bat으로 개인 Worker를 재배포하세요.' -ForegroundColor Green
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("[오류] $($_.Exception.Message)")
    exit 1
}
