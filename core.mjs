/*
 * 谢雨聊排版工具：本地 Markdown / 图片解析与内联排版。
 * Inspired by Raphael Publish's markdown.ts, wechatCompat.ts and theme structure.
 * Reference: https://github.com/liuxiaopai-ai/raphael-publish (MIT; see THIRD_PARTY_NOTICES.md).
 * This module never reads a file or accesses the network.
 */

import {effectiveTypography} from './layout-settings.mjs';
import {auxiliaryFontSize, markReferenceTokens, referenceTitleText} from './references.mjs';

export const THEMES = Object.freeze([
  { id: 'clear', name: '清爽绿', description: '白底、克制的绿色，适合日常分享。' },
  { id: 'warm', name: '温暖书页', description: '浅米色与暖棕色，适合随笔和长文。' },
  { id: 'ink', name: '简洁墨蓝', description: '白底墨蓝，适合观点与知识整理。' },
]);

const PALETTES = {
  clear: { accent: '#237a63', text: '#303b37', muted: '#66736d', bg: '#ffffff', soft: '#f1f7f4', border: '#dce8e1' },
  warm: { accent: '#995b3f', text: '#403a34', muted: '#817265', bg: '#fffcf6', soft: '#f6efe5', border: '#e7dacb' },
  ink: { accent: '#345875', text: '#303a46', muted: '#687787', bg: '#ffffff', soft: '#f1f5f8', border: '#dce5ed' },
};

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Normalize literal selected paths; percent characters are actual filename characters. */
export function normalizePath(value = '') {
  const path = String(value).trim().normalize('NFC').replace(/\\/g, '/');
  const drive = path.match(/^[a-z]:/i)?.[0] || '';
  const absolute = path.startsWith('/');
  const parts = path.slice(drive.length).split('/');
  const output = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..' && output.length && output.at(-1) !== '..') output.pop();
    else if (part === '..' && (absolute || drive)) continue;
    else output.push(part);
  }
  return (drive ? `${drive}/` : absolute ? '/' : '') + output.join('/');
}

const pathKey = path => normalizePath(path).toLocaleLowerCase('en-US');
const basename = path => normalizePath(path).split('/').at(-1) || '';
const dirname = path => normalizePath(path).replace(/\/?[^/]*$/, '');

/** Duplicate paths and duplicate basenames remain visible, never silently overwritten. */
export function buildImageIndex(entries = []) {
  const files = new Map(), byKey = new Map(), byBasename = new Map(), duplicatePaths = new Map();
  const all = [], seen = new Map();
  for (const entry of entries) {
    if (!entry || !entry.path) continue;
    const path = normalizePath(entry.path);
    const key = pathKey(path);
    const identity = entry.file || entry;
    if (seen.get(key)?.has(identity)) continue;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(identity);
    const record = { ...entry, path };
    all.push(record);
    if (!files.has(path)) files.set(path, record);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(record);
    const nameKey = basename(path).toLocaleLowerCase('en-US');
    if (!byBasename.has(nameKey)) byBasename.set(nameKey, []);
    byBasename.get(nameKey).push(record);
  }
  for (const candidates of byKey.values()) {
    if (candidates.length > 1) duplicatePaths.set(candidates[0].path, candidates);
  }
  return { files, byKey, byBasename, duplicatePaths, all };
}

// Each offset is visited once. Long runs of backslashes must not rescan their prefix.
function escapeOffsets(source) {
  const escaped = new Uint8Array(source.length);
  let run = 0;
  for (let i = 0; i < source.length; i++) {
    escaped[i] = run % 2;
    run = source[i] === '\\' ? run + 1 : 0;
  }
  return escaped;
}

