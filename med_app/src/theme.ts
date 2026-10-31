import { createTheme, type MantineColorsTuple, type MantineThemeOverride } from '@mantine/core';
import { branding, type Branding, type Palette } from './branding';

/**
 * The theme, derived from the branding — src/branding.ts by default, the hospital's own (config.json → `VITE_BRANDING`)
 * once `applyBranding` has run at boot. This module turns the palette into everything the code reads: the design
 * tokens (`tokens`), Mantine's colour scales (`clinical` from the accent, `ink` from the neutral anchors), the
 * shadows, and the CSS variables styles.css uses (`brandCssVariables`). No other file names a colour.
 *
 * `tokens`, `scales` and `theme` are filled by `applyBranding`, which main.tsx calls after config.json is in and
 * before anything renders — the same once-at-boot arrangement as `runtimeConfig`. Components read them at render
 * time, so none of the 17 files importing `tokens` knows whose palette it is showing.
 *
 * The visual system in three rules, applied through this theme and styles.css:
 *   shape    cards 12 px, controls and inputs 8 px, badges 6 px — nothing else
 *   depth    a hairline plus a diffused shadow tinted with the ink colour; never a grey drop shadow
 *   motion   transform and opacity only, under 200 ms, ease-out; nothing moves unless it answers the user
 */

type Rgb = readonly [number, number, number];

