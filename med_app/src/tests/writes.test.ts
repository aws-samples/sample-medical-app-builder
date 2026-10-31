import { describe, expect, it } from 'vitest';
import type { Condition, MedicationRequest, Observation } from '@medplum/fhirtypes';
import cases from '../primitives/data/writeCases.json';
import { validateAllergyEntry, validateConditionEntry, validateObservationEntry, validateMediaEntry, validateProcedureEntry, validateStatusChange, validateTaskEntry, type AllergyEntryRules, type ConditionEntryRules, type MediaEntryRules, type ObservationEntryRules, type ProcedureEntryRules, type TaskEntryRules } from '../primitives/data/writes';
import { validateRecordEntry, type RecordEntryRules } from '../primitives/data/recordShape';
import { MockPrimitiveExecutor, VERSION_CONFLICT_MESSAGE } from '../primitives/data/mock/mockExecutor';
import { WriteRejectedError } from '../primitives/data/types';

/**
 * The record changes beyond a form submission: recording a measurement and changing a status. The
 * validators are mirrored in the dispatcher (writes.py); writeCases.json is asserted by both suites, so
 * a rule changed on one side fails the other. The mock executor is the reference behaviour of the
 * dispatcher for the panel's preview and local development.
 */

const NOW = new Date(cases.now);
const PATIENT = cases.patient;

