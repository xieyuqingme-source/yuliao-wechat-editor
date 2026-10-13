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

async function harness({latest = null, confirm = true, scrollSyncFactory} = {}) {
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
    ...(scrollSyncFactory ? {scrollSyncFactory} : {}),
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

const sourceRows = h => h.$('history-sources').children;
const sourceAction = (h,index,actionIndex = 0) => sourceRows(h)[index].children[1].children[actionIndex];
const directoryFile = (root,path,title,body = '私密历史正文') => file(path.split('/').at(-1),`# ${title}\n\n${body}`,{path:`${root}/${path}`});
async function importDirectory(h,files,{append = false,sourceIndex = null} = {}) {
  if (sourceIndex !== null) await sourceAction(h,sourceIndex).click();
  else await h.$(append ? 'append-history-folder' : 'import-history-folder').click();
  return selectFiles(h,'history-folder-input',files);
}

test('directory-first UI appends two sources, preserves same-name different articles and never reads README or backups',async () => {
  const h = await harness();
  const first = directoryFile('往期文章','子目录/同名.md','第一篇','正文一');
  const readme = directoryFile('往期文章','README.md','说明'),backup = directoryFile('往期文章','backup/拷贝.md','备份');
  const txt = file('随笔.txt','不应读取',{path:'往期文章/随笔.txt'});
  await importDirectory(h,[first,readme,backup,txt]);
  const second = directoryFile('文章','同名.md','第二篇','正文二');
  await importDirectory(h,[second],{append:true});
  assert.equal(h.state.relatedArticles.items.length,2);assert.equal(h.state.relatedArticles.sources.length,2);
  assert.equal(first.reads,1);assert.equal(second.reads,1);
  assert.equal(readme.reads,0);assert.equal(backup.reads,0);assert.equal(txt.reads,0);
  assert.match(sourceRows(h)[0].textContent,/往期文章 · 1 篇/);assert.match(sourceRows(h)[1].textContent,/文章 · 1 篇/);
  assert.match(articleRows(h)[0].textContent,/往期文章 \/ 子目录\/同名\.md/);
  assert.match(articleRows(h)[1].textContent,/文章 \/ 同名\.md/);
  assert.ok(!JSON.stringify(h.state.relatedArticles).includes('正文一'));assert.ok(!JSON.stringify(h.state.relatedArticles).includes('D:\\'));
  assert.equal(h.$('history-folder-input').value,'');
});

test('explicit source re-selection updates changed titles, removes missing files and preserves surviving selection order',async () => {
  const h = await harness();await type(h,'当前正文');
  await importDirectory(h,[directoryFile('往期文章','甲.md','原甲'),directoryFile('往期文章','乙.md','原乙')]);
  await importDirectory(h,[directoryFile('文章','丙.md','原丙')],{append:true});
  await choose(h,0);await choose(h,1);await choose(h,2);await selectedAction(h,2,0).click();
  const firstId = h.state.relatedArticles.items[0].id,thirdId = h.state.relatedArticles.items[2].id;
  const sourceId = h.state.relatedArticles.sources[0].id;
  await importDirectory(h,[directoryFile('往期文章','甲.md','修改甲','正文已改')],{sourceIndex:0});
  assert.equal(h.state.relatedArticles.sources[0].id,sourceId);assert.equal(h.state.relatedArticles.items.length,2);
  assert.deepEqual(h.state.relatedArticles.selectedIds,[firstId,thirdId]);
  assert.equal(h.state.relatedArticles.items.find(item => item.id === firstId).title,'修改甲');
  assert.match(h.$('markdown-editor').value,/- 修改甲\n- 原丙/);assert.ok(!h.$('markdown-editor').value.includes('原乙'));
  await h.$('copy-rich').click();await h.$('export-html').click();await h.$('export-html').click();
  assert.equal(h.copied[0].html,h.state.result.html);assert.ok(h.$('preview').srcdoc.includes(h.copied[0].html));
  assert.ok(h.downloads[0].content.includes(h.copied[0].html));assert.equal(h.downloads[0].content,h.downloads[1].content);
  assert.equal((h.$('markdown-editor').value.match(/相关文章推荐：/g) || []).length,1);
  for (const output of [h.copied[0].html,h.copied[0].text,h.downloads[0].content]) {
    assert.ok(!output.includes('往期文章'));assert.ok(!output.includes('.md'));assert.ok(!output.includes('私密历史正文'));assert.ok(!output.includes('正文已改'));
  }
});

test('repeat append and selecting the wrong root retain data; explicit same-directory update succeeds',async () => {
  const h = await harness();const first = directoryFile('往期文章','甲.md','甲');
  await importDirectory(h,[first]);await choose(h,0);const original = structuredClone(h.state.relatedArticles);
  await importDirectory(h,[first],{append:true});assert.deepEqual(h.state.relatedArticles,original);assert.equal(first.reads,1);
  assert.match(h.$('history-issues').textContent,/重新选择更新/);
  const wrong = directoryFile('文章','乙.md','乙');
  await importDirectory(h,[wrong],{sourceIndex:0});assert.deepEqual(h.state.relatedArticles,original);assert.equal(wrong.reads,0);
  assert.match(h.$('history-issues').textContent,/所选目录名称不同/);
  await importDirectory(h,[first],{sourceIndex:0});assert.equal(first.reads,2);
  assert.deepEqual(h.state.relatedArticles,original);assert.equal(h.state.relatedArticles.sources.length,1);
});

test('cancelled or empty picker keeps index and selection; removing a source retains shared and manual article references',async () => {
  const h = await harness();const shared = directoryFile('往期文章','甲.md','共享','相同内容');
  await importDirectory(h,[shared]);await choose(h,0);
  await importDirectory(h,[directoryFile('文章','甲副本.md','共享','相同内容')],{append:true});
  await selectFiles(h,'history-files-input',[file('甲.md','# 共享\n\n相同内容')]);
  const original = structuredClone(h.state.relatedArticles),source = h.$('markdown-editor').value;
  await sourceAction(h,0).click();await h.$('history-folder-input').dispatch('cancel');
  assert.deepEqual(h.state.relatedArticles,original);assert.equal(h.$('markdown-editor').value,source);
  await importDirectory(h,[],{sourceIndex:0});assert.deepEqual(h.state.relatedArticles,original);
  assert.match(h.$('history-import-state').textContent,/空目录/);
  await sourceAction(h,0,1).click();assert.equal(h.state.relatedArticles.sources.length,1);assert.equal(h.state.relatedArticles.items.length,1);
  assert.equal(h.state.relatedArticles.selectedIds.length,1);
  await sourceAction(h,0,1).click();assert.equal(h.state.relatedArticles.sources.length,0);assert.equal(h.state.relatedArticles.items.length,1);
  assert.equal(h.state.relatedArticles.selectedIds.length,1);assert.equal(h.$('markdown-editor').value,source);
});

test('source metadata, selections and footer undo together and survive draft export/startup restore/new article import',async () => {
  const h = await harness();await type(h,'当前正文');
  await importDirectory(h,[directoryFile('往期文章','甲.md','甲')]);await choose(h,0);
  await importDirectory(h,[directoryFile('文章','乙.md','乙')],{append:true});await choose(h,1);
  await sourceAction(h,0,1).click();assert.equal(h.state.relatedArticles.sources.length,1);assert.equal(h.state.relatedArticles.selectedIds.length,1);
  await h.$('undo-edit').click();assert.equal(h.state.relatedArticles.sources.length,2);assert.equal(h.state.relatedArticles.selectedIds.length,2);
  await h.$('redo-edit').click();assert.equal(h.state.relatedArticles.sources.length,1);assert.equal(h.state.relatedArticles.selectedIds.length,1);
  await h.$('export-draft').click();const draft = JSON.parse(h.downloads[0].content);
  assert.ok(!h.downloads[0].content.includes('私密历史正文'));const restored = await harness({latest:draft});
  assert.deepEqual(restored.state.relatedArticles,draft.relatedArticles);assert.equal(sourceRows(restored).length,1);
  await selectFiles(h,'md-input',[file('新.md','# 新文章\n新正文')]);
  assert.equal(h.state.relatedArticles.sources.length,1);assert.equal(h.state.relatedArticles.selectedIds.length,0);
  assert.equal(h.state.relatedArticles.footer,null);assert.equal(h.$('markdown-editor').value,'# 新文章\n新正文');
});

test('deferred directory updates cannot commit after cancellation, selection change, undo, source removal, restore or a newer import',async () => {
  for (const action of ['cancel','selection','undo','remove-source','restore','new-article','new-source','new-update']) {
    const h = await harness();await type(h,'当前正文');await importDirectory(h,[directoryFile('往期文章','甲.md','甲')]);
    await h.$('export-draft').click();const draftText = h.downloads[0].content;
    let resolve;const deferred = new Promise(done => {resolve = done;});
    const waitingFile = file('甲.md','# 未完成标题',{path:'往期文章/甲.md',read:() => deferred});
    const waiting = importDirectory(h,[waitingFile],{sourceIndex:0});
    await new Promise(done => setImmediate(done));assert.equal(h.state.historyBusy,true,action);
    if (action === 'cancel') await h.$('cancel-history-import').click();
    if (action === 'selection') await choose(h,0);
    if (action === 'undo') await h.$('undo-edit').click();
    if (action === 'remove-source') await sourceAction(h,0,1).click();
    if (action === 'restore') await selectFiles(h,'draft-input',[file('草稿.json',draftText)]);
    if (action === 'new-article') await selectFiles(h,'md-input',[file('新.md','# 新文章')]);
    if (action === 'new-source') await importDirectory(h,[directoryFile('文章','乙.md','最新追加')],{append:true});
    if (action === 'new-update') await importDirectory(h,[directoryFile('往期文章','甲.md','最新更新')],{sourceIndex:0});
    resolve(new TextEncoder().encode('# 未完成标题').buffer);await waiting;
    assert.ok(!h.state.relatedArticles.items.some(item => item.title === '未完成标题'),action);assert.equal(h.state.historyBusy,false,action);
    if (action === 'selection') assert.equal(h.state.relatedArticles.selectedIds.length,1);
    if (action === 'new-source') assert.ok(h.state.relatedArticles.items.some(item => item.title === '最新追加'));
    if (action === 'new-update') assert.ok(h.state.relatedArticles.items.some(item => item.title === '最新更新'));
  }
});

test('a folder picker opened before undo cannot import its eventual selection into the restored state',async () => {
  const h = await harness();await importDirectory(h,[directoryFile('往期文章','甲.md','甲')]);
  await h.$('append-history-folder').click();await h.$('undo-edit').click();
  const later = directoryFile('文章','乙.md','乙');await selectFiles(h,'history-folder-input',[later]);
  assert.equal(later.reads,0);assert.equal(h.state.relatedArticles.items.length,0);assert.equal(h.state.relatedArticles.sources?.length || 0,0);
});

test('legacy sources stay explicitly unknown until content matches a user-selected directory',async () => {
  const h = await harness();await selectFiles(h,'history-files-input',[file('甲.md','# 甲\n\n旧正文')]);
  await h.$('export-draft').click();const old = JSON.parse(h.downloads[0].content);
  delete old.relatedArticles.sources;delete old.relatedArticles.manualIds;
  const restored = await harness({latest:old});assert.equal(restored.$('history-legacy-state').hidden,false);
  assert.match(articleRows(restored)[0].textContent,/旧版来源未知/);
  await importDirectory(restored,[directoryFile('往期文章','甲.md','甲','旧正文')]);
  assert.equal(restored.state.relatedArticles.items.length,1);assert.equal(restored.$('history-legacy-state').hidden,true);
});

test('directory controls explicitly explain user-triggered refresh and public output boundaries',async () => {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/id="import-history-folder" class="primary">选择历史文章目录/);
  assert.match(html,/id="append-history-folder">追加另一个目录/);
  assert.match(html,/README、备份/);assert.match(html,/不会持续同步/);assert.match(html,/目录内容不代表已发表/);
  assert.match(html,/不含本地来源路径或历史正文/);assert.match(html,/不生成目录文档/);
  assert.match(html,/connect-src 'none'/);assert.ok(!/<script[^>]+https?:/i.test(html));
});

