$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$envExamplePath = Join-Path $projectRoot '.env.example'
$dataExamplePath = Join-Path $projectRoot 'data.example.json'

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
        Write-Host 'Y 또는 N을 입력해 주세요.' -ForegroundColor Yellow
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
    if ($Value -match "[\r\n]") { Stop-Wizard "$Key 값에는 줄바꿈을 넣을 수 없습니다." }
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
        Write-Host '필수 입력값입니다.' -ForegroundColor Yellow
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
    if ($current -and (Confirm-Choice "$Key 값이 이미 있습니다. 기존 값을 사용할까요?" $true)) {
        Write-Host "- ${Key}: 기존 값 유지"
        return
    }
    while ($true) {
        $value = Read-SecretValue $Label
        if ($value) {
            Set-DotEnvValue $Key $value
            Write-Host "- ${Key}: .env에 저장했습니다."
            return
        }
        Write-Host '필수 입력값입니다.' -ForegroundColor Yellow
    }
}

function Open-HelpPage([string]$Name, [string]$Url) {
    if (Confirm-Choice "$Name 페이지를 브라우저로 열까요?" $true) {
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

function Find-GitHubCli {
    $command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($command) { return [string]$command.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return ''
}

function Ensure-GitHubCli {
    $path = Find-GitHubCli
    if ($path) { return $path }

    Write-Host 'data.json 자동 업로드에는 GitHub 공식 CLI(gh)가 필요합니다.' -ForegroundColor Yellow
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget -and (Confirm-Choice '지금 winget으로 GitHub CLI를 설치할까요?' $true)) {
        & winget.exe install --id GitHub.cli --exact --source winget --accept-package-agreements --accept-source-agreements | Out-Host
        if ($LASTEXITCODE -ne 0) { Stop-Wizard "GitHub CLI 설치 실패: 종료 코드 $LASTEXITCODE" }
        $path = Find-GitHubCli
        if ($path) { return $path }
    }

    Open-HelpPage 'GitHub CLI 설치' 'https://cli.github.com/'
    Stop-Wizard 'GitHub CLI 설치 후 settings_kor.bat을 다시 실행하세요.'
}

function Ensure-GitHubCliLogin([string]$GhPath) {
    & $GhPath auth status --hostname github.com *> $null
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host 'GitHub CLI 로그인이 필요합니다. 브라우저에서 GitHub 로그인을 진행합니다.'
    & $GhPath auth login --hostname github.com --web --git-protocol https
    if ($LASTEXITCODE -ne 0) { Stop-Wizard "GitHub CLI 로그인 실패: 종료 코드 $LASTEXITCODE" }
}

function Get-HttpStatusCode($ErrorRecord) {
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
}

function Convert-ToGitHubPath([string]$Path) {
    return (($Path -split '/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

function Publish-InitialDataFile([string]$Owner, [string]$Repo, [string]$Branch, [string]$DataPath, [string]$Token) {
    if (-not (Test-Path -LiteralPath $dataExamplePath -PathType Leaf)) {
        Stop-Wizard '프로젝트 루트에서 data.example.json을 찾을 수 없습니다.'
    }

    $headers = @{
        Accept = 'application/vnd.github+json'
        Authorization = "Bearer $Token"
        'X-GitHub-Api-Version' = '2026-03-10'
        'User-Agent' = 'ps-log-setup-wizard'
    }
    $repoApi = "https://api.github.com/repos/$([Uri]::EscapeDataString($Owner))/$([Uri]::EscapeDataString($Repo))"
    try {
        $repoInfo = Invoke-RestMethod -Method Get -Uri $repoApi -Headers $headers
    } catch {
        $status = Get-HttpStatusCode $_
        if ($status -eq 404) {
            Stop-Wizard '저장소를 찾지 못했습니다. 저장소가 존재하는지, GitHub CLI로 올바른 계정에 로그인했는지 확인하세요.'
        }
        Stop-Wizard "GitHub 저장소 확인에 실패했습니다. HTTP $status"
    }

    if (-not [bool]$repoInfo.private) {
        Stop-Wizard '입력한 데이터 저장소가 공개 상태입니다. 반드시 Private로 변경한 뒤 다시 실행하세요.'
    }

    $defaultBranch = [string]$repoInfo.default_branch
    $repoIsEmpty = ([int64]$repoInfo.size -eq 0)
    if ($repoIsEmpty) {
        if ($defaultBranch -and $Branch -ne $defaultBranch) {
            Write-Host "비어 있는 저장소의 기본 브랜치는 '$defaultBranch'입니다. .env 브랜치도 이 값으로 맞춥니다."
            $Branch = $defaultBranch
            Set-DotEnvValue 'GITHUB_BRANCH' $Branch
        }
    } else {
        $branchApi = "$repoApi/branches/$([Uri]::EscapeDataString($Branch))"
        try {
            $null = Invoke-RestMethod -Method Get -Uri $branchApi -Headers $headers
        } catch {
            if ((Get-HttpStatusCode $_) -ne 404) { throw }
            if ($defaultBranch -and (Confirm-Choice "'$Branch' 브랜치가 없습니다. 기본 브랜치 '$defaultBranch'를 사용할까요?" $true)) {
                $Branch = $defaultBranch
                Set-DotEnvValue 'GITHUB_BRANCH' $Branch
            } else {
                Stop-Wizard '존재하는 데이터 저장소 브랜치를 입력한 뒤 다시 실행하세요.'
            }
        }
    }

    $encodedPath = Convert-ToGitHubPath $DataPath
    $contentApi = "$repoApi/contents/$encodedPath"
    $lookupUri = "$contentApi`?ref=$([Uri]::EscapeDataString($Branch))"
    try {
        $null = Invoke-RestMethod -Method Get -Uri $lookupUri -Headers $headers
        Write-Host "선택한 비공개 저장소의 $Branch 브랜치에 $DataPath 파일이 이미 있습니다." -ForegroundColor Green
        Write-Host '기존 데이터 보호를 위해 덮어쓰지 않습니다.'
        return $Branch
    } catch {
        $lookupStatus = Get-HttpStatusCode $_
        if ($lookupStatus -ne 404 -and -not ($repoIsEmpty -and $lookupStatus -eq 409)) {
            Stop-Wizard "기존 data.json 확인에 실패했습니다. HTTP $lookupStatus"
        }
    }

    $base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($dataExamplePath))
    $payload = @{
        message = 'chore: initialize PS Log data'
        content = $base64
    }
    if (-not $repoIsEmpty) { $payload.branch = $Branch }
    $body = $payload | ConvertTo-Json -Depth 5
    try {
        $null = Invoke-RestMethod -Method Put -Uri $contentApi -Headers $headers -ContentType 'application/json' -Body $body
    } catch {
        $status = Get-HttpStatusCode $_
        Stop-Wizard "data.json 자동 업로드에 실패했습니다. 토큰의 Contents 권한이 Read and write인지 확인하세요. HTTP $status"
    }

    Write-Host "선택한 비공개 저장소에 $DataPath 파일을 기본 양식으로 생성했습니다." -ForegroundColor Green
    return $Branch
}

try {
    Set-Location $projectRoot
    Write-Host 'PS Log 최초 설정 마법사 - 한글판' -ForegroundColor Green
    Write-Host '비밀키는 Git에서 제외되는 .env 파일에만 저장됩니다.'

    Write-Step 1 '.env 준비'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $envExamplePath -PathType Leaf)) {
            Stop-Wizard '.env.example 파일이 없습니다.'
        }
        if (-not (Confirm-Choice '.env 파일이 없습니다. .env.example을 복사해서 만들까요?' $true)) {
            Stop-Wizard '.env 파일이 없어서 설정을 계속할 수 없습니다.'
        }
        Copy-Item -LiteralPath $envExamplePath -Destination $envPath
        Write-Host '.env 파일을 만들었습니다.' -ForegroundColor Green
    } else {
        Write-Host '.env 파일을 확인했습니다.' -ForegroundColor Green
    }
    $script:envValues = Read-DotEnv $envPath

    Write-Step 2 '필수 프로그램 확인'
    foreach ($command in @('git.exe', 'node.exe', 'npm.cmd', 'npx.cmd')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            Stop-Wizard "$command 프로그램을 찾지 못했습니다. Git과 Node.js LTS를 설치한 뒤 다시 실행하세요."
        }
    }
    Write-Host "- $(& git.exe --version)"
    Write-Host "- node $(& node.exe --version)"
    Write-Host "- npm $(& npm.cmd --version)"

    $localWrangler = Join-Path $projectRoot 'node_modules\.bin\wrangler.cmd'
    if (-not (Test-Path -LiteralPath $localWrangler -PathType Leaf)) {
        if (-not (Confirm-Choice '프로젝트 패키지가 없습니다. 지금 npm install을 실행할까요?' $true)) {
            Stop-Wizard '배포 전에 npm install이 필요합니다.'
        }
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { Stop-Wizard "npm install 실패: 종료 코드 $LASTEXITCODE" }
    }
    & npx.cmd --no-install wrangler --version
    if ($LASTEXITCODE -ne 0) { Stop-Wizard 'Wrangler 버전 확인에 실패했습니다.' }
    $script:ghPath = Ensure-GitHubCli
    Write-Host "- GitHub CLI $(& $script:ghPath --version | Select-Object -First 1)"
    Write-Host '필수 프로그램 준비가 끝났습니다.' -ForegroundColor Green

    Write-Step 3 '비공개 데이터 저장소 설정'
    $existingRepo = Get-ExistingOrDefault 'GITHUB_REPO' ''
    $existingOwner = ''
    $existingRepoName = 'ps-log-data'
    if ($existingRepo -match '^([^/]+)/(.+)$') {
        $existingOwner = $Matches[1]
        $existingRepoName = $Matches[2]
    }
    if ($existingOwner -and (Confirm-Choice '기존 .env에 비공개 데이터 저장소가 설정되어 있습니다. 값을 표시하지 않고 그대로 사용할까요?' $true)) {
        $owner = $existingOwner
        $repoName = $existingRepoName
    } else {
        $owner = Read-RequiredValue 'GitHub 사용자명 또는 조직명' ''
        $repoName = Read-RequiredValue '비공개 데이터 저장소 이름' 'ps-log-data'
    }
    $branch = Read-RequiredValue '데이터 저장소 브랜치' (Get-ExistingOrDefault 'GITHUB_BRANCH' 'master')
    $dataPath = Read-RequiredValue '데이터 파일 경로' (Get-ExistingOrDefault 'GITHUB_PATH' 'data.json')
    $workerName = Read-RequiredValue 'Cloudflare Worker 이름' (Get-ExistingOrDefault 'WORKER_NAME' 'ps-log')
    if ([string]::IsNullOrWhiteSpace($owner) -or [string]::IsNullOrWhiteSpace($repoName)) {
        Stop-Wizard 'GitHub 사용자명과 데이터 저장소 이름을 모두 입력해야 합니다.'
    }
    if ($owner -match '[\s/]' -or $repoName -match '[\s/]') {
        Stop-Wizard 'GitHub 사용자명과 저장소 이름에는 공백이나 슬래시를 넣을 수 없습니다.'
    }
    $repoFullName = "$owner/$repoName"
    if ($repoFullName -notmatch '^[^/\s]+/[^/\s]+$') {
        Stop-Wizard '데이터 저장소 주소가 올바르지 않습니다. 본인아이디와 레포이름을 다시 확인하세요.'
    }
    Set-DotEnvValue 'GITHUB_REPO' $repoFullName
    Set-DotEnvValue 'GITHUB_BRANCH' $branch
    Set-DotEnvValue 'GITHUB_PATH' $dataPath
    Set-DotEnvValue 'WORKER_NAME' $workerName

    Write-Host "`nGitHub에서 방금 입력한 데이터 저장소를 Private로 만들어 주세요."
    Write-Host 'data.json은 다음 단계에서 자동으로 생성하므로 직접 만들 필요가 없습니다.' -ForegroundColor Yellow
    Open-HelpPage 'GitHub 새 저장소 만들기' 'https://github.com/new'
    if (-not (Confirm-Choice '입력한 비공개 데이터 저장소를 만들었나요?' $false)) {
        Stop-Wizard '비공개 데이터 저장소를 만든 뒤 다시 실행하세요.'
    }

    Write-Step 4 'GitHub 로그인, data.json 자동 생성 및 토큰 안내'
    Write-Host 'data.json 업로드는 브라우저용 R/W 토큰을 받지 않고 GitHub CLI 로그인으로 처리합니다.' -ForegroundColor Green
    Write-Host 'GitHub CLI 로그인 정보는 Windows 자격 증명 저장소에서 관리되며 .env에 들어가지 않습니다.'
    Ensure-GitHubCliLogin $script:ghPath
    $githubCliToken = ((& $script:ghPath auth token --hostname github.com) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $githubCliToken) {
        Stop-Wizard 'GitHub CLI 로그인 토큰을 가져오지 못했습니다. gh auth login을 다시 실행하세요.'
    }
    $branch = Publish-InitialDataFile $owner $repoName $branch $dataPath $githubCliToken
    Set-DotEnvValue 'GITHUB_BRANCH' $branch
    $githubCliToken = $null

    Write-Host "`n두 GitHub 토큰은 코드 저장소가 아니라 방금 설정한 비공개 데이터 저장소만 선택해야 합니다." -ForegroundColor Yellow
    Write-Host ''
    Write-Host '[A] 브라우저용 R/W 토큰'
    Write-Host '1. Fine-grained personal access token 생성 화면을 엽니다.'
    Write-Host '2. Repository access에서 Only select repositories를 선택하고 방금 설정한 데이터 저장소만 고릅니다.'
    Write-Host '3. Repository permissions > Contents를 Read and write로 설정합니다.'
    Write-Host '4. 토큰을 생성하고 복사합니다. 이 토큰은 설치 마법사나 .env에 붙여넣지 않습니다.'
    Write-Host '5. 배포가 끝난 뒤 PS Log 웹페이지의 설정 화면에만 입력합니다.'
    Open-HelpPage 'GitHub fine-grained 토큰 발급' 'https://github.com/settings/personal-access-tokens/new'
    if (-not (Confirm-Choice '브라우저용 R/W 토큰을 만들고 안전한 곳에 복사했나요?' $false)) {
        Stop-Wizard '브라우저용 R/W 토큰을 만든 뒤 다시 진행하세요. 마법사에는 토큰 값을 붙여넣지 않습니다.'
    }
    Write-Host 'R/W 토큰은 배포 후 웹페이지 설정 화면에만 입력합니다.' -ForegroundColor Yellow

    Write-Host "`n[B] Worker용 Read-only 토큰"
    Write-Host '같은 비공개 데이터 저장소만 선택하고 Contents를 Read-only로 설정하세요.'
    Write-Host '이 토큰은 오전 8시 메일 발송 시 data.json을 읽는 데 사용합니다.'
    Ensure-Secret 'GITHUB_TOKEN' 'Worker용 Read-only GitHub 토큰을 붙여넣으세요'

    Write-Step 5 'Resend 이메일 API 설정'
    Write-Host 'Resend 로그인 후 왼쪽 API Keys 메뉴로 이동하세요.'
    Write-Host '화면의 ADD API KEY 또는 Create API Key 버튼을 바로 누르면 됩니다.' -ForegroundColor Yellow
    Write-Host '이름은 ps-log, 권한은 Sending access로 만들고 표시된 re_... 키를 복사하세요.'
    Write-Host '키 값은 생성 직후 한 번만 보이므로 바로 복사해야 합니다.'
    Open-HelpPage 'Resend API Keys' 'https://resend.com/api-keys'
    Ensure-Secret 'RESEND_API_KEY' 'Resend API 키를 붙여넣으세요'
    $mailDefault = Get-ExistingOrDefault 'MAIL_TO' ''
    $mailTo = if ($mailDefault -and (Confirm-Choice '기존 .env에 본인메일이 설정되어 있습니다. 값을 표시하지 않고 그대로 사용할까요?' $true)) {
        $mailDefault
    } else {
        Read-RequiredValue '복습 메일을 받을 본인메일' ''
    }
    Set-DotEnvValue 'MAIL_TO' $mailTo
    $mailFromDefault = Get-ExistingOrDefault 'MAIL_FROM' ''
    $mailFrom = if ($mailFromDefault -and (Confirm-Choice 'MAIL_FROM이 이미 설정되어 있습니다. 값을 표시하지 않고 그대로 사용할까요?' $true)) {
        $mailFromDefault
    } else {
        Read-Value 'MAIL_FROM (기본 발신자를 사용하려면 비워두세요)' ''
    }
    Set-DotEnvValue 'MAIL_FROM' $mailFrom

    Write-Step 6 'CRON 관리 키 생성'
    $existingCron = if ($script:envValues.ContainsKey('CRON_KEY')) { [string]$script:envValues['CRON_KEY'] } else { '' }
    if ($existingCron -and (Confirm-Choice 'CRON_KEY가 이미 있습니다. 기존 값을 사용할까요?' $true)) {
        Write-Host '- CRON_KEY: 기존 값 유지'
    } else {
        if (Confirm-Choice '안전한 CRON_KEY를 자동으로 생성할까요?' $true) {
            $cronKey = New-CronKey
        } else {
            $cronKey = Read-SecretValue '사용할 CRON_KEY를 입력하세요'
            if (-not $cronKey) { Stop-Wizard 'CRON_KEY는 비워둘 수 없습니다.' }
        }
        Set-DotEnvValue 'CRON_KEY' $cronKey
        Write-Host "CRON_KEY: $cronKey" -ForegroundColor Yellow
        Write-Host '웹페이지 설정에서 사용량을 확인할 때 필요하므로 안전한 곳에 복사해 두세요.'
    }

    Write-Step 7 'Cloudflare 인증과 API 토큰 설정'
    Write-Host '[배포 인증] 가장 간단한 방법은 wrangler login이며 API 토큰이 필요하지 않습니다.' -ForegroundColor Green
    Write-Host '자동 배포용 API 토큰을 쓰고 싶다면 아래 권한으로 발급할 수 있습니다.'
    Write-Host '1. Cloudflare > My Profile > API Tokens > Create Token으로 이동'
    Write-Host '2. Edit Cloudflare Workers 템플릿의 Use template 선택'
    Write-Host '3. 다음 권한이 포함됐는지 확인:'
    Write-Host '   - Account: Workers Scripts Edit, Account Settings Read'
    Write-Host '   - User: User Details Read, Memberships Read'
    Write-Host '   - 템플릿에는 KV/R2/Tail/Workers Routes 권한도 함께 포함될 수 있음'
    Write-Host '4. Account Resources에서 Include > 사용할 계정 선택'
    Write-Host '5. custom domain을 쓰면 Zone Resources에서 해당 Zone 선택'
    Write-Host '6. Continue to summary > Create Token > 토큰을 즉시 복사'
    $hasDeployToken = $script:envValues.ContainsKey('DEPLOY_CF_API_TOKEN') -and [string]$script:envValues['DEPLOY_CF_API_TOKEN']
    $useDeployToken = Confirm-Choice 'wrangler login 대신 배포용 API 토큰을 사용할까요?' ([bool]$hasDeployToken)

    $env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CF_ACCOUNT_ID -ErrorAction SilentlyContinue
    if ($useDeployToken) {
        Open-HelpPage 'Cloudflare API Tokens' 'https://dash.cloudflare.com/profile/api-tokens'
        Ensure-Secret 'DEPLOY_CF_API_TOKEN' 'Cloudflare 배포용 API 토큰을 붙여넣으세요'
        $deployAccountDefault = Get-ExistingOrDefault 'DEPLOY_CF_ACCOUNT_ID' ''
        Write-Host 'Account ID는 Cloudflare 대시보드의 Workers & Pages 개요 오른쪽 Account details에서 복사할 수 있습니다.'
        Set-DotEnvValue 'DEPLOY_CF_ACCOUNT_ID' (Read-RequiredValue 'Cloudflare Account ID' $deployAccountDefault)
        $env:CLOUDFLARE_API_TOKEN = [string]$script:envValues['DEPLOY_CF_API_TOKEN']
        $env:CLOUDFLARE_ACCOUNT_ID = [string]$script:envValues['DEPLOY_CF_ACCOUNT_ID']
        & npx.cmd --no-install wrangler whoami *> $null
        if ($LASTEXITCODE -ne 0) {
            Stop-Wizard 'Cloudflare 토큰 인증에 실패했습니다. Edit Cloudflare Workers 템플릿, Account 선택, User Memberships Read 권한을 다시 확인하세요.'
        } else {
            Write-Host 'Cloudflare 토큰 인증을 확인했습니다. 계정 정보는 표시하지 않습니다.' -ForegroundColor Green
        }
    } else {
        Set-DotEnvValue 'DEPLOY_CF_API_TOKEN' ''
        Set-DotEnvValue 'DEPLOY_CF_ACCOUNT_ID' ''
        Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
        & npx.cmd --no-install wrangler whoami *> $null
        if ($LASTEXITCODE -ne 0) {
            if (-not (Confirm-Choice 'Cloudflare 로그인이 필요합니다. 지금 wrangler login을 실행할까요?' $true)) {
                Stop-Wizard 'Cloudflare 로그인 또는 배포용 API 토큰이 필요합니다.'
            }
            & npx.cmd --no-install wrangler login
            if ($LASTEXITCODE -ne 0) { Stop-Wizard "Cloudflare 로그인 실패: 종료 코드 $LASTEXITCODE" }
        } else {
            Write-Host 'Cloudflare 로그인을 확인했습니다. 계정 정보는 표시하지 않습니다.' -ForegroundColor Green
        }
    }

    Write-Host "`n[사용량 조회용 선택 설정] 웹 설정 화면에서 Cloudflare 24시간 요청 수를 보려면 별도 읽기 토큰이 필요합니다."
    Write-Host '1. API Tokens > Create Token > Custom token > Get started 선택'
    Write-Host '2. Permissions에서 Account / Account Analytics / Read 선택'
    Write-Host '3. Account Resources에서 Include / Specific account / 사용할 계정 선택'
    Write-Host '4. Continue to summary > Create Token을 누르고 토큰 복사'
    Write-Host '이 토큰은 Worker 배포 권한이 없으며 사용량 숫자를 읽는 데만 사용됩니다.'
    if (Confirm-Choice 'Cloudflare 사용량 조회 기능도 설정할까요? (N 권장)' $false) {
        Open-HelpPage 'Cloudflare Custom API Token' 'https://dash.cloudflare.com/profile/api-tokens'
        Ensure-Secret 'WORKER_CF_API_TOKEN' 'Account Analytics Read 토큰을 붙여넣으세요'
        $analyticsAccountDefault = Get-ExistingOrDefault 'WORKER_CF_ACCOUNT_ID' (Get-ExistingOrDefault 'DEPLOY_CF_ACCOUNT_ID' '')
        Set-DotEnvValue 'WORKER_CF_ACCOUNT_ID' (Read-RequiredValue '사용량 조회 대상 Cloudflare Account ID' $analyticsAccountDefault)
    }

    Write-Step 8 '설정 검증 및 최초 배포'
    Write-Host 'GitHub 데이터 저장소 : 설정 완료 (값 숨김)'
    Write-Host "브랜치 / 파일 경로    : $($script:envValues['GITHUB_BRANCH']) / $($script:envValues['GITHUB_PATH'])"
    Write-Host "Cloudflare Worker     : $($script:envValues['WORKER_NAME'])"
    Write-Host '최초 웹 버전          : 1.0.0'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'deploy-setup.ps1') -ValidateOnly
    if ($LASTEXITCODE -ne 0) { Stop-Wizard '배포 설정 검증에 실패했습니다.' }
    if (-not (Confirm-Choice 're_settings.bat을 실행해서 지금 배포할까요?' $true)) {
        Write-Host '설정은 저장했습니다. 준비되면 re_settings.bat을 실행하세요.'
        exit 0
    }
    $deployBat = Join-Path $projectRoot 're_settings.bat'
    $deployCommand = '"' + $deployBat + '" --no-bump --no-pause'
    & cmd.exe /d /c $deployCommand
    if ($LASTEXITCODE -ne 0) { Stop-Wizard "배포 실패: 종료 코드 $LASTEXITCODE" }

    Write-Host "`n최초 설정과 배포가 완료됐습니다." -ForegroundColor Green
    Write-Host '마지막으로 배포된 웹페이지 설정에서 브라우저용 R/W GitHub 토큰을 입력하세요.'
    Write-Host '이후 재배포는 re_settings.bat을 실행하면 버전 증가와 함께 처리됩니다.'
    exit 0
} catch {
    [Console]::Error.WriteLine("[오류] $($_.Exception.Message)")
    exit 1
}
