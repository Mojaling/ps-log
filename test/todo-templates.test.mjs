import test from 'node:test';
import assert from 'node:assert/strict';
import { missingTodoTemplatesForDate, normalizeTodoTemplates } from '../public/todo-templates.js';

test('기본 Todo를 정리하고 같은 날 중복 추가를 막는다', () => {
  const templates = normalizeTodoTemplates([
    {id:'one', text:' 문제 1개 ', color:'yellow'},
    {id:'two', text:'복습', color:'invalid'},
  ]);
  assert.deepEqual(templates, [
    {id:'one', text:'문제 1개', color:'yellow'},
    {id:'two', text:'복습', color:'blue'},
  ]);
  assert.deepEqual(missingTodoTemplatesForDate(templates, [
    {date:'2026-08-06', templateId:'one'},
  ], '2026-08-06').map(item=>item.id), ['two']);
});
