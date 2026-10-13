import test from 'node:test';
import assert from 'node:assert/strict';
import {copyRichText} from '../clipboard.mjs';
import {insertMarkdownAtSelection, pathsForSelectedDirectory, sniffRasterMime, wrapArticleHtml} from '../app.mjs';

test('rich copy writes both HTML and plain text without touching DOM',async () => {
  let written;
  class Item {constructor(data){this.data=data;}}
  const result = await copyRichText({html:'<p>你好<img src="data:image/png;base64,AA=="></p>',text:'你好',
    clipboard:{write:async items => {written=items;}},ClipboardItemCtor:Item,documentRef:null});
  assert.equal(result.method,'clipboard');
  assert.equal(written.length,1);
  assert.deepEqual(Object.keys(written[0].data),['text/html','text/plain']);
  assert.equal(written[0].data['text/html'].type,'text/html');
  assert.match(await written[0].data['text/html'].text(),/data:image\/png/);
  assert.equal(await written[0].data['text/plain'].text(),'你好');
});

function fakeDom(copyResult = true) {
  let removed = false, copied = false, restored;
  const originalRange = {cloneRange:() => ({saved:true})};
  const selection = {rangeCount:1,getRangeAt:() => originalRange,
    removeAllRanges(){this.rangeCount=0;},addRange(range){this.range=range;this.rangeCount++;}};
  const active = {selectionStart:3,selectionEnd:6,selectionDirection:'backward',
    focus(){this.focused=true;},setSelectionRange(...values){restored=values;}};
  const holder = {style:{},setAttribute(){},focus(){},remove(){removed=true;}};
  const documentRef = {activeElement:active,body:{appendChild(element){assert.equal(element,holder);}},
    createElement:() => holder,createRange:() => ({selectNodeContents(element){assert.equal(element,holder);}}),
    execCommand(command){assert.equal(command,'copy');copied=true;return copyResult;}};
  return {documentRef,selection,active,holder,get removed(){return removed;},get copied(){return copied;},get restored(){return restored;}};
}

test('rejected modern clipboard uses selection fallback and restores cursor',async () => {
  const dom = fakeDom();
  class Item {constructor(data){this.data=data;}}
  const result = await copyRichText({html:'<p>正文</p>',text:'正文',ClipboardItemCtor:Item,
    clipboard:{write:async () => {throw new Error('Denied');}},documentRef:dom.documentRef,selection:dom.selection});
  assert.equal(result.method,'selection');assert.equal(dom.holder.innerHTML,'<p>正文</p>');
  assert.equal(dom.copied,true);assert.equal(dom.removed,true);assert.equal(dom.active.focused,true);
  assert.deepEqual(dom.restored,[3,6,'backward']);assert.equal(dom.selection.range.saved,true);
});

test('failed fallback still removes the temporary element and restores cursor',async () => {
  const dom = fakeDom(false);
  await assert.rejects(copyRichText({html:'<p>x</p>',text:'x',clipboard:null,ClipboardItemCtor:null,
    documentRef:dom.documentRef,selection:dom.selection}),/拒绝复制/);
  assert.equal(dom.removed,true);assert.deepEqual(dom.restored,[3,6,'backward']);
});

test('unavailable clipboard clearly requests HTML export',async () => {
  await assert.rejects(copyRichText({html:'<p>x</p>',text:'x',clipboard:null,ClipboardItemCtor:null,
    documentRef:null,selection:null}),/导出 HTML/);
});

test('actual-image insertion replaces only current selection and keeps following text',() => {
  const result=insertMarkdownAtSelection('开头\n待替换\n结尾',3,6,'![[__pasted__/a.png|图片]]');
  assert.equal(result.value,'开头\n![[__pasted__/a.png|图片]]\n结尾');
  assert.equal(result.cursor,3+'![[__pasted__/a.png|图片]]'.length);
  const next=insertMarkdownAtSelection(result.value,result.cursor,result.cursor,'\n第二张');
  assert.match(next.value,/图片\]\]\n第二张\n结尾$/);
  assert.equal(insertMarkdownAtSelection('abc',-20,50,'X').value,'X');
});

test('directory root is removed once, while Chinese spaces and relative names survive',() => {
  const files=[{name:'图片 一.png',webkitRelativePath:'Example Vault/附件/图片 一.png',size:9,type:'image/png'},
    {name:'文章.md',webkitRelativePath:'Example Vault/文章/文章.md',size:2,type:'text/markdown'}];
  const entries=pathsForSelectedDirectory(files);
  assert.deepEqual(entries.map(e=>e.path),['附件/图片 一.png','文章/文章.md']);
  assert.equal(entries[0].file,files[0]);
  assert.equal(pathsForSelectedDirectory([{name:'普通图.png'}])[0].path,'普通图.png');
});

test('raster signature sniffer rejects renamed SVG and accepts supported signatures',() => {
  assert.equal(sniffRasterMime(Uint8Array.of(137,80,78,71,13,10,26,10)),'image/png');
  assert.equal(sniffRasterMime(Uint8Array.of(255,216,255,224)),'image/jpeg');
  assert.equal(sniffRasterMime(new TextEncoder().encode('GIF89a____')),'image/gif');
  assert.equal(sniffRasterMime(new TextEncoder().encode('RIFF____WEBP____')),'image/webp');
  assert.equal(sniffRasterMime(new TextEncoder().encode('<svg onload="alert(1)"></svg>')),null);
  assert.equal(sniffRasterMime(new Uint8Array()),null);
});

test('standalone HTML export is self-contained and CSP blocks remote fetches and scripts',() => {
  const html=wrapArticleHtml('<section style="color:#123"><img src="data:image/png;base64,AA=="></section>','<文章>');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html,/default-src 'none'; img-src data:/);
  assert.match(html,/<title>&lt;文章&gt;<\/title>/);
  assert.match(html,/data:image\/png/);
});
