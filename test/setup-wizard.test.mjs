import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wizard = readFileSync(new URL('../scripts/setup-wizard-kor.ps1', import.meta.url), 'utf8');
const wizardEn = readFileSync(new URL('../scripts/setup-wizard.ps1', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../scripts/deploy-setup.ps1', import.meta.url), 'utf8');
const cloudflare = readFileSync(new URL('../scripts/cloudflare-workers-dev.ps1', import.meta.url), 'utf8');
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
  assert.match(wizard, /12단계에서 웹 설정창에만 붙여넣습니다/);
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

// 웹용 R/W 토큰은 브라우저와 사용자의 비밀번호 관리자에만 있어야 한다.
// 마법사는 값을 보지도, 받지도 않는다.
test('웹용 R/W 토큰은 마법사가 아예 받지 않는다', () => {
  assert.match(wizard, /이 토큰은 마법사에 입력하지 않습니다/);
  assert.doesNotMatch(wizard, /Read-SecretValue '웹용/);
  assert.doesNotMatch(wizard, /Set-Clipboard/, '토큰을 클립보드에 올리지 않습니다');
  assert.doesNotMatch(wizard, /\$browserToken\s*=/, '토큰을 변수에 담지도 않습니다 ($browserTokenUrl 은 주소라 무관)');
  // 발급 여부만 확인하고, 아니라고 하면 재발급을 안내한 뒤 다시 묻는다.
  assert.match(wizard, /while \(-not \(Confirm-Choice 'ps-log R\/W 토큰을 발급하고 안전한 곳에 저장했나요\?' \$false\)\)/);
  assert.match(wizard, /놓쳤다면 새로 발급해야 합니다/);
  assert.match(wizard, /다시 발급[\s\S]{0,300}?Contents\s+: Read and write/);
});

// 토큰을 받지 않으니 권한 오류는 12단계 동기화에서야 드러난다. 읽는 법을 알려 준다.
test('12단계는 동기화 실패를 토큰 권한 문제로 해석해 준다', () => {
  assert.match(wizard, /401 \/ 404 -> Repository access가/);
  assert.match(wizard, /403\s+-> Contents가 Read-only/);
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

// Windows PowerShell 5.1은 $ErrorActionPreference='Stop' 에서 네이티브 명령의 stderr를
// 리다이렉트하면 예외를 던진다. gh는 "저장소 없음"도 stderr로 알리므로, 존재 확인에
// *> $null 을 쓰면 없을 때 만들어 주는 코드까지 가지 못하고 마법사가 죽는다.
test('존재 여부 확인은 예외가 아니라 종료 코드로 판단한다', () => {
  for(const [name, source] of Object.entries({'setup-wizard-kor.ps1': wizard, 'setup-wizard.ps1': wizardEn})){
    assert.match(source, /function Invoke-NativeProbe/, `${name}: 프로브 실행기가 없습니다`);
    assert.doesNotMatch(source, /\*>\s*\$null/,
      `${name}: *> $null 프로브가 남아 있으면 PowerShell 5.1에서 예외로 죽습니다`);
    // 프로브가 끝나면 Stop 설정을 반드시 되돌려야 이후 단계의 오류 처리가 유지된다.
    assert.match(source, /\$ErrorActionPreference = 'Continue'[\s\S]*?finally \{\s*\$ErrorActionPreference = \$previous/);
  }
  assert.match(wizard, /Invoke-NativeProbe \$GhPath @\('repo', 'view'/);
  assert.match(wizard, /Invoke-NativeProbe \$GhPath @\('auth', 'status'/);
});

test('데이터 저장소는 없으면 만들고 생성 결과를 확인한다', () => {
  assert.match(wizard, /repo create \$fullName --private/);
  // 생성 직후 조회가 늦어질 수 있어 재확인 없이 다음 단계로 넘어가면 안 된다.
  assert.match(wizard, /foreach \(\$attempt in 1\.\.5\)[\s\S]*?Invoke-NativeProbe \$GhPath @\('repo', 'view'/);
});

test('배포와 시크릿 등록은 사용자가 선택한 동일 Worker 이름을 사용한다', () => {
  assert.match(deploy, /'deploy', '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
  assert.match(deploy, /'secret', 'put', \$secretName, '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
});

test('Windows에서는 npx 중첩 프로세스 없이 로컬 Wrangler CLI를 직접 실행한다', () => {
  assert.match(cloudflare, /node_modules\\wrangler\\bin\\wrangler\.js/);
  for(const [name, source] of Object.entries({
    'setup-wizard-kor.ps1': wizard,
    'setup-wizard.ps1': wizardEn,
    'deploy-setup.ps1': deploy,
    'cloudflare-workers-dev.ps1': cloudflare,
  })){
    assert.doesNotMatch(source, /&\s*npx\.cmd[^\n]*wrangler/,
      `${name}: npx를 거친 Wrangler 실행이 남아 있습니다`);
  }
  assert.match(wizard, /login[\s\S]{0,700}?Test-WranglerAuthentication/,
    'OAuth 프로세스 종료 후 실제 로그인 상태를 다시 확인해야 합니다');
});

// 버전만 올리고 커밋하지 않으면 배포할 때마다 작업 트리가 더러워져 다음 git pull이 막힌다.
test('배포는 올린 버전 번호를 커밋해 작업 트리를 깨끗하게 남긴다', () => {
  const body = deploy.match(/function Save-VersionBumpCommit[\s\S]*?\n\}/);
  assert.ok(body, 'Save-VersionBumpCommit 함수가 없습니다');
  const fn = body[0];

  // 배포가 성공한 뒤에 커밋해야 한다. 실패하면 version.js는 원래대로 되돌아간다.
  assert.match(deploy, /Updating Worker secrets[\s\S]*?if \(-not \$NoVersionBump\) \{ Save-VersionBumpCommit/);
  // 작업 중인 다른 변경까지 함께 커밋하면 안 된다.
  assert.match(fn, /commit --only[^\n]*-- \$VersionPath/);
  assert.doesNotMatch(fn, /add -A/);
  // 커밋 실패가 배포 실패로 뒤집히면 안 된다 — Worker는 이미 올라간 뒤다.
  assert.match(fn, /could not be committed/);
  assert.doesNotMatch(fn, /Stop-Setup/);
  // 푸시는 사용자의 몫이다 (안내 문구의 'not pushed'는 걸리지 않도록 git 호출만 본다).
  assert.doesNotMatch(fn, /git\.exe[^\n]*push/);
});

test('.env는 Git 추적 제외 상태를 유지한다', () => {
  assert.match(gitignore, /^\.env$/m);
});
