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
    .replace(/<u>(.*?)<\/u>/gi, '++$1++'));
}

export function renderCompactFormatting(source){
  return transformOutsideFences(compactLegacyFormatting(source), line=>line
    .replace(/==(yellow|green|blue|purple|pink):(.*?)==/g,
      (_, color, text)=>`<mark class="md-hl md-hl-${color}">${text}</mark>`)
    .replace(/\{\{(red|blue|black):(.*?)\}\}/g,
      (_, color, text)=>`<span class="md-color md-color-${color}">${text}</span>`)
    .replace(/\+\+(.*?)\+\+/g, '<u>$1</u>'));
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
