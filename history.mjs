import {normalizeDirectoryMetadata} from './source-metadata.mjs';
import {getDisplayTitle} from './recommendation-title.mjs';

/** Local, user-selected history files. Stored records deliberately omit bodies and absolute paths. */
export const HISTORY_LIMITS = Object.freeze({files:2000, fileBytes:2_000_000, totalBytes:30_000_000, title:500});
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const controls = /[\u0000-\u001f\u007f]/;
const own = value => value && typeof value === 'object' && !Array.isArray(value);
const basename = value => String(value || '').replaceAll('\\','/').split('/').pop();
const fileName = value => (basename(value).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255) || '未命名.md');
const cleanTitle = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,HISTORY_LIMITS.title);

function hasManagedStructure(text) {
  if (typeof text !== 'string') return false;
  const prefix = /^\n*相关文章推荐：\n\n/.exec(text);
  if (!prefix) return false;
  const lines = text.slice(prefix[0].length).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length > 0 && lines.every(line => line.startsWith('- ') && line.slice(2).trim());
}

/** Validate persisted metadata and filter unknown fields, selections and duplicate IDs. */
export function normalizeHistoryState(input = {}, source) {
  const items = [], seen = new Set();
  for (const entry of Array.isArray(input?.items) ? input.items.slice(0,HISTORY_LIMITS.files) : []) {
    if (!own(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)
      || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > HISTORY_LIMITS.title || controls.test(entry.title)) continue;
    seen.add(entry.id);
    const item = {id:entry.id,title:entry.title.trim(),name:fileName(typeof entry.name === 'string' ? entry.name : '未命名.md')};
    if (typeof entry.displayTitle === 'string' && entry.displayTitle.trim() && entry.displayTitle.length <= HISTORY_LIMITS.title && !controls.test(entry.displayTitle)) {
      item.displayTitle = entry.displayTitle.trim();
    }
    if (['filename','heading','frontmatter'].includes(entry.titleSource)) item.titleSource = entry.titleSource;
    items.push(item);
  }
  const selectedIds = [];
  for (const id of Array.isArray(input?.selectedIds) ? input.selectedIds : []) {
    if (seen.has(id) && !selectedIds.includes(id)) selectedIds.push(id);
  }
  let footer = null;
  if (own(input?.footer)) {
    const raw = input.footer;
    const valid = Number.isSafeInteger(raw.start) && Number.isSafeInteger(raw.end) && raw.start >= 0 && raw.end >= raw.start
      && typeof raw.text === 'string' && raw.text.length <= 1_100_000 && hasManagedStructure(raw.text);
    if (valid && raw.detached !== true) {
      footer = {start:raw.start,end:raw.end,text:raw.text};
      if (typeof source === 'string' && (raw.end > source.length || source.slice(raw.start,raw.end) !== raw.text)) {
        footer = {detached:true};
      }
    } else footer = {detached:true};
  }
  return {items,selectedIds,footer,...normalizeDirectoryMetadata(input,seen)};
}

/** A small SHA-256 implementation avoids dependencies or network services for content IDs. */
export function fingerprintText(text) {
  const bytes = new TextEncoder().encode(String(text).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'));
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(length); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8,Math.floor(bytes.length / 0x20000000)); view.setUint32(length - 4,(bytes.length * 8) >>> 0);
  const rotate = (n,b) => (n >>> b) | (n << (32-b));
  const w = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i-15], b = w[i-2];
      w[i] = (w[i-16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + w[i-7] + (rotate(b,17)^rotate(b,19)^(b>>>10))) >>> 0;
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^((~e)&g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
      j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    for (const [i,value] of [a,b,c,d,e,f,g,j].entries()) h[i] = (h[i]+value)>>>0;
  }
  return 'h-' + h.map(n => n.toString(16).padStart(8,'0')).join('');
}

