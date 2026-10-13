/** Small, local Markdown components. This module never reads files or accesses the network. */
export const COMPONENTS = Object.freeze([
  { id: 'h1', label: '一级标题', description: '将选中文字设为一级标题，或插入可编辑标题。' },
  { id: 'h2', label: '二级标题', description: '将选中文字设为二级标题，或插入可编辑标题。' },
  { id: 'h3', label: '三级标题', description: '将选中文字设为三级标题，或插入可编辑标题。' },
  { id: 'quote', label: '引用', description: '将选中文字放入引用块，或插入可编辑引用。' },
  { id: 'important', label: '重点提示', description: '插入带“重点”标记的引用块。' },
  { id: 'divider', label: '分隔线', description: '在光标或选区末尾插入分隔线，保留选中文字。' },
  { id: 'caption', label: '图片说明', description: '插入普通斜体说明文字，可放在图片下面。' },
  { id: 'references', label: '参考资料', description: '插入参考资料标题和普通文字列表，不自动添加链接。' },
].map(item => Object.freeze(item)));

/** Snapshot of a textarea value and its UTF-16 selection offsets. */
const cloneMeta = value => typeof structuredClone === 'function'
  ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export function editorSnapshot(input = {}) {
  const value = String(input.value ?? '');
  const offset = number => Math.min(value.length, Math.max(0, Number.isFinite(number) ? Math.trunc(number) : 0));
  const first = offset(input.start ?? input.selectionStart);
  const last = offset(input.end ?? input.selectionEnd ?? first);
  const direction = ['forward', 'backward'].includes(input.direction ?? input.selectionDirection)
    ? (input.direction ?? input.selectionDirection) : 'none';
  const snapshot = { value, start: Math.min(first, last), end: Math.max(first, last), direction };
  if (input.meta !== undefined) snapshot.meta = cloneMeta(input.meta);
  return snapshot;
}

const newlineFor = value => value.includes('\r\n') ? '\r\n' : '\n';
const mapLines = (value, convert) => value.split(/(\r?\n)/).map((line, index) => index % 2 ? line : convert(line, index / 2)).join('');
const linePrefix = (value, prefix) => mapLines(value, line => line.length ? prefix + line : line);

function padBlock(before, after, newline) {
  const leftCount = before.match(/(?:\r?\n)+$/)?.[0].match(/\n/g)?.length || 0;
  const rightCount = after.match(/^(?:\r?\n)+/)?.[0].match(/\n/g)?.length || 0;
  return {
    left: before ? newline.repeat(Math.max(0, 2 - leftCount)) : '',
    right: after ? newline.repeat(Math.max(0, 2 - rightCount)) : '',
  };
}

/**
 * Insert a conventional Markdown block at the exact selection. No selected prose is rewritten.
 * Empty selections receive a selected placeholder; selected prose remains selected after wrapping.
 * A divider is inserted after the selection without removing it.
 */
export function applyComponent(input, id) {
  const snapshot = editorSnapshot(input);
  if (!COMPONENTS.some(item => item.id === id)) throw new RangeError(`未知排版组件：${id}`);
  let { value, start, end } = snapshot;
  if (id === 'divider') start = end;
  const selected = value.slice(start, end);
  const newline = newlineFor(value);
  let block, selectionStart = 0, selectionEnd;
  if (/^h[123]$/.test(id)) {
    const level = Number(id.slice(1));
    const prefix = '#'.repeat(level) + ' ';
    const content = selected || ['一级标题', '二级标题', '三级标题'][level - 1];
    block = linePrefix(content, prefix);
    selectionStart = prefix.length;
    selectionEnd = block.length;
  } else if (id === 'quote') {
    block = mapLines(selected || '在这里填写引用文字', line => '> ' + line);
    selectionStart = 2;
    selectionEnd = block.length;
  } else if (id === 'important') {
    const prefix = '> **重点：** ';
    block = mapLines(selected || '在这里填写重点提示', (line, index) => (index ? '> ' : prefix) + line);
    selectionStart = prefix.length;
    selectionEnd = block.length;
  } else if (id === 'divider') {
    block = '---';
    selectionStart = selectionEnd = block.length;
  } else if (id === 'caption') {
    // Ordinary emphasis uses the existing Markdown renderer and contains no raw HTML.
    block = mapLines(selected || '在这里填写图片说明', line => line ? '*' + line + '*' : line);
    selectionStart = 1;
    selectionEnd = block.length - 1;
  } else {
    const prefix = '### 参考资料' + newline + newline;
    block = prefix + linePrefix(selected || '资料名称或作者，补充说明', '- ');
    selectionStart = prefix.length + 2;
    selectionEnd = block.length;
  }
  const before = value.slice(0, start), after = value.slice(end);
  const padding = padBlock(before, after, newline);
  const offset = before.length + padding.left.length;
  selectionStart = Math.min(selectionStart, block.length);
  selectionEnd = Math.max(selectionStart, Math.min(selectionEnd, block.length));
  return {
    value: before + padding.left + block + padding.right + after,
    start: offset + selectionStart, end: offset + selectionEnd,
    direction: selected ? snapshot.direction : 'forward',
  };
}

/**
 * A bounded value/selection journal shared by typed edits and toolbar edits.
 * UI records each beforeinput/input transaction, and every programmatic replacement.
 * Switching/importing a document must reset the journal. Stale values also reset automatically,
 * so Ctrl+Z never overwrites unrecorded edits or a different article.
 */
export function createEditHistory(initial = {}, { limit = 80 } = {}) {
  const capacity = Math.max(1, Math.min(1000, Number.isFinite(limit) ? Math.trunc(limit) : 80));
  let current = editorSnapshot(initial), entries = [], cursor = 0;
  const copy = snapshot => editorSnapshot(snapshot);
  const reset = snapshot => { current = editorSnapshot(snapshot); entries = []; cursor = 0; };
  function acceptCurrent(snapshot) {
    const actual = editorSnapshot(snapshot ?? current);
    if (actual.value !== current.value) { reset(actual); return false; }
    // Moving the cursor does not invalidate an edit; value changes always do.
    current = actual;
    return true;
  }
  return {
    get current() { return copy(current); },
    get canUndo() { return cursor > 0; },
    get canRedo() { return cursor < entries.length; },
    get length() { return entries.length; },
    reset,
    record(beforeInput, afterInput, { kind = 'edit' } = {}) {
      const before = editorSnapshot(beforeInput), after = editorSnapshot(afterInput);
      if (before.value !== current.value) reset(before);
      current = after;
      if (before.value === after.value && JSON.stringify(before.meta) === JSON.stringify(after.meta)) return false;
      entries.splice(cursor);
      entries.push({ before, after, kind: String(kind) });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
      cursor = entries.length;
      return true;
    },
    undo(snapshot = current) {
      if (!acceptCurrent(snapshot) || cursor === 0) return null;
      current = copy(entries[--cursor].before);
      return copy(current);
    },
    redo(snapshot = current) {
      if (!acceptCurrent(snapshot) || cursor === entries.length) return null;
      current = copy(entries[cursor++].after);
      return copy(current);
    },
  };
}
