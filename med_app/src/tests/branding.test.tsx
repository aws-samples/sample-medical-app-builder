import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { branding, resolveBranding, type Palette } from '../branding';
import { loadRuntimeConfig, parseBranding, runtimeConfig } from '../config/env';
import { TopBar } from '../panel/TopBar';
import { applyBranding, brandCssVariables, contrast, currentBranding, neutralScale, rgbOf, scaleAround, scales, theme, tokens } from '../theme';

/**
 * src/branding.ts is the one file a deployment edits: the palette and the logo. Everything else derives from it, so
 * these tests hold the derivation to the design the panel shipped with (the hand-tuned scales, within a few units),
 * keep styles.css free of colours of its own, and check that a changed palette still reads.
 */

// The scales as they were hand-tuned before the palette became the source — the derivation must land on them.
const CLINICAL_AS_SHIPPED = ['#E6F3EF', '#C4E3D9', '#9FD1C1', '#78BEA8', '#55AC91', '#3A967B', '#237F65', '#0F6E56', '#0A5A46', '#064536'];
const INK_AS_SHIPPED = ['#F4F6F8', '#E3E9EE', '#C9D3DB', '#A9B7C3', '#8494A4', '#5B6B7A', '#3F4E5C', '#2A3743', '#15202B', '#0D151D'];

const within = (a: string, b: string, units: number) => rgbOf(a).every((c, i) => Math.abs(c - rgbOf(b)[i]!) <= units);