function codeMask(source, escaped) {
  const mask = new Uint8Array(source.length);
  let offset = 0, fence = null, indented = false, previousBlank = true;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const clean = line.replace(/\r?\n$/, '');
    // Fences may live inside quotes or list items. Their contents still are code.
    let markerLine = clean.replace(/^(?:[ ]{0,3}>[ \t]?)+/, '');
    if (fence) markerLine = markerLine.replace(/^[ ]{1,8}(?=[`~])/, '');
    else markerLine = markerLine.replace(/^[ ]{0,3}(?:[-+*]|\d+[.)])[ \t]+/, '');
    const marker = markerLine.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      mask.fill(1, offset, offset + line.length);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      mask.fill(1, offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(clean) && (indented || previousBlank)) {
      indented = true;
      mask.fill(1, offset, offset + line.length);
    } else if (!clean.trim() && indented) {
      mask.fill(1, offset, offset + line.length);
    } else {
      indented = false;
    }
    previousBlank = !clean.trim();
    offset += line.length;
  }
  // Index exact backtick-run lengths once, including escaped potential closers.
  // CommonMark code spans can contain one newline, but cannot cross a paragraph or code block.
  const runs = [], nextByLength = new Map();
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '`') continue;
    let end = start + 1;
    while (source[end] === '`') end++;
    runs.push({start,end,next:-1});
    start = end - 1;
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i].end - runs[i].start;
    const openingLength = escaped[runs[i].start] && length > 1 ? length - 1 : length;
    runs[i].next = nextByLength.get(openingLength) ?? -1;
    nextByLength.set(length,i);
  }
  const paragraphs = [...source.matchAll(/\n[ \t]*\r?\n/g)].map(match => match.index);
  let paragraph = 0, blocked = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const openingStart = run.start + (escaped[run.start] ? 1 : 0);
    if (mask[run.start] || openingStart === run.end) continue;
    const next = runs[run.next];
    if (!next) continue;
    while (paragraphs[paragraph] < run.end) paragraph++;
    if (paragraphs[paragraph] < next.start) continue;
    blocked = Math.max(blocked,run.end);
    while (blocked < next.start && !mask[blocked]) blocked++;
    if (blocked < next.start) continue;
    mask.fill(1,openingStart,next.end);
    i = run.next;
  }
  return mask;
}

