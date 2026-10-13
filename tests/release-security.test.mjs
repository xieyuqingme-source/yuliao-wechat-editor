import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {parseImageReferences, renderArticle, buildImageIndex} from '../core.mjs';
import {validateDraft} from '../drafts.mjs';

const markdownFactory = createRequire(import.meta.url)('../vendor/markdown-it.cjs');
const draft = assets => ({format:'xieyuliao-draft',version:1,markdown:'原正文',assets});
const image = path => ({path,dataURL:'data:image/png;base64,AA=='});

test('unclosed brackets, repeated wiki openers and backslash runs use bounded scans', () => {
  const cases = ['['.repeat(200_000),'![[x'.repeat(50_000),'\\'.repeat(200_000) + '![[图.png]]',
    '[x]('.repeat(25_000),'!['.repeat(100_000)];
  const start = performance.now();
  for (const source of cases) {
    const refs = parseImageReferences(source);
    assert.ok(refs.length <= 1);
    if (source.includes('图.png')) assert.equal(refs[0]?.target,'图.png');
  }
  // A coarse ceiling catches the former quadratic implementation, not machine speed variations.
  assert.ok(performance.now() - start < 5000,'pathological reference scan exceeded five seconds');
});

test('deep balanced labels and destinations preserve the actual image and UTF16 offsets', () => {
  const label = '配图' + '['.repeat(10_000) + '标签' + ']'.repeat(10_000);
  const target = '图' + '('.repeat(10_000) + 'x' + ')'.repeat(10_000) + '.png';
  const source = '正文😀\n![' + label + '](' + target + ')\n末尾';
  const refs = parseImageReferences(source);
  assert.equal(refs.length,1);assert.ok(refs[0].target === target);assert.ok(refs[0].alt === label);
  assert.equal(source.slice(refs[0].start,refs[0].end),refs[0].raw);
});

test('malformed overlapping angle destinations stop with a clear error without truncating source', () => {
  const source = '[x](< '.repeat(2000), original = source;
  assert.throws(() => parseImageReferences(source),/语法过于复杂.*正文未被截断/);
  assert.equal(source,original);
});

test('many different backtick runs retain code masks without repeated searches', () => {
  const source = Array.from({length:400},(_,i) => '`'.repeat(i+1) + '![[代码.png]]').join(' ')
    + '\n\n![[正文.png]]';
  const start = performance.now();
  const first = parseImageReferences(source), second = parseImageReferences(source);
  assert.deepEqual(second,first);assert.equal(first.at(-1)?.target,'正文.png');
  assert.ok(performance.now() - start < 5000);
});

test('nested quote, angle, escaped delimiter and escaped initial code runs remain compatible', () => {
  const cases = [
    ['![图](<中文 图片.png>)','中文 图片.png'],
    ['![图](图(a(b)).png "title with )")','图(a(b)).png'],
    ['![图](图\\(a\\).png)','图(a).png'],
    ['[![图](图.png)](https://example.com/ "![[私有.png]]")','图.png'],
    ['\\``![[代码.png]]` ![[正文.png]]','正文.png'],
  ];
  for (const [source,target] of cases) assert.equal(parseImageReferences(source).at(-1)?.target,target);
});

test('large image-reference rendering expands each marker once and keeps literal marker text inert', () => {
  const refs = Array.from({length:2000},(_,i) => `![[missing-${i}.png]]`).join('\n\n');
  const literals = 'XYLLOCALIMAGE0X1END XYLLOCALIMAGE1X1END XYLLOCALIMAGE' + 'X'.repeat(50_000);
  const source = literals + '\n\n' + refs, original = source;
  const start = performance.now(), rendered = renderArticle(source,{markdownFactory});
  assert.equal(rendered.issues.length,2000);assert.equal(rendered.images.length,2000);
  assert.ok(rendered.html.includes(literals));assert.ok(rendered.html.includes('missing-1999.png'));
  assert.equal(source,original);assert.ok(performance.now() - start < 5000);
});

