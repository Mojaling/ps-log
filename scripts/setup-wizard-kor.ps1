$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$envExamplePath = Join-Path $projectRoot '.env.example'
$dataExamplePath = Join-Path $projectRoot 'data.example.json'
. (Join-Path $PSScriptRoot 'cloudflare-workers-dev.ps1')

# "있는지 없는지" 를 묻는 네이티브 명령 전용 실행기.
#
# Windows PowerShell 5.1은 $ErrorActionPreference = 'Stop' 상태에서 네이티브 명령의
# stderr를 리다이렉트하면(*> 나 2>&1) 그 줄을 ErrorRecord로 바꿔 예외를 던진다.
# gh는 "저장소가 없다" 같은 정상적인 조회 실패도 stderr로 알려 주기 때문에,
# 없으면 만들어 주려던 코드까지 가지 못하고 마법사가 그 자리에서 죽었다.
# 존재 여부 확인은 예외가 아니라 종료 코드로 판단해야 한다.
function Invoke-NativeProbe {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

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

function Select-CloudflareAccount($WhoAmI, [string]$PreferredAccountId = '') {
    $accounts = @($WhoAmI.accounts)
    if ($PreferredAccountId) {
        $matched = @($accounts | Where-Object { [string]$_.id -eq $PreferredAccountId })
        if ($matched.Count -eq 1) { return $matched[0] }
        Write-Host '기존 Cloudflare Account ID가 현재 로그인 계정에 없어 다시 선택합니다.' -ForegroundColor Yellow
    }
    if ($accounts.Count -eq 1) { return $accounts[0] }

    Write-Host '여러 Cloudflare 계정이 연결되어 있습니다. 배포할 계정을 선택하세요.'
    for ($index = 0; $index -lt $accounts.Count; $index++) {
        Write-Host ("{0}. {1}" -f ($index + 1), [string]$accounts[$index].name)
    }
    while ($true) {
        $answer = (Read-Host "계정 번호 [1-$($accounts.Count)]").Trim()
        $number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $accounts.Count) {
            return $accounts[$number - 1]
        }
        Write-Host '목록에 있는 계정 번호를 입력해 주세요.' -ForegroundColor Yellow
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

# winget 설치 직후에는 이 창의 PATH가 옛날 값이라 방금 깐 프로그램을 못 찾는다.
# 레지스트리에서 시스템·사용자 PATH를 다시 읽어 현재 세션에 반영한다.
function Update-SessionPath {
    $parts = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
    ) | Where-Object { $_ }
    if ($parts) { $env:Path = ($parts -join ';') }
}

function Install-WithWinget([string]$PackageId, [string]$DisplayName) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }
    if (-not (Confirm-Choice "지금 winget으로 $DisplayName 을(를) 자동 설치할까요?" $true)) { return $false }
    Write-Host "$DisplayName 설치를 시작합니다. 몇 분 걸릴 수 있습니다." -ForegroundColor Yellow
    & winget.exe install --id $PackageId --exact --source winget --accept-package-agreements --accept-source-agreements | Out-Host
    # winget은 "이미 설치됨"에도 0이 아닌 코드를 낸다. 성공 판정은 종료 코드가 아니라
    # 설치 후 실제로 명령을 찾을 수 있는지로 한다.
    Update-SessionPath
    return $true
}

# Git·Node.js는 PATH로만 찾는다. winget으로 방금 깔았는데 PATH 갱신이 안 되면
# 이 창에서는 계속 못 찾으므로, 조용히 실패하지 말고 재실행을 안내한다.
function Ensure-RequiredTool([string]$Command, [string]$DisplayName, [string]$WingetId, [string]$DownloadUrl) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }

    Write-Host "$DisplayName 을(를) 찾지 못했습니다." -ForegroundColor Yellow
    if (Install-WithWinget $WingetId $DisplayName) {
        if (Get-Command $Command -ErrorAction SilentlyContinue) {
            Write-Host "$DisplayName 설치를 확인했습니다." -ForegroundColor Green
            return
        }
        Stop-Wizard "$DisplayName 설치는 끝났지만 이 창에서 인식되지 않습니다. settings_kor.bat을 다시 실행하면 이어서 진행됩니다."
    }

    Open-HelpPage "$DisplayName 설치" $DownloadUrl
    Stop-Wizard "$DisplayName 을(를) 설치한 뒤 settings_kor.bat을 다시 실행하세요."
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
    if (Install-WithWinget 'GitHub.cli' 'GitHub CLI') {
        $path = Find-GitHubCli
        if ($path) {
            Write-Host 'GitHub CLI 설치를 확인했습니다.' -ForegroundColor Green
            return $path
        }
    }

    Open-HelpPage 'GitHub CLI 설치' 'https://cli.github.com/'
    Stop-Wizard 'GitHub CLI 설치 후 settings_kor.bat을 다시 실행하세요.'
}

