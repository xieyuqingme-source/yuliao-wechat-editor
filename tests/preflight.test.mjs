import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {checkArticle, TITLE_LENGTH_ADVICE} from '../preflight.mjs';
import {renderArticle, buildImageIndex} from '../core.mjs';
import {applyComponent, COMPONENTS} from '../components.mjs';
import {syncRelatedFooter} from '../history.mjs';
import {copyRichText} from '../clipboard.mjs';

const require = createRequire(import.meta.url);
const markdownFactory = require('../vendor/markdown-it.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const render = (source, options = {}) => renderArticle(source, {markdownFactory, ...options});
const check = (source, options = {}) => checkArticle({source, rendered: render(source, options), markdownFactory, ...options});
const ofType = (issues, type) => issues.filter(issue => issue.type === type);
const item = (id, title, extra = {}) => ({id, title, name: `${id}.md`, ...extra});

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

test('40 Unicode characters is an explanatory layout suggestion, never an official rule', () => {
  assert.equal(TITLE_LENGTH_ADVICE.threshold, 40);
  assert.match(TITLE_LENGTH_ADVICE.explanation, /排版建议/);
  assert.match(TITLE_LENGTH_ADVICE.explanation, /不是微信官方限制/);
  assert.equal(Object.isFrozen(TITLE_LENGTH_ADVICE), true);
  assert.deepEqual(checkArticle(), []);
});

test('missing image warnings retain the exact UTF-16 range of each occurrence', () => {
  const source = '😀前文\n\n![[缺失 图.png]]\n\n后文 ![[缺失 图.png|300]]\n';
  const issues = ofType(check(source), 'image-unavailable');
  assert.equal(issues.length, 2);
  assert.equal(source.slice(issues[0].start, issues[0].end), '![[缺失 图.png]]');
  assert.equal(source.slice(issues[1].start, issues[1].end), '![[缺失 图.png|300]]');
  assert.ok(issues[0].start < issues[1].start);
  assert.match(issues[0].message, /图片无法显示/);
});

test('stripped frontmatter image ranges are mapped back to the original editor offsets', () => {
  const source = '\uFEFF---\r\ntitle: 测试\r\nimage: ![[属性内的图.png]]\r\n---\r\n😀正文\r\n![[正文缺图.png]]';
  const issues = ofType(check(source, {stripFrontmatter: true}), 'image-unavailable');
  assert.equal(issues.length, 1);
  assert.equal(source.slice(issues[0].start, issues[0].end), '![[正文缺图.png]]');
  assert.equal(issues[0].start, source.indexOf('![[正文缺图.png]]'));
});

test('frontmatter kept in the renderer does not shift its image offsets', () => {
  const source = '---\ntitle: 笔记\n---\n\n![[图.png]]';
  const issues = ofType(check(source, {stripFrontmatter: false}), 'image-unavailable');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].start, source.indexOf('![[图.png]]'));
});

test('renderer removedFrontmatter is sufficient to recover offsets without repeated option', () => {
  const source = '---\ntitle: 文稿\n---\n\n![[图.png]]';
  const issues = checkArticle({source, rendered: render(source, {stripFrontmatter: true})});
  assert.equal(issues[0].start, source.indexOf('![[图.png]]'));
});