/** Read only a top-level YAML scalar, never execute or interpret arbitrary YAML. */
function frontmatterTitle(text) {
  const lines = text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');
  if (lines[0]?.trim() !== '---') return '';
  const end = lines.findIndex((line,i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return '';
  for (let i = 1; i < end; i++) {
    const match = /^title\s*:\s*(.*?)\s*$/i.exec(lines[i]);
    if (!match) continue;
    const raw = match[1];
    if (!raw || /^[>|\[\]{&*!]/.test(raw)) return '';
    if (raw.startsWith('"')) {
      // JSON-compatible escapes cover common quoted titles; unsupported YAML falls back safely.
      const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
      if (!quoted) return '';
      try { return cleanTitle(JSON.parse(quoted[1])); } catch { return ''; }
    }
    if (raw.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw);
      return quoted ? cleanTitle(quoted[1].replaceAll("''","'")) : '';
    }
    return cleanTitle(raw.replace(/\s+#.*$/,''));
  }
  return '';
}

export function extractHistoryTitle(text, name) {
  const yaml = frontmatterTitle(text);
  if (yaml) return {title:yaml,source:'frontmatter'};
  let fence = null, inFrontmatter = false;
  const lines = String(text).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');
  if (lines[0]?.trim() === '---' && lines.slice(1).some(line => /^(?:---|\.\.\.)\s*$/.test(line))) inFrontmatter = true;
  for (const [i,line] of lines.entries()) {
    if (inFrontmatter) { if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) inFrontmatter=false; continue; }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = {character:marker[1][0],length:marker[1].length};
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence=null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#[ \t]+(.+?)[ \t]*$/.exec(line);
    const title = heading ? cleanTitle(heading[1].replace(/[ \t]+#+[ \t]*$/,'')) : '';
    if (title) return {title,source:'heading'};
  }
  return {title:cleanTitle(fileName(name).replace(/\.(?:md|txt)$/i,'')) || '未命名文章',source:'filename'};
}

/** Atomic import: cancellation returns the original records, even after some reads complete. */
export async function importHistoryFiles(files, {existing = [],directory = false,signal,isCancelled = () => false,
  maxFiles = HISTORY_LIMITS.files,maxFileBytes = HISTORY_LIMITS.fileBytes,maxTotalBytes = HISTORY_LIMITS.totalBytes} = {}) {
  const original = normalizeHistoryState({items:existing}).items;
  const staged = [...original], ids = new Set(staged.map(item => item.id));
  const issues = [], titleSources = [];
  const cancelled = () => signal?.aborted || isCancelled();
  const result = (cancel = false) => ({items:cancel ? original : staged,added:cancel ? 0 : staged.length-original.length,
    skipped:cancel ? 0 : skipped,issues:cancel ? [] : issues,titleSources:cancel ? [] : titleSources,cancelled:Boolean(cancel)});
  let skipped = 0, totalBytes = 0;
  if (cancelled()) return result(true);
  const selected = Array.from(files || []);
  const candidates = selected.filter(file => (directory ? /\.md$/i : /\.(?:md|txt)$/i).test(fileName(file?.name || file?.webkitRelativePath)));
  skipped = selected.length-candidates.length;
  if (candidates.length > maxFiles) {
    issues.push({status:'batch-limit',name:'',message:`一次最多选择 ${maxFiles} 个文件，请缩小所选范围。`});
    skipped = selected.length; return result();
  }
  for (const file of candidates) {
    if (cancelled()) return result(true);
    const name = fileName(file?.name || file?.webkitRelativePath);
    if (staged.length >= HISTORY_LIMITS.files) {
      skipped++;issues.push({status:'index-limit',name,message:'历史文章最多保留 2000 条，请先删除不需要的记录。'});continue;
    }
    try {
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('unreadable');
      if (Number.isFinite(file.size) && file.size > maxFileBytes) {
        skipped++;issues.push({status:'file-limit',name,message:`文件超过 ${maxFileBytes} 字节，未读取。`});continue;
      }
      if (Number.isFinite(file.size) && totalBytes + file.size > maxTotalBytes) {
        issues.push({status:'batch-limit',name,message:`本批总大小超过 ${maxTotalBytes} 字节，整批未导入。`});
        return {...result(),items:original,added:0,skipped:selected.length,titleSources:[]};
      }
      const buffer = await file.arrayBuffer();
      if (cancelled()) return result(true);
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength > maxFileBytes) {skipped++;issues.push({status:'file-limit',name,message:'实际文件大小超出限制，未导入。'});continue;}
      totalBytes += bytes.byteLength;
      if (totalBytes > maxTotalBytes) {
        issues.push({status:'batch-limit',name,message:`本批总大小超过 ${maxTotalBytes} 字节，整批未导入。`});
        return {...result(),items:original,added:0,skipped:selected.length,titleSources:[]};
      }
      const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      const id = fingerprintText(text);
      if (ids.has(id)) {skipped++;issues.push({status:'duplicate',name,message:'内容与已导入文章相同，已跳过。'});continue;}
      const extracted = extractHistoryTitle(text,name);
      const sameTitle = staged.filter(item => item.title === extracted.title);
      if (sameTitle.length) issues.push({status:'same-title',name,message:`存在同标题“${extracted.title}”的不同文章，已全部保留，请按文件名区分。`});
      ids.add(id);staged.push({id,title:extracted.title,name});titleSources.push({id,source:extracted.source});
    } catch {
      if (cancelled()) return result(true);
      skipped++;issues.push({status:'read-error',name,message:'文件无法读取或不是有效 UTF-8 文本，未导入。'});
    }
  }
  return result(cancelled());
}

export function searchHistory(items, query = '') {
  const q = String(query).normalize('NFKC').toLocaleLowerCase().trim();
  return normalizeHistoryState({items}).items.filter(item => !q || `${getDisplayTitle(item)}\n${item.title}\n${item.name}`.normalize('NFKC').toLocaleLowerCase().includes(q));
}

export function toggleHistorySelection(input, id, checked) {
  const state = normalizeHistoryState(input);
  if (!state.items.some(item => item.id === id)) return state;
  const select = checked === undefined ? !state.selectedIds.includes(id) : Boolean(checked);
  if (select && state.selectedIds.includes(id)) return state;
  state.selectedIds = state.selectedIds.filter(value => value !== id);
  if (select) state.selectedIds.push(id);
  return state;
}

export function moveHistorySelection(input, id, direction) {
  const state = normalizeHistoryState(input), at = state.selectedIds.indexOf(id);
  const offset = direction === 'up' || direction === -1 ? -1 : direction === 'down' || direction === 1 ? 1 : 0;
  const next = at + offset;
  if (at >= 0 && next >= 0 && next < state.selectedIds.length) [state.selectedIds[at],state.selectedIds[next]] = [state.selectedIds[next],state.selectedIds[at]];
  return state;
}

export function removeHistoryItem(input, id) {
  const state = normalizeHistoryState(input);
  state.items = state.items.filter(item => item.id !== id);
  state.selectedIds = state.selectedIds.filter(value => value !== id);
  if (state.sources) {
    state.sources = state.sources.map(source => ({...source,entries:source.entries.filter(entry => entry.articleId !== id)}));
    state.manualIds = state.manualIds.filter(value => value !== id);
    if (state.manualEntries) state.manualEntries = state.manualEntries.filter(entry => entry.articleId !== id);
  }
  return state;
}

/** Escape every CommonMark punctuation character so titles cannot become links or images. */
export function escapeRelatedTitle(title) {
  return cleanTitle(title).replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,'\\$&');
}

export function relatedMarkdown(items) {
  const titles = normalizeHistoryState({items}).items.map(item => escapeRelatedTitle(getDisplayTitle(item)));
  return titles.length ? `相关文章推荐：\n\n${titles.map(title => `- ${title}`).join('\n')}\n` : '';
}

function trustedFooter(source, footer) {
  return own(footer) && !footer.detached && Number.isSafeInteger(footer.start) && Number.isSafeInteger(footer.end)
    && footer.start >= 0 && footer.end >= footer.start && footer.end <= source.length && hasManagedStructure(footer.text)
    && source.slice(footer.start,footer.end) === footer.text;
}

/** Replace only our tracked range. Rendering, copy and export consume this ordinary source. */
export function syncRelatedFooter(source, selectedItems, footer = null) {
  source = String(source);
  const block = relatedMarkdown(selectedItems);
  if (footer && !trustedFooter(source,footer)) return {source,footer,range:footer,changed:false,conflict:true};
  if (!footer && !block) return {source,footer:null,range:null,changed:false,conflict:false};
  const start = footer ? footer.start : source.length;
  const end = footer ? footer.end : source.length;
  // Preserve the separator created with this range; source outside it is never normalized.
  const leading = footer ? (/^\n*/.exec(footer.text)?.[0] || '')
    : !source || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  const text = block ? leading + block : '';
  const nextSource = source.slice(0,start) + text + source.slice(end);
  const nextFooter = block ? {start,end:start+text.length,text} : null;
  return {source:nextSource,footer:nextFooter,range:nextFooter,changed:nextSource!==source,conflict:false};
}

/** Only a same-line title edit can remain managed; new paragraphs belong to the user. */
function editsOneTitle(footer, start, oldEnd, inserted) {
  if (/[\r\n]/.test(inserted)) return false;
  const prefix = /^\n*相关文章推荐：\n\n/.exec(footer.text);
  if (!prefix) return false;
  let at = prefix[0].length;
  while (at < footer.text.length) {
    const lineEnd = footer.text.indexOf('\n',at);
    const end = lineEnd < 0 ? footer.text.length : lineEnd;
    if (!footer.text.slice(at,end).startsWith('- ')) return false;
    const titleStart = footer.start + at + 2, titleEnd = footer.start + end;
    if (start >= titleStart && oldEnd <= titleEnd) {
      const title = footer.text.slice(at+2,start-footer.start) + inserted + footer.text.slice(oldEnd-footer.start,end);
      return Boolean(title.trim());
    }
    at = end + 1;
  }
  return false;
}

/** Track textarea edits. Structural edits detach rather than swallowing new body text. */
export function trackRelatedFooterEdit(before, after, footer) {
  before=String(before);after=String(after);
  if (!footer) return null;
  if (!trustedFooter(before,footer)) return {detached:true};
  if (before === after) return {...footer};
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length-start && suffix < after.length-start && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
  const oldEnd=before.length-suffix,delta=after.length-before.length;
  let a=footer.start,b=footer.end;
  if (oldEnd <= a) {a+=delta;b+=delta;}
  else if (start >= b) { /* Changes after the managed range do not belong to it. */ }
  else if (start >= a && oldEnd <= b) {
    if (!editsOneTitle(footer,start,oldEnd,after.slice(start,after.length-suffix))) return {detached:true};
    b+=delta;
    if (b === a) return {detached:true};
  } else {
    return {detached:true};
  }
  return {start:a,end:b,text:after.slice(a,b)};
}

export const trackManagedRange = trackRelatedFooterEdit;
