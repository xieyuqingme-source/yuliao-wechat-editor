import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { COMPONENTS, editorSnapshot, applyComponent, createEditHistory } from '../components.mjs';
import { renderArticle, THEMES } from '../core.mjs';
import { copyRichText } from '../clipboard.mjs';
import { wrapArticleHtml } from '../app.mjs';

const markdownFactory = createRequire(import.meta.url)('../vendor/markdown-it.cjs');
const caret = (value, position = value.length) => ({ value, start: position, end: position, direction: 'none' });
const selection = (value, start = 0, end = value.length) => ({ value, start, end, direction: 'backward' });
const selectedText = snapshot => snapshot.value.slice(snapshot.start, snapshot.end);

test('toolbar exposes exactly the eight requested Markdown components', () => {
  assert.deepEqual(COMPONENTS.map(item => item.id), ['h1', 'h2', 'h3', 'quote', 'important', 'divider', 'caption', 'references']);
  assert.ok(COMPONENTS.every(item => item.label && item.description && Object.isFrozen(item)));
  assert.throws(() => applyComponent(caret('原文'), 'unknown'), /未知排版组件/);
});

test('empty article inserts an editable placeholder for each text component', () => {
  const tags = { h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', important: 'blockquote', caption: 'em', references: 'ul' };
  for (const [id, tag] of Object.entries(tags)) {
    const inserted = applyComponent(caret(''), id);
    assert.ok(selectedText(inserted).length > 1, id);
    assert.equal(inserted.direction, 'forward');
    const rendered = renderArticle(inserted.value, { markdownFactory });
    assert.match(rendered.html, new RegExp(`<${tag}(?: |>)`));
    // The selected placeholder can be replaced by typing without erasing component syntax.
    const edited = inserted.value.slice(0, inserted.start) + '谢雨卿的内容' + inserted.value.slice(inserted.end);
    assert.match(renderArticle(edited, { markdownFactory }).html, /谢雨卿的内容/);
  }
});

test('cursor in a paragraph isolates the new block and preserves both original fragments', () => {
  const result = applyComponent(caret('开头结尾', 2), 'h2');
  assert.equal(result.value, '开头\n\n## 二级标题\n\n结尾');
  assert.equal(selectedText(result), '二级标题');
  assert.match(renderArticle(result.value, { markdownFactory }).html, /<h2[^>]*>二级标题<\/h2>/);
});

test('existing blank-line boundaries are not multiplied and CRLF source retains its newline format', () => {
  assert.equal(applyComponent(caret('前文\n\n后文', 4), 'quote').value, '前文\n\n> 在这里填写引用文字\n\n后文');
  const value = '前文\r\n后文';
  assert.equal(applyComponent(caret(value, 4), 'h3').value, '前文\r\n\r\n### 三级标题\r\n\r\n后文');
});

test('selected words are wrapped at the exact range while surrounding prose survives', () => {
  const result = applyComponent(selection('甲选中文字乙', 1, 5), 'important');
  assert.equal(result.value, '甲\n\n> **重点：** 选中文字\n\n乙');
  assert.equal(selectedText(result), '选中文字');
  assert.equal(result.direction, 'backward');
});

test('multiline headings and quotes retain all original lines including empty lines', () => {
  const value = '第一行\n\n第二行\n第三行';
  const heading = applyComponent(selection(value), 'h2');
  assert.equal(heading.value, '## 第一行\n\n## 第二行\n## 第三行');
  const quoted = applyComponent(selection(value), 'quote');
  assert.equal(quoted.value, '> 第一行\n> \n> 第二行\n> 第三行');
  const important = applyComponent(selection(value), 'important');
  assert.equal(important.value, '> **重点：** 第一行\n> \n> 第二行\n> 第三行');
  const rendered = renderArticle(quoted.value, { markdownFactory });
  assert.equal((rendered.html.match(/<blockquote /g) || []).length, 1);
  assert.match(rendered.html, /第一行/); assert.match(rendered.html, /第二行/);
});

test('divider insertion retains selected text and places a usable rule after the selection', () => {
  const value = '开头\n正文\n结尾';
  const result = applyComponent(selection(value, 3, 5), 'divider');
  assert.equal(result.value, '开头\n正文\n\n---\n\n结尾');
  assert.equal(result.start, result.end);
  assert.match(renderArticle(result.value, { markdownFactory }).html, /<hr style=/);
  assert.equal(applyComponent(caret(''), 'divider').value, '---');
});

test('caption and references contain only ordinary editable Markdown and do not infer links', () => {
  const caption = applyComponent(selection('山间晨光'), 'caption');
  assert.equal(caption.value, '*山间晨光*');
  assert.equal(selectedText(caption), '山间晨光');
  const references = applyComponent(selection('张三，《文章一》\n李四，《文章二》'), 'references');
  assert.equal(references.value, '### 参考资料\n\n- 张三，《文章一》\n- 李四，《文章二》');
  const rendered = renderArticle(references.value, { markdownFactory });
  assert.equal((rendered.html.match(/<li /g) || []).length, 2);
  assert.doesNotMatch(rendered.html, /<a /);
});

test('special-character source remains literal in the transaction and raw HTML is inert in preview', () => {
  const value = '中文 & <img src=x onerror="bad()"> `code` [资料] *星号* 🚀';
  for (const id of ['h1', 'quote', 'important', 'caption', 'references']) {
    const result = applyComponent(selection(value), id);
    assert.ok(result.value.includes(value), id);
    const html = renderArticle(result.value, { markdownFactory }).html;
    assert.doesNotMatch(html, /<img |<script/i);
    assert.match(html, /&lt;img/);
  }
});

test('selection offsets are normalized without splitting or modifying the source value', () => {
  assert.deepEqual(editorSnapshot({ value: '甲🚀乙', start: -20, end: 99 }), { value: '甲🚀乙', start: 0, end: 4, direction: 'none' });
  assert.deepEqual(editorSnapshot({ value: 'abc', selectionStart: 3, selectionEnd: 1, selectionDirection: 'backward' }), { value: 'abc', start: 1, end: 3, direction: 'backward' });
  for (const id of COMPONENTS.map(item => item.id)) {
    const blank = applyComponent(selection('\n'), id);
    assert.ok(blank.start <= blank.end && blank.end <= blank.value.length, id);
  }
});

test('toolbar transaction Undo/Redo restores value and original forward/backward selection', () => {
  const before = selection('保留这句话', 2, 5);
  const after = applyComponent(before, 'quote');
  const history = createEditHistory(before);
  assert.equal(history.record(before, after, { kind: 'component' }), true);
  assert.equal(history.canUndo, true);
  assert.deepEqual(history.undo(after), before);
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(before), after);
  assert.equal(history.redo(after), null);
});

