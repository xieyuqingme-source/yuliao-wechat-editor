import {DEVICE_WIDTHS} from './layout-settings.mjs';

const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const deviceName = value => typeof value === 'string' && Object.hasOwn(DEVICE_WIDTHS, value) ? value : 'phone';

/** The iframe retains its real CSS content width; only its preview surface scales. */
export function calculatePreviewLayout({device = 'phone', availableWidth, viewportHeight = 590,
  borderWidth = 1} = {}) {
  const name = deviceName(device), deviceWidth = DEVICE_WIDTHS[name];
  const border = typeof borderWidth === 'number' && Number.isFinite(borderWidth) && borderWidth >= 0
    ? Math.min(20, borderWidth) : 1;
  const height = finitePositive(viewportHeight) ? viewportHeight : 590;
  const outerWidth = deviceWidth + 2 * border;
  const base = {device: name, deviceWidth, frameWidth: deviceWidth, borderWidth: border,
    scale: 1, frameHeight: Math.max(0, height - 2 * border),
    displayWidth: outerWidth, displayHeight: Math.max(height, 2 * border), ready: false};
  if (!finitePositive(availableWidth)) return base;
  const scale = Math.min(1, availableWidth / outerWidth);
  const frameHeight = height / scale - 2 * border;
  // Hidden panels and degenerate geometry must never write Infinity into CSS.
  if (!finitePositive(scale) || !Number.isFinite(frameHeight)) return base;
  return {...base, scale, frameHeight: Math.max(0, frameHeight),
    displayWidth: outerWidth * scale,
    displayHeight: (Math.max(0, frameHeight) + 2 * border) * scale, ready: true};
}

/** Measure the containing content box, excluding its padding. No file or network access. */
export function measurePreviewSpace(surround, windowTarget = surround?.ownerDocument?.defaultView) {
  const width = surround?.clientWidth;
  let computed = null;
  try {computed = windowTarget?.getComputedStyle?.(surround) ?? null;} catch {}
  const padding = value => typeof value === 'string' && /^\d+(?:\.\d+)?px$/.test(value.trim())
    ? Number.parseFloat(value) : 0;
  const rawHeight = computed?.getPropertyValue?.('--preview-height');
  const viewportHeight = padding(rawHeight) || 590;
  return {availableWidth: typeof width === 'number' && Number.isFinite(width)
    ? Math.max(0, width - padding(computed?.paddingLeft) - padding(computed?.paddingRight)) : 0,
    viewportHeight};
}

const fallbackFrame = callback => {callback(); return null;};
const sameLayout = (one, two) => one && two && ['device', 'scale', 'frameWidth', 'frameHeight',
  'borderWidth', 'displayWidth', 'displayHeight', 'ready'].every(key => one[key] === two[key]);
const setStyle = (element, values) => {
  if (!element) return;
  if (element.style) {
    for (const [name, value] of Object.entries(values)) element.style[name] = value;
  } else element.setAttribute?.('style', Object.entries(values)
    .map(([name, value]) => `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${value}`).join(';'));
};

/**
 * Fit a real-width iframe into a scaled visual stage. Both the stage and frame
 * must be inside surround; stage must be position:relative and frame:absolute.
 * Hooks let the app retain reading progress before/after viewport changes.
 * Geometry changes are coalesced; no timers, draft fields or article HTML used.
 */
export function createPreviewLayout({frame, surround, stage, getDevice = () => 'phone',
  onBeforeLayout = () => {}, onLayout = () => {},
  windowTarget = surround?.ownerDocument?.defaultView ?? globalThis.window,
  ResizeObserverClass = windowTarget?.ResizeObserver ?? globalThis.ResizeObserver,
  requestFrame = windowTarget?.requestAnimationFrame?.bind(windowTarget) ?? fallbackFrame,
  cancelFrame = windowTarget?.cancelAnimationFrame?.bind(windowTarget) ?? (() => {}),
  measure = () => measurePreviewSpace(surround, windowTarget)} = {}) {
  let destroyed = false, queued = false, frameId = null, ticket = 0, forcePending = false;
  let current = null, observer = null;
  const apply = force => {
    if (destroyed) return current;
    let geometry;
    try {geometry = measure() || {};} catch {geometry = {};}
    const next = calculatePreviewLayout({...geometry, device: getDevice()});
    if (!next.ready || !frame || !stage) {
      // Keep a requested reapplication while hidden (for example after an app
      // style reset), so the next measurable resize also restores the scale.
      forcePending ||= force === true;
      return current;
    }
    if (!force && sameLayout(current, next)) return current;
    onBeforeLayout(next, current);
    setStyle(stage, {position: 'relative', width: `${next.displayWidth}px`, height: `${next.displayHeight}px`});
    setStyle(frame, {width: `${next.frameWidth}px`, height: `${next.frameHeight}px`,
      maxWidth: 'none', flex: 'none', margin: '0', boxSizing: 'content-box',
      position: 'absolute', left: '0', top: '0',
      borderWidth: `${next.borderWidth}px`, transform: `scale(${next.scale})`, transformOrigin: '0 0'});
    current = next;
    onLayout(next);
    return current;
  };
  const refresh = ({force = false} = {}) => {
    if (destroyed) return;
    forcePending ||= force === true;
    if (queued) return;
    queued = true;
    const activeTicket = ++ticket;
    const id = requestFrame(() => {
      if (destroyed || !queued || activeTicket !== ticket) return;
      queued = false; frameId = null;
      const forced = forcePending; forcePending = false;
      apply(forced);
    });
    if (queued && activeTicket === ticket) frameId = id;
  };
  const onResize = () => refresh();
  windowTarget?.addEventListener?.('resize', onResize);
  if (surround && typeof ResizeObserverClass === 'function') {
    try {observer = new ResizeObserverClass(onResize); observer.observe(surround);} catch {
      observer?.disconnect?.(); observer = null;
    }
  }
  return {
    refresh,
    getLayout: () => current,
    destroy() {
      if (destroyed) return;
      destroyed = true; ticket++; queued = false; forcePending = false;
      if (frameId !== null && frameId !== undefined) cancelFrame(frameId);
      frameId = null;
      observer?.disconnect?.(); observer = null;
      windowTarget?.removeEventListener?.('resize', onResize);
    },
  };
}
