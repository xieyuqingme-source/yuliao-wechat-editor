import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {auxiliaryFontSize, cleanReferenceWhitespace, findReferenceSections} from '../references.mjs';
import {renderArticle} from '../core.mjs';
import {syncRelatedFooter} from '../history.mjs';
import {copyRichText} from '../clipboard.mjs';
import {wrapArticleHtml} from '../app.mjs';

const markdownFactory = createRequire(import.meta.url)('../vendor/markdown-it.cjs');
const options = {markdownFactory};
const clean = (source, more = {}) => cleanReferenceWhitespace(source, {...options, ...more});
const find = source => findReferenceSections(source, options);
const render = (source, more = {}) => renderArticle(source, {...options, ...more});
const shape = source => markdownFactory({html: false, breaks: true}).parse(source, {}).map(token => ({type: token.type, tag: token.tag,
  level: token.level, nesting: token.nesting, attrs: token.attrs, content: token.content,
  children: token.children?.map(child => ({type: child.type, content: child.content, attrs: child.attrs}))}));
const lastFont = tag => [...tag.matchAll(/font-size:([\d.]+)px/g)].at(-1)?.[1];
const paragraph = (html, text) => [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)].map(match => match[0]).find(part => part.includes(text));

test('reference labels support headings, setext, bilingual bold and exact screenshot syntax', () => {
  for (const title of ['## 参考资料', '参考文献\n-----', '# References:', '**参考资料 / References:**',
    '**参考资料 / References: **', '__References / 参考资料：__', '参考资料：']) {
    const source = `# 文章\n\n正文\n\n${title}\n\n1. First item\n2. Second item\n\n## 下一节\n\n后续正文`;
    const sections = find(source);
    assert.equal(sections.length, 1, title);
    assert.equal(source.slice(sections[0].start, sections[0].end).includes('First item'), true);
    assert.equal(source.slice(sections[0].start, sections[0].end).includes('下一节'), false);
    assert.equal(sections[0].end, source.indexOf('## 下一节'));
  }
});

test('only a whole top-level section label can establish reference styling', () => {
  for (const source of ['正文提到 **参考资料** 这个词', '> **参考资料**\n> - quoted', '- **参考资料**\n  - nested',
    '```md\n## 参考资料\n1. code\n```', '    **参考资料**\n    1. code', '**其他** 字样 **参考资料**']) assert.deepEqual(find(source), [], source);
  const source = '---\nnote: |\n  参考资料\n---\n\n正文';
  assert.deepEqual(find(source), []);
});

test('reference range ends at headings, standalone next section and related titles', () => {
  for (const next of ['# Next', '###### Next', '**下一节**', '__Next__', '相关文章推荐：', '相关阅读：']) {
    const source = `**参考资料**\n\n1. First\n\n${next}\n\n  Keep this body`;
    const section = find(source)[0];
    assert.equal(section.end, source.indexOf(next));
    assert.equal(clean(source).source.endsWith('  Keep this body'), true);
    const html = render(source).html;
    assert.equal(lastFont(paragraph(html, 'Keep this body')), '16');
  }
});

test('multiple reference sections each stay local and preserve ordinary whitespace', () => {
  const source = '  Body  words\n\n## 参考资料\n\n  One  two\n\n## 第二节\n\n  Do  not change\n\n**References**\n\n  Three  four';
  const result = clean(source);
  assert.equal(result.sections.length, 2);
  assert.equal(result.changedLines, 2);
  assert.equal(result.source, '  Body  words\n\n## 参考资料\n\nOne  two\n\n## 第二节\n\n  Do  not change\n\n**References**\n\nThree  four');
});

