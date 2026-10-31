import type { SpecIssue } from '../spec/common';
import type { RecordShapeArtifact } from '../spec/shapes';
import { ShapesApiError, type ShapeDetail, type ShapeSummary, type ShapesClient } from './types';

/** The deployed registry: reads on the read API, writes on the write API, the compiler on the manifest service — one base URL, the caller's ID token. */
export function remoteShapesClient(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): ShapesClient {
  const base = apiBaseUrl.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown, accept: readonly number[] = []): Promise<{ status: number; body: T }> {
    const token = await getIdToken();
    if (!token) throw new ShapesApiError(401, 'Not signed in.');
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
    if (!res.ok && !accept.includes(res.status)) throw new ShapesApiError(res.status, typeof parsed.message === 'string' ? parsed.message : `The registry API returned HTTP ${res.status}.`, parsed);
    return { status: res.status, body: parsed as T };
  }
  return {
    kind: 'remote',
    async list() {
      const { body } = await call<{ shapes?: ShapeSummary[] }>('GET', '/registry/shapes');
      return body.shapes ?? [];
    },
    async get(id) {
      return (await call<ShapeDetail>('GET', `/registry/shapes/${encodeURIComponent(id)}`)).body;
    },
    async create(document) {
      return (await call<ShapeSummary>('POST', '/registry/shapes', { document })).body;
    },
    async revise(id, document) {
      return (await call<ShapeSummary>('PUT', `/registry/shapes/${encodeURIComponent(id)}`, { document })).body;
    },
    async transition(id, version, to, notes) {
      return (await call<ShapeSummary>('POST', `/registry/shapes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/transitions`, { to, ...(notes ? { notes } : {}) })).body;
    },
    async compile(document) {
      // 422 is a normal outcome: the document does not compile (yet).
      const { body } = await call<{ ok: boolean; artifact?: RecordShapeArtifact; issues?: SpecIssue[] }>('POST', '/manifest/shape', { shape: document }, [422]);
      return body.ok && body.artifact ? { ok: true, artifact: body.artifact } : { ok: false, issues: body.issues ?? [] };
    },
  };
}
