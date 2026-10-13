import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePreviewLayout, measurePreviewSpace, createPreviewLayout} from '../preview-layout.mjs';
import {createScrollSync, scrollRatio} from '../preview-sync.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);

class Signals {
  listeners = new Map();
  addEventListener(name, fn) {if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn);}
  removeEventListener(name, fn) {this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== fn));}
  emit(name) {for (const fn of this.listeners.get(name) || []) fn({type: name});}
  get listenerCount() {return [...this.listeners.values()].flat().length;}
}
function clock() {
  let serial = 0;
  const frames = new Map(), cancelled = [];
  return {frames, cancelled,
    requestFrame(fn) {const id = ++serial; frames.set(id, fn); return id;},
    cancelFrame(id) {cancelled.push(frames.get(id)); frames.delete(id);},
    flush() {let budget = 10; while (frames.size) {
      assert.ok(--budget > 0, 'Unexpected layout feedback loop');
      const [id, fn] = frames.entries().next().value; frames.delete(id); fn();
    }},
  };
}
function observerRig() {
  const observers = [];
  class Observer {
    constructor(fn) {this.fn = fn; this.disconnected = false; observers.push(this);}
    observe(target) {this.target = target;}
    disconnect() {this.disconnected = true;}
    emit() {this.fn();}
  }
  return {observers, ResizeObserverClass: Observer};
}
function rig({availableWidth = 500, viewportHeight = 590, device = 'desktop', ...options} = {}) {
  const scheduler = clock(), observation = observerRig(), windowTarget = new Signals();
  const frame = {style: {}}, stage = {style: {}}, surround = {};
  let space = {availableWidth, viewportHeight}, currentDevice = device;
  const events = [];
  const controller = createPreviewLayout({frame, stage, surround, windowTarget, ...scheduler, ...observation,
    measure: () => space, getDevice: () => currentDevice,
    onBeforeLayout: next => events.push({type: 'before', next, oldWidth: frame.style.width}),
    onLayout: next => events.push({type: 'after', next, newWidth: frame.style.width}), ...options});
  return {controller, frame, stage, surround, windowTarget, scheduler, events, ...observation,
    setSpace(next) {space = {...space, ...next};}, setDevice(next) {currentDevice = next;}};
}

test('three genuine viewport widths fit even a narrow panel including two border pixels', () => {
  for (const [device, width] of [['phone', 390], ['tablet', 768], ['desktop', 1000]]) {
    for (const availableWidth of [180, 320, 388, 450, 650, 900, 1200]) {
      const result = calculatePreviewLayout({device, availableWidth, viewportHeight: 570});
      assert.equal(result.ready, true); assert.equal(result.frameWidth, width);
      assert.equal(result.deviceWidth, width); assert.ok(result.scale > 0 && result.scale <= 1);
      assert.ok(result.displayWidth <= availableWidth + 0.000001);
      near((result.frameWidth + 2) * result.scale, result.displayWidth);
      near((result.frameHeight + 2) * result.scale, 570);
      near(result.displayHeight, 570);
    }
  }
});

test('preview scaling does not enlarge phone viewports or reduce the visual reading height', () => {
  const natural = calculatePreviewLayout({device: 'phone', availableWidth: 800, viewportHeight: 660});
  assert.equal(natural.scale, 1); assert.equal(natural.displayWidth, 392); assert.equal(natural.frameHeight, 658);
  const scaled = calculatePreviewLayout({device: 'desktop', availableWidth: 501, viewportHeight: 660});
  assert.equal(scaled.scale, 0.5); assert.equal(scaled.frameWidth, 1000); assert.equal(scaled.frameHeight, 1318);
  assert.equal(scaled.displayHeight, 660); assert.equal(scaled.displayWidth, 501);
});

