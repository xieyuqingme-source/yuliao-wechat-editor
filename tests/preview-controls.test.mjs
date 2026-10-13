import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PRESENTATION, DEVICE_WIDTHS, normalizePresentation, effectiveTypography} from '../layout-settings.mjs';
import {clampScrollRatio, scrollMetrics, scrollRatio, scrollTopForRatio, createScrollSync} from '../preview-sync.mjs';

class Signals {
  listeners = new Map();
  addEventListener(name, callback, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push({callback, options});
  }
  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.callback !== callback));
  }
  emit(name, detail = {}) {
    for (const {callback} of [...(this.listeners.get(name) || [])]) callback({target: this, ...detail});
  }
  get listenerCount() {return [...this.listeners.values()].flat().length;}
}

class Viewport extends Signals {
  constructor(height = 2000, viewport = 500, {mode = 'sync', events, queue} = {}) {
    super(); this.scrollHeight = height; this.clientHeight = viewport; this._top = 0;
    this.mode = mode; this.events = events || this; this.queue = queue; this.writes = 0;
  }
  get scrollTop() {return this._top;}
  set scrollTop(top) {
    this.writes++;
    this._top = Math.min(Math.max(0, this.scrollHeight - this.clientHeight), Math.max(0, top));
    if (this.mode === 'sync') this.events.emit('scroll');
    else if (this.mode === 'queue') this.queue.push(() => this.events.emit('scroll'));
  }
  userScroll(top) {
    this.events.emit('wheel');
    this._top = Math.min(Math.max(0, this.scrollHeight - this.clientHeight), Math.max(0, top));
    this.events.emit('scroll');
  }
}

function scheduler() {
  let serial = 0;
  const frames = new Map(), cancelled = [];
  return {frames, cancelled,
    requestFrame: callback => {const id = ++serial; frames.set(id, callback); return id;},
    cancelFrame: id => {cancelled.push(frames.get(id)); frames.delete(id);},
    flush() {
      let budget = 100;
      while (frames.size) {
        if (--budget < 0) throw new Error('Animation frame loop');
        const [id, callback] = frames.entries().next().value;
        frames.delete(id); callback();
      }
    },
  };
}

