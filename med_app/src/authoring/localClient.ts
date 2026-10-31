import { compileSpec } from '../spec/compiler';
import { shapeLookup, type RecordShapeArtifact } from '../spec/shapes';
import type { AppManifest } from '../manifest/schema';
import type { VersionEvent } from '../manifest/registry';
import { applyOps, classify, RejectedChange, withHeader, withoutHeader } from './draftOps';
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
  type Refusal,
  type TranscriptEntry,
  type TurnState,
} from './types';

/**
 * The authoring loop without a backend: drafts live in memory (optionally mirrored to a Storage so a
 * dev-server reload keeps them), edits run the same operations as the API, compilation is the same
 * compiler, and "save to registry" lands in a local store the launcher merges into the bundled
 * manifests. The one thing this cannot provide is the drafting agent — that is a model behind the
 * deployed API — so the chat answers with a plain explanation unless a `LocalAgent` is supplied
 * (tests script one; a demo could too).
 */

export interface LocalAgentInput {
  readonly spec: PlainSpec;
  readonly transcript: readonly TranscriptEntry[];
  readonly message: string;
}

export interface LocalAgentOutput {
  readonly reply: string;
  readonly ops?: readonly DraftOp[];
  readonly refusal?: { readonly refusal: string; readonly detail: string };
  /** The tools the turn called, read-only ones included (lookup_codes, check_readiness, compile_preview) — the progress the
   *  page shows; defaults to the ops' names. A replayed session gives the recorded list. */
  readonly tool_calls?: readonly string[];
}

export type LocalAgent = (input: LocalAgentInput) => Promise<LocalAgentOutput> | LocalAgentOutput;

/** What the chat says when no model is connected. */
export const OFFLINE_REPLY =
  'The drafting assistant is part of the deployed environment (it runs on Amazon Bedrock behind the hospital API), so in this local mode nothing answers here. ' +
  'You can still build the draft with the panel on the right — archetype, roles, governance and the app settings — and preview and save it.';

export const offlineAgent: LocalAgent = () => ({ reply: OFFLINE_REPLY });

interface LocalDraft {
  session_id: string;
  author_sub: string;
  spec: PlainSpec;
  events: { at: string; tool: string; args: unknown }[];
  refusals: Refusal[];
  transcript: TranscriptEntry[];
  turn: TurnState | null;
  saved_as: (AppRef & { at: string; state?: LifecycleState }) | null;
  iterates: AppRef | null;
  created_at: string;
  updated_at: string;
}

/** A locally saved app version — what the local registry source lists next to the bundled manifests. */
export interface LocalSavedVersion {
  readonly app_id: string;
  readonly version: string;
  readonly parent_version?: string;
  readonly manifest: AppManifest;
  readonly spec: PlainSpec;
  readonly owner_sub: string;
  readonly created_by_sub: string;
  readonly author?: { readonly name?: string; readonly email?: string };
  readonly signoff?: { approver_sub: string; approved_at: string; clinical_notes?: string } | null;
  /** The version's lifecycle events, oldest first, as the registry's EVENT items would be. */
  readonly history?: readonly VersionEvent[];
}

/** Locally saved apps, shared between the authoring client and the registry source. */
export class LocalRegistryStore {
  private versions: LocalSavedVersion[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly storage?: Storage) {
    const raw = storage?.getItem(STORE_KEY);
    if (raw) {
      try {
        this.versions = JSON.parse(raw) as LocalSavedVersion[];
      } catch {
        this.versions = [];
      }
    }
  }

  list(): readonly LocalSavedVersion[] {
    return this.versions;
  }

  latest(appId: string): LocalSavedVersion | undefined {
    return this.versions.filter((v) => v.app_id === appId).sort((a, b) => compareSemver(b.version, a.version))[0];
  }

  find(appId: string, version: string): LocalSavedVersion | undefined {
    return this.versions.find((v) => v.app_id === appId && v.version === version);
  }

  add(version: LocalSavedVersion): void {
    this.versions = [...this.versions, version];
    this.persist();
  }

  replace(appId: string, version: string, update: (v: LocalSavedVersion) => LocalSavedVersion): void {
    this.versions = this.versions.map((v) => (v.app_id === appId && v.version === version ? update(v) : v));
    this.persist();
  }

