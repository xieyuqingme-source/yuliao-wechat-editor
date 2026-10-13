import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startApp, readRaster} from '../app.mjs';
import {MAX_MARKDOWN_BYTES, MAX_IMAGE_BYTES, MAX_ASSET_DATA_BYTES, MAX_INDEX_ENTRIES, utf8ByteLength, acceptsSourceChange, createLimitedReader, readAssetBatch} from '../input-limits.mjs';
import {makeDraft} from '../drafts.mjs';
import {createPreviewLayout} from '../preview-layout.mjs';
import markdownFactory from '../vendor/markdown-it.cjs';

// Deliberately uses an in-memory DOM, not a real browser or the user's clipboard.
class Element {
  constructor(doc, tag = 'div') {
    this.doc = doc;this.tagName = tag.toUpperCase();this.children = [];this.listeners = new Map();
    this.dataset = {};this.attributes = {};this.style = {};this.ownerDocument = doc;this._value = '';this._text = '';this.disabled = false;
    this.hidden = false;this.selectionStart = 0;this.selectionEnd = 0;this.selectionDirection = 'none';
    this.classList = {add(){},remove(){}};
  }
  set id(value) {this._id = value;this.doc.nodes.set(value,this);}
  get id() {return this._id;}
  set value(value) {this._value = String(value);this.selectionStart = this.selectionEnd = this._value.length;}
  get value() {return this._value;}
  set textContent(value) {this._text = String(value);this.children = [];}
  get textContent() {return this._text + this.children.map(child => child.textContent).join('');}
  get childElementCount() {return this.children.length;}
  append(...nodes) {for (const node of nodes) {node.parentNode = this;this.children.push(node);}}
  replaceChildren(...nodes) {this.children = [];this._text = '';this.append(...nodes);}
  setAttribute(name,value) {this.attributes[name] = String(value);}
  addEventListener(type,fn) {if (!this.listeners.has(type)) this.listeners.set(type,[]);this.listeners.get(type).push(fn);}
  removeEventListener(type,fn) {this.listeners.set(type,(this.listeners.get(type) || []).filter(item => item !== fn));}
  async dispatch(type,values = {}) {
    const event = {type,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented = true;},...values};
    for (const fn of this.listeners.get(type) || []) await fn(event);
    return event;
  }
  click() {this.clickCount = (this.clickCount || 0) + 1;return this.dispatch('click');}
  focus() {this.doc.activeElement = this;}
  setSelectionRange(start,end,direction = 'none') {
    this.selectionStart = Math.min(this.value.length,Math.max(0,start));
    this.selectionEnd = Math.min(this.value.length,Math.max(this.selectionStart,end));this.selectionDirection = direction;
  }
  contains(node) {return node === this || this.children.some(child => child.contains(node));}
}

async function harness({latest = null, confirm = true, scrollSyncFactory, previewLayoutFactory, rasterReader, markdown = markdownFactory} = {}) {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  const doc = {nodes:new Map(),listeners:new Map(),visibilityState:'visible',createElement(tag){return new Element(this,tag);},
    getElementById(id){return this.nodes.get(id) || null;},addEventListener(type,fn){this.listeners.set(type,fn);}};
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {const node = new Element(doc,match[1]);node.id = match[2];}
  const $ = id => doc.getElementById(id);
  $('theme-select').value = 'clear';$('strip-frontmatter').checked = true;
  const copied = [],downloads = [],saved = [],confirms = [];
  const store = {loadLatest:async () => latest,listBackups:async () => [],save:async draft => {saved.push(draft);return {id:String(saved.length)};},
    loadBackup:async () => latest,clear:async () => {saved.length = 0;}};
  const timers = new Map();let nextTimer = 0;
  const state = await startApp({documentRef:doc,storeFactory:async () => store,markdownFactory:markdown,
    ...(rasterReader ? {rasterReader} : {}),
    ...(scrollSyncFactory ? {scrollSyncFactory} : {}),
    ...(previewLayoutFactory ? {previewLayoutFactory} : {}),
    copy:async value => {copied.push(value);return {method:'stub'};},
    downloadFile:(content,type,filename) => downloads.push({content,type,filename}),
    confirmAction:message => {confirms.push(message);return confirm;},
    setTimer:(fn,delay) => {timers.set(++nextTimer,{fn,delay});return nextTimer;},clearTimer:id => timers.delete(id)});
  return {doc,$,state,copied,downloads,saved,confirms,timers};
}

