/** Local, nonblocking layout advice. No files, network, DOM or edits are used here. */
import { prepareSource, parseImageReferences } from './core.mjs';
import { getDisplayTitle, findDuplicateDisplayTitles } from './recommendation-title.mjs';

export const TITLE_LENGTH_ADVICE = Object.freeze({
  threshold: 40,
  unit: 'Unicode 字符',
  explanation: '标题超过 40 个 Unicode 字符，可能在较窄预览中换行较多；这是排版建议，不是微信官方限制。',
});

const own = value => value && typeof value === 'object' && !Array.isArray(value);
const visibleString = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
const shortText = value => [...visibleString(value)].slice(0, 100).join('');
const titleKey = value => value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
const unescapeMarkdown = value => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
const escapedAt = (source, at) => {
  let count = 0;
  while (at > 0 && source[--at] === '\\') count++;
  return count % 2 === 1;
};

function linesOf(source) {
  const lines = [];
  let start = 0;
  for (const raw of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const text = raw.replace(/\r?\n$/, '');
    lines.push({text, start, end: start + text.length, rawEnd: start + raw.length});
    start += raw.length;
  }
  return lines;
}

/** Mask code examples, including quoted/list fences and inline code spanning one newline. */
function codeMask(source, lines) {
  const mask = new Uint8Array(source.length);
  let fence = null, indented = false, previousBlank = true;
  for (const line of lines) {
    let clean = line.text.replace(/^(?:[ ]{0,3}>[ \t]?)+/, '');
    if (fence) clean = clean.replace(/^[ ]{1,8}(?=[`~])/, '');
    else clean = clean.replace(/^[ ]{0,3}(?:[-+*]|\d+[.)])[ \t]+/, '');
    const marker = clean.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      mask.fill(1, line.start, line.rawEnd);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = {char: marker[1][0], length: marker[1].length};
      mask.fill(1, line.start, line.rawEnd);
    } else if (/^(?: {4}|\t)/.test(clean) && (indented || previousBlank)) {
      indented = true;
      mask.fill(1, line.start, line.rawEnd);
    } else if (!clean.trim() && indented) {
      mask.fill(1, line.start, line.rawEnd);
    } else indented = false;
    previousBlank = !clean.trim();
  }
  for (let at = 0; at < source.length; at++) {
    if (mask[at] || source[at] !== '`' || escapedAt(source, at)) continue;
    let runEnd = at + 1;
    while (source[runEnd] === '`') runEnd++;
    const marker = source.slice(at, runEnd);
    let close = source.indexOf(marker, runEnd);
    while (close >= 0 && (source[close - 1] === '`' || source[close + marker.length] === '`')) close = source.indexOf(marker, close + marker.length);
    if (close >= 0 && !/\n[ \t]*\r?\n/.test(source.slice(runEnd, close)) && !mask.subarray(runEnd, close).includes(1)) {
      mask.fill(1, at, close + marker.length);
      at = close + marker.length - 1;
    } else at = runEnd - 1;
  }
  return mask;
}

/** Read just one supported, top-level YAML string. Never parse YAML tags, aliases or code. */
function yamlTitle(frontmatter) {
  const lines = linesOf(frontmatter), candidates = [];
  for (const line of lines.slice(1, -1)) {
    const match = /^title[ \t]*:[ \t]*(.*?)[ \t]*$/i.exec(line.text);
    if (!match) continue;
    const raw = match[1];
    let title = '';
    if (!raw || /^[>|\[\]{&*!@`]/.test(raw)) return null;
    if (raw.startsWith('"')) {
      const quoted = /^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/.exec(raw);
      if (!quoted) return null;
      try { title = JSON.parse(quoted[1]); } catch { return null; }
    } else if (raw.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(raw);
      if (!quoted) return null;
      title = quoted[1].replaceAll("''", "'");
    } else {
      title = raw.replace(/[ \t]+#.*$/, '');
      if (/:[ \t]|[\[\]{}]/.test(title)) return null;
    }
    if (typeof title !== 'string' || !title.trim() || /[\u0000-\u001f\u007f]/.test(title)) return null;
    const contentAt = line.text.indexOf(raw);
    candidates.push({title: title.trim(), start: line.start + contentAt, end: line.start + contentAt + raw.length});
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function sourceRange(source, start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= source.length
    ? {start, end} : {start: null, end: null};
}

function footerEntries(source, footer, selectedItems) {
  if (!own(footer) || footer.detached || typeof footer.text !== 'string') return [];
  const range = sourceRange(source, footer.start, footer.end);
  if (range.start === null || source.slice(range.start, range.end) !== footer.text) return [];
  const lines = linesOf(footer.text), heading = lines.findIndex(line => line.text === '相关文章推荐：');
  if (heading < 0 || lines.slice(0, heading).some(line => line.text.trim())) return [];
  const entries = [];
  for (const line of lines.slice(heading + 1)) {
    if (!line.text.trim()) continue;
    if (!line.text.startsWith('- ') || !line.text.slice(2).trim()) return [];
    entries.push({title: unescapeMarkdown(line.text.slice(2).trim()), start: range.start + line.start + 2, end: range.start + line.end});
  }
  // The managed range retains its ordering during same-line title edits. IDs are advice only.
  return entries.map((entry, index) => ({...entry, articleId: selectedItems[index]?.id}));
}

function plainHeadingTitle(raw, markdownFactory) {
  if (typeof markdownFactory !== 'function') return unescapeMarkdown(raw);
  try {
    // The already-loaded local renderer is used only as a parser; no HTML is rendered here.
    const md = markdownFactory({html: false, linkify: false, typographer: false});
    const read = tokens => (tokens || []).map(token => token.children ? read(token.children)
      : ['text', 'code_inline'].includes(token.type) ? token.content : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('');
    return read(md.parseInline(raw, {}));
  } catch {return unescapeMarkdown(raw);}
}

/**
 * Return warnings with UTF-16 offsets into the ORIGINAL textarea source, or null when not locatable.
 * `rendered` must be the renderArticle result for this source. `relatedArticles` are selected items.
 * This function does not render, mutate, fix, save or block anything. Strings are for textContent.
 */
export function checkArticle({source = '', rendered = null, relatedArticles = [], stripFrontmatter = false,
  relatedFooter = null, titleLengthThreshold = TITLE_LENGTH_ADVICE.threshold, markdownFactory = globalThis.markdownit} = {}) {
  source = typeof source === 'string' ? source : '';
  const issues = [], selected = Array.isArray(relatedArticles) ? relatedArticles.filter(own) : [];
  const threshold = Number.isSafeInteger(titleLengthThreshold) && titleLengthThreshold >= 1 && titleLengthThreshold <= 500
    ? titleLengthThreshold : TITLE_LENGTH_ADVICE.threshold;
  const prepared = prepareSource(source, {stripFrontmatter: true});
  const metadataLength = prepared.removedFrontmatter ? prepared.frontmatter.length : 0;
  const removedLength = rendered?.removedFrontmatter === true || stripFrontmatter === true ? metadataLength : 0;
  const add = (type, message, range = {}, extra = {}) => {
    issues.push({id: `${type}-${issues.length + 1}`, type, message, ...sourceRange(source, range.start, range.end), ...extra});
  };

  // Renderer issues already include missing, ambiguous, blocked and invalid/unread image assets.
  // Each occurrence gets its own location, including repeated references to the same filename.
  const refs = parseImageReferences(source.slice(removedLength));
  const usedRefs = new Set();
  for (const issue of Array.isArray(rendered?.issues) ? rendered.issues : []) {
    if (!own(issue)) continue;
    let range = sourceRange(source, Number.isSafeInteger(issue.start) ? issue.start + removedLength : null,
      Number.isSafeInteger(issue.end) ? issue.end + removedLength : null);
    if (range.start !== null && typeof issue.raw === 'string' && source.slice(range.start, range.end) !== issue.raw) range = {start: null, end: null};
    if (range.start === null) {
      const ref = refs.find((item, index) => !usedRefs.has(index) && item.target === issue.target && (!issue.raw || item.raw === issue.raw));
      if (ref) { usedRefs.add(refs.indexOf(ref)); range = {start: ref.start + removedLength, end: ref.end + removedLength}; }
    } else {
      const at = refs.findIndex(ref => ref.start + removedLength === range.start && ref.end + removedLength === range.end);
      if (at >= 0) usedRefs.add(at);
    }
    const target = shortText(issue.target);
    const detail = issue.status === 'ambiguous' ? '存在同名图片，请选择明确路径。'
      : issue.status === 'missing' ? '请检查已选择的附件目录或图片路径。'
      : issue.status === 'asset-unavailable' ? '匹配文件尚未读取，或图片格式/数据不受支持。'
      : '图片格式、引用或来源未获支持；没有读取网络图片。';
    add('image-unavailable', `图片无法显示${target ? `：${target}` : ''}。${detail}`, range);
  }

  const lines = linesOf(source), mask = codeMask(source, lines);
  if (metadataLength) mask.fill(1, 0, metadataLength);
  const plainPlaceholders = new Set(['在这里填写引用文字', '在这里填写重点提示', '在这里填写图片说明', '资料名称或作者，补充说明']);
  for (const line of lines) {
    // Whole code blocks are ignored. Inline code within a real H1 remains visible title text.
    if (mask.subarray(line.start, line.end).every(value => value === 1)) continue;
    const text = line.text.trim();
    const heading = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line.text);
    const headingPlaceholder = heading && heading[2] === ['一级标题', '二级标题', '三级标题'][heading[1].length - 1];
    const placeholder = headingPlaceholder || /^>[ \t]+在这里填写引用文字[ \t]*$/.test(text)
      || /^>[ \t]+\*\*重点：\*\*[ \t]+在这里填写重点提示[ \t]*$/.test(text)
      || /^\*在这里填写图片说明\*$/.test(text)
      || /^-[ \t]+资料名称或作者，补充说明[ \t]*$/.test(text) || plainPlaceholders.has(text);
    if (placeholder) add('placeholder', '这里仍有排版组件的占位文字，请自行填写或删除。', line);
    if (heading?.[1] === '#' && !headingPlaceholder) {
      const title = plainHeadingTitle(heading[2].trim(), markdownFactory);
      if ([...title].length > threshold) {
        const at = line.text.indexOf(heading[2]);
        add('title-length', `文章标题有 ${[...title].length} 个 Unicode 字符，超过建议的 ${threshold} 个，较窄预览可能换行较多；这是排版建议，不是微信官方限制。`,
          {start: line.start + at, end: line.start + at + heading[2].length}, {title});
      }
    }
  }
  const yaml = metadataLength ? yamlTitle(prepared.frontmatter) : null;
  if (yaml && [...yaml.title].length > threshold) add('title-length',
    `笔记 title 有 ${[...yaml.title].length} 个 Unicode 字符，超过建议的 ${threshold} 个，较窄预览可能换行较多；这是排版建议，不是微信官方限制。`, yaml, {title: yaml.title});

  const entries = footerEntries(source, relatedFooter, selected);
  const duplicateKeys = new Set();
  for (const group of findDuplicateDisplayTitles(selected)) {
    const key = titleKey(group.title);
    const locations = entries.filter(entry => titleKey(entry.title) === key);
    // A protected same-line edit can already have removed an indexed duplicate from the output.
    if (entries.length && locations.length < 2) continue;
    duplicateKeys.add(key);
    add('duplicate-recommendation', `推荐中有 ${group.ids.length} 篇显示为“${shortText(group.title)}”的文章，请人工核对；同名文章仍全部保留。`, locations[0],
      {articleIds: [...group.ids], occurrences: locations.map(({start, end}) => ({start, end}))});
  }
  const actualGroups = new Map();
  for (const entry of entries) {
    const key = titleKey(entry.title);
    if (!actualGroups.has(key)) actualGroups.set(key, []);
    actualGroups.get(key).push(entry);
  }
  for (const [key, group] of actualGroups) {
    if (group.length < 2 || duplicateKeys.has(key)) continue;
    add('duplicate-recommendation', `文末推荐中有 ${group.length} 行显示为“${shortText(group[0].title)}”，请人工核对；文字未被修改。`, group[0],
      {articleIds: group.map(entry => entry.articleId).filter(id => typeof id === 'string'), occurrences: group.map(({start, end}) => ({start, end}))});
  }
  const warnedKeys = new Set();
  for (const item of selected) {
    const title = getDisplayTitle(item), key = titleKey(title);
    if ([...title].length <= threshold || warnedKeys.has(key)) continue;
    const location = entries.find(entry => titleKey(entry.title) === key);
    // The actual editable footer takes precedence over an older display title in the local index.
    if (entries.length && !location) continue;
    warnedKeys.add(key);
    add('title-length', `推荐标题“${shortText(title)}”有 ${[...title].length} 个 Unicode 字符，超过建议的 ${threshold} 个，较窄预览可能换行较多；这是排版建议，不是微信官方限制。`, location,
      {title, articleIds: selected.filter(entry => titleKey(getDisplayTitle(entry)) === key).map(entry => entry.id).filter(id => typeof id === 'string')});
  }
  // Check the actual editable footer as well, since a same-line user edit can differ from its index.
  for (const entry of entries) {
    const key = titleKey(entry.title);
    if ([...entry.title].length <= threshold || warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    add('title-length', `文末推荐标题有 ${[...entry.title].length} 个 Unicode 字符，超过建议的 ${threshold} 个，较窄预览可能换行较多；这是排版建议，不是微信官方限制。`, entry,
      {title: entry.title, articleIds: typeof entry.articleId === 'string' ? [entry.articleId] : []});
  }
  if (relatedFooter?.detached === true) add('recommendation-detached', '文末推荐已经手工调整，自动管理已暂停；请人工核对推荐是否重复或需要更新。');
  return issues;
}