test('ordinary typing after a component is undone before the component and new typing clears redo', () => {
  const before = caret('原文');
  const after = applyComponent(before, 'h2');
  const history = createEditHistory(before);
  history.record(before, after, { kind: 'component' });
  const typed = caret(after.value.slice(0, after.start) + '新标题' + after.value.slice(after.end), after.start + 3);
  history.record(after, typed, { kind: 'input' });
  assert.deepEqual(history.undo(typed), after);
  assert.deepEqual(history.undo(after), before);
  assert.deepEqual(history.redo(before), after);
  const alternate = caret(after.value + '另一次输入');
  history.record(after, alternate);
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(alternate), null);
  assert.deepEqual(history.undo(alternate), after);
});

test('cursor-only motion does not invalidate Undo but a new unrecorded article prevents stale overwrite', () => {
  const before = caret('第一篇'), after = applyComponent(before, 'references');
  const history = createEditHistory(before);
  history.record(before, after);
  assert.deepEqual(history.undo(caret(after.value, 0)), before);
  history.redo(before);
  const otherArticle = caret('另一篇文章的原文');
  assert.equal(history.undo(otherArticle), null);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.deepEqual(history.current, otherArticle);
  assert.equal(history.redo(after), null);
});

test('journal reset handles document switches and protects internal snapshots from caller mutation', () => {
  const before = caret('旧稿'), after = applyComponent(before, 'quote');
  const history = createEditHistory(before);
  history.record(before, after);
  const current = history.current; current.value = '外部修改';
  assert.equal(history.current.value, after.value);
  history.reset(caret('新稿'));
  assert.equal(history.undo(caret('新稿')), null);
  assert.equal(history.redo(caret('新稿')), null);
  assert.equal(history.length, 0);
  const imported = caret('未记录的导入');
  const next = caret('未记录的导入。');
  history.record(imported, next);
  assert.deepEqual(history.undo(next), imported);
  assert.equal(history.undo(imported), null);
});

