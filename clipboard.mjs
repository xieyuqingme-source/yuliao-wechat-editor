/** Copy trusted, locally rendered article HTML. All dependencies can be injected for tests. */
export async function copyRichText({html, text, clipboard = globalThis.navigator?.clipboard,
  ClipboardItemCtor = globalThis.ClipboardItem, BlobCtor = globalThis.Blob,
  documentRef = globalThis.document, selection = globalThis.getSelection?.()}) {
  let modernError;
  if (clipboard?.write && ClipboardItemCtor && BlobCtor) {
    try {
      const item = new ClipboardItemCtor({
        'text/html': new BlobCtor([html], {type: 'text/html'}),
        'text/plain': new BlobCtor([text], {type: 'text/plain'})
      });
      await clipboard.write([item]);
      return {method: 'clipboard', formats: ['text/html', 'text/plain']};
    } catch (error) { modernError = error; }
  }
  if (!documentRef?.createElement || !documentRef?.execCommand || !selection) {
    throw new Error(`浏览器未允许富文本复制，请导出 HTML 后打开复制。${modernError ? `（${modernError.message}）` : ''}`);
  }
  const active = documentRef.activeElement;
  const textSelection = active && typeof active.selectionStart === 'number'
    ? {start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection} : null;
  const ranges = [];
  for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
  const holder = documentRef.createElement('div');
  holder.contentEditable = 'true';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:390px;opacity:0;pointer-events:none';
  holder.innerHTML = html;
  documentRef.body.appendChild(holder);
  try {
    holder.focus();
    const range = documentRef.createRange();
    range.selectNodeContents(holder);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!documentRef.execCommand('copy')) throw new Error('浏览器拒绝复制。请导出 HTML 后打开复制。');
    return {method: 'selection', formats: ['text/html', 'text/plain'], warning: '已使用浏览器选区复制，请检查粘贴结果。'};
  } finally {
    holder.remove();
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
    active?.focus?.();
    if (textSelection) active.setSelectionRange?.(textSelection.start, textSelection.end, textSelection.direction);
  }
}
