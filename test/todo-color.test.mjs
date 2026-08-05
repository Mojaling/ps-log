import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTodoColor, normalizeTodoColor } from '../public/todo-color.js';

test('Todo 색상은 파랑·노랑·보라만 허용한다', ()=>{
  assert.equal(normalizeTodoColor('yellow'), 'yellow');
  assert.equal(normalizeTodoColor('unknown'), 'blue');
});

test('Todo 색상 변경 버튼은 세 색상을 순환한다', ()=>{
  assert.equal(nextTodoColor('blue'), 'yellow');
  assert.equal(nextTodoColor('yellow'), 'purple');
  assert.equal(nextTodoColor('purple'), 'blue');
});
