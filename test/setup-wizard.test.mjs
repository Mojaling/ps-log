import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wizard = readFileSync(new URL('../scripts/setup-wizard-kor.ps1', import.meta.url), 'utf8');
const wizardEn = readFileSync(new URL('../scripts/setup-wizard.ps1', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../scripts/deploy-setup.ps1', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

test('한글 최초 설정 마법사는 합의한 12단계를 순서대로 유지한다', () => {
  const steps = [...wizard.matchAll(/Write-Step\s+(\d+)\s+'([^']+)'/g)]
    .map(([, number, title]) => ({number: Number(number), title}));
  assert.deepEqual(steps.map(step => step.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.match(steps[2].title, /Cloudflare.*workers\.dev/);
  assert.match(steps[4].title, /Private.*data\.json/);
  assert.match(steps[9].title, /테스트 이메일/);
  assert.match(steps[11].title, /R\/W GitHub 토큰/);
});

test('최초 설정은 외부 서비스의 핵심 값을 배포 전에 검증한다', () => {
  assert.match(wizard, /Get-WorkersDevRegistration/);
  assert.match(wizard, /Ensure-PrivateDataRepository/);
  assert.match(wizard, /Publish-InitialDataFile/);
  assert.match(wizard, /Test-WorkerGitHubToken/);
  assert.match(wizard, /RESEND_API_KEY.+-notmatch '\^re_/s);
  assert.match(wizard, /Send-TestReviewEmail/);
  assert.match(wizard, /PS Log 테스트 이메일을 정상적으로 받았나요/);
});

test('브라우저 R/W 토큰은 데이터 저장소 전용이며 env에 저장하지 않는다', () => {
  assert.match(wizard, /코드 Fork 저장소를 고르면 웹에서 data\.json을 읽고 쓸 수 없습니다/);
  assert.match(wizard, /이 토큰은 \.env에 저장하지 않습니다/);
  assert.doesNotMatch(wizard, /Set-DotEnvValue\s+'(?:BROWSER|RW)_GITHUB_TOKEN'/);
  // 웹용 토큰이 .env에 흘러드는 경로가 생기면 안 된다.
  assert.doesNotMatch(wizard, /Set-DotEnvValue[^\n]*\$browserToken/);
  assert.doesNotMatch(wizard, /Ensure-Secret[^\n]*웹용/);
});

// GitHub는 fine-grained 토큰 생성 API를 주지 않는다. 발급 화면 프리필이 유일한 자동화 수단이라
// 주소가 깨지면 사용자가 다시 손으로 다 채워야 한다.
test('두 토큰 모두 미리 채워진 발급 화면으로 안내한다', () => {
  const wizards = {'setup-wizard-kor.ps1': wizard, 'setup-wizard.ps1': wizardEn};
  for(const [name, source] of Object.entries(wizards)){
    assert.match(source, /function New-TokenPageUrl/, `${name}: URL 생성기가 없습니다`);
    for(const param of ['name=', 'description=', 'target_name=', 'expires_in=', 'contents=']){
      assert.ok(source.includes(param), `${name}: 프리필 인자 ${param} 가 빠졌습니다`);
    }
    assert.match(source, /New-TokenPageUrl[^\n]*-Contents 'write'/, `${name}: 웹용 R/W 주소가 없습니다`);
    assert.match(source, /New-TokenPageUrl[^\n]*-Contents 'read'/, `${name}: Worker용 Read-only 주소가 없습니다`);
    // 프리필 없는 맨 주소로 돌아가면 자동화가 무의미해진다.
    assert.doesNotMatch(source, /'https:\/\/github\.com\/settings\/personal-access-tokens\/new'/,
      `${name}: 프리필 없는 발급 주소가 남아 있습니다`);
  }
});

test('웹용 토큰은 넘어가기 전에 읽기·쓰기 권한을 실제로 확인한다', () => {
  assert.match(wizard, /function Test-BrowserGitHubToken/);
  assert.match(wizard, /Test-BrowserGitHubToken -Owner \$owner/);
  // 권한 확인 때문에 사용자의 기록에 커밋이 남으면 안 된다.
  assert.match(wizard, /git\/blobs/, '쓰기 확인은 브랜치를 건드리지 않는 blob 생성으로 한다');
  assert.doesNotMatch(wizard, /Test-BrowserGitHubToken[\s\S]*?Invoke-RestMethod -Method Put/,
    '권한 확인이 data.json을 덮어쓰면 안 됩니다');
});

// 처음 쓰는 사람이 가장 많이 막히는 지점 세 곳 — 준비물, 계정 가입, 메일 지연.
test('필수 프로그램은 안내만 하지 않고 자동 설치를 시도한다', () => {
  assert.match(wizard, /Ensure-RequiredTool 'git\.exe'[^\n]*Git\.Git/);
  assert.match(wizard, /Ensure-RequiredTool 'node\.exe'[^\n]*OpenJS\.NodeJS\.LTS/);
  // winget 직후에는 PATH가 옛날 값이라 방금 깐 프로그램을 못 찾는다.
  assert.match(wizard, /function Update-SessionPath/);
  assert.match(wizard, /Update-SessionPath[\s\S]{0,400}?return \$true/,
    'winget 설치 뒤 PATH를 갱신해야 같은 창에서 이어갈 수 있습니다');
  // PATH를 읽지 못했을 때 기존 PATH를 지워 버리면 이후 모든 명령이 깨진다.
  assert.match(wizard, /if \(\$parts\) \{ \$env:Path = /);
});

test('가입이 필요한 서비스는 로그인 화면 전에 계정부터 확인한다', () => {
  assert.match(wizard, /function Ensure-ServiceAccount/);
  for(const [service, url] of [
    ['GitHub', 'https://github.com/signup'],
    ['Cloudflare', 'https://dash.cloudflare.com/sign-up'],
    ['Resend', 'https://resend.com/signup'],
  ]){
    assert.match(wizard, new RegExp(`Ensure-ServiceAccount '${service}' '${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `${service} 가입 안내가 없습니다`);
  }
});

test('테스트 메일이 늦어도 배포 완료 안내까지는 도달한다', () => {
  // 배포는 9단계에서 이미 끝났으므로 11단계에서 막히면 안 된다.
  assert.match(wizard, /테스트 메일을 한 번 더 보낼까요/);
  assert.match(wizard, /메일 확인은 나중에 하고 나머지 설정을 계속할까요/);
  assert.match(wizard, /\$mailVerified = \$true/);
  assert.match(wizard, /if \(-not \$mailVerified\)/, '건너뛴 경우 12단계에서 다시 안내해야 합니다');
});

test('배포와 시크릿 등록은 사용자가 선택한 동일 Worker 이름을 사용한다', () => {
  assert.match(deploy, /'deploy', '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
  assert.match(deploy, /'secret', 'put', \$secretName, '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
});

test('.env는 Git 추적 제외 상태를 유지한다', () => {
  assert.match(gitignore, /^\.env$/m);
});