test('a fitted clip stage contains every transformed frame edge, including desktop border', () => {
  for (const device of ['phone', 'tablet', 'desktop']) for (const availableWidth of [212, 389, 590, 875]) {
    const layout = calculatePreviewLayout({device, availableWidth, viewportHeight: 590});
    // With top-left origin, absolute left/top zero and zero margins, clip removes
    // only the obsolete unscaled layout overflow; these entire visible edges fit.
    const visual = {left: 0, top: 0, right: (layout.frameWidth + layout.borderWidth * 2) * layout.scale,
      bottom: (layout.frameHeight + layout.borderWidth * 2) * layout.scale};
    assert.ok(visual.left >= 0 && visual.top >= 0);
    assert.ok(visual.right <= layout.displayWidth + 0.000001);
    assert.ok(visual.bottom <= layout.displayHeight + 0.000001);
    assert.ok(visual.right <= availableWidth + 0.000001);
    near(visual.bottom, 590);
  }
});

test('invalid/hidden/zero geometry is finite and deferred instead of writing invalid CSS', () => {
  for (const availableWidth of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '500', {}, Number.MIN_VALUE]) {
    const result = calculatePreviewLayout({availableWidth});
    assert.equal(result.ready, false);
    for (const [name, value] of Object.entries(result)) if (typeof value === 'number') assert.ok(Number.isFinite(value), name);
  }
  for (const viewportHeight of [NaN, Infinity, -1, 0, {}, '660']) {
    const result = calculatePreviewLayout({availableWidth: 500, viewportHeight});
    assert.equal(result.displayHeight, 590); assert.equal(result.ready, true);
  }
});

test('device allowlist and border inputs never coerce malicious or inherited keys', () => {
  for (const device of ['constructor', '__proto__', 'prototype', 1000, {}, {toString: null}, null]) {
    assert.equal(calculatePreviewLayout({device, availableWidth: 500}).frameWidth, 390);
  }
  for (const borderWidth of [-1, Infinity, NaN, '1', {}]) {
    assert.equal(calculatePreviewLayout({availableWidth: 500, borderWidth}).borderWidth, 1);
  }
  const borderless = calculatePreviewLayout({device: 'tablet', availableWidth: 384, borderWidth: 0});
  assert.equal(borderless.scale, 0.5); assert.equal(borderless.frameHeight, 1180);
  assert.equal(calculatePreviewLayout({availableWidth: 300, borderWidth: 500}).borderWidth, 20);
});

test('space measurement uses client content width minus CSS padding, never transformed rect width', () => {
  const surround = {clientWidth: 532, getBoundingClientRect() {throw new Error('Do not measure transformed outer rect');}};
  const computed = {paddingLeft: '16px', paddingRight: '16px', getPropertyValue: key => key === '--preview-height' ? '660px' : ''};
  assert.deepEqual(measurePreviewSpace(surround, {getComputedStyle: () => computed}), {availableWidth: 500, viewportHeight: 660});
  computed.paddingLeft = '12.5px'; computed.paddingRight = '7.5px';
  assert.deepEqual(measurePreviewSpace(surround, {getComputedStyle: () => computed}), {availableWidth: 512, viewportHeight: 660});
  assert.deepEqual(measurePreviewSpace({clientWidth: 12}, {getComputedStyle: () => computed}), {availableWidth: 0, viewportHeight: 660});
});

test('default measurement without DOM geometry or unavailable computed styles is safe', () => {
  assert.deepEqual(measurePreviewSpace({}), {availableWidth: 0, viewportHeight: 590});
  assert.deepEqual(measurePreviewSpace(null), {availableWidth: 0, viewportHeight: 590});
  assert.deepEqual(measurePreviewSpace({clientWidth: Infinity}), {availableWidth: 0, viewportHeight: 590});
  assert.deepEqual(measurePreviewSpace({clientWidth: 400}, {getComputedStyle() {throw new Error('Missing browser');}}),
    {availableWidth: 400, viewportHeight: 590});
  const controller = createPreviewLayout({frame: {setAttribute() {throw new Error('No geometry must not mutate');}}, surround: {}, stage: {}});
  controller.refresh(); assert.equal(controller.getLayout(), null); controller.destroy();
});

