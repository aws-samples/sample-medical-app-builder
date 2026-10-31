import type { SpecIssue } from '../spec/common';
import type { RecordShapeArtifact } from '../spec/shapes';

/**
 * The record-shape library — the forms a composed page's `record` section writes with (`shape: <id>`), kept in the
 * registry like apps: a HEAD and versions under a lighter lifecycle (draft → published → deprecated, one published
 * version at a time, no review step of its own because the review that matters is the one of the app that writes with
 * it). Authors create and revise; approvers and admins publish and deprecate. Mirrors the registry API
 * (`GET /registry/shapes`, writes on the registry write API, `POST /manifest/shape` for the compiler); the local client
 * keeps the same shape in the browser for mock mode and tests.
 */

export type ShapeState = 'draft' | 'published' | 'deprecated';

export interface ShapeVersion {
  readonly version: string;
  readonly state: ShapeState;
  readonly parent_version?: string | null;
  /** The RecordShape document as written — what the editor reopens. */
  readonly document: unknown;
  /** What the compiler made of it — what an app embeds. */
  readonly artifact: RecordShapeArtifact;
  readonly checksum?: string | null;
  readonly created_at?: string | null;
  readonly updated_at?: string | null;
  readonly created_by_sub?: string | null;
  readonly author?: { readonly name?: string; readonly email?: string } | null;
}

export interface ShapeSummary {
  readonly shape_id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly resource: string;
  readonly owner_sub?: string | null;
  readonly latest_version: string;
  readonly latest_state: ShapeState;
  /** The published version, or null when the library offers none of this shape. */
  readonly active_version: string | null;
  readonly updated_at?: string | null;
  readonly updated_by?: { readonly name?: string; readonly email?: string } | null;
  readonly latest: ShapeVersion | null;
  readonly published: { readonly version: string; readonly checksum?: string | null; readonly artifact: RecordShapeArtifact } | null;
}

export interface ShapeEvent {
  /** The version the step concerns — a shape's history spans its versions. */
  readonly version?: string | null;
  readonly ts: string;
  readonly actor_sub?: string | null;
  readonly actor?: { readonly name?: string; readonly email?: string } | null;
  readonly from_state: ShapeState | null;
  readonly to_state: ShapeState;
  readonly notes?: string | null;
}

export interface ShapeDetail extends ShapeSummary {
  /** Newest first. */
  readonly versions: readonly ShapeVersion[];
  /** Newest first. */
  readonly history: readonly ShapeEvent[];
}

export type ShapeCompileOutcome = { readonly ok: true; readonly artifact: RecordShapeArtifact } | { readonly ok: false; readonly issues: readonly SpecIssue[] };

export class ShapesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ShapesApiError';
  }
}

export interface ShapesClient {
  readonly kind: 'remote' | 'local';
  list(): Promise<ShapeSummary[]>;
  get(shapeId: string): Promise<ShapeDetail>;
  /** A new shape from its document (the id is the document's); 409 when the id exists, 422 when it does not compile. */
  create(document: unknown): Promise<ShapeSummary>;
  /** A draft is revised in place; after a publication a new draft version follows. */
  revise(shapeId: string, document: unknown): Promise<ShapeSummary>;
  transition(shapeId: string, version: string, to: ShapeState, notes?: string): Promise<ShapeSummary>;
  /** The compiler's verdict on a document — the artifact, or the problems. */
  compile(document: unknown): Promise<ShapeCompileOutcome>;
}

/** The artifacts a compile is handed: every shape's published version, each knowing which version it is (it goes onto every record's tag). */
export function publishedArtifacts(shapes: readonly ShapeSummary[]): RecordShapeArtifact[] {
  return shapes.flatMap((s) => (s.published ? [{ ...s.published.artifact, version: s.published.version }] : []));
}
