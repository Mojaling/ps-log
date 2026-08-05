import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactLegacyFormatting,
  highlightTags,
  indentSelection,
  renderCompactFormatting,
  textColorTags,
  toggleHighlight,
  toggleSelection,
  toggleTextColor,
} from '../public/editor-format.js';

test('선택한 텍스트의 서식을 적용하고 다시 실행하면 제거한다', ()=>{
  const bold = toggleSelection('앞 선택 뒤', 2, 4, '**', '**');
  assert.equal(bold.value, '앞 **선택** 뒤');
  assert.equal(bold.value.slice(bold.selectionStart, bold.selectionEnd), '선택');

  const plain = toggleSelection(bold.value, bold.selectionStart, bold.selectionEnd, '**', '**');
  assert.equal(plain.value, '앞 선택 뒤');
  assert.equal(plain.value.slice(plain.selectionStart, plain.selectionEnd), '선택');
});

test('형광펜과 글자색은 짧은 표기로 토글하고 색상도 교체한다', ()=>{
  assert.deepEqual(highlightTags('purple'), ['==purple:', '==']);
  assert.deepEqual(textColorTags('blue'), ['{{blue:', '}}']);

  const pink = toggleHighlight('텍스트', 0, 3, 'pink');
  assert.equal(pink.value, '==pink:텍스트==');
  const purple = toggleHighlight(pink.value, pink.selectionStart, pink.selectionEnd, 'purple');
  assert.equal(purple.value, '==purple:텍스트==');
  const plain = toggleHighlight(purple.value, purple.selectionStart, purple.selectionEnd, 'purple');
  assert.equal(plain.value, '텍스트');

  const red = toggleTextColor('텍스트', 0, 3, 'red');
  assert.equal(red.value, '{{red:텍스트}}');
  assert.equal(toggleTextColor(red.value, red.selectionStart, red.selectionEnd, 'red').value, '텍스트');
});

test('기존 긴 HTML 서식을 짧은 편집 표기로 바꾸고 미리보기 HTML로 렌더링한다', ()=>{
  const legacy = '<mark class="md-hl md-hl-pink"><span class="md-color md-color-red">텍스트</span></mark> <u>밑줄</u> H<sub>2</sub> x<sup>3</sup>';
  const compact = compactLegacyFormatting(legacy);
  assert.equal(compact, '==pink:{{red:텍스트}}== ++밑줄++ H_{2} x^{3}');
  assert.equal(renderCompactFormatting(compact),
    '<mark class="md-hl md-hl-pink"><span class="md-color md-color-red">텍스트</span></mark> <u>밑줄</u> H<sub>2</sub> x<sup>3</sup>');
});

test('위첨자와 아래첨자는 짧은 표기로 토글하고 미리보기 태그로 렌더링한다', ()=>{
  const superscript = toggleSelection('x2', 1, 2, '^{', '}', '2');
  assert.equal(superscript.value, 'x^{2}');
  assert.equal(toggleSelection(superscript.value, superscript.selectionStart, superscript.selectionEnd, '^{', '}', '2').value, 'x2');

  const subscript = toggleSelection('H2O', 1, 2, '_{', '}', '2');
  assert.equal(subscript.value, 'H_{2}O');
  assert.equal(renderCompactFormatting('x^{2} + H_{2}O'), 'x<sup>2</sup> + H<sub>2</sub>O');
});

test('코드 펜스 안의 서식처럼 보이는 문자열은 변환하지 않는다', ()=>{
  const markdown = '==pink:본문== x^{2}\n```java\nString s = "==pink:코드== x^{2} H_{2}";\n```';
  const rendered = renderCompactFormatting(markdown);
  assert.match(rendered, /^<mark class="md-hl md-hl-pink">본문<\/mark> x<sup>2<\/sup>/);
  assert.match(rendered, /String s = "==pink:코드== x\^\{2\} H_\{2\}";/);
});

test('Tab 크기만큼 공백을 넣고 Shift+Tab으로 제거한다', ()=>{
  const indented = indentSelection('abc', 0, 0, 4, false);
  assert.equal(indented.value, '    abc');
  assert.equal(indented.selectionStart, 4);
  const outdented = indentSelection(indented.value, 4, 4, 4, true);
  assert.equal(outdented.value, 'abc');
  assert.equal(outdented.selectionStart, 0);
});

test('text color and highlight remain nested in either application order', ()=>{
  assert.equal(
    renderCompactFormatting('{{red:==yellow:text==}}'),
    '<span class="md-color md-color-red"><mark class="md-hl md-hl-yellow">text</mark></span>',
  );
  assert.equal(
    renderCompactFormatting('==yellow:{{red:text}}=='),
    '<mark class="md-hl md-hl-yellow"><span class="md-color md-color-red">text</span></mark>',
  );
});
