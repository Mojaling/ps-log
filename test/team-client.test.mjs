import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProblem, loadOutbox, saveOutbox } from '../public/team-client.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
  };
}

test('팀 서버에 보내기 전 문제 식별값을 정규화한다', () => {
  assert.equal(canonicalProblem({site:' 백준 ', number:' 1000 ', title:'A+B'}), '백준|1000');
  assert.equal(canonicalProblem({site:'LeetCode', title:' Two Sum '}), 'leetcode|two sum');
});

test('팀 활동 outbox는 손상된 값과 최대 개수를 안전하게 처리한다', () => {
  const storage = memoryStorage();
  storage.setItem('pslog.team-outbox.v1', '{broken');
  assert.deepEqual(loadOutbox(storage), []);
  const events = Array.from({length:205}, (_, index) => ({eventId:`e${index}`, type:'problem_solved'}));
  saveOutbox(events, storage);
  const loaded = loadOutbox(storage);
  assert.equal(loaded.length, 200);
  assert.equal(loaded[0].eventId, 'e5');
});