# 가입해야 쓸 수 있는 외부 서비스는 로그인 화면을 열기 전에 계정부터 확인한다.
# 계정 없이 로그인 페이지만 열어 주면 처음 쓰는 사람이 그 자리에서 막힌다.
function Ensure-ServiceAccount([string]$ServiceName, [string]$SignUpUrl) {
    if (Confirm-Choice "$ServiceName 계정이 이미 있나요?" $true) { return }
    Write-Host "$ServiceName 가입 페이지를 엽니다. 이메일 인증까지 마치고 돌아오세요." -ForegroundColor Yellow
    Open-HelpPage "$ServiceName 가입" $SignUpUrl
    if (-not (Confirm-Choice "$ServiceName 가입을 완료했나요?" $false)) {
        Stop-Wizard "$ServiceName 계정이 있어야 다음 단계로 갈 수 있습니다."
    }
}

function Ensure-GitHubCliLogin([string]$GhPath) {
    if ((Invoke-NativeProbe $GhPath @('auth', 'status', '--hostname', 'github.com')) -eq 0) { return }

    Ensure-ServiceAccount 'GitHub' 'https://github.com/signup'
    Write-Host 'GitHub CLI 로그인이 필요합니다. 브라우저에서 GitHub 로그인을 진행합니다.'
    & $GhPath auth login --hostname github.com --web --git-protocol https
    if ($LASTEXITCODE -ne 0) { Stop-Wizard "GitHub CLI 로그인 실패: 종료 코드 $LASTEXITCODE" }
}

function Get-HttpStatusCode($ErrorRecord) {
    try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
}

