import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wizard = readFileSync(new URL('../scripts/setup-wizard-kor.ps1', import.meta.url), 'utf8');
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
  assert.match(wizard, /두 토큰 모두 실제 data\.json이 있는 Private 데이터 저장소만 선택/);
  assert.match(wizard, /이 토큰은 \.env에 넣지 않고 마지막에 PS Log 웹 설정에만 입력/);
  assert.doesNotMatch(wizard, /Set-DotEnvValue\s+'(?:BROWSER|RW)_GITHUB_TOKEN'/);
});

test('배포와 시크릿 등록은 사용자가 선택한 동일 Worker 이름을 사용한다', () => {
  assert.match(deploy, /'deploy', '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
  assert.match(deploy, /'secret', 'put', \$secretName, '--name', \[string\]\$envValues\['WORKER_NAME'\]/);
});

test('.env는 Git 추적 제외 상태를 유지한다', () => {
  assert.match(gitignore, /^\.env$/m);
});
