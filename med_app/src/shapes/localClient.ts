import { parse as parseYaml } from 'yaml';
import { compileShape, type RecordShapeArtifact } from '../spec/shapes';
import { ShapesApiError, type ShapeDetail, type ShapeEvent, type ShapeState, type ShapeSummary, type ShapeVersion, type ShapesClient } from './types';

const STORAGE_KEY = 'medapp.local-shapes';
const FIRST_VERSION = '0.1.0';
const TRANSITIONS: Record<ShapeState, readonly ShapeState[]> = { draft: ['published', 'deprecated'], published: ['deprecated'], deprecated: [] };

/** The shapes bundled with the panel (med_app/shapes): the mock library's published seed, by the same hand as the showcase apps. */
const shapeFiles = import.meta.glob('/shapes/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface LocalShapesOptions {
  readonly caller: () => { sub: string; name?: string; email?: string } | undefined;
  /** Authors and admins create and revise; the page decides too, this refuses like the API would. */
  readonly mayAuthor?: () => boolean;
  /** Approvers and admins publish and deprecate. */
  readonly mayCurate?: () => boolean;
  /** Administrators alone define shapes for a kind the platform has not admitted (an open kind, with its stamps declared). */
  readonly mayAdmin?: () => boolean;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly now?: () => string;
  readonly delayMs?: number;
}

interface Stored {
  readonly shape_id: string;
  owner_sub: string;
  active_version: string | null;
  versions: ShapeVersion[]; // oldest first
  history: ShapeEvent[]; // oldest first
}

