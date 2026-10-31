import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { handle, parseGroups } from '../spec/lambda';

// Through a variable on purpose: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const spec = parseYaml(read('../../specs/bp-trend.yaml')) as Record<string, unknown>;
const env = { HOSPITAL_ID: 'hsp-musterstadt' };

function apiEvent(routeKey: string, body: unknown, groups = '[medapp-authors]', sub = 'author-1') {
  return { routeKey, body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': groups } } } } };
}
type Response = { statusCode: number; body: string };
const json = (r: unknown) => JSON.parse((r as Response).body) as Record<string, unknown>;

describe('manifest service Lambda', () => {
  it('compiles a spec for staff through the API and stamps the caller as author', () => {
    const r = handle(apiEvent('POST /manifest/compile', { spec }), env) as Response;
    expect(r.statusCode).toBe(200);
    const body = json(r) as { ok: boolean; manifest: { metadata: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.manifest.metadata).toMatchObject({ app_id: 'app_bp_trend', hospital_id: 'hsp-musterstadt', created_by_sub: 'author-1' });
  });

  it('answers readiness for a partial draft and refuses an incomplete compile with 422', () => {
    const partial = { apiVersion: 'medapp.eu/v1', kind: 'AppSpec', archetype: 'APP-09', app: { app_id: 'app_x', name: 'X' } };
    const ready = handle(apiEvent('POST /manifest/readiness', { spec: partial }), env) as Response;
    expect(ready.statusCode).toBe(200);
    expect(json(ready)).toMatchObject({ ready: false });
    expect((json(ready) as { missing: { path: string }[] }).missing.map((m) => m.path)).toEqual(expect.arrayContaining(['roles', 'governance', 'knobs']));
    const compiled = handle(apiEvent('POST /manifest/compile', { spec: partial }), env) as Response;
    expect(compiled.statusCode).toBe(422);
    expect(json(compiled)).toMatchObject({ ok: false });
  });

  it('is for staff only, needs a caller, and rejects bad bodies and routes', () => {
    expect((handle(apiEvent('POST /manifest/compile', { spec }, '[medapp-viewers]'), env) as Response).statusCode).toBe(403);
    expect((handle(apiEvent('POST /manifest/compile', { spec }, '[medapp-authors]', ''), env) as Response).statusCode).toBe(401);
    expect((handle({ ...apiEvent('POST /manifest/compile', {}), body: '{not json' }, env) as Response).statusCode).toBe(400);
    expect((handle(apiEvent('POST /manifest/nope', { spec }), env) as Response).statusCode).toBe(404);
    expect(parseGroups('[medapp-authors medapp-admins]')).toEqual(['medapp-authors', 'medapp-admins']);
    expect(parseGroups(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('compiles a record shape, and resolves `shape:` references through the artifacts the caller hands over — on both paths', () => {
    const shape = parseYaml(read('../../shapes/measurable-goal.yaml')) as Record<string, unknown>;
    const note = parseYaml(read('../../shapes/progress-note.yaml')) as Record<string, unknown>;
    const library = parseYaml(read('../../specs/composed-therapy-plan-library.yaml')) as Record<string, unknown>;
    // The HTTP route: the panel's library page compiles a document it is editing.
    const r = handle(apiEvent('POST /manifest/shape', { shape }), env) as Response;
    expect(r.statusCode).toBe(200);
    const artifact = (json(r) as { ok: boolean; artifact: { id: string; checksum: string; rules: { resource: string } } }).artifact;
    expect(artifact).toMatchObject({ id: 'measurable_goal', rules: { resource: 'Goal' } });
    expect(artifact.checksum).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    const broken = handle(apiEvent('POST /manifest/shape', { shape: { ...shape, shape: { ...(shape['shape'] as object), fields: [{ id: 'x', label: 'X', type: 'number', path: 'priority' }] } } }), env) as Response;
    expect(broken.statusCode).toBe(422);
    expect((json(broken) as { issues: { message: string }[] }).issues.map((i) => i.message)).toContain('a number field cannot be written into priority (CodeableConcept)');
    // A spec referring to shapes: without the library the references are open; with it the spec compiles and pins the checksums.
    const noteArtifact = (json(handle(apiEvent('POST /manifest/shape', { shape: note }), env)) as { artifact: unknown }).artifact;
    const consent = parseYaml(read('../../shapes/consent-per-purpose.yaml')) as Record<string, unknown>;
    const consentArtifact = (json(handle(apiEvent('POST /manifest/shape', { shape: consent }), env)) as { artifact: unknown }).artifact;
    const open = json(handle(apiEvent('POST /manifest/readiness', { spec: library }), env)) as { ready: boolean; missing: { message: string }[] };
    expect(open.ready).toBe(false);
    expect(open.missing.map((m) => m.message)).toContain('no published record shape "measurable_goal" — the library has none yet');
    const withShapes = json(handle(apiEvent('POST /manifest/compile', { spec: library, shapes: [artifact, noteArtifact, consentArtifact] }), env)) as { ok: boolean; manifest: { primitives: { kind: string; config: { shape?: { id: string; checksum: string; tag: unknown } } }[] } };
    expect(withShapes.ok).toBe(true);
    const pinned = withShapes.manifest.primitives.filter((p) => p.kind === 'write.fhir.record.create').map((p) => p.config.shape);
    expect(pinned.map((s) => [s?.id, s?.checksum])).toEqual([['measurable_goal', artifact.checksum], ['progress_note', (noteArtifact as { checksum: string }).checksum], ['consent_per_purpose', (consentArtifact as { checksum: string }).checksum]]);
    // Without a registry version the tag's version is the checksum — the content is the identity.
    expect(pinned[0]?.tag).toEqual({ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/record-shape', code: 'measurable_goal', version: artifact.checksum, display: 'Measurable goal' });
    // The direct path, as the registry writer and the agent call it.
    const direct = handle({ action: 'compile_shape', shape }, env) as { statusCode: number; ok: boolean; artifact: { checksum: string } };
    expect(direct.statusCode).toBe(200);
    expect(direct.artifact.checksum).toBe(artifact.checksum);
    expect(handle({ action: 'readiness', spec: library, shapes: [artifact, noteArtifact, consentArtifact] }, env)).toMatchObject({ statusCode: 200, ready: true });
  });

  it('serves direct invocations from platform Lambdas without an HTTP envelope', () => {
    const r = handle({ action: 'compile', spec, hospital_id: 'hsp-musterstadt', created_by_sub: 'agent', created_at: '2026-09-14T00:00:00Z' }, env) as { statusCode: number; ok: boolean; manifest: { metadata: Record<string, unknown> } };
    expect(r.statusCode).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.manifest.metadata['created_at']).toBe('2026-09-14T00:00:00Z');
    const ready = handle({ action: 'readiness', spec }, env) as { statusCode: number; ready: boolean };
    expect(ready).toMatchObject({ statusCode: 200, ready: true });
    const valid = handle({ action: 'validate', manifest: r.manifest }, env) as { statusCode: number; ok: boolean };
    expect(valid).toMatchObject({ statusCode: 200, ok: true });
    expect((handle({ action: 'explode' }, env) as { statusCode: number }).statusCode).toBe(400);
  });
});
