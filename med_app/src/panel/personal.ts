/**
 * The person's own ordering of the launcher — the apps they pinned and the ones they opened lately — kept in this
 * browser (localStorage, per hospital and person). Nothing of it is clinical and nothing leaves the device; it is the
 * cheapest layer of "the way you want it", under the hospital's collections.
 */

const RECENT_KEEP = 8;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function key(what: 'pins' | 'recent', hospitalId: string, sub: string): string {
  return `medapp.${what}.${hospitalId}.${sub}`;
}

function read<T>(k: string, store: Store | undefined, fallback: T): T {
  const raw = store?.getItem(k);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface Personal {
  readonly pins: readonly string[];
  /** App ids, most recently opened first. */
  readonly recent: readonly string[];
}

export function readPersonal(hospitalId: string, sub: string, store: Store | undefined = storage()): Personal {
  return { pins: read<string[]>(key('pins', hospitalId, sub), store, []), recent: read<string[]>(key('recent', hospitalId, sub), store, []) };
}

export function togglePin(hospitalId: string, sub: string, appId: string, store: Store | undefined = storage()): readonly string[] {
  const pins = read<string[]>(key('pins', hospitalId, sub), store, []);
  const next = pins.includes(appId) ? pins.filter((p) => p !== appId) : [...pins, appId];
  store?.setItem(key('pins', hospitalId, sub), JSON.stringify(next));
  return next;
}

/** An app was opened: it moves to the front of the recent list. */
export function noteOpened(hospitalId: string, sub: string, appId: string, store: Store | undefined = storage()): readonly string[] {
  const recent = read<string[]>(key('recent', hospitalId, sub), store, []);
  const next = [appId, ...recent.filter((r) => r !== appId)].slice(0, RECENT_KEEP);
  store?.setItem(key('recent', hospitalId, sub), JSON.stringify(next));
  return next;
}