function unescapeMarkdown(value) {
  return value.replace(/\\([ !"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

function parseDestination(content) {
  const text = content.trim();
  if (text.startsWith('<')) {
    const close = text.indexOf('>');
    if (close < 0) return null;
    const trailing = text.slice(close + 1).trim();
    if (trailing && !/^(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\))$/.test(trailing)) return null;
    return unescapeMarkdown(text.slice(1, close));
  }
  const withoutTitle = text.replace(/\s+(?:"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*')\s*$/, '');
  return unescapeMarkdown(withoutTitle);
}

function imageScanner(source, escaped) {
  const brackets = new Uint32Array(source.length), stack = [], destinations = new Map();
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {stack.length = 0;continue;}
    if (escaped[i]) continue;
    if (source[i] === '[') stack.push(i);
    else if (source[i] === ']' && stack.length) brackets[stack.pop()] = i + 1;
  }
  // Valid nested destinations are cached. Malformed overlapping quote/angle contexts
  // retain the old parsing semantics, but have a linear work budget instead of freezing.
  let remaining = source.length * 8 + 1024, wiki = -2, newline = -2;
  const nextAt = (pattern,from,previous) => previous === -1 || previous >= from ? previous : source.indexOf(pattern,from);
  return {
    bracket: open => (brackets[open] || 0) - 1,
    wiki: from => {wiki = nextAt(']]',from,wiki);return wiki;},
    newline: from => {newline = nextAt('\n',from,newline);return newline;},
    destination: open => {
      if (destinations.has(open)) return destinations.get(open);
      const openings = [open];
      let quote = '', angle = false;
      for (let i = open + 1; i < source.length; i++) {
        if (--remaining < 0) throw new Error('Markdown 链接语法过于复杂，请减少未闭合的括号或引号后重试。正文未被截断。');
        if (escaped[i]) continue;
        const char = source[i];
        if (quote) {if (char === quote) quote = '';continue;}
        if (angle) {if (char === '>') angle = false;continue;}
        if ((char === '"' || char === "'") && /\s/.test(source[i - 1] || '')) {quote = char;continue;}
        if (char === '<') {angle = true;continue;}
        if (char === '(') openings.push(i);
        else if (char === ')') {
          destinations.set(openings.pop(),i);
          if (!openings.length) return i;
        }
      }
      for (const unclosed of openings) destinations.set(unclosed,-1);
      return -1;
    },
  };
}

function maskLinkAttributes(source, mask, scanner, escaped) {
  // A wiki image inside a link label is content, but its URL/title is an attribute.
  for (let i = 0; i < source.length; i++) {
    if (mask[i] || escaped[i]) continue;
    if (source[i] === '[' && !(source[i - 1] === '!' && !escaped[i - 1])) {
      const close = scanner.bracket(i);
      if (close >= 0 && source[close + 1] === '(') {
        const finish = scanner.destination(close + 1);
        if (finish >= 0) mask.fill(1, close + 1, finish + 1);
      }
    } else if (source[i] === '<') {
      const tail = source.slice(i);
      const autolink = tail.match(/^<(?:[a-z][a-z\d+.-]*:[^<>\n]*|[^<>\s]+@[^<>\s]+)>/i);
      if (autolink) { mask.fill(1, i, i + autolink[0].length); i += autolink[0].length - 1; }
    }
  }
}

/** Offsets always refer to the supplied source. Code examples are not image references. */
export function parseImageReferences(value = '') {
  const source = String(value), refs = [], escaped = escapeOffsets(source), mask = codeMask(source,escaped),
    scanner = imageScanner(source,escaped), definitions = new Map();
  const definitionPattern = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?(<[^>\n]+>|[^\n]+)$/gm;
  for (const match of source.matchAll(definitionPattern)) {
    if (!mask[match.index]) {
      definitions.set(match[1].trim().replace(/\s+/g, ' ').toLowerCase(), parseDestination(match[2]));
      mask.fill(1, match.index, match.index + match[0].length);
      const nextLineTitle = source.slice(match.index + match[0].length).match(/^\r?\n[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\))[ \t]*(?=\r?\n|$)/);
      if (nextLineTitle) mask.fill(1, match.index + match[0].length, match.index + match[0].length + nextLineTitle[0].length);
    }
  }
  maskLinkAttributes(source, mask, scanner, escaped);
  for (let start = 0; start < source.length; start++) {
    if (mask[start] || source[start] !== '!' || source[start + 1] !== '[' || escaped[start]) continue;
    let target, alt = '', width, height, end, kind;
    if (source[start + 2] === '[') {
      const close = scanner.wiki(start + 3), newline = scanner.newline(start);
      if (close < 0 || newline >= 0 && newline < close) continue;
      const body = source.slice(start + 3, close);
      const pieces = body.split('|');
      target = pieces.shift()?.trim();
      const suffix = pieces.join('|').trim();
      const size = suffix.match(/^(\d{1,5})(?:x(\d{1,5}))?$/i);
      if (size) {
        width = Math.min(8192, Math.max(1, Number(size[1])));
        if (size[2]) height = Math.min(8192, Math.max(1, Number(size[2])));
      } else alt = suffix;
      end = close + 2;
      kind = 'obsidian';
    } else {
      const close = scanner.bracket(start + 1);
      if (close < 0) continue;
      alt = unescapeMarkdown(source.slice(start + 2, close));
      if (source[close + 1] === '(') {
        const finish = scanner.destination(close + 1);
        if (finish < 0) continue;
        target = parseDestination(source.slice(close + 2, finish));
        end = finish + 1;
      } else {
        let label = alt, finish = close;
        if (source[close + 1] === '[') {
          const labelClose = scanner.bracket(close + 1);
          if (labelClose < 0) continue;
          label = source.slice(close + 2, labelClose) || alt;
          finish = labelClose;
        }
        target = definitions.get(label.trim().replace(/\s+/g, ' ').toLowerCase());
        if (!target) continue;
        end = finish + 1;
      }
      kind = 'markdown';
    }
    if (!target) continue;
    refs.push({ id: refs.length, kind, raw: source.slice(start, end), target, alt, width, height, start, end });
    start = end - 1;
  }
  return refs;
}

function blockedTarget(target) {
  const text = decodePath(String(target).trim()).replace(/\\/g, '/');
  if (/[\u0000-\u001f\u007f]/.test(text)) return '图片路径含有控制字符。';
  if (/^(?:https?:|\/\/)/i.test(text)) return '远程图片未加载，请选择本地图片文件。';
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:\//i.test(text)) return '该图片地址协议不受支持。';
  if (/\.svg(?:[?#]|$)/i.test(text)) return 'SVG 图片未启用，请转为 PNG 或 JPG。';
  return null;
}

function candidateResult(candidates, ref) {
  if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.map(item => item.path), message: `图片“${ref.target}”有 ${candidates.length} 个候选，请使用明确路径。` };
  if (candidates.length === 1) {
    const record = candidates[0];
    const blocked = blockedTarget(record.path);
    if (blocked || record.type === 'image/svg+xml' || record.file?.type === 'image/svg+xml') return { status: 'blocked', path: record.path, message: blocked || 'SVG 图片未启用，请转为 PNG 或 JPG。' };
    return { status: 'matched', path: record.path, file: record.file, record, message: '' };
  }
  return null;
}

/** Match only already-selected files. Explicit directory references never fall back to basename. */
export function resolveImage(ref, { index = buildImageIndex(), articlePath = '' } = {}) {
  const blocked = blockedTarget(ref.target);
  if (blocked) return { status: 'blocked', message: blocked };
  // Only Markdown destinations are URIs. Wiki links and selected file paths are literal.
  // Decode exactly once, so %2520 addresses a file containing the characters "%20".
  const destination = ref.kind === 'markdown' ? decodePath(ref.target) : ref.target;
  const target = normalizePath(destination), article = normalizePath(articlePath);
  const hasDirectory = /[\\/]/.test(destination) || /^\./.test(destination);
  const isAbsolute = /^(?:\/|[a-z]:\/)/i.test(target);
  const relative = normalizePath(`${dirname(article) ? `${dirname(article)}/` : ''}${target}`);
  let paths;
  if (ref.kind === 'markdown' && dirname(article) && !isAbsolute) paths = [relative];
  else if (hasDirectory) paths = isAbsolute ? [target] : [target, relative];
  else if (ref.kind === 'obsidian') paths = [];
  else paths = [target];
  for (const path of [...new Set(paths.map(pathKey))]) {
    const result = candidateResult(index.byKey?.get(path) || [], ref);
    if (result) return result;
  }
  if (!hasDirectory && !(ref.kind === 'markdown' && dirname(article))) {
    const result = candidateResult(index.byBasename?.get(basename(target).toLocaleLowerCase('en-US')) || [], ref);
    if (result) return result;
  }
  return { status: 'missing', message: `未找到图片“${ref.target}”。请检查附件目录和文章相对路径。` };
}

/** Removing note properties is explicit and only touches the returned string. */
export function prepareSource(value = '', { stripFrontmatter = false } = {}) {
  const source = String(value);
  const match = source.match(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!stripFrontmatter || !match) return { source, removedFrontmatter: false, frontmatter: match?.[0] || '' };
  return { source: source.slice(match[0].length), removedFrontmatter: true, frontmatter: match[0] };
}

export function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function isSafeImageData(value) {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,[a-z\d+/\s]+={0,2}$/i.test(value);
}

function styleMap(palette, typography) {
  const font = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;';
  const text = `${font}font-size:${typography.fontSize}px;line-height:${typography.lineHeight};color:${palette.text};`;
  const map = {
    section: `${text}background-color:${palette.bg};box-sizing:border-box;max-width:100%;padding:24px 22px 36px;overflow-wrap:break-word;word-break:normal;`,
    p: `${text}margin:0 0 20px;`,
    strong: `font-weight:700;color:${palette.accent};`, em: 'font-style:italic;',
    a: `color:${palette.accent};text-decoration:none;border-bottom:1px solid ${palette.accent};`,
    ul: `${text}list-style-type:disc;list-style-position:outside;margin:18px 0;padding-left:25px;`,
    ol: `${text}list-style-type:decimal;list-style-position:outside;margin:18px 0;padding-left:25px;`,
    li: `${text}margin:6px 0;padding-left:3px;`,
    blockquote: `${text}margin:24px 0;padding:14px 16px;border-left:3px solid ${palette.accent};background-color:${palette.soft};`,
    code: `font-family:Consolas,"SFMono-Regular",monospace;font-size:14px;color:${palette.accent};background-color:${palette.soft};padding:2px 5px;border-radius:3px;`,
    pre: `font-family:Consolas,"SFMono-Regular",monospace;font-size:13px;line-height:1.65;margin:22px 0;padding:16px;background-color:${palette.soft};border:1px solid ${palette.border};border-radius:5px;overflow-x:auto;white-space:pre;tab-size:2;`,
    preCode: `display:block;font-family:Consolas,"SFMono-Regular",monospace;font-size:13px;line-height:1.65;color:${palette.text};white-space:pre;word-break:normal;overflow-wrap:normal;`,
    hr: `margin:30px 0;border:0;border-top:1px solid ${palette.border};`,
    table: `${font}font-size:14px;line-height:1.7;color:${palette.text};width:100%;table-layout:fixed;border-collapse:collapse;margin:22px 0;`,
    th: `padding:9px 8px;border:1px solid ${palette.border};background-color:${palette.soft};font-weight:600;overflow-wrap:anywhere;`,
    td: `padding:9px 8px;border:1px solid ${palette.border};overflow-wrap:anywhere;`,
    s: 'text-decoration:line-through;',
  };
  for (let level = 1; level <= 6; level++) {
    const size = [27, 23, 20, 18, 17, 16][level - 1];
    map[`h${level}`] = `${font}font-size:${size}px;line-height:1.5;font-weight:700;color:${palette.accent};margin:${level === 1 ? '8px' : '30px'} 0 16px;${level === 2 ? `padding-bottom:8px;border-bottom:1px solid ${palette.border};` : ''}`;
  }
  return map;
}

/** Styling needs explicit, current ownership; matching text elsewhere never acquires it. */
function recommendationRange(source, prepared, footer) {
  if (!footer || footer.detached || !Number.isSafeInteger(footer.start) || !Number.isSafeInteger(footer.end)
    || typeof footer.text !== 'string' || footer.text.length > 1_100_000 || footer.start < 0
    || footer.end <= footer.start || footer.end > source.length || source.slice(footer.start,footer.end) !== footer.text) return null;
  const prefix = /^(\n*)相关文章推荐：\n\n/.exec(footer.text);
  if (!prefix) return null;
  const lines = footer.text.slice(prefix[0].length).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || !lines.every(line => line.startsWith('- ') && line.slice(2).trim())) return null;
  const removed = prepared.removedFrontmatter ? prepared.frontmatter.length : 0;
  const start = footer.start - removed, end = footer.end - removed;
  if (start < 0 || prepared.source.slice(start,end) !== footer.text) return null;
  // A managed footer is a standalone block; a hand-crafted mid-line range is inert.
  if (start > 0 && prepared.source[start-1] !== '\n' && !prefix[1]) return null;
  if (end < prepared.source.length && !footer.text.endsWith('\n') && prepared.source[end] !== '\n') return null;
  // This includes escaped literal backslashes; image-path decoding stays independent.
  const decodeTitle = title => title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,'$1');
  return {start,end,leading:prefix[1],titles:lines.map(line => decodeTitle(line.slice(2)))};
}

function renderRecommendations(range, palette, typography) {
  const font = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;';
  const section = `${font}margin:38px 0 0;padding:20px 0 0;border-top:1px solid ${palette.border};`;
  const smallSize = auxiliaryFontSize(typography.fontSize);
  const label = `${font}font-size:${smallSize}px;line-height:1.6;font-weight:600;color:${palette.accent};margin:0 0 8px;`;
  const list = `${font}list-style:none;margin:0;padding:0;`;
  const rows = range.titles.map((title,i) => {
    const style = `${font}list-style:none;font-size:${smallSize}px;line-height:${typography.lineHeight};color:${palette.text};margin:0;padding:10px 0;overflow-wrap:break-word;${i < range.titles.length-1 ? `border-bottom:1px solid ${palette.border};` : ''}`;
    return `<li style="${escapeHtml(style)}">${escapeHtml(title)}</li>`;
  }).join('\n');
  return `<section aria-label="相关文章推荐" style="${escapeHtml(section)}"><p style="${escapeHtml(label)}">相关文章推荐：</p><ul style="${escapeHtml(list)}">${rows}</ul></section>\n`;
}

/** All export styles are inline. No DOMParser or browser API is required. */
export function renderArticle(value, { theme = 'clear', stripFrontmatter = false, index = buildImageIndex(), articlePath = '', assetData = new Map(), markdownFactory = globalThis.markdownit, relatedFooter = null, presentation = null } = {}) {
  if (typeof markdownFactory !== 'function') throw new Error('本地 Markdown 渲染器未加载，请检查 vendor/markdown-it.cjs。');
  const prepared = prepareSource(value, { stripFrontmatter });
  const hasTheme = Object.hasOwn(PALETTES,theme);
  const typography = effectiveTypography(theme,presentation);
  const source = prepared.source, palette = {...PALETTES[hasTheme ? theme : 'clear'],accent:typography.accentColor}, styles = styleMap(palette,typography);
  let related = recommendationRange(String(value ?? ''),prepared,relatedFooter);
  const allRefs = parseImageReferences(source);
  if (related && allRefs.some(ref => ref.start < related.end && ref.end > related.start
    && (ref.start < related.start || ref.end > related.end))) related = null;
  const refs = allRefs.filter(ref => !related || ref.start < related.start || ref.end > related.end), issues = [], images = [];
  // A user-written marker remains ordinary text, without repeated whole-source searches.
  const occupiedMarkers = new Set(source.match(/XYLLOCALIMAGE\d+X/g) || []);
  let markerNumber = 0;
  while (occupiedMarkers.has(`XYLLOCALIMAGE${markerNumber}X`)) markerNumber++;
  const prefix = `XYLLOCALIMAGE${markerNumber}X`;
  const replacements = new Map();
  const getData = path => assetData instanceof Map ? assetData.get(path) : assetData?.[path];
  for (const ref of refs) {
    const result = resolveImage(ref, { index, articlePath });
    const data = result.status === 'matched' ? getData(result.path) : null;
    const hasData = isSafeImageData(data);
    const image = { ...ref, ...result, hasData };
    images.push(image);
    const marker = `${prefix}${ref.id}END`;
    if (result.status === 'matched' && hasData) {
      const sizing = ref.width ? `width:${ref.width}px;` : 'width:auto;';
      const heightStyle = ref.height ? `height:auto;max-height:${ref.height}px;object-fit:contain;` : 'height:auto;';
      const sizeAttrs = `${ref.width ? ` width="${ref.width}"` : ''}${ref.height ? ` height="${ref.height}"` : ''}`;
      const caption = ref.alt ? `<span style="display:block;font-size:12px;line-height:1.6;color:${palette.muted};text-align:center;margin-top:8px;">${escapeHtml(ref.alt)}</span>` : '';
      replacements.set(marker, `<span style="display:block;margin:24px 0;"><img src="${escapeHtml(data)}" alt="${escapeHtml(ref.alt || basename(ref.target))}"${sizeAttrs} style="display:block;${sizing}max-width:100%;${heightStyle}margin:0 auto;border-radius:4px;" />${caption}</span>`);
    } else {
      const status = result.status === 'matched' ? 'asset-unavailable' : result.status;
      const message = result.status === 'matched' ? `图片“${ref.target}”已匹配，但文件未读取或格式不受支持。` : result.message;
      issues.push({ ...ref, ...result, status, message });
      replacements.set(marker, `<span style="display:block;margin:20px 0;padding:16px;border:1px dashed #b78362;background-color:#fff8f1;font-size:13px;line-height:1.7;color:#805c40;">${escapeHtml(message)}</span>`);
    }
  }
  const sourceParts = [];
  let cursor = 0;
  for (const ref of refs) {
    sourceParts.push(source.slice(cursor,ref.start),`${prefix}${ref.id}END`);cursor = ref.end;
  }
  sourceParts.push(source.slice(cursor));
  let replaced = sourceParts.join('');
  const md = markdownFactory({ html: false, linkify: false, typographer: false, breaks: true });
  const originalValidateLink = md.validateLink.bind(md);
  md.validateLink = url => originalValidateLink(url) && !/^(?:file:|\/\/)/i.test(url) && (!/^[a-z][a-z\d+.-]*:/i.test(url) || /^(?:https?:|mailto:|tel:)/i.test(url));
  const originalRenderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx];
    if (token.nesting !== -1 && styles[token.tag]) {
      const existing = token.attrGet('style') || '';
      let local = '';
      if (token.meta?.xylReference) {
        const smallSize = auxiliaryFontSize(typography.fontSize);
        if (['p', 'ul', 'ol', 'li', 'blockquote'].includes(token.tag)) local += `font-size:${smallSize}px;`;
        if (token.tag === 'ul' || token.tag === 'ol') local += 'margin:10px 0;padding-left:20px;';
        if (token.tag === 'li') local += 'margin:4px 0;padding-left:0;';
        if (token.meta.xylReferenceTitle && (token.tag === 'p' || /^h[1-6]$/.test(token.tag))) {
          local += `font-size:${smallSize}px;line-height:1.6;font-weight:600;color:${palette.accent};margin:26px 0 10px;padding-bottom:0;border-bottom:0;`;
        }
      }
      token.attrSet('style', `${styles[token.tag]}${local}${existing}`);
    }
    if (token.type === 'link_open') token.attrSet('rel', 'noopener noreferrer');
    return originalRenderToken(tokens, idx, options);
  };
  md.renderer.rules.code_inline = (tokens, idx) => `<code style="${escapeHtml(styles.code)}">${escapeHtml(tokens[idx].content)}</code>`;
  // Placeholders are expanded only in escaped text tokens, never in href/title attributes.
  const markerPattern = new RegExp(`${prefix}\\d+END`,'g');
  md.renderer.rules.text = (tokens, idx) => escapeHtml(tokens[idx].content)
    .replace(markerPattern,marker => replacements.get(marker) || marker);
  const renderCode = (tokens, idx) => `<pre style="${escapeHtml(styles.pre)}"><code style="${escapeHtml(styles.preCode)}">${escapeHtml(tokens[idx].content)}</code></pre>\n`;
  md.renderer.rules.fence = renderCode;
  md.renderer.rules.code_block = renderCode;
  // Any image syntax not handled by the local parser stays inert and is reported.
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx], target = token.attrGet('src') || '';
    issues.push({ status: 'blocked', target, message: '该图片语法未解析，请使用本地图片路径。' });
    return `<span style="font-size:13px;color:#805c40;">[未解析图片：${escapeHtml(target)}]</span>`;
  };
  let tokens, env = {};
  if (related) {
    const marker = `${prefix}RELATEDFOOTEREND`;
    let offset = 0;
    for (const ref of refs) {
      if (ref.end <= related.start) offset += `${prefix}${ref.id}END`.length - (ref.end-ref.start);
    }
    const start = related.start + offset, end = related.end + offset;
    const original = replaced;
    replaced = replaced.slice(0,start) + related.leading + marker + '\n' + replaced.slice(end);
    md.block.ruler.before('paragraph','xyl_related_footer',(state,startLine,_endLine,silent) => {
      const at = state.bMarks[startLine] + state.tShift[startLine], finish = state.eMarks[startLine];
      if (state.src.slice(at,finish) !== marker || state.sCount[startLine] >= 4) return false;
      if (silent) return true;
      const token = state.push('xyl_related_footer','section',0);
      token.map = [startLine, startLine + 1];
      state.env.relatedFooterRendered = true;
      state.line = startLine + 1;
      return true;
    });
    md.renderer.rules.xyl_related_footer = () => renderRecommendations(related,palette,typography);
    tokens = md.parse(replaced,env);
    // If a fence or other Markdown context consumed the marker, render original text.
    if (!env.relatedFooterRendered) { env = {}; replaced = original; tokens = md.parse(original,env); }
  } else tokens = md.parse(replaced,env);
  markReferenceTokens(tokens, replaced);
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.meta?.xylReferenceTitle) continue;
    const label = referenceTitleText(token.content);
    if (label !== null) token.children = md.parseInline(label, {}).at(0)?.children || token.children;
  }
  const content = md.renderer.render(tokens,md.options,env);
  return { html: `<section style="${escapeHtml(styles.section)}">${content}</section>`, issues, images, source, removedFrontmatter: prepared.removedFrontmatter, theme: hasTheme ? theme : 'clear' };
}