function rig({editorHeight = 2400, editorViewport = 600, previewHeight = 4600, previewViewport = 600,
  mode = 'sync', enabled = true, separateEvents = false} = {}) {
  const clock = scheduler(), events = [];
  const documentEvents = separateEvents ? new Signals() : undefined;
  const windowEvents = new Signals(), editorWindow = new Signals();
  const editor = new Viewport(editorHeight, editorViewport, {mode, queue: events});
  const preview = new Viewport(previewHeight, previewViewport, {mode, queue: events, events: documentEvents});
  const sync = createScrollSync({editor, preview, enabled, ...clock,
    previewEvents: documentEvents, previewResizeTarget: windowEvents, editorResizeTarget: editorWindow});
  const drainEvents = () => {
    let budget = 100;
    while (events.length) {
      if (--budget < 0) throw new Error('Scroll event loop');
      events.shift()(); clock.flush();
    }
  };
  return {editor, preview, sync, clock, events, documentEvents, windowEvents, editorWindow, drainEvents};
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('presentation defaults are isolated, resettable, and use the current theme defaults', () => {
  assert.deepEqual(normalizePresentation(), DEFAULT_PRESENTATION);
  assert.notEqual(normalizePresentation(), DEFAULT_PRESENTATION);
  assert.deepEqual(effectiveTypography('clear'), {fontSize: 16, lineHeight: 1.85, accentColor: '#237a63'});
  assert.deepEqual(effectiveTypography('warm'), {fontSize: 16, lineHeight: 1.85, accentColor: '#995b3f'});
  assert.deepEqual(effectiveTypography('ink'), {fontSize: 16, lineHeight: 1.85, accentColor: '#345875'});
  const custom = {fontSize: 18, lineHeight: 2, accentColor: '#A1B2C3', device: 'tablet', scrollSync: false};
  assert.deepEqual(effectiveTypography('warm', custom), {fontSize: 18, lineHeight: 2, accentColor: '#a1b2c3'});
  const reset = normalizePresentation({...custom, fontSize: null, lineHeight: null, accentColor: null});
  assert.deepEqual(reset, {...DEFAULT_PRESENTATION, device: 'tablet', scrollSync: false});
  assert.deepEqual(effectiveTypography('ink', reset), effectiveTypography('ink'));
});

test('presentation accepts only bounded finite numbers and rounds to two decimal places', () => {
  assert.equal(normalizePresentation({fontSize: 13, lineHeight: 0}).fontSize, 14);
  assert.equal(normalizePresentation({fontSize: 13, lineHeight: 0}).lineHeight, 1.5);
  assert.equal(normalizePresentation({fontSize: 500, lineHeight: 10}).fontSize, 20);
  assert.equal(normalizePresentation({fontSize: 500, lineHeight: 10}).lineHeight, 2.2);
  assert.equal(normalizePresentation({fontSize: 16.345, lineHeight: 1.875}).fontSize, 16.35);
  assert.equal(normalizePresentation({fontSize: 16.345, lineHeight: 1.875}).lineHeight, 1.88);
  for (const invalid of ['18', '', NaN, Infinity, -Infinity, true, [], {}, '16px;color:red']) {
    const normalized = normalizePresentation({fontSize: invalid, lineHeight: invalid});
    assert.equal(normalized.fontSize, null); assert.equal(normalized.lineHeight, null);
    assert.equal(effectiveTypography('clear', normalized).fontSize, 16);
  }
});

test('accent/device/sync allowlist drops CSS, hidden metadata and prototype-shaped values', () => {
  const badValues = ['red', '#abc', '#abcdef;', '#abcdef\n', '#abcdef;background:url(https://bad)', 'var(--private)', {}];
  for (const accentColor of badValues) assert.equal(normalizePresentation({accentColor}).accentColor, null);
  assert.equal(normalizePresentation({accentColor: '#Ff00aA'}).accentColor, '#ff00aa');
  for (const device of ['__proto__', 'constructor', 'watch', 390, {}, {toString: null}, null]) {
    assert.equal(normalizePresentation({device}).device, 'phone');
  }
  for (const scrollSync of ['false', 0, null, {}]) assert.equal(normalizePresentation({scrollSync}).scrollSync, true);
  assert.equal(normalizePresentation({scrollSync: false}).scrollSync, false);
  const cleaned = normalizePresentation({path: 'D:/PRIVATE', body: 'PRIVATE', iframe: {}, handle: {}, device: 'desktop'});
  assert.deepEqual(Object.keys(cleaned), ['fontSize', 'lineHeight', 'accentColor', 'device', 'scrollSync']);
  assert.doesNotMatch(JSON.stringify(cleaned), /PRIVATE|iframe|handle/);
  for (const theme of ['__proto__', {}, {toString: null}, 'unknown']) {
    assert.deepEqual(effectiveTypography(theme), effectiveTypography('clear'));
  }
});

test('device widths are three simulated viewports independent from article typography', () => {
  assert.deepEqual(DEVICE_WIDTHS, {phone: 390, tablet: 768, desktop: 1000});
  assert.ok(Object.isFrozen(DEVICE_WIDTHS)); assert.ok(Object.isFrozen(DEFAULT_PRESENTATION));
  for (const device of Object.keys(DEVICE_WIDTHS)) {
    assert.deepEqual(effectiveTypography('warm', {device}), effectiveTypography('warm'));
  }
});

test('pure progress math clamps overscroll and protects empty/invalid/no-overflow surfaces', () => {
  near(scrollRatio({scrollTop: 500, scrollHeight: 2000, clientHeight: 1000}), 0.5);
  assert.equal(scrollRatio({scrollTop: -10, scrollHeight: 2000, clientHeight: 1000}), 0);
  assert.equal(scrollRatio({scrollTop: 5000, scrollHeight: 2000, clientHeight: 1000}), 1);
  assert.equal(scrollTopForRatio({scrollTop: 0, scrollHeight: 2400, clientHeight: 400}, 0.25), 500);
  for (const value of [NaN, Infinity, {}, null, '0.5']) assert.equal(clampScrollRatio(value), 0);
  assert.equal(clampScrollRatio(-4), 0); assert.equal(clampScrollRatio(5), 1);
  for (const scroller of [null, {}, {scrollTop: 1, scrollHeight: Infinity, clientHeight: 10},
    {scrollTop: 100, scrollHeight: 100, clientHeight: 500},
    {scrollTop: 1, scrollHeight: 0, clientHeight: 0}]) {
    assert.equal(scrollRatio(scroller), 0); assert.equal(scrollTopForRatio(scroller, 0.7), 0);
    assert.ok(Number.isFinite(scrollMetrics(scroller).ratio));
  }
});

test('editor-to-preview uses each viewport range and coalesces rapid scroll input', () => {
  const {editor, preview, sync, clock} = rig();
  for (const top of [100, 200, 450, 900]) editor.userScroll(top);
  assert.equal(clock.frames.size, 1); assert.equal(preview.scrollTop, 0);
  clock.flush(); assert.equal(preview.scrollTop, 2000); assert.equal(preview.writes, 1);
  near(sync.getRatio(), 0.5); assert.equal(clock.frames.size, 0);
  sync.destroy();
});

test('preview-to-editor works with Document scroll events and suppresses synchronous loops', () => {
  const {editor, preview, sync, clock, documentEvents} = rig({separateEvents: true});
  assert.equal(preview.listenerCount, 0); assert.equal(documentEvents.listeners.get('scroll').length, 1);
  preview.userScroll(3000); clock.flush();
  assert.equal(editor.scrollTop, 1350); near(sync.getRatio(), 0.75);
  assert.equal(editor.writes, 1); assert.equal(preview.writes, 0); assert.equal(clock.frames.size, 0);
  sync.destroy();
});

test('last user event wins when both panes scroll before the same animation frame', () => {
  const {editor, preview, sync, clock} = rig();
  editor.userScroll(900); preview.userScroll(1000);
  clock.flush(); assert.equal(editor.scrollTop, 450); assert.equal(preview.scrollTop, 1000);
  near(sync.getRatio(), 0.25);
  preview.userScroll(3000); editor.userScroll(360);
  clock.flush(); assert.equal(editor.scrollTop, 360); assert.equal(preview.scrollTop, 800);
  near(sync.getRatio(), 0.2); sync.destroy();
});

test('delayed programmatic events and repeated queued events stay within a finite assignment budget', () => {
  const h = rig({mode: 'queue'});
  h.editor.userScroll(900); h.clock.flush();
  assert.equal(h.events.length, 1);
  for (let i = 0; i < 5; i++) h.events.push(() => h.preview.emit('scroll'));
  h.drainEvents(); assert.equal(h.preview.writes, 1); assert.equal(h.editor.writes, 0);
  assert.equal(h.clock.frames.size, 0);
  h.preview.userScroll(3000); h.clock.flush(); h.drainEvents();
  assert.equal(h.editor.scrollTop, 1350); assert.equal(h.editor.writes, 1); assert.equal(h.preview.writes, 1);
  h.sync.destroy();
});

test('real input after a delayed assignment supersedes the old queued event', () => {
  const h = rig({mode: 'queue'});
  h.editor.userScroll(900); h.clock.flush();
  h.preview.userScroll(1000); h.clock.flush(); h.drainEvents();
  assert.equal(h.editor.scrollTop, 450); assert.equal(h.preview.scrollTop, 1000);
  near(h.sync.getRatio(), 0.25); assert.ok(h.editor.writes + h.preview.writes <= 2);
  h.sync.destroy();
});

test('disable cancels queued work; stale cancelled callbacks cannot change either surface', () => {
  const h = rig(); h.editor.userScroll(900); h.sync.setEnabled(false);
  assert.equal(h.clock.frames.size, 0); assert.equal(h.clock.cancelled.length, 1);
  h.clock.cancelled[0](); assert.equal(h.preview.scrollTop, 0);
  h.preview.userScroll(3000); h.sync.refresh(); h.clock.flush();
  assert.equal(h.editor.scrollTop, 900); assert.equal(h.preview.scrollTop, 3000);
  assert.equal(h.editor.writes, 0); assert.equal(h.preview.writes, 0);
  h.sync.destroy();
});

test('reenable aligns with the last pane actually scrolled while disabled', () => {
  const h = rig({enabled: false}); h.editor.userScroll(360); h.preview.userScroll(3000);
  h.sync.setEnabled(true); h.clock.flush();
  assert.equal(h.editor.scrollTop, 1350); assert.equal(h.preview.scrollTop, 3000);
  h.sync.setEnabled(false); h.editor.userScroll(900); h.sync.setEnabled(true); h.clock.flush();
  assert.equal(h.preview.scrollTop, 2000); near(h.sync.getRatio(), 0.5); h.sync.destroy();
});

test('image load changes metrics but keeps the cached reading ratio', () => {
  const h = rig({separateEvents: true}); h.editor.userScroll(900); h.clock.flush();
  h.preview.scrollHeight = 8600;
  h.documentEvents.emit('load', {target: {nodeName: 'IMG'}}); h.clock.flush();
  assert.equal(h.preview.scrollTop, 4000); assert.equal(h.editor.scrollTop, 900);
  near(h.sync.getRatio(), 0.5);
  assert.equal(h.documentEvents.listeners.get('load')[0].options, true); h.sync.destroy();
});

test('delayed old scroll events after image reflow do not overwrite the cached ratio', () => {
  const h = rig({mode: 'queue', separateEvents: true}); h.editor.userScroll(900); h.clock.flush();
  assert.equal(h.events.length, 1);
  h.preview.scrollHeight = 8600; h.documentEvents.emit('load', {target: {nodeName: 'IMG'}});
  h.events.shift()(); h.clock.flush(); h.drainEvents();
  assert.equal(h.preview.scrollTop, 4000); assert.equal(h.editor.scrollTop, 900);
  near(h.sync.getRatio(), 0.5); assert.equal(h.clock.frames.size, 0);
  h.sync.destroy();
});

test('a genuine new scroll position after reflow still overrides the pending image refresh', () => {
  const h = rig({mode: 'queue', separateEvents: true}); h.editor.userScroll(900); h.clock.flush();
  h.preview.scrollHeight = 8600; h.documentEvents.emit('load', {target: {nodeName: 'IMG'}});
  h.preview.userScroll(1000); h.clock.flush(); h.drainEvents();
  assert.equal(h.editor.scrollTop, 225); assert.equal(h.preview.scrollTop, 1000);
  near(h.sync.getRatio(), 0.125); h.sync.destroy();
});

test('resize/device width refresh keeps progress in two differently wrapping viewports', () => {
  const h = rig(); h.preview.userScroll(1000); h.clock.flush();
  h.editor.scrollHeight = 4200; h.preview.scrollHeight = 2600;
  h.windowEvents.emit('resize'); h.clock.flush();
  assert.equal(h.editor.scrollTop, 900); assert.equal(h.preview.scrollTop, 500);
  near(h.sync.getRatio(), 0.25);
  h.editor.clientHeight = 1200; h.editorWindow.emit('resize'); h.clock.flush();
  assert.equal(h.editor.scrollTop, 750); assert.equal(h.preview.scrollTop, 500); h.sync.destroy();
});

test('iframe rebind retains cached progress and detaches old document/window listeners', () => {
  const h = rig({separateEvents: true}); h.preview.userScroll(3000); h.clock.flush();
  const newDocument = new Signals(), newWindow = new Signals();
  const newPreview = new Viewport(2600, 600, {events: newDocument});
  h.sync.rebindPreview(newPreview, {eventTarget: newDocument, resizeTarget: newWindow}); h.clock.flush();
  assert.equal(newPreview.scrollTop, 1500); assert.equal(h.editor.scrollTop, 1350);
  assert.equal(h.documentEvents.listenerCount, 0); assert.equal(h.windowEvents.listenerCount, 0);
  h.preview.userScroll(0); h.clock.flush(); assert.equal(h.editor.scrollTop, 1350);
  newPreview.userScroll(500); h.clock.flush(); assert.equal(h.editor.scrollTop, 450);
  assert.equal(newDocument.listenerCount, 6); h.sync.destroy(); assert.equal(newDocument.listenerCount, 0);
});

test('disabled rebind/refresh/load never drives preview or editor', () => {
  const h = rig({enabled: false}); h.editor.userScroll(900); h.preview.userScroll(1000);
  const documentEvents = new Signals(), newWindow = new Signals();
  const newPreview = new Viewport(4000, 500, {events: documentEvents}); newPreview._top = 700;
  h.sync.rebindPreview(newPreview, {eventTarget: documentEvents, resizeTarget: newWindow});
  h.sync.refresh({source: 'preview'}); documentEvents.emit('load'); newWindow.emit('resize'); h.clock.flush();
  assert.equal(h.editor.scrollTop, 900); assert.equal(newPreview.scrollTop, 700);
  assert.equal(newPreview.writes, 0); assert.equal(h.editor.writes, 0); assert.equal(h.clock.frames.size, 0);
  h.sync.destroy();
});

test('no-overflow source sends zero and no-overflow target creates no NaN or event loop', () => {
  const h = rig({editorHeight: 400, editorViewport: 600});
  h.preview.userScroll(2000); h.clock.flush(); assert.equal(h.editor.scrollTop, 0);
  h.editor.userScroll(0); h.clock.flush(); assert.equal(h.preview.scrollTop, 0);
  h.editor.scrollHeight = 4600; h.preview.scrollHeight = 300;
  h.editor.userScroll(2000); h.clock.flush(); assert.equal(h.preview.scrollTop, 0);
  assert.ok(Number.isFinite(h.sync.getRatio())); assert.equal(h.clock.frames.size, 0); h.sync.destroy();
});

test('long-to-short refresh clamps both surfaces and permits later short-to-long scrolling', () => {
  const h = rig(); h.editor.userScroll(1350); h.clock.flush();
  h.editor.scrollHeight = 100; h.preview.scrollHeight = 200; h.sync.refresh(); h.clock.flush();
  assert.equal(h.editor.scrollTop, 0); assert.equal(h.preview.scrollTop, 0);
  h.editor.userScroll(0); h.clock.flush(); near(h.sync.getRatio(), 0);
  h.editor.scrollHeight = 2400; h.preview.scrollHeight = 4600;
  h.editor.userScroll(900); h.clock.flush(); assert.equal(h.preview.scrollTop, 2000); h.sync.destroy();
});

test('explicit refresh without preserveRatio reads actual current position', () => {
  const h = rig(); h.editor.userScroll(900); h.clock.flush();
  h.preview._top = 3000; h.sync.refresh({source: 'preview', preserveRatio: false}); h.clock.flush();
  assert.equal(h.editor.scrollTop, 1350); near(h.sync.getRatio(), 0.75); h.sync.destroy();
});

test('user scroll wins over a queued metrics refresh', () => {
  const h = rig(); h.editor.userScroll(900); h.clock.flush();
  h.preview.scrollHeight = 8600; h.sync.refresh(); h.preview.userScroll(2000); h.clock.flush();
  assert.equal(h.editor.scrollTop, 450); assert.equal(h.preview.scrollTop, 2000);
  near(h.sync.getRatio(), 0.25); h.sync.destroy();
});

test('destroy is idempotent and cleans resize/load/scroll listeners plus pending work', () => {
  const h = rig({separateEvents: true}); h.editor.userScroll(900); h.sync.destroy(); h.sync.destroy();
  assert.equal(h.editor.listenerCount, 0); assert.equal(h.documentEvents.listenerCount, 0);
  assert.equal(h.windowEvents.listenerCount, 0); assert.equal(h.editorWindow.listenerCount, 0);
  assert.equal(h.clock.frames.size, 0); h.clock.cancelled[0](); assert.equal(h.preview.scrollTop, 0);
  h.sync.setEnabled(true); h.sync.refresh(); h.sync.rebindPreview(new Viewport()); h.clock.flush();
  assert.equal(h.clock.frames.size, 0); assert.equal(h.preview.scrollTop, 0);
});

test('missing fake-DOM metrics and missing Node animation frames safely produce no timers', () => {
  const editor = new Signals(), preview = new Signals();
  const sync = createScrollSync({editor, preview});
  editor.emit('scroll'); preview.emit('scroll'); sync.refresh(); sync.rebindPreview(null);
  sync.setEnabled(false); sync.setEnabled(true); sync.destroy();
  assert.equal(editor.scrollTop, undefined); assert.equal(preview.scrollTop, undefined);
  assert.equal(editor.listenerCount, 0); assert.equal(preview.listenerCount, 0);
});

test('synchronous no-browser scheduling remains loop-free for real numeric fake metrics', () => {
  const editor = new Viewport(2000, 500), preview = new Viewport(3500, 500);
  const sync = createScrollSync({editor, preview}); editor.userScroll(750);
  assert.equal(preview.scrollTop, 1500); assert.equal(editor.writes, 0); assert.equal(preview.writes, 1);
  preview.userScroll(750); assert.equal(editor.scrollTop, 375); assert.equal(editor.writes, 1); sync.destroy();
});

test('property: differing viewport wraps preserve monotonic ratios in both directions', () => {
  let seed = 31;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let sample = 0; sample < 40; sample++) {
    const h = rig({editorHeight: 1500 + random() * 5000, editorViewport: 200 + random() * 700,
      previewHeight: 2500 + random() * 11000, previewViewport: 400 + random() * 800,
      mode: sample % 2 ? 'queue' : 'sync'});
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      h.editor.userScroll(scrollMetrics(h.editor).max * progress); h.clock.flush(); h.drainEvents();
      near(scrollRatio(h.preview), progress);
      h.preview.userScroll(scrollMetrics(h.preview).max * (1 - progress)); h.clock.flush(); h.drainEvents();
      near(scrollRatio(h.editor), 1 - progress);
    }
    assert.ok(h.editor.writes + h.preview.writes <= 24); h.sync.destroy();
  }
});