test('bounded journal discards only oldest edits and selection-only records do not destroy redo', () => {
  const history = createEditHistory(caret(''), { limit: 2 });
  let current = caret('');
  for (const word of ['甲', '乙', '丙']) {
    const next = caret(current.value + word);
    history.record(current, next); current = next;
  }
  assert.equal(history.length, 2);
  assert.equal(history.undo(current).value, '甲乙');
  assert.equal(history.undo(caret('甲乙')).value, '甲');
  assert.equal(history.undo(caret('甲')), null);
  assert.equal(history.record(caret('甲'), selection('甲')), false);
  assert.equal(history.canRedo, true);
  assert.equal(history.redo(selection('甲')).value, '甲乙');
});

test('Undo/Redo returns recommendation metadata without sharing mutable references', () => {
  const before = { ...caret('正文'), meta: { relatedArticles: { selectedIds: [], footer: null } } };
  const after = { ...caret('正文\n\n相关文章推荐：\n- 一篇文章'),
    meta: { relatedArticles: { selectedIds: ['article-a'], footer: { start: 4, end: 21 } } } };
  const history = createEditHistory(before);
  history.record(before, after, { kind: 'related' });
  after.meta.relatedArticles.selectedIds.push('外部变化');
  assert.deepEqual(history.current.meta.relatedArticles.selectedIds, ['article-a']);
  const undone = history.undo(history.current);
  assert.deepEqual(undone.meta, before.meta);
  undone.meta.relatedArticles.selectedIds.push('另一次外部变化');
  const redone = history.redo(history.current);
  assert.deepEqual(redone.meta.relatedArticles.selectedIds, ['article-a']);
  // Metadata-only transactions are useful when a user's manual list text remains unchanged.
  const metadataOnly = { ...redone, meta: { relatedArticles: { selectedIds: [], footer: null } } };
  assert.equal(history.record(redone, metadataOnly), true);
  assert.deepEqual(history.undo(metadataOnly).meta, redone.meta);
});

test('all component types render with the actual parser in every theme, and export/copy use identical HTML', async () => {
  let snapshot = caret('原始文章正文');
  for (const component of COMPONENTS) {
    snapshot = applyComponent(caret(snapshot.value), component.id);
  }
  for (const theme of THEMES) {
    const rendered = renderArticle(snapshot.value, { theme: theme.id, markdownFactory });
    assert.deepEqual(rendered.issues, []);
    for (const tag of ['h1', 'h2', 'h3', 'blockquote', 'strong', 'hr', 'em', 'ul', 'li']) {
      assert.match(rendered.html, new RegExp(`<${tag}(?: |>)`), theme.id + ':' + tag);
    }
    assert.equal(rendered.source, snapshot.value);
    const exported = wrapArticleHtml(rendered.html, '组件验证');
    assert.ok(exported.includes(rendered.html));
    let item;
    class ClipboardItem { constructor(data) { this.data = data; } }
    const copied = await copyRichText({ html: rendered.html, text: rendered.source,
      clipboard: { write: async items => { item = items[0]; } }, ClipboardItemCtor: ClipboardItem, documentRef: null });
    assert.equal(copied.method, 'clipboard');
    assert.equal(await item.data['text/html'].text(), rendered.html);
    assert.equal(await item.data['text/plain'].text(), snapshot.value);
    assert.ok(exported.includes(await item.data['text/html'].text()));
  }
});
