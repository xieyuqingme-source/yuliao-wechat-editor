import {normalizePath, buildImageIndex, parseImageReferences, resolveImage, renderArticle, prepareSource} from './core.mjs';
import {copyRichText} from './clipboard.mjs';
import {createDraftStore, makeDraft, validateDraft, saveDraftAfterRender} from './drafts.mjs';
import {COMPONENTS, applyComponent, createEditHistory} from './components.mjs';
import {normalizeHistoryState, searchHistory, toggleHistorySelection,
  moveHistorySelection, removeHistoryItem, syncRelatedFooter, trackRelatedFooterEdit} from './history.mjs';
import {importHistoryDirectory, importManualHistoryFiles, removeHistoryDirectory} from './directories.mjs';
import {getDisplayTitle, suggestDisplayTitle, setDisplayTitle, findDuplicateDisplayTitles} from './recommendation-title.mjs';
import {normalizePresentation, effectiveTypography, DEVICE_WIDTHS} from './layout-settings.mjs';
import {createScrollSync} from './preview-sync.mjs';
import {createPreviewLayout} from './preview-layout.mjs';
import {cleanReferenceWhitespace} from './references.mjs';
import {checkArticle} from './preflight.mjs';
import {MAX_MARKDOWN_BYTES, MAX_IMAGE_BYTES, MAX_INDEX_ENTRIES, utf8ByteLength,
  acceptsSourceChange, createLimitedReader, readAssetBatch} from './input-limits.mjs';

export function insertMarkdownAtSelection(value, start, end, insert) {
  const a = Math.max(0, Math.min(value.length, Number.isFinite(start) ? start : value.length));
  const b = Math.max(a, Math.min(value.length, Number.isFinite(end) ? end : a));
  return {value: value.slice(0,a) + insert + value.slice(b), cursor: a + insert.length};
}

export function pastedImageReference(path) {
  if (!path.startsWith('__pasted__/') || /[\[\]|\r\n]/.test(path)) throw new Error('内部图片路径无效。');
  return `![[${path}|图片]]`;
}

export function pathsForSelectedDirectory(files) {
  return [...files].map(file => {
    const relative = String(file.webkitRelativePath || file.name).replaceAll('\\','/');
    const path = file.webkitRelativePath ? relative.split('/').slice(1).join('/') : relative;
    return {path: normalizePath(path), file, size: file.size, type: file.type};
  }).filter(entry => entry.path);
}

export function entriesFromDraft(draft) {
  return (draft.indexedFiles ?? draft.assets).map(entry => ({path:entry.path,type:entry.type || '',
    restored:true,pasted:entry.path.startsWith('__pasted__/')}));
}

export function replaceDirectoryEntries(current, selected) {
  return [...current.filter(entry => entry.pasted),...selected];
}

export function sniffRasterMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (a,z) => String.fromCharCode(...b.slice(a,z));
  if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n)) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a','GIF89a'].includes(ascii(0,6))) return 'image/gif';
  if (b.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return 'image/webp';
  if (b.length >= 14 && ascii(0,2) === 'BM') return 'image/bmp';
  if (b.length >= 16 && ascii(4,8) === 'ftyp' && ['avif','avis'].includes(ascii(8,12))) return 'image/avif';
  return null;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function wrapArticleHtml(html, title = '谢雨聊文章') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#fff;overflow-wrap:anywhere">${html}</body></html>`;
}

export async function readRaster(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 20 MiB，请缩小后重选。');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('图片实际大小超过 20 MiB，请缩小后重选。');
  const mime = sniffRasterMime(buffer);
  if (!mime) throw new Error('文件字节不是支持的 PNG、JPEG、GIF、WebP、BMP 或 AVIF；不读取 SVG。');
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片无法读取，请重新选择附件目录。'));
    reader.readAsDataURL(new Blob([buffer],{type:mime}));
  });
}

