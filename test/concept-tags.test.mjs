import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConceptTags, conceptHasTag, normalizeConceptTags } from '../public/concept-tags.js';

test('개념 태그의 공백과 대소문자 중복을 정리한다', ()=>{
  assert.deepEqual(normalizeConceptTags([' 그래프 ', 'DP', 'graph', 'dp', '', null]), ['그래프', 'DP', 'graph']);
});

test('노트에서 태그를 대소문자와 관계없이 정확히 찾는다', ()=>{
  const concept = {tags:['JavaScript', '브라우저']};
  assert.equal(conceptHasTag(concept, 'javascript'), true);
  assert.equal(conceptHasTag(concept, 'Java'), false);
});

test('현재 노트들의 태그를 사용 횟수순으로 모은다', ()=>{
  const tags = collectConceptTags([
    {tags:['그래프', '최단경로']},
    {tags:['그래프', 'DP']},
    {tags:['dp']},
  ]);
  assert.deepEqual(tags, [
    {key:'그래프', name:'그래프', count:2},
    {key:'dp', name:'DP', count:2},
    {key:'최단경로', name:'최단경로', count:1},
  ]);
});
