import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONCEPT_CATEGORIES, MAX_CONCEPT_CATEGORIES, normalizeConceptCategories } from '../public/concept-categories.js';

test('기존 네 카테고리를 기본값으로 유지한다', () => {
  assert.deepEqual(normalizeConceptCategories(null), DEFAULT_CONCEPT_CATEGORIES.map(item=>({...item})));
});

test('사용자 카테고리는 이름과 ID를 정리하고 최대 6개만 유지한다', () => {
  const source = Array.from({length:8}, (_,i)=>({id:`category-${i}`,name:`분류 ${i}`}));
  const result = normalizeConceptCategories(source);
  assert.equal(result.length, MAX_CONCEPT_CATEGORIES);
  assert.equal(result[0].name, '분류 0');
});