export async function startApp({documentRef = globalThis.document, storeFactory = createDraftStore,
  copy = copyRichText, downloadFile = null, confirmAction = globalThis.confirm,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  markdownFactory = globalThis.markdownit, scrollSyncFactory = createScrollSync,
  previewLayoutFactory = createPreviewLayout, rasterReader = readRaster} = {}) {
  const document = documentRef;
  const setTimeout = setTimer, clearTimeout = clearTimer;
  const confirm = message => confirmAction?.(message) ?? false;
  const $ = id => document.getElementById(id);
  const editor = $('markdown-editor');
  const state = {entries: [], assets: new Map(), readErrors: new Map(), reads: new WeakMap(), index: buildImageIndex([]),
    revision: 0, renderToken: 0, result: null, filename: '', folderMode: 'replace', store: null,
    saveTimer: null, renderTimer: null, noticeTimer: null, autosavePaused: false, saveToken: 0, cancelGeneration: 0,
    relatedArticles: normalizeHistoryState(null, editor.value), historyGeneration: 0, historyBusy: false,
    historyPickerTarget: null, historyPickerGeneration: null,
    historyFilePickerGeneration: null,
    presentation: normalizePresentation(), preflightSource: null,
    documentGeneration: 0, composing: false, renderError: null, failedReads: new WeakMap()};
  const limitedRasterReader = createLimitedReader(rasterReader);
  const snapshot = () => ({value:editor.value,start:editor.selectionStart,end:editor.selectionEnd,
    direction:editor.selectionDirection,meta:{relatedArticles:state.relatedArticles,presentation:state.presentation}});
  const journal = createEditHistory(snapshot());
  const frame = $('preview');
  const scrollSync = scrollSyncFactory({editor,preview:null,enabled:state.presentation.scrollSync});
  let previewDocument = null, previewOwnRatio = 0;
  const capturePreviewPosition = () => {
    const scroller = previewDocument?.scrollingElement;
    const span = Number(scroller?.scrollHeight) - Number(scroller?.clientHeight);
    if (span > 0 && Number.isFinite(Number(scroller?.scrollTop))) previewOwnRatio = Math.max(0,Math.min(1,Number(scroller.scrollTop)/span));
  };
  const restoreOwnPreviewPosition = () => {
    const scroller = previewDocument?.scrollingElement;
    const span = Number(scroller?.scrollHeight) - Number(scroller?.clientHeight);
    if (span > 0) scroller.scrollTop = previewOwnRatio * span;
  };
  const previewLayout = previewLayoutFactory({frame,surround:$('preview-surround'),stage:$('preview-stage'),
    getDevice:() => state.presentation.device,onBeforeLayout:capturePreviewPosition,
    onLayout:layout => {
      $('preview-stage').dataset.fitted = 'true';
      $('preview-fit-state').textContent = layout.ready
        ? `${layout.deviceWidth} px 阅读宽度 · ${Math.round(layout.scale * 100)}% 显示`
        : '预览会按右栏可用宽度完整显示';
      if (state.presentation.scrollSync) scrollSync.refresh({preserveRatio:true});
      else restoreOwnPreviewPosition();
    }});
  const reflectPresentation = () => {
    capturePreviewPosition();
    const settings = state.presentation;
    for (const [id,value,suffix] of [['article-font-size',settings.fontSize,' px'],['article-line-height',settings.lineHeight,' 倍']]) {
      const input = $(id);
      if (value !== null && input.options && !Array.from(input.options).some(option => option.value === String(value))) {
        const option = document.createElement('option');option.value = String(value);option.textContent = `${value}${suffix}`;input.append(option);
      }
    }
    $('article-font-size').value = settings.fontSize === null ? '' : String(settings.fontSize);
    $('article-line-height').value = settings.lineHeight === null ? '' : String(settings.lineHeight);
    $('article-accent-color').value = effectiveTypography($('theme-select').value,settings).accentColor;
    $('preview-device').value = settings.device;$('preview-scroll-sync').checked = settings.scrollSync;
    // A real DOM receives viewport geometry atomically from previewLayout; avoid
    // resetting its height/transform between capturing and restoring progress.
    if (!frame.style) frame.setAttribute('style',`width:${DEVICE_WIDTHS[settings.device]}px;max-width:none;flex:none`);
    frame.dataset.device = settings.device;
    scrollSync.setEnabled(settings.scrollSync);
    previewLayout.refresh({force:true});
    if (settings.scrollSync) scrollSync.refresh({preserveRatio:true});else restoreOwnPreviewPosition();
  };
  let removePreviewListeners = () => {};
  frame.addEventListener('load',() => {
    removePreviewListeners();
    let previewWindow = null;
    try {previewDocument = frame.contentDocument || null;previewWindow = frame.contentWindow || null;} catch {previewDocument = null;}
    scrollSync.rebindPreview(previewDocument?.scrollingElement || null,
      {eventTarget:previewDocument,resizeTarget:previewWindow});
    const documentForEvents = previewDocument;
    const onPreviewScroll = () => {if (!state.presentation.scrollSync) capturePreviewPosition();};
    const onPreviewReflow = () => {
      if (state.presentation.scrollSync) scrollSync.refresh({preserveRatio:true});
      else restoreOwnPreviewPosition();
      previewLayout.refresh();
    };
    documentForEvents?.addEventListener?.('scroll',onPreviewScroll,{passive:true});
    documentForEvents?.addEventListener?.('load',onPreviewReflow,true);
    removePreviewListeners = () => {
      documentForEvents?.removeEventListener?.('scroll',onPreviewScroll);
      documentForEvents?.removeEventListener?.('load',onPreviewReflow,true);
    };
    previewLayout.refresh();
    if (!state.presentation.scrollSync) restoreOwnPreviewPosition();
  });
  let pendingInput = null;
  const updateUndoButtons = () => {
    $('undo-edit').disabled = !journal.canUndo;
    $('redo-edit').disabled = !journal.canRedo;
  };
  const resetJournal = () => {pendingInput = null;journal.reset(snapshot());updateUndoButtons();};
  const invalidateHistoryImport = () => {
    state.historyGeneration++;state.historyBusy = false;
    $('history-folder-input').value = '';
    $('cancel-history-import').hidden = true;
    $('history-import-state').textContent = '';
  };
  const notice = (message, error = false) => {
    clearTimeout(state.noticeTimer);
    $('notice').textContent = message;
    $('notice').dataset.error = String(error);
    $('notice').hidden = false;
    state.noticeTimer = setTimeout(() => {$('notice').hidden = true;}, error ? 15000 : 7000);
  };
  const markChanged = () => {
    state.revision++;
    state.autosavePaused = false;
    $('save-state').textContent = '有更新，准备保存…';
    if (state.preflightSource !== null) $('preflight-state').textContent = '排版已变化，请重新检查。';
    clearTimeout(state.renderTimer);
    clearTimeout(state.saveTimer);
    state.renderTimer = setTimeout(() => void updatePreview(),100);
    state.saveTimer = setTimeout(() => void saveCurrent(),1100);
  };
  const commitEditor = (next, {kind = 'edit', relatedArticles = null, before = snapshot(), focus = true} = {}) => {
    const source = String(next.value ?? editor.value);
    if (!acceptsSourceChange(editor.value,source)) {
      renderHistory();notice('正文新增输入超过 5 MiB（UTF-8），本次操作未应用；原正文和选区保留。较大旧草稿可删减或原样导出。',true);return false;
    }
    state.relatedArticles = relatedArticles ?? {...state.relatedArticles,
      footer:trackRelatedFooterEdit(editor.value,source,state.relatedArticles.footer)};
    editor.value = source;
    editor.setSelectionRange(next.start ?? editor.selectionStart,next.end ?? next.start ?? editor.selectionEnd,next.direction || 'none');
    if (focus) editor.focus();
    journal.record(before,snapshot(),{kind});pendingInput = null;
    updateUndoButtons();renderHistory();markChanged();return true;
  };
  const restoreJournal = direction => {
    if (state.composing) return;
    const previous = snapshot();
    const next = direction === 'redo' ? journal.redo(previous) : journal.undo(previous);
    if (!next) {updateUndoButtons();return;}
    invalidateHistoryImport();
    editor.value = next.value;
    editor.setSelectionRange(next.start,next.end,next.direction);editor.focus();
    state.relatedArticles = normalizeHistoryState(next.meta?.relatedArticles ?? state.relatedArticles,editor.value);
    state.presentation = normalizePresentation(next.meta?.presentation ?? state.presentation);reflectPresentation();
    pendingInput = null;updateUndoButtons();renderHistory();markChanged();
  };
  const selectedItems = () => {
    const byId = new Map(state.relatedArticles.items.map(item => [item.id,item]));
    return state.relatedArticles.selectedIds.map(id => byId.get(id)).filter(Boolean);
  };
  const updateRelated = next => {
    if (state.historyBusy) {
      invalidateHistoryImport();
      $('history-import-state').textContent = '当前选文已更新，未完成的目录导入已取消。';
    }
    const before = snapshot();
    const byId = new Map(next.items.map(item => [item.id,item]));
    const selected = next.selectedIds.map(id => byId.get(id)).filter(Boolean);
    const result = syncRelatedFooter(editor.value,selected,next.footer);
    commitEditor({value:result.source,start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection},
      {before,relatedArticles:{...next,footer:result.footer},kind:'related',focus:false});
    if (result.conflict) notice('相关文章列表已手动删除或大幅改动，自动同步已暂停。请先整理正文中的旧列表，再清空选择并重新选文。',true);
  };
  const rowButton = (label, title, action, disabled = false) => {
    const button = document.createElement('button');button.type = 'button';button.textContent = label;
    button.title = title;button.setAttribute('aria-label',title);button.disabled = disabled;
    button.addEventListener('click',action);return button;
  };
  const requestHistoryDirectory = (sourceId = null) => {
    invalidateHistoryImport();
    state.historyPickerTarget = sourceId;state.historyPickerGeneration = state.historyGeneration;
    $('history-folder-input').click();
  };
  const historyItemSource = item => {
    const names = (state.relatedArticles.sources || []).flatMap(source => source.entries
      .filter(entry => entry.articleId === item.id).map(entry => `${source.label} / ${entry.path}`));
    if ((state.relatedArticles.manualIds || []).includes(item.id)) names.push(`单独文件 · ${item.name}`);
    return names.length ? [...new Set(names)].join('；') : `${item.name} · 旧版来源未知`;
  };
  function renderHistorySources() {
    const sources = state.relatedArticles.sources || [];
    const list = $('history-sources');list.replaceChildren();
    for (const source of sources) {
      const row = document.createElement('li');row.dataset.sourceId = source.id;
      const text = document.createElement('span');text.className = 'history-source-name';
      const count = new Set(source.entries.map(entry => entry.articleId)).size;
      text.textContent = `${source.label} · ${count} 篇`;
      const actions = document.createElement('div');actions.className = 'history-source-actions';
      actions.append(rowButton('重新选择更新',`重新选择目录更新：${source.label}`,() => requestHistoryDirectory(source.id)),
        rowButton('移除此来源',`移除本地目录索引：${source.label}`,() => {
          if (!confirm(`移除“${source.label}”的本地来源索引？仅从此来源导入的文章和推荐选择会移除，其他来源保留，原目录与文件不会改动。`)) return;
          invalidateHistoryImport();updateRelated(removeHistoryDirectory(state.relatedArticles,source.id));
          notice('已移除本地来源索引；原目录与文件未改动。');
        }));
      row.append(text,actions);list.append(row);
    }
    $('history-sources-panel').hidden = sources.length === 0;
    const known = new Set([...(state.relatedArticles.manualIds || []),...sources.flatMap(source => source.entries.map(entry => entry.articleId))]);
    const unknown = state.relatedArticles.items.filter(item => !known.has(item.id)).length;
    $('history-legacy-state').hidden = unknown === 0;
    $('history-legacy-state').textContent = `有 ${unknown} 篇旧版导入文章尚未绑定目录。重新选择“往期文章”和“文章”可按内容匹配绑定；其余旧条目可手动删除，工具不会猜测原路径。`;
  }
  function renderHistory() {
    const {items,selectedIds,footer} = state.relatedArticles;
    const visible = searchHistory(items,$('history-search').value);
    renderHistorySources();
    const duplicateTitles = findDuplicateDisplayTitles(items);
    $('history-duplicate-state').hidden = duplicateTitles.length === 0;
    $('history-duplicate-state').textContent = duplicateTitles.length
      ? `有 ${duplicateTitles.length} 组显示标题相同，已保留各篇文章。请按本地来源辨认，必要时修改显示标题。` : '';
    $('history-summary').textContent = `已导入 ${items.length} 篇 · 已选 ${selectedIds.length} 篇`;
    const list = $('history-articles');list.replaceChildren();
    for (const item of visible) {
      const row = document.createElement('li');row.dataset.articleId = item.id;row.dataset.selected = String(selectedIds.includes(item.id));
      const label = document.createElement('label');label.className = 'history-article-label';
      const checkbox = document.createElement('input');checkbox.type = 'checkbox';checkbox.checked = selectedIds.includes(item.id);
      checkbox.setAttribute('aria-label',`推荐：${getDisplayTitle(item)}`);
      checkbox.addEventListener('change',() => updateRelated(toggleHistorySelection(state.relatedArticles,item.id,checkbox.checked)));
      const text = document.createElement('span');text.className = 'history-article-text';
      const title = document.createElement('strong');title.textContent = getDisplayTitle(item);
      const name = document.createElement('small');name.textContent = historyItemSource(item);text.append(title,name);label.append(checkbox,text);
      const remove = rowButton('×',`从本地文章库删除：${item.title}`,() => {
        invalidateHistoryImport();updateRelated(removeHistoryItem(state.relatedArticles,item.id));
      });remove.className = 'article-remove';row.append(label,remove);list.append(row);
      const details = document.createElement('details');details.className = 'history-title-editor';
      const summary = document.createElement('summary');summary.textContent = '编辑显示标题';details.append(summary);
      const titleLabel = document.createElement('label');titleLabel.className = 'display-title-label';
      titleLabel.textContent = '显示标题';
      const input = document.createElement('input');input.type = 'text';input.maxLength = 500;
      input.value = getDisplayTitle(item);input.setAttribute('aria-label',`显示标题：${item.title}`);
      const applyTitle = value => updateRelated({...state.relatedArticles,items:state.relatedArticles.items.map(current =>
        current.id === item.id ? setDisplayTitle(current,value) : current)});
      input.addEventListener('change',() => applyTitle(input.value));
      input.addEventListener('keydown',event => {if (event.key === 'Enter') {event.preventDefault();applyTitle(input.value);}});
      titleLabel.append(input);details.append(titleLabel);
      const original = document.createElement('p');original.className = 'help';
      original.textContent = `原标题：${item.title}。这里只调整推荐列表，原文件与原标题保留；清空或恢复可重新使用原标题。`;
      details.append(original);
      const titleActions = document.createElement('div');titleActions.className = 'display-title-actions';
      if (item.displayTitle) titleActions.append(rowButton('恢复原标题',`恢复原标题：${item.title}`,() => applyTitle('')));
      const suggestion = suggestDisplayTitle(item);
      if (suggestion && suggestion !== getDisplayTitle(item)) {
        const help = document.createElement('span');help.className = 'muted';help.textContent = `文件名日期前缀建议：${suggestion}`;
        titleActions.append(help,rowButton('采用建议',`采用显示标题建议：${suggestion}`,() => applyTitle(suggestion)));
      }
      details.append(titleActions);row.append(details);
    }
    $('history-empty').hidden = visible.length > 0;
    $('history-empty').textContent = items.length ? '没有匹配的文章，请调整搜索。' : '主动选择历史文章目录后，在这里勾选推荐文章。';
    const selectedList = $('history-selected');selectedList.replaceChildren();
    const chosen = selectedItems();
    chosen.forEach((item,index) => {
      const row = document.createElement('li');row.dataset.articleId = item.id;
      const title = document.createElement('span');title.textContent = getDisplayTitle(item);title.className = 'selected-title';
      const actions = document.createElement('div');actions.className = 'selected-actions';
      actions.append(rowButton('上移',`上移：${item.title}`,() => updateRelated(moveHistorySelection(state.relatedArticles,item.id,-1)),index === 0),
        rowButton('下移',`下移：${item.title}`,() => updateRelated(moveHistorySelection(state.relatedArticles,item.id,1)),index === chosen.length - 1),
        rowButton('取消',`取消推荐：${item.title}`,() => updateRelated(toggleHistorySelection(state.relatedArticles,item.id,false))));
      row.append(title,actions);selectedList.append(row);
    });
    $('clear-history-selection').disabled = !selectedIds.length && !footer;
    $('history-footer-state').dataset.error = String(Boolean(footer?.detached));
    $('history-footer-state').textContent = footer?.detached
      ? '列表已手动删除或大幅改动，自动同步暂停。请先整理正文中的旧列表，再清空选择并重新选文。'
      : chosen.length ? '已在正文中生成可编辑列表。再次调整选文会更新已生成列表；未加超链接。'
        : '勾选后会在正文末尾生成“相关文章推荐：”及标题列表。';
  }
  async function importHistory(files,directory = false,sourceId = null) {
    if (!files.length) return;
    const generation = ++state.historyGeneration;
    state.historyBusy = true;$('cancel-history-import').hidden = false;
    $('history-import-state').textContent = '正在读取所选历史文章…';
    $('history-issues').replaceChildren();$('history-issues').hidden = true;
    try {
      const options = {state:state.relatedArticles,sourceId,isCancelled:() => generation !== state.historyGeneration};
      const result = directory ? await importHistoryDirectory(files,options) : await importManualHistoryFiles(files,options);
      if (result.cancelled || generation !== state.historyGeneration) return;
      state.historyBusy = false;
      if (result.committed) updateRelated({...result.state,footer:state.relatedArticles.footer});
      for (const issue of result.issues) {
        const row = document.createElement('li');row.textContent = `${issue.name ? `${issue.name}：` : ''}${issue.message}`;
        $('history-issues').append(row);
      }
      $('history-issues').hidden = result.issues.length === 0;
      $('history-import-state').textContent = result.committed
        ? `新增 ${result.added} 篇 · 更新 ${result.updated || 0} 篇 · 移除 ${result.removed || 0} 篇 · 跳过 ${result.skipped} 个文件`
        : '目录未更新，原文章库和选择保留；请查看下方提示。';
      if (result.committed) notice(`历史文章导入完成：新增 ${result.added} 篇。只保留标题与本地来源索引，原文件未改动。`);
      else notice('目录未更新，原文章库保留。请查看相关文章推荐下方的提示。',true);
    } catch(error) {
      if (generation === state.historyGeneration) {notice(`历史文章导入失败：${error.message}`,true);$('history-import-state').textContent = '导入未完成，原文章库保留。';}
    } finally {
      if (generation === state.historyGeneration) {state.historyBusy = false;$('cancel-history-import').hidden = true;}
    }
  }
  const updateFileSummary = () => {
    const images = state.entries.filter(e => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(e.path)).length;
    $('file-summary').textContent = `${state.filename || '尚未导入文章'} · ${images} 个图片索引 · ${state.assets.size} 张已读取`;
  };
  const rebuildIndex = () => {state.index = buildImageIndex(state.entries); updateFileSummary();};
  const draftSnapshot = () => makeDraft({markdown:editor.value,theme:$('theme-select').value,
    articlePath:$('article-path').value,stripFrontmatter:$('strip-frontmatter').checked,assets:state.assets,
    entries:state.index.all,relatedArticles:state.relatedArticles,presentation:state.presentation});
  const updateBackups = async () => {
    if (!state.store) return;
    const selected = $('backup-select').value;
    const records = await state.store.listBackups();
    const option = (label,value) => {const item = document.createElement('option');item.textContent = label;item.value = value;return item;};
    $('backup-select').replaceChildren(option('选择备份…',''));
    for (const record of records) {
      const date = new Date(record.savedAt).toLocaleString('zh-CN');
      $('backup-select').append(option(`${date} · ${record.imageCount} 张图片`,record.id));
    }
    if (records.some(r => r.id === selected)) $('backup-select').value = selected;
  };
  const saveCurrent = async ({force = false} = {}) => {
    if (state.autosavePaused && !force) return;
    if (!state.store) return;
    if (!editor.value && state.assets.size === 0 && !state.relatedArticles.items.length && !state.relatedArticles.sources?.length && !force) return;
    const token = ++state.saveToken;
    const generation = state.cancelGeneration;
    try {
      let revision;
      const record = await saveDraftAfterRender({render:updatePreview,store:state.store,
        snapshot:() => {revision = state.revision;return draftSnapshot();},
        isCancelled:() => generation !== state.cancelGeneration || (state.autosavePaused && !force)});
      if (!record) return;
      if (token === state.saveToken && revision === state.revision) {
        $('save-state').textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
      }
      await updateBackups();
    } catch (error) {
      $('save-state').textContent = '保存失败，请导出完整草稿';
      notice(`自动草稿未保存：${error.message}。可用“导出完整草稿”另存。`,true);
    }
  };
  const addIssue = (list, message) => {
    const item = document.createElement('li');item.textContent = message;list.append(item);
  };
  async function updatePreview() {
    const token = ++state.renderToken;
    const revision = state.revision;
    const source = editor.value;
    state.renderError = null;
    const articlePath = $('article-path').value;
    const index = state.index;
    const targets = new Map();
    const cancelled = () => token !== state.renderToken || revision !== state.revision;
    try {
      if (utf8ByteLength(source) > MAX_MARKDOWN_BYTES) throw new Error('正文超过 5 MiB（UTF-8），暂不排版。原草稿仍保留，可删减正文或原样导出本地草稿。');
      const prepared = prepareSource(source,{stripFrontmatter:$('strip-frontmatter').checked});
      for (const ref of parseImageReferences(prepared.source)) {
        const match = resolveImage(ref,{index,articlePath});
        if (match.status === 'matched' && !state.assets.has(match.path) && match.file) targets.set(match.path,match.file);
      }
      const batch = await readAssetBatch(targets,{existingAssets:state.assets,isCancelled:cancelled,read:file => {
        if (state.failedReads.has(file)) return Promise.reject(new Error(state.failedReads.get(file)));
        let reading = state.reads.get(file);
        if (!reading) {reading = limitedRasterReader(file);state.reads.set(file,reading);}
        return reading;
      }});
      if (batch.cancelled || cancelled()) return null;
      for (const [path,file] of targets) {
        state.reads.delete(file);
        if (batch.errors.has(path)) state.failedReads.set(file,batch.errors.get(path));
      }
      const assets = new Map([...state.assets,...batch.staged]);
      const result = renderArticle(source,{theme:$('theme-select').value,stripFrontmatter:$('strip-frontmatter').checked,
        index,articlePath,assetData:assets,markdownFactory,relatedFooter:state.relatedArticles.footer,presentation:state.presentation});
      if (cancelled()) return null;
      for (const [path,dataURL] of batch.staged) state.assets.set(path,dataURL);
      state.readErrors = batch.errors;state.renderError = null;state.result = result;
      const nextPreview = wrapArticleHtml(result.html);
      if (frame.srcdoc !== nextPreview) {capturePreviewPosition();frame.srcdoc = nextPreview;}
      $('word-count').textContent = `${source.replace(/\s/g,'').length.toLocaleString('zh-CN')} 字符`;
      const list = $('issues-list');list.replaceChildren();
      for (const issue of result.issues ?? []) {
        const target = issue.ref?.target || issue.target || issue.path || '';
        const candidates = issue.candidates?.length ? ` 候选：${issue.candidates.join('；')}` : '';
        addIssue(list,`${target ? `“${target}”：` : ''}${issue.message || '图片未匹配。'}${candidates} 请重新选择目录或明确修改图片引用。`);
      }
      for (const [path,message] of state.readErrors) addIssue(list,`“${path}”：${message}`);
      const duplicates = state.index.duplicatePaths;
      if (duplicates?.size) addIssue(list,`所选文件中有 ${duplicates.size} 个重复完整路径。工具不会任选图片；请替换目录，或选择不冲突的目录并改成明确引用。`);
      $('issues-panel').hidden = list.childElementCount === 0;
      updateFileSummary();
      return result;
    } catch(error) {
      if (!cancelled()) {
        state.result = null;state.renderError = error;
        notice(`排版失败：${error.message}`,true);
      }
      return null;
    }
  }
  async function ensureRendered() {
    const revision = state.revision;
    const result = await updatePreview();if (result) return result;
    if (state.renderError) throw state.renderError;
    if (revision !== state.revision) {const current = await updatePreview();if (current) return current;}
    if (state.renderError) throw state.renderError;
    throw new Error('正文正在变化，请稍候再操作。');
  }
  const applyDraft = draft => {
    state.documentGeneration++;invalidateHistoryImport();
    editor.value = draft.markdown;
    $('theme-select').value = draft.theme;
    $('article-path').value = draft.articlePath;
    $('strip-frontmatter').checked = draft.stripFrontmatter;
    state.assets = new Map(draft.assets.map(a => [a.path,a.dataURL]));
    state.entries = entriesFromDraft(draft);
    state.relatedArticles = normalizeHistoryState(draft.relatedArticles,draft.markdown);
    state.presentation = normalizePresentation(draft.presentation);reflectPresentation();
    state.readErrors.clear();state.reads = new WeakMap();state.failedReads = new WeakMap();state.filename = '本地草稿';
    rebuildIndex();renderHistory();resetJournal();markChanged();
  };
  const confirmReplace = async message => {
    if (!editor.value && state.assets.size === 0 && !state.relatedArticles.items.length) return true;
    if (!confirm(message)) return false;
    await saveCurrent({force:true});
    return true;
  };
  const download = (content,type,filename) => {
    if (downloadFile) return downloadFile(content,type,filename);
    const url = URL.createObjectURL(new Blob([content],{type}));
    const link = document.createElement('a');link.href = url;link.download = filename;link.click();
    setTimeout(() => URL.revokeObjectURL(url),30000);
  };
  const exportName = suffix => {
    const name = (state.filename || '谢雨聊文章').replace(/\.(md|markdown|json)$/i,'').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');
    return `${name}${suffix}`;
  };
  async function importMarkdown(file) {
    if (!file || !/\.(md|markdown)$/i.test(file.name)) {notice('请选择 .md 或 .markdown 文件。',true);return false;}
    if (file.size > MAX_MARKDOWN_BYTES) {notice('Markdown 超过 5 MB，请拆分后导入。',true);return false;}
    const generation = ++state.documentGeneration;invalidateHistoryImport();
    let text;
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > MAX_MARKDOWN_BYTES) {notice('Markdown 实际大小超过 5 MiB，原正文保留。',true);return false;}
      text = new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
      if (generation !== state.documentGeneration) return false;}
    catch {notice('文件不是有效的 UTF-8 文本，请在编辑器中另存为 UTF-8 后重试。',true);return false;}
    if (!await confirmReplace('导入文章会替换当前编辑内容；会先尝试保存当前草稿。继续吗？')) return false;
    if (generation !== state.documentGeneration) return false;
    editor.value = text;state.filename = file.name;
    $('article-path').value = file.webkitRelativePath ? pathsForSelectedDirectory([file])[0]?.path || file.name : file.name;
    state.entries = state.entries.filter(e => !e.pasted && !e.restored);
    state.relatedArticles = normalizeHistoryState({...state.relatedArticles,selectedIds:[],footer:null},text);
    state.assets.clear();state.readErrors.clear();rebuildIndex();renderHistory();resetJournal();markChanged();
    notice('已读取文章副本，原文件未改动。若图片含相对路径，请填写文章在所选目录中的路径。');
    notice('已读取新文章副本，原文件未改动。新稿的推荐选择已重置，历史文章库保留。跨目录图片请填写文章相对路径。');
    return true;
  }
  async function selectDirectory(files,mode) {
    if (!files.length) return;
    const selected = pathsForSelectedDirectory(files);
    const nextEntries = mode === 'replace' ? replaceDirectoryEntries(state.entries,selected) : [...state.entries,...selected];
    if (nextEntries.length > MAX_INDEX_ENTRIES) {notice('文件索引最多保留 10 万项，本次目录未应用，原目录和图片保留。',true);return;}
    if (mode === 'replace') {
      for (const path of state.assets.keys()) if (!path.startsWith('__pasted__/')) state.assets.delete(path);
      state.readErrors.clear();state.reads = new WeakMap();state.failedReads = new WeakMap();
    }
    state.entries = nextEntries;
    rebuildIndex();markChanged();
    const roots = [...new Set([...files].map(f => f.webkitRelativePath?.split('/')[0]).filter(Boolean))];
    const matchingNotes = state.entries.filter(e => e.path.split('/').at(-1) === state.filename);
    const hint = matchingNotes.length === 1 && matchingNotes[0].path !== $('article-path').value
      ? ` 文章路径可填写“${matchingNotes[0].path}”；请核对后手动设置。` : '';
    notice(`已${mode === 'replace' ? '替换' : '追加'}目录${roots.length ? `“${roots.join('、')}”` : ''}，路径以所选目录为根。${hint}`);
  }
  const insertText = text => {
    const inserted = insertMarkdownAtSelection(editor.value,editor.selectionStart,editor.selectionEnd,text);
    return commitEditor({value:inserted.value,start:inserted.cursor,end:inserted.cursor},{kind:'insert'});
  };
  const addActualImages = (files,{insert = false,text = ''} = {}) => {
    if (state.entries.length + files.length > MAX_INDEX_ENTRIES) {notice('文件索引最多保留 10 万项，本批图片未添加。',true);return false;}
    const refs = [],newEntries = [];
    for (const file of files) {
      if (insert) {
        const safeName = file.name?.replace(/[^\p{L}\p{N}._-]/gu,'_') || 'image.png';
        const path = `__pasted__/${crypto.randomUUID()}-${safeName}`;
        newEntries.push({path,file,pasted:true});refs.push(pastedImageReference(path));
      } else newEntries.push({path:normalizePath(file.name),file,size:file.size,type:file.type});
    }
    const insertion = insert && refs.length ? insertMarkdownAtSelection(editor.value,editor.selectionStart,editor.selectionEnd,
      `${text}\n${refs.join('\n')}\n`) : null;
    if (insertion && !acceptsSourceChange(editor.value,insertion.value)) {notice('粘贴或插入后的正文超过 5 MiB（UTF-8），本批文字和图片未添加，原正文和选区保留。',true);return false;}
    state.entries = [...state.entries,...newEntries];
    rebuildIndex();
    if (insertion) commitEditor({value:insertion.value,start:insertion.cursor,end:insertion.cursor},{kind:'insert'});else markChanged();
    notice(insert ? `已插入 ${files.length} 张图片，正在读取本地内容。` : '已添加图片文件；重复名称会提示冲突。图片仍按正文引用的位置显示。');
  };
  for (const item of COMPONENTS) {
    const button = rowButton(item.label,item.description,() => {
      if (state.composing) {notice('请先完成当前输入，再插入排版组件。');return;}
      commitEditor(applyComponent(snapshot(),item.id),{kind:`component:${item.id}`});
    });
    button.id = `component-${item.id}`;button.dataset.component = item.id;
    button.addEventListener('mousedown',event => event.preventDefault());
    $('component-tools').append(button);
  }
  $('undo-edit').addEventListener('click',() => restoreJournal('undo'));
  $('redo-edit').addEventListener('click',() => restoreJournal('redo'));
  $('clean-reference-whitespace').addEventListener('click',() => {
    if (state.composing) {notice('请先完成当前输入，再清理参考资料。');return;}
    const cleaned = cleanReferenceWhitespace(editor.value,{selectionStart:editor.selectionStart,
      selectionEnd:editor.selectionEnd,markdownFactory});
    if (!cleaned.changed) {
      notice(cleaned.sections.length ? '参考资料区没有可安全清理的多余行首空白。'
        : '未识别到参考资料区。请使用“参考资料 / References”等标题或粗体标题。');return;
    }
    commitEditor({value:cleaned.source,start:cleaned.selectionStart,end:cleaned.selectionEnd,
      direction:editor.selectionDirection},{kind:'reference-whitespace'});
    notice(`已局部清理参考资料 ${cleaned.changedLines} 行的多余行首空白，可撤销。正文词间空格、链接与必要缩进保留。`);
  });
  editor.addEventListener('compositionstart',() => {state.composing = true;});
  editor.addEventListener('compositionend',() => {state.composing = false;});
  editor.addEventListener('beforeinput',event => {
    if (!state.composing && !event.isComposing && ['historyUndo','historyRedo'].includes(event.inputType)) {
      event.preventDefault();restoreJournal(event.inputType === 'historyRedo' ? 'redo' : 'undo');return;
    }
    pendingInput = snapshot();
    if (typeof event.data === 'string' && String(event.inputType || '').startsWith('insert')) {
      const next = insertMarkdownAtSelection(editor.value,editor.selectionStart,editor.selectionEnd,event.data);
      if (!acceptsSourceChange(editor.value,next.value)) {
        event.preventDefault();pendingInput = null;
        notice('新增输入超过 5 MiB（UTF-8），原正文和选区保留。',true);
      }
    }
  });
  editor.addEventListener('input',() => {
    const before = pendingInput || journal.current;
    if (!acceptsSourceChange(before.value,editor.value)) {
      editor.value = before.value;editor.setSelectionRange(before.start,before.end,before.direction);
      pendingInput = null;notice('新增输入超过 5 MiB（UTF-8），本次输入未应用；原正文和选区保留。',true);return;
    }
    state.relatedArticles = {...state.relatedArticles,
      footer:trackRelatedFooterEdit(before.value,editor.value,state.relatedArticles.footer)};
    journal.record(before,snapshot(),{kind:'typing'});pendingInput = null;
    updateUndoButtons();renderHistory();markChanged();
  });
  editor.addEventListener('keydown',event => {
    if (state.composing || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = String(event.key).toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();restoreJournal(key === 'y' || event.shiftKey ? 'redo' : 'undo');
  });
  $('import-history-files').addEventListener('click',() => {
    invalidateHistoryImport();state.historyFilePickerGeneration = state.historyGeneration;
    $('history-files-input').value = '';$('history-files-input').click();
  });
  $('import-history-folder').addEventListener('click',() => requestHistoryDirectory());
  $('append-history-folder').addEventListener('click',() => requestHistoryDirectory());
  $('history-files-input').addEventListener('change',async event => {
    const files = [...event.target.files];event.target.value = '';
    const generation = state.historyFilePickerGeneration;state.historyFilePickerGeneration = null;
    if (generation !== null && generation !== state.historyGeneration) return;
    if (files.length) await importHistory(files);
  });
  $('history-files-input').addEventListener('cancel',() => {state.historyFilePickerGeneration = null;$('history-files-input').value = '';});
  $('history-folder-input').addEventListener('change',async event => {
    const files = [...event.target.files];event.target.value = '';
    const target = state.historyPickerTarget,pickerGeneration = state.historyPickerGeneration;
    state.historyPickerTarget = null;state.historyPickerGeneration = null;
    if (pickerGeneration !== null && pickerGeneration !== state.historyGeneration) return;
    if (files.length) await importHistory(files,true,target);
    else $('history-import-state').textContent = '未选择目录，原文章库与选择保留。空目录不能自动清空索引，可使用“移除此来源”。';
  });
  $('history-folder-input').addEventListener('cancel',() => {
    state.historyPickerTarget = null;state.historyPickerGeneration = null;$('history-folder-input').value = '';
    $('history-import-state').textContent = '已取消目录选择，原文章库与选择保留。';
  });
  $('cancel-history-import').addEventListener('click',() => {
    invalidateHistoryImport();$('history-import-state').textContent = '已取消本次导入，文章库保留。';
  });
  $('history-search').addEventListener('input',renderHistory);
  $('clear-history-selection').addEventListener('click',() => {
    if (state.relatedArticles.footer?.detached) {
      if (!confirm('列表已手动删除或大幅改动。清空选择将保留正文并解除列表管理；重新勾选前，请先手动删除正文中的旧推荐列表。继续？')) return;
      const before = snapshot();
      state.relatedArticles = {...state.relatedArticles,selectedIds:[],footer:null};
      journal.record(before,snapshot(),{kind:'related-reset'});updateUndoButtons();renderHistory();markChanged();
      notice('已清空选文并解除管理，正文保留。请先删除旧推荐列表，再重新勾选。');return;
    }
    updateRelated({...state.relatedArticles,selectedIds:[]});
  });
  editor.addEventListener('paste',event => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!files.length) {
      if (text) {event.preventDefault();insertText(text);}
      return;
    }
    event.preventDefault();addActualImages(files,{insert:true,text});
  });
  const updatePresentation = next => {
    const before = snapshot();state.presentation = normalizePresentation(next);reflectPresentation();
    journal.record(before,snapshot(),{kind:'presentation'});pendingInput = null;updateUndoButtons();markChanged();
  };
  $('article-font-size').addEventListener('change',() => updatePresentation({...state.presentation,
    fontSize:$('article-font-size').value === '' ? null : Number($('article-font-size').value)}));
  $('article-line-height').addEventListener('change',() => updatePresentation({...state.presentation,
    lineHeight:$('article-line-height').value === '' ? null : Number($('article-line-height').value)}));
  $('article-accent-color').addEventListener('change',() => updatePresentation({...state.presentation,accentColor:$('article-accent-color').value}));
  $('preview-device').addEventListener('change',() => updatePresentation({...state.presentation,device:$('preview-device').value}));
  $('preview-scroll-sync').addEventListener('change',() => updatePresentation({...state.presentation,scrollSync:$('preview-scroll-sync').checked}));
  $('reset-presentation').addEventListener('click',() => updatePresentation({...state.presentation,fontSize:null,lineHeight:null,accentColor:null}));
  $('theme-select').addEventListener('input',() => {reflectPresentation();markChanged();});
  for (const id of ['article-path','strip-frontmatter']) $(id).addEventListener('input',markChanged);
  $('import-md').addEventListener('click',() => $('md-input').click());
  $('replace-folder').addEventListener('click',() => {state.folderMode = 'replace';$('folder-input').click();});
  $('append-folder').addEventListener('click',() => {state.folderMode = 'append';$('folder-input').click();});
  $('add-images').addEventListener('click',() => $('image-input').click());
  $('md-input').addEventListener('change',async event => {
    const file = event.target.files[0];event.target.value = '';if (file) await importMarkdown(file);
  });
  $('folder-input').addEventListener('change',async event => {
    const files = [...event.target.files];event.target.value = '';await selectDirectory(files,state.folderMode);
  });
  $('image-input').addEventListener('change',event => {
    const files = [...event.target.files];event.target.value = '';if (files.length) addActualImages(files);
  });
  const dropZone = $('drop-zone');
  dropZone.addEventListener('dragover',event => {event.preventDefault();dropZone.classList.add('drag-over');});
  dropZone.addEventListener('dragleave',event => {if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('drag-over');});
  dropZone.addEventListener('drop',async event => {
    event.preventDefault();dropZone.classList.remove('drag-over');
    const files = [...event.dataTransfer.files];
    const notes = files.filter(f => /\.(md|markdown)$/i.test(f.name));
    if (notes.length > 1) {notice('一次只导入一篇 Markdown，避免覆盖错文章。',true);return;}
    if (notes.length && !await importMarkdown(notes[0])) return;
    const images = files.filter(f => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
    if (images.length) addActualImages(images,{insert:notes.length === 0});
    if (!notes.length && !images.length) notice('请拖入 .md 或受支持图片。选择整个附件目录请使用上方按钮。',true);
  });
  const withButton = (id, action) => $(id).addEventListener('click',async () => {
    $(id).disabled = true;
    try {await action();}catch(error){notice(error.message,true);}finally{$(id).disabled = false;}
  });
  async function runPreflight() {
    const rendered = await ensureRendered(),inspectedSource = editor.value;
    const issues = checkArticle({source:inspectedSource,rendered,relatedArticles:selectedItems(),
      stripFrontmatter:$('strip-frontmatter').checked,relatedFooter:state.relatedArticles.footer,markdownFactory});
    state.preflightSource = inspectedSource;
    $('preflight-panel').hidden = false;$('preflight-results').replaceChildren();
    $('preflight-summary').textContent = issues.length ? `发现 ${issues.length} 条排版提示，请按需要处理。` : '本次没有发现这些排版问题；公众号后台与真实设备效果仍需自行检查。';
    $('preflight-state').textContent = issues.length ? `${issues.length} 条提示` : '本次未发现排版提示';
    for (const issue of issues) {
      const row = document.createElement('li');row.dataset.checkType = issue.type;
      const hasRange = Number.isSafeInteger(issue.start) && Number.isSafeInteger(issue.end) && issue.start >= 0 && issue.end >= issue.start && issue.end <= inspectedSource.length;
      const articleId = issue.articleIds?.find(id => state.relatedArticles.items.some(item => item.id === id));
      const button = rowButton(issue.message,hasRange ? `定位正文：${issue.message}` : articleId ? `定位推荐文章：${issue.message}` : issue.message,async () => {
        if (editor.value !== inspectedSource || $('preflight-state').textContent === '排版已变化，请重新检查。') {
          await runPreflight();notice('排版已变化，已更新检查结果。请重新点击要定位的提示。');return;
        }
        if (hasRange) {
          editor.focus();editor.setSelectionRange(issue.start,issue.end);
          const scrollSpan = Number(editor.scrollHeight) - Number(editor.clientHeight);
          if (scrollSpan > 0 && editor.value.length) editor.scrollTop = issue.start / editor.value.length * scrollSpan;
          if (state.presentation.scrollSync) scrollSync.refresh({source:'editor',preserveRatio:false});
        }
        else if (articleId) {
          $('history-search').value = '';renderHistory();
          const target = [...$('history-articles').children].find(item => item.dataset.articleId === articleId);
          target?.scrollIntoView?.({block:'center'});target?.classList?.add('preflight-highlight');target?.children?.[0]?.children?.[0]?.focus();
        }
      },!hasRange && !articleId);
      row.append(button);$('preflight-results').append(row);
    }
  }
  withButton('run-preflight',runPreflight);
  $('close-preflight').addEventListener('click',() => {$('preflight-panel').hidden = true;});
  withButton('copy-rich',async () => {
    if (!editor.value.trim()) throw new Error('请先导入或输入正文。');
    const rendered = await ensureRendered();
    const result = await copy({html:rendered.html,text:rendered.source ?? editor.value});
    notice(`${result.warning || '已复制 HTML 富文本与纯文本。'} 微信图片保留仍需手动检查。`);
  });
  withButton('export-html',async () => {
    const result = await ensureRendered();
    download(wrapArticleHtml(result.html,state.filename || '谢雨聊文章'),'text/html;charset=utf-8',exportName('.html'));
    notice(`已导出 HTML，携带 ${result.images?.filter(i => i.hasData).length || 0} 张匹配图片。缺失或冲突图片保留提示占位。`);
  });
  withButton('export-draft',async () => {
    // Render limits must not prevent backing up a previously valid draft.
    await updatePreview();
    download(JSON.stringify(draftSnapshot(),null,2),'application/json;charset=utf-8',exportName('.xieyuliao.json'));
    notice('已导出完整草稿，包含正文与全部已读取／粘贴图片。');
  });
  $('import-draft').addEventListener('click',() => $('draft-input').click());
  $('draft-input').addEventListener('change',async event => {
    const file = event.target.files[0];event.target.value = '';if (!file) return;
    try {
      if (file.size > 90_000_000) throw new Error('完整草稿超过 90 MB，请减少图片。');
      const draft = validateDraft(JSON.parse(await file.text()));
      if (!await confirmReplace('导入完整草稿会替换当前正文和图片；会先尝试备份。继续吗？')) return;
      applyDraft(draft);await updatePreview();if (!state.renderError) notice('已恢复完整草稿与图片。');
    } catch(error) {notice(`导入草稿失败：${error.message}`,true);}
  });
  withButton('restore-backup',async () => {
    if (!state.store) throw new Error('当前浏览器无法使用本地备份。');
    const id = $('backup-select').value;if (!id) throw new Error('请先选择一份备份。');
    const draft = await state.store.loadBackup(id);if (!draft) throw new Error('该备份已不在本机，请重新选择。');
    if (!await confirmReplace('恢复备份会替换当前正文和图片；会先尝试保存当前内容。继续吗？')) return;
    applyDraft(validateDraft(draft));await updatePreview();if (!state.renderError) notice('已恢复所选备份。');
  });
  withButton('clear-drafts',async () => {
    if (!state.store) throw new Error('当前浏览器无法访问本地草稿。');
    if (!confirm('确定清除本工具在当前浏览器保存的全部草稿和备份？当前编辑内容仍在页面，可先导出完整草稿。')) return;
    invalidateHistoryImport();clearTimeout(state.saveTimer);state.autosavePaused = true;state.cancelGeneration++;state.saveToken++;await state.store.clear();await updateBackups();
    $('save-state').textContent = '本机草稿已清除';notice('本机草稿已清除。下一次编辑将重新自动保存。');
  });
  document.addEventListener('visibilitychange',() => {if (document.visibilityState === 'hidden') void saveCurrent();});
  const initialRevision = 0;
  reflectPresentation();renderHistory();updateUndoButtons();
  await updatePreview();
  $('save-state').textContent = '正在初始化本地草稿…';
  try {
    state.store = await storeFactory();
    const latest = await state.store.loadLatest();
    if (latest && state.revision === initialRevision) {
      applyDraft(validateDraft(latest));await updatePreview();clearTimeout(state.saveTimer);
      $('save-state').textContent = '已恢复上次本地草稿';if (!state.renderError) notice('已恢复上次本地草稿。新导入文章会先尝试备份当前内容。');
    } else if (state.revision !== initialRevision) void saveCurrent();
    else $('save-state').textContent = '本地草稿已就绪';
    await updateBackups();
  } catch(error) {
    $('save-state').textContent = '自动保存不可用，请导出完整草稿';
    notice(`本地草稿不可用：${error.message}。请使用完整草稿导出。`,true);
  }
  return state;
}

if (typeof document !== 'undefined') {
  void startApp().catch(error => {
    const notice = document.getElementById('notice');
    if (notice) {notice.textContent = `工具初始化失败：${error.message}。请检查启动窗口。`;notice.dataset.error = 'true';notice.hidden = false;}
    console.error(error);
  });
}