const titleDetails = (h,index) => articleRows(h)[index].children[2];
const displayTitleInput = (h,index) => titleDetails(h,index).children[1].children[0];
const titleActions = (h,index) => titleDetails(h,index).children[3].children;

test('display-title editing preserves originals, updates selected footer safely and supports search, undo, copy and export',async () => {
  const h = await harness();await type(h,'正文');
  await importDirectory(h,[directoryFile('往期文章','甲.md','原标题')]);await choose(h,0);
  const original = h.state.relatedArticles.items[0].title;
  const input = displayTitleInput(h,0);input.value = '新显示 [方括号] <词> & *';await input.dispatch('change');
  assert.equal(h.state.relatedArticles.items[0].title,original);assert.equal(h.state.relatedArticles.items[0].displayTitle,input.value);
  assert.ok(h.$('markdown-editor').value.includes('- 新显示'));assert.equal(h.$('history-selected').children[0].children[0].textContent,input.value);
  assert.match(titleDetails(h,0).textContent,/原标题：原标题/);
  h.$('history-search').value = '新显示';await h.$('history-search').dispatch('input');assert.equal(articleRows(h).length,1);
  h.$('history-search').value = '原标题';await h.$('history-search').dispatch('input');assert.equal(articleRows(h).length,1);
  h.$('history-search').value = '';await h.$('history-search').dispatch('input');
  await h.$('copy-rich').click();await h.$('export-html').click();
  assert.equal(h.copied[0].html,h.state.result.html);assert.ok(h.downloads[0].content.includes(h.copied[0].html));
  assert.ok(h.copied[0].html.includes('&lt;词&gt;'));assert.ok(!h.copied[0].html.includes('<词>'));assert.ok(!h.copied[0].html.includes('<a '));
  await h.$('undo-edit').click();assert.equal(h.state.relatedArticles.items[0].displayTitle,undefined);assert.match(h.$('markdown-editor').value,/- 原标题/);
  await h.$('redo-edit').click();assert.equal(h.state.relatedArticles.items[0].displayTitle,'新显示 [方括号] <词> & *');
  await titleActions(h,0).find(button => button.textContent === '恢复原标题').click();assert.equal(h.state.relatedArticles.items[0].displayTitle,undefined);
  const reset = displayTitleInput(h,0);reset.value = '回车标题';await reset.dispatch('keydown',{key:'Enter'});
  assert.equal(h.state.relatedArticles.items[0].displayTitle,'回车标题');
  const empty = displayTitleInput(h,0);empty.value = '';await empty.dispatch('change');assert.equal(h.state.relatedArticles.items[0].displayTitle,undefined);
});

