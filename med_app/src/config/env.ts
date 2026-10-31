import { z } from 'zod';
import { PALETTE_KEYS, type BrandingOverride } from '../branding';

/**
 * Runtime configuration, read from Vite env (`.env`, `.env.local`, …).
 * Everything the browser needs is prefixed VITE_. Validation happens once at startup so
 * misconfiguration surfaces as a readable message on the sign-in screen, not a stack trace.
 */
const EnvSchema = z.object({
  VITE_HOSPITAL_ID: z.string().default('hsp-local'),
  VITE_HOSPITAL_NAME: z.string().default(''),
  VITE_AUTH_MODE: z.enum(['cognito', 'mock']).default('cognito'),
  VITE_COGNITO_REGION: z.string().default(''),
  VITE_COGNITO_USER_POOL_ID: z.string().default(''),
  VITE_COGNITO_CLIENT_ID: z.string().default(''),
  VITE_DATA_MODE: z.enum(['mock', 'dispatcher']).default('mock'),
  VITE_REGISTRY_MODE: z.enum(['local', 'remote']).default('local'),
  VITE_API_BASE_URL: z.string().default(''),
  VITE_OHIF_VIEWER_URL: z.string().default(''),
  VITE_OHIF_DATA_SOURCE: z.string().default(''),
  /** The hospital's branding as JSON (infra/hospitals/<id>.json → config.json): a palette override and/or a logo. Empty: src/branding.ts. */
  VITE_BRANDING: z.string().default(''),
  /** Mock mode only: `offline` (the chat explains there is no model) or `replay` (a recorded session is replayed turn by turn). */
  VITE_AGENT_MODE: z.enum(['offline', 'replay']).default('offline'),
});

