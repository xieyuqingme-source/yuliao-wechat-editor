import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizePath, buildImageIndex, parseImageReferences, resolveImage, prepareSource, renderArticle, isSafeImageData, THEMES } from '../core.mjs';

const require = createRequire(import.meta.url);
const markdownFactory = require('../vendor/markdown-it.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const ref = target => ({ kind: 'obsidian', target });
const mdRef = target => ({ kind: 'markdown', target });
const records = [
  { path: '附件/中文 图片.png' }, { path: '文章/同位图.png' },
  { path: '附件/重名.png' }, { path: '另一处/重名.png' }, { path: '__pasted__/实际粘贴.png' },
];
const index = buildImageIndex(records);
const assetData = new Map(records.map(record => [record.path, PNG]));
const options = { index, articlePath: '文章/文章.md', assetData, markdownFactory };

test('normalizes literal Chinese, Unicode, Windows separators and relative segments', () => {
  assert.equal(normalizePath('附件\\子目录\\..\\中文%20图片.png'), '附件/中文%20图片.png');
  assert.equal(normalizePath('文章/../附件/图.png'), '附件/图.png');
  assert.equal(normalizePath('X:\\Example Vault\\附件\\图.png'), 'X:/Example Vault/附件/图.png');
  assert.equal(normalizePath('../图.png'), '../图.png');
  assert.equal(normalizePath('图%ZZ.png'), '图%ZZ.png');
  assert.equal(normalizePath('e\u0301.png'), 'é.png');
});

test('parse Obsidian names, directory paths, dimensions and aliases', () => {
  const refs = parseImageReferences('前文 ![[附件/中文 图片.png|320x180]] 中间 ![[同位图.png|240]] 后文 ![[图.png|图说]]');
  assert.equal(refs.length, 3);
  assert.equal(refs[0].target, '附件/中文 图片.png');
  assert.equal(refs[0].width, 320);
  assert.equal(refs[0].height, 180);
  assert.equal(refs[1].width, 240);
  assert.equal(refs[2].alt, '图说');
  for (const item of refs) assert.equal(item.raw, ('前文 ![[附件/中文 图片.png|320x180]] 中间 ![[同位图.png|240]] 后文 ![[图.png|图说]]').slice(item.start, item.end));
});

test('parse standard Markdown local images with spaces, angles, encoding and backslashes', () => {
  const source = '![说明](../附件/中文 图片.png "标题")\n![](<../附件/中文 图片.png>)\n![](../附件/中文%20图片.png)\n![](..\\附件\\中文 图片.png)';
  const refs = parseImageReferences(source);
  assert.equal(refs.length, 4);
  assert.equal(refs[0].alt, '说明');
  assert.equal(refs[0].target, '../附件/中文 图片.png');
  assert.equal(refs[1].target, '../附件/中文 图片.png');
  for (const item of refs) assert.equal(resolveImage(item, { index, articlePath: options.articlePath }).path, '附件/中文 图片.png');
});

test('parse balanced and escaped parentheses in names and reference-style images', () => {
  const refs = parseImageReferences('![](图(1).png) ![](图\\(2\\).png)\n![配图][id]\n![id][]\n![id]\n[id]: <附件/中文 图片.png> "图题"');
  assert.equal(refs.length, 5);
  assert.equal(refs[0].target, '图(1).png');
  assert.equal(refs[1].target, '图(2).png');
  assert.equal(refs[2].target, '附件/中文 图片.png');
  assert.equal(refs[3].target, refs[4].target);
});

test('skip escaped references, fenced code, inline code and indented examples', () => {
  const source = '\\![[不读1.png]]\n`![[不读2.png]]`\n`` ![](不读3.png) ``\n\n```md\n![[不读4.png]]\n```\n\n    ![[不读5.png]]\n\n真实 ![[同位图.png]]';
  const refs = parseImageReferences(source);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, '同位图.png');
});

test('do not mask a fence-looking inline paragraph or unmatched backticks', () => {
  const refs = parseImageReferences('正文 ` 未闭合 ![[同位图.png]]\n~~~~\n![[代码图片.png]]\n~~~~\n![[附件/中文 图片.png]]');
  assert.deepEqual(refs.map(item => item.target), ['同位图.png', '附件/中文 图片.png']);
});

