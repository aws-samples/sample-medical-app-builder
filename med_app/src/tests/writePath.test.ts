import { describe, expect, it } from 'vitest';
import type { Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { loadRegistry as loadShowcase, parseManifestSource } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';
import type { AppManifest, PrimitiveDecl } from '../manifest/schema';
import { isWriteKind } from '../manifest/schema';
import { resolveEffectiveScope } from '../manifest/roles';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { HTN_ASSESSMENT_URL, SEED, SEED_ANCHOR, htnAssessment } from '../primitives/data/mock/seed';
import { validateQuestionnaireResponse } from '../primitives/data/questionnaire';
import { ScopeViolationError, WriteRejectedError, type ExecutionRequest } from '../primitives/data/types';

const entry = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_htn_assessment');
if (!entry?.ok) throw new Error('assessment manifest missing');
const manifest: AppManifest = entry.manifest;
const submitDecl = manifest.primitives.find((p) => p.id === 'p_submit') as PrimitiveDecl;
const listDecl = manifest.primitives.find((p) => p.id === 'p_submissions') as PrimitiveDecl;

const completeResponse = (overrides: Partial<QuestionnaireResponse> = {}): QuestionnaireResponse => ({
  resourceType: 'QuestionnaireResponse',
  identifier: { system: 'urn:medapp:submission', value: 'test-submission-1' },
  questionnaire: HTN_ASSESSMENT_URL,
  status: 'completed',
  item: [
    { linkId: 'home_bp', answer: [{ valueCoding: { code: 'daily', display: 'Daily' } }] },
    { linkId: 'adherence', answer: [{ valueCoding: { code: 'full', display: 'All doses taken' } }] },
    { linkId: 'symptoms', answer: [{ valueCoding: { code: 'dizziness' } }, { valueCoding: { code: 'headache' } }] },
    { linkId: 'side_effects', answer: [{ valueCoding: { code: 'yes', display: 'Yes' } }] },
    { linkId: 'notes', answer: [{ valueString: 'Dose review next visit.' }] },
  ],
  ...overrides,
});

function request(decl: PrimitiveDecl, config: Record<string, unknown>, role = 'nurse'): ExecutionRequest {
  return {
    manifest,
    role,
    scope: resolveEffectiveScope(manifest, role),
    decl,
    config,
    context: { patient_id: 'pat-kms-0001' },
    idToken: 'test-token',
    userSub: 'nurse-sub-42',
  };
}

const submitConfig = (response: QuestionnaireResponse) => ({ questionnaire: HTN_ASSESSMENT_URL, subject: 'pat-kms-0001', response });

describe('QuestionnaireResponse validation against its Questionnaire', () => {
  it('accepts a complete, well-typed response', () => {
    expect(validateQuestionnaireResponse(htnAssessment, completeResponse())).toEqual([]);
  });

  it('reports every structural problem, not just the first', () => {
    const bad = completeResponse({
      item: [
        { linkId: 'home_bp', answer: [{ valueCoding: { code: 'hourly' } }] }, // not an offered option
        { linkId: 'adherence', answer: [{ valueString: 'ok' }, { valueString: 'fine' }] }, // one answer only, and string is allowed for choice
        // side_effects (required) missing
        { linkId: 'mood', answer: [{ valueString: 'x' }] }, // unknown item
        { linkId: 'notes', answer: [{ valueInteger: 3 }] }, // wrong value type
      ],
    });
    const problems = validateQuestionnaireResponse(htnAssessment, bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        '"How often does the patient measure blood pressure at home?": hourly is not one of the offered options',
        '"Medication adherence over the last four weeks" allows one answer, got 2',
        '"Side effects of current medication reported" is required',
        'unknown item "mood"',
        '"Notes for the next visit" expects valueString not valueInteger',
      ])
    );
    expect(problems).toHaveLength(5);
  });

  it('round two: a question not asked (its condition unmet) is neither required nor answerable; numbers keep to their range; coded options compare system and code', () => {
    // The showcase falls-risk form: the "About the falls" section (count, worst injury) only once "fallen in the last 12 months" is yes — the condition on the group reaches its questions; counts 0–20; timed up-and-go 0–300 s.
    const falls = loadFixtureRegistry().concat(loadShowcase()).find((e) => e.ok && e.manifest.metadata.app_id === 'app_falls_risk');
    if (!falls?.ok) throw new Error('falls-risk manifest missing');
    const q = falls.manifest.artifacts!.questionnaires[0]!;
    const response = (items: QuestionnaireResponse['item']): QuestionnaireResponse => ({ resourceType: 'QuestionnaireResponse', questionnaire: q.url, status: 'completed', item: items });
    const base = [
      { linkId: 'mobility', item: [{ linkId: 'walking_aid', answer: [{ valueCoding: { code: 'stick' } }] }, { linkId: 'timed_up_and_go', answer: [{ valueDecimal: 12.5 }] }] },
    ];
    // No fall: the count and the injury are not asked — and not required, although the count is answered-when-shown.
    const noFall = response([{ linkId: 'history', item: [{ linkId: 'fell_last_year', answer: [{ valueCoding: { code: 'no' } }] }] }, ...base]);
    expect(validateQuestionnaireResponse(q, noFall)).toEqual([]);
    // Answering a question that is not asked is a mistake the validator names.
    const sneaked = response([{ linkId: 'history', item: [{ linkId: 'fell_last_year', answer: [{ valueCoding: { code: 'no' } }] }] }, { linkId: 'fall_details', item: [{ linkId: 'falls_count', answer: [{ valueInteger: 2 }] }] }, ...base]);
    expect(validateQuestionnaireResponse(q, sneaked)).toEqual(['"How many falls? (0–20)" is not asked (its condition is not met) and cannot carry answers']);
    // A fall: the count is asked and must stay within 0–20; the timed up-and-go within 0–300.
    const fell = response([{ linkId: 'history', item: [{ linkId: 'fell_last_year', answer: [{ valueCoding: { code: 'yes' } }] }] }, { linkId: 'fall_details', item: [{ linkId: 'falls_count', answer: [{ valueInteger: 25 }] }] }, { linkId: 'mobility', item: [{ linkId: 'walking_aid', answer: [{ valueCoding: { code: 'stick' } }] }, { linkId: 'timed_up_and_go', answer: [{ valueDecimal: -1 }] }] }]);
    expect(validateQuestionnaireResponse(q, fell)).toEqual(['"How many falls? (0–20)": 25 is above the maximum 20', '"Timed up-and-go (s, 0–300)": -1 is below the minimum 0']);
    const fine = response([{ linkId: 'history', item: [{ linkId: 'fell_last_year', answer: [{ valueCoding: { code: 'yes' } }] }] }, { linkId: 'fall_details', item: [{ linkId: 'falls_count', answer: [{ valueInteger: 3 }] }, { linkId: 'injury', answer: [{ valueCoding: { code: 'minor' } }] }] }, ...base]);
    expect(validateQuestionnaireResponse(q, fine)).toEqual([]);

    // Conditions in general: exists, comparisons, all-of, a disabled group disabling its children, coded options with a system.
    const coded: Questionnaire = {
      resourceType: 'Questionnaire',
      status: 'active',
      item: [
        { linkId: 'smokes', type: 'choice', answerOption: [{ valueCoding: { system: 'http://snomed.info/sct', code: '77176002', display: 'Smoker' } }, { valueCoding: { system: 'http://snomed.info/sct', code: '266919005', display: 'Never' } }] },
        { linkId: 'per_day', type: 'integer', required: true, enableWhen: [{ question: 'smokes', operator: '=', answerCoding: { system: 'http://snomed.info/sct', code: '77176002' } }] },
        { linkId: 'heavy', type: 'group', enableWhen: [{ question: 'per_day', operator: '>=', answerInteger: 20 }], item: [{ linkId: 'quit_plan', type: 'text', required: true }] },
        { linkId: 'both', type: 'boolean', enableWhen: [{ question: 'smokes', operator: 'exists', answerBoolean: true }, { question: 'per_day', operator: '<', answerInteger: 5 }], enableBehavior: 'all' },
      ],
    };
    const smoker = (perDay: number, extra: QuestionnaireResponse['item'] = []) => ({ resourceType: 'QuestionnaireResponse' as const, status: 'completed' as const, item: [{ linkId: 'smokes', answer: [{ valueCoding: { system: 'http://snomed.info/sct', code: '77176002' } }] }, { linkId: 'per_day', answer: [{ valueInteger: perDay }] }, ...extra] });
    expect(validateQuestionnaireResponse(coded, smoker(10))).toEqual([]);
    expect(validateQuestionnaireResponse(coded, smoker(25))).toEqual(['"quit_plan" is required']); // the group is asked from 20 a day, and its child is required; an item without text is named by its linkId
    expect(validateQuestionnaireResponse(coded, smoker(3, [{ linkId: 'both', answer: [{ valueBoolean: true }] }]))).toEqual([]); // both conditions hold
    expect(validateQuestionnaireResponse(coded, smoker(10, [{ linkId: 'both', answer: [{ valueBoolean: true }] }]))).toEqual(['"both" is not asked (its condition is not met) and cannot carry answers']);
    const never = { resourceType: 'QuestionnaireResponse' as const, status: 'completed' as const, item: [{ linkId: 'smokes', answer: [{ valueCoding: { system: 'http://snomed.info/sct', code: '266919005' } }] }] };
    expect(validateQuestionnaireResponse(coded, never)).toEqual([]); // per_day is required only when asked
    const wrongSystem = { ...never, item: [{ linkId: 'smokes', answer: [{ valueCoding: { system: 'http://loinc.org', code: '266919005' } }] }] };
    expect(validateQuestionnaireResponse(coded, wrongSystem)).toEqual(['"smokes": http://loinc.org|266919005 is not one of the offered options']);
  });

  it('rejects a response that answers a different questionnaire', () => {
    const problems = validateQuestionnaireResponse(htnAssessment, completeResponse({ questionnaire: 'https://elsewhere/Questionnaire/other' }));
    expect(problems[0]).toContain('answers https://elsewhere/Questionnaire/other');
  });
});