test('ordinary five numbered references lose only excess marker indent and retain links and numbering', () => {
  const source = '**参考资料 / References: **\n\n' + Array.from({length: 5}, (_, i) => `   ${i + 1}. [Title ${i + 1} with English words](https://example.invalid/doc%20${i + 1})  tail`).join('\n');
  const result = clean(source);
  assert.equal(result.changedLines, 5);
  assert.equal(result.source, source.replace(/^   /gm, ''));
  assert.deepEqual(shape(result.source), shape(source));
  const html = render(result.source).html;
  assert.match(html, /list-style-type:decimal/);
  assert.equal((html.match(/<li /g) || []).length, 5);
  assert.match(html, /padding-left:20px;/);
  assert.equal(html.includes('**参考资料'), false);
  assert.equal(result.source.includes('**参考资料 / References: **'), true);
  assert.equal((html.match(/href="https:\/\/example.invalid\/doc%20/g) || []).length, 5);
});

test('complex reference lists are untouched so nested lists and continuations keep their AST', () => {
  for (const list of ['   1. parent\n         - nested\n\n   2. next',
    '   1. parent\n\n         paragraph continuation', '   1. parent\n      continuation',
    '   1. parent\n\n       ```js\n       code  value\n       ```',
    '   - parent\n      1. Nested number\n   - next', '   1.\n      continuation']) {
    const source = `**参考资料**\n\n${list}`;
    const result = clean(source);
    assert.equal(result.source, source, list);
    assert.deepEqual(shape(result.source), shape(source), list);
    assert.equal(result.changed, false, list);
  }
});

test('fenced code, indented code, tabs and markdown hard breaks remain exact', () => {
  const source = '**参考资料**\n\n  Ordinary  words  \n\n```md\n   1. Keep   spaces\n  **References**\n```\n\n    const  a = 1;\n\n\tCode with tab\n\n## Next\n\n  untouched';
  const result = clean(source);
  assert.equal(result.changedLines, 1);
  assert.equal(result.source, source.replace('  Ordinary', 'Ordinary'));
  const code = value => markdownFactory().parse(value, {}).filter(token => ['fence', 'code_block'].includes(token.type)).map(token => ({type: token.type, content: token.content}));
  assert.deepEqual(code(result.source), code(source));
  assert.ok(result.source.includes('Ordinary  words  \n'));
});

test('unicode leading spaces are removed conservatively without creating markdown structure', () => {
  const source = '**References**\n\n\u3000\u00a0English  words\n\n\u3000- keep as prose\n\n\u00a0[ref]: https://example.invalid';
  const result = clean(source);
  assert.equal(result.changedLines, 1);
  assert.ok(result.source.includes('\nEnglish  words\n'));
  assert.ok(result.source.includes('\n\u3000- keep as prose\n'));
  assert.ok(result.source.endsWith('\u00a0[ref]: https://example.invalid'));
});

test('CRLF and UTF16 selections map through edits and source can be restored exactly', () => {
  const source = '😀正文\r\n\r\n  **参考资料**\r\n\r\n   1. One  two\r\n   2. Three\r\n';
  const start = source.indexOf('One'), end = source.indexOf('Three') + 5;
  const result = clean(source, {selectionStart: start, selectionEnd: end});
  assert.equal(result.changedLines, 3);
  assert.equal(result.source.slice(result.selectionStart, result.selectionEnd), 'One  two\r\n2. Three');
  assert.equal(result.source.replace(/\r\n/g, '').includes('\n'), false);
  let restored = result.source;
  for (const change of result.changes) restored = restored.slice(0, change.start) + source.slice(change.start, change.end) + restored.slice(change.start);
  assert.equal(restored, source);
});

test('cleanup is idempotent and inert when no recognized reference section exists', () => {
  const source = '**参考资料**\n\n  A  B\n\n   1. C\n   2. D';
  const first = clean(source), second = clean(first.source);
  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
  assert.deepEqual(clean('  原稿\n\n   1. 留着'), {source: '  原稿\n\n   1. 留着', changed: false, changedLines: 0, changes: [], sections: [], selectionStart: 0, selectionEnd: 0});
});

test('reference type sizes are smaller across body settings and ordinary prose/lists stay unchanged', () => {
  const source = '普通正文\n\n1. Ordinary list\n\n**参考资料 / References: **\n\n1. Reference entry\n\n## Next\n\nAfter text';
  for (const fontSize of [14, 16, 18, 20]) {
    const html = render(source, {presentation: {fontSize, lineHeight: 2}}).html;
    const small = auxiliaryFontSize(fontSize);
    assert.ok(small < fontSize);
    assert.equal(lastFont(paragraph(html, '普通正文')), String(fontSize));
    assert.equal(lastFont(paragraph(html, 'After text')), String(fontSize));
    const lists = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map(match => match[0]);
    assert.equal(lastFont(lists[0]), String(fontSize));
    assert.equal(lastFont(lists[1]), String(small));
    assert.ok(lists[1].includes('padding-left:0;'));
    assert.ok(lists[0].includes('padding-left:3px;'));
    assert.equal(lastFont(paragraph(html, '参考资料')), String(small));
    assert.equal(render(source, {presentation: {fontSize}}).source, source);
  }
  assert.equal(auxiliaryFontSize(16), 14);
});

test('managed related footer is a hard reference boundary even when ordinary body follows it', () => {
  const managed = syncRelatedFooter('**参考资料**\n\n1. Reference entry', [{id: 'a', title: 'Real title', name: 'a.md'}]);
  const source = managed.source + '\n普通尾部正文';
  const result = render(source, {relatedFooter: managed.footer});
  assert.equal(lastFont(paragraph(result.html, '普通尾部正文')), '16');
  const footer = result.html.match(/<section aria-label="相关文章推荐"[\s\S]*?<\/section>/)?.[0];
  assert.ok(footer);
  assert.equal(lastFont(footer), '14');
  assert.equal(result.source, source);
});

test('inline reference styles and related sizes are identical in preview rich copy and exported HTML', async () => {
  const managed = syncRelatedFooter('普通正文\n\n## 参考资料\n\n1. [English title](https://example.invalid)\n2. Second', [{id: 'a', title: '真实推荐文章', name: 'a.md'}]);
  const result = render(managed.source, {relatedFooter: managed.footer, presentation: {fontSize: 18, device: 'desktop', lineHeight: 2, accentColor: '#123456'}});
  assert.match(result.html, /font-size:15\.75px/);
  let payload;
  class ClipboardItem {constructor(data) {this.data = data;}}
  await copyRichText({html: result.html, text: result.source, clipboard: {write: async items => {payload = items[0];}}, ClipboardItemCtor: ClipboardItem, documentRef: null});
  assert.equal(await payload.data['text/html'].text(), result.html);
  assert.equal(await payload.data['text/plain'].text(), managed.source);
  assert.ok(wrapArticleHtml(result.html, '文章').includes(result.html));
  assert.doesNotMatch(result.html, /transform:|scale\(|device:|1000px/);
});
