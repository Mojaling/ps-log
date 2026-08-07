import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const headers = readFileSync(fileURLToPath(new URL('public/_headers', root)), 'utf8');
const appSource = readFileSync(fileURLToPath(new URL('public/app.js', root)), 'utf8');

function directive(name){
  const policy = headers.match(/Content-Security-Policy:\s*(.+)/);
  assert.ok(policy, '_headers에 Content-Security-Policy가 없습니다');
  const found = policy[1].split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name} `));
  assert.ok(found, `CSP에 ${name} 지시문이 없습니다`);
  return found.split(/\s+/).slice(1);
}

// 미리보기는 사진을 blob: 주소로 붙인다. CSP가 blob:을 빠뜨리면 브라우저가 조용히 차단해
// 노트의 사진이 전부 사라진다 (테스트로는 드러나지 않고 배포된 사이트에서만 보인다).
test('CSP는 미리보기가 만드는 blob: 이미지 주소를 허용한다', ()=>{
  assert.ok(appSource.includes('URL.createObjectURL'),
    '앱이 더 이상 object URL을 쓰지 않는다면 이 테스트를 함께 정리하세요');
  const imgSrc = directive('img-src');
  assert.ok(imgSrc.includes('blob:'), `img-src에 blob:이 없습니다: ${imgSrc.join(' ')}`);
  assert.ok(imgSrc.includes("'self'"));
  assert.ok(imgSrc.includes('data:'), '외부 data: 이미지 문법을 위해 data:도 유지합니다');
});

test('CSP는 스크립트를 같은 오리진으로 제한한다', ()=>{
  assert.deepEqual(directive('script-src'), ["'self'"]);
  assert.deepEqual(directive('connect-src'), ["'self'", 'https://api.github.com']);
});

test('민감 페이지용 보안 헤더를 함께 제공한다', ()=>{
  assert.match(headers, /Referrer-Policy:\s*no-referrer/i);
  assert.match(headers, /Strict-Transport-Security:\s*max-age=/i);
  assert.match(headers, /Permissions-Policy:/i);
  assert.match(headers, /Cross-Origin-Opener-Policy:\s*same-origin/i);
});

test('Markdown 링크와 data 이미지에서 mailto 및 SVG를 허용하지 않는다', ()=>{
  assert.doesNotMatch(appSource, /SAFE_LINK_SCHEMES\s*=\s*\[[^\]]*mailto:/);
  assert.doesNotMatch(appSource, /SAFE_IMG_DATA[^\n]*svg\\\+xml/);
});