  /** Called after every change — the launcher reloads its registry from it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(): void {
    this.storage?.setItem(STORE_KEY, JSON.stringify(this.versions));
    for (const l of this.listeners) l();
  }
}

const STORE_KEY = 'medapp.local-registry';
const DRAFTS_KEY = 'medapp.local-drafts';

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export function nextMinor(version: string): string {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

const LIFECYCLE_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  draft: ['in_review', 'deprecated'],
  in_review: ['approved', 'draft', 'deprecated'],
  approved: ['published', 'draft', 'deprecated'],
  published: ['deprecated'],
  deprecated: [],
};

export interface LocalAuthoringOptions {
  readonly hospitalId: string;
  /** Who is drafting — the mock session's sub. */
  readonly getCallerSub: () => string;
  /** The signed-in person as a name and email, kept on the versions they save ("By: …"); optional, for tests. */
  readonly getCallerIdentity?: () => { name?: string; email?: string } | undefined;
  readonly registry: LocalRegistryStore;
  readonly agent?: LocalAgent;
  /** Existing hospital groups a role may bind to. Empty by default: there is no user pool here. */
  readonly groups?: readonly GroupInfo[];
  readonly storage?: Storage;
  readonly now?: () => string;
  /** Time the scripted turn takes to move queued → running → done (so the page's polling is exercised). */
  readonly turnDelayMs?: number;
  /** Versions the launcher already knows (bundled manifests) — so iterating on one picks the next minor. */
  readonly knownVersions?: (appId: string) => string | undefined;
  /** The record-shape library's published artifacts — what `shape: <id>` in a record section resolves to. None: no library. */
  readonly shapes?: () => Promise<readonly RecordShapeArtifact[]> | readonly RecordShapeArtifact[];
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** `{ author }` for a saved version when the signed-in person is known by name or email; nothing otherwise. */
function authorOf(opts: LocalAuthoringOptions): { author?: { name?: string; email?: string } } {
  const who = opts.getCallerIdentity?.();
  if (!who || (!who.name && !who.email)) return {};
  return { author: { ...(who.name ? { name: who.name } : {}), ...(who.email ? { email: who.email } : {}) } };
}

/** One lifecycle event as the registry write API would record it — the caller as a person, when it had a name. */
function eventBy(opts: LocalAuthoringOptions, ts: string, from: LifecycleState | null, to: LifecycleState, notes?: string | null, signed = false): VersionEvent {
  const { author } = authorOf(opts);
  return { ts, actor_sub: opts.getCallerSub(), ...(author ? { actor: author } : {}), from_state: from, to_state: to, ...(notes ? { notes } : {}), ...(signed ? { signed: true } : {}) };
}

export function localAuthoringClient(opts: LocalAuthoringOptions): AuthoringClient {
  const now = opts.now ?? (() => new Date().toISOString());
  const agent = opts.agent ?? offlineAgent;
  const groups = opts.groups ?? [];
  const knownGroups = groups.map((g) => g.name);
  const drafts = new Map<string, LocalDraft>();
  const turnDelay = opts.turnDelayMs ?? 120;

  const raw = opts.storage?.getItem(DRAFTS_KEY);
  if (raw) {
    try {
      for (const d of JSON.parse(raw) as LocalDraft[]) drafts.set(d.session_id, d);
    } catch {
      /* start empty */
    }
  }
  const persist = () => opts.storage?.setItem(DRAFTS_KEY, JSON.stringify([...drafts.values()]));

  function load(sessionId: string): LocalDraft {
    const d = drafts.get(sessionId);
    const caller = opts.getCallerSub();
    if (!d || (d.author_sub !== caller && caller !== '*')) throw new AuthoringApiError(404, 'No such draft.');
    return d;
  }

  function title(spec: PlainSpec): string {
    const app = spec.app as { name?: string } | undefined;
    return app?.name || 'Untitled draft';
  }

  function view(d: LocalDraft): DraftView {
    return {
      session_id: d.session_id,
      title: title(d.spec),
      spec: withHeader(d.spec),
      open: classify(d.spec).open,
      refusals: d.refusals,
      transcript: d.transcript,
      turn: d.turn,
      saved_as: d.saved_as,
      iterates: d.iterates,
      created_at: d.created_at,
      updated_at: d.updated_at,
    };
  }

  /** A saved conversation freezes when its version is submitted; while the version is a draft it is still its author's to change. */
  function frozen(d: LocalDraft): boolean {
    return Boolean(d.saved_as) && d.saved_as?.state !== 'draft';
  }

  function busy(d: LocalDraft): boolean {
    return d.turn?.status === 'queued' || d.turn?.status === 'running';
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Run the scripted agent the way the worker Lambda would: queued → running (progress per tool) → done/failed. */
  async function runTurn(d: LocalDraft, turn: TurnState): Promise<void> {
    await sleep(turnDelay);
    d.turn = { ...turn, status: 'running' };
    persist();
    try {
      const out = await agent({ spec: withHeader(d.spec), transcript: d.transcript, message: turn.message });
      const progress: string[] = [];
      if (out.ops?.length) {
        d.spec = applyOps(d.spec, out.ops, knownGroups);
        for (const op of out.ops) {
          progress.push(op.op);
          d.events.push({ at: now(), tool: op.op, args: op.args });
        }
      }
      if (out.refusal) {
        d.refusals.push({ at: now(), ...out.refusal });
        progress.push('record_refusal');
      }
      d.transcript.push({ role: 'user', text: turn.message }, { role: 'assistant', text: out.reply });
      const calls = out.tool_calls ? [...out.tool_calls] : progress;
      d.turn = { ...turn, status: 'done', progress: calls, reply: out.reply, tool_calls: calls, finished_at: now() };
    } catch (err) {
      d.transcript.push({ role: 'user', text: turn.message });
      d.turn = { ...turn, status: 'failed', error: err instanceof Error ? err.message : String(err), finished_at: now() };
    }
    d.updated_at = now();
    persist();
  }

  function beginTurn(d: LocalDraft, message: string): TurnState {
    const turn: TurnState = { id: newId('t'), status: 'queued', message, progress: [], started_at: now() };
    d.turn = turn;
    d.updated_at = now();
    persist();
    void runTurn(d, turn);
    return turn;
  }

  async function compileNow(spec: PlainSpec, createdBy: string): Promise<CompileOutcome> {
    const library = opts.shapes ? await opts.shapes() : undefined;
    const r = compileSpec(withHeader(spec), { hospital_id: opts.hospitalId, created_at: now(), created_by_sub: createdBy, ...(library ? { shapes: shapeLookup(library) } : {}) });
    return r.ok ? { ok: true, manifest: r.manifest } : { ok: false, issues: r.issues };
  }

  function latestVersionOf(appId: string): string | undefined {
    const local = opts.registry.latest(appId)?.version;
    const known = opts.knownVersions?.(appId);
    if (local && known) return compareSemver(local, known) >= 0 ? local : known;
    return local ?? known;
  }

  return {
    kind: 'local',
    pollIntervalMs: 150,

    async createDraft(input) {
      const caller = opts.getCallerSub();
      const d: LocalDraft = {
        session_id: newId('d'),
        author_sub: caller,
        spec: {},
        events: [],
        refusals: [],
        transcript: [],
        turn: null,
        saved_as: null,
        iterates: null,
        created_at: now(),
        updated_at: now(),
      };
      if (input.from_session) {
        // Iterating on your own app: continue the conversation that produced it. The saved draft stays as it is.
        const source = drafts.get(input.from_session);
        if (!source || source.author_sub !== caller) throw new AuthoringApiError(404, 'No such draft to continue.', {});
        if (source.turn && (source.turn.status === 'queued' || source.turn.status === 'running')) throw new AuthoringApiError(409, 'The agent is still working on that draft; continue it when it is done.', {});
        const copy = JSON.parse(JSON.stringify({ spec: source.spec, events: source.events, refusals: source.refusals, transcript: source.transcript })) as Pick<LocalDraft, 'spec' | 'events' | 'refusals' | 'transcript'>;
        d.spec = copy.spec;
        d.events = copy.events;
        d.refusals = copy.refusals;
        d.transcript = copy.transcript;
        d.iterates = input.iterates?.app_id ? { app_id: input.iterates.app_id, version: input.iterates.version ?? '' } : source.saved_as ? { app_id: source.saved_as.app_id, version: source.saved_as.version } : null;
        d.events.push({ at: now(), tool: 'continue_from', args: { session_id: source.session_id, iterates: d.iterates, by: caller } });
      } else if (input.spec) {
        const candidate = withoutHeader(input.spec);
        const { invalid } = classify(candidate);
        if (invalid.length) throw new AuthoringApiError(422, 'The spec does not validate.', { rejected: invalid });
        d.spec = candidate;
        if (input.iterates?.app_id) d.iterates = { app_id: input.iterates.app_id, version: input.iterates.version ?? '' };
        d.events.push({ at: now(), tool: 'seed_spec', args: { iterates: d.iterates, by: caller } });
      }
      drafts.set(d.session_id, d);
      persist();
      const turn = input.message?.trim() ? beginTurn(d, input.message.trim()) : null;
      return { session_id: d.session_id, turn };
    },

    async listDrafts(): Promise<DraftSummary[]> {
      const caller = opts.getCallerSub();
      return [...drafts.values()]
        .filter((d) => d.author_sub === caller)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((d) => ({
          session_id: d.session_id,
          title: title(d.spec),
          archetype: typeof d.spec.archetype === 'string' ? d.spec.archetype : null,
          updated_at: d.updated_at,
          created_at: d.created_at,
          turn_status: d.turn?.status ?? null,
          saved_as: d.saved_as ? { app_id: d.saved_as.app_id, version: d.saved_as.version, state: d.saved_as.state } : null,
        }));
    },

    async getDraft(sessionId) {
      return view(load(sessionId));
    },

    async patchDraft(sessionId, ops) {
      const d = load(sessionId);
      if (busy(d)) throw new AuthoringApiError(409, 'The agent is still working on the previous message; edit when it is done.', { turn: d.turn });
      if (frozen(d)) throw new AuthoringApiError(409, 'This version has been submitted for review; iterate on the app to change it.', { saved_as: d.saved_as });
      if (!ops.length) throw new AuthoringApiError(400, 'ops must be a non-empty list of {op, args}.');
      try {
        d.spec = applyOps(d.spec, ops, knownGroups);
      } catch (err) {
        if (err instanceof RejectedChange) throw new AuthoringApiError(422, err.message, { rejected: err.issues });
        throw err;
      }
      d.events.push({ at: now(), tool: 'panel_edit', args: { ops: ops.map((o) => o.op), by: opts.getCallerSub() } });
      d.updated_at = now();
      persist();
      return { spec: withHeader(d.spec), open: classify(d.spec).open };
    },

    async sendTurn(sessionId, message) {
      const d = load(sessionId);
      const text = message.trim();
      if (!text) throw new AuthoringApiError(400, 'message is required.');
      if (busy(d)) throw new AuthoringApiError(409, 'The agent is still working on the previous message.', { turn: d.turn });
      if (frozen(d)) throw new AuthoringApiError(409, 'This version has been submitted for review; iterate on the app to change it.', { saved_as: d.saved_as });
      return beginTurn(d, text);
    },

    async deleteDraft(sessionId) {
      const d = load(sessionId);
      if (busy(d)) throw new AuthoringApiError(409, 'The agent is still working on this draft; delete it when it is done.', { turn: d.turn });
      if (d.saved_as) throw new AuthoringApiError(409, "This draft has been saved to the registry and is kept as that version's record.", { saved_as: d.saved_as });
      drafts.delete(sessionId);
      persist();
    },

    async compile(spec) {
      return await compileNow(withoutHeader(spec), opts.getCallerSub());
    },

    async listGroups() {
      return [...groups];
    },

    async saveApp(sessionId) {
      const d = load(sessionId);
      const caller = opts.getCallerSub();
      const spec = withoutHeader(d.spec);
      const { parent_version: _dropped, ...app } = (spec.app as Record<string, unknown> | undefined) ?? {};
      spec.app = { ...app, version: '0.1.0' };
      const compiled = await compileNow(spec, caller);
      if (!compiled.ok) throw new AuthoringApiError(422, 'The draft does not compile.', { issues: compiled.issues });
      const manifest = compiled.manifest as AppManifest;
      const appId = manifest.metadata.app_id;
      if (latestVersionOf(appId)) throw new AuthoringApiError(409, `An app with id ${appId} already exists; iterate on it or choose another id.`, { app_id: appId });
      opts.registry.add({ app_id: appId, version: '0.1.0', manifest, spec: withHeader(spec), owner_sub: caller, created_by_sub: caller, ...authorOf(opts), history: [eventBy(opts, now(), null, 'draft', `created from draft ${sessionId}`)] });
      d.saved_as = { app_id: appId, version: '0.1.0', at: now(), state: 'draft' };
      d.updated_at = now();
      persist();
      return { app_id: appId, version: '0.1.0', state: 'draft' };
    },

    async saveVersion(appId, sessionId) {
      const d = load(sessionId);
      const caller = opts.getCallerSub();
      const latest = latestVersionOf(appId);
      if (!latest) throw new AuthoringApiError(404, 'No such app.');
      const version = nextMinor(latest);
      const spec = withoutHeader(d.spec);
      const app = { ...(spec.app as Record<string, unknown> | undefined) };
      if (app.app_id !== undefined && app.app_id !== appId) throw new AuthoringApiError(400, `The draft is for ${String(app.app_id)}, not ${appId}.`);
      spec.app = { ...app, app_id: appId, version, parent_version: latest };
      const compiled = await compileNow(spec, caller);
      if (!compiled.ok) throw new AuthoringApiError(422, 'The draft does not compile.', { issues: compiled.issues });
      const manifest = compiled.manifest as AppManifest;
      opts.registry.add({ app_id: appId, version, parent_version: latest, manifest, spec: withHeader(spec), owner_sub: caller, created_by_sub: caller, ...authorOf(opts), history: [eventBy(opts, now(), null, 'draft', `created from draft ${sessionId}; iterates ${latest}`)] });
      d.saved_as = { app_id: appId, version, at: now(), state: 'draft' };
      d.updated_at = now();
      persist();
      return { app_id: appId, version, parent_version: latest, state: 'draft' };
    },

    async replaceVersion(appId, version, sessionId) {
      // A draft version is its author's to change: the same conversation, saved again under the same number.
      const d = load(sessionId);
      const item = opts.registry.find(appId, version);
      if (!item) throw new AuthoringApiError(404, 'No such app version.');
      if (item.manifest.lifecycle.state !== 'draft') throw new AuthoringApiError(409, `Only a draft version can be revised in place; this one is ${item.manifest.lifecycle.state}. Iterate on the app to make a new version.`, { state: item.manifest.lifecycle.state });
      if (!d.saved_as || d.saved_as.app_id !== appId || d.saved_as.version !== version) throw new AuthoringApiError(409, 'This draft is not the conversation that version was saved from.', { saved_as: d.saved_as });
      const spec = withoutHeader(d.spec);
      const { parent_version: _previous, ...app } = (spec.app as Record<string, unknown> | undefined) ?? {};
      if (app.app_id !== undefined && app.app_id !== appId) throw new AuthoringApiError(400, `The draft is for ${String(app.app_id)}, not ${appId}.`);
      spec.app = { ...app, app_id: appId, version, ...(item.parent_version ? { parent_version: item.parent_version } : {}) };
      const compiled = await compileNow(spec, item.created_by_sub);
      if (!compiled.ok) throw new AuthoringApiError(422, 'The draft does not compile.', { issues: compiled.issues });
      const manifest = compiled.manifest as AppManifest;
      opts.registry.replace(appId, version, (v) => ({ ...v, manifest: { ...manifest, lifecycle: v.manifest.lifecycle }, spec: withHeader(spec), history: [...(v.history ?? []), eventBy(opts, now(), 'draft', 'draft', `revised from draft ${sessionId}`)] }));
      d.saved_as = { app_id: appId, version, at: now(), state: 'draft' };
      d.updated_at = now();
      persist();
      return { app_id: appId, version, state: 'draft', revised: true as const };
    },

    async transition(appId, version, to, notes) {
      const item = opts.registry.find(appId, version);
      if (!item) throw new AuthoringApiError(404, 'No such app version.');
      const from = item.manifest.lifecycle.state as LifecycleState;
      if (!LIFECYCLE_TRANSITIONS[from].includes(to)) throw new AuthoringApiError(409, `${from} → ${to} is not a lifecycle transition.`);
      const caller = opts.getCallerSub();
      // The conversation that produced the version learns its state: frozen from submission, editable again when sent back.
      for (const draft of drafts.values()) {
        if (draft.saved_as?.app_id === appId && draft.saved_as.version === version) draft.saved_as = { ...draft.saved_as, state: to };
      }
      persist();
      // Approval records who signed off (no KMS here, the signature says so); a return to draft removes it — the content may change again.
      const signoff = to === 'approved' ? { approver_sub: caller, approved_at: now(), signature: 'local:unsigned', clinical_notes: notes ?? null } : to === 'draft' ? null : (item.manifest.lifecycle.signoff ?? null);
      const at = now();
      opts.registry.replace(appId, version, (v) => ({
        ...v,
        signoff: signoff ? { approver_sub: signoff.approver_sub ?? '', approved_at: signoff.approved_at ?? '', clinical_notes: signoff.clinical_notes ?? undefined } : null,
        manifest: { ...v.manifest, lifecycle: { ...v.manifest.lifecycle, state: to, signoff } },
        history: [...(v.history ?? []), eventBy(opts, at, from, to, notes, to === 'approved')],
      }));
      if (to === 'published') {
        // Never more than one published version: the previously published one is deprecated.
        for (const other of opts.registry.list().filter((v) => v.app_id === appId && v.version !== version && v.manifest.lifecycle.state === 'published')) {
          opts.registry.replace(appId, other.version, (v) => ({ ...v, manifest: { ...v.manifest, lifecycle: { ...v.manifest.lifecycle, state: 'deprecated' } }, history: [...(v.history ?? []), eventBy(opts, at, 'published', 'deprecated', `superseded by ${version}`)] }));
        }
      }
      return { app_id: appId, version, state: to, signoff };
    },
  };
}
