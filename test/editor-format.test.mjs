import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactLegacyFormatting,
  deleteLine,
  duplicateLine,
  highlightTags,
  indentSelection,
  insertBlankLineMark,
  insertTable,
  renderCompactFormatting,
  tableTemplate,
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

test('Ctrl+Alt+아래는 지금 줄을 바로 아래에 복사한다', ()=>{
  const value = '첫 줄\n둘째 줄\n셋째 줄';
  const caret = value.indexOf('둘째') + 1;      // "둘|째 줄"
  const out = duplicateLine(value, caret, caret);
  assert.equal(out.value, '첫 줄\n둘째 줄\n둘째 줄\n셋째 줄');
  // 커서는 복사된 줄의 같은 자리로 따라간다.
  assert.equal(out.value.slice(0, out.selectionStart), '첫 줄\n둘째 줄\n둘');
  // 마지막 줄에서도 동작한다.
  const last = duplicateLine('한 줄', 1, 1);
  assert.equal(last.value, '한 줄\n한 줄');
});

test('Ctrl+D는 지금 줄을 줄바꿈까지 지운다', ()=>{
  const value = '첫 줄\n둘째 줄\n셋째 줄';
  const caret = value.indexOf('둘째') + 1;
  const out = deleteLine(value, caret, caret);
  assert.equal(out.value, '첫 줄\n셋째 줄');
  assert.equal(out.selectionStart, '첫 줄\n'.length);

  // 마지막 줄을 지울 때 빈 줄이 남으면 안 된다.
  const lastLine = deleteLine('첫 줄\n둘째 줄', 8, 8);
  assert.equal(lastLine.value, '첫 줄');
  assert.equal(lastLine.selectionStart, '첫 줄'.length);

  // 한 줄뿐일 때도 안전하게 비운다.
  assert.equal(deleteLine('하나', 1, 1).value, '');
});

test('표 템플릿은 화면에 보이는 칸 수가 요청한 크기와 같다', ()=>{
  const rows = tableTemplate(3, 3).split('\n');
  assert.equal(rows.length, 4);                 // 머리글 + 구분선 + 본문 2줄
  assert.equal(rows[0], '| 제목 1 | 제목 2 | 제목 3 |');
  assert.equal(rows[1], '| --- | --- | --- |');
  assert.equal(rows[2], '| 내용 | 내용 | 내용 |');
  assert.equal(tableTemplate(2, 4).split('\n')[0].split('|').length - 2, 4);
});

test('표를 넣으면 앞 문단에 딸려 들어가지 않는다', ()=>{
  const out = insertTable('설명 문장', 5, 5);
  const lines = out.value.split('\n');
  assert.equal(lines[0], '설명 문장');
  assert.equal(lines[1], '', '표 앞에는 빈 줄이 있어야 표로 인식됩니다');
  assert.equal(lines[2], '| 제목 1 | 제목 2 | 제목 3 |');
  // 바로 타이핑할 수 있도록 첫 머리글 칸이 선택된다.
  assert.equal(out.value.slice(out.selectionStart, out.selectionEnd), '제목 1');

  // 빈 줄에서 넣으면 쓸데없는 줄을 만들지 않는다.
  assert.equal(insertTable('', 0, 0).value.split('\n')[0], '| 제목 1 | 제목 2 | 제목 3 |');
});

test('세미콜론 세 개만 있는 줄은 강제로 빈 줄이 된다', ()=>{
  assert.equal(renderCompactFormatting('위\n;;;\n아래'), '위\n&nbsp;\n아래');
  assert.equal(renderCompactFormatting('  ;;;  '), '&nbsp;');
  // 글자와 섞이면 그대로 둔다.
  assert.equal(renderCompactFormatting('a;;;b'), 'a;;;b');
  assert.equal(renderCompactFormatting(';;;;'), ';;;;');
  // 코드 블록 안의 ;;; 는 코드다.
  assert.equal(renderCompactFormatting('```\n;;;\n```'), '```\n;;;\n```');
});

test('빈 줄 넣기는 지금 줄 아래에 표시만 있는 줄을 만든다', ()=>{
  const out = insertBlankLineMark('첫 줄\n둘째 줄', 2, 2);
  assert.equal(out.value, '첫 줄\n;;;\n둘째 줄');
  assert.equal(out.selectionStart, '첫 줄\n;;;'.length);
});