describe('the palette becomes the theme', () => {
  it('derives the colour scales from the palette and lands on the shipped design', () => {
    expect(scales.clinical[7]).toBe(branding.palette.accent);
    expect(scales.ink[8]).toBe(branding.palette.ink);
    expect(scales.ink[0]).toBe(branding.palette.page);
    expect(scales.ink[1]).toBe(branding.palette.line);
    expect(scales.ink[5]).toBe(branding.palette.muted);
    CLINICAL_AS_SHIPPED.forEach((shade, i) => expect(within(scales.clinical[i]!, shade, 14), `clinical[${i}] ${scales.clinical[i]} vs ${shade}`).toBe(true));
    INK_AS_SHIPPED.forEach((shade, i) => expect(within(scales.ink[i]!, shade, 10), `ink[${i}] ${scales.ink[i]} vs ${shade}`).toBe(true));
    expect(tokens.grid).toBe('#EDF1F4');
    expect(theme.colors?.clinical).toEqual(scales.clinical);
    expect(theme.primaryColor).toBe('clinical');
  });

  it('gives a new accent the same treatment: lighter above, darker below, the colour itself at the primary shade', () => {
    const scale = scaleAround('#1F5FA8');
    expect(scale[7]).toBe('#1F5FA8');
    expect(rgbOf(scale[0]!).every((c) => c > 220)).toBe(true); // near white, still tinted
    expect(scaleAround('#B42318')[7]).toBe('#B42318');
    const lum = scale.map((c) => rgbOf(c).reduce((a, b) => a + b, 0));
    for (let i = 1; i < lum.length; i++) expect(lum[i]!).toBeLessThan(lum[i - 1]!);
  });

  it('keeps a changed palette readable: text on the page and on cards, the accent on white, light text on ink', () => {
    const p = branding.palette;
    expect(contrast(p.ink, p.page)).toBeGreaterThan(7);
    expect(contrast(p.ink, p.surface)).toBeGreaterThan(7);
    expect(contrast(p.muted, p.surface)).toBeGreaterThan(4.5);
    expect(contrast(p.accent, p.surface)).toBeGreaterThan(4.5);
    expect(contrast(p.alert, p.surface)).toBeGreaterThan(4.5);
    expect(contrast(p.line, p.ink)).toBeGreaterThan(7); // the sign-in panel's text on its dark ground
    // The neutral scale is an order of lightness; a palette that breaks it would make the derived shades meaningless.
    const order = [p.ink, p.muted, p.line, p.page, p.surface].map((c) => rgbOf(c).reduce((a, b) => a + b, 0));
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
  });

  it('writes the CSS variables styles.css reads — and the stylesheet names no colour of its own', () => {
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    expect(css.match(/#[0-9a-fA-F]{3,6}\b/g)).toBeNull();
    expect(css.match(/rgba?\(\s*\d/g)).toBeNull();
    const vars = brandCssVariables();
    const used = new Set([...css.matchAll(/var\((--ds-[a-z-]+)/g)].map((m) => m[1]!));
    const declared = new Set([...css.matchAll(/^\s*(--ds-[a-z-]+):/gm)].map((m) => m[1]!));
    for (const name of used) expect(name in vars || declared.has(name), `${name} is used by styles.css but set nowhere`).toBe(true);
    expect(vars['--ds-ink']).toBe(branding.palette.ink);
    expect(vars['--ds-ink-rgb']).toBe('21, 32, 43');
    expect(vars['--ds-hairline']).toBe('rgba(21, 32, 43, 0.08)');
    const root = document.createElement('div');
    applyBranding(root);
    expect(root.style.getPropertyValue('--ds-page')).toBe(branding.palette.page);
    expect(root.style.getPropertyValue('--ds-shadow-card')).toContain('rgba(21, 32, 43');
    // A different palette flows through the same derivation.
    const other: Palette = { ...branding.palette, ink: '#101820', accent: '#1F5FA8' };
    expect(brandCssVariables(other)['--ds-accent-rgb']).toBe('31, 95, 168');
    expect(neutralScale(other)[8]).toBe('#101820');
  });
});

describe('the top bar shows the logo src/branding.ts gives', () => {
  const session: Session = { idToken: 't', accessToken: 'a', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub: 'sub-ada', username: 'ada', name: 'Ada Admin', email: 'ada@klinikum-musterstadt.example', groups: [] } };
  const provider: AuthProvider = { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
  const renderBar = () =>
    render(
      <MantineProvider theme={theme}>
        <AuthProviderBoundary provider={provider}>
          <MemoryRouter>
            <TopBar crumbs={[{ label: 'Blood pressure' }]} />
          </MemoryRouter>
        </AuthProviderBoundary>
      </MantineProvider>
    );

  it('without a logo: the hospital name alone, a link home', async () => {
    renderBar();
    expect(await screen.findByText(runtimeConfig.hospitalName)).toBeInTheDocument();
    expect(screen.queryByTestId('brand-logo')).toBeNull();
  });

  it('with a logo: the image before the name, the name hidden when the logo says it', async () => {
    const mutable = branding as { logo?: typeof branding.logo };
    mutable.logo = { src: '/branding/logo.svg', alt: 'Test hospital', height: 24 };
    try {
      const { unmount } = renderBar();
      const img = await screen.findByTestId('brand-logo');
      expect(img).toHaveAttribute('src', '/branding/logo.svg');
      expect(img).toHaveAttribute('alt', ''); // the name beside it is the accessible text
      expect(img.closest('ol')).toHaveClass('has-logo');
      expect(img.closest('a')).toHaveAttribute('href', '/');
      expect(screen.getByText(runtimeConfig.hospitalName)).toBeInTheDocument();
      unmount();
      mutable.logo = { src: '/branding/wordmark.svg', alt: 'Test hospital', hideName: true };
      renderBar();
      const wordmark = await screen.findByTestId('brand-logo');
      expect(wordmark).toHaveAttribute('alt', 'Test hospital');
      expect(screen.queryByText(runtimeConfig.hospitalName)).toBeNull();
    } finally {
      delete mutable.logo;
    }
  });
});

describe("a hospital's branding arrives with config.json and is applied at boot — no build", () => {
  const klinikBlue = { palette: { accent: '#1F5FA8', ink: '#101820' }, logo: { src: '/branding/logo.svg', alt: 'Klinikum Blau', height: 24, srcOnDark: '/branding/logo-on-dark.svg' } };

  it('parses VITE_BRANDING strictly: a colour must be #RRGGBB, keys must be the panel’s, and a bad value is a problem, not a crash', () => {
    expect(parseBranding('')).toEqual({});
    expect(parseBranding(JSON.stringify(klinikBlue)).branding).toEqual(klinikBlue);
    expect(parseBranding('{not json').problem).toMatch(/not valid JSON/);
    expect(parseBranding(JSON.stringify({ palette: { accent: 'blue' } })).problem).toMatch(/palette.accent/);
    expect(parseBranding(JSON.stringify({ palette: { accnt: '#1F5FA8' } })).problem).toMatch(/unrecognized|Unrecognized/);
    expect(parseBranding(JSON.stringify({ logo: { src: '/branding/x.svg' } })).problem).toMatch(/logo.alt/);
    expect(parseBranding(JSON.stringify({ font: 'Comic Sans' })).problem).toMatch(/unrecognized|Unrecognized/);
    const config = loadRuntimeConfig({ VITE_AUTH_MODE: 'mock', VITE_BRANDING: JSON.stringify(klinikBlue) });
    expect(config.branding).toEqual(klinikBlue);
    const broken = loadRuntimeConfig({ VITE_AUTH_MODE: 'mock', VITE_BRANDING: '{"palette":{"accent":"blue"}}' });
    expect(broken.branding).toBeUndefined();
    expect(broken.problems.some((p) => p.includes('VITE_BRANDING'))).toBe(true);
  });

  it('merges the override over src/branding.ts: the colours it names change, the rest stay', () => {
    const resolved = resolveBranding(klinikBlue);
    expect(resolved.palette.accent).toBe('#1F5FA8');
    expect(resolved.palette.ink).toBe('#101820');
    expect(resolved.palette.page).toBe(branding.palette.page);
    expect(resolved.logo).toEqual(klinikBlue.logo);
    expect(resolveBranding(undefined)).toBe(branding);
    expect(resolveBranding({ palette: { accent: '#1F5FA8' } }).logo).toBe(branding.logo);
  });

  it('applyBranding refills what the components read — tokens, scales, the Mantine theme, the CSS variables — and back', () => {
    const root = document.createElement('div');
    try {
      applyBranding(root, resolveBranding(klinikBlue));
      expect(currentBranding().logo?.alt).toBe('Klinikum Blau');
      expect(tokens.accent).toBe('#1F5FA8');
      expect(tokens.grid).toBe('#EDF1F4'); // page and line unchanged
      expect(scales.clinical[7]).toBe('#1F5FA8');
      expect(scales.ink[8]).toBe('#101820');
      expect(theme.colors?.clinical?.[7]).toBe('#1F5FA8');
      expect(theme.black).toBe('#101820');
      expect(root.style.getPropertyValue('--ds-accent')).toBe('#1F5FA8');
      expect(root.style.getPropertyValue('--ds-ink-rgb')).toBe('16, 24, 32');
    } finally {
      applyBranding(root);
    }
    expect(tokens.accent).toBe(branding.palette.accent);
    expect(scales.clinical[7]).toBe(branding.palette.accent);
    expect(theme.black).toBe(branding.palette.ink);
    expect(currentBranding()).toBe(branding);
  });

  it('the top bar shows the hospital’s logo from the applied branding', async () => {
    const root = document.createElement('div');
    applyBranding(root, resolveBranding(klinikBlue));
    try {
      const session: Session = { idToken: 't', accessToken: 'a', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub: 'sub-ada', username: 'ada', name: 'Ada Admin', email: 'ada@klinikum-musterstadt.example', groups: [] } };
      const provider: AuthProvider = { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
      render(
        <MantineProvider theme={theme}>
          <AuthProviderBoundary provider={provider}>
            <MemoryRouter>
              <TopBar crumbs={[{ label: 'Blood pressure' }]} />
            </MemoryRouter>
          </AuthProviderBoundary>
        </MantineProvider>
      );
      const img = await screen.findByTestId('brand-logo');
      expect(img).toHaveAttribute('src', '/branding/logo.svg');
      expect(img).toHaveAttribute('height', '24');
      expect(screen.getByText(runtimeConfig.hospitalName)).toBeInTheDocument();
    } finally {
      applyBranding(root);
    }
  });
});