test('nested quote/list code fences and multiline inline code never read example images', () => {
  const source = '> ```md\n> ![[引用代码.png]]\n> ```\n\n- ```md\n  ![[列表代码.png]]\n  ```\n\n跨行 `示例\n![[行内代码.png]]`\n\n![[同位图.png]]';
  assert.deepEqual(parseImageReferences(source).map(item => item.target), ['同位图.png']);
  const rendered = renderArticle(source, options);
  assert.equal(rendered.images.length, 1);
  assert.match(rendered.html, /!\[\[引用代码.png\]\]/);
  assert.match(rendered.html, /!\[\[列表代码.png\]\]/);
  assert.match(rendered.html, /!\[\[行内代码.png\]\]/);
});

test('resolve unique wiki basename and exact directory case-insensitively', () => {
  assert.equal(resolveImage(ref('中文 图片.png'), { index }).path, '附件/中文 图片.png');
  assert.equal(resolveImage(mdRef('附件/中文%20图片.png'), { index }).path, '附件/中文 图片.png');
  assert.equal(resolveImage(ref('附件/中文%20图片.png'), { index }).status, 'missing');
  assert.equal(resolveImage(ref('LOGO.PNG'), { index: buildImageIndex([{ path: '附件/logo.png' }]) }).path, '附件/logo.png');
});

test('selected literal percent filenames remain distinct from spaces and directories', () => {
  const percentIndex = buildImageIndex([
    { path: '附件/图 片.png' }, { path: '附件/图%20片.png' },
    { path: '附件/图%2F片.png' }, { path: '附件/图/片.png' },
  ]);
  assert.equal(percentIndex.files.size, 4);
  assert.equal(percentIndex.duplicatePaths.size, 0);
  assert.equal(resolveImage(ref('图 片.png'), { index: percentIndex }).path, '附件/图 片.png');
  assert.equal(resolveImage(ref('图%20片.png'), { index: percentIndex }).path, '附件/图%20片.png');
  assert.equal(resolveImage(ref('图%2F片.png'), { index: percentIndex }).path, '附件/图%2F片.png');
  assert.equal(resolveImage(ref('附件/图/片.png'), { index: percentIndex }).path, '附件/图/片.png');
});

test('Markdown URI destinations decode exactly once, including encoded slashes', () => {
  const percentIndex = buildImageIndex([
    { path: '附件/图 片.png' }, { path: '附件/图%20片.png' },
    { path: '附件/图%2F片.png' }, { path: '附件/图/片.png' },
  ]);
  assert.equal(resolveImage(mdRef('附件/图%20片.png'), { index: percentIndex }).path, '附件/图 片.png');
  assert.equal(resolveImage(mdRef('附件/图%2520片.png'), { index: percentIndex }).path, '附件/图%20片.png');
  assert.equal(resolveImage(mdRef('附件/图%252F片.png'), { index: percentIndex }).path, '附件/图%2F片.png');
  assert.equal(resolveImage(mdRef('附件/图%2F片.png'), { index: percentIndex }).path, '附件/图/片.png');
  assert.equal(resolveImage(mdRef('..%2F附件%2F图%2520片.png'), { index: percentIndex, articlePath: '文章/文章.md' }).path, '附件/图%20片.png');
});

test('literal percent files cannot impersonate a missing space filename or directory path', () => {
  const literalIndex = buildImageIndex([{ path: '附件/图%20片.png' }, { path: '附件/图%2F片.png' }, { path: '其他/片.png' }]);
  assert.equal(resolveImage(ref('图 片.png'), { index: literalIndex }).status, 'missing');
  assert.equal(resolveImage(mdRef('附件/图%20片.png'), { index: literalIndex }).status, 'missing');
  assert.equal(resolveImage(ref('附件/图/片.png'), { index: literalIndex }).status, 'missing');
  assert.equal(resolveImage(mdRef('图%2F片.png'), { index: literalIndex }).status, 'missing');
  assert.equal(resolveImage(mdRef('错误%2F片.png'), { index: literalIndex }).status, 'missing');
  assert.equal(resolveImage(mdRef('附件/图%2520片.png'), { index: literalIndex }).path, '附件/图%20片.png');
});

test('wiki basename ambiguity includes every candidate and requires an explicit path', () => {
  const result = resolveImage(ref('重名.png'), { index, articlePath: '附件/原稿.md' });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates, ['附件/重名.png', '另一处/重名.png']);
  assert.equal(resolveImage(ref('附件/重名.png'), { index }).path, '附件/重名.png');
});