test('date cleanup is an optional filename-only suggestion; heading titles and numeric topics stay intact',async () => {
  const h = await harness();
  const date = file('0614_四大美学.md','只有正文，没有标题',{path:'往期文章/0614_四大美学.md'});
  const numeric = file('1984与阅读.md','只有正文',{path:'往期文章/1984与阅读.md'});
  const heading = file('0614_有标题.md','# 0614_正文中的原标题\n正文',{path:'往期文章/0614_有标题.md'});
  await importDirectory(h,[date,numeric,heading]);
  assert.equal(h.state.relatedArticles.items[0].titleSource,'filename');assert.equal(h.state.relatedArticles.items[2].titleSource,'heading');
  assert.equal(h.state.relatedArticles.items[0].title,'0614_四大美学');assert.equal(h.state.relatedArticles.items[0].displayTitle,undefined);
  assert.ok(titleActions(h,0).some(button => button.textContent === '采用建议'));
  assert.ok(!titleActions(h,1).some(button => button.textContent === '采用建议'));
  assert.ok(!titleActions(h,2).some(button => button.textContent === '采用建议'));
  await choose(h,0);await titleActions(h,0).find(button => button.textContent === '采用建议').click();
  assert.equal(h.state.relatedArticles.items[0].title,'0614_四大美学');assert.equal(h.state.relatedArticles.items[0].displayTitle,'四大美学');
  assert.match(h.$('markdown-editor').value,/- 四大美学/);assert.equal(date.reads,1);
  await importDirectory(h,[date,numeric,heading],{sourceIndex:0});assert.equal(h.state.relatedArticles.items[0].displayTitle,'四大美学');
  await h.$('export-draft').click();const draft = JSON.parse(h.downloads[0].content),restored = await harness({latest:draft});
  assert.equal(restored.state.relatedArticles.items[0].displayTitle,'四大美学');assert.equal(restored.state.relatedArticles.items[0].title,'0614_四大美学');
});