function file(name,content,{path = '',read = null} = {}) {
  const bytes = new TextEncoder().encode(content);
  const result = {name,size:bytes.length,type:'text/plain',webkitRelativePath:path,reads:0,
    async arrayBuffer(){this.reads++;return read ? read() : bytes.buffer.slice(0);},async text(){return content;}};
  return result;
}
async function selectFiles(h,id,files) {const input = h.$(id);input.files = files;return input.dispatch('change');}
async function type(h,value,start = value.length,end = start) {
  const editor = h.$('markdown-editor');await editor.dispatch('beforeinput',{inputType:'insertText'});
  editor.value = value;editor.setSelectionRange(start,end);await editor.dispatch('input',{inputType:'insertText'});
}

const png = 'data:image/png;base64,iVBORw0KGgo=';
const paste = (h,text,files = []) => h.$('markdown-editor').dispatch('paste',{clipboardData:{
  getData:() => text,items:files.map(image => ({kind:'file',type:'image/png',getAsFile:() => image}))}});

test('UTF-8 accounting includes Chinese, surrogate pairs and malformed surrogates without truncating',() => {
  for (const text of ['', 'English words', '中文 空格', '🙂雨', '\ud800x\udc00']) {
    assert.equal(utf8ByteLength(text),new TextEncoder().encode(text).length);
  }
  assert.equal(acceptsSourceChange('原文','雨'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3))),false);
  const old = '雨'.repeat(1_800_000);
  assert.equal(acceptsSourceChange(old,old),true);
  assert.equal(acceptsSourceChange(old,old.slice(0,-1)),true);
  assert.equal(acceptsSourceChange(old,old + 'x'),false);
  assert.equal(acceptsSourceChange(old,old.replace(/^雨/,'云')),false);
});

test('a successful bounded asset batch has exact data and never mutates the prior map',async () => {
  const existing = new Map([['old.png',png]]);
  const batch = await readAssetBatch(new Map([['new.png',{}]]),{existingAssets:existing,read:async () => png,budget:1000});
  assert.deepEqual([...batch.staged],[['new.png',png]]);assert.equal(batch.errors.size,0);
  assert.deepEqual([...existing],[['old.png',png]]);
});

test('read failure and actual data budget overflow discard the whole batch',async () => {
  for (const mode of ['failure','overflow']) {
    const old = new Map([['old.png',png]]);
    const targets = new Map([['first.png',{ok:true}],['second.png',{ok:false}]]);
    const result = await readAssetBatch(targets,{existingAssets:old,budget:60,read:async file => {
      if (mode === 'failure' && !file.ok) throw new Error('synthetic read failure');
      return png;
    }});
    assert.equal(result.staged.size,0);assert.equal(result.errors.size,2);
    assert.deepEqual([...old],[['old.png',png]]);
  }
});

test('known total size and already oversized legacy assets reject additions before reads',async () => {
  let reads = 0;
  const predicted = await readAssetBatch(new Map([['large.png',{size:1000}]]),{read:async () => {reads++;return png;},budget:100});
  assert.equal(predicted.errors.size,1);assert.equal(reads,0);
  const legacy = new Map([['old.png','x'.repeat(200)]]);
  const blocked = await readAssetBatch(new Map([['small.png',{}]]),{existingAssets:legacy,read:async () => {reads++;return png;},budget:100});
  assert.equal(blocked.staged.size,0);assert.equal(reads,0);assert.equal(legacy.get('old.png').length,200);
  const empty = await readAssetBatch(new Map(),{existingAssets:legacy,read:async () => {reads++;return png;},budget:100});
  assert.equal(empty.errors.size,0);
});

test('overlapping image requests share at most three readers; cancellation never commits a partial batch',async () => {
  let active = 0,peak = 0;
  const read = createLimitedReader(async () => {
    active++;peak = Math.max(peak,active);await new Promise(resolve => setImmediate(resolve));active--;return png;
  });
  const targets = prefix => new Map(Array.from({length:8},(_,i) => [`${prefix}${i}.png`,{}]));
  const [first,second] = await Promise.all([readAssetBatch(targets('a'),{read}),readAssetBatch(targets('b'),{read})]);
  assert.equal(peak,3);assert.equal(first.staged.size,8);assert.equal(second.staged.size,8);
  let cancelled = false;
  const stopped = await readAssetBatch(targets('c'),{read:async () => {cancelled = true;return png;},isCancelled:() => cancelled});
  assert.equal(stopped.cancelled,true);assert.equal(stopped.staged.size,0);
});

test('a false image file size cannot bypass the actual 20 MiB byte limit',async () => {
  await assert.rejects(readRaster({size:1,arrayBuffer:async () => new ArrayBuffer(MAX_IMAGE_BYTES + 1)}),/实际大小/);
  let read = false;
  await assert.rejects(readRaster({size:MAX_IMAGE_BYTES + 1,arrayBuffer:async () => {read = true;return new ArrayBuffer(0);}}),/20 MiB/);
  assert.equal(read,false);
});