test('standard Markdown references resolve relative to the known article directory', () => {
  assert.equal(resolveImage(mdRef('同位图.png'), options).path, '文章/同位图.png');
  assert.equal(resolveImage(mdRef('../附件/中文 图片.png'), options).path, '附件/中文 图片.png');
  assert.equal(resolveImage(mdRef('../附件/重名.png'), options).path, '附件/重名.png');
});

test('explicit wrong relative paths never guess a same-named image elsewhere', () => {
  for (const target of ['../不存在/中文 图片.png', './附件/中文 图片.png', '中文 图片.png']) {
    assert.equal(resolveImage(mdRef(target), options).status, 'missing');
  }
  assert.equal(resolveImage(ref('不存在/中文 图片.png'), options).status, 'missing');
  assert.equal(resolveImage(ref('../../附件/中文 图片.png'), { index }).status, 'missing');
});

test('same canonical path containing different selected files is ambiguous', () => {
  const fileA = { size: 10 }, fileB = { size: 11 };
  const duplicate = buildImageIndex([{ path: '附件/图片.png', file: fileA }, { path: '附件\\图片.png', file: fileB }]);
  assert.equal(duplicate.duplicatePaths.size, 1);
  assert.equal(resolveImage(ref('附件/图片.png'), { index: duplicate }).status, 'ambiguous');
  const repeated = buildImageIndex([{ path: '附件/图片.png', file: fileA }, { path: '附件/图片.png', file: fileA }]);
  assert.equal(repeated.all.length, 1);
  assert.equal(resolveImage(ref('图片.png'), { index: repeated }).status, 'matched');
});

test('missing image has a specific actionable issue', () => {
  const result = resolveImage(ref('缺图.png'), { index });
  assert.equal(result.status, 'missing');
  assert.match(result.message, /缺图.png/);
  assert.match(result.message, /附件目录/);
});

test('block remote images, unknown protocols, control characters and SVG', () => {
  for (const target of ['https://example.com/私人.png', 'http://example.com/a.png', '//example.com/a.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,ABC', 'file:///D:/a.png', '图.svg', '图.SVG#x', 'a\u0000.png']) {
    assert.equal(resolveImage(ref(target), { index }).status, 'blocked', target);
  }
  assert.equal(resolveImage(ref('图.png'), { index: buildImageIndex([{ path: '图.png', type: 'image/svg+xml' }]) }).status, 'blocked');
});

test('frontmatter is preserved by default and only the complete initial block can be stripped', () => {
  const source = '\uFEFF---\r\ntitle: 谢雨聊\r\ntags: [随笔]\r\n---\r\n# 正文\r\n\r\n---\r\n正文分隔线之后';
  assert.equal(prepareSource(source).source, source);
  const cleaned = prepareSource(source, { stripFrontmatter: true });
  assert.equal(cleaned.removedFrontmatter, true);
  assert.equal(cleaned.source, '# 正文\r\n\r\n---\r\n正文分隔线之后');
  assert.equal(prepareSource('---\ntitle: 未闭合\n正文', { stripFrontmatter: true }).removedFrontmatter, false);
  assert.equal(prepareSource('---\n---\n正文', { stripFrontmatter: true }).source, '正文');
  assert.equal(prepareSource('正文\n---\ntitle: 内容\n---', { stripFrontmatter: true }).source, '正文\n---\ntitle: 内容\n---');
});

test('render keeps every image at its source position with inline styles and data', () => {
  const result = renderArticle('先写第一段。\n\n![[附件/中文 图片.png|320x180]]\n\n再写第二段。\n\n![同位图](同位图.png)\n\n结尾。', options);
  assert.equal(result.issues.length, 0);
  assert.equal(result.images.length, 2);
  assert.ok(result.images.every(image => image.status === 'matched' && image.hasData));
  const first = result.html.indexOf('<img'), second = result.html.indexOf('<img', first + 1);
  assert.ok(result.html.indexOf('第一段') < first);
  assert.ok(first < result.html.indexOf('第二段'));
  assert.ok(result.html.indexOf('第二段') < second);
  assert.ok(second < result.html.indexOf('结尾'));
  assert.match(result.html, /width="320" height="180"/);
  assert.match(result.html, /max-height:180px/);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.match(result.html, /^<section style=/);
  assert.doesNotMatch(result.html, /XYLLOCALIMAGE/);
});

