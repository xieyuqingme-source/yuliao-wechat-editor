import {normalizeHistoryState} from './history.mjs';
import {normalizePresentation} from './layout-settings.mjs';

const FORMAT = 'xieyuliao-draft';
const SAFE_DATA = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
const safePath = path => typeof path === 'string' && path && !/[\\\u0000-\u001f]/.test(path)
  && !path.startsWith('/') && !path.split('/').some(p => p === '..') && !/^[a-z]+:/i.test(path);

export function validateDraft(input) {
  if (!input || input.format !== FORMAT || input.version !== 1 || typeof input.markdown !== 'string') {
    throw new Error('这不是受支持的谢雨聊完整草稿（版本 1）。');
  }
  // Character budget preserves older multi-byte drafts; new UI entries separately check UTF-8 bytes.
  if (input.markdown.length > 5 * 1024 * 1024) throw new Error('草稿正文超过 5,242,880 个字符，请拆分文章。');
  if (!Array.isArray(input.assets)) throw new Error('草稿缺少图片清单。');
  if (input.assets.length > 100_000) throw new Error('草稿图片清单超过 10 万项。');
  let total = 0;
  const paths = new Set();
  const assets = input.assets.map(asset => {
    if (!asset || !safePath(asset.path)
      || paths.has(asset.path) || typeof asset.dataURL !== 'string' || !SAFE_DATA.test(asset.dataURL)) {
      throw new Error('草稿包含重复路径、不安全路径或不受支持的图片数据。');
    }
    paths.add(asset.path);
    total += asset.dataURL.length;
    if (total > 80_000_000) throw new Error('草稿图片超过 80 MB，请减少图片后重试。');
    return {path: asset.path, dataURL: asset.dataURL};
  });
  const suppliedIndex = input.indexedFiles ?? assets.map(asset => ({path:asset.path}));
  if (!Array.isArray(suppliedIndex) || suppliedIndex.length > 100_000) throw new Error('草稿文件索引不合法或超过 10 万个文件。');
  // Duplicate index paths are intentional: restoring a draft must retain ambiguity, not pick a cached image.
  const indexedFiles = suppliedIndex.map(entry => {
    if (!entry || !safePath(entry.path)) throw new Error('草稿文件索引包含不安全路径。');
    return {path:entry.path,type:typeof entry.type === 'string' ? entry.type.slice(0,100) : ''};
  });
  const indexedPaths = new Set(indexedFiles.map(entry => entry.path));
  for (const asset of assets) if (!indexedPaths.has(asset.path)) {
    if (indexedFiles.length >= 100_000) throw new Error('草稿文件索引不合法或超过 10 万个文件。');
    indexedFiles.push({path:asset.path,type:''});indexedPaths.add(asset.path);
  }
  return {format: FORMAT, version: 1, markdown: input.markdown,
    theme: ['clear','warm','ink'].includes(input.theme) ? input.theme : 'clear',
    articlePath: typeof input.articlePath === 'string' ? input.articlePath : '',
    stripFrontmatter: input.stripFrontmatter !== false, assets, indexedFiles,
    relatedArticles: normalizeHistoryState(input.relatedArticles, input.markdown),
    ...(Object.hasOwn(input,'presentation') ? {presentation:normalizePresentation(input.presentation)} : {}),
    savedAt: typeof input.savedAt === 'string' ? input.savedAt : new Date().toISOString()};
}

export function makeDraft(options) {
  const {markdown, theme, articlePath, stripFrontmatter, assets, entries, relatedArticles, history, presentation}=options;
  return validateDraft({format: FORMAT, version: 1, markdown, theme, articlePath, stripFrontmatter,
    relatedArticles: relatedArticles ?? history,
    ...(Object.hasOwn(options,'presentation') ? {presentation} : {}),
    assets: [...assets].map(([path, dataURL]) => ({path, dataURL})),
    indexedFiles: entries ? entries.map(entry => ({path:entry.path,type:entry.type || entry.file?.type || ''})) : undefined,
    savedAt: new Date().toISOString()});
}

/** A clear action can cancel work still waiting for image rendering before a write is queued. */
export async function saveDraftAfterRender({render, snapshot, store, isCancelled = () => false}) {
  await render();
  if (isCancelled()) return null;
  return store.save(snapshot());
}

/** Backups are serialized to avoid parallel saves pruning each other's records. */
export function createDraftRepository(backend, {keep = 8, now = () => Date.now()} = {}) {
  if (keep < 5) throw new Error('至少保留 5 份备份。');
  let queue = Promise.resolve();
  let serial = 0;
  const instanceId = globalThis.crypto?.randomUUID?.() || `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const ordered = async () => (await backend.getAll()).sort((a,b) => b.order - a.order || b.id.localeCompare(a.id));
  const serialize = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  return {
    save: draft => serialize(async () => {
      const checked = validateDraft(draft);
      const previous = await ordered();
      const order = Math.max(now(), (previous[0]?.order ?? 0) + 1);
      const record = {id: `${order}-${String(++serial).padStart(8,'0')}-${instanceId}`, order, draft: checked};
      await backend.put(record);
      for (const old of previous.slice(keep - 1)) await backend.delete(old.id);
      return record;
    }),
    loadLatest: () => serialize(async () => (await ordered())[0]?.draft ?? null),
    listBackups: () => serialize(async () => (await ordered()).map(({id,draft}) => ({id,savedAt:draft.savedAt,
      summary:draft.markdown.slice(0,100),imageCount:draft.assets.length}))),
    loadBackup: id => serialize(async () => (await backend.get(id))?.draft ?? null),
    clear: () => serialize(() => backend.clear()),
    close: () => backend.close?.()
  };
}

export async function createDraftStore({indexedDB = globalThis.indexedDB, name = 'xieyuliao-local-drafts'} = {}) {
  if (!indexedDB) throw new Error('当前浏览器不支持本地草稿存储，请使用完整草稿导出。');
  const db = await new Promise((resolve,reject) => {
    const request = indexedDB.open(name,1);
    request.onupgradeneeded = () => request.result.createObjectStore('backups',{keyPath:'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地草稿数据库。'));
    request.onblocked = () => reject(new Error('另一个页面正在占用草稿数据库，请关闭旧页面后刷新。'));
  });
  const transact = (mode, action) => new Promise((resolve,reject) => {
    const tx = db.transaction('backups',mode);
    const request = action(tx.objectStore('backups'));
    let result;
    request.onsuccess = () => {result = request.result;};
    request.onerror = () => reject(request.error || new Error('草稿读写失败。'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('草稿读写失败，可能超出浏览器存储容量。'));
    tx.onabort = () => reject(tx.error || new Error('草稿存储中止，可能超出浏览器存储容量。'));
  });
  return createDraftRepository({
    getAll: () => transact('readonly',store => store.getAll()),
    get: id => transact('readonly',store => store.get(id)),
    put: record => transact('readwrite',store => store.put(record)),
    delete: id => transact('readwrite',store => store.delete(id)),
    clear: () => transact('readwrite',store => store.clear()), close: () => db.close()
  });
}
