import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewSchedule, inferProblemReviewOffsets, normalizeReviewOffsets, parseReviewOffsets } from '../public/review-schedule.js';

test('복습 날짜를 정렬하고 최대 5회로 검증한다', () => {
  assert.deepEqual(parseReviewOffsets('30, 5, 10, 25'), {ok:true, offsets:[5,10,25,30]});
  assert.equal(parseReviewOffsets('1,2,3,4,5,6').ok, false);
  assert.equal(parseReviewOffsets('5,5').ok, false);
  assert.equal(parseReviewOffsets('0,10').ok, false);
});

test('이전 문제의 3·7·21 일정은 날짜에서 복원한다', () => {
  const problem = {attemptDate:'2026-08-01', reviews:[{due:'2026-08-04'},{due:'2026-08-08'},{due:'2026-08-22'}]};
  const diff = (a,b)=>(new Date(`${b}T00:00:00Z`)-new Date(`${a}T00:00:00Z`))/86400000;
  assert.deepEqual(inferProblemReviewOffsets(problem, diff), [3,7,21]);
});

test('사용자 설정으로 복습 일정을 생성한다', () => {
  const add = (iso, days)=>{
    const date = new Date(`${iso}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10);
  };
  assert.deepEqual(buildReviewSchedule('2026-08-01', [5,10], add), [
    {offset:5,due:'2026-08-06',done:false,doneDate:null},
    {offset:10,due:'2026-08-11',done:false,doneDate:null},
  ]);
  assert.deepEqual(normalizeReviewOffsets(null), [3,7,21]);
});
