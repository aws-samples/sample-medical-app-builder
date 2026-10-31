import type { RecordShapeArtifact } from '../spec/shapes';
import {
  AuthoringApiError,
  type AppRef,
  type AuthoringClient,
  type CompileOutcome,
  type DraftOp,
  type DraftSummary,
  type DraftView,
  type GroupInfo,
  type LifecycleState,
  type PlainSpec,
  type SavedApp,
  type SpecIssue,
  type TransitionResult,
  type TurnState,
} from './types';

/**
 * The deployed authoring API (ApiStack routes) with the caller's Cognito ID token. Thin on purpose:
 * every rule lives server-side; this only maps HTTP statuses to outcomes the page can act on.
 */
export function remoteAuthoringClient(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  // Keep the browser's fetch bound to the global (same caveat as the dispatcher executor).
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  options: {
    /** The record-shape library's published artifacts, sent along with a compile so `shape: <id>` references resolve (the compiler does not read the registry). */
    readonly shapes?: () => Promise<readonly RecordShapeArtifact[]>;
  } = {}
): AuthoringClient {
  const base = apiBaseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown, accept: readonly number[] = []): Promise<{ status: number; body: T }> {
    const token = await getIdToken();
    if (!token) throw new AuthoringApiError(401, 'Not signed in.');
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    if (!res.ok && !accept.includes(res.status)) {
      throw new AuthoringApiError(res.status, typeof parsed.message === 'string' ? parsed.message : `The authoring API returned HTTP ${res.status}.`, parsed);
    }
    return { status: res.status, body: parsed as T };
  }

  return {
    kind: 'remote',
    pollIntervalMs: 2000,

    async createDraft(input) {
      const payload: Record<string, unknown> = {};
      if (input.message) payload.message = input.message;
      if (input.spec) payload.spec = input.spec;
      if (input.iterates) payload.iterates = input.iterates;
      if (input.from_session) payload.from_session = input.from_session;
      const { body } = await call<{ session_id: string; turn: TurnState | null }>('POST', '/drafts', payload);
      return body;
    },

    async listDrafts() {
      const { body } = await call<{ drafts?: DraftSummary[] }>('GET', '/drafts');
      return body.drafts ?? [];
    },

    async getDraft(sessionId) {
      const { body } = await call<DraftView>('GET', `/drafts/${encodeURIComponent(sessionId)}`);
      return body;
    },

    async patchDraft(sessionId, ops: readonly DraftOp[]) {
      const { body } = await call<{ spec: PlainSpec; open: SpecIssue[] }>('PATCH', `/drafts/${encodeURIComponent(sessionId)}`, { ops });
      return body;
    },

    async sendTurn(sessionId, message) {
      const { body } = await call<{ turn: TurnState }>('POST', `/drafts/${encodeURIComponent(sessionId)}/turns`, { message });
      return body.turn;
    },

    async deleteDraft(sessionId) {
      await call<unknown>('DELETE', `/drafts/${encodeURIComponent(sessionId)}`);
    },

    async compile(spec): Promise<CompileOutcome> {
      // 422 is a normal outcome here: the spec does not compile (yet).
      const shapes = options.shapes ? await options.shapes().catch(() => undefined) : undefined;
      const { body } = await call<{ ok: boolean; manifest?: unknown; issues?: SpecIssue[] }>('POST', '/manifest/compile', { spec, ...(shapes ? { shapes } : {}) }, [422]);
      return body.ok ? { ok: true, manifest: body.manifest } : { ok: false, issues: body.issues ?? [] };
    },

    async listGroups() {
      const { body } = await call<{ groups?: GroupInfo[] }>('GET', '/groups');
      return body.groups ?? [];
    },

    async saveApp(sessionId) {
      const { body } = await call<SavedApp>('POST', '/registry/apps', { session_id: sessionId });
      return body;
    },

    async saveVersion(appId, sessionId) {
      const { body } = await call<SavedApp>('POST', `/registry/apps/${encodeURIComponent(appId)}/versions`, { session_id: sessionId });
      return body;
    },

    async replaceVersion(appId, version, sessionId) {
      const { body } = await call<SavedApp & { revised: true }>('PUT', `/registry/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(version)}`, { session_id: sessionId });
      return body;
    },

    async transition(appId, version, to: LifecycleState, notes?: string) {
      const { body } = await call<TransitionResult>('POST', `/registry/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(version)}/transitions`, { to, ...(notes ? { notes } : {}) });
      return body;
    },
  };
}

export type { AppRef };