describe('write.fhir.questionnaire_response.submit (mock executor = reference behaviour)', () => {
  it('stamps provenance server-side and makes the submission visible to the next query', async () => {
    const exec = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const clientClaims = completeResponse({
      authored: '1999-01-01T00:00:00Z',
      author: { reference: 'Practitioner/somebody-else' },
      source: { reference: 'Practitioner/123' },
      meta: { security: [{ code: 'R' }], versionId: '7' },
      id: 'client-chosen-id',
      text: { status: 'generated', div: '<div>injected</div>' },
    });

    const before = (await exec.execute(request(listDecl, { resource: 'QuestionnaireResponse', params: { patient: 'pat-kms-0001', questionnaire: HTN_ASSESSMENT_URL }, count: 50 }))) as QuestionnaireResponse[];
    expect(before.map((r) => r.id)).toEqual(['qr-kms-0001']);

    const stored = (await exec.execute(request(submitDecl, submitConfig(clientClaims)))) as QuestionnaireResponse;
    expect(stored.id).toBe('qr-mock-0001');
    expect(stored.status).toBe('completed');
    expect(stored.subject).toEqual({ reference: 'Patient/pat-kms-0001' });
    // Client-asserted authorship and time are discarded in favour of the authenticated identity and the server clock.
    expect(stored.author).toEqual({ identifier: { system: 'urn:medapp:cognito-sub', value: 'nurse-sub-42' } });
    expect(stored.authored).toBe(SEED_ANCHOR.toISOString());
    expect(stored.source).toBeUndefined();
    expect(stored.text).toBeUndefined();
    expect(stored.meta).toEqual({ versionId: '1', lastUpdated: SEED_ANCHOR.toISOString(), source: 'urn:medapp:app_htn_assessment@0.1.0' });
    expect(stored.item).toEqual(clientClaims.item);

    const after = (await exec.execute(request(listDecl, { resource: 'QuestionnaireResponse', params: { patient: 'pat-kms-0001', questionnaire: HTN_ASSESSMENT_URL }, count: 50 }))) as QuestionnaireResponse[];
    expect(after.map((r) => r.id)).toEqual(['qr-mock-0001', 'qr-kms-0001']); // newest first
  });

  it('is idempotent on the submission identifier: a retried submit returns the same record', async () => {
    const exec = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const first = (await exec.execute(request(submitDecl, submitConfig(completeResponse())))) as QuestionnaireResponse;
    const retry = (await exec.execute(request(submitDecl, submitConfig(completeResponse())))) as QuestionnaireResponse;
    expect(retry.id).toBe(first.id);
    const other = (await exec.execute(request(submitDecl, submitConfig(completeResponse({ identifier: { system: 'urn:medapp:submission', value: 'test-submission-2' } }))))) as QuestionnaireResponse;
    expect(other.id).toBe('qr-mock-0002');
  });

  it('refuses an invalid response with the list of problems and stores nothing', async () => {
    const exec = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const incomplete = completeResponse({ item: [{ linkId: 'notes', answer: [{ valueString: 'only notes' }] }] });
    const err = await exec.execute(request(submitDecl, submitConfig(incomplete))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteRejectedError);
    expect((err as WriteRejectedError).problems).toEqual(['"How often does the patient measure blood pressure at home?" is required', '"Medication adherence over the last four weeks" is required', '"Side effects of current medication reported" is required']);
    const list = (await exec.execute(request(listDecl, { resource: 'QuestionnaireResponse', params: { patient: 'pat-kms-0001', questionnaire: HTN_ASSESSMENT_URL }, count: 50 }))) as QuestionnaireResponse[];
    expect(list).toHaveLength(1); // the seeded follow-up only; the falls screens answer another form
  });

  it('refuses a response that claims a different patient than the one in context', async () => {
    const exec = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const err = await exec.execute(request(submitDecl, submitConfig(completeResponse({ subject: { reference: 'Patient/pat-kms-0002' } })))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteRejectedError);
    expect((err as WriteRejectedError).problems).toEqual(['response subject Patient/pat-kms-0002 is not the patient in context']);
  });

  it('refuses the write when the role scope lacks QuestionnaireResponse.create', async () => {
    const nurseScope = manifest.data_scopes['scope_nurse'];
    if (!nurseScope?.fhir) throw new Error('scope_nurse missing');
    const readOnly: AppManifest = {
      ...manifest,
      data_scopes: {
        ...manifest.data_scopes,
        scope_nurse: {
          ...nurseScope,
          fhir: nurseScope.fhir.map((f) => (f.resource === 'QuestionnaireResponse' ? { ...f, operations: ['search' as const] } : f)),
        },
      },
    };
    const exec = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const req: ExecutionRequest = { ...request(submitDecl, submitConfig(completeResponse())), manifest: readOnly, scope: resolveEffectiveScope(readOnly, 'nurse') };
    const err = await exec.execute(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeViolationError);
    expect((err as ScopeViolationError).requirement).toBe('QuestionnaireResponse.create');
  });
});