test('renderer factory receives the fixed HTML and link options and hostile input stays inert', () => {
  let received;
  const factory = options => {received = options;return markdownFactory(options);};
  const source = '<script>bad()</script>\n<img src="https://example.com/tracker">\n\n'
    + '[bad](javascript:alert(1))\n\n[entity](java&#x73;cript:alert(1))\n\n[file](file:///X:/private)\n\nhttps://example.com/';
  const rendered = renderArticle(source,{markdownFactory:factory});
  assert.deepEqual(received,{html:false,linkify:false,typographer:false,breaks:true});
  assert.doesNotMatch(rendered.html,/<script|<img|href="(?:javascript:|file:|https:\/\/example.com\/)/i);
  assert.match(rendered.html,/&lt;script&gt;/);
});

test('unselected local draft data cannot enter current HTML', () => {
  const source = '当前文章 ![[public.png]]';
  const rendered = renderArticle(source,{markdownFactory,index:buildImageIndex([{path:'public.png'},{path:'unused-private.png'}]),
    assetData:new Map([['public.png','data:image/png;base64,AA=='],['unused-private.png','data:image/png;base64,U0VDUkVU']])});
  assert.match(rendered.html,/base64,AA==/);assert.doesNotMatch(rendered.html,/unused-private|U0VDUkVU/);
});

test('empty image payloads are rejected while old nonempty version1 drafts retain exact source', () => {
  for (const dataURL of ['data:image/png;base64,','data:image/png;base64,=','data:image/png;base64,==']) {
    assert.throws(() => validateDraft(draft([{path:'x.png',dataURL}])),/不受支持/);
  }
  const original = {...draft([image('图.png')]),markdown:'---\ntitle: 属性\n---\n正文'};
  const restored = validateDraft(original);
  assert.equal(restored.markdown,original.markdown);assert.deepEqual(restored.assets,original.assets);
  assert.equal(restored.format,'xieyuliao-draft');assert.equal(restored.version,1);
});

test('large draft membership stays linear while preserving duplicate-path ambiguity and appending uncached assets', () => {
  const assets = Array.from({length:20_000},(_,i) => image(`图片/${i}.png`));
  const indexedFiles = assets.map(({path}) => ({path}));
  indexedFiles.push({path:assets[0].path});
  const input = {...draft(assets),indexedFiles}, start = performance.now();
  const restored = validateDraft(input);
  assert.equal(restored.assets.length,20_000);assert.equal(restored.indexedFiles.length,20_001);
  assert.equal(restored.indexedFiles.filter(entry => entry.path === assets[0].path).length,2);
  assert.ok(performance.now() - start < 3000,'draft membership exceeded three seconds');
  const appended = validateDraft({...draft([image('追加.png')]),indexedFiles:[{path:'已有.png'}]});
  assert.deepEqual(appended.indexedFiles.map(entry => entry.path),['已有.png','追加.png']);
  assert.equal(input.indexedFiles.length,20_001);
});

test('draft count limits are checked before asset normalization and after index merging', () => {
  assert.throws(() => validateDraft(draft(Array(100_001).fill(null))),/10 万/);
  const indexedFiles = Array.from({length:100_000},(_,i) => ({path:`${i}.png`}));
  assert.throws(() => validateDraft({...draft([image('extra.png')]),indexedFiles}),/10 万/);
});

test('five MiB ASCII entries and older multi-byte drafts restore exact body and version1 shape', () => {
  const ascii = 'a'.repeat(5_100_000), original = {...draft([]),markdown:ascii};
  const restored = validateDraft(JSON.parse(JSON.stringify(original)));
  assert.ok(restored.markdown === ascii);assert.equal(restored.version,1);assert.equal(restored.assets.length,0);
  const chinese = '文'.repeat(2_000_000);
  assert.ok(new TextEncoder().encode(chinese).byteLength > 5 * 1024 * 1024);
  assert.ok(validateDraft({...draft([]),markdown:chinese}).markdown === chinese);
  assert.throws(() => validateDraft({...draft([]),markdown:'a'.repeat(5 * 1024 * 1024 + 1)}),/5,242,880 个字符/);
});