test('layout application keeps intrinsic dimensions and places scaled stage before after hook', () => {
  const h = rig({availableWidth: 501}); h.controller.refresh(); h.scheduler.flush();
  assert.equal(h.frame.style.width, '1000px'); assert.equal(h.frame.style.height, '1178px');
  assert.equal(h.frame.style.transform, 'scale(0.5)'); assert.equal(h.frame.style.transformOrigin, '0 0');
  assert.equal(h.frame.style.boxSizing, 'content-box'); assert.equal(h.frame.style.borderWidth, '1px');
  assert.equal(h.frame.style.position, 'absolute'); assert.equal(h.frame.style.top, '0'); assert.equal(h.frame.style.left, '0');
  assert.equal(h.stage.style.width, '501px'); assert.equal(h.stage.style.height, '590px');
  assert.equal(h.events[0].type, 'before'); assert.equal(h.events[0].oldWidth, undefined);
  assert.equal(h.events[1].type, 'after'); assert.equal(h.events[1].newWidth, '1000px');
  assert.equal(h.controller.getLayout().frameWidth, 1000); h.controller.destroy();
});

test('resize observer and window events coalesce into current geometry and avoid feedback', () => {
  const h = rig(); assert.equal(h.observers[0].target, h.surround);
  h.controller.refresh(); h.observers[0].emit(); h.windowTarget.emit('resize');
  h.setSpace({availableWidth: 760, viewportHeight: 570}); h.windowTarget.emit('resize');
  assert.equal(h.scheduler.frames.size, 1); h.scheduler.flush();
  near(h.controller.getLayout().scale, 760 / 1002); assert.equal(h.events.length, 2);
  for (let i = 0; i < 5; i++) {h.observers[0].emit(); h.scheduler.flush();}
  assert.equal(h.events.length, 2); assert.equal(h.scheduler.frames.size, 0);
  h.setDevice('tablet'); h.controller.refresh(); h.scheduler.flush();
  assert.equal(h.frame.style.width, '768px'); assert.ok(h.controller.getLayout().displayWidth <= 760);
  h.controller.destroy();
});

test('force refresh restores transform after UI base-style changes at the same geometry', () => {
  const h = rig(); h.controller.refresh(); h.scheduler.flush();
  h.frame.style.transform = ''; h.controller.refresh({force: true}); h.controller.refresh(); h.scheduler.flush();
  assert.equal(h.frame.style.transform, `scale(${500 / 1002})`); assert.equal(h.events.length, 4);
  h.controller.destroy();
});

test('temporarily hidden panels retain last safe layout then recover on becoming visible', () => {
  const h = rig(); h.controller.refresh(); h.scheduler.flush(); const old = h.controller.getLayout();
  h.setSpace({availableWidth: 0}); h.windowTarget.emit('resize'); h.scheduler.flush();
  assert.equal(h.controller.getLayout(), old); assert.equal(h.events.length, 2);
  h.setSpace({availableWidth: 300}); h.observers[0].emit(); h.scheduler.flush();
  assert.equal(h.controller.getLayout().displayWidth, 300); assert.equal(h.frame.style.width, '1000px');
  h.controller.destroy();
});

test('a force refresh requested while hidden is retained for identical visible geometry', () => {
  const h = rig(); h.controller.refresh(); h.scheduler.flush();
  h.setSpace({availableWidth: 0}); h.frame.style.transform = '';
  h.controller.refresh({force: true}); h.scheduler.flush(); assert.equal(h.frame.style.transform, '');
  h.setSpace({availableWidth: 500}); h.observers[0].emit(); h.scheduler.flush();
  assert.equal(h.frame.style.transform, `scale(${500 / 1002})`); assert.equal(h.events.length, 4);
  h.controller.destroy();
});

test('destroy removes observer/window listeners and stale scheduled callbacks cannot mutate', () => {
  const h = rig(); h.controller.refresh(); h.controller.destroy(); h.controller.destroy();
  assert.equal(h.windowTarget.listenerCount, 0); assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.scheduler.frames.size, 0); h.scheduler.cancelled[0]();
  h.observers[0].emit(); h.windowTarget.emit('resize'); h.controller.refresh({force: true}); h.scheduler.flush();
  assert.deepEqual(h.frame.style, {}); assert.deepEqual(h.stage.style, {}); assert.equal(h.events.length, 0);
});