test('missing and ambiguous placeholders preserve location and source', () => {
  const source = '前文\n\n![[缺图.png]]\n\n中间\n\n![[重名.png]]\n\n后文';
  const result = renderArticle(source, options);
  assert.deepEqual(result.issues.map(item => item.status), ['missing', 'ambiguous']);
  assert.equal(result.source, source);
  assert.ok(result.html.indexOf('前文') < result.html.indexOf('未找到图片'));
  assert.ok(result.html.indexOf('未找到图片') < result.html.indexOf('中间'));
  assert.ok(result.html.indexOf('中间') < result.html.indexOf('2 个候选'));
  assert.ok(result.html.indexOf('2 个候选') < result.html.indexOf('后文'));
  assert.doesNotMatch(result.html, /<img/);
});

test('unread and unsupported image assets get placeholders, never a local or network src', () => {
  const result = renderArticle('![[附件/中文 图片.png]]', { ...options, assetData: new Map() });
  assert.equal(result.issues[0].status, 'asset-unavailable');
  assert.equal(result.images[0].hasData, false);
  const unsafe = renderArticle('![[附件/中文 图片.png]]', { ...options, assetData: { '附件/中文 图片.png': 'data:image/svg+xml;base64,PHN2Zz4=' } });
  assert.equal(unsafe.issues[0].status, 'asset-unavailable');
  assert.doesNotMatch(unsafe.html, /<img/);
});

test('three themes inline headings, paragraphs, list, quote, table and code styles', () => {
  const article = '# 标题\n\n## 二级\n\n正文 **重点** 与 `代码`。\n\n- 列表甲\n- 列表乙\n\n1. 步骤\n\n> 引用\n\n| 项目 | 数值 |\n| :-- | --: |\n| 例子 | 1 |\n\n```js\nconst x = "<safe>";\n```\n\n---';
  const outputs = THEMES.map(theme => renderArticle(article, { ...options, theme: theme.id }).html);
  assert.equal(new Set(outputs).size, 3);
  for (const html of outputs) {
    for (const tag of ['h1', 'h2', 'p', 'strong', 'ul', 'ol', 'li', 'blockquote', 'table', 'th', 'td', 'code', 'pre', 'hr']) assert.match(html, new RegExp(`<${tag}[^>]*style=`), tag);
    assert.match(html, /&lt;safe&gt;/);
    assert.match(html, /list-style-type:disc/);
    assert.match(html, /text-align:right/);
    assert.doesNotMatch(html, /<style|<link|class="hljs/);
  }
});

test('repeated render is deterministic and does not mutate source, index or options', () => {
  const source = 'XYLLOCALIMAGE0END\n\n![[附件/中文 图片.png]]';
  const before = index.all.map(record => record.path);
  const first = renderArticle(source, options), second = renderArticle(source, options);
  assert.equal(first.html, second.html);
  assert.equal(first.source, source);
  assert.deepEqual(index.all.map(record => record.path), before);
  assert.match(first.html, /XYLLOCALIMAGE0END/);
  assert.equal((first.html.match(/<img/g) || []).length, 1);
});

test('raw HTML and hostile protocols cannot execute or load remote content', () => {
  const source = '<script>alert(1)</script>\n<img src="https://example.com/a" onerror="alert(1)">\n\n[坏链接](javascript:alert(1))\n\n[本地程序](file:///C:/a.exe)\n\n![](https://example.com/a.png)\n\n[正常](https://example.com/)';
  const result = renderArticle(source, options);
  assert.doesNotMatch(result.html, /<script|<img|href="javascript:|href="file:/i);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /href="https:\/\/example.com\/"/);
  assert.equal(result.issues[0].status, 'blocked');
});

test('image-like text in normal link destinations and titles stays in safe attributes', () => {
  for (const source of [
    '[外部链接](https://example.com/![[图.png]])',
    '[link](https://example.com "![[图.png]]")',
    '[link](https://example.com "![[图(1.png]]")',
  ]) {
    assert.equal(parseImageReferences(source).length, 0);
    const result = renderArticle(source, { ...options, index: buildImageIndex([{ path: '图.png' }]), assetData: new Map([['图.png', PNG]]) });
    assert.equal(result.images.length, 0);
    assert.equal(result.issues.length, 0);
    assert.doesNotMatch(result.html, /<img|<span/);
    assert.match(result.html, /<a /);
    assert.doesNotMatch(result.html, /(?:href|title)="[^"]*<(?:img|span)/);
  }
});

