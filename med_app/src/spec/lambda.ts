import { validateManifest } from '../manifest/schema';
import { readiness } from './appSpec';
import { compileSpec, type CompileOptions } from './compiler';
import { compileShape, shapeLookup, type RecordShapeArtifact } from './shapes';

/**
 * The compiler as a service — the Lambda handler behind `POST /manifest/compile` and
 * `POST /manifest/readiness`, and the target of direct invocations from the drafting agent and the
 * registry writer (`{ action, spec, … }`). It is the *only* place a manifest is produced from a spec
 * in the deployed platform: one implementation, the same code the frontend uses.
 *
 * Bundled by med_app/scripts/bundle-lambda.mjs; staged into the AuthoringStack at synth time.
 */

const STAFF_GROUPS = ['medapp-authors', 'medapp-approvers', 'medapp-admins'];

export interface DirectRequest {
  readonly action: 'compile' | 'readiness' | 'validate' | 'compile_shape';
  readonly spec?: unknown;
  readonly manifest?: unknown;
  /** compile_shape: the RecordShape document to compile. */
  readonly shape?: unknown;
  /** compile / readiness: the published record shapes (compiled artifacts) a `record` section may refer to. */
  readonly shapes?: unknown;
  readonly hospital_id?: string;
  readonly created_by_sub?: string;
  readonly created_at?: string;
}

export interface Env {
  readonly HOSPITAL_ID?: string;
}

/** HTTP API JWT authorizers pass array claims as "[a b]"; accept that, a JSON array, or comma/space lists. */
export function parseGroups(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String);
  let text = String(raw).trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  return text
    .split(/[\s,]+/)
    .map((g) => g.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function respond(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

/** The shapes the caller handed over — compiled artifacts, as the registry stores them; anything else is ignored. */
function shapesOf(req: DirectRequest) {
  return Array.isArray(req.shapes) ? shapeLookup(req.shapes.filter((s): s is RecordShapeArtifact => typeof s === 'object' && s !== null && typeof (s as { id?: unknown }).id === 'string' && typeof (s as { rules?: unknown }).rules === 'object')) : undefined;
}

function run(req: DirectRequest, defaults: { hospital_id: string; created_by_sub?: string }): { status: number; body: unknown } {
  switch (req.action) {
    case 'readiness': {
      const shapes = shapesOf(req);
      return { status: 200, body: readiness(req.spec, shapes ? { shapes } : undefined) };
    }
    case 'compile_shape': {
      const r = compileShape(req.shape);
      return { status: r.ok ? 200 : 422, body: r };
    }
    case 'validate': {
      const r = validateManifest(req.manifest);
      return { status: r.ok ? 200 : 422, body: r.ok ? { ok: true, manifest: r.manifest } : { ok: false, issues: r.issues } };
    }
    case 'compile': {
      const shapes = shapesOf(req);
      const options: CompileOptions = {
        hospital_id: req.hospital_id ?? defaults.hospital_id,
        created_at: req.created_at ?? new Date().toISOString(),
        ...(req.created_by_sub ?? defaults.created_by_sub ? { created_by_sub: req.created_by_sub ?? defaults.created_by_sub } : {}),
        ...(shapes ? { shapes } : {}),
      };
      const r = compileSpec(req.spec, options);
      return { status: r.ok ? 200 : 422, body: r };
    }
    default:
      return { status: 400, body: { message: `Unknown action ${String((req as { action?: unknown }).action)}` } };
  }
}

type ApiEvent = {
  routeKey?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};

const ROUTES: Record<string, DirectRequest['action']> = {
  'POST /manifest/compile': 'compile',
  'POST /manifest/readiness': 'readiness',
  'POST /manifest/validate': 'validate',
  'POST /manifest/shape': 'compile_shape',
};

export function handle(event: unknown, env: Env = process.env as Env): unknown {
  const hospital_id = env.HOSPITAL_ID ?? 'hsp-unknown';

  // Direct invocation (Lambda → Lambda): the caller is a trusted platform component.
  if (event && typeof event === 'object' && 'action' in (event as Record<string, unknown>) && !('routeKey' in (event as Record<string, unknown>))) {
    const r = run(event as DirectRequest, { hospital_id });
    return { statusCode: r.status, ...(r.body as Record<string, unknown>) };
  }

  const api = (event ?? {}) as ApiEvent;
  const claims = api.requestContext?.authorizer?.jwt?.claims ?? {};
  const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
  if (!sub) return respond(401, { message: 'No authenticated caller.' });
  const groups = parseGroups(claims['cognito:groups']);
  if (!groups.some((g) => STAFF_GROUPS.includes(g))) return respond(403, { message: 'Compiling manifests is for authors, approvers and admins.' });

  const action = ROUTES[api.routeKey ?? ''];
  if (!action) return respond(404, { message: `Unknown route ${api.routeKey}` });

  let body: Record<string, unknown>;
  try {
    const raw = api.isBase64Encoded && api.body ? Buffer.from(api.body, 'base64').toString('utf8') : (api.body ?? '{}');
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return respond(400, { message: 'Body must be JSON.' });
  }
  // The panel hands the published shapes it read from the registry along with the spec; the shape route carries the document.
  const r = run({ action, spec: body['spec'], manifest: body['manifest'], shape: body['shape'], shapes: body['shapes'] }, { hospital_id, created_by_sub: sub });
  return respond(r.status, r.body);
}

export const handler = async (event: unknown): Promise<unknown> => handle(event);
