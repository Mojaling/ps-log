$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Read-Env([string]$Path) {
    $values = @{}
    foreach ($sourceLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $sourceLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) { $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
    }
    return $values
}

try {
    $envPath = Join-Path $projectRoot '.team.env'
    $configPath = Join-Path $projectRoot 'wrangler.team.local.jsonc'
    if (-not (Test-Path -LiteralPath $envPath)) { throw '먼저 team_settings_kor.bat으로 중앙 서버를 설정하세요.' }
    if (-not (Test-Path -LiteralPath $configPath)) { throw '팀 서버 배포 설정을 찾을 수 없습니다. team_settings_kor.bat을 다시 실행하세요.' }
    $values = Read-Env $envPath
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $teamUrl = [string]$config.vars.TEAM_PUBLIC_URL
    $adminKey = [string]$values['ADMIN_KEY']
    if (-not $teamUrl -or -not $adminKey) { throw '팀 서버 주소 또는 ADMIN_KEY가 없습니다.' }

    $label = (Read-Host '팀원 이름/메모 (선택)').Trim()
    $hoursText = (Read-Host '유효 시간 [24]').Trim()
    $hours = if ($hoursText) { [int]$hoursText } else { 24 }
    if ($hours -lt 1 -or $hours -gt 168) { throw '유효 시간은 1~168시간이어야 합니다.' }
    $body = @{ label=$label; maxUses=1; expiresInHours=$hours } | ConvertTo-Json -Compress
    $invite = Invoke-RestMethod -Method Post -Uri "$teamUrl/v1/admin/invites" `
        -Headers @{ Authorization="Bearer $adminKey"; 'Content-Type'='application/json' } -Body $body
    Write-Host "`n팀 서버 주소: $teamUrl" -ForegroundColor Cyan
    Write-Host "일회용 초대 코드: $($invite.code)" -ForegroundColor Yellow
    Write-Host "유효 시간: $hours 시간 · 한 번 사용하면 만료됩니다."
    exit 0
} catch {
    [Console]::Error.WriteLine("[오류] $($_.Exception.Message)")
    exit 1
}