function nextMinor(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${Number(minor) + 1}.0`;
}

function seed(now: string): Stored[] {
  const out: Stored[] = [];
  for (const source of Object.values(shapeFiles)) {
    const document = parseYaml(source) as unknown;
    const r = compileShape(document);
    if (!r.ok) continue;
    const author = { name: 'Sabine Weber', email: 'sabine.weber@klinikum-musterstadt.example' };
    out.push({
      shape_id: r.artifact.id,
      owner_sub: 'seed-sabine',
      active_version: FIRST_VERSION,
      versions: [{ version: FIRST_VERSION, state: 'published', document, artifact: r.artifact, checksum: r.artifact.checksum, created_at: now, updated_at: now, created_by_sub: 'seed-sabine', author }],
      history: [
        { version: FIRST_VERSION, ts: now, actor_sub: 'seed-sabine', actor: author, from_state: null, to_state: 'draft', notes: 'created' },
        { version: FIRST_VERSION, ts: now, actor_sub: 'seed-ada', actor: { name: 'Ada Approver' }, from_state: 'draft', to_state: 'published', notes: 'Shipped with the platform.' },
      ],
    });
  }
  return out;
}

/**
 * The library without a backend, over sessionStorage: the bundled shapes (published) plus whatever is made in this
 * browser. Same rules as the API — the document compiles, ids are fixed, a draft is revised in place, a published
 * version is followed by a new draft, curators publish (superseding the previous) and deprecate.
 */
export function localShapesClient(opts: LocalShapesOptions): ShapesClient {
  const now = opts.now ?? (() => new Date().toISOString());
  const delay = () => new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 60));
  let items: Stored[] | null = null;

  function load(): Stored[] {
    if (items) return items;
    const raw = opts.storage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        items = JSON.parse(raw) as Stored[];
      } catch {
        items = null;
      }
    }
    items ??= seed(now());
    return items;
  }
  function save(): void {
    opts.storage?.setItem(STORAGE_KEY, JSON.stringify(load()));
  }
  function who(): { sub: string; name?: string; email?: string } {
    const caller = opts.caller();
    if (!caller) throw new ShapesApiError(401, 'Not signed in.');
    return caller;
  }
  const by = (c: { name?: string; email?: string }) => (c.name || c.email ? { ...(c.name ? { name: c.name } : {}), ...(c.email ? { email: c.email } : {}) } : null);
  function compiled(document: unknown): RecordShapeArtifact {
    if (!document || typeof document !== 'object') throw new ShapesApiError(400, 'Send the shape as `document`: a RecordShape (apiVersion, kind, shape).');
    const r = compileShape(document);
    if (!r.ok) throw new ShapesApiError(422, 'The shape does not compile.', { issues: r.issues });
    if (r.artifact.open_kind && opts.mayAdmin && !opts.mayAdmin()) throw new ShapesApiError(403, `A shape for ${r.artifact.resource} — a kind the platform has not admitted — is defined by administrators.`, { resource: r.artifact.resource });
    return r.artifact;
  }
  function find(id: string): Stored {
    const s = load().find((x) => x.shape_id === id);
    if (!s) throw new ShapesApiError(404, 'No such shape.');
    return s;
  }
  function latest(s: Stored): ShapeVersion {
    return s.versions[s.versions.length - 1]!;
  }
  function summary(s: Stored): ShapeSummary {
    const last = latest(s);
    const published = s.active_version ? s.versions.find((v) => v.version === s.active_version && v.state === 'published') : undefined;
    const lastEvent = s.history[s.history.length - 1];
    return {
      shape_id: s.shape_id,
      name: last.artifact.name,
      description: last.artifact.description ?? null,
      resource: last.artifact.resource,
      owner_sub: s.owner_sub,
      latest_version: last.version,
      latest_state: last.state,
      active_version: published ? published.version : null,
      updated_at: lastEvent?.ts ?? last.updated_at ?? null,
      updated_by: lastEvent?.actor ?? null,
      latest: last,
      published: published ? { version: published.version, checksum: published.checksum ?? null, artifact: published.artifact } : null,
    };
  }

  return {
    kind: 'local',
    async list() {
      await delay();
      return load()
        .map(summary)
        .sort((a, b) => a.name.localeCompare(b.name) || a.shape_id.localeCompare(b.shape_id));
    },
    async get(id) {
      await delay();
      const s = find(id);
      const detail: ShapeDetail = { ...summary(s), versions: [...s.versions].reverse(), history: [...s.history].reverse() };
      return detail;
    },
    async create(document) {
      await delay();
      const c = who();
      if (opts.mayAuthor && !opts.mayAuthor()) throw new ShapesApiError(403, 'Creating a shape is for authors and admins.');
      const artifact = compiled(document);
      if (load().some((s) => s.shape_id === artifact.id)) throw new ShapesApiError(409, `A shape with the id ${artifact.id} already exists — revise it, or pick another id.`, { shape_id: artifact.id });
      const ts = now();
      const made: Stored = {
        shape_id: artifact.id,
        owner_sub: c.sub,
        active_version: null,
        versions: [{ version: FIRST_VERSION, state: 'draft', document, artifact, checksum: artifact.checksum, created_at: ts, updated_at: ts, created_by_sub: c.sub, author: by(c) }],
        history: [{ version: FIRST_VERSION, ts, actor_sub: c.sub, actor: by(c), from_state: null, to_state: 'draft', notes: 'created' }],
      };
      load().push(made);
      save();
      return summary(made);
    },
    async revise(id, document) {
      await delay();
      const c = who();
      const s = find(id);
      const owner = s.owner_sub === c.sub && (!opts.mayAuthor || opts.mayAuthor());
      if (!owner && opts.mayCurate && !opts.mayCurate()) throw new ShapesApiError(403, 'Revising a shape is for its owner, approvers or admins.');
      const artifact = compiled(document);
      if (artifact.id !== id) throw new ShapesApiError(409, `The document's id (${artifact.id}) is not this shape's (${id}); the id is the shape's name across apps and does not change.`);
      const last = latest(s);
      const ts = now();
      if (last.state === 'draft') {
        if (last.checksum === artifact.checksum) return summary(s);
        s.versions[s.versions.length - 1] = { ...last, document, artifact, checksum: artifact.checksum, updated_at: ts };
        s.history.push({ version: last.version, ts, actor_sub: c.sub, actor: by(c), from_state: 'draft', to_state: 'draft', notes: 'revised' });
      } else {
        const version = nextMinor(last.version);
        s.versions.push({ version, state: 'draft', parent_version: last.version, document, artifact, checksum: artifact.checksum, created_at: ts, updated_at: ts, created_by_sub: c.sub, author: by(c) });
        s.history.push({ version, ts, actor_sub: c.sub, actor: by(c), from_state: null, to_state: 'draft', notes: `from ${last.version}` });
      }
      save();
      return summary(s);
    },
    async transition(id, version, to, notes) {
      await delay();
      const c = who();
      if (opts.mayCurate && !opts.mayCurate()) throw new ShapesApiError(403, 'Publishing and deprecating shapes is for approvers and admins.');
      const s = find(id);
      const v = s.versions.find((x) => x.version === version);
      if (!v) throw new ShapesApiError(404, 'No such shape version.');
      if (!TRANSITIONS[v.state].includes(to)) throw new ShapesApiError(409, `${v.state} → ${to} is not an allowed transition for a shape`, { state: v.state });
      const ts = now();
      if (to === 'published' && s.active_version && s.active_version !== version) {
        const previous = s.versions.find((x) => x.version === s.active_version);
        if (previous && previous.state === 'published') {
          Object.assign(previous, { state: 'deprecated', updated_at: ts });
          s.history.push({ version: previous.version, ts, actor_sub: c.sub, actor: by(c), from_state: 'published', to_state: 'deprecated', notes: `superseded by ${version}` });
        }
      }
      const from = v.state;
      Object.assign(v, { state: to, updated_at: ts });
      s.history.push({ version, ts, actor_sub: c.sub, actor: by(c), from_state: from, to_state: to, ...(notes ? { notes } : {}) });
      if (to === 'published') s.active_version = version;
      else if (to === 'deprecated' && s.active_version === version) s.active_version = null;
      save();
      return summary(s);
    },
    async compile(document) {
      await delay();
      const r = compileShape(document);
      return r.ok ? { ok: true, artifact: r.artifact } : { ok: false, issues: r.issues };
    },
  };
}