describe('manifest rules for actions and write primitives', () => {
  const base = `
apiVersion: medapp.eu/v1
kind: AppManifest
metadata: { app_id: x, version: 0.0.1, name: X, intent_class: workflow, hospital_id: h }
lifecycle: { state: draft }
auth:
  roles: [{ id: nurse, display_name: N, cognito_group: g, data_scope_ref: s }]
  default_role: nurse
data_scopes:
  s:
    fhir:
      - { resource: Patient, operations: [read] }
      - { resource: QuestionnaireResponse, operations: [create] }
primitives:
  - { id: p_patient, kind: data.fhir.patient.read, catalog_version: 1.0.0, config: { patient: $context.patient_id }, output_binding: patient }
  - id: p_submit
    kind: write.fhir.questionnaire_response.submit
    catalog_version: 1.0.0
    config: { questionnaire: q, subject: $context.patient_id, response: $ui.r }
    output_binding: submitted
layout:
  design_system_version: 1.0.0
  root: { component: PageShell }
`;

  it('classifies kinds', () => {
    expect(isWriteKind('write.fhir.questionnaire_response.submit')).toBe(true);
    expect(isWriteKind('data.fhir.query')).toBe(false);
  });

  it('accepts a write primitive that is driven by an action', () => {
    const ok = parseManifestSource('ok.yaml', `${base}actions:\n  - { id: save, label: Save, primitive: p_submit }\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.actions[0]).toMatchObject({ id: 'save', primitive: 'p_submit', on_success: 'reload' });
  });

  it('rejects a write primitive that no action runs (it could never execute, and load must not run it)', () => {
    const r = parseManifestSource('orphan.yaml', base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes('p_submit') && /action/i.test(i.message))).toBe(true);
  });

  it('rejects an action that points at a read primitive or at an unknown one, and duplicate action ids', () => {
    const r = parseManifestSource(
      'bad.yaml',
      `${base}actions:\n  - { id: save, label: Save, primitive: p_patient }\n  - { id: save, label: Again, primitive: p_nope }\n  - { id: real, label: R, primitive: p_submit }\n`
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const messages = r.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('actions must run write.* primitives'))).toBe(true);
      expect(messages.some((m) => m.includes('unknown primitive "p_nope"'))).toBe(true);
      expect(messages.some((m) => m.includes('duplicate action id "save"'))).toBe(true);
    }
  });

  it('keeps the schema strict: unknown operation names are refused', () => {
    const r = parseManifestSource('ops.yaml', base.replace('operations: [create]', 'operations: [delete]'));
    expect(r.ok).toBe(false);
  });
});