function Get-HttpErrorBody($ErrorRecord) {
    try {
        $response = $ErrorRecord.Exception.Response
        if (-not $response) { return '' }
        $stream = $response.GetResponseStream()
        if (-not $stream) { return '' }
        $reader = New-Object IO.StreamReader($stream)
        try {
            $body = $reader.ReadToEnd().Trim()
            if ($body.Length -gt 300) { return $body.Substring(0, 300) }
            return $body
        } finally {
            $reader.Dispose()
        }
    } catch {
        return ''
    }
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

function Ensure-PrivateDataRepository([string]$GhPath, [string]$Owner, [string]$Repo) {
    $fullName = "$Owner/$Repo"
    if ((Invoke-NativeProbe $GhPath @('repo', 'view', $fullName, '--json', 'isPrivate')) -eq 0) {
        Write-Host '비공개 데이터 저장소가 이미 있습니다. 공개 여부와 data.json을 확인합니다.' -ForegroundColor Green
        return
    }

    Write-Host "GitHub에 '$fullName' 비공개 저장소가 없습니다. 지금 만들어 드립니다." -ForegroundColor Yellow
    if (-not (Confirm-Choice 'GitHub CLI로 Private 저장소를 지금 자동 생성할까요?' $true)) {
        Open-HelpPage 'GitHub 새 저장소 만들기' 'https://github.com/new'
        if (-not (Confirm-Choice 'Private 저장소 생성을 완료했나요?' $false)) {
            Stop-Wizard '비공개 데이터 저장소가 있어야 설정을 계속할 수 있습니다.'
        }
        return
    }

    & $GhPath repo create $fullName --private --description 'Private data for PS Log'
    if ($LASTEXITCODE -ne 0) {
        Stop-Wizard "Private 저장소 자동 생성 실패: 종료 코드 $LASTEXITCODE. 저장소 이름이 이미 쓰이고 있는지, gh 로그인 계정이 '$Owner'와 같은지 확인하세요."
    }
    # 생성 직후 조회가 바로 되지 않는 경우가 있어, 다음 단계로 넘어가기 전에 실제로 확인한다.
    foreach ($attempt in 1..5) {
        if ((Invoke-NativeProbe $GhPath @('repo', 'view', $fullName, '--json', 'isPrivate')) -eq 0) {
            Write-Host "'$fullName' Private 저장소를 생성했습니다." -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds 2
    }
    Stop-Wizard "'$fullName' 저장소를 만들었지만 조회되지 않습니다. GitHub에서 생성 여부를 확인한 뒤 settings_kor.bat을 다시 실행하세요."
}

# GitHub는 fine-grained 토큰을 만드는 API를 제공하지 않는다 (조직 토큰 승인/취소 API만 있다).
# 대신 발급 화면이 쿼리 문자열 프리필을 지원하므로, 이름·설명·소유자·기간·권한을 미리 채운
# 주소를 만들어 준다. 사용자가 직접 고를 것은 저장소 하나와 Generate 버튼뿐이다.
function New-TokenPageUrl {
    param(
        [string]$Name,
        [string]$Description,
        [string]$Owner,
        [ValidateSet('read', 'write')][string]$Contents,
        [string]$ExpiresInDays = '366'
    )
    $query = @(
        "name=$([Uri]::EscapeDataString($Name))"
        "description=$([Uri]::EscapeDataString($Description))"
        "target_name=$([Uri]::EscapeDataString($Owner))"
        "expires_in=$([Uri]::EscapeDataString($ExpiresInDays))"
        "contents=$Contents"
    )
    return 'https://github.com/settings/personal-access-tokens/new?' + ($query -join '&')
}

function New-GitHubApiHeaders([string]$Token) {
    return @{
        Accept = 'application/vnd.github+json'
        Authorization = "Bearer $Token"
        'X-GitHub-Api-Version' = '2026-03-10'
        'User-Agent' = 'ps-log-setup-wizard'
    }
}

# 웹용 토큰은 읽기만 되면 안 되고 쓰기까지 돼야 한다. 그런데 확인하겠다고 data.json을
# 건드리면 사용자의 기록에 커밋이 남는다. 어느 브랜치에서도 참조하지 않는 blob 하나를
# 만들어 보는 것으로 대신한다 — 쓰기 권한이 없으면 403이 나고, 있으면 화면에 아무것도
# 남지 않는 고아 객체만 생겼다가 GitHub가 알아서 정리한다.
function Test-BrowserGitHubToken([string]$Owner, [string]$Repo, [string]$Branch, [string]$DataPath, [string]$Token) {
    $headers = New-GitHubApiHeaders $Token
    $repoApi = "https://api.github.com/repos/$([Uri]::EscapeDataString($Owner))/$([Uri]::EscapeDataString($Repo))"

    $encodedPath = Convert-ToGitHubPath $DataPath
    try {
        $content = Invoke-RestMethod -Method Get -Uri "$repoApi/contents/$encodedPath`?ref=$([Uri]::EscapeDataString($Branch))" -Headers $headers
    } catch {
        $status = Get-HttpStatusCode $_
        if ($status -eq 404) {
            Stop-Wizard "웹용 토큰이 '$Owner/$Repo'의 $DataPath 를 읽지 못했습니다 (HTTP 404). Repository access에서 코드 Fork가 아니라 데이터 저장소를 선택했는지 확인하세요."
        }
        Stop-Wizard "웹용 토큰으로 $DataPath 를 읽지 못했습니다. Repository access가 '$Owner/$Repo'인지 확인하세요. HTTP $status"
    }
    if ([string]$content.type -ne 'file') {
        Stop-Wizard "$DataPath 경로가 파일이 아닙니다. .env의 GITHUB_PATH를 확인하세요."
    }

    $probe = @{ content = 'ps-log write permission check'; encoding = 'utf-8' } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$repoApi/git/blobs" -Headers $headers -ContentType 'application/json' -Body $probe | Out-Null
    } catch {
        $status = Get-HttpStatusCode $_
        if ($status -eq 403 -or $status -eq 404) {
            Stop-Wizard '웹용 토큰에 쓰기 권한이 없습니다. Repository permissions > Contents를 Read and write로 다시 발급하세요.'
        }
        Stop-Wizard "웹용 토큰의 쓰기 권한을 확인하지 못했습니다. HTTP $status"
    }
    Write-Host '웹용 토큰의 읽기·쓰기 권한을 모두 확인했습니다.' -ForegroundColor Green
}

function Test-WorkerGitHubToken([string]$Owner, [string]$Repo, [string]$Branch, [string]$DataPath, [string]$Token) {
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
        Stop-Wizard "두 번째 GitHub 토큰으로 Private 저장소를 읽지 못했습니다. 토큰의 Repository access가 '$Owner/$Repo'인지 확인하세요. HTTP $status"
    }
    if (-not [bool]$repoInfo.private) {
        Stop-Wizard '데이터 저장소가 Private가 아닙니다. 저장소 공개 범위를 먼저 변경하세요.'
    }

    $encodedPath = Convert-ToGitHubPath $DataPath
    $contentUri = "$repoApi/contents/$encodedPath`?ref=$([Uri]::EscapeDataString($Branch))"
    try {
        $content = Invoke-RestMethod -Method Get -Uri $contentUri -Headers $headers
    } catch {
        $status = Get-HttpStatusCode $_
        Stop-Wizard "두 번째 GitHub 토큰으로 $Branch 브랜치의 $DataPath 파일을 읽지 못했습니다. Contents가 Read-only 이상인지 확인하세요. HTTP $status"
    }
    if ([string]$content.type -ne 'file') {
        Stop-Wizard "$DataPath 경로가 파일이 아닙니다. .env의 GITHUB_PATH를 확인하세요."
    }
    Write-Host '두 번째 GitHub 토큰으로 Private data.json 읽기 검증을 통과했습니다.' -ForegroundColor Green
}

