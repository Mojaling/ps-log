import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProblem, eventKey, localActivitiesForDate, loadOutbox, saveOutbox, settledEventIds } from '../public/team-client.js';

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

test('같은 문제에서 같은 날 여러 복습 단계를 끝내도 팀 활동은 한 번만 만든다', () => {
  const problem = {
    site:'SWEA', number:'1213', firstResult:'fail', attemptDate:'2026-07-30', reviewOffsets:[3,7,21],
    reviews:[
      {offset:3, done:true, doneDate:'2026-08-06'},
      {offset:7, done:true, doneDate:'2026-08-06'},
      {offset:21, done:false, doneDate:null},
    ],
  };
  const activities = localActivitiesForDate([problem], '2026-08-06');
  assert.equal(activities.length, 1);
  assert.equal(activities[0].type, 'review_completed');
  assert.equal(activities[0].stage, 7);
});

test('같은 문제와 날짜의 팀 이벤트 키는 복습 단계와 무관하게 같다', () => {
  const base = {type:'review_completed', problemKey:'abc', activityDate:'2026-08-06'};
  assert.equal(eventKey({...base, stage:3}), eventKey({...base, stage:7}));
});

test('서버가 거절하거나 응답하지 않은 팀 이벤트는 전송 완료로 지우지 않는다', () => {
  const events = [{eventId:'ok'}, {eventId:'rejected'}, {eventId:'missing'}];
  const settled = settledEventIds(events, [
    {eventId:'ok', awarded:3},
    {eventId:'rejected', awarded:0, rejected:'review_not_due'},
  ]);
  assert.deepEqual([...settled], ['ok']);
});