test('ambiguous names, unread files and unsafe/remote references warn without network reads', () => {
  const source = '![[重复.png]]\n\n![[坏图.png]]\n\n![远程](https://example.invalid/private.png)\n\n![不支持](data:image/svg+xml;base64,PHN2Zz4=)';
  const index = buildImageIndex([{path: 'A/重复.png'}, {path: 'B/重复.png'}, {path: '坏图.png'}]);
  const assetData = new Map([['坏图.png', 'data:image/png;base64,not-a-real-data-url!!']]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {throw new Error('Preflight must never access the network');};
  try {
    const issues = ofType(check(source, {index, assetData}), 'image-unavailable');
    assert.equal(issues.length, 4);
    assert.match(issues[0].message, /同名图片/);
    assert.match(issues[1].message, /尚未读取|不受支持/);
    assert.match(issues[2].message, /没有读取网络图片/);
    for (const issue of issues) assert.ok(source.slice(issue.start, issue.end).startsWith('!'));
  } finally {globalThis.fetch = originalFetch;}
});

test('available selected images and fenced image examples have no warning', () => {
  const source = '![[正常.png]]\n\n```md\n![[示例缺图.png]]\n```\n\n`![[行内示例.png]]`';
  const index = buildImageIndex([{path: '正常.png'}]);
  const assetData = new Map([['正常.png', PNG]]);
  assert.deepEqual(check(source, {index, assetData}), []);
});

test('malformed issue ranges are not used as editor selections', () => {
  const source = '正文';
  const issues = checkArticle({source, rendered: {issues: [
    {target: '找不到.png', start: -2, end: 999, status: 'missing'},
    {target: '另一个.png', start: 1.1, end: 2.2, status: 'blocked'}, null,
  ]}});
  assert.equal(issues.length, 2);
  for (const issue of issues) {assert.equal(issue.start, null); assert.equal(issue.end, null);}
});

test('fallback image positions consume repeated references individually', () => {
  const source = '![[图.png]]\n\n![[图.png]]';
  const issues = checkArticle({source, rendered: {issues: [
    {target: '图.png', status: 'missing'}, {target: '图.png', status: 'missing'},
  ]}});
  assert.equal(issues.length, 2);
  assert.equal(issues[0].start, 0);
  assert.equal(issues[1].start, source.lastIndexOf('![[图.png]]'));
});

test('all seven text-producing empty components warn and a divider does not', () => {
  for (const component of COMPONENTS) {
    const inserted = applyComponent({value: '既有正文', start: 4, end: 4}, component.id);
    const issues = ofType(check(inserted.value), 'placeholder');
    assert.equal(issues.length, component.id === 'divider' ? 0 : 1, component.id);
    if (issues[0]) assert.ok(inserted.value.slice(issues[0].start, issues[0].end).trim());
  }
});

test('components wrapping real selections have no empty placeholder warning', () => {
  for (const component of COMPONENTS) {
    const inserted = applyComponent({value: '真实文字', start: 0, end: 4}, component.id);
    assert.equal(ofType(check(inserted.value), 'placeholder').length, 0, component.id);
  }
});

test('rewriting a component placeholder clears its warning without altering other text', () => {
  const source = applyComponent({value: '', start: 0, end: 0}, 'important').value;
  assert.equal(ofType(check(source), 'placeholder').length, 1);
  const rewritten = source.replace('在这里填写重点提示', '请检查本地附件是否完整');
  assert.equal(ofType(check(rewritten), 'placeholder').length, 0);
  assert.equal(rewritten, '> **重点：** 请检查本地附件是否完整');
});

test('placeholder phrases mentioned in prose, changed text or inline examples are ignored', () => {
  const source = '这里介绍一级标题和二级标题。\n\n引用组件默认写着在这里填写引用文字，请替换。\n\n> 在这里填写引用文字，并保留后面的解释。\n\n*在这里填写图片说明（可选）*\n\n`# 一级标题`\n\n`在这里填写重点提示`';
  assert.equal(ofType(check(source), 'placeholder').length, 0);
});

test('ordinary heading terminology is not a component placeholder', () => {
  const source = '一级标题\n\n二级标题\n\n三级标题\n\n### 参考资料\n\n- 这是资料名称或作者，补充说明的写法';
  assert.equal(ofType(check(source), 'placeholder').length, 0);
});

test('fenced, indented, nested quote/list and multiline inline code examples are ignored', () => {
  const source = '```md\n# 一级标题\n> 在这里填写引用文字\n```\n\n    # 一级标题\n    在这里填写重点提示\n\n> ```md\n> **重点：** 在这里填写重点提示\n> ```\n\n- ~~~md\n  # 一级标题\n  ~~~\n\n`示例\n# 一级标题`\n\n# 真实标题';
  assert.equal(ofType(check(source), 'placeholder').length, 0);
});

test('frontmatter placeholder-looking values are ignored, whether stripped or retained', () => {
  const source = '---\nexample: |\n  # 一级标题\n  > 在这里填写引用文字\n---\n\n正文';
  assert.equal(ofType(check(source, {stripFrontmatter: true}), 'placeholder').length, 0);
  assert.equal(ofType(check(source, {stripFrontmatter: false}), 'placeholder').length, 0);
});

test('Chinese and emoji title lengths count Unicode code points, not UTF-16 units', () => {
  assert.equal(ofType(check('# ' + '😀'.repeat(40)), 'title-length').length, 0);
  const source = '# ' + '😀'.repeat(41);
  const issues = ofType(check(source), 'title-length');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /41 个 Unicode 字符/);
  assert.equal(source.slice(issues[0].start, issues[0].end), '😀'.repeat(41));
  assert.equal(ofType(check('# ' + '中'.repeat(40)), 'title-length').length, 0);
  assert.equal(ofType(check('# ' + '中'.repeat(41)), 'title-length').length, 1);
});

test('H1 closing markers and escaped title punctuation are not counted as title text', () => {
  const source = '# ' + '\\!'.repeat(40) + ' ###';
  assert.equal(ofType(check(source), 'title-length').length, 0);
  const issues = ofType(check(source.replace(' ###', '\\! ###')), 'title-length');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, '!'.repeat(41));
});

