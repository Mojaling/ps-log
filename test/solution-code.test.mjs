import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SOLUTION_BYTES,
  normalizeSolutionLanguage,
  solutionByteLength,
  solutionLanguageLabel,
} from '../public/solution-code.js';

test('풀이 언어 별칭을 C++·Python·Java 세 종류로 정규화한다', () => {
  assert.equal(normalizeSolutionLanguage('C++'), 'cpp');
  assert.equal(normalizeSolutionLanguage('py'), 'python');
  assert.equal(normalizeSolutionLanguage('JAVA'), 'java');
  assert.equal(normalizeSolutionLanguage('javascript'), '');
  assert.equal(solutionLanguageLabel('cpp'), 'C++');
});

test('풀이 용량은 UTF-8 바이트를 기준으로 계산한다', () => {
  assert.equal(solutionByteLength('abc'), 3);
  assert.equal(solutionByteLength('가'), 3);
  assert.equal(MAX_SOLUTION_BYTES, 64 * 1024);
});

