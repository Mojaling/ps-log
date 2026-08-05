import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditHistory, TYPING_PAUSE_MS, UNDO_LIMIT } from '../public/editor-history.js';

const at = (value, caret = value.length) => ({value, selectionStart: caret, selectionEnd: caret});

test('되돌리기는 최근 10개까지만 남는다', ()=>{
  const history = createEditHistory();
  assert.equal(history.limit, UNDO_LIMIT);
  for(let i = 0; i < 25; i++) history.record(at(`단계 ${i}`));
  assert.equal(history.size, 10);
  // 가장 최근 것부터 나오고, 11개째부터는 사라진다.
  assert.equal(history.undo().value, '단계 24');
  const rest = [];
  let entry;
  while((entry = history.undo())) rest.push(entry.value);
  assert.deepEqual(rest, ['단계 23','단계 22','단계 21','단계 20','단계 19','단계 18','단계 17','단계 16','단계 15']);
  assert.equal(history.undo(), null, '비면 null 을 돌려준다');
});

test('되돌리면 커서 위치도 함께 복원된다', ()=>{
  const history = createEditHistory();
  history.record({value:'첫 줄\n둘째 줄', selectionStart:2, selectionEnd:5});
  const back = history.undo();
  assert.equal(back.value, '첫 줄\n둘째 줄');
  assert.equal(back.selectionStart, 2);
  assert.equal(back.selectionEnd, 5);
});

test('타이핑은 쉰 지점마다 한 칸씩만 쌓인다', ()=>{
  const history = createEditHistory();
  let now = 1000;
  history.recordTyping(at(''), now);              // 첫 입력 → 1칸
  for(let i = 1; i <= 20; i++) history.recordTyping(at('가'.repeat(i)), now += 50);
  assert.equal(history.size, 1, '연속으로 치는 동안에는 늘지 않는다');

  now += TYPING_PAUSE_MS + 1;                      // 잠시 쉬었다가
  history.recordTyping(at('가'.repeat(20)), now);
  assert.equal(history.size, 2, '쉬었다 이어 치면 한 칸 늘어난다');
});

test('내용이 같으면 쌓지 않는다', ()=>{
  const history = createEditHistory();
  history.record(at('같은 내용'));
  history.record(at('같은 내용'));
  history.record({value:'같은 내용', selectionStart:0, selectionEnd:2}); // 커서만 이동
  assert.equal(history.size, 1);
});

test('서식 편집은 타이핑 묶음을 끊는다', ()=>{
  const history = createEditHistory();
  let now = 1000;
  history.recordTyping(at('가'), now);
  history.record(at('가나'));                      // 서식 적용
  history.recordTyping(at('가나다'), now += 10);   // 곧바로 이어 쳐도
  assert.equal(history.size, 3, '서식 직후 타이핑은 따로 기록된다');
});

test('다른 노트를 열면 이전 기록이 남지 않는다', ()=>{
  const history = createEditHistory();
  history.record(at('A 노트 내용'));
  history.reset();
  assert.equal(history.size, 0);
  assert.equal(history.undo(), null);
});

test('잘못된 기록은 무시한다', ()=>{
  const history = createEditHistory();
  history.record(null);
  history.record({});
  history.record({value: 123});
  assert.equal(history.size, 0);
  // 범위를 벗어난 커서는 값 길이 안으로 맞춘다.
  history.record({value:'짧게', selectionStart:99, selectionEnd:120});
  const back = history.undo();
  assert.equal(back.selectionStart, 2);
  assert.equal(back.selectionEnd, 2);
});
