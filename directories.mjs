import {HISTORY_LIMITS, normalizeHistoryState, fingerprintText, extractHistoryTitle} from './history.mjs';
import {DIRECTORY_LIMITS, isArticleRelativePath, isDirectoryLabel} from './source-metadata.mjs';

const hashPattern = /^h-[a-f0-9]{64}$/;
const basename = value => String(value || '').replaceAll('\\','/').split('/').pop();
const nameOf = file => basename(file?.name || file?.webkitRelativePath).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255);
const issue = (status,message,name = '') => ({status,name,message});
const references = sources => new Set(sources.flatMap(source => source.entries.map(entry => entry.articleId)));
const unique = values => [...new Set(values)];

function context(files, options) {
  const original = normalizeHistoryState(options.state);
  const selected = Array.from(files || []);
  const cancelled = () => Boolean(options.signal?.aborted || options.isCancelled?.());
  const result = (issues = [], cancel = false) => ({state:original,sourceId:options.sourceId || null,
    committed:false,cancelled:cancel,added:0,updated:0,removed:0,skipped:cancel ? 0 : selected.length,issues:cancel ? [] : issues});
  return {original,selected,cancelled,result};
}

/** One atomic read; an incomplete directory snapshot can never delete old articles. */
async function readCandidates(candidates, selectedCount, options, cancelled) {
  const maxFiles = Math.min(options.maxFiles ?? HISTORY_LIMITS.files,HISTORY_LIMITS.files);
  const maxFileBytes = options.maxFileBytes ?? HISTORY_LIMITS.fileBytes;
  const maxTotalBytes = options.maxTotalBytes ?? HISTORY_LIMITS.totalBytes;
  const issues = [], records = [];
  if (candidates.length > maxFiles) return {issues:[issue('batch-limit',`一次最多选择 ${maxFiles} 篇候选文章，请缩小目录范围。`)],failed:true};
  let total = 0;
  for (const {file,path} of candidates) {
    if (cancelled()) return {cancelled:true};
    const name = nameOf(file);
    try {
      if (!file || typeof file.arrayBuffer !== 'function') throw new Error('unreadable');
      if (Number.isFinite(file.size) && file.size > maxFileBytes) {
        return {issues:[issue('file-limit',`文件超过 ${maxFileBytes} 字节；本次目录未更新。`,name)],failed:true};
      }
      if (Number.isFinite(file.size) && total + file.size > maxTotalBytes) {
        return {issues:[issue('batch-limit',`批次总大小超过 ${maxTotalBytes} 字节；本次未更新。`,name)],failed:true};
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (cancelled()) return {cancelled:true};
      if (bytes.byteLength > maxFileBytes) return {issues:[issue('file-limit','实际文件大小超过限制；本次未更新。',name)],failed:true};
      total += bytes.byteLength;
      if (total > maxTotalBytes) return {issues:[issue('batch-limit',`批次总大小超过 ${maxTotalBytes} 字节；本次未更新。`,name)],failed:true};
      const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      const extracted = extractHistoryTitle(text,name);
      records.push({path,name,title:extracted.title,fingerprint:fingerprintText(text),titleSource:extracted.source});
    } catch {
      if (cancelled()) return {cancelled:true};
      return {issues:[issue('read-error','文件无法读取或不是有效 UTF-8；本次未更新，原目录索引保留。',name)],failed:true};
    }
  }
  return {records,issues,skipped:selectedCount-candidates.length};
}

/** Current content IDs may differ from stable article IDs after a same-path edit. */
function fingerprintIndex(state) {
  const byHash = new Map(), tracked = references(state.sources || []);
  for (const source of state.sources || []) for (const entry of source.entries) {
    if (!byHash.has(entry.fingerprint)) byHash.set(entry.fingerprint,entry.articleId);
  }
  for (const entry of state.manualEntries || []) {
    if (!byHash.has(entry.fingerprint)) byHash.set(entry.fingerprint,entry.articleId);
  }
  // Manual references can outlive their last directory, so a stable ID is not its current hash.
  for (const id of state.manualIds || []) tracked.add(id);
  for (const item of state.items) {
    if (!tracked.has(item.id) && hashPattern.test(item.id) && !byHash.has(item.id)) byHash.set(item.id,item.id);
  }
  return byHash;
}

function nextArticleId(fingerprint, items) {
  if (!items.has(fingerprint)) return fingerprint;
  let counter = 1, id;
  do {id = `a-${fingerprint.slice(2,62)}-${counter++}`;} while (items.has(id));
  return id;
}

function nextSourceId(sources) {
  const existing = new Set(sources.map(source => source.id));
  let id;
  do {id = `d-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}`;} while (existing.has(id));
  return id;
}

function retainedItems(original, items, sources, manualIds) {
  // Only formerly owned articles can be removed. Unbound v1/v2 records remain local.
  const formerlyOwned = references(original.sources || []), nowOwned = references(sources);
  return items.filter(item => !formerlyOwned.has(item.id) || nowOwned.has(item.id) || manualIds.includes(item.id));
}

function finishState(original, items, sources, manualIds, translations = new Map()) {
  const retained = retainedItems(original,items,sources,manualIds);
  const valid = new Set(retained.map(item => item.id));
  const selectedIds = unique(original.selectedIds.map(id => translations.get(id) || id).filter(id => valid.has(id)));
  return normalizeHistoryState({...original,items:retained,selectedIds,sources,manualIds});
}

function sameTitleWarning(items, record, id, issues) {
  if ([...items.values()].some(item => item.id !== id && item.title === record.title)) {
    issues.push(issue('same-title',`同名标题“${record.title}”对应不同内容，已保留各篇，请人工辨认。`,record.name));
  }
}

/** A directory is read only after the user chooses it. Re-selecting a source replaces its snapshot. */
export async function importHistoryDirectory(files, options = {}) {
  const {original,selected,cancelled,result} = context(files,options);
  if (cancelled() || !selected.length) return result([],true);
  const sources = original.sources || [], manualIds = original.manualIds || [];
  const target = options.sourceId ? sources.find(source => source.id === options.sourceId) : null;
  if (options.sourceId && !target) return result([issue('unknown-source','该目录来源已不存在，请重新追加目录。')]);
  if (!target && sources.length >= DIRECTORY_LIMITS.sources) return result([issue('source-limit','目录来源过多，请先移除不需要的来源。')]);
  let label = null;
  const candidates = [], paths = new Set();
  for (const file of selected) {
    const relative = file?.webkitRelativePath;
    if (typeof relative !== 'string' || !relative.includes('/') || relative.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(relative)) {
      return result([issue('invalid-directory','未获得可靠的目录相对路径，请通过“选择目录”重新选择。')]);
    }
    const [root,...parts] = relative.split('/');
    if (!isDirectoryLabel(root)) return result([issue('invalid-directory','目录名称不适合用作文章来源，请重新选择文章目录。')]);
    if (label && root !== label) return result([issue('mixed-directory','本次选择包含多个目录根，请分别追加。')]);
    label = root;
    const path = parts.join('/');
    if (!isArticleRelativePath(path)) continue;
    if (paths.has(path)) return result([issue('duplicate-path','同一目录内相对路径重复，本次未更新。',nameOf(file))]);
    paths.add(path); candidates.push({file,path});
  }
  if (target && target.label !== label) return result([issue('source-mismatch',`请重新选择“${target.label}”目录；所选目录名称不同，原索引未改。`)]);
  if (!target && sources.some(source => source.label === label)) {
    return result([issue('source-conflict',`已有“${label}”来源，请点击该来源的“重新选择更新”。浏览器不能区分两个同名目录，原索引未改。`)]);
  }
  const read = await readCandidates(candidates,selected.length,options,cancelled);
  if (read.cancelled || cancelled()) return result([],true);
  if (read.failed) return result(read.issues);
  const records = read.records, issues = [...read.issues];
  if (!records.length) issues.push(issue('no-articles','所选目录没有符合条件的 Markdown 文章；已排除说明、隐藏和备份文件。'));
  const sourceId = target?.id || nextSourceId(sources);
  const items = new Map(original.items.map(item => [item.id,{...item}]));
  const byHash = fingerprintIndex(original), oldPaths = new Map((target?.entries || []).map(entry => [entry.path,entry]));
  const outside = references(sources.filter(source => source.id !== sourceId));
  for (const id of manualIds) outside.add(id);
  const incomingHashes = new Set(records.map(record => record.fingerprint));
  const oldHashes = new Map(), changedHashes = new Map();
  for (const entry of target?.entries || []) {
    if (!oldHashes.has(entry.articleId)) oldHashes.set(entry.articleId,new Set());
    oldHashes.get(entry.articleId).add(entry.fingerprint);
  }
  for (const record of records) {
    const old = oldPaths.get(record.path);
    if (!old) continue;
    if (!changedHashes.has(old.articleId)) changedHashes.set(old.articleId,new Set());
    changedHashes.get(old.articleId).add(record.fingerprint);
  }
  const mutable = id => !outside.has(id) && changedHashes.get(id)?.size === 1
    && ![...(oldHashes.get(id) || [])].some(hash => incomingHashes.has(hash));
  const entries = [], translations = new Map(), usedHashes = new Set();
  let duplicates = 0;
  for (const record of records) {
    const old = oldPaths.get(record.path);
    let id = byHash.get(record.fingerprint);
    if (!id && old && mutable(old.articleId)) id = old.articleId;
    if (!id) id = nextArticleId(record.fingerprint,items);
    if (!items.has(id)) {
      sameTitleWarning(items,record,id,issues);
      items.set(id,{id,title:record.title,name:record.name,titleSource:record.titleSource});
    } else if (old && old.fingerprint !== record.fingerprint && mutable(old.articleId)) {
      translations.set(old.articleId,id);
      if (id === old.articleId) {
        sameTitleWarning(items,record,id,issues);
        items.set(id,{...items.get(id),title:record.title,name:record.name,titleSource:record.titleSource});
      }
    } else if (target && !outside.has(id)
      && (records.find(value => value.fingerprint === record.fingerprint && value.name === items.get(id).name)
        || records.find(value => value.fingerprint === record.fingerprint)) === record) {
      // A same-content rename can change a filename fallback title for this sole source.
      items.set(id,{...items.get(id),title:record.title,name:record.name,titleSource:record.titleSource});
    }
    if (old && old.fingerprint !== record.fingerprint && !mutable(old.articleId)) {
      issues.push(issue('shared-change','原文章仍被其它文件或来源引用；这次变化作为另一篇保留，请人工勾选新篇。',record.name));
    }
    if (usedHashes.has(record.fingerprint) || !old && byHash.has(record.fingerprint)) duplicates++;
    usedHashes.add(record.fingerprint); byHash.set(record.fingerprint,id);
    entries.push({path:record.path,articleId:id,fingerprint:record.fingerprint});
  }
  if (duplicates) issues.push(issue('duplicate',`本次 ${duplicates} 个文件与已有内容相同，文章合并显示，来源引用均保留。`));
  if (entries.length + sources.filter(source => source.id !== sourceId).reduce((sum,source) => sum+source.entries.length,0) > DIRECTORY_LIMITS.entries) {
    return result([issue('source-limit','来源文件索引达到上限，本次未更新，请先移除不需要的来源。')]);
  }
  const nextSources = target ? sources.map(source => source.id === sourceId ? {id:sourceId,label,entries} : source)
    : [...sources,{id:sourceId,label,entries}];
  if (retainedItems(original,[...items.values()],nextSources,manualIds).length > HISTORY_LIMITS.files) {
    return result([issue('index-limit','历史文章最多保留 2000 篇，本次未更新，请先删除不需要的记录。')]);
  }
  const state = finishState(original,[...items.values()],nextSources,manualIds,translations);
  // Unknown legacy records cannot be attributed to a directory by title or filename.
  const legacy = original.items.filter(item => !references(sources).has(item.id) && !manualIds.includes(item.id));
  if (legacy.some(item => !entries.some(entry => entry.articleId === item.id))) {
    issues.push(issue('legacy-unbound','旧版未记录目录来源，无法按标题或文件名反推；未匹配的旧记录保留，请人工删除不需要的条目。'));
  }
  const oldById = new Map(original.items.map(item => [item.id,item]));
  const changedContentIds = new Set(entries.filter(entry => {
    const old = oldPaths.get(entry.path);
    return old && old.articleId === entry.articleId && old.fingerprint !== entry.fingerprint;
  }).map(entry => entry.articleId));
  return {state,sourceId,committed:true,cancelled:false,
    added:state.items.filter(item => !oldById.has(item.id)).length,
    updated:state.items.filter(item => oldById.has(item.id) && (changedContentIds.has(item.id)
      || oldById.get(item.id).title !== item.title || oldById.get(item.id).name !== item.name)).length,
    removed:original.items.filter(item => !state.items.some(next => next.id === item.id)).length,
    skipped:read.skipped+duplicates,issues};
}

/** Explicit source removal does not read a directory or affect other source references. */
export function removeHistoryDirectory(input, sourceId) {
  const original = normalizeHistoryState(input);
  if (!(original.sources || []).some(source => source.id === sourceId)) return original;
  return finishState(original,original.items,original.sources.filter(source => source.id !== sourceId),original.manualIds || []);
}

/** Individual files remain an explicit reference even if a directory later drops their copy. */
export async function importManualHistoryFiles(files, options = {}) {
  const {original,selected,cancelled,result} = context(files,options);
  if (cancelled() || !selected.length) return result([],true);
  const candidates = selected.filter(file => {
    const name = nameOf(file);
    return /\.(?:md|txt)$/i.test(name) && isArticleRelativePath(name.replace(/\.txt$/i,'.md'));
  }).map(file => ({file,path:''}));
  const read = await readCandidates(candidates,selected.length,options,cancelled);
  if (read.cancelled || cancelled()) return result([],true);
  if (read.failed) return result(read.issues);
  const byHash = fingerprintIndex(original), items = new Map(original.items.map(item => [item.id,item]));
  const manualIds = [...(original.manualIds || [])], issues = [...read.issues];
  const manualEntries = new Map((original.manualEntries || []).map(entry => [entry.articleId,entry]));
  let duplicates = 0;
  for (const record of read.records) {
    let id = byHash.get(record.fingerprint);
    if (id) duplicates++;
    else {
      id = nextArticleId(record.fingerprint,items);sameTitleWarning(items,record,id,issues);
      items.set(id,{id,title:record.title,name:record.name,titleSource:record.titleSource});byHash.set(record.fingerprint,id);
    }
    if (!manualIds.includes(id)) manualIds.push(id);
    manualEntries.set(id,{articleId:id,fingerprint:record.fingerprint});
  }
  if (items.size > HISTORY_LIMITS.files) return result([issue('index-limit','历史文章最多保留 2000 篇，本次未导入。')]);
  if (duplicates) issues.push(issue('duplicate',`${duplicates} 个文件内容相同，合并显示并保留手动导入引用。`));
  const state = normalizeHistoryState({...original,items:[...items.values()],sources:original.sources || [],manualIds,
    manualEntries:[...manualEntries.values()]});
  return {state,sourceId:null,committed:true,cancelled:false,added:state.items.length-original.items.length,
    updated:0,removed:0,skipped:read.skipped+duplicates,issues};
}
