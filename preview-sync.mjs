/** Approximate reading progress, independent of DOM layout, files and network. */
export function clampScrollRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function scrollMetrics(scroller) {
  const valid = scroller && ['scrollTop', 'scrollHeight', 'clientHeight']
    .every(key => typeof scroller[key] === 'number' && Number.isFinite(scroller[key]));
  if (!valid) return {valid: false, top: 0, max: 0, ratio: 0, height: 0, viewport: 0};
  const height = Math.max(0, scroller.scrollHeight), viewport = Math.max(0, scroller.clientHeight);
  const max = Math.max(0, height - viewport), top = Math.min(max, Math.max(0, scroller.scrollTop));
  return {valid: true, top, max, ratio: max > 0 ? clampScrollRatio(top / max) : 0, height, viewport};
}

export const scrollRatio = scroller => scrollMetrics(scroller).ratio;
export const scrollTopForRatio = (scroller, ratio) => scrollMetrics(scroller).max * clampScrollRatio(ratio);

const fallbackFrame = callback => {callback(); return null;};
const sameMetrics = (one, two) => one.height === two.height && one.viewport === two.viewport;

/**
 * Synchronize the two supplied surfaces by proportional reading progress.
 * A programmatic-position guard survives delayed scroll events; the latest user
 * event replaces a pending animation frame. No source text or iframe handle is
 * stored in drafts. The caller must rebind after rebuilding an iframe document.
 */
export function createScrollSync({editor, preview = null, enabled = true,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? fallbackFrame,
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? (() => {}),
  editorEvents = editor, previewEvents,
  editorResizeTarget, previewResizeTarget} = {}) {
  let active = enabled === true, destroyed = false;
  let ratio = scrollRatio(editor), latestSide = 'editor';
  let pending = null, queued = false, frameId = null, frameTicket = 0;
  const records = {editor: null, preview: null};

  const cancelPending = () => {
    pending = null;
    if (queued) {
      queued = false; frameTicket++;
      if (frameId !== null && frameId !== undefined) cancelFrame(frameId);
      frameId = null;
    }
  };

  const applyRatio = (record, value) => {
    if (!record?.scroller) return;
    const before = scrollMetrics(record.scroller);
    if (!before.valid) return;
    const top = before.max * clampScrollRatio(value);
    record.ratio = before.ratio;
    // No assignment means no synthetic event to suppress. In particular a
    // non-overflowing pane must remain able to report its zero progress.
    if (Math.abs(before.top - top) <= 0.01 && record.scroller.scrollTop === top) return;
    // Set before assignment because some hosts dispatch scroll synchronously.
    record.expected = {...before, top};
    try {record.scroller.scrollTop = top;} catch {record.expected = null; return;}
    const after = scrollMetrics(record.scroller);
    record.ratio = after.ratio;
    record.expected = {...after};
  };

  const schedule = task => {
    if (!active || destroyed) return;
    pending = task;
    if (queued) return;
    queued = true;
    const ticket = ++frameTicket;
    const id = requestFrame(() => {
      if (destroyed || !active || ticket !== frameTicket) return;
      queued = false; frameId = null;
      const next = pending; pending = null;
      if (!next) return;
      if (next.both) {
        applyRatio(records.editor, next.ratio);
        applyRatio(records.preview, next.ratio);
        const editorMetrics = scrollMetrics(records.editor?.scroller);
        const previewMetrics = scrollMetrics(records.preview?.scroller);
        if (editorMetrics.valid && previewMetrics.valid && !editorMetrics.max && !previewMetrics.max) ratio = 0;
      } else applyRatio(records[next.source === 'editor' ? 'preview' : 'editor'], next.ratio);
    });
    // A no-browser fallback is synchronous, so it creates no timers or stale ID.
    if (queued && ticket === frameTicket) frameId = id;
  };

  const onScroll = side => {
    if (destroyed) return;
    const record = records[side];
    if (!record) return;
    const metrics = scrollMetrics(record.scroller);
    if (!metrics.valid) return;
    if (record.expected && Math.abs(metrics.top - Math.min(metrics.max, record.expected.top)) <= 0.75) {
      if (sameMetrics(metrics, record.expected)) return;
      if (active) {
        // An old assignment's delayed event may arrive after image loading or
        // reflow. Its unchanged/clamped pixel position must not become a new
        // user progress ratio and replace the pending layout refresh.
        refresh(); return;
      }
    }
    record.expected = null;
    record.ratio = metrics.ratio;
    ratio = metrics.ratio; latestSide = side;
    if (active) schedule({source: side, ratio});
  };

  const refresh = ({source, preserveRatio = true} = {}) => {
    if (destroyed || !active) return;
    if (source === 'editor' || source === 'preview') latestSide = source;
    const record = records[latestSide];
    if (!preserveRatio) ratio = scrollRatio(record?.scroller);
    else if (source && record) ratio = record.ratio;
    ratio = clampScrollRatio(ratio);
    schedule({ratio, both: true});
  };

  const bind = (side, scroller, {eventTarget, resizeTarget} = {}) => {
    records[side]?.cleanup();
    if (!scroller || typeof scroller !== 'object') {records[side] = null; return;}
    const listeners = [];
    const listen = (target, name, callback, options) => {
      if (!target?.addEventListener || !target?.removeEventListener) return;
      target.addEventListener(name, callback, options);
      listeners.push(() => target.removeEventListener(name, callback, options));
    };
    records[side] = {scroller, ratio: scrollRatio(scroller), expected: null,
      cleanup: () => {for (const remove of listeners) remove();}};
    const events = eventTarget ?? scroller;
    listen(events, 'scroll', () => onScroll(side), {passive: true});
    // A real gesture supersedes a retained delayed-event guard, including a
    // gesture after reflow that returns to the old pixel offset.
    const userIntent = () => {if (records[side]) records[side].expected = null;};
    for (const eventName of ['wheel', 'pointerdown', 'touchstart']) {
      listen(events, eventName, userIntent, {passive: true});
    }
    listen(events, 'keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userIntent();
    });
    // Capture handles image load events that do not bubble from the iframe body.
    if (side === 'preview') listen(events, 'load', () => refresh(), true);
    listen(resizeTarget ?? scroller.ownerDocument?.defaultView, 'resize', () => refresh());
  };

  bind('editor', editor, {eventTarget: editorEvents, resizeTarget: editorResizeTarget});
  bind('preview', preview, {eventTarget: previewEvents, resizeTarget: previewResizeTarget});

  return {
    setEnabled(value) {
      if (destroyed) return;
      const next = value === true;
      if (next === active) return;
      active = next;
      cancelPending();
      if (active) {
        // Start from the last surface the user actually scrolled while disabled.
        ratio = scrollRatio(records[latestSide]?.scroller);
        refresh();
      }
    },
    refresh,
    rebindPreview(scroller, options = {}) {
      if (destroyed) return;
      bind('preview', scroller, options);
      if (active) schedule({ratio, source: 'editor'});
    },
    getRatio(side) {
      if (side === 'editor' || side === 'preview') return records[side]?.ratio ?? 0;
      return clampScrollRatio(ratio);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; cancelPending();
      records.editor?.cleanup(); records.preview?.cleanup();
      records.editor = null; records.preview = null;
    },
  };
}
