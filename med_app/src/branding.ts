/**
 * Branding — the one file a deployment edits to make the panel its own: the colours, and the hospital's logo in the
 * top bar. Everything else derives from what is written here (src/theme.ts): the Mantine theme and its colour scales,
 * the design tokens the components read, the CSS variables styles.css uses, the shadows, the sign-in screen. Nothing
 * else in the code names a colour.
 *
 * To re-colour the panel: change the hex values below. `accent` is the one colour with meaning (approved, in scope,
 * buttons, links); `ink`, `muted`, `line`, `page`, `surface` are the neutral scale from text to background — keep them
 * in that order of lightness, so the derived shades stay readable; `data`, `data2`, `data3` are chart series; `alert`
 * marks thresholds, violations and refusals. Run `npm test` after a change: the theme tests check contrast and order.
 *
 * To add a logo: put the file under `public/branding/` (any format the browser renders; SVG scales best) and point
 * `logo.src` at it (`/branding/logo.svg`). It appears in the top bar before the hospital's name, which stays unless
 * `hideName` is set — a wordmark logo already says the name. The sign-in screen's brand panel is dark (`ink`); a logo
 * for it must be a light variant, given as `srcOnDark`; without one the panel shows the name alone, as before.
 * An imported asset works too: `import logo from './assets/logo.svg'` and `src: logo`.
 *
 * What is written here is the default — the look of a deployment that says nothing else. A deployed hospital may
 * override it without a build: its file under infra/hospitals/ carries a palette (any subset of the colours below)
 * and a logo, which reach the panel through config.json (`VITE_BRANDING`, see src/config/env.ts) and are applied at
 * boot by `applyBranding` (src/theme.ts) — `resolveBranding` below merges them over these defaults. In development
 * the same JSON in `.env` (`VITE_BRANDING='{"palette":{"accent":"#1F5FA8"}}'`, single-quoted — dotenv would cut an
 * unquoted value at the first `#`) previews a hospital's look.
 */

export interface Palette {
  /** The page behind everything: a quiet cool grey, so clinical data sits on white surfaces. */
  readonly page: string;
  /** Cards, the top bar, the sidebar, inputs. */
  readonly surface: string;
  /** Text — a deep blue-black, not pure black. Also the sign-in screen's brand panel. */
  readonly ink: string;
  /** Secondary text, column heads, captions. */
  readonly muted: string;
  /** Hairlines and table rules. */
  readonly line: string;
  /** The one colour with meaning: approved, in scope, buttons, links, the hospital's name in the top bar. */
  readonly accent: string;
  /** Primary chart series. */
  readonly data: string;
  /** Secondary chart series. */
  readonly data2: string;
  /** Fourth chart series, after the accent. */
  readonly data3: string;
  /** Thresholds, violations, scope refusals. */
  readonly alert: string;
}

export interface Logo {
  /** URL of the image: a file under public/branding/ (`/branding/logo.svg`) or an imported asset. */
  readonly src: string;
  /** What a screen reader says in its place — the hospital's name, usually. */
  readonly alt: string;
  /** Rendered height in pixels; the width follows the image. Default 28. */
  readonly height?: number;
  /** A light variant for the dark brand panel of the sign-in screen; without it that panel shows the name alone. */
  readonly srcOnDark?: string;
  /** Leave the hospital's name out of the top bar — for a wordmark that already says it. */
  readonly hideName?: boolean;
}

export interface Branding {
  readonly palette: Palette;
  /** Omit for the hospital's name alone. */
  readonly logo?: Logo;
}

export const branding: Branding = {
  palette: {
    page: '#F4F6F8',
    surface: '#FFFFFF',
    ink: '#15202B',
    muted: '#5B6B7A',
    line: '#E3E9EE',
    accent: '#0F6E56',
    data: '#1F5FA8',
    data2: '#7A4DB3',
    data3: '#B8860B',
    alert: '#B42318',
  },
  // logo: { src: '/branding/logo.svg', alt: 'Klinikum Musterstadt', height: 28, srcOnDark: '/branding/logo-on-dark.svg' },
};

/** The colours a hospital may override, one by one; what it leaves out keeps the default above. */
export type PaletteOverride = Partial<Palette>;

/** A hospital's branding as config.json carries it: a palette override and/or a logo (its files under /branding/). */
export interface BrandingOverride {
  readonly palette?: PaletteOverride;
  readonly logo?: Logo;
}

export const PALETTE_KEYS = ['page', 'surface', 'ink', 'muted', 'line', 'accent', 'data', 'data2', 'data3', 'alert'] as const satisfies readonly (keyof Palette)[];

/** The branding a deployment runs with: the defaults above, overridden where the hospital's configuration says so. */
export function resolveBranding(override?: BrandingOverride): Branding {
  if (!override) return branding;
  const palette = { ...branding.palette, ...Object.fromEntries(Object.entries(override.palette ?? {}).filter(([, v]) => typeof v === 'string')) } as Palette;
  const logo = override.logo ?? branding.logo;
  return logo ? { palette, logo } : { palette };
}
