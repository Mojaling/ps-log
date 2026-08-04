import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentTodoDate,
  isTodoDateClosed,
  isTodoLocked,
  isTodoOverdue,
  millisecondsUntilNextTodoCutoff,
} from '../public/todo-cutoff.js';

test('한국 시간 오전 8시 전에는 전날 Todo를 계속 수정할 수 있다', () => {
  const now = new Date('2026-08-04T22:59:00Z'); // KST 2026-08-05 07:59
  assert.equal(currentTodoDate(now), '2026-08-04');
  assert.equal(isTodoDateClosed('2026-08-04', now), false);
  assert.equal(isTodoDateClosed('2026-08-03', now), true);
});

test('한국 시간 오전 8시부터 전날 미완료 Todo를 잠근다', () => {
  const now = new Date('2026-08-04T23:00:00Z'); // KST 2026-08-05 08:00
  assert.equal(currentTodoDate(now), '2026-08-05');
  assert.equal(isTodoLocked({date:'2026-08-04', done:false}, now), true);
  assert.equal(isTodoLocked({date:'2026-08-04', done:true}, now), true);
  assert.equal(isTodoOverdue({date:'2026-08-04', done:false}, now), true);
  assert.equal(isTodoOverdue({date:'2026-08-04', done:true}, now), false);
  assert.equal(isTodoLocked({date:'2026-08-05', done:false}, now), false);
});

test('다음 한국 시간 오전 8시까지 남은 시간을 계산한다', () => {
  const before = new Date('2026-08-04T22:59:00Z');
  const after = new Date('2026-08-04T23:01:00Z');
  assert.equal(millisecondsUntilNextTodoCutoff(before), 60_000);
  assert.equal(millisecondsUntilNextTodoCutoff(after), 23 * 60 * 60 * 1000 + 59 * 60 * 1000);
});