test('empty data URLs are rejected atomically',async () => {
  const result = await readAssetBatch(new Map([['empty.png',{}]]),{read:async () => 'data:image/png;base64,'});
  assert.equal(result.staged.size,0);assert.equal(result.errors.size,1);
});

test('beforeinput and fallback input rejection preserve the exact body, selection and undo state',async () => {
  const h = await harness();await type(h,'已有原稿',1,3);
  const editor = h.$('markdown-editor'),tooLarge = '雨'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3));
  const rejected = await editor.dispatch('beforeinput',{inputType:'insertText',data:tooLarge});
  assert.equal(rejected.defaultPrevented,true);assert.equal(editor.value,'已有原稿');assert.equal(editor.selectionStart,1);assert.equal(editor.selectionEnd,3);
  await editor.dispatch('beforeinput',{inputType:'insertFromPaste'});
  editor.value = tooLarge;await editor.dispatch('input');
  assert.equal(editor.value,'已有原稿');assert.equal(editor.selectionStart,1);assert.equal(editor.selectionEnd,3);
  await h.$('undo-edit').click();assert.equal(editor.value,'');
  await h.$('redo-edit').click();assert.equal(editor.value,'已有原稿');
});

test('text and mixed image paste are atomic when the resulting source exceeds the UTF-8 limit',async () => {
  const h = await harness();await type(h,'完整 原稿',2,4);
  const tooLarge = '雨'.repeat(Math.ceil(MAX_MARKDOWN_BYTES / 3));
  await paste(h,tooLarge);assert.equal(h.$('markdown-editor').value,'完整 原稿');
  await paste(h,tooLarge,[{name:'图片.png',size:8}]);
  assert.equal(h.state.entries.length,0);assert.equal(h.state.assets.size,0);
  assert.equal(h.$('markdown-editor').value,'完整 原稿');assert.equal(h.$('markdown-editor').selectionStart,2);assert.equal(h.$('markdown-editor').selectionEnd,4);
  await paste(h,'英文 words');assert.equal(h.$('markdown-editor').value,'完整英文 words稿');
});

test('actual Markdown bytes are checked before replacement even when the declared size lies',async () => {
  const h = await harness();await type(h,'原正文');
  await selectFiles(h,'md-input',[{name:'oversized.md',size:1,arrayBuffer:async () => new ArrayBuffer(MAX_MARKDOWN_BYTES + 1)}]);
  assert.equal(h.$('markdown-editor').value,'原正文');assert.equal(h.confirms.length,0);
  assert.match(h.$('notice').textContent,/实际大小/);
});

test('directory replacement, appending and image addition beyond 100k entries retain the old index and assets',async () => {
  const h = await harness();await type(h,'正文');h.state.assets.set('old.png',png);
  h.state.entries = [{path:'old.png',pasted:true}];
  const files = Array.from({length:MAX_INDEX_ENTRIES},(_,i) => ({name:`${i}.png`,webkitRelativePath:`selected/${i}.png`,size:0}));
  await selectFiles(h,'folder-input',files);assert.equal(h.state.entries.length,1);assert.equal(h.state.assets.get('old.png'),png);
  h.state.entries = Array.from({length:MAX_INDEX_ENTRIES},(_,i) => ({path:`${i}.png`}));
  await h.$('append-folder').click();await selectFiles(h,'folder-input',[{name:'new.png',webkitRelativePath:'selected/new.png'}]);
  assert.equal(h.state.entries.length,MAX_INDEX_ENTRIES);
  await selectFiles(h,'image-input',[{name:'new.png',size:0}]);assert.equal(h.state.entries.length,MAX_INDEX_ENTRIES);
  assert.equal(h.state.assets.get('old.png'),png);assert.equal(h.$('markdown-editor').value,'正文');
});

