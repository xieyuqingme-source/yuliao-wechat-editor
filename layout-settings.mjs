/** Small, allowlisted presentation choices. No DOM, file access or network. */
export const DEVICE_WIDTHS = Object.freeze({phone: 390, tablet: 768, desktop: 1000});

export const DEFAULT_PRESENTATION = Object.freeze({
  fontSize: null,
  lineHeight: null,
  accentColor: null,
  device: 'phone',
  scrollSync: true,
});

export const THEME_TYPOGRAPHY = Object.freeze({
  clear: Object.freeze({fontSize: 16, lineHeight: 1.85, accentColor: '#237a63'}),
  warm: Object.freeze({fontSize: 16, lineHeight: 1.85, accentColor: '#995b3f'}),
  ink: Object.freeze({fontSize: 16, lineHeight: 1.85, accentColor: '#345875'}),
});

const boundedNumber = (value, min, max) => typeof value === 'number' && Number.isFinite(value)
  ? Math.round(Math.min(max, Math.max(min, value)) * 100) / 100 : null;

/** Null means the current theme's default, including after changing theme. */
export function normalizePresentation(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    fontSize: boundedNumber(value.fontSize, 14, 20),
    lineHeight: boundedNumber(value.lineHeight, 1.5, 2.2),
    accentColor: typeof value.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.accentColor)
      ? value.accentColor.toLowerCase() : null,
    device: typeof value.device === 'string' && Object.hasOwn(DEVICE_WIDTHS, value.device) ? value.device : 'phone',
    scrollSync: typeof value.scrollSync === 'boolean' ? value.scrollSync : true,
  };
}

/** Public article styling uses only these three values; preview device and sync stay local. */
export function effectiveTypography(theme = 'clear', presentation) {
  const defaults = typeof theme === 'string' && Object.hasOwn(THEME_TYPOGRAPHY, theme)
    ? THEME_TYPOGRAPHY[theme] : THEME_TYPOGRAPHY.clear;
  const normalized = normalizePresentation(presentation);
  return {
    fontSize: normalized.fontSize ?? defaults.fontSize,
    lineHeight: normalized.lineHeight ?? defaults.lineHeight,
    accentColor: normalized.accentColor ?? defaults.accentColor,
  };
}