test('missing ResizeObserver falls back to window resize; failed observation is disconnected', () => {
  const h = rig({ResizeObserverClass: null}); h.windowTarget.emit('resize'); h.scheduler.flush();
  assert.equal(h.frame.style.width, '1000px'); h.controller.destroy();
  let cleaned = false;
  class FailingObserver {observe() {throw new Error('Unavailable');} disconnect() {cleaned = true;}}
  const fallback = rig({ResizeObserverClass: FailingObserver}); assert.equal(cleaned, true);
  fallback.windowTarget.emit('resize'); fallback.scheduler.flush(); assert.ok(fallback.controller.getLayout()); fallback.controller.destroy();
});

test('element fallback uses only finite CSS geometry when style object is absent', () => {
  const attrs = {}, frame = {setAttribute(name, value) {attrs.frame = value;}}, stage = {setAttribute(name, value) {attrs.stage = value;}};
  const controller = createPreviewLayout({frame, stage, measure: () => ({availableWidth: 300}), getDevice: () => 'desktop'});
  controller.refresh(); assert.match(attrs.frame, /width:1000px/); assert.match(attrs.frame, /transform:scale\(/);
  assert.match(attrs.stage, /width:300px/); assert.doesNotMatch(JSON.stringify(attrs), /NaN|Infinity|url\(/); controller.destroy();
});

test('scaled viewport changes preserve synchronized reading progress across width and image reflow', () => {
  const editor = Object.assign(new Signals(), {scrollTop: 900, scrollHeight: 2400, clientHeight: 600});
  const preview = Object.assign(new Signals(), {scrollTop: 0, scrollHeight: 5000, clientHeight: 588});
  const sync = createScrollSync({editor, preview}); sync.refresh(); near(scrollRatio(preview), 0.5);
  const h = rig({availableWidth: 350, device: 'desktop', onLayout(next) {
    preview.clientHeight = next.frameHeight; sync.refresh({preserveRatio: true});
  }});
  h.controller.refresh(); h.scheduler.flush(); near(scrollRatio(preview), 0.5); near(scrollRatio(editor), 0.5);
  h.setSpace({availableWidth: 900, viewportHeight: 660}); h.windowTarget.emit('resize'); h.scheduler.flush();
  near(scrollRatio(preview), 0.5); assert.equal(editor.scrollTop, 900);
  preview.scrollHeight = 8000; preview.emit('load'); near(scrollRatio(preview), 0.5);
  h.setDevice('phone'); h.controller.refresh(); h.scheduler.flush(); assert.equal(h.controller.getLayout().frameWidth, 390);
  near(scrollRatio(preview), 0.5); sync.destroy(); h.controller.destroy();
});

test('disabled sync allows independent preview reading ratio to survive layout via hooks', () => {
  const editor = Object.assign(new Signals(), {scrollTop: 900, scrollHeight: 2400, clientHeight: 600});
  const preview = Object.assign(new Signals(), {scrollTop: 1103, scrollHeight: 5000, clientHeight: 588});
  const sync = createScrollSync({editor, preview, enabled: false}); let saved = 0;
  const h = rig({onBeforeLayout() {saved = scrollRatio(preview);}, onLayout(next) {
    preview.clientHeight = next.frameHeight; preview.scrollTop = (preview.scrollHeight - preview.clientHeight) * saved;
  }});
  h.controller.refresh(); h.scheduler.flush(); near(scrollRatio(preview), 0.25); assert.equal(editor.scrollTop, 900);
  h.setSpace({availableWidth: 800}); h.windowTarget.emit('resize'); h.scheduler.flush();
  near(scrollRatio(preview), 0.25); sync.destroy(); h.controller.destroy();
});

test('property: all three visual viewports stay inside finite panel widths with stable target heights', () => {
  for (const device of ['phone', 'tablet', 'desktop']) for (let width = 37; width <= 1700; width += 43) {
    const result = calculatePreviewLayout({device, availableWidth: width, viewportHeight: 585.5});
    assert.ok(result.displayWidth <= width + 0.000001); near(result.displayHeight, 585.5);
    assert.ok(result.frameHeight > 0); assert.equal(result.frameWidth, {phone: 390, tablet: 768, desktop: 1000}[device]);
  }
});
