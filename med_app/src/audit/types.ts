/**
 * The audit trail as the panel reads it — mirrors `lambdas/audit_api` and `medapp_shared/audit_model.py`. One record per
 * data access or write the dispatcher performed, per account change an administrator made, per lifecycle step of an app.
 */

export type AuditOutcome = 'ok' | 'refused' | 'error';

export interface AuditEntry {
  readonly audit_id: string;
  /** ISO, UTC. */
  readonly timestamp: string;
  /** `data.*` reads, `write.*` writes, `platform.*` (patient lookups, account changes), `lifecycle.*` steps of an app. */
  readonly kind: string;
  readonly user_sub: string;
  readonly user_name?: string;
  readonly user_email?: string;
  readonly outcome?: AuditOutcome;
  readonly detail?: string;
  /** Which Lambda wrote it: dispatcher | user_admin | registry. */
  readonly source?: string;
  // the dispatcher's
  readonly app_id?: string;
  readonly manifest_version?: string;
  readonly primitive_id?: string;
  readonly role?: string;
  readonly role_source?: string;
  readonly patient_context?: string;
  readonly duration_ms?: number;
  readonly result_summary?: string;
  readonly resource_ref?: string;
  readonly provenance?: string;
  /** Paths at which the request's config differed from the published manifest's — the call was refused (dispatcher step 6). */
  readonly config_mismatch?: readonly string[];
  /** Keys the request sent that the manifest does not declare — dropped before execution. */
  readonly config_dropped?: readonly string[];
  readonly query?: string;
  // user administration's
  readonly target_username?: string;
  readonly email?: string;
  readonly groups_added?: readonly string[];
  readonly groups_removed?: readonly string[];
  // lifecycle's
  readonly from_state?: string;
  readonly to_state?: string;
  readonly parent_version?: string;
  readonly [extra: string]: unknown;
}

export type KindGroup = 'reads' | 'writes' | 'platform' | 'lifecycle';

export interface AuditQuery {
  /** ISO timestamps or dates; default the last seven days, at most 92. */
  readonly from?: string;
  readonly to?: string;
  readonly user?: string;
  readonly app?: string;
  readonly patient?: string;
  readonly kind?: KindGroup | string;
  readonly outcome?: AuditOutcome;
  /** One record by its id — the one an app's inspector row names. */
  readonly id?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface AuditPage {
  readonly records: AuditEntry[];
  /** More records follow; pass it back to get the next page. */
  readonly cursor: string | null;
  readonly range: { readonly from: string; readonly to: string };
}

export class AuditApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'AuditApiError';
  }
}

export interface AuditClient {
  readonly kind: 'remote' | 'local';
  query(q: AuditQuery): Promise<AuditPage>;
}

export const KIND_GROUPS: readonly { value: KindGroup; label: string }[] = [
  { value: 'reads', label: 'Reads' },
  { value: 'writes', label: 'Writes' },
  { value: 'platform', label: 'Platform' },
  { value: 'lifecycle', label: 'Lifecycle' },
];

export function kindGroupOf(kind: string): KindGroup | undefined {
  if (kind.startsWith('data.')) return 'reads';
  if (kind.startsWith('write.')) return 'writes';
  if (kind.startsWith('platform.')) return 'platform';
  if (kind.startsWith('lifecycle.')) return 'lifecycle';
  return undefined;
}

/** "Lukas Hoffmann", else the email, else the sub — who did it. */
export function actorOf(entry: Pick<AuditEntry, 'user_name' | 'user_email' | 'user_sub'>): string {
  return entry.user_name || entry.user_email || entry.user_sub;
}
