export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'green', 'blue', 'purple', 'pink']);
export const TEXT_COLORS = Object.freeze(['red', 'blue', 'black']);

function selectionBounds(value, start, end){
  const source = String(value ?? '');
  const from = Math.max(0, Math.min(Number(start) || 0, source.length));
  const to = Math.max(from, Math.min(Number(end) || from, source.length));
  return { source, from, to };
}

function wrappedResult(source, from, to, prefix, suffix, placeholder){
  const selected = source.slice(from, to) || placeholder;
  return {
    value: source.slice(0, from) + prefix + selected + suffix + source.slice(to),
    selectionStart: from + prefix.length,
    selectionEnd: from + prefix.length + selected.length,
    active: true,
  };
}

function removeOuterWrapper(source, from, to, prefix, suffix){
  const selected = source.slice(from, to);
  if(selected.startsWith(prefix) && selected.endsWith(suffix)
    && selected.length >= prefix.length + suffix.length){
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    return {
      value: source.slice(0, from) + inner + source.slice(to),
      selectionStart: from,
      selectionEnd: from + inner.length,
      active: false,
    };
  }
  if(from >= prefix.length
    && source.slice(from - prefix.length, from) === prefix
    && source.slice(to, to + suffix.length) === suffix){
    return {
      value: source.slice(0, from - prefix.length) + selected + source.slice(to + suffix.length),
      selectionStart: from - prefix.length,
      selectionEnd: to - prefix.length,
      active: false,
    };
  }
  return null;
}

export function toggleSelection(value, start, end, prefix, suffix, placeholder='텍스트'){
  const { source, from, to } = selectionBounds(value, start, end);
  return removeOuterWrapper(source, from, to, prefix, suffix)
    || wrappedResult(source, from, to, prefix, suffix, placeholder);
}

function toggleColoredSelection(value, start, end, wrappers, desired, placeholder){
  const { source, from, to } = selectionBounds(value, start, end);
  for(const wrapper of wrappers){
    const removed = removeOuterWrapper(source, from, to, wrapper.prefix, wrapper.suffix);
    if(!removed) continue;
    if(wrapper.prefix === desired.prefix) return removed;
    return wrappedResult(
      removed.value,
      removed.selectionStart,
      removed.selectionEnd,
      desired.prefix,
      desired.suffix,
      placeholder,
    );
  }
  return wrappedResult(source, from, to, desired.prefix, desired.suffix, placeholder);
}

export function highlightTags(color){
  const safe = HIGHLIGHT_COLORS.includes(color) ? color : HIGHLIGHT_COLORS[0];
  return [`==${safe}:`, '=='];
}

export function textColorTags(color){
  const safe = TEXT_COLORS.includes(color) ? color : TEXT_COLORS[0];
  return [`{{${safe}:`, '}}'];
}

export function toggleHighlight(value, start, end, color){
  const wrappers = HIGHLIGHT_COLORS.map(item=>{
    const [prefix, suffix] = highlightTags(item);
    return { prefix, suffix };
  });
  const [prefix, suffix] = highlightTags(color);
  return toggleColoredSelection(value, start, end, wrappers, {prefix, suffix}, '텍스트');
}

export function toggleTextColor(value, start, end, color){
  const wrappers = TEXT_COLORS.map(item=>{
    const [prefix, suffix] = textColorTags(item);
    return { prefix, suffix };
  });
  const [prefix, suffix] = textColorTags(color);
  return toggleColoredSelection(value, start, end, wrappers, {prefix, suffix}, '텍스트');
}