function Assert-EmailAddress([string]$Value, [string]$Label) {
    try {
        $address = New-Object Net.Mail.MailAddress($Value)
        if (-not $address.Address -or $address.Address -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
            throw 'invalid'
        }
    } catch {
        Stop-Wizard "$Label 이메일 주소 형식이 올바르지 않습니다."
    }
}

function Send-TestReviewEmail([string]$WorkerUrl, [string]$CronKey) {
    $uri = "$WorkerUrl/__cron?test=1"
    $lastMessage = ''
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            $response = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Bearer $CronKey" } -TimeoutSec 20
            Write-Host "테스트 메일 요청 성공: $response" -ForegroundColor Green
            return
        } catch {
            $statusCode = Get-HttpStatusCode $_
            $errorBody = Get-HttpErrorBody $_
            $lastMessage = if ($statusCode -and $errorBody) {
                "HTTP $statusCode - $errorBody"
            } elseif ($statusCode) {
                "HTTP $statusCode"
            } else {
                $_.Exception.Message
            }
            if ($attempt -lt 6) {
                Write-Host "최초 workers.dev 주소와 비밀키가 적용될 때까지 기다린 뒤 다시 시도합니다. ($attempt/6)" -ForegroundColor Yellow
                Start-Sleep -Seconds 8
            }
        }
    }
    Stop-Wizard "테스트 이메일 요청에 실패했습니다: $lastMessage"
}