test('matching display titles warn without merging; title edits respect a detached manually changed footer',async () => {
  const h = await harness();await type(h,'原正文');
  await importDirectory(h,[directoryFile('往期文章','甲.md','甲','不同正文甲'),directoryFile('往期文章','乙.md','乙','不同正文乙')]);
  await choose(h,0);const second = displayTitleInput(h,1);second.value = '甲';await second.dispatch('change');
  assert.equal(h.state.relatedArticles.items.length,2);assert.equal(h.$('history-duplicate-state').hidden,false);
  assert.match(h.$('history-duplicate-state').textContent,/已保留各篇/);
  await type(h,h.$('markdown-editor').value.replace('相关文章推荐：','相关文章推荐：\n\n我加的正文'));
  assert.equal(h.state.relatedArticles.footer.detached,true);const untouched = h.$('markdown-editor').value;
  const first = displayTitleInput(h,0);first.value = '只改索引标题';await first.dispatch('change');
  assert.equal(h.$('markdown-editor').value,untouched);assert.equal(h.state.relatedArticles.items[0].displayTitle,'只改索引标题');
});

test('preflight warnings locate source text without changing it and never block copy or HTML export',async () => {
  const h = await harness();
  await type(h,`# ${'较长标题'.repeat(12)}\n\n![[缺失图片.png]]\n\n> 在这里填写引用文字\n\n*在这里填写图片说明*`);
  await importDirectory(h,[directoryFile('往期文章','甲.md','相同推荐','正文一'),directoryFile('往期文章','乙.md','相同推荐','正文二')]);
  await choose(h,0);await choose(h,1);const original = h.$('markdown-editor').value;
  await h.$('run-preflight').click();assert.equal(h.$('markdown-editor').value,original);assert.equal(h.$('preflight-panel').hidden,false);
  const types = new Set(h.$('preflight-results').children.map(row => row.dataset.checkType));
  for (const type of ['image-unavailable','placeholder','duplicate-recommendation','title-length']) assert.ok(types.has(type),type);
  const placeholderRow = h.$('preflight-results').children.find(row => row.dataset.checkType === 'placeholder');
  await placeholderRow.children[0].click();const editor = h.$('markdown-editor');
  assert.ok(editor.selectionEnd > editor.selectionStart);assert.match(editor.value.slice(editor.selectionStart,editor.selectionEnd),/在这里填写/);
  await h.$('copy-rich').click();await h.$('export-html').click();assert.equal(h.copied.length,1);assert.equal(h.downloads.length,1);
  assert.equal(editor.value,original);assert.ok(h.downloads[0].content.includes(h.copied[0].html));
  await type(h,original.replace('在这里填写引用文字','已经完成的引用').replace('在这里填写图片说明','已经完成的说明'));
  const edited = editor.value;await placeholderRow.children[0].click();assert.equal(editor.value,edited);
  assert.ok(!h.$('preflight-results').children.some(row => row.dataset.checkType === 'placeholder'));
  assert.match(h.$('notice').textContent,/已更新检查结果/);
  await h.$('close-preflight').click();assert.equal(h.$('preflight-panel').hidden,true);
});

