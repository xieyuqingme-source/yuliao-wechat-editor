import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startApp} from '../app.mjs';
import {makeDraft} from '../drafts.mjs';
import markdownFactory from '../vendor/markdown-it.cjs';

// Deliberately uses an in-memory DOM, not a real browser or the user's clipboard.
class Element {
  constructor(doc, tag = 'div') {
    this.doc = doc;this.tagName = tag.toUpperCase();this.children = [];this.listeners = new Map();
    this.dataset = {};this.attributes = {};this._value = '';this._text = '';this.disabled = false;
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

async function harness({latest = null, confirm = true} = {}) {
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
  const state = await startApp({documentRef:doc,storeFactory:async () => store,markdownFactory,
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
const articleRows = h => h.$('history-articles').children;
const checkbox = row => row.children[0].children[0];
async function choose(h,index,checked = true) {const input = checkbox(articleRows(h)[index]);input.checked = checked;await input.dispatch('change');}
const selectedAction = (h,index,actionIndex) => h.$('history-selected').children[index].children[1].children[actionIndex];

test('actual app bootstrap creates all components and integrates selection insertion, typing, undo and redo',async () => {
  const h = await harness();const editor = h.$('markdown-editor');
  assert.equal(h.$('component-tools').children.length,8);
  await type(h,'开头 原文 结尾',3,5);
  await h.$('component-h2').click();assert.match(editor.value,/## 原文/);
  assert.equal(editor.value.slice(editor.selectionStart,editor.selectionEnd),'原文');
  const inserted = editor.value;
  await type(h,inserted + '\n后来输入的正文');
  await editor.dispatch('keydown',{key:'z',ctrlKey:true});assert.equal(editor.value,inserted);
  await h.$('undo-edit').click();assert.equal(editor.value,'开头 原文 结尾');
  await editor.dispatch('keydown',{key:'y',ctrlKey:true});assert.equal(editor.value,inserted);
  await editor.dispatch('beforeinput',{inputType:'historyRedo'});assert.match(editor.value,/后来输入的正文$/);
  const beforeIme = editor.value;
  await editor.dispatch('compositionstart');
  const ignored = await editor.dispatch('keydown',{key:'z',ctrlKey:true,isComposing:true});
  assert.equal(ignored.defaultPrevented,false);assert.equal(editor.value,beforeIme);
  await editor.dispatch('compositionend');
  editor.value += '\n未产生 input 事件的新稿';
  await h.$('undo-edit').click();assert.match(editor.value,/未产生 input 事件的新稿$/,'stale undo refuses to overwrite current text');
});

test('batch picker cancel, repeated imports, search and duplicate-title prompts retain only safe metadata',async () => {
  const h = await harness();
  await selectFiles(h,'history-files-input',[]);assert.equal(h.state.relatedArticles.items.length,0);
  const one = file('中文 空格.md','# 标题 [特殊] <字> & 星*\n\n私有正文甲');
  const two = file('另一篇.txt','标题乙\n\n私有正文乙');
  await selectFiles(h,'history-files-input',[one,two]);
  assert.equal(h.$('history-files-input').value,'');assert.equal(h.state.relatedArticles.items.length,2);
  assert.deepEqual(Object.keys(h.state.relatedArticles.items[0]).sort(),['id','name','title','titleSource']);
  assert.equal(h.state.relatedArticles.items[0].titleSource,'heading');
  assert.equal(h.$('markdown-editor').value,'');
  await selectFiles(h,'history-files-input',[one]);assert.equal(h.state.relatedArticles.items.length,2);
  assert.match(h.$('history-import-state').textContent,/新增 0/);
  await selectFiles(h,'history-files-input',[file('重名标题.md','# 标题 [特殊] <字> & 星*\n\n另一份私有正文')]);
  assert.equal(h.state.relatedArticles.items.length,3);assert.equal(h.$('history-issues').hidden,false);
  h.$('history-search').value = '中文 空格';await h.$('history-search').dispatch('input');
  assert.equal(articleRows(h).length,1);assert.equal(articleRows(h)[0].children[0].children[1].children[0].textContent,'标题 [特殊] <字> & 星*');
});

test('selection ordering, cancellation and deletion synchronize exactly one editable footer with preview, copy and export',async () => {
  const h = await harness();await type(h,'正文保留');
  await selectFiles(h,'history-files-input',[file('甲.md','# 甲 [x](https://example.com)\n私有正文A'),file('乙.md','# 乙\n私有正文B')]);
  await choose(h,0);await choose(h,1);await choose(h,1);
  assert.equal((h.$('markdown-editor').value.match(/相关文章推荐：/g) || []).length,1);
  await selectedAction(h,1,0).click();
  assert.equal(h.state.relatedArticles.selectedIds[0],h.state.relatedArticles.items[1].id);
  assert.ok(h.$('markdown-editor').value.indexOf('- 乙') < h.$('markdown-editor').value.indexOf('- 甲'));
  await h.$('copy-rich').click();await h.$('export-html').click();await h.$('export-html').click();
  assert.equal(h.copied[0].html,h.state.result.html);
  assert.ok(h.$('preview').srcdoc.includes(h.copied[0].html));
  assert.ok(h.downloads[0].content.includes(h.copied[0].html));assert.equal(h.downloads[0].content,h.downloads[1].content);
  assert.ok(!h.copied[0].html.includes('私有正文'));assert.ok(!h.downloads[0].content.includes('私有正文'));
  assert.ok(!h.copied[0].html.includes('<a '),'imported title punctuation cannot create a hyperlink');
  await selectedAction(h,0,2).click();assert.equal(h.state.relatedArticles.selectedIds.length,1);
  await articleRows(h)[0].children[1].click();assert.equal(h.state.relatedArticles.items.length,1);
  assert.equal(h.state.relatedArticles.selectedIds.length,0);assert.equal(h.$('markdown-editor').value,'正文保留');
});

test('footer title text is editable, structural changes pause updates, and clearing detached state keeps body intact',async () => {
  const h = await harness();await type(h,'原始正文');
  await selectFiles(h,'history-files-input',[file('甲.md','# 甲\n正文'),file('乙.md','# 乙\n正文')]);await choose(h,0);
  await type(h,h.$('markdown-editor').value.replace('- 甲','- 手改标题'));
  assert.equal(Boolean(h.state.relatedArticles.footer.detached),false);
  await choose(h,1);assert.match(h.$('markdown-editor').value,/- 甲\n- 乙/);
  const manuallyChanged = h.$('markdown-editor').value + '\n新的正文段落';
  await type(h,manuallyChanged);
  // Inserting within the managed range must not later be deleted by a selector action.
  const inside = h.$('markdown-editor').value.replace('相关文章推荐：','相关文章推荐：\n\n我的补充正文');
  await type(h,inside);assert.equal(h.state.relatedArticles.footer.detached,true);
  await choose(h,1,false);assert.equal(h.$('markdown-editor').value,inside);
  await h.$('clear-history-selection').click();assert.equal(h.$('markdown-editor').value,inside);
  assert.equal(h.state.relatedArticles.footer,null);assert.equal(h.state.relatedArticles.selectedIds.length,0);
  assert.match(h.confirms.at(-1),/保留正文/);
});

test('related selection and metadata undo together; new article import resets footer selection and the journal',async () => {
  const h = await harness();await type(h,'第一篇正文');
  await selectFiles(h,'history-files-input',[file('历史.md','# 历史标题\n历史私有正文')]);await choose(h,0);
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,'第一篇正文');assert.equal(h.state.relatedArticles.selectedIds.length,0);
  await h.$('redo-edit').click();assert.equal(h.state.relatedArticles.selectedIds.length,1);assert.match(h.$('markdown-editor').value,/相关文章推荐/);
  await selectFiles(h,'md-input',[file('新的中文文稿.md','# 新稿\n新稿正文')]);
  assert.equal(h.$('markdown-editor').value,'# 新稿\n新稿正文');assert.equal(h.state.relatedArticles.items.length,1);
  assert.equal(h.state.relatedArticles.footer,null);assert.equal(h.state.relatedArticles.selectedIds.length,0);
  assert.equal(h.$('undo-edit').disabled,true);assert.equal(h.$('md-input').value,'');
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,'# 新稿\n新稿正文');
});

test('complete draft export/import and startup restore retain history order and editable managed text without historical bodies',async () => {
  const h = await harness();await type(h,'当前正文');
  await selectFiles(h,'history-files-input',[file('甲.md','# 甲\n历史私有甲'),file('乙.md','# 乙\n历史私有乙')]);
  await choose(h,0);await choose(h,1);await selectedAction(h,1,0).click();
  await h.$('export-draft').click();const draftText = h.downloads[0].content;
  assert.ok(!draftText.includes('历史私有'));const draft = JSON.parse(draftText);
  assert.equal(draft.relatedArticles.selectedIds.length,2);
  const restored = await harness({latest:draft});assert.equal(restored.$('markdown-editor').value,h.$('markdown-editor').value);
  assert.deepEqual(restored.state.relatedArticles,draft.relatedArticles);assert.equal(restored.$('undo-edit').disabled,true);
  await selectFiles(h,'draft-input',[file('恢复.json',draftText)]);assert.deepEqual(h.state.relatedArticles,draft.relatedArticles);
  const old = makeDraft({markdown:'旧版正文',theme:'clear',articlePath:'old.md',stripFrontmatter:true,assets:new Map(),entries:[]});
  delete old.relatedArticles;
  await selectFiles(h,'draft-input',[file('旧版.json',JSON.stringify(old))]);
  assert.equal(h.$('markdown-editor').value,'旧版正文');assert.equal(h.state.relatedArticles.items.length,0);
});

test('directory import reads only selected Markdown and picker cancellation preserves the existing library',async () => {
  const h = await harness();
  const md = file('文章.md','# 目录文章\n正文',{path:'历史/中文 空格/文章.md'});
  const txt = file('文章.txt','绝不读取',{path:'历史/文章.txt'}),image = file('图片.png','绝不读取',{path:'历史/图片.png'});
  await selectFiles(h,'history-folder-input',[md,txt,image]);
  assert.equal(md.reads,1);assert.equal(txt.reads,0);assert.equal(image.reads,0);assert.equal(h.state.relatedArticles.items.length,1);
  await selectFiles(h,'history-folder-input',[]);assert.equal(h.state.relatedArticles.items.length,1);
});

test('importing only a history index still autosaves metadata in an empty current article',async () => {
  const h = await harness();
  await selectFiles(h,'history-files-input',[file('仅索引.md','# 仅索引标题\n私有历史正文')]);
  assert.equal(h.$('markdown-editor').value,'');
  h.timers.get(h.state.saveTimer).fn();await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].markdown,'');assert.equal(h.saved[0].relatedArticles.items.length,1);
  assert.ok(!JSON.stringify(h.saved[0]).includes('私有历史正文'));
});

test('manually removing a generated list pauses sync, and declining reset or article replacement preserves the draft',async () => {
  const h = await harness({confirm:false});await type(h,'保留正文');
  await selectFiles(h,'history-files-input',[file('甲.md','# 甲\n正文'),file('乙.md','# 乙\n正文')]);await choose(h,0);
  await type(h,'保留正文');assert.equal(h.state.relatedArticles.footer.detached,true);
  await choose(h,1);assert.equal(h.$('markdown-editor').value,'保留正文');
  await h.$('clear-history-selection').click();assert.equal(h.state.relatedArticles.footer.detached,true);
  assert.equal(h.state.relatedArticles.selectedIds.length,2);
  await selectFiles(h,'md-input',[file('拒绝替换.md','# 不应该覆盖')]);
  assert.equal(h.$('markdown-editor').value,'保留正文');assert.equal(h.state.relatedArticles.selectedIds.length,2);
});

test('deferred imports cannot commit after cancellation, undo, removal, article switching or a newer import',async () => {
  for (const action of ['cancel','undo','remove','article','newer']) {
    const h = await harness();await type(h,'正文');
    await selectFiles(h,'history-files-input',[file('原库.md','# 原库\n正文')]);
    let resolve;const deferred = new Promise(done => {resolve = done;});
    const waiting = selectFiles(h,'history-files-input',[file('慢导入.md','# 慢导入\n正文',{read:() => deferred})]);
    assert.equal(h.state.historyBusy,true);
    if (action === 'cancel') await h.$('cancel-history-import').click();
    if (action === 'undo') await h.$('undo-edit').click();
    if (action === 'remove') await articleRows(h)[0].children[1].click();
    if (action === 'article') await selectFiles(h,'md-input',[file('新.md','# 新正文')]);
    if (action === 'newer') await selectFiles(h,'history-files-input',[file('新库.md','# 新库\n正文')]);
    resolve(new TextEncoder().encode('# 慢导入\n正文').buffer);await waiting;
    assert.ok(!h.state.relatedArticles.items.some(item => item.title === '慢导入'),action);
    if (action === 'undo' || action === 'remove') assert.equal(h.state.relatedArticles.items.length,0,action);
    if (action === 'article') assert.equal(h.$('markdown-editor').value,'# 新正文');
    if (action === 'newer') assert.ok(h.state.relatedArticles.items.some(item => item.title === '新库'));
    assert.equal(h.state.historyBusy,false);
  }
});

test('layout exposes clear manual-selection instructions and restricts network access',async () => {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/人工选文，未加超链接/);assert.match(html,/再次调整选文会更新已生成列表/);
  assert.match(html,/connect-src 'none'/);assert.ok(!/<script[^>]+https?:/i.test(html));
  assert.ok(!html.includes('二维码'));assert.match(html,/id="history-files-input"[^>]*multiple/);
});
