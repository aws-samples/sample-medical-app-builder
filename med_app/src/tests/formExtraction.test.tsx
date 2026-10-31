import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Observation, QuestionnaireResponse } from '@medplum/fhirtypes';
import { QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION } from '../manifest/artifacts';
import { resolveEffectiveScope } from '../manifest/roles';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { extractAnswers } from '../primitives/data/questionnaire';
import { affectedBindings } from '../renderer/plan';
import { compileSpec, readiness } from '../spec';
import type { AppSpec } from '../spec';
import { formExtraction } from '../spec/forms';

/**
 * Answers that are measurements in their own right — the falls screen's timed up-and-go — are also written as
 * Observations when the form is submitted: the spec flags the item (`as_observation`), the compiler says so the standard
 * way on the Questionnaire (the item's code and SDC's observationExtract marker) and in the submit primitive's `extract`,
 * the scope gains Observation.create, and the executor writes one Observation per flagged answer, derived from the
 * response, so a trend over the lab's code sees it beside the values typed into an entry form.
 */

const file = '../../specs/falls-risk-form.yaml';
const spec = () => parseYaml(readFileSync(new URL(file, import.meta.url), 'utf8')) as AppSpec & { knobs: { form: { items: Record<string, unknown>[] } } };
const TUG = 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio|tug';

describe('the compiler', () => {
  it('turns as_observation into the item code with the SDC marker, the extract rule on the submit, and Observation.create in the scope', () => {
    const base = spec();
    expect(formExtraction(base.knobs.form as never)).toEqual([{ link_id: 'timed_up_and_go', code: TUG, display: 'Timed up-and-go', unit: 's' }]);
    const r = compileSpec(base, { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const submit = r.manifest.primitives.find((p) => p.kind === 'write.fhir.questionnaire_response.submit')!;
    expect(submit.config).toMatchObject({ extract: [{ link_id: 'timed_up_and_go', code: TUG, display: 'Timed up-and-go', unit: 's' }] });
    const questionnaire = r.manifest.artifacts!.questionnaires![0]!;
    const mobility = questionnaire.item!.find((i) => i.linkId === 'mobility')!;
    const tug = mobility.item!.find((i) => i.linkId === 'timed_up_and_go')!;
    expect(tug.code).toEqual([{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'tug', display: 'Timed up-and-go' }]);
    expect(tug.extension).toEqual(expect.arrayContaining([{ url: QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION, valueBoolean: true }]));
    const scope = resolveEffectiveScope(r.manifest, r.manifest.auth.default_role);
    expect(scope.fhir.find((e) => e.resource === 'Observation')).toMatchObject({ operations: ['create'], codes: [TUG] });
    // A successful submit now stales the bindings that read Observations too, not only the responses.
    const reads = [{ id: 'p_a', kind: 'data.fhir.observation.by_code', catalog_version: '1.0.0', config: {}, output_binding: 'a' }, { id: 'p_b', kind: 'data.fhir.query', catalog_version: '1.0.0', config: { resource: 'QuestionnaireResponse' }, output_binding: 'b' }] as never[];
    expect(affectedBindings([...reads, submit as never], submit)).toEqual(new Set(['a', 'b']));
    expect(affectedBindings([...reads, submit as never], { ...submit, config: { ...submit.config, extract: undefined } })).toEqual(new Set(['b']));
  });

  it('refuses the flag on anything but a number', () => {
    const base = spec();
    const items = base.knobs.form.items as { id: string; items?: Record<string, unknown>[] }[];
    const history = items.find((i) => i.id === 'history')!;
    history.items![0] = { ...history.items![0], as_observation: { system: 'loinc', code: '52552-7' } };
    expect(readiness(base).missing.map((i) => i.message)).toContain('only a number is recorded as an Observation');
  });
});

describe('the executor', () => {
  it('writes one Observation per flagged answer, derived from the response, and nothing for an unanswered one', async () => {
    const r = compileSpec(spec(), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    if (!r.ok) throw new Error('compile');
    const executor = new MockPrimitiveExecutor(undefined, new Date('2026-09-11T12:00:00Z'), 0);
    const submit = r.manifest.primitives.find((p) => p.kind === 'write.fhir.questionnaire_response.submit')!;
    const scope = resolveEffectiveScope(r.manifest, r.manifest.auth.default_role);
    const url = (submit.config as { questionnaire: string }).questionnaire;
    const response = (tug?: number): QuestionnaireResponse => ({
      resourceType: 'QuestionnaireResponse',
      status: 'completed',
      questionnaire: url,
      identifier: { system: 'urn:medapp:submission', value: tug === undefined ? 's2' : 's1' },
      item: [
        { linkId: 'history', item: [{ linkId: 'fell_last_year', answer: [{ valueCoding: { code: 'no', display: 'No' } }] }] },
        { linkId: 'mobility', item: [{ linkId: 'walking_aid', answer: [{ valueCoding: { code: 'stick', display: 'Stick' } }] }, ...(tug === undefined ? [] : [{ linkId: 'timed_up_and_go', answer: [{ valueDecimal: tug }] }])] },
      ],
    });
    expect(extractAnswers((submit.config as { extract: never }).extract, response(14.5))).toEqual([{ link_id: 'timed_up_and_go', code: TUG, display: 'Timed up-and-go', unit: 's', value: 14.5 }]);
    expect(extractAnswers((submit.config as { extract: never }).extract, response())).toEqual([]);

    const run = (qr: QuestionnaireResponse) => executor.execute({ manifest: r.manifest, role: r.manifest.auth.default_role, scope, decl: submit, config: { ...submit.config, subject: 'pat-kms-0001', response: qr }, context: { patient_id: 'pat-kms-0001' }, idToken: 't', userSub: 'u1', userDisplay: 'Nurse Example' });
    const stored = (await run(response(14.5))) as QuestionnaireResponse;
    await run(response());
    const read = { id: 'p_tug', kind: 'data.fhir.observation.by_code', catalog_version: '1.0.0', config: { patient: 'pat-kms-0001', codes: [TUG], count: 50 }, output_binding: 'tug' } as never;
    const observations = (await executor.execute({ manifest: r.manifest, role: r.manifest.auth.default_role, scope: { ...scope, fhir: [...scope.fhir, { resource: 'Observation', operations: ['read', 'search'] }] }, decl: read, config: (read as { config: Record<string, unknown> }).config, context: { patient_id: 'pat-kms-0001' }, idToken: 't', userSub: 'u1' })) as Observation[];
    expect(observations).toHaveLength(1);
    const [obs] = observations;
    expect(obs!.code?.coding).toEqual([{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'tug', display: 'Timed up-and-go' }]);
    expect(obs!.valueQuantity).toEqual({ value: 14.5, unit: 's' });
    expect(obs!.derivedFrom).toEqual([{ reference: `QuestionnaireResponse/${stored.id}` }]);
    expect(obs!.category?.[0]?.coding?.[0]?.code).toBe('survey');
    expect(obs!.identifier?.[0]).toEqual({ system: 'urn:medapp:submission', value: 's1-timed_up_and_go' });
    expect(obs!.performer?.[0]?.display).toBe('Nurse Example');
    expect(obs!.effectiveDateTime).toBe(stored.authored);
  });
});
