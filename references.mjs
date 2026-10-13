/** Reference-section recognition and conservative, reversible local whitespace edits. */
const LABEL = /^(?:参考(?:资料|文献)(?:\s*[/／]\s*References?)?|References?(?:\s*[/／]\s*参考(?:资料|文献))?)\s*[:：]?$/i;
const RELATED = /^(?:相关文章推荐|相关文章|相关阅读)\s*[:：]?$/;
const own = value => value && typeof value === 'object' && !Array.isArray(value);

function lineOffsets(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1);
  offsets.push(source.length);
  return offsets;
}

function frontmatterEnd(source) {
  return source.match(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)?.[0].length || 0;
}

const rawLine = (source, offsets, line) => source.slice(offsets[line], offsets[line + 1]).replace(/\r?\n$/, '');
function standaloneLabel(raw) {
  const text = raw.trim();
  const matched = text.match(/^(\*\*|__)([\s\S]*?)\1$/);
  const bold = matched && !matched[2].includes(matched[1]) ? matched : null;
  // The screenshot's trailing space inside ** is intentionally accepted for recognition.
  return {text: (bold ? bold[2] : text).trim(), bold: Boolean(bold)};
}

/** A validated whole-line label may tolerate accidental spaces inside bold markers. */
export function referenceTitleText(raw) {
  const label = standaloneLabel(String(raw));
  return label.bold && LABEL.test(label.text) ? label.text : null;
}

/** Only top-level headings/standalone labels establish a section; examples remain inert. */
export function referenceSectionsFromTokens(tokens, value = '') {
  const source = String(value), offsets = lineOffsets(source), ignoredUntil = frontmatterEnd(source);
  const boundaries = [];
  for (let index = 0; index < (tokens || []).length; index++) {
    const token = tokens[index];
    if (token.level !== 0 || !token.map || !['heading_open', 'paragraph_open', 'xyl_related_footer'].includes(token.type)) continue;
    const [startLine, endLine] = token.map;
    const start = offsets[startLine] ?? source.length;
    if (start < ignoredUntil) continue;
    const heading = token.type === 'heading_open';
    let label;
    if (heading) {
      const inline = tokens[index + 1];
      label = standaloneLabel(inline?.content || '');
    } else if (token.type === 'xyl_related_footer') {
      boundaries.push({startLine, endLine, reference: false});
      continue;
    } else {
      if (endLine - startLine !== 1) continue;
      label = standaloneLabel(rawLine(source, offsets, startLine));
    }
    const reference = LABEL.test(label.text);
    if (heading || reference || label.bold || RELATED.test(label.text)) boundaries.push({startLine, endLine, reference});
  }
  return boundaries.filter(item => item.reference).map(item => {
    const next = boundaries.find(candidate => candidate.startLine >= item.endLine);
    const endLine = next?.startLine ?? offsets.length - 1;
    return {start: offsets[item.startLine], end: offsets[endLine] ?? source.length,
      titleStart: offsets[item.startLine], titleEnd: offsets[item.endLine] ?? source.length,
      startLine: item.startLine, contentStartLine: item.endLine, endLine};
  });
}

function parserSource(source) {
  const end = frontmatterEnd(source);
  return end ? source.slice(0, end).replace(/[^\r\n]/g, ' ') + source.slice(end) : source;
}

function parse(value, markdownFactory) {
  if (typeof markdownFactory !== 'function') throw new Error('本地 Markdown 渲染器尚未加载。');
  const source = String(value ?? '');
  const md = markdownFactory({html: false, linkify: false, typographer: false, breaks: true});
  const tokens = md.parse(parserSource(source), {});
  return {source, tokens, sections: referenceSectionsFromTokens(tokens, source)};
}

export function findReferenceSections(value = '', {markdownFactory = globalThis.markdownit} = {}) {
  return parse(value, markdownFactory).sections;
}