test('reference link definitions and autolinks cannot read image-like attribute text', () => {
  for (const source of [
    '[链接][id]\n\n[id]: https://example.com/![[图.png]] "![[同位图.png]]"',
    '[链接][id]\n\n[id]: https://example.com\n "![[图.png]]"',
    '<https://example.com/![[图.png]]>',
  ]) {
    const result = renderArticle(source, options);
    assert.equal(result.images.length, 0);
    assert.equal(result.issues.length, 0);
    assert.doesNotMatch(result.html, /<img|<span/);
    assert.match(result.html, /<a /);
  }
});

test('images in link labels remain content and render at their actual position', () => {
  const source = '前文\n\n[![[附件/中文 图片.png]]](https://example.com "链接图")\n\n后文';
  const result = renderArticle(source, options);
  assert.equal(result.images.length, 1);
  assert.equal(result.issues.length, 0);
  assert.match(result.html, /<a [^>]*><span [^>]*><img /);
  assert.ok(result.html.indexOf('前文') < result.html.indexOf('<img'));
  assert.ok(result.html.indexOf('<img') < result.html.indexOf('后文'));
  assert.doesNotMatch(result.html, /(?:href|title)="[^"]*<(?:img|span)/);
});

test('alt and path values cannot inject HTML or attributes', () => {
  const evilIndex = buildImageIndex([{ path: '图.png' }]);
  const result = renderArticle('![<script>alert(1)</script>](图.png)\n\n![[缺图<img>.png]]', { markdownFactory, index: evilIndex, assetData: new Map([['图.png', PNG]]) });
  assert.doesNotMatch(result.html, /<script|<img>/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /缺图&lt;img&gt;.png/);
});

test('safe data image types and invalid data formats are checked', () => {
  assert.equal(isSafeImageData(PNG), true);
  for (const value of ['https://x/a.png', 'data:text/html;base64,QQ==', 'data:image/svg+xml;base64,QQ==', 'data:image/png,<svg>', 'data:image/png;base64,QQ==" onerror="x', null]) assert.equal(isSafeImageData(value), false);
});

test('render works with object assetData, unknown theme fallback, and missing factory error', () => {
  const result = renderArticle('![[附件/中文 图片.png]]', { ...options, theme: 'unknown', assetData: Object.fromEntries(assetData) });
  assert.equal(result.theme, 'clear');
  assert.equal(result.issues.length, 0);
  assert.throws(() => renderArticle('文章', { markdownFactory: null }), /渲染器未加载/);
});

test('real synthetic Markdown and PNG files can be imported and embedded without changing the original', () => {
  const root = mkdtempSync(path.join(tmpdir(),'yuliao-import-test-'));
  try {
  const articleURL = path.join(root,'文章','文章.md'), imageURL = path.join(root,'附件','中文 图片.png');
  mkdirSync(path.dirname(articleURL), { recursive: true });
  mkdirSync(path.dirname(imageURL), { recursive: true });
  const original = '---\ntitle: 合成测试\n---\n# 谢雨聊\n\n图片前正文。\n\n![配图](../附件/中文%20图片.png)\n\n图片后正文。';
  writeFileSync(articleURL, original, 'utf8');
  writeFileSync(imageURL, Buffer.from(PNG.split(',')[1], 'base64'));
  const importedSource = readFileSync(articleURL, 'utf8');
  const importedImage = `data:image/png;base64,${readFileSync(imageURL).toString('base64')}`;
  const result = renderArticle(importedSource, { markdownFactory, articlePath: '文章/文章.md', stripFrontmatter: true, index: buildImageIndex([{ path: '附件/中文 图片.png' }]), assetData: new Map([['附件/中文 图片.png', importedImage]]) });
  assert.equal(result.issues.length, 0);
  assert.equal(result.removedFrontmatter, true);
  assert.match(result.html, /data:image\/png;base64,/);
  assert.equal(readFileSync(articleURL, 'utf8'), original);
  } finally {rmSync(root,{recursive:true,force:true});}
});