export function rgbOf(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) throw new Error(`branding: ${hex} is not a hex colour`);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hexOf = (rgb: Rgb): string => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** `t` of the way from `from` to `to`, in sRGB — the mixing the hand-tuned scales were made with. */
export function mix(from: string, to: string, t: number): string {
  const a = rgbOf(from);
  const b = rgbOf(to);
  return hexOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/** Relative luminance (WCAG), for the contrast checks the tests run on a changed palette. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

type Hsl = readonly [number, number, number];

function hslOf(hex: string): Hsl {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

function hexFromHsl([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector] as [number, number, number];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/**
 * A ten-shade Mantine scale around one colour, which sits at index 7 (the theme's primary shade). The hue is kept;
 * the lightness runs evenly from near-white down to the colour, then two darker steps; the saturation of the light
 * shades is held at under half the colour's own, rising to it over the last two steps — which is what the hand-tuned
 * "clinical" scale the panel shipped with did, so the defaults look as they did and a new accent gets the same
 * treatment (a white mix would have washed the middle shades out).
 */
export function scaleAround(color: string): MantineColorsTuple {
  const [h, s, l] = hslOf(color);
  const steps = [0, 0.147, 0.309, 0.47, 0.632, 0.765, 0.897]; // of the way from near-white (0.93) down to the colour's lightness
  const saturation = [0.46, 0.46, 0.46, 0.46, 0.46, 0.58, 0.75].map((f) => s * f);
  const light = saturation.map((sk, k) => hexFromHsl([h, sk, 0.93 + (l - 0.93) * steps[k]!]));
  const dark = [
    [Math.min(1, s * 1.05), l * 0.8],
    [Math.min(1, s * 1.1), l * 0.6],
  ].map(([sk, lk]) => hexFromHsl([h, sk!, lk!]));
  return [...light, color.toUpperCase(), ...dark] as unknown as MantineColorsTuple;
}

/**
 * The neutral scale, anchored on the palette's own greys — page at 0, line at 1, muted at 5, ink at 8 — with the
 * steps between them mixed in. Components refer to it as the `ink` colour (`c="ink.5"`, `var(--mantine-color-ink-1)`).
 */
export function neutralScale(p: Pick<Palette, 'page' | 'line' | 'muted' | 'ink'>): MantineColorsTuple {
  return [p.page, p.line, mix(p.line, p.muted, 0.19), mix(p.line, p.muted, 0.43), mix(p.line, p.muted, 0.7), p.muted, mix(p.muted, p.ink, 0.4), mix(p.muted, p.ink, 0.7), p.ink, mix(p.ink, '#000000', 0.35)].map((c) =>
    c.toUpperCase()
  ) as unknown as MantineColorsTuple;
}

/** The palette's colours as written plus the few the components need derived from them. */
export type Tokens = Palette & {
  /** Chart furniture: grid lines lighter than table rules, so the data is the darkest thing in the plot. */
  grid: string;
  /** A tint of the alert colour for the border of a warning card. */
  alertTint: string;
};

export type Scales = { clinical: MantineColorsTuple; ink: MantineColorsTuple };

function deriveTokens(p: Palette): Tokens {
  return { ...p, grid: mix(p.page, p.line, 0.4), alertTint: mix(p.alert, p.surface, 0.7) };
}

function deriveScales(p: Palette): Scales {
  return { clinical: scaleAround(p.accent), ink: neutralScale(p) };
}

/**
 * Design tokens, shared by the panel, the app shell and the design-system components. Filled for the default
 * branding at import, refilled by `applyBranding` — the object's identity never changes, so every importer sees the
 * current palette.
 */
export const tokens: Tokens = deriveTokens(branding.palette);
export const scales: Scales = deriveScales(branding.palette);

let current: Branding = branding;

/** The branding the panel runs with: the defaults, or the hospital's once `applyBranding` has run. */
export function currentBranding(): Branding {
  return current;
}

/**
 * The colour variables styles.css reads — set on the document root by `applyBranding()` before the first render, so
 * the stylesheet names no colour of its own. Derived shades: `stripe` and `hover` for table rows, `line-soft` for a
 * quieter rule, `ink-raised` and `ink-rule` for cards and rules on the dark sign-in panel.
 */
export function brandCssVariables(p: Palette = current.palette): Record<string, string> {
  const ink = rgbOf(p.ink).join(', ');
  const accent = rgbOf(p.accent).join(', ');
  return {
    '--ds-page': p.page,
    '--ds-surface': p.surface,
    '--ds-ink': p.ink,
    '--ds-muted': p.muted,
    '--ds-line': p.line,
    '--ds-accent': p.accent,
    '--ds-alert': p.alert,
    '--ds-ink-rgb': ink,
    '--ds-accent-rgb': accent,
    '--ds-grid': mix(p.page, p.line, 0.4),
    '--ds-stripe': mix(p.surface, p.page, 0.6),
    '--ds-hover': mix(p.page, p.line, 0.18),
    '--ds-line-soft': mix(p.line, p.muted, 0.075),
    '--ds-ink-raised': mix(p.ink, p.muted, 0.08),
    '--ds-ink-rule': mix(p.ink, p.muted, 0.36),
    '--ds-hairline': `rgba(${ink}, 0.08)`,
    '--ds-shadow-card': `0 1px 2px rgba(${ink}, 0.04), 0 10px 30px -22px rgba(${ink}, 0.25)`,
  };
}

/**
 * Makes `b` the panel's branding: the CSS variables on the document root, the tokens and scales the components read,
 * the Mantine theme. main.tsx calls it once, after config.json, before the first render; the default branding without
 * an argument.
 */
export function applyBranding(root: HTMLElement = document.documentElement, b: Branding = branding): void {
  current = b;
  Object.assign(tokens, deriveTokens(b.palette));
  Object.assign(scales, deriveScales(b.palette));
  theme = makeTheme(b.palette);
  for (const [name, value] of Object.entries(brandCssVariables(b.palette))) root.style.setProperty(name, value);
}

// Geist, self-hosted (@fontsource-variable, imported in main.tsx): a neutral grotesk with tabular figures that
// read well at 13–14 px in dense tables. Geist Mono for identifiers (MRNs, UIDs, codes).
const FONT_STACK = '"Geist Variable", system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_STACK = '"Geist Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The Mantine theme for a palette; `theme` below is the current one. */
export function makeTheme(p: Palette = current.palette): MantineThemeOverride {
  const inkRgb = rgbOf(p.ink).join(', ');
  const shadowCard = `0 1px 2px rgba(${inkRgb}, 0.04), 0 10px 30px -22px rgba(${inkRgb}, 0.25)`;
  const s = deriveScales(p);
  return createTheme({
  fontFamily: FONT_STACK,
  fontFamilyMonospace: MONO_STACK,
  headings: {
    fontFamily: FONT_STACK,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '1.625rem', lineHeight: '1.2' },
      h2: { fontSize: '1.3125rem', lineHeight: '1.25' },
      h3: { fontSize: '1.0625rem', lineHeight: '1.3' },
      h4: { fontSize: '0.9375rem', lineHeight: '1.35' },
    },
  },
  primaryColor: 'clinical',
  primaryShade: 7,
  colors: { clinical: s.clinical, ink: s.ink },
  defaultRadius: 'md',
  black: p.ink,
  // Depth tokens: tinted with the ink colour, diffused, never a grey drop shadow (styles.css applies them).
  shadows: {
    xs: `0 1px 2px rgba(${inkRgb}, 0.04)`,
    sm: shadowCard,
    md: `0 2px 4px rgba(${inkRgb}, 0.04), 0 16px 40px -24px rgba(${inkRgb}, 0.28)`,
    lg: `0 4px 8px rgba(${inkRgb}, 0.05), 0 24px 56px -24px rgba(${inkRgb}, 0.3)`,
    xl: `0 8px 16px rgba(${inkRgb}, 0.06), 0 32px 72px -24px rgba(${inkRgb}, 0.32)`,
  },
  components: {
    // Cards: 12 px, a hairline and the small tinted shadow (`.ds-paper` in styles.css).
    Paper: { defaultProps: { radius: 12 }, classNames: { root: 'ds-paper' } },
    Badge: { defaultProps: { radius: 6, variant: 'light' }, classNames: { root: 'ds-badge' } },
    Table: { defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'sm' }, classNames: { table: 'ds-table' } },
    Button: { defaultProps: { radius: 'md' }, classNames: { root: 'ds-press' } },
    ActionIcon: { defaultProps: { radius: 'md' }, classNames: { root: 'ds-press' } },
    SegmentedControl: { defaultProps: { radius: 'md' } },
    TextInput: { defaultProps: { radius: 'md' } },
    PasswordInput: { defaultProps: { radius: 'md' } },
    Textarea: { defaultProps: { radius: 'md' } },
    Select: { defaultProps: { radius: 'md' } },
    NumberInput: { defaultProps: { radius: 'md' } },
    Alert: { defaultProps: { radius: 'md' } },
    Skeleton: { defaultProps: { radius: 'md' } },
    Title: { classNames: { root: 'ds-title' } },
    // Every tab strip — the panel's and the ones rendered inside apps — shows the selected tab in bold (styles.css).
    Tabs: { classNames: { tab: 'ds-tab' } },
  },
  });
}

/** The current Mantine theme — a live binding: `applyBranding` replaces it, App.tsx reads it at render. */
export let theme: MantineThemeOverride = makeTheme(branding.palette);