test('real H1 inline code counts as visible title text and link destinations do not inflate it', () => {
  const source = '# ' + '长'.repeat(39) + ' `AI`';
  const issues = ofType(check(source), 'title-length');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, '长'.repeat(39) + ' AI');
  assert.equal(source.slice(issues[0].start, issues[0].end), '长'.repeat(39) + ' `AI`');
  const url = 'https://example.invalid/' + 'destination'.repeat(30);
  assert.equal(ofType(check(`# [短标题](${url})`), 'title-length').length, 0);
  assert.equal(ofType(check('# **' + '长'.repeat(40) + '**'), 'title-length').length, 0);
  assert.equal(ofType(check('# **' + '长'.repeat(41) + '**'), 'title-length').length, 1);
});

test('only safe top-level YAML title strings are read and get their original source range', () => {
  const title = '长'.repeat(41);
  for (const raw of [title, JSON.stringify(title), `'${title}'`, JSON.stringify(title) + ' # 说明']) {
    const source = `---\r\ntitle: ${raw}\r\n---\r\n正文`;
    const issues = ofType(check(source, {stripFrontmatter: true}), 'title-length');
    assert.equal(issues.length, 1, raw);
    assert.equal(issues[0].title, title);
    assert.equal(source.slice(issues[0].start, issues[0].end), raw);
  }
});

test('YAML aliases, tags, multiline values, duplicate keys and malformed quotes are ignored', () => {
  const long = '长'.repeat(41);
  for (const fields of [`title: !unsafe ${long}`, `title: &alias ${long}`, `title: *${long}`,
    `title: |\n  ${long}`, `title: [${long}]`, `title: {nested: ${long}}`, `nested:\n  title: ${long}`,
    `title: "${long}`, `title: ${long}\ntitle: 另一个标题`]) {
    const source = `---\n${fields}\n---\n正文`;
    assert.equal(ofType(check(source), 'title-length').length, 0, fields);
  }
});

test('long headings in code examples are ignored while body H1 remains locatable', () => {
  const long = '标题'.repeat(21);
  const source = `~~~md\n# ${long}\n~~~\n\n    # ${long}\n\n# ${long}`;
  const issues = ofType(check(source), 'title-length');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].start, source.lastIndexOf(long));
});

test('duplicate recommendations use normalized display titles and preserve both article IDs', () => {
  const relatedArticles = [item('a', '日期_原文', {displayTitle: 'ＡＢＣ 标题'}), item('b', '另篇正文', {displayTitle: 'abc 标题'})];
  const managed = syncRelatedFooter('正文', relatedArticles);
  const issues = ofType(check(managed.source, {relatedArticles, relatedFooter: managed.footer}), 'duplicate-recommendation');
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].articleIds, ['a', 'b']);
  assert.equal(issues[0].occurrences.length, 2);
  assert.equal(managed.source.slice(issues[0].start, issues[0].end), 'ＡＢＣ 标题');
  assert.equal(relatedArticles.length, 2);
  assert.match(issues[0].message, /全部保留/);
});

test('same article repeated as metadata does not invent a different-article duplicate', () => {
  const same = item('a', '同一文章');
  assert.equal(ofType(checkArticle({source: '正文', relatedArticles: [same, same]}), 'duplicate-recommendation').length, 0);
});

test('Markdown-special recommendation titles remain literal text and map to escaped editor ranges', () => {
  const title = '<img onerror="x"> ![[图.png]] [link](url) & * _ `';
  const relatedArticles = [item('a', title), item('b', title)];
  const managed = syncRelatedFooter('正文', relatedArticles);
  const rendered = render(managed.source, {relatedFooter: managed.footer});
  const issues = checkArticle({source: managed.source, rendered, relatedArticles, relatedFooter: managed.footer});
  const duplicate = ofType(issues, 'duplicate-recommendation')[0];
  assert.deepEqual(duplicate.articleIds, ['a', 'b']);
  assert.match(duplicate.message, /<img onerror="x">/);
  assert.ok(managed.source.slice(duplicate.start, duplicate.end).includes('\\<img'));
  assert.equal(ofType(issues, 'image-unavailable').length, 0);
  assert.doesNotMatch(rendered.html, /<img onerror/);
});

test('long recommendation uses edited display title rather than the original filename title', () => {
  const relatedArticles = [item('a', '原题', {displayTitle: '😀'.repeat(41)}), item('b', '長'.repeat(80), {displayTitle: '短标题'})];
  const managed = syncRelatedFooter('正文', relatedArticles);
  const issues = ofType(check(managed.source, {relatedArticles, relatedFooter: managed.footer}), 'title-length');
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].articleIds, ['a']);
  assert.equal(managed.source.slice(issues[0].start, issues[0].end), '😀'.repeat(41));
});

