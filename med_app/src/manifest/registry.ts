import { parse as parseYaml } from 'yaml';
import { runtimeConfig } from '../config/env';
import { compileShape, type RecordShapeArtifact } from '../spec/shapes';
import type { LocalRegistryStore } from '../authoring/localClient';
import { validateManifest, type AppManifest, type LifecycleState, type ManifestIssue } from './schema';

/**
 * The local app registry: the YAML files under /manifests/<hospital_id>/ — each hospital's seed set, compiled from
 * showcase/<hospital_id>.yaml by `npm run showcase`. In the hospital deployment this is the DynamoDB registry; here it
 * is the folder, so a manifest can be edited and hot-reloaded while iterating on the catalog. The configured hospital
 * (VITE_HOSPITAL_ID) selects its set; a hospital id without a set of its own — `hsp-local` in development — sees every set.
 */
const files = import.meta.glob('/manifests/*/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/** `/manifests/<hospital_id>/<file>.yaml` → the hospital id and the file name. */
function placeOf(path: string): { hospitalId: string; file: string } {
  const m = /^\/manifests\/([^/]+)\/([^/]+)$/.exec(path);
  return m ? { hospitalId: m[1]!, file: m[2]! } : { hospitalId: '', file: path };
}

/** The hospitals that have a seed set bundled. */
export function bundledHospitals(): string[] {
  return [...new Set(Object.keys(files).map((p) => placeOf(p).hospitalId))].sort();
}

/** The set the panel shows: the configured hospital's own, or every set when it has none. */
export function bundledSetFor(hospitalId: string = runtimeConfig.hospitalId): string[] {
  const all = bundledHospitals();
  return all.includes(hospitalId) ? [hospitalId] : all;
}

/**
 * The AppSpec fixtures bundled next to the manifests (med_app/specs). Matched by file name first — a showcase
 * manifest is compiled from the spec of the same name — and by app id otherwise, they give the bundled apps what a
 * registry row carries: the spec "iterate on this app" reopens. (Compiler fixtures may share an app id with a
 * showcase app; the file name keeps them apart.)
 */
const specFiles = import.meta.glob('/specs/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** The record shapes bundled with the panel (med_app/shapes): the mock registry's library, and what the bundled apps were compiled against. */
const shapeFiles = import.meta.glob('/shapes/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function loadBundledShapes(): RecordShapeArtifact[] {
  const out: RecordShapeArtifact[] = [];
  for (const source of Object.values(shapeFiles)) {
    try {
      const r = compileShape(parseYaml(source));
      if (r.ok) out.push(r.artifact);
    } catch {
      /* a broken shape file is the spec tests' business, not the launcher's */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One step in a version's life, as the registry recorded it: who, when, from which state to which, and what they said —
 * the reason a reviewer sent it back, the notes an approver signed with. `from_state` null is the version's creation;
 * draft → draft a revision of a draft.
 */
export interface VersionEvent {
  readonly ts: string;
  readonly actor_sub: string;
  /** The person as the token named them; absent on events written before names were kept. */
  readonly actor?: { readonly name?: string; readonly email?: string };
  readonly from_state: LifecycleState | null;
  readonly to_state: LifecycleState;
  readonly notes?: string | null;
  /** An approval carries a KMS signature; the panel only needs to know it was signed. */
  readonly signed?: boolean;
}

/** What the registry knows about a version beyond its manifest — staff-only in the API, absent for clinicians. */
export interface RegistryEntryMeta {
  /** The app's owner (who created it); may submit for review and iterate. */
  readonly owner_sub?: string;
  /** Who compiled this version; may not approve it (separation of duties). */
  readonly created_by_sub?: string;
  /** Who compiled this version, as a person — "By: …" in the panel; absent for versions saved before names were kept. */
  readonly author?: { readonly name?: string; readonly email?: string };
  /** The AppSpec the version was compiled from — what "iterate on this app" reopens. Absent for hand-authored manifests. */
  readonly spec?: Record<string, unknown>;
  /** The version's lifecycle so far, newest first. */
  readonly history?: readonly VersionEvent[];
}

export type RegistryEntry =
  | { readonly file: string; readonly ok: true; readonly manifest: AppManifest; readonly meta?: RegistryEntryMeta }
  | { readonly file: string; readonly ok: false; readonly issues: ManifestIssue[]; readonly name?: string };

export function parseManifestSource(file: string, source: string): RegistryEntry {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    return { file, ok: false, issues: [{ path: '(yaml)', message: err instanceof Error ? err.message : String(err) }] };
  }
  const result = validateManifest(raw);
  if (result.ok) return { file, ok: true, manifest: result.manifest };
  const name = (raw as { metadata?: { name?: string } } | null)?.metadata?.name;
  return { file, ok: false, issues: result.issues, name };
}

function bundledSpecs(): { byFile: Map<string, Record<string, unknown>>; byAppId: Map<string, Record<string, unknown>> } {
  const byFile = new Map<string, Record<string, unknown>>();
  const byAppId = new Map<string, Record<string, unknown>>();
  for (const [path, source] of Object.entries(specFiles)) {
    try {
      const spec = parseYaml(source) as { app?: { app_id?: string } } | null;
      if (!spec?.app?.app_id) continue;
      byFile.set(path.replace(/^\/specs\//, ''), spec as Record<string, unknown>);
      if (!byAppId.has(spec.app.app_id)) byAppId.set(spec.app.app_id, spec as Record<string, unknown>);
    } catch {
      /* a broken fixture is the spec tests' business, not the launcher's */
    }
  }
  return { byFile, byAppId };
}

export function loadRegistry(hospitalId: string = runtimeConfig.hospitalId): RegistryEntry[] {
  const specs = bundledSpecs();
  const sets = new Set(bundledSetFor(hospitalId));
  return Object.entries(files)
    .filter(([path]) => sets.has(placeOf(path).hospitalId))
    .map(([path, source]) => parseManifestSource(placeOf(path).file, source))
    .map((e): RegistryEntry => {
      const spec = e.ok ? (specs.byFile.get(e.file) ?? specs.byAppId.get(e.manifest.metadata.app_id)) : undefined;
      return e.ok && spec ? { ...e, meta: { spec } } : e;
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The versions the registry API presents to staff: per app, the published version, — while a newer one is being
 * drafted or reviewed — that one too, and every deprecated one (superseded or retired) for the Deprecated tab.
 * Locally saved versions (the authoring loop in mock mode) take part like any other. Mock mode has no clinicians,
 * so this is the staff view.
 */
export function presentVersions(entries: RegistryEntry[]): RegistryEntry[] {
  const byApp = new Map<string, Extract<RegistryEntry, { ok: true }>[]>();
  const out: RegistryEntry[] = [];
  for (const e of entries) {
    if (!e.ok) {
      out.push(e);
      continue;
    }
    const list = byApp.get(e.manifest.metadata.app_id) ?? [];
    list.push(e);
    byApp.set(e.manifest.metadata.app_id, list);
  }
  for (const versions of byApp.values()) {
    const published = versions.find((v) => v.manifest.lifecycle.state === 'published');
    const newest = versions.reduce((best, v) => (compareVersions(v.manifest.metadata.version, best.manifest.metadata.version) > 0 ? v : best));
    if (published) out.push(published);
    if (newest !== published) out.push(newest);
    for (const v of versions) if (v !== published && v !== newest && v.manifest.lifecycle.state === 'deprecated') out.push(v);
  }
  return out;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * The entry for an app: a specific version when asked for one, otherwise the published version, else
 * the newest (the registry may list a published version and its successor side by side).
 */
export function findEntry(entries: RegistryEntry[], appId: string, version?: string): Extract<RegistryEntry, { ok: true }> | undefined {
  const versions = entries.filter((e): e is Extract<RegistryEntry, { ok: true }> => e.ok && e.manifest.metadata.app_id === appId);
  if (version) return versions.find((e) => e.manifest.metadata.version === version);
  if (versions.length === 0) return undefined;
  return versions.find((e) => e.manifest.lifecycle.state === 'published') ?? versions.reduce((best, v) => (compareVersions(v.manifest.metadata.version, best.manifest.metadata.version) > 0 ? v : best));
}

export function findManifest(entries: RegistryEntry[], appId: string, version?: string): AppManifest | undefined {
  return findEntry(entries, appId, version)?.manifest;
}

/** The path that opens exactly this entry: versionless for the published one, pinned otherwise. */
/** "Lukas Hoffmann", or the email when no name was on the token; undefined when the version carries no author. */
export function authorLabel(meta: RegistryEntryMeta | undefined): string | undefined {
  return meta?.author?.name || meta?.author?.email || undefined;
}

/** Whether the signed-in person made this app or this version — what "Only my apps" shows. */
export function isMine(meta: RegistryEntryMeta | undefined, sub: string | undefined): boolean {
  return !!sub && !!meta && (meta.owner_sub === sub || meta.created_by_sub === sub);
}

export function appPath(entry: Extract<RegistryEntry, { ok: true }>): string {
  const { app_id, version } = entry.manifest.metadata;
  return entry.manifest.lifecycle.state === 'published' ? `/apps/${encodeURIComponent(app_id)}` : `/apps/${encodeURIComponent(app_id)}/${encodeURIComponent(version)}`;
}

/** The approver's review of a version — what changed against the published one — `/apps/<id>/<version>/review`. */
export function reviewPath(entry: Extract<RegistryEntry, { ok: true }>): string {
  const { app_id, version } = entry.manifest.metadata;
  return `/apps/${encodeURIComponent(app_id)}/${encodeURIComponent(version)}/review`;
}

/* ───────────────────────────── Registry sources ───────────────────────────── */

/** Where the app list comes from. The renderer does not care; it only ever sees validated manifests. */
export interface RegistrySource {
  readonly kind: 'local' | 'remote';
  load(): Promise<RegistryEntry[]>;
}

/**
 * The YAML files bundled with the app — development and catalog work — plus, when given, the apps
 * saved locally by the authoring loop (mock mode has no registry API to write to).
 */
export function localRegistrySource(authored?: LocalRegistryStore, bundled: () => RegistryEntry[] = loadRegistry): RegistrySource {
  return {
    kind: 'local',
    load: async () => {
      const saved: RegistryEntry[] = (authored?.list() ?? []).map((v) => ({
        file: `${v.app_id}@${v.version}`,
        ok: true,
        manifest: v.manifest,
        meta: { owner_sub: v.owner_sub, created_by_sub: v.created_by_sub, spec: v.spec, ...(v.author ? { author: v.author } : {}), ...(v.history ? { history: [...v.history].reverse() } : {}) },
      }));
      return presentVersions([...bundled(), ...saved]);
    },
  };
}

/** Response shape of GET /registry/apps (infra/lambdas/registry_api). */
interface RemoteApp {
  app_id: string;
  version: string;
  state: string;
  roles: string[];
  manifest_hash?: string;
  manifest: unknown;
  /** Staff only (null otherwise). */
  spec?: Record<string, unknown> | null;
  owner_sub?: string | null;
  created_by_sub?: string | null;
  author?: { name?: string | null; email?: string | null } | null;
  /** Staff only (null otherwise): the version's lifecycle events, newest first. */
  history?: RemoteEvent[] | null;
}

interface RemoteEvent {
  ts: string;
  actor_sub?: string | null;
  actor?: { name?: string | null; email?: string | null } | null;
  from_state?: string | null;
  to_state: string;
  notes?: string | null;
  signed?: boolean;
}

const LIFECYCLE: readonly string[] = ['draft', 'in_review', 'approved', 'published', 'deprecated'];

function eventOf(e: RemoteEvent): VersionEvent | null {
  if (!LIFECYCLE.includes(e.to_state) || (e.from_state && !LIFECYCLE.includes(e.from_state))) return null;
  const actor = e.actor && (e.actor.name || e.actor.email) ? { ...(e.actor.name ? { name: e.actor.name } : {}), ...(e.actor.email ? { email: e.actor.email } : {}) } : undefined;
  return {
    ts: e.ts,
    actor_sub: e.actor_sub ?? '',
    ...(actor ? { actor } : {}),
    from_state: (e.from_state as LifecycleState | null | undefined) ?? null,
    to_state: e.to_state as LifecycleState,
    ...(e.notes ? { notes: e.notes } : {}),
    ...(e.signed ? { signed: true } : {}),
  };
}

export class RegistryApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RegistryApiError';
  }
}

/**
 * The registry API over the DynamoDB table. The API already applies the visibility rule for the
 * caller; every manifest is still validated here before the renderer sees it (defence in depth —
 * a schema skew between the pipeline and this build shows up as a rejected entry, not a crash).
 */
export function remoteRegistrySource(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  // Same receiver caveat as the dispatcher executor: keep the browser's fetch bound to the global.
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): RegistrySource {
  return {
    kind: 'remote',
    load: async () => {
      const token = await getIdToken();
      if (!token) throw new RegistryApiError(401, 'Not signed in.');
      const res = await fetchImpl(`${apiBaseUrl}/registry/apps`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new RegistryApiError(res.status, `Registry API returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      const body = (await res.json()) as { apps?: RemoteApp[] };
      return (body.apps ?? []).map((app): RegistryEntry => {
        const source = `${app.app_id}@${app.version}`;
        const result = validateManifest(app.manifest);
        if (result.ok) {
          const meta: RegistryEntryMeta = {
            ...(app.owner_sub ? { owner_sub: app.owner_sub } : {}),
            ...(app.created_by_sub ? { created_by_sub: app.created_by_sub } : {}),
            ...(app.author && (app.author.name || app.author.email) ? { author: { ...(app.author.name ? { name: app.author.name } : {}), ...(app.author.email ? { email: app.author.email } : {}) } } : {}),
            ...(app.spec ? { spec: app.spec } : {}),
            ...(app.history ? { history: app.history.map(eventOf).filter((e): e is VersionEvent => e !== null) } : {}),
          };
          return { file: source, ok: true, manifest: result.manifest, ...(Object.keys(meta).length ? { meta } : {}) };
        }
        const name = (app.manifest as { metadata?: { name?: string } } | null)?.metadata?.name;
        return { file: source, ok: false, issues: result.issues, name };
      });
    },
  };
}