test('presentation settings change preview, copy and HTML consistently, reset to theme defaults and persist in drafts',async () => {
  const h = await harness();await type(h,'# 当前标题\n\n当前正文');
  const change = async (id,value) => {h.$(id).value = value;await h.$(id).dispatch('change');};
  await change('article-font-size','18');await change('article-line-height','2');await change('article-accent-color','#123456');
  await change('preview-device','desktop');h.$('preview-scroll-sync').checked = false;await h.$('preview-scroll-sync').dispatch('change');
  assert.deepEqual(h.state.presentation,{fontSize:18,lineHeight:2,accentColor:'#123456',device:'desktop',scrollSync:false});
  await h.$('copy-rich').click();await h.$('export-html').click();
  assert.match(h.copied[0].html,/font-size:18px/);assert.match(h.copied[0].html,/line-height:2(?:;|")/);assert.ok(h.copied[0].html.includes('#123456'));
  assert.ok(h.$('preview').srcdoc.includes(h.copied[0].html));assert.ok(h.downloads[0].content.includes(h.copied[0].html));
  assert.ok(!h.downloads[0].content.includes('preview-device'));assert.ok(!h.downloads[0].content.includes('双向同步滚动'));
  await h.$('export-draft').click();const draft = JSON.parse(h.downloads[1].content);assert.deepEqual(draft.presentation,h.state.presentation);
  const restored = await harness({latest:draft});assert.deepEqual(restored.state.presentation,h.state.presentation);
  assert.equal(restored.$('article-font-size').value,'18');assert.equal(restored.$('preview-device').value,'desktop');assert.equal(restored.$('preview-scroll-sync').checked,false);
  await h.$('reset-presentation').click();assert.deepEqual(h.state.presentation,{fontSize:null,lineHeight:null,accentColor:null,device:'desktop',scrollSync:false});
  await h.$('copy-rich').click();assert.match(h.copied[1].html,/font-size:16px/);assert.match(h.copied[1].html,/line-height:1\.85/);
  await h.$('undo-edit').click();assert.equal(h.state.presentation.fontSize,18);assert.equal(h.state.presentation.accentColor,'#123456');
  const old = {...draft};delete old.presentation;await selectFiles(h,'draft-input',[file('旧草稿.json',JSON.stringify(old))]);
  assert.deepEqual(h.state.presentation,{fontSize:null,lineHeight:null,accentColor:null,device:'phone',scrollSync:true});
});

test('device widths stay real iframe widths, sync can be disabled, and preview reload preserves its own position safely',async () => {
  const calls = [],controller = {setEnabled:value => calls.push(['enabled',value]),
    refresh:options => calls.push(['refresh',options]),rebindPreview:(scroller,options) => calls.push(['rebind',scroller,options])};
  const h = await harness({scrollSyncFactory:options => {calls.push(['create',options]);return controller;}});
  const frame = h.$('preview'),editor = h.$('markdown-editor');
  assert.match(frame.attributes.style,/width:390px;max-width:none;flex:none/);
  for (const [device,width] of [['tablet',768],['desktop',1000],['phone',390]]) {
    h.$('preview-device').value = device;await h.$('preview-device').dispatch('change');
    assert.match(frame.attributes.style,new RegExp(`width:${width}px;max-width:none;flex:none`));
  }
  const scroller = {scrollHeight:1000,clientHeight:100,scrollTop:450},frameDoc = {scrollingElement:scroller},frameWindow = {};
  frame.contentDocument = frameDoc;frame.contentWindow = frameWindow;await frame.dispatch('load');
  const rebound = calls.findLast(call => call[0] === 'rebind');assert.equal(rebound[1],scroller);assert.equal(rebound[2].eventTarget,frameDoc);assert.equal(rebound[2].resizeTarget,frameWindow);
  editor.scrollTop = 123;h.$('preview-scroll-sync').checked = false;await h.$('preview-scroll-sync').dispatch('change');
  const beforeCalls = calls.length;h.$('preview-device').value = 'tablet';await h.$('preview-device').dispatch('change');
  assert.ok(!calls.slice(beforeCalls).some(call => call[0] === 'refresh'));assert.equal(editor.scrollTop,123);
  await type(h,'# 新正文\n\n重新渲染');await h.$('copy-rich').click();
  const nextScroller = {scrollHeight:1800,clientHeight:200,scrollTop:0};frame.contentDocument = {scrollingElement:nextScroller};await frame.dispatch('load');
  assert.equal(nextScroller.scrollTop,800);assert.equal(editor.scrollTop,123);
  let assignments = 0,srcdoc = frame.srcdoc;Object.defineProperty(frame,'srcdoc',{get:() => srcdoc,set:value => {srcdoc = value;assignments++;},configurable:true});
  await h.$('copy-rich').click();await h.$('export-html').click();assert.equal(assignments,0,'identical rendering never reloads the iframe');
  frame.contentDocument = null;await frame.dispatch('load');assert.equal(calls.findLast(call => call[0] === 'rebind')[1],null);
});

test('layout settings and preflight copy clearly describe simulation and warning limits without enabling iframe scripts',async () => {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  const styles = await readFile(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(html,/模拟阅读宽度/);assert.match(html,/不代表真实设备或微信效果/);assert.match(html,/按位置近似同步/);
  assert.match(html,/不是微信官方规则或内容审核/);assert.match(html,/不会阻止复制或导出/);
  assert.match(html,/sandbox="allow-same-origin"/);assert.ok(!html.includes('allow-scripts'));
  assert.match(html,/connect-src 'none'/);
  assert.match(styles,/\.preview-pane #preview\{box-sizing:content-box\}/);
});