describe('write validators — the shared cases', () => {
  for (const c of cases.observation_cases) {
    it(`observation: ${c.name}`, () => {
      const rules = (cases as unknown as Record<string, ObservationEntryRules>)[c.rules]!;
      expect(validateObservationEntry(rules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.status_cases) {
    it(`status: ${c.name}`, () => {
      expect(validateStatusChange(c.rules, c.change, (c.current ?? undefined) as never, c.resourceType, c.statusField, PATIENT)).toEqual(c.expected);
    });
  }
  // The coded entries: the same shape of case — rules by name, a payload, the words expected.
  const all = cases as unknown as Record<string, unknown>;
  for (const c of cases.condition_cases) {
    it(`problem: ${c.name}`, () => {
      expect(validateConditionEntry(all[c.rules] as ConditionEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.allergy_cases) {
    it(`allergy: ${c.name}`, () => {
      expect(validateAllergyEntry(all[c.rules] as AllergyEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.procedure_cases) {
    it(`procedure: ${c.name}`, () => {
      expect(validateProcedureEntry(all[c.rules] as ProcedureEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.task_cases) {
    it(`task: ${c.name}`, () => {
      expect(validateTaskEntry(all[c.rules] as TaskEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.media_cases) {
    it(`photo: ${c.name}`, () => {
      expect(validateMediaEntry(all[c.rules] as MediaEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
  for (const c of cases.record_cases) {
    it(`record: ${c.name}`, () => {
      expect(validateRecordEntry(all[c.rules] as RecordEntryRules, c.payload, PATIENT, NOW)).toEqual(c.expected);
    });
  }
});

const BP = 'http://loinc.org|85354-9';
const SYS = 'http://loinc.org|8480-6';
const DIA = 'http://loinc.org|8462-4';

function executor() {
  return new MockPrimitiveExecutor(undefined, NOW, 0);
}

const scope = (fhir: { resource: string; operations: ('read' | 'search' | 'create' | 'update')[] }[]) => ({ patient_scope: 'individual' as const, phi_fields_visible: [], fhir });

async function run(ex: MockPrimitiveExecutor, kind: string, config: Record<string, unknown>, fhir: { resource: string; operations: ('read' | 'search' | 'create' | 'update')[] }[]) {
  return ex.execute({
    decl: { id: 'p', kind, catalog_version: '1.0.0', config: {}, output_binding: 'x' },
    config,
    scope: scope(fhir),
    idToken: 't',
    userSub: 'nurse-7',
    userDisplay: 'Nurse Seven',
    manifest: { metadata: { app_id: 'app_test', version: '0.1.0' } },
    role: 'ward',
    context: { patient_id: PATIENT },
  } as never);
}

const bpEntry = (sys: number, dia: number, id = 'bp-0001'): Observation => ({
  resourceType: 'Observation',
  identifier: [{ system: 'urn:medapp:submission', value: id }],
  code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
  effectiveDateTime: '2026-09-11T11:30:00Z',
  component: [
    { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: sys, unit: 'mmHg' } },
    { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: dia, unit: 'mmHg' } },
  ],
  status: 'amended', // a claim the executor must not trust
});

const entryConfig = (observation: Observation) => ({ subject: PATIENT, codes: [BP], components: [SYS, DIA], unit: 'mmHg', category: 'vital-signs', ranges: { [SYS]: { min: 50, max: 300 }, [DIA]: { min: 30, max: 200 } }, max_backdate_days: 7, observation });

describe('the mock executor writes like the dispatcher', () => {
  it('records a measurement the trend then sees, stamped by the platform; a retry is one record', async () => {
    const ex = executor();
    const stored = (await run(ex, 'write.fhir.observation.create', entryConfig(bpEntry(138, 86)), [{ resource: 'Observation', operations: ['create'] }])) as Observation;
    expect(stored.id).toBe('obs-mock-0001');
    expect(stored.status).toBe('final');
    expect(stored.subject).toEqual({ reference: `Patient/${PATIENT}` });
    expect(stored.performer).toEqual([{ identifier: { system: 'urn:medapp:cognito-sub', value: 'nurse-7' }, display: 'Nurse Seven' }]);
    expect(stored.issued).toBe(NOW.toISOString());
    expect(stored.category?.[0]?.coding?.[0]?.code).toBe('vital-signs');
    expect(stored.meta?.source).toBe('urn:medapp:app_test@0.1.0');
    const again = (await run(ex, 'write.fhir.observation.create', entryConfig(bpEntry(138, 86)), [{ resource: 'Observation', operations: ['create'] }])) as Observation;
    expect(again.id).toBe('obs-mock-0001');

    const series = (await run(ex, 'data.fhir.observation.by_code', { patient: PATIENT, codes: [SYS], since: 'now-2y', count: 500 }, [{ resource: 'Observation', operations: ['search'] }])) as Observation[];
    expect(series[0]?.id).toBe('obs-mock-0001');
    expect(series.length).toBe(25);
  });

  it('refuses an implausible or wrong-coded measurement with the reasons, and stores nothing', async () => {
    const ex = executor();
    await expect(run(ex, 'write.fhir.observation.create', entryConfig(bpEntry(900, 86)), [{ resource: 'Observation', operations: ['create'] }])).rejects.toMatchObject({ problems: ['component http://loinc.org|8480-6: 900 mmHg is outside the accepted range 50–300'] });
    const series = (await run(ex, 'data.fhir.observation.by_code', { patient: PATIENT, codes: [SYS], since: 'now-2y', count: 500 }, [{ resource: 'Observation', operations: ['search'] }])) as Observation[];
    expect(series.length).toBe(24);
    await expect(run(ex, 'write.fhir.observation.create', entryConfig(bpEntry(120, 80)), [{ resource: 'Observation', operations: ['search'] }])).rejects.toThrow(/Observation\.create/);
  });

  it('resolves a problem as a versioned update the problem list then reflects, and refuses a stale version', async () => {
    const ex = executor();
    const cfg = { subject: PATIENT, allowed: ['resolved', 'inactive'], change: { id: 'cond-kms-0003', versionId: '1', status: 'resolved', note: 'Beschwerdefrei.' } };
    const updated = (await run(ex, 'write.fhir.condition.update_status', cfg, [{ resource: 'Condition', operations: ['update'] }])) as Condition;
    expect(updated.clinicalStatus?.coding?.[0]?.code).toBe('resolved');
    expect(updated.abatementDateTime).toBe(NOW.toISOString());
    expect(updated.meta?.versionId).toBe('2');
    expect(updated.note?.[0]).toEqual({ authorString: 'Nurse Seven', time: NOW.toISOString(), text: 'Beschwerdefrei.' });

    const active = (await run(ex, 'data.fhir.query', { resource: 'Condition', params: { patient: PATIENT, 'clinical-status': 'active' } }, [{ resource: 'Condition', operations: ['search'] }])) as Condition[];
    expect(active.map((c) => c.id)).toEqual(['cond-kms-0002', 'cond-kms-0001']);

    const stale = { ...cfg, change: { id: 'cond-kms-0003', versionId: '1', status: 'inactive' } };
    await expect(run(ex, 'write.fhir.condition.update_status', stale, [{ resource: 'Condition', operations: ['update'] }])).rejects.toThrow(VERSION_CONFLICT_MESSAGE);
    await expect(run(ex, 'write.fhir.condition.update_status', { ...cfg, change: { id: 'cond-kms-0004', status: 'resolved' } }, [{ resource: 'Condition', operations: ['update'] }])).rejects.toBeInstanceOf(WriteRejectedError);
  });

  it('stops a medication with a reason; the prescription itself stays', async () => {
    const ex = executor();
    const cfg = { subject: PATIENT, allowed: ['stopped', 'completed', 'on-hold'], change: { id: 'medrx-kms-0003', status: 'stopped', reason: 'Knöchelödeme' } };
    const updated = (await run(ex, 'write.fhir.medication_request.update_status', cfg, [{ resource: 'MedicationRequest', operations: ['update'] }])) as MedicationRequest;
    expect(updated.status).toBe('stopped');
    expect(updated.statusReason).toEqual({ text: 'Knöchelödeme' });
    expect(updated.medicationCodeableConcept?.coding?.[0]?.code).toBe('C08CA01');
    const active = (await run(ex, 'data.fhir.query', { resource: 'MedicationRequest', params: { patient: PATIENT, status: 'active' } }, [{ resource: 'MedicationRequest', operations: ['search'] }])) as MedicationRequest[];
    expect(active.map((m) => m.id)).toEqual(['medrx-kms-0002', 'medrx-kms-0001']);
    await expect(run(ex, 'write.fhir.medication_request.update_status', cfg, [{ resource: 'MedicationRequest', operations: ['update'] }])).rejects.toMatchObject({ problems: ['MedicationRequest/medrx-kms-0003 is already stopped'] });
  });
});
