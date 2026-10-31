import { describe, expect, it, vi } from 'vitest';
import { loadFixtureRegistry } from './fixtures';
import { resolveEffectiveScope } from '../manifest/roles';
import { DispatcherPrimitiveExecutor } from '../primitives/data/dispatcherExecutor';
import { DispatcherRequestError, WriteRejectedError } from '../primitives/data/types';

const bp = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_bp_trend');
if (!bp?.ok) throw new Error('bp manifest missing');
const manifest = bp.manifest;
const found = manifest.primitives.find((p) => p.id === 'p_series');
if (!found) throw new Error('p_series missing');
const decl: NonNullable<typeof found> = found;

function request(overrides: Partial<Parameters<DispatcherPrimitiveExecutor['execute']>[0]> = {}) {
  return {
    manifest,
    role: 'viewer',
    scope: resolveEffectiveScope(manifest, 'viewer'),
    decl,
    config: { patient: 'pat-kms-0001', codes: ['8480-6', '8462-4'], since: 'now-2y', count: 500 },
    context: { patient_id: 'pat-kms-0001' },
    idToken: 'id-token',
    userSub: 'sub-1',
    ...overrides,
  };
}

describe('DispatcherPrimitiveExecutor', () => {
  it('calls the browser fetch with the global as receiver (regression: "Illegal invocation")', async () => {
    // A fetch that, like Chrome's, refuses to run with a foreign receiver.
    const strictFetch = vi.fn(function (this: unknown, _input: string | URL | Request, _init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify({ output: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const original = globalThis.fetch;
    globalThis.fetch = strictFetch as unknown as typeof fetch;
    try {
      const executor = new DispatcherPrimitiveExecutor('https://api.example.test');
      await expect(executor.execute(request())).resolves.toEqual([]);
      expect(strictFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('posts the manifest coordinates and surfaces the dispatcher message on refusal', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(JSON.stringify({ message: 'Your groups do not grant the role', requirement: 'Observation.search' }), { status: 403 });
    }) as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl);
    await expect(executor.execute(request())).rejects.toThrow(/do not grant the role.*Observation\.search/);
    expect(seen.url).toBe('https://api.example.test/primitives/data.fhir.observation.by_code');
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ app_id: 'app_bp_trend', manifest_version: '0.3.0', primitive_id: 'p_series', role: 'viewer' });
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer id-token');
  });

  it('shows what the data source answered when the dispatcher reports an upstream failure (502)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'The clinical data source did not complete the request.', detail: 'DICOMweb server answered 403: The request signature we calculated does not match' }), { status: 502 })) as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl);
    await expect(executor.execute(request())).rejects.toThrow('The clinical data source did not complete the request. DICOMweb server answered 403: The request signature we calculated does not match');
  });

  it('turns a 422 with problems into a WriteRejectedError so the form can list them', async () => {
    const assessment = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_htn_assessment');
    if (!assessment?.ok) throw new Error('assessment manifest missing');
    const submit = assessment.manifest.primitives.find((p) => p.id === 'p_submit');
    if (!submit) throw new Error('p_submit missing');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: 'The record was not saved: the submission does not match the form.', problems: ['"home_bp" is required'] }), { status: 422 })) as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl);
    const err = await executor
      .execute(
        request({
          manifest: assessment.manifest,
          role: 'nurse',
          scope: resolveEffectiveScope(assessment.manifest, 'nurse'),
          decl: submit,
          config: { questionnaire: 'https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup', subject: 'pat-kms-0001', response: { resourceType: 'QuestionnaireResponse', item: [] } },
        })
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteRejectedError);
    expect((err as WriteRejectedError).problems).toEqual(['"home_bp" is required']);
    expect((err as WriteRejectedError).primitiveId).toBe('p_submit');
  });

  it("carries the dispatcher's record id and verdict on every answer, so the browser's record can point at the trail's", async () => {
    const answers = [
      new Response(JSON.stringify({ output: [{ resourceType: 'Observation' }], audit_id: 'srv-ok-1', outcome: 'ok' }), { status: 200 }),
      new Response(JSON.stringify({ message: 'Your groups do not grant the role', requirement: 'Observation.search', audit_id: 'srv-refused-2', outcome: 'refused' }), { status: 403 }),
      new Response(JSON.stringify({ message: 'The clinical data source did not complete the request.', detail: 'HAPI answered 500', audit_id: 'srv-error-3', outcome: 'error' }), { status: 502 }),
      new Response(JSON.stringify({ message: 'The record was not saved: the submission does not match the form.', problems: ['x is required'], audit_id: 'srv-refused-4', outcome: 'refused' }), { status: 422 }),
    ];
    const fetchImpl = (async () => answers.shift()!) as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl);

    await expect(executor.run(request())).resolves.toEqual({ output: [{ resourceType: 'Observation' }], audit_id: 'srv-ok-1' });

    const refused = (await executor.run(request()).catch((e: unknown) => e)) as DispatcherRequestError;
    expect(refused).toBeInstanceOf(DispatcherRequestError);
    expect(refused).toMatchObject({ status: 403, audit_id: 'srv-refused-2', outcome: 'refused', requirement: 'Observation.search' });
    expect(refused.message).toBe('Your groups do not grant the role (Observation.search)');

    const failed = (await executor.run(request()).catch((e: unknown) => e)) as DispatcherRequestError;
    expect(failed).toMatchObject({ status: 502, audit_id: 'srv-error-3', outcome: 'error' });
    expect(failed.message).toBe('The clinical data source did not complete the request. HAPI answered 500');

    const rejected = (await executor.run(request()).catch((e: unknown) => e)) as WriteRejectedError;
    expect(rejected).toBeInstanceOf(WriteRejectedError);
    expect(rejected.audit_id).toBe('srv-refused-4');
  });

  it('refuses in the browser, before any request, what the role does not grant — no record exists for such a call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const executor = new DispatcherPrimitiveExecutor('https://api.example.test', fetchImpl);
    const decl = { ...bp.manifest.primitives.find((p) => p.id === 'p_series')!, config: { patient: 'pat-kms-0001', codes: ['8480-6'], since: 'now-2y', count: 10 } };
    const narrowed = { ...resolveEffectiveScope(bp.manifest, 'viewer'), fhir: [] };
    await expect(executor.run(request({ decl, scope: narrowed }))).rejects.toThrow(/does not grant/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