/** Attach renderer-only metadata; never write markers/styles into the editable Markdown. */
export function markReferenceTokens(tokens, source) {
  const sections = referenceSectionsFromTokens(tokens, source), stack = [];
  const markChildren = (children, reference, title) => {
    for (const child of children || []) {
      child.meta = {...(own(child.meta) ? child.meta : {}), xylReference: reference, xylReferenceTitle: title};
      markChildren(child.children, reference, title);
    }
  };
  for (const token of tokens) {
    let parent = stack.at(-1) || {reference: false, title: false};
    if (token.nesting === -1) parent = stack.pop() || parent;
    let context = parent;
    if (token.map) {
      const section = sections.find(item => token.map[0] >= item.startLine && token.map[0] < item.endLine);
      context = {reference: Boolean(section), title: Boolean(section && token.map[0] === section.startLine)};
    }
    token.meta = {...(own(token.meta) ? token.meta : {}), xylReference: context.reference, xylReferenceTitle: context.title};
    markChildren(token.children, context.reference, context.title);
    if (token.nesting === 1) stack.push(context);
  }
  return sections;
}

export function auxiliaryFontSize(bodySize) {
  return Math.max(12.5, Math.round(Number(bodySize) * 0.875 * 100) / 100);
}

/** Remove only excess leading whitespace in parsed top-level reference prose/list markers. */
export function cleanReferenceWhitespace(value = '', {selectionStart = 0, selectionEnd = selectionStart, markdownFactory = globalThis.markdownit} = {}) {
  const {source, tokens, sections} = parse(value, markdownFactory), offsets = lineOffsets(source), lines = new Set(), protectedLines = new Set();
  const inside = line => sections.some(section => line >= section.startLine && line < section.endLine);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.map || !inside(token.map[0])) continue;
    if (token.type === 'fence' || token.type === 'code_block') {
      for (let line = token.map[0]; line < token.map[1]; line++) protectedLines.add(line);
    } else if (token.type === 'paragraph_open' && token.level === 0) {
      for (let line = token.map[0]; line < token.map[1]; line++) lines.add(line);
    } else if (token.type === 'heading_open' && token.level === 0) lines.add(token.map[0]);
    else if (['ordered_list_open', 'bullet_list_open'].includes(token.type) && token.level === 0) {
      let depth = 1, safe = true, itemStart = -1;
      const items = [];
      for (let next = index + 1; next < tokens.length && depth; next++) {
        const child = tokens[next];
        if (child.type === 'list_item_open') {
          if (child.level !== 1) safe = false;
          itemStart = child.map?.[0] ?? -1;
          items.push(child.map?.[0]);
        }
        if (['fence', 'code_block', 'blockquote_open', 'heading_open', 'table_open'].includes(child.type)
          || (child.type === 'paragraph_open' && child.map && (child.map[1] - child.map[0] !== 1 || child.map[0] !== itemStart))
          || (['ordered_list_open', 'bullet_list_open'].includes(child.type) && child.level !== 0)) safe = false;
        depth += child.nesting;
      }
      // A complete simple list moves together; changing just its parent's indent can
      // turn an untouched nested list/continuation into code or plain prose.
      if (items.some(line => /^(?: {4}|[ ]*\t)/.test(rawLine(source, offsets, line)))) safe = false;
      if (safe) for (const line of items) if (Number.isSafeInteger(line)) lines.add(line);
    }
  }
  const changes = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    if (protectedLines.has(line)) continue;
    const raw = rawLine(source, offsets, line), leading = raw.match(/^[ \u00a0\u3000]+/)?.[0] || '';
    // Four spaces/tabs can express Markdown code or nesting; do not reinterpret them.
    if (!leading || /^ {4}/.test(raw) || /^[ ]*\t/.test(raw) || !raw.slice(leading.length).trim()) continue;
    if (/[^ ]/.test(leading) && /^(?:#{1,6}[ \t]|[-+*][ \t]|\d+[.)][ \t]|>|`{3}|~{3}|\[.*\]:)/.test(raw.slice(leading.length))) continue;
    changes.push({start: offsets[line], end: offsets[line] + leading.length, text: ''});
  }
  let cleaned = source;
  for (let i = changes.length - 1; i >= 0; i--) cleaned = cleaned.slice(0, changes[i].start) + changes[i].text + cleaned.slice(changes[i].end);
  const mapOffset = value => {
    const offset = typeof value === 'number' && Number.isFinite(value) ? Math.min(source.length, Math.max(0, Math.trunc(value))) : 0;
    let result = offset;
    for (const change of changes) {
      if (offset <= change.start) break;
      result -= Math.min(offset, change.end) - change.start;
    }
    return result;
  };
  return {source: cleaned, changed: changes.length > 0, changedLines: changes.length, changes, sections,
    selectionStart: mapOffset(selectionStart), selectionEnd: mapOffset(selectionEnd)};
}
