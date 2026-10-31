import { CollectionsApiError, type Collection, type CollectionsClient } from './types';

/** The deployed registry: reads on the read API, writes on the write API — one base URL, the caller's ID token. */
export function remoteCollectionsClient(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): CollectionsClient {
  const base = apiBaseUrl.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getIdToken();
    if (!token) throw new CollectionsApiError(401, 'Not signed in.');
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
    }
    if (!res.ok) throw new CollectionsApiError(res.status, typeof parsed.message === 'string' ? parsed.message : `The registry API returned HTTP ${res.status}.`);
    return parsed as T;
  }
  return {
    kind: 'remote',
    async list() {
      const body = await call<{ collections?: Collection[] }>('GET', '/registry/collections');
      return body.collections ?? [];
    },
    create: (input) => call<Collection>('POST', '/registry/collections', input),
    update: (id, patch) => call<Collection>('PUT', `/registry/collections/${encodeURIComponent(id)}`, patch),
    async remove(id) {
      await call('DELETE', `/registry/collections/${encodeURIComponent(id)}`);
    },
  };
}
