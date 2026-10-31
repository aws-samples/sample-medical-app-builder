import type { AppManifest, PrimitiveDecl } from '../../manifest/schema';
import type { EffectiveScope } from '../../manifest/roles';

export interface ExecutionRequest {
  readonly manifest: AppManifest;
  readonly role: string;
  readonly scope: EffectiveScope;
  readonly decl: PrimitiveDecl;
  /** `decl.config` with every $reference resolved. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly idToken: string;
  readonly userSub: string;
  /** What to call the signed-in person on records they create (mock executor only; the dispatcher takes it from the verified token). */
  readonly userDisplay?: string;
}

/** What one primitive call came back with: the output, and the id of the audit record written about the call. */
export interface ExecutionResult {
  readonly output: unknown;
  /**
   * The id the audit trail knows this call by — the dispatcher's record (its answer names it), or the one the mock
   * executor mints. Absent when no record exists, e.g. a request refused in the browser before it was made.
   */
  readonly audit_id?: string;
}

/**
 * Executes one data primitive. Two implementations:
 *  - mock:       in-browser, over synthetic FHIR resources (development / demos)
 *  - dispatcher: HTTP to the platform's primitive dispatcher (API Gateway → Lambda → FHIR/DICOMweb)
 * The frontend never talks to a FHIR server directly in either mode.
 */
export interface PrimitiveExecutor {
  readonly kind: 'mock' | 'dispatcher';
  /** The output alone — `run` without the receipt. */
  execute(request: ExecutionRequest): Promise<unknown>;
  /** The output together with the id of the audit record about the call. */
  run(request: ExecutionRequest): Promise<ExecutionResult>;
  /**
   * The launch context's patient lookup (who a single-patient app is about), by name, through the same data
   * source: a hospital's record holds patients the panel has never heard of. Audited on the server like a
   * primitive; a few fields per hit, never the record.
   */
  searchPatients(name: string): Promise<PatientHit[]>;
}

/** What the patient picker shows for one hit. */
export interface PatientHit {
  readonly id: string;
  readonly name: string;
  readonly birthDate?: string;
  readonly gender?: string;
  readonly identifiers: readonly { system?: string; value?: string }[];
}

/**
 * The browser's own record of one primitive call — what the app asked, as which role, for which patient, and how it
 * went. The inspector shows these; in mock mode the panel's trail keeps them. In a deployment the authoritative record
 * is the dispatcher's: `audit_id` names it, and `outcome` is the server's verdict whenever the call reached it.
 */
export interface AuditRecord {
  /** The audit trail's id for this call; absent when the call never reached the data source (refused in the browser). */
  readonly audit_id?: string;
  readonly timestamp: string;
  readonly app_id: string;
  readonly manifest_version: string;
  readonly primitive_id: string;
  readonly kind: string;
  readonly role: string;
  readonly user_sub: string;
  readonly patient_context?: string;
  readonly duration_ms: number;
  readonly outcome: 'ok' | 'refused' | 'error';
  readonly detail?: string;
}

export class ScopeViolationError extends Error {
  constructor(
    readonly primitiveId: string,
    readonly requirement: string
  ) {
    super(`Primitive "${primitiveId}" requires ${requirement}, which the active role's data scope does not grant.`);
    this.name = 'ScopeViolationError';
  }
}

export class UnknownPrimitiveError extends Error {
  constructor(readonly kind: string) {
    super(`Data primitive "${kind}" is not in the catalog.`);
    this.name = 'UnknownPrimitiveError';
  }
}

/** A write was refused because the payload is invalid (e.g. a required question unanswered). */
export class WriteRejectedError extends Error {
  constructor(
    readonly primitiveId: string,
    readonly problems: readonly string[],
    /** The dispatcher's record of the refusal, when it was the dispatcher that refused. */
    readonly audit_id?: string
  ) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems: ${problems.join('; ')}`);
    this.name = 'WriteRejectedError';
  }
}

/**
 * The dispatcher answered with an error status. Besides the message shown, it carries the id and the outcome of the
 * record the dispatcher wrote about the call — `refused` for a 403/404/409-conflict, `error` for the rest — so the
 * browser's record agrees with the trail instead of reading an HTTP status.
 */
export class DispatcherRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly audit_id?: string,
    readonly outcome?: AuditRecord['outcome'],
    readonly requirement?: string
  ) {
    super(message);
    this.name = 'DispatcherRequestError';
  }
}

export class PrimitiveConfigError extends Error {
  constructor(
    readonly primitiveId: string,
    detail: string
  ) {
    super(`Primitive "${primitiveId}" has an invalid config: ${detail}`);
    this.name = 'PrimitiveConfigError';
  }
}
