import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalProblem,
  canonicalTodo,
  eventKey,
  localActivitiesForDate,
  loadOutbox,
  loadSolutionSync,
  missedTodoActivities,
  saveOutbox,
  saveSolutionSync,
  sharedProblemCatalogData,
  sharedProblemMetadata,
  settledEventIds,
  teamAuthCode,
} from '../public/team-client.js';

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

test('팀 로그인 일회용 코드는 URL 쿼리가 아닌 fragment에서만 읽는다', () => {
  assert.equal(teamAuthCode('#team-auth=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(teamAuthCode('?code=abc_DEF-123'), '');
  assert.equal(teamAuthCode('#team'), '');
});

test('Todo 식별값에는 내용 대신 ID와 날짜만 사용한다', () => {
  assert.equal(canonicalTodo({id:'todo-1', date:'2026-08-07', text:'비공개 할 일'}), 'todo|todo-1|2026-08-07');
});

test('점수 활동에는 문제 공개 필드만 보내고 개인 메모와 풀이 코드는 제외한다', () => {
  assert.deepEqual(sharedProblemMetadata({
    site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', link:'https://example.com',
    notes:'비공개 메모', code:'secret',
  }), {site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', link:'https://example.com'});
});

test('문제 카탈로그에는 선택한 C++·Python·Java 풀이만 공유한다', () => {
  assert.deepEqual(sharedProblemCatalogData({
    site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', link:'https://example.com',
    note:'비공개 메모', solutionLanguage:'c++', solutionCode:'int main() {}',
  }), {
    site:'BOJ', number:'1000', title:'A+B', difficulty:'D1', link:'https://example.com',
    solutionLanguage:'cpp', solutionCode:'int main() {}',
  });
  assert.deepEqual(sharedProblemCatalogData({
    site:'BOJ', title:'A', solutionLanguage:'javascript', solutionCode:'alert(1)',
  }).solutionCode, '');
});

test('이미 공유한 풀이의 본문 대신 해시만 브라우저에 기억한다', () => {
  const storage = memoryStorage();
  saveSolutionSync({abc:'f'.repeat(64)}, storage);
  assert.deepEqual(loadSolutionSync(storage), {abc:'f'.repeat(64)});
  assert.doesNotMatch(storage.getItem('pslog.team-solution-sync.v1'), /int main|print\(/);
});

test('오전 8시에 마감된 미완료 Todo만 감점 활동으로 만든다', () => {
  const now = new Date('2026-08-08T00:00:00Z'); // 한국 시간 8월 8일 오전 9시
  const activities = missedTodoActivities([
    {id:'missed', date:'2026-08-07', done:false},
    {id:'done', date:'2026-08-07', done:true},
    {id:'today', date:'2026-08-08', done:false},
  ], now);
  assert.deepEqual(activities.map(item => [item.type, item.todo.id, item.activityDate]), [
    ['todo_missed', 'missed', '2026-08-07'],
  ]);
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