test('same-line manually edited footer duplicate titles are warned without overwriting them', () => {
  const relatedArticles = [item('a', '甲文章'), item('b', '乙文章')];
  const managed = syncRelatedFooter('正文', relatedArticles);
  const source = managed.source.replace('- 乙文章', '- 甲文章');
  const footer = {...managed.footer, text: managed.footer.text.replace('- 乙文章', '- 甲文章')};
  const issues = ofType(check(source, {relatedArticles, relatedFooter: footer}), 'duplicate-recommendation');
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].articleIds, ['a', 'b']);
  assert.equal(issues[0].occurrences.length, 2);
  assert.equal(source, managed.source.replace('- 乙文章', '- 甲文章'));
});

test('long manually edited footer title is inspected as the actual output text', () => {
  const relatedArticles = [item('a', '甲文章')];
  const managed = syncRelatedFooter('正文', relatedArticles);
  const long = '长'.repeat(41);
  const source = managed.source.replace('- 甲文章', '- ' + long);
  const footer = {...managed.footer, end: managed.footer.end + long.length - 3, text: managed.footer.text.replace('- 甲文章', '- ' + long)};
  const issues = ofType(check(source, {relatedArticles, relatedFooter: footer}), 'title-length');
  assert.equal(issues.length, 1);
  assert.equal(source.slice(issues[0].start, issues[0].end), long);
});

test('hand editing the actual footer can clear old indexed duplicate and length warnings', () => {
  const long = '长'.repeat(41);
  const relatedArticles = [item('a', long), item('b', long)];
  const managed = syncRelatedFooter('正文', relatedArticles);
  let changed = 0;
  const text = managed.footer.text.replaceAll(long, () => ['甲文章', '乙文章'][changed++]);
  const source = managed.source.slice(0, managed.footer.start) + text;
  const footer = {...managed.footer, text, end: managed.footer.start + text.length};
  const issues = check(source, {relatedArticles, relatedFooter: footer});
  assert.equal(ofType(issues, 'title-length').length, 0);
  assert.equal(ofType(issues, 'duplicate-recommendation').length, 0);
  assert.equal(relatedArticles[0].title, long);
  assert.equal(relatedArticles[1].title, long);
});

test('detached editable footer prompts manual duplicate/update review without inventing a range', () => {
  const source = '正文\n\n相关文章推荐：\n\n我手工写的内容';
  const issues = checkArticle({source, relatedArticles: [item('a', '文章')], relatedFooter: {detached: true}});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'recommendation-detached');
  assert.equal(issues[0].start, null);
  assert.match(issues[0].message, /手工调整/);
});

test('checks are deterministic and do not mutate frozen source, renderer or history inputs', () => {
  const relatedArticles = freeze([item('a', '重复'), item('b', '重复')]);
  const managed = syncRelatedFooter('# 一级标题\n\n![[缺失.png]]', relatedArticles);
  const rendered = freeze(render(managed.source, {relatedFooter: managed.footer}));
  const input = freeze({source: managed.source, rendered, relatedArticles, relatedFooter: managed.footer});
  const before = JSON.stringify(input);
  const first = checkArticle(input), second = checkArticle(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.equal(new Set(first.map(issue => issue.id)).size, first.length);
  assert.ok(first.every(issue => typeof issue.message === 'string'));
});

test('warnings never block rendering, HTML export or injected rich text copy', async () => {
  const source = '# 一级标题\n\n![[缺失.png]]';
  const rendered = render(source);
  const before = rendered.html;
  const issues = checkArticle({source, rendered});
  assert.equal(issues.length, 2);
  const html = '<!doctype html><meta charset="utf-8">' + rendered.html;
  assert.equal(rendered.html, before);
  assert.ok(html.includes('<section'));
  let written;
  class Item {constructor(data) {this.data = data;}}
  const copied = await copyRichText({html: rendered.html, text: source, ClipboardItemCtor: Item,
    clipboard: {write: async items => {written = items;}}, documentRef: null});
  assert.equal(copied.method, 'clipboard');
  assert.equal(await written[0].data['text/html'].text(), before);
  assert.equal(await written[0].data['text/plain'].text(), source);
});

test('preflight depends on local pure modules and contains no browser, file, network or model calls', () => {
  const module = readFileSync(new URL('../preflight.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /from ['"](?:node:fs|node:https|node:http|https?:)/);
  assert.doesNotMatch(module, /\b(?:fetch|XMLHttpRequest|sendBeacon|localStorage|indexedDB|document|navigator)\s*[.(]/);
  assert.doesNotMatch(module, /\b(?:OpenAI|Anthropic|gemini|chat\.completions)\b/);
});
