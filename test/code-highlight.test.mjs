import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodeLanguage } from '../public/code-highlight.js';

test('Markdown 코드 언어 별칭을 Prism 언어명으로 맞춘다', ()=>{
  assert.equal(normalizeCodeLanguage('c++'), 'cpp');
  assert.equal(normalizeCodeLanguage('CPP'), 'cpp');
  assert.equal(normalizeCodeLanguage('py'), 'python');
  assert.equal(normalizeCodeLanguage('java'), 'java');
});