const HEX = /^#[0-9A-Fa-f]{6}$/;
const BrandingSchema = z
  .object({
    palette: z.object(Object.fromEntries(PALETTE_KEYS.map((k) => [k, z.string().regex(HEX, 'a #RRGGBB colour').optional()]))).strict().optional(),
    logo: z
      .object({
        src: z.string().min(1),
        alt: z.string().min(1),
        height: z.number().int().min(12).max(64).optional(),
        srcOnDark: z.string().min(1).optional(),
        hideName: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `VITE_BRANDING` parsed and checked — data, not code: an unknown key or a non-colour is a problem, never applied. */
export function parseBranding(value: string): { branding?: BrandingOverride; problem?: string } {
  if (!value.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return { problem: 'VITE_BRANDING is not valid JSON; the default branding is used.' };
  }
  const parsed = BrandingSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'branding'}: ${i.message}`).join('; ');
    return { problem: `VITE_BRANDING is not a branding (${detail}); the default branding is used.` };
  }
  const { palette, logo } = parsed.data;
  const override: BrandingOverride = { ...(palette && Object.keys(palette).length ? { palette } : {}), ...(logo ? { logo } : {}) };
  return Object.keys(override).length ? { branding: override } : {};
}

export type AuthMode = 'cognito' | 'mock';
export type DataMode = 'mock' | 'dispatcher';
export type RegistryMode = 'local' | 'remote';

export interface RuntimeConfig {
  readonly hospitalId: string;
  /** Display name for the top bar; falls back to the id when not configured. */
  readonly hospitalName: string;
  readonly auth: {
    readonly mode: AuthMode;
    readonly region: string;
    readonly userPoolId: string;
    readonly clientId: string;
  };
  readonly data: {
    readonly mode: DataMode;
    readonly apiBaseUrl: string;
  };
  readonly registry: {
    /** local: manifests/*.yaml bundled with the app · remote: the registry API over the DynamoDB table */
    readonly mode: RegistryMode;
    /** With the local registry: what answers in the drafting chat — nothing (`offline`) or a recorded session (`replay`). */
    readonly agent: 'offline' | 'replay';
  };
  readonly imaging: {
    readonly ohifViewerUrl: string;
    /**
     * The OHIF data source studies are opened from (`/viewer/<name>?StudyInstanceUIDs=…`); undefined = the viewer's default,
     * the hospital's PACS. On synthetic data — a panel in mock data mode, every preview — it is `SYNTHETIC_VIEWER_SOURCE`:
     * the reference PACS that holds the synthetic studies, so a preview never asks the hospital's PACS for a UID it cannot have.
     */
    readonly viewerDataSource?: string;
  };
  /** The hospital's branding override from config.json (`VITE_BRANDING`); undefined = the defaults of src/branding.ts. */
  readonly branding?: BrandingOverride;
  /** Human-readable configuration problems. Empty when the config is usable. */
  readonly problems: readonly string[];
}

/**
 * The name of the viewer's data source for the synthetic record — a contract with the deployment
 * (infra/stacks/viewer_stack.py SYNTHETIC_SOURCE_NAME writes it into OHIF's app-config.js).
 */
export const SYNTHETIC_VIEWER_SOURCE = 'reference';

export function loadRuntimeConfig(raw: Record<string, unknown>): RuntimeConfig {
  // Drop empty strings so zod defaults apply and enums don't fail on "".
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid runtime configuration — ${detail}`);
  }
  const e = parsed.data;
  const problems: string[] = [];

  if (e.VITE_AUTH_MODE === 'cognito') {
    if (!e.VITE_COGNITO_USER_POOL_ID) problems.push('VITE_COGNITO_USER_POOL_ID is not set.');
    if (!e.VITE_COGNITO_CLIENT_ID) problems.push('VITE_COGNITO_CLIENT_ID is not set.');
    if (e.VITE_COGNITO_USER_POOL_ID && e.VITE_COGNITO_REGION && !e.VITE_COGNITO_USER_POOL_ID.startsWith(e.VITE_COGNITO_REGION + '_')) {
      problems.push(`VITE_COGNITO_USER_POOL_ID (${e.VITE_COGNITO_USER_POOL_ID}) does not belong to region ${e.VITE_COGNITO_REGION}.`);
    }
  }
  if (e.VITE_DATA_MODE === 'dispatcher' && !e.VITE_API_BASE_URL) {
    problems.push('VITE_DATA_MODE is "dispatcher" but VITE_API_BASE_URL is not set.');
  }
  if (e.VITE_REGISTRY_MODE === 'remote' && !e.VITE_API_BASE_URL) {
    problems.push('VITE_REGISTRY_MODE is "remote" but VITE_API_BASE_URL is not set.');
  }
  if (e.VITE_REGISTRY_MODE === 'remote' && e.VITE_AUTH_MODE === 'mock') {
    problems.push('VITE_REGISTRY_MODE is "remote" but VITE_AUTH_MODE is "mock": the registry API needs a real Cognito token.');
  }
  if (e.VITE_DATA_MODE === 'dispatcher' && e.VITE_AUTH_MODE === 'mock') {
    problems.push('VITE_DATA_MODE is "dispatcher" but VITE_AUTH_MODE is "mock": the dispatcher needs a real Cognito token.');
  }
  const brand = parseBranding(e.VITE_BRANDING);
  if (brand.problem) problems.push(brand.problem);

  return {
    hospitalId: e.VITE_HOSPITAL_ID,
    hospitalName: e.VITE_HOSPITAL_NAME || e.VITE_HOSPITAL_ID,
    auth: {
      mode: e.VITE_AUTH_MODE,
      region: e.VITE_COGNITO_REGION,
      userPoolId: e.VITE_COGNITO_USER_POOL_ID,
      clientId: e.VITE_COGNITO_CLIENT_ID,
    },
    data: {
      mode: e.VITE_DATA_MODE,
      apiBaseUrl: e.VITE_API_BASE_URL.replace(/\/+$/, ''),
    },
    registry: {
      mode: e.VITE_REGISTRY_MODE,
      agent: e.VITE_AGENT_MODE,
    },
    imaging: {
      ohifViewerUrl: e.VITE_OHIF_VIEWER_URL.replace(/\/+$/, ''),
      viewerDataSource: e.VITE_OHIF_DATA_SOURCE || (e.VITE_DATA_MODE === 'mock' ? SYNTHETIC_VIEWER_SOURCE : undefined),
    },
    ...(brand.branding ? { branding: brand.branding } : {}),
    problems,
  };
}

/**
 * The active configuration. Development reads it from `.env` (Vite's import.meta.env). A deployed panel
 * additionally fetches `/config.json`, written by the infrastructure at deploy time with that hospital's
 * Cognito pool, API URL, modes and branding — one build serves any deployment. `initRuntimeConfig` runs once, before
 * the app module is imported (see main.tsx), so every reader sees the final value.
 */
export let runtimeConfig: RuntimeConfig = loadRuntimeConfig(import.meta.env as Record<string, unknown>);

export function initRuntimeConfig(overrides: Record<string, unknown>): RuntimeConfig {
  runtimeConfig = loadRuntimeConfig({ ...(import.meta.env as Record<string, unknown>), ...overrides });
  return runtimeConfig;
}

/**
 * `/config.json` when the deployment provides one; `{}` otherwise (the dev server answers unknown paths
 * with index.html, which is not JSON — hence the content-type check, not just `res.ok`).
 */
export async function fetchRuntimeOverrides(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<Record<string, unknown>> {
  try {
    const res = await fetchImpl('/config.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return {};
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
    // Only the keys the schema knows; strings only — config.json is data, not code.
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k, v]) => k.startsWith('VITE_') && typeof v === 'string'));
  } catch {
    return {};
  }
}
