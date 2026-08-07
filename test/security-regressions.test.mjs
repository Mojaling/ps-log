import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const worker = read('worker/index.js');
const teamWorker = read('team-worker/index.js');

test('이메일은 URL·브라우저 설정·동기화 데이터 경로에서 제거한다', () => {
  assert.doesNotMatch(app, /settings\.email|s-email|mailto:/);
  assert.doesNotMatch(html, /id="s-email"/);
  assert.doesNotMatch(worker, /settings\.email/);
  assert.match(worker, /const to = env\.MAIL_TO;/);
});

test('외부 제공자 오류 응답 본문을 Worker 로그에 기록하지 않는다', () => {
  assert.doesNotMatch(worker, /console\.error\([^\n]*(?:await\s+\w+\.text\(\)|JSON\.stringify\(j\.errors\))/);
});

test('팀 일회용 코드는 개인 사이트 query URL로 만들지 않는다', () => {
  assert.doesNotMatch(teamWorker, /auth\/callback[^\n]*searchParams\.set\(['"]code/);
  assert.match(teamWorker, /redirect\.hash = `team-auth=/);
  assert.match(worker, /SameSite=Strict/);
});