try {
    Set-Location $projectRoot
    Write-Host 'PS Log 최초 설정 마법사 - 한글판' -ForegroundColor Green
    Write-Host '비밀키는 Git에서 제외되는 .env 파일에만 저장됩니다.'

    Write-Host '이 마법사는 PS Log를 처음부터 끝까지 설치하고 배포합니다.'
    Write-Host '중간에 브라우저로 처리할 일은 다음 세 가지 계정입니다.'
    Write-Host '  - GitHub    : 기록을 보관할 Private 저장소를 만듭니다 (무료)'
    Write-Host '  - Cloudflare: 웹앱과 복습 메일 Worker를 올립니다 (무료)'
    Write-Host '  - Resend    : 복습 메일을 발송합니다 (무료)'
    Write-Host '없는 계정은 각 단계에서 가입 페이지를 열어 드립니다. 미리 만들어 두면 더 빠릅니다.'
    Write-Host 'Git과 Node.js가 없으면 winget으로 자동 설치합니다.'
    Write-Host ''

    Write-Step 1 '.env 파일 확인'
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

    Write-Step 2 'npm과 필수 프로그램 설치 여부 확인'
    Ensure-RequiredTool 'git.exe' 'Git' 'Git.Git' 'https://git-scm.com/download/win'
    Ensure-RequiredTool 'node.exe' 'Node.js LTS' 'OpenJS.NodeJS.LTS' 'https://nodejs.org/'
    # npm·npx는 Node.js에 딸려 오므로 따로 설치하지 않고 존재만 확인한다.
    foreach ($command in @('npm.cmd', 'npx.cmd')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            Stop-Wizard "$command 을(를) 찾지 못했습니다. Node.js LTS를 다시 설치한 뒤 settings_kor.bat을 다시 실행하세요."
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

    Write-Step 3 'Cloudflare 로그인 인증 및 workers.dev 설정'
    Write-Host '로컬 PC 배포는 API 키 없이 wrangler login(OAuth) 인증을 사용합니다.' -ForegroundColor Green
    Set-DotEnvValue 'DEPLOY_CF_API_TOKEN' ''
    $env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false'
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CF_ACCOUNT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CLOUDFLARE_ACCOUNT_ID -ErrorAction SilentlyContinue
    if ((Invoke-NativeProbe 'npx.cmd' @('--no-install', 'wrangler', 'whoami')) -ne 0) {
        Ensure-ServiceAccount 'Cloudflare' 'https://dash.cloudflare.com/sign-up'
        if (-not (Confirm-Choice 'Cloudflare 브라우저 로그인을 지금 실행할까요?' $true)) {
            Stop-Wizard 'Cloudflare 로그인이 필요합니다.'
        }
        & npx.cmd --no-install wrangler login
        if ($LASTEXITCODE -ne 0) { Stop-Wizard "Cloudflare 로그인 실패: 종료 코드 $LASTEXITCODE" }
    }
    Write-Host 'Cloudflare OAuth 로그인을 확인했습니다.' -ForegroundColor Green

    $cloudflareWhoAmI = Get-WranglerWhoAmI
    $preferredCloudflareAccount = Get-ExistingOrDefault 'DEPLOY_CF_ACCOUNT_ID' ''
    $selectedCloudflareAccount = Select-CloudflareAccount -WhoAmI $cloudflareWhoAmI -PreferredAccountId $preferredCloudflareAccount
    Set-DotEnvValue 'DEPLOY_CF_ACCOUNT_ID' ([string]$selectedCloudflareAccount.id)
    $env:CLOUDFLARE_ACCOUNT_ID = [string]$selectedCloudflareAccount.id
    Write-Host '배포할 Cloudflare Account ID를 .env에 자동 저장했습니다.' -ForegroundColor Green

    $workersDev = Get-WorkersDevRegistration -AccountId ([string]$selectedCloudflareAccount.id)
    while (-not $workersDev.Registered) {
        Write-Host '현재 계정에는 workers.dev 주소가 없습니다. 최초 배포 전에 반드시 등록해야 합니다.' -ForegroundColor Yellow
        Write-Host "등록 주소: $($workersDev.OnboardingUrl)"
        Open-HelpPage 'Cloudflare workers.dev 등록' $workersDev.OnboardingUrl
        Write-Host '브라우저에서 사용할 계정 서브도메인을 정하고 등록을 완료하세요.'
        if (-not (Confirm-Choice 'workers.dev 등록을 완료했나요?' $false)) {
            Stop-Wizard 'workers.dev 등록을 완료해야 다음 단계로 갈 수 있습니다.'
        }
        $workersDev = Get-WorkersDevRegistration -AccountId ([string]$selectedCloudflareAccount.id)
        if (-not $workersDev.Registered) {
            Write-Host '아직 등록 상태가 확인되지 않습니다. 브라우저 작업을 확인하세요.' -ForegroundColor Yellow
        }
    }
    Write-Host 'workers.dev 등록을 확인했습니다.' -ForegroundColor Green

    Write-Host "`nCloudflare 사용량 조회는 핵심 기능이나 배포에 필요하지 않습니다."
    if (Confirm-Choice 'Cloudflare 사용량 조회 기능도 설정할까요? (N 권장)' $false) {
        Write-Host 'Custom API Token에서 Account > Account Analytics > Read 권한을 선택하세요.'
        Open-HelpPage 'Cloudflare Custom API Token' 'https://dash.cloudflare.com/profile/api-tokens'
        Ensure-Secret 'WORKER_CF_API_TOKEN' 'Account Analytics Read 토큰을 붙여넣으세요'
        Set-DotEnvValue 'WORKER_CF_ACCOUNT_ID' ([string]$selectedCloudflareAccount.id)
    }

    Write-Step 4 'GitHub 계정과 .env 기본 정보 입력'
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
    $branch = Read-RequiredValue '데이터 저장소 브랜치' (Get-ExistingOrDefault 'GITHUB_BRANCH' 'main')
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
    if ($workerName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
        Stop-Wizard 'Worker 이름은 영문자·숫자·하이픈만 사용하고 하이픈으로 시작하거나 끝낼 수 없습니다.'
    }
    Set-DotEnvValue 'GITHUB_REPO' $repoFullName
    Set-DotEnvValue 'GITHUB_BRANCH' $branch
    Set-DotEnvValue 'GITHUB_PATH' $dataPath
    Set-DotEnvValue 'WORKER_NAME' $workerName
    Write-Host '.env 기본 정보를 저장했습니다. 값은 터미널에 다시 표시하지 않습니다.' -ForegroundColor Green

    Write-Step 5 'Private ps-log-data 저장소 생성 및 data.json 추가'
    Write-Host 'GitHub CLI 로그인으로 Private 저장소와 data.json을 준비합니다.'
    Write-Host 'GitHub CLI 로그인 정보는 Windows 자격 증명 저장소에서 관리되며 .env에 넣지 않습니다.'
    Ensure-GitHubCliLogin $script:ghPath
    Ensure-PrivateDataRepository $script:ghPath $owner $repoName
    $githubCliToken = ((& $script:ghPath auth token --hostname github.com) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $githubCliToken) {
        Stop-Wizard 'GitHub CLI 로그인 토큰을 가져오지 못했습니다. gh auth login을 다시 실행하세요.'
    }
    $branch = Publish-InitialDataFile $owner $repoName $branch $dataPath $githubCliToken
    Set-DotEnvValue 'GITHUB_BRANCH' $branch
    $githubCliToken = $null

    Write-Step 6 'GitHub 키 2개 발급'
    Write-Host 'GitHub는 토큰을 대신 만들어 주는 API를 제공하지 않아 Generate 버튼만은 직접 눌러야 합니다.'
    Write-Host '대신 이름·기간·권한을 미리 채운 발급 화면을 열어 드립니다.' -ForegroundColor Green
    Write-Host "화면에서 고를 것은 Repository access > Only select repositories > $repoName 하나뿐입니다." -ForegroundColor Yellow
    Write-Host '코드 Fork 저장소를 고르면 웹에서 data.json을 읽고 쓸 수 없습니다.' -ForegroundColor Yellow

    Write-Host "`n[A] 웹 브라우저용 R/W 토큰 (Contents: Read and write)"
    $browserTokenUrl = New-TokenPageUrl -Name 'ps-log' -Description 'PS Log 웹앱이 data.json을 읽고 커밋합니다' -Owner $owner -Contents 'write'
    Write-Host "1. 열린 화면에서 $repoName 저장소만 선택"
    Write-Host '2. Generate token을 누르고 나온 github_pat_... 값을 복사'
    Write-Host '3. 아래에 붙여넣으면 권한이 맞는지 바로 확인해 드립니다.'
    Write-Host '   (이 토큰은 .env에 저장하지 않습니다. 확인만 하고 메모리에서 지웁니다.)'
    Open-HelpPage '웹용 R/W 토큰 발급 (미리 채워진 화면)' $browserTokenUrl
    $browserToken = ''
    while ($true) {
        $browserToken = Read-SecretValue '웹용 R/W 토큰을 붙여넣으세요'
        if ($browserToken) { break }
        Write-Host '필수 입력값입니다.' -ForegroundColor Yellow
    }
    Test-BrowserGitHubToken -Owner $owner -Repo $repoName -Branch $branch -DataPath $dataPath -Token $browserToken

    # 12단계에서 웹 설정창에 붙여넣어야 하므로 클립보드에 올려 준다.
    # .env에는 절대 쓰지 않는다 — 이 토큰이 사는 곳은 사용자의 비밀번호 관리자와 브라우저뿐이다.
    if (Confirm-Choice '이 토큰을 클립보드에 복사할까요? (비밀번호 관리자에 붙여넣어 보관하세요)' $true) {
        try {
            Set-Clipboard -Value $browserToken
            Write-Host '클립보드에 복사했습니다. 지금 바로 안전한 곳에 붙여넣어 보관하세요.' -ForegroundColor Green
            Write-Host '이 값은 GitHub에서 다시 볼 수 없습니다.' -ForegroundColor Yellow
        } catch {
            Write-Host '클립보드 복사에 실패했습니다. 화면에 복사해 둔 토큰을 직접 보관하세요.' -ForegroundColor Yellow
        }
    }
    $browserToken = $null

    Write-Host "`n[B] 이메일 Worker용 Read-only 토큰 (Contents: Read-only)"
    $workerTokenUrl = New-TokenPageUrl -Name 'ps-log-data' -Description 'PS Log 복습 메일 Worker가 data.json을 읽습니다' -Owner $owner -Contents 'read'
    Write-Host "1. 열린 화면에서 $repoName 저장소만 선택"
    Write-Host '2. Generate token을 누르고 나온 값을 복사해 아래에 붙여넣기'
    Write-Host '3. 이 토큰은 .env의 GITHUB_TOKEN에 저장됩니다.'
    Open-HelpPage 'Worker용 Read-only 토큰 발급 (미리 채워진 화면)' $workerTokenUrl
    Ensure-Secret 'GITHUB_TOKEN' '두 번째 ps-log-data Read-only 토큰을 붙여넣으세요'
    Test-WorkerGitHubToken -Owner $owner -Repo $repoName -Branch $branch -DataPath $dataPath -Token ([string]$script:envValues['GITHUB_TOKEN'])

    Write-Step 7 'Resend 이메일 API 키 발급'
    Ensure-ServiceAccount 'Resend' 'https://resend.com/signup'
    Write-Host 'Resend 로그인 후 왼쪽 API Keys 메뉴로 이동하세요.'
    Write-Host '화면의 ADD API KEY 또는 Create API Key 버튼을 바로 누르면 됩니다.' -ForegroundColor Yellow
    Write-Host '이름은 ps-log, 권한은 Sending access로 만들고 표시된 re_... 키를 복사하세요.'
    Write-Host '키 값은 생성 직후 한 번만 보이므로 바로 복사해야 합니다.'
    Open-HelpPage 'Resend API Keys' 'https://resend.com/api-keys'
    Ensure-Secret 'RESEND_API_KEY' 'Resend API 키를 붙여넣으세요'
    if ([string]$script:envValues['RESEND_API_KEY'] -notmatch '^re_[A-Za-z0-9_\-]+$') {
        Stop-Wizard 'Resend API 키는 re_로 시작해야 합니다. 복사한 값을 다시 확인하세요.'
    }
    $mailDefault = Get-ExistingOrDefault 'MAIL_TO' ''
    $mailTo = if ($mailDefault -and (Confirm-Choice '기존 .env에 본인메일이 설정되어 있습니다. 값을 표시하지 않고 그대로 사용할까요?' $true)) {
        $mailDefault
    } else {
        Read-RequiredValue '복습 메일을 받을 본인메일' ''
    }
    Assert-EmailAddress -Value $mailTo -Label 'MAIL_TO'
    Set-DotEnvValue 'MAIL_TO' $mailTo
    $mailFromDefault = Get-ExistingOrDefault 'MAIL_FROM' ''
    $mailFrom = if ($mailFromDefault -and (Confirm-Choice 'MAIL_FROM이 이미 설정되어 있습니다. 값을 표시하지 않고 그대로 사용할까요?' $true)) {
        $mailFromDefault
    } else {
        Read-Value 'MAIL_FROM (기본 발신자를 사용하려면 비워두세요)' ''
    }
    if (-not $mailFrom) {
        Write-Host 'MAIL_FROM을 비우면 onboarding@resend.dev를 사용하며 Resend 가입 이메일로만 보낼 수 있습니다.' -ForegroundColor Yellow
        if (-not (Confirm-Choice 'MAIL_TO가 Resend에 가입할 때 사용한 본인 이메일과 같은가요?' $true)) {
            Write-Host '다른 주소로 보내려면 Resend에서 본인 도메인을 인증하고 그 도메인의 발신 주소를 입력해야 합니다.'
            Open-HelpPage 'Resend Domains' 'https://resend.com/domains'
            $mailFrom = Read-RequiredValue '인증한 발신 주소 MAIL_FROM (예: PS Log <review@example.com>)' ''
        }
    }
    if ($mailFrom) { Assert-EmailAddress -Value $mailFrom -Label 'MAIL_FROM' }
    Set-DotEnvValue 'MAIL_FROM' $mailFrom

    Write-Step 8 'CRON 관리 키 발급'
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

    Write-Step 9 're_settings.bat으로 실제 최초 배포'
    Write-Host 'GitHub 데이터 저장소 : 설정 완료 (값 숨김)'
    Write-Host "브랜치 / 파일 경로    : $($script:envValues['GITHUB_BRANCH']) / $($script:envValues['GITHUB_PATH'])"
    Write-Host "Cloudflare Worker     : $($script:envValues['WORKER_NAME'])"
    $versionSource = [IO.File]::ReadAllText((Join-Path $projectRoot 'public\version.js'))
    $currentWebVersion = if ($versionSource -match 'APP_VERSION\s*=\s*[''"]([^''"]+)[''"]') { $Matches[1] } else { '확인 불가' }
    Write-Host "최초 배포 웹 버전     : $currentWebVersion (버전 증가 없이 배포)"
    Write-Host "`n실제 배포와 같은 경로로 Cloudflare 인증과 Worker 번들을 사전 점검합니다."
    Write-Host '이 점검은 배포, 버전 증가, 비밀키 변경을 하지 않습니다.'
    $deployBat = Join-Path $projectRoot 're_settings.bat'
    $checkCommand = '"' + $deployBat + '" --check --no-pause'
    & cmd.exe /d /c $checkCommand
    if ($LASTEXITCODE -ne 0) { Stop-Wizard '배포 사전 점검에 실패했습니다. 위 오류를 먼저 해결하세요.' }
    Write-Host '배포 사전 점검이 완료됐습니다. 인증과 Worker 빌드가 정상입니다.' -ForegroundColor Green
    if (-not (Confirm-Choice 're_settings.bat을 실행해서 지금 배포할까요?' $true)) {
        Write-Host '설정은 저장했습니다. 준비되면 re_settings.bat을 실행하세요.'
        exit 0
    }
    $deployCommand = '"' + $deployBat + '" --no-bump --no-pause'
    & cmd.exe /d /c $deployCommand
    if ($LASTEXITCODE -ne 0) { Stop-Wizard "배포 실패: 종료 코드 $LASTEXITCODE" }

    Write-Step 10 '테스트 이메일 자동 발송'
    $workerHostName = $workerName.ToLowerInvariant()
    $workerUrl = "https://$workerHostName.$($workersDev.Subdomain).workers.dev"
    Write-Host '배포된 Worker의 /__cron?test=1 엔드포인트로 테스트 이메일을 요청합니다.'
    Send-TestReviewEmail -WorkerUrl $workerUrl -CronKey ([string]$script:envValues['CRON_KEY'])

    Write-Step 11 '이메일 수신 성공 확인'
    # 배포는 9단계에서 이미 끝났다. 메일이 늦게 오거나 스팸으로 갔다고 해서 여기서 마법사를
    # 중단하면, 정작 앱을 쓰기 시작하는 12단계 안내를 못 보고 끝난다. 다시 보내기와
    # 나중에 확인하기를 열어 둔다.
    $mailVerified = $false
    while ($true) {
        Write-Host '받는 주소의 받은편지함과 스팸함을 확인하세요.'
        if (Confirm-Choice 'PS Log 테스트 이메일을 정상적으로 받았나요?' $false) {
            $mailVerified = $true
            break
        }
        Write-Host "`n메일이 아직 없다면 아래를 확인해 보세요." -ForegroundColor Yellow
        Write-Host '- 스팸함과 프로모션 탭 (첫 발송은 스팸으로 분류되는 경우가 많습니다)'
        Write-Host '- Resend 대시보드의 Logs 에 발송 기록이 남았는지'
        Write-Host '- MAIL_FROM을 비워 뒀다면, 받는 주소가 Resend 가입 이메일과 같은지'
        Open-HelpPage 'Resend 발송 기록(Logs)' 'https://resend.com/emails'
        if (Confirm-Choice '테스트 메일을 한 번 더 보낼까요?' $true) {
            Send-TestReviewEmail -WorkerUrl $workerUrl -CronKey ([string]$script:envValues['CRON_KEY'])
            continue
        }
        if (Confirm-Choice '메일 확인은 나중에 하고 나머지 설정을 계속할까요?' $true) { break }
        Stop-Wizard '이메일 수신 확인이 끝나지 않아 최초 설정을 완료하지 않았습니다.'
    }

    Write-Step 12 '웹페이지에서 R/W GitHub 토큰 입력 후 사용'
    Write-Host "PS Log 주소: $workerUrl" -ForegroundColor Cyan
    Write-Host '1. 위 웹페이지를 열고 오른쪽 위 설정을 누릅니다.'
    Write-Host "2. 저장소에는 $repoFullName, 브랜치에는 $branch, 경로에는 $dataPath 를 입력합니다."
    Write-Host '3. 6단계에서 보관해 둔 첫 번째 ps-log R/W GitHub 토큰을 입력합니다.'
    Write-Host '   (6단계에서 클립보드에 복사했다면 그대로 Ctrl+V 하면 됩니다.)'
    Write-Host '4. 설정을 저장한 뒤 동기화를 눌러 data.json 읽기·쓰기가 되는지 확인합니다.'
    Write-Host '5. 이후 코드를 수정해 재배포할 때는 re_settings.bat을 실행하면 됩니다.'
    Open-HelpPage '배포된 PS Log' $workerUrl
    if (-not $mailVerified) {
        Write-Host "`n[남은 확인] 테스트 이메일 수신을 아직 확인하지 못했습니다." -ForegroundColor Yellow
        Write-Host '배포와 설정은 모두 끝났으므로 웹앱은 지금 바로 쓸 수 있습니다.'
        Write-Host '메일만 다시 확인하려면 아래 주소를 브라우저 주소창이 아니라 터미널에서 호출하세요.'
        Write-Host "  curl.exe -X POST -H `"Authorization: Bearer <CRON_KEY>`" `"$workerUrl/__cron?test=1`""
        Write-Host 'CRON_KEY는 8단계에서 표시된 값이며 .env에도 저장돼 있습니다.'
    }
    Write-Host "`n모든 최초 설정, 배포, 테스트가 완료됐습니다." -ForegroundColor Green
    exit 0
} catch {
    [Console]::Error.WriteLine("[오류] $($_.Exception.Message)")
    exit 1
}
