import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startApp} from '../app.mjs';
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

async function harness({latest = null, confirm = true, scrollSyncFactory, previewLayoutFactory} = {}) {
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

test('the requested brand and contact footer are exact and the reference control is local and reversible',async () => {
  const html = await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/<title>雨聊公众号排版<\/title>/);
  assert.match(html,/<h1>雨聊公众号排版<\/h1>/);
  assert.match(html,/<footer><span>有问题请联系公众号谢雨聊<\/span>/);
  assert.ok(!html.includes('谢雨卿的写作工作台'));
  assert.match(html,/id="clean-reference-whitespace"[^>]*>清理参考资料行首空白/);
  assert.match(html,/仅参考区 · 可撤销 · 保留词间空格及必要缩进/);
  assert.match(html,/缩放不影响复制或导出/);
  assert.match(html,/sandbox="allow-same-origin"/);assert.ok(!html.includes('allow-scripts'));
  assert.match(html,/connect-src 'none'/);
  const css = await readFile(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(css,/grid-template-columns:minmax\(0,2fr\) minmax\(0,3fr\)/);
  assert.match(css,/@media\(max-width:950px\)[\s\S]*?\.workspace\{grid-template-columns:1fr\}/);
  assert.match(css,/\.preview-pane\{overflow:visible\}/);
  assert.match(css,/\.preview-pane \.phone-surround\{overflow:auto;/);
  assert.match(css,/\.preview-stage\{position:relative/);
  assert.match(css,/\.preview-stage\[data-fitted=true\]\{overflow:clip\}/);
});

test('all three real device widths fit the available pane, respond to resize and never change exported HTML',async () => {
  const geometry = {availableWidth:620,viewportHeight:590};let layout;
  const windowSurface = {listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},
    removeEventListener(type,fn){if (this.listeners.get(type) === fn) this.listeners.delete(type);}};
  const h = await harness({previewLayoutFactory:options => {
    layout = createPreviewLayout({...options,measure:() => geometry,windowTarget:windowSurface,
      ResizeObserverClass:null,requestFrame:fn => {fn();return null;}});return layout;
  }});
  await type(h,'# 正文\n\n这一段在预览、复制和导出中相同。');
  const frame = h.$('preview'),stage = h.$('preview-stage');
  for (const [device,width] of [['phone',390],['tablet',768],['desktop',1000]]) {
    h.$('preview-device').value = device;await h.$('preview-device').dispatch('change');
    const current = layout.getLayout();assert.equal(current.deviceWidth,width);assert.equal(frame.style.width,`${width}px`);
    assert.ok(current.displayWidth <= geometry.availableWidth + 1e-8);
    assert.equal(Number.parseFloat(stage.style.height),590);
    assert.ok(Math.abs((Number.parseFloat(frame.style.height) + 2) * current.scale - 590) < 1e-7);
    assert.match(h.$('preview-fit-state').textContent,new RegExp(`${width} px 阅读宽度`));
    await h.$('copy-rich').click();await h.$('export-html').click();
    assert.ok(h.$('preview').srcdoc.includes(h.copied.at(-1).html));
    assert.ok(h.downloads.at(-1).content.includes(h.copied.at(-1).html));
    assert.ok(!h.downloads.at(-1).content.includes('transform:scale'));
    assert.ok(!h.downloads.at(-1).content.includes('preview-stage'));
  }
  const html = h.copied.at(-1).html;
  geometry.availableWidth = 280;geometry.viewportHeight = 570;windowSurface.listeners.get('resize')();
  assert.equal(layout.getLayout().deviceWidth,1000);assert.ok(layout.getLayout().displayWidth <= 280 + 1e-8);
  assert.equal(Number.parseFloat(stage.style.height),570);
  assert.match(h.$('preview-fit-state').textContent,/28% 显示/);
  await h.$('copy-rich').click();assert.equal(h.copied.at(-1).html,html);
  geometry.availableWidth = 1200;geometry.viewportHeight = 660;windowSurface.listeners.get('resize')();
  assert.equal(layout.getLayout().scale,1);assert.equal(frame.style.width,'1000px');
  assert.equal(stage.style.width,'1002px');assert.equal(stage.style.height,'660px');
  // Theme or typography controls reapply geometry without losing the scale.
  geometry.availableWidth = 400;windowSurface.listeners.get('resize')();
  h.$('article-font-size').value = '18';await h.$('article-font-size').dispatch('change');
  assert.equal(frame.style.transform,`scale(${400 / 1002})`);
});

test('resize, image reflow and width changes preserve preview progress when synchronization is off',async () => {
  const geometry = {availableWidth:600,viewportHeight:590};let layout;
  const calls = [],controller = {setEnabled:value => calls.push(['enabled',value]),
    refresh:options => calls.push(['refresh',options]),rebindPreview:(scroller,options) => calls.push(['rebind',scroller,options])};
  const h = await harness({scrollSyncFactory:() => controller,previewLayoutFactory:options => {
    layout = createPreviewLayout({...options,measure:() => geometry,windowTarget:null,
      ResizeObserverClass:null,requestFrame:fn => {fn();return null;}});return layout;
  }});
  const frame = h.$('preview'),scroller = {scrollHeight:1800,clientHeight:200,scrollTop:800};
  const frameDoc = new Element(h.doc,'document');frameDoc.scrollingElement = scroller;
  frame.contentDocument = frameDoc;frame.contentWindow = {};
  await frame.dispatch('load');h.$('markdown-editor').scrollTop = 230;
  h.$('preview-scroll-sync').checked = false;await h.$('preview-scroll-sync').dispatch('change');
  // A user scroll establishes the preserved ratio; an image changes scroll extent.
  scroller.scrollTop = 400;await frameDoc.dispatch('scroll');
  scroller.scrollHeight = 3400;await frameDoc.dispatch('load');assert.equal(scroller.scrollTop,800);
  const beforeCalls = calls.length;
  geometry.availableWidth = 300;layout.refresh();
  h.$('preview-device').value = 'desktop';await h.$('preview-device').dispatch('change');
  assert.equal(scroller.scrollTop,800);assert.equal(h.$('markdown-editor').scrollTop,230);
  assert.ok(!calls.slice(beforeCalls).some(call => call[0] === 'refresh'));
  h.$('preview-scroll-sync').checked = true;await h.$('preview-scroll-sync').dispatch('change');
  const activeCalls = calls.length;geometry.availableWidth = 400;layout.refresh();await frameDoc.dispatch('load');
  assert.ok(calls.slice(activeCalls).some(call => call[0] === 'refresh' && call[1].preserveRatio === true));
});

test('an actual width and height reflow preserves the disabled preview ratio before applying the new geometry',async () => {
  const geometry = {availableWidth:600,viewportHeight:590};let layout,activeScroller = null;
  const h = await harness({previewLayoutFactory:options => {
    const values = options.frame.style;
    options.frame.style = new Proxy(values,{set(target,name,value) {
      target[name] = value;
      if (activeScroller && (name === 'width' || name === 'height')) {
        if (name === 'width') activeScroller.scrollHeight = 2_000_000 / Number.parseFloat(value);
        if (name === 'height') activeScroller.clientHeight = Number.parseFloat(value);
        activeScroller.scrollTop = Math.min(activeScroller.scrollTop,
          Math.max(0,activeScroller.scrollHeight - activeScroller.clientHeight));
      }
      return true;
    }});
    layout = createPreviewLayout({...options,measure:() => geometry,windowTarget:null,
      ResizeObserverClass:null,requestFrame:fn => {fn();return null;}});return layout;
  }});
  const frame = h.$('preview');activeScroller = {scrollHeight:2_000_000 / 390,
    clientHeight:Number.parseFloat(frame.style.height),scrollTop:0};
  const frameDoc = new Element(h.doc,'document');frameDoc.scrollingElement = activeScroller;
  frame.contentDocument = frameDoc;await frame.dispatch('load');
  h.$('preview-scroll-sync').checked = false;await h.$('preview-scroll-sync').dispatch('change');
  activeScroller.scrollTop = (activeScroller.scrollHeight - activeScroller.clientHeight) * 0.4;
  await frameDoc.dispatch('scroll');
  const assertRatio = () => assert.ok(Math.abs(activeScroller.scrollTop /
    (activeScroller.scrollHeight - activeScroller.clientHeight) - 0.4) < 1e-8);
  h.$('preview-device').value = 'desktop';await h.$('preview-device').dispatch('change');assertRatio();
  assert.equal(frame.style.width,'1000px');
  geometry.availableWidth = 400;layout.refresh();assertRatio();
  await h.$('undo-edit').click();assert.equal(frame.style.width,'390px');assertRatio();
  await h.$('redo-edit').click();assert.equal(frame.style.width,'1000px');assertRatio();
});

test('reference whitespace cleanup is one undoable edit with correct footer tracking and no whole-article trimming',async () => {
  const h = await harness();
  const article = '  正文 English  words\n\n**参考资料 / References: **\n\n  1. English  words [链接](https://example.com/a%20b)\n  2. Second reference\n\n```text\n  keep code\n```\n\n  1. Nested outer\n     - 必要嵌套缩进\n\n## 下一节\n\n  保留正文行首空白';
  await type(h,article);
  await importDirectory(h,[directoryFile('往期文章','相关.md','原始推荐标题')]);await choose(h,0);
  const before = h.$('markdown-editor').value,metadataBefore = structuredClone(h.state.relatedArticles);
  h.$('markdown-editor').setSelectionRange(before.indexOf('Second'),before.indexOf('Second') + 6);
  await h.$('clean-reference-whitespace').click();
  const after = h.$('markdown-editor').value;
  assert.ok(after.startsWith('  正文 English  words'));
  assert.match(after,/\n1\. English  words \[链接\]\(https:\/\/example.com\/a%20b\)/);
  assert.match(after,/\n2\. Second reference/);assert.ok(after.includes('  1. Nested outer\n     - 必要嵌套缩进'));
  assert.ok(after.includes('```text\n  keep code\n```'));assert.ok(after.includes('  保留正文行首空白'));
  assert.equal(h.state.relatedArticles.footer.detached,undefined);
  assert.ok(h.state.relatedArticles.footer.start < metadataBefore.footer.start);
  assert.match(h.$('notice').textContent,/2 行.*可撤销/);
  assert.equal(after.slice(h.$('markdown-editor').selectionStart,h.$('markdown-editor').selectionEnd),'Second');
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,before);assert.deepEqual(h.state.relatedArticles,metadataBefore);
  await h.$('redo-edit').click();assert.equal(h.$('markdown-editor').value,after);
  await h.$('copy-rich').click();await h.$('export-html').click();
  assert.ok(h.downloads[0].content.includes(h.copied[0].html));
  const p = h.copied[0].html;assert.match(p,/<ol[^>]*padding-left:20px/);
  assert.ok(p.includes('font-size:14px'));assert.ok(p.includes('font-size:16px'));
});

test('a repeated no-op cleanup adds no undo entry and typography of references and related titles follows body size',async () => {
  const h = await harness();await type(h,'正文\n\n## 参考资料\n\n  1. English  reference\n\n## 下一章\n\n正文列表\n\n1. 后文');
  await importDirectory(h,[directoryFile('文章','相关.md','相关标题')]);await choose(h,0);
  const before = h.$('markdown-editor').value;await h.$('clean-reference-whitespace').click();
  await h.$('clean-reference-whitespace').click();assert.match(h.$('notice').textContent,/没有可安全清理/);
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,before);
  await h.$('redo-edit').click();
  h.$('article-font-size').value = '18';await h.$('article-font-size').dispatch('change');
  await h.$('copy-rich').click();await h.$('export-html').click();
  const html = h.copied[0].html;assert.ok(html.includes('font-size:18px'));assert.ok(html.includes('font-size:15.75px'));
  assert.ok(h.$('preview').srcdoc.includes(html));assert.ok(h.downloads[0].content.includes(html));
  const source = h.$('markdown-editor').value;await h.$('export-draft').click();
  const draft = JSON.parse(h.downloads[1].content),restored = await harness({latest:draft});
  assert.equal(restored.$('markdown-editor').value,source);assert.equal(restored.state.presentation.fontSize,18);
  await type(h,'  没有参考标题的正文');await h.$('clean-reference-whitespace').click();
  assert.equal(h.$('markdown-editor').value,'  没有参考标题的正文');assert.match(h.$('notice').textContent,/未识别到参考资料区/);
  await h.$('undo-edit').click();assert.equal(h.$('markdown-editor').value,source,'no-op keeps the preceding real editor transaction');
});
