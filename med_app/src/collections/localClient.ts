import { parse as parseYaml } from 'yaml';
import { bundledSetFor } from '../manifest/registry';
import { CollectionsApiError, type Collection, type CollectionsClient } from './types';

/** The seed sets (showcase/<hospital_id>.yaml): the same files the registry seed writes; their collections seed the mock registry's. */
const setFiles = import.meta.glob('/showcase/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const STORAGE_KEY = 'medapp.local-collections';

export interface LocalCollectionsOptions {
  /** The apps that exist — a collection may only name these (the API checks the registry's HEAD items). */
  readonly knownAppIds: () => readonly string[];
  readonly caller: () => { sub: string; name?: string; email?: string } | undefined;
  /** Whether the caller may curate — approvers and admins; the page decides too, this refuses like the API would. */
  readonly mayCurate?: () => boolean;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly now?: () => string;
  readonly delayMs?: number;
}

/** `col_<slug>` from the name, as the registry does — stable once created. */
export function collectionIdFor(name: string): string {
  const slug = name
    .trim()
    .toLocaleLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new CollectionsApiError(400, 'A collection needs a name.');
  return `col_${slug.slice(0, 48)}`;
}

/** The configured hospital's seed collections (showcase/<hospital_id>.yaml, the same file the registry seed writes); ids from the names, as the registry does. */
function seedCollections(now: string): Collection[] {
  const sets = new Set(bundledSetFor());
  const out: Collection[] = [];
  for (const [path, source] of Object.entries(setFiles)) {
    const hospitalId = /^\/showcase\/([^/]+)\.yaml$/.exec(path)?.[1] ?? '';
    if (!sets.has(hospitalId)) continue;
    const doc = parseYaml(source) as { collections?: { name: string; description?: string; apps: string[] }[] };
    for (const c of doc.collections ?? []) {
      out.push({
        collection_id: collectionIdFor(c.name),
        name: c.name,
        description: c.description ?? null,
        app_ids: [...c.apps],
        updated_at: now,
        updated_by: { name: 'Sabine Weber' },
      });
    }
  }
  return out;
}

/**
 * Collections without a backend, over sessionStorage: the seeded ones plus whatever a curator makes in this browser.
 * Same rules as the API — a name is required, ids are slugs of the name, an app must exist, approvers and admins only.
 */
export function localCollectionsClient(opts: LocalCollectionsOptions): CollectionsClient {
  const now = opts.now ?? (() => new Date().toISOString());
  const delay = () => new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 60));
  let items: Collection[] | null = null;

  function load(): Collection[] {
    if (items) return items;
    const raw = opts.storage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        items = JSON.parse(raw) as Collection[];
      } catch {
        items = null;
      }
    }
    items ??= seedCollections(now());
    return items;
  }
  function save(): void {
    opts.storage?.setItem(STORAGE_KEY, JSON.stringify(load()));
  }
  function curator(): { sub: string; name?: string; email?: string } {
    const who = opts.caller();
    if (!who) throw new CollectionsApiError(401, 'Not signed in.');
    if (opts.mayCurate && !opts.mayCurate()) throw new CollectionsApiError(403, 'Collections are curated by approvers and admins.');
    return who;
  }
  function known(appIds: readonly string[]): string[] {
    const ids = [...new Set(appIds)];
    const unknown = ids.filter((a) => !opts.knownAppIds().includes(a));
    if (unknown.length) throw new CollectionsApiError(404, `No such app: ${unknown.join(', ')}.`);
    return ids;
  }
  const by = (who: { name?: string; email?: string }) => (who.name || who.email ? { ...(who.name ? { name: who.name } : {}), ...(who.email ? { email: who.email } : {}) } : null);

  return {
    kind: 'local',
    async list() {
      await delay();
      return load().map((c) => ({ ...c, app_ids: [...c.app_ids] }));
    },
    async create(input) {
      await delay();
      const who = curator();
      const id = collectionIdFor(input.name);
      if (load().some((c) => c.collection_id === id)) throw new CollectionsApiError(409, `A collection named like that already exists (${id}).`);
      const made: Collection = { collection_id: id, name: input.name.trim(), description: input.description?.trim() || null, app_ids: known(input.app_ids), updated_at: now(), updated_by: by(who) };
      load().push(made);
      save();
      return made;
    },
    async update(id, patch) {
      await delay();
      const who = curator();
      const current = load().find((c) => c.collection_id === id);
      if (!current) throw new CollectionsApiError(404, 'No such collection.');
      const next: Collection = {
        ...current,
        ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() || null } : {}),
        ...(patch.app_ids ? { app_ids: known(patch.app_ids) } : {}),
        updated_at: now(),
        updated_by: by(who),
      };
      items = load().map((c) => (c.collection_id === id ? next : c));
      save();
      return next;
    },
    async remove(id) {
      await delay();
      curator();
      if (!load().some((c) => c.collection_id === id)) throw new CollectionsApiError(404, 'No such collection.');
      items = load().filter((c) => c.collection_id !== id);
      save();
    },
  };
}
