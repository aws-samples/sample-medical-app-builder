import { assertScopeAllows } from './dataCatalog';
import { DispatcherRequestError, WriteRejectedError, type ExecutionRequest, type ExecutionResult, type PatientHit, type PrimitiveExecutor } from './types';

/**
 * Calls the platform's primitive dispatcher:
 *
 *   POST {apiBaseUrl}/primitives/{kind}
 *   Authorization: Bearer <Cognito ID token>
 *   { app_id, manifest_version, primitive_id, role, config, context }
 *
 * The Lambda re-validates the manifest, recomputes the data-scope hash, applies scope
 * filters server-side and writes the audit record. The response is `{ output, audit_id, outcome }` — the output
 * shaped exactly like the mock executor's return value for that primitive kind, and the id of the record just
 * written; refusals and errors name their record too, so the browser's view of the call can point at it.
 */
export class DispatcherPrimitiveExecutor implements PrimitiveExecutor {
  readonly kind = 'dispatcher' as const;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiBaseUrl: string,
    fetchImpl?: typeof fetch,
    /** Preferred over the token captured in the request: it is refreshed when about to expire. */
    private readonly getIdToken?: () => Promise<string | undefined> | string | undefined
  ) {
    // Never call the browser's fetch through `this`: invoked as a method of this object it runs with
    // the wrong receiver and Chrome throws "Illegal invocation". Wrap it so the receiver is the global.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async execute(req: ExecutionRequest): Promise<unknown> {
    return (await this.run(req)).output;
  }

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    // Refuse locally first so the UI can explain; the server performs the authoritative check. A call refused here
    // never reaches the dispatcher, so there is no trail record of it — the browser's own record says so.
    assertScopeAllows(req.decl.kind, req.decl.id, req.config as Record<string, unknown>, req.scope);

    const token = (this.getIdToken ? await this.getIdToken() : undefined) ?? req.idToken;
    const res = await this.fetchImpl(`${this.apiBaseUrl}/primitives/${encodeURIComponent(req.decl.kind)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-medapp-app-id': req.manifest.metadata.app_id,
        'x-medapp-manifest-version': req.manifest.metadata.version,
      },
      body: JSON.stringify({
        app_id: req.manifest.metadata.app_id,
        manifest_version: req.manifest.metadata.version,
        primitive_id: req.decl.id,
        catalog_version: req.decl.catalog_version,
        role: req.role,
        config: req.config,
        context: req.context,
      }),
    });

    if (!res.ok) {
      // The dispatcher explains refusals (403 role/scope/state), rejections (400 config, 422 invalid
      // write payload with `problems`) and misses (404 app/version/primitive) in `message`; an upstream
      // failure (502) adds what the data source answered in `detail` — shown, so the cause is on the screen
      // and not only in the audit log.
      const body = (await res.json().catch(() => ({}))) as { message?: string; requirement?: string; problems?: string[]; detail?: string; audit_id?: string; outcome?: 'ok' | 'refused' | 'error' };
      if (res.status === 422 && Array.isArray(body.problems)) throw new WriteRejectedError(req.decl.id, body.problems, body.audit_id);
      const message = body.message ?? `Dispatcher returned HTTP ${res.status} for ${req.decl.kind}.`;
      const text = res.status === 403 && body.requirement ? `${message} (${body.requirement})` : body.detail ? `${message} ${body.detail}` : message;
      throw new DispatcherRequestError(res.status, text, body.audit_id, body.outcome, body.requirement);
    }
    const body = (await res.json()) as { output: unknown; audit_id?: string };
    return { output: body.output, ...(body.audit_id ? { audit_id: body.audit_id } : {}) };
  }

  async searchPatients(name: string): Promise<PatientHit[]> {
    const token = this.getIdToken ? await this.getIdToken() : undefined;
    const res = await this.fetchImpl(`${this.apiBaseUrl}/patients?name=${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; detail?: string };
      const message = body.message ?? `Dispatcher returned HTTP ${res.status} for the patient lookup.`;
      throw new Error(body.detail ? `${message} ${body.detail}` : message);
    }
    const body = (await res.json()) as { patients?: PatientHit[] };
    return body.patients ?? [];
  }
}
