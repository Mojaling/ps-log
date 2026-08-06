import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { authorized, buildHTML, collectDue, configuredTeamBase, cookieValue, safeLink, sendMail } from '../worker/index.js';

test('가장 먼저 밀린 미완료 복습만 수집한다', () => {
  const data = { problems:[{
    id:'p1', firstResult:'fail', title:'테스트',
    reviews:[
      {due:'2026-08-01', done:false},
      {due:'2026-08-03', done:false},
      {due:'2026-08-20', done:false},
    ],
  }] };
  const due = collectDue(data, '2026-08-04');
  assert.equal(due.length, 1);
  assert.equal(due[0].idx, 0);
});

test('메일 HTML은 사용자 값과 위험 링크를 실행 가능한 HTML로 만들지 않는다', () => {
  const due = [{
    p:{number:'<b>1</b>', title:'<script>alert(1)</script>', site:'X', link:'javascript:alert(1)'},
    idx:0,
    review:{due:'2026-08-01'},
  }];
  const html = buildHTML(due, '2026-08-04');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.equal(safeLink('https://example.com'), 'https://example.com/');
  assert.equal(safeLink('javascript:alert(1)'), null);
});

test('Resend 직접 호출에는 필수 User-Agent와 인증 헤더를 포함한다', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = {url, options};
    return new Response('{}', {status: 200});
  };
  try {
    await sendMail({RESEND_API_KEY:'re_test'}, 'me@example.com', 'test', '<p>test</p>');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.options.headers.Authorization, 'Bearer re_test');
  assert.equal(captured.options.headers['User-Agent'], 'ps-log-worker/1.0');
});

test('관리 키는 헤더로만 받고 쿼리 키는 거부한다', () => {
  const env = {CRON_KEY:'test-secret'};
  assert.equal(authorized(
    new Request('https://example.com/__cron', {headers:{Authorization:'Bearer test-secret'}}),
    new URL('https://example.com/__cron'), env), true);
  assert.equal(authorized(
    new Request('https://example.com/__cron?key=test-secret'),
    new URL('https://example.com/__cron?key=test-secret'), env), false);
});

test('관리 엔드포인트는 용도별 HTTP 메서드만 허용한다', async () => {
  const cron = await worker.fetch(new Request('https://example.com/__cron'), {});
  const usage = await worker.fetch(new Request('https://example.com/__usage', {method:'POST'}), {});
  assert.equal(cron.status, 405);
  assert.equal(cron.headers.get('allow'), 'POST');
  assert.equal(usage.status, 405);
  assert.equal(usage.headers.get('allow'), 'GET');
});

test('팀 서버 주소는 안전한 origin만 허용하고 세션 쿠키를 읽는다', () => {
  assert.equal(configuredTeamBase({TEAM_API_BASE:'https://team.example.com/'}), 'https://team.example.com');
  assert.equal(configuredTeamBase({TEAM_API_BASE:'https://team.example.com/path'}), null);
  assert.equal(configuredTeamBase({TEAM_API_BASE:'javascript:alert(1)'}), null);
  assert.equal(cookieValue(new Request('https://app.example.com', {headers:{Cookie:'a=1; pslog_team_session=hello%20team'}}), 'pslog_team_session'), 'hello team');
});

test('팀 미설정 배포는 config에서 비활성 상태만 공개한다', async () => {
  const response = await worker.fetch(new Request('https://app.example.com/__team/config'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {enabled:false});
});