function transformOutsideFences(source, transform){
  let fence = null;
  return String(source || '').split(/(\r?\n)/).map(part=>{
    if(/^\r?\n$/.test(part)) return part;
    const marker = part.match(/^\s*(`{3,}|~{3,})/);
    if(marker){
      const token = marker[1];
      if(!fence) fence = token[0];
      else if(token[0] === fence) fence = null;
      return part;
    }
    return fence ? part : transform(part);
  }).join('');
}

export function compactLegacyFormatting(source){
  return transformOutsideFences(source, line=>line
    .replace(/<span class=["']md-color md-color-(red|blue|black)["']>(.*?)<\/span>/gi,
      (_, color, text)=>`{{${color}:${text}}}`)
    .replace(/<mark class=["']md-hl md-hl-(yellow|green|blue|purple|pink)["']>(.*?)<\/mark>/gi,
      (_, color, text)=>`==${color}:${text}==`)
    .replace(/<sup>(.*?)<\/sup>/gi, '^{$1}')
    .replace(/<sub>(.*?)<\/sub>/gi, '_{$1}')
    .replace(/<u>(.*?)<\/u>/gi, '++$1++'));
}

// Markdown은 빈 줄을 아무리 넣어도 하나로 합치기 때문에 문단 사이를 강제로 띄울 수 없다.
// `;;;` 만 있는 줄을 사이 띄우기로 쓴다 — 공백 문자 하나를 남겨 그 줄이 사라지지 않게 한다.
export const BLANK_LINE_MARK = ';;;';
const BLANK_LINE_PATTERN = /^\s*;;;\s*$/;

export function renderCompactFormatting(source){
  return transformOutsideFences(compactLegacyFormatting(source), line=>BLANK_LINE_PATTERN.test(line) ? '&nbsp;' : line
    .replace(/==(yellow|green|blue|purple|pink):(.*?)==/g,
      (_, color, text)=>`<mark class="md-hl md-hl-${color}">${text}</mark>`)
    .replace(/\{\{(red|blue|black):(.*?)\}\}/g,
      (_, color, text)=>`<span class="md-color md-color-${color}">${text}</span>`)
    .replace(/\^\{([^{}\n]+)\}/g, '<sup>$1</sup>')
    .replace(/_\{([^{}\n]+)\}/g, '<sub>$1</sub>')
    .replace(/\+\+(.*?)\+\+/g, '<u>$1</u>'));
}

// 커서(또는 선택 영역)가 걸쳐 있는 줄 전체의 범위.
function lineRange(source, from, to){
  const start = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const endIndex = source.indexOf('\n', to);
  return { start, end: endIndex === -1 ? source.length : endIndex, hasTrailingNewline: endIndex !== -1 };
}

// Ctrl+Alt+아래: 지금 줄을 바로 아래에 복사한다. 커서는 복사된 줄의 같은 자리로 간다.
export function duplicateLine(value, start, end){
  const { source, from, to } = selectionBounds(value, start, end);
  const line = lineRange(source, from, to);
  const block = source.slice(line.start, line.end);
  const inserted = '\n' + block;
  return {
    value: source.slice(0, line.end) + inserted + source.slice(line.end),
    selectionStart: from + inserted.length,
    selectionEnd: to + inserted.length,
  };
}

// Ctrl+D: 지금 줄을 줄바꿈까지 통째로 지운다.
export function deleteLine(value, start, end){
  const { source, from, to } = selectionBounds(value, start, end);
  const line = lineRange(source, from, to);
  let cutStart = line.start;
  let cutEnd = line.end;
  if(line.hasTrailingNewline) cutEnd += 1;
  // 마지막 줄에는 뒤따르는 줄바꿈이 없으니 앞의 줄바꿈을 지워야 빈 줄이 남지 않는다.
  else if(line.start > 0) cutStart -= 1;
  const next = source.slice(0, cutStart) + source.slice(cutEnd);
  const caret = Math.min(cutStart, next.length);
  return { value: next, selectionStart: caret, selectionEnd: caret };
}

// 지금 줄 아래에 사이 띄우기 표시만 있는 줄을 넣는다.
export function insertBlankLineMark(value, start, end){
  const { source, from, to } = selectionBounds(value, start, end);
  const line = lineRange(source, from, to);
  const inserted = '\n' + BLANK_LINE_MARK;
  const caret = line.end + inserted.length;
  return {
    value: source.slice(0, line.end) + inserted + source.slice(line.end),
    selectionStart: caret,
    selectionEnd: caret,
  };
}

export function tableTemplate(rows=3, cols=3){
  const rowCount = Math.max(2, Math.min(20, Math.trunc(Number(rows)) || 3));
  const colCount = Math.max(1, Math.min(10, Math.trunc(Number(cols)) || 3));
  const row = cells => `| ${cells.join(' | ')} |`;
  const header = row(Array.from({length: colCount}, (_, i)=>`제목 ${i + 1}`));
  const divider = row(Array.from({length: colCount}, ()=>'---'));
  // 첫 줄이 머리글이므로 본문은 한 줄 적다 — 화면에 보이는 칸이 rows × cols 가 된다.
  const body = Array.from({length: rowCount - 1}, ()=>row(Array.from({length: colCount}, ()=>'내용')));
  return [header, divider, ...body].join('\n');
}

// 표는 줄 맨 앞에서 시작해야 하고 앞에 빈 줄이 없으면 문단에 딸려 들어간다.
export function insertTable(value, start, end, rows=3, cols=3){
  const { source, from, to } = selectionBounds(value, start, end);
  const line = lineRange(source, from, to);
  const before = source.slice(0, line.start);
  const current = source.slice(line.start, line.end);
  const after = source.slice(line.end);

  // 커서가 있던 줄에 글이 있으면 그 줄은 남기고 아래에 넣는다.
  const keep = current.trim() ? current + '\n\n' : '';
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const table = tableTemplate(rows, cols);
  const tail = after.startsWith('\n') ? '\n' : '\n\n';
  const prefix = before + lead + keep;
  const firstCell = prefix.length + 2; // "| " 다음
  return {
    value: prefix + table + tail + after,
    selectionStart: firstCell,
    selectionEnd: firstCell + '제목 1'.length,
  };
}

export function indentSelection(value, start, end, size=4, outdent=false){
  const { source, from, to } = selectionBounds(value, start, end);
  const width = Math.max(1, Math.min(8, Math.trunc(Number(size)) || 4));
  if(from === to && !outdent){
    const spaces = ' '.repeat(width);
    return {
      value: source.slice(0, from) + spaces + source.slice(to),
      selectionStart: from + width,
      selectionEnd: from + width,
    };
  }

  const lineStart = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEndIndex = source.indexOf('\n', to);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  const block = source.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  let firstDelta = 0;
  let totalDelta = 0;
  const changed = lines.map((line, index)=>{
    if(!outdent){
      if(index === 0) firstDelta = width;
      totalDelta += width;
      return ' '.repeat(width) + line;
    }
    const remove = Math.min(width, (line.match(/^ */) || [''])[0].length);
    if(index === 0) firstDelta = -remove;
    totalDelta -= remove;
    return line.slice(remove);
  }).join('\n');
  return {
    value: source.slice(0, lineStart) + changed + source.slice(lineEnd),
    selectionStart: Math.max(lineStart, from + firstDelta),
    selectionEnd: Math.max(lineStart, to + totalDelta),
  };
}
