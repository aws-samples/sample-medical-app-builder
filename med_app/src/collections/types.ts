/**
 * Collections — how the hospital groups its published apps for the launcher. Organisation, not a clinical change:
 * approvers and admins create and edit them without any version moving; an app may sit in several. Mirrors the
 * registry API (`GET /registry/collections`, writes on the registry write API); the local client keeps the same shape
 * in the browser for mock mode and tests.
 */

export interface Collection {
  readonly collection_id: string;
  readonly name: string;
  readonly description?: string | null;
  /** Ordered; for a clinician, narrowed by the API to the apps they may open. */
  readonly app_ids: readonly string[];
  readonly updated_at?: string | null;
  readonly updated_by?: { readonly name?: string; readonly email?: string } | null;
}

export interface CollectionInput {
  readonly name: string;
  readonly description?: string;
  readonly app_ids: readonly string[];
}

export interface CollectionPatch {
  readonly name?: string;
  readonly description?: string;
  readonly app_ids?: readonly string[];
}

export class CollectionsApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'CollectionsApiError';
  }
}

export interface CollectionsClient {
  readonly kind: 'remote' | 'local';
  list(): Promise<Collection[]>;
  create(input: CollectionInput): Promise<Collection>;
  update(collectionId: string, patch: CollectionPatch): Promise<Collection>;
  remove(collectionId: string): Promise<void>;
}
