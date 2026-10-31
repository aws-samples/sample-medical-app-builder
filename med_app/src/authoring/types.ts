/**
 * The authoring API as the panel sees it — drafting sessions, the compiler service and the
 * registry write path (infra/lambdas/drafts_api, med_app/src/spec/lambda.ts, infra/lambdas/registry_write).
 * Two implementations: `remoteAuthoringClient` over the deployed API, and `localAuthoringClient`
 * for mock mode and tests, which runs the same draft operations and compiler in the browser.
 */

export type DraftOpName = 'choose_archetype' | 'set_app' | 'set_knobs' | 'add_role' | 'update_role' | 'remove_role' | 'set_default_role' | 'set_governance';

/** One structured edit; the same operations the agent's tools perform (infra/app_creator/draft.py). */
export interface DraftOp {
  readonly op: DraftOpName;
  readonly args: Record<string, unknown>;
}

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'failed';

/** The turn in flight or the last one — what the chat pane polls. */
export interface TurnState {
  readonly id: string;
  readonly status: TurnStatus;
  readonly message: string;
  /** Tool names as they ran, for the progress chips. */
  readonly progress: readonly string[];
  readonly reply?: string;
  readonly tool_calls?: readonly string[];
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly error?: string;
}

export interface TranscriptEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface Refusal {
  readonly at: string;
  readonly refusal: string;
  readonly detail: string;
}

export interface AppRef {
  readonly app_id: string;
  readonly version: string;
}

export type PlainSpec = Record<string, unknown>;

/** GET /drafts/{id}. */
export interface DraftView {
  readonly session_id: string;
  readonly title: string;
  /** The AppSpec so far, with its apiVersion/kind header. Partial until `open` is empty. */
  readonly spec: PlainSpec;
  /** What is still missing — the readiness checklist. */
  readonly open: readonly SpecIssue[];
  readonly refusals: readonly Refusal[];
  readonly transcript: readonly TranscriptEntry[];
  readonly turn: TurnState | null;
  /**
   * The version this conversation was saved as. `state` follows the version (the registry writer keeps it current): while
   * it is `draft` the conversation stays editable and saving revises the version in place; from `in_review` on it is frozen.
   * Absent on conversations saved before the stamp existed — treated as frozen.
   */
  readonly saved_as: (AppRef & { readonly at?: string; readonly state?: LifecycleState }) | null;
  readonly iterates: AppRef | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Is this saved conversation still the author's to change? (Unsaved drafts are, trivially.) */
export function editableDraft(view: Pick<DraftView, 'saved_as'>): boolean {
  return !view.saved_as || view.saved_as.state === 'draft';
}

/** GET /drafts — one row per draft of the caller. */
export interface DraftSummary {
  readonly session_id: string;
  readonly title: string;
  readonly archetype: string | null;
  readonly updated_at: string;
  readonly created_at: string;
  readonly turn_status: TurnStatus | null;
  readonly saved_as: (AppRef & { readonly state?: LifecycleState }) | null;
}

export interface GroupInfo {
  readonly name: string;
  readonly description: string;
}

export type CompileOutcome = { readonly ok: true; readonly manifest: unknown } | { readonly ok: false; readonly issues: readonly SpecIssue[] };

export interface SavedApp extends AppRef {
  readonly state: string;
  readonly parent_version?: string;
}

export type LifecycleState = 'draft' | 'in_review' | 'approved' | 'published' | 'deprecated';

export interface TransitionResult extends AppRef {
  readonly state: LifecycleState;
  readonly signoff?: unknown;
}

/** A refused call: the HTTP status and the body the API sent (`rejected` for 422 on a draft edit). */
export class AuthoringApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AuthoringApiError';
  }

  /** The validation issues of a rejected edit (PATCH /drafts → 422). */
  get rejected(): SpecIssue[] {
    const r = this.body.rejected;
    return Array.isArray(r) ? (r as SpecIssue[]) : [];
  }
}

export interface AuthoringClient {
  readonly kind: 'remote' | 'local';
  /** How often the drafting page polls a draft while a turn is in flight. */
  readonly pollIntervalMs: number;
  /** Open a draft; `message` starts the conversation, `spec` seeds it (iterating on an app). */
  /**
   * Open a draft. `spec` seeds it with an app's stored spec; `from_session` (one of the caller's saved drafts) continues that
   * conversation in the new draft instead — messages, spec, refusals — which is what iterating on your own app means.
   */
  createDraft(input: { message?: string; spec?: PlainSpec; iterates?: AppRef; from_session?: string }): Promise<{ session_id: string; turn: TurnState | null }>;
  listDrafts(): Promise<DraftSummary[]>;
  getDraft(sessionId: string): Promise<DraftView>;
  /** Structured edits, applied atomically; a rejected batch throws AuthoringApiError(422) with `rejected`. */
  patchDraft(sessionId: string, ops: readonly DraftOp[]): Promise<{ spec: PlainSpec; open: SpecIssue[] }>;
  sendTurn(sessionId: string, message: string): Promise<TurnState>;
  /** Remove an unsaved conversation for good; 409 once saved or while a turn runs. */
  deleteDraft(sessionId: string): Promise<void>;
  compile(spec: PlainSpec): Promise<CompileOutcome>;
  /** The hospital groups a role may be bound to (existing groups). */
  listGroups(): Promise<GroupInfo[]>;
  saveApp(sessionId: string): Promise<SavedApp>;
  /** Revise a draft version in place from the conversation it was saved from — "Save changes"; 409 once it is in review or beyond. */
  replaceVersion(appId: string, version: string, sessionId: string): Promise<SavedApp & { readonly revised: true }>;
  saveVersion(appId: string, sessionId: string): Promise<SavedApp>;
  transition(appId: string, version: string, to: LifecycleState, notes?: string): Promise<TransitionResult>;
}
