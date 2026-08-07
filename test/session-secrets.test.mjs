import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSessionSecret, saveSessionSecret } from '../public/session-secrets.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
  };
}

test('기존 localStorage 토큰은 세션으로 옮기고 영구 설정에서 삭제한다', () => {
  const persistent = memoryStorage({sync:JSON.stringify({repo:'me/private', token:'github_pat_secret'})});
  const session = memoryStorage();
  const loaded = loadSessionSecret(persistent, session, {
    persistentKey:'sync', sessionKey:'token', secretField:'token',
  });
  assert.equal(loaded.secret, 'github_pat_secret');
  assert.deepEqual(JSON.parse(persistent.getItem('sync')), {repo:'me/private'});
  assert.equal(session.getItem('token'), 'github_pat_secret');
});

test('새 비밀키는 sessionStorage에만 저장한다', () => {
  const persistent = memoryStorage();
  const session = memoryStorage();
  saveSessionSecret(persistent, session, {
    persistentKey:'usage', sessionKey:'cron', secretField:'cronKey',
    config:{label:'local'}, secret:'cron-secret',
  });
  assert.deepEqual(JSON.parse(persistent.getItem('usage')), {label:'local'});
  assert.equal(session.getItem('cron'), 'cron-secret');
});