test('a previously valid multi-byte oversized draft restores, exports and backs up unchanged, while copy stays blocked',async () => {
  const source = '雨'.repeat(1_800_000);
  const latest = makeDraft({markdown:source,theme:'clear',articlePath:'old.md',stripFrontmatter:true,assets:new Map([['old.png',png]]),entries:[{path:'old.png'}]});
  const h = await harness({latest});assert.equal(h.$('markdown-editor').value,source);
  assert.match(h.$('notice').textContent,/暂不排版/);assert.equal(h.state.result,null);
  await h.$('copy-rich').click();assert.equal(h.copied.length,0);
  await h.$('export-draft').click();assert.equal(JSON.parse(h.downloads.at(-1).content).markdown,source);
  assert.equal(JSON.parse(h.downloads.at(-1).content).assets[0].dataURL,png);
  await type(h,source.slice(0,-1));h.timers.get(h.state.saveTimer).fn();await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.saved.at(-1).markdown,source.slice(0,-1));
  await type(h,'可用正文');await h.$('copy-rich').click();assert.equal(h.copied.length,1);
  assert.ok(h.copied[0].html.includes('可用正文'));
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,source.slice(0,-1));
  await h.$('export-draft').click();assert.equal(JSON.parse(h.downloads.at(-1).content).markdown,source.slice(0,-1));
});

test('component overflow preserves an oversized old draft and importing it remains possible',async () => {
  const source = '雨'.repeat(1_800_000);
  const latest = makeDraft({markdown:source,theme:'clear',articlePath:'old.md',stripFrontmatter:true,assets:new Map(),entries:[]});
  const h = await harness({latest});h.$('markdown-editor').setSelectionRange(1,3);
  await h.$('component-h2').click();
  assert.equal(h.$('markdown-editor').value,source);assert.equal(h.$('markdown-editor').selectionStart,1);assert.equal(h.$('markdown-editor').selectionEnd,3);
  assert.equal(h.$('undo-edit').disabled,true);
  await selectFiles(h,'draft-input',[file('legacy.json',JSON.stringify(latest))]);
  assert.equal(h.$('markdown-editor').value,source);assert.match(h.$('notice').textContent,/暂不排版/);
  await h.$('export-draft').click();assert.equal(JSON.parse(h.downloads.at(-1).content).markdown,source);
});

test('actual app preview reads only referenced files with at most three concurrent readers',async () => {
  let active = 0,peak = 0,reads = 0;
  const h = await harness({rasterReader:async () => {
    reads++;active++;peak = Math.max(peak,active);await new Promise(resolve => setImmediate(resolve));active--;return png;
  }});
  await selectFiles(h,'image-input',Array.from({length:9},(_,i) => ({name:`${i}.png`,size:8})));
  await type(h,Array.from({length:8},(_,i) => `![图${i}](${i}.png)`).join('\n'));
  await h.$('copy-rich').click();assert.equal(peak,3);assert.equal(reads,8);assert.equal(h.state.assets.size,8);
  const first = h.copied.at(-1).html;
  await h.$('copy-rich').click();await h.$('export-html').click();assert.equal(reads,8);
  assert.equal(h.copied.at(-1).html,first);assert.ok(h.downloads.at(-1).content.includes(first));
});

test('image failure does not partially save assets and repeated copy does not reread the failed batch',async () => {
  let reads = 0;
  const h = await harness({rasterReader:async image => {reads++;if (image.name === 'bad.png') throw new Error('坏图');return png;}});
  h.state.assets.set('old.png',png);
  h.state.entries.push({path:'old.png',restored:true});
  await selectFiles(h,'image-input',[{name:'good.png',size:8},{name:'bad.png',size:8}]);
  await type(h,'![旧](old.png)\n![好](good.png)\n![坏](bad.png)');
  await h.$('copy-rich').click();assert.equal(reads,2);
  assert.deepEqual([...h.state.assets],[['old.png',png]]);assert.equal(h.state.readErrors.size,2);
  const html = h.copied.at(-1).html;
  await h.$('copy-rich').click();await h.$('export-html').click();assert.equal(reads,2);
  assert.equal(h.copied.at(-1).html,html);assert.ok(h.downloads.at(-1).content.includes(html));
  assert.equal((html.match(/data:image\/png;base64/g) || []).length,1);
});

test('parse errors are caught by preview, copy and raw backup without retrying the same render four times',async () => {
  const h = await harness();await type(h,'[x](< '.repeat(2000));
  await h.$('copy-rich').click();assert.equal(h.copied.length,0);assert.ok(h.state.renderError);
  await h.$('export-draft').click();assert.equal(JSON.parse(h.downloads.at(-1).content).markdown,h.$('markdown-editor').value);
  await type(h,'# 恢复正常');await h.$('copy-rich').click();assert.equal(h.copied.length,1);assert.equal(h.state.renderError,null);
  let renders = 0;
  const failing = await harness({markdown:() => {renders++;throw new Error('synthetic renderer failure');}});
  const before = renders;await type(failing,'测试');await failing.$('copy-rich').click();
  assert.equal(renders - before,1);assert.equal(failing.copied.length,0);
  await failing.$('export-draft').click();assert.equal(JSON.parse(failing.downloads.at(-1).content).markdown,'测试');
});
