import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import definitions from '../fhir/base-definitions.json';
import { CLOSED_KINDS, OPEN_KINDS, PATIENT_SCOPED_KINDS, RECORD_RESOURCES, isOpenKind, kindIssue, recordKinds } from '../fhir/kinds';
import { BASE_QUERY_RESOURCES } from '../primitives/data/queryResources';
import { QUERY_RESOURCES } from '../primitives/data/dataCatalog';
import { resolveElement } from '../spec/record';

/**
 * Which kinds of record a shape may write is a rule, not a list: every patient-scoped type of FHIR R4 the platform
 * neither admits (its own stamps) nor refuses by name (src/fhir/closed-kinds.json, the policy) is open to administrators.
 * Opening a kind is nobody's code change; refusing one is a line in the policy file. The dispatcher reads the outcome
 * from infra/lambdas/dispatcher/data/record-kinds.json (`npm run export:kinds`), so that file must not lag the rule.
 */
describe('the kinds of record, by rule', () => {
  it('opens every patient-scoped kind that is neither admitted nor refused — and nothing else', () => {
    expect(PATIENT_SCOPED_KINDS.length).toBeGreaterThan(50);
    for (const kind of OPEN_KINDS) {
      expect(PATIENT_SCOPED_KINDS).toContain(kind);
      expect(RECORD_RESOURCES as readonly string[]).not.toContain(kind);
      expect(CLOSED_KINDS).not.toHaveProperty(kind);
    }
    const expected = PATIENT_SCOPED_KINDS.filter((k) => !(RECORD_RESOURCES as readonly string[]).includes(k) && !(k in CLOSED_KINDS));
    expect([...OPEN_KINDS]).toEqual(expected);
    // Kinds that join by rule — none of these is named anywhere in the code.
    expect([...OPEN_KINDS]).toEqual(expect.arrayContaining(['Flag', 'FamilyMemberHistory', 'ClinicalImpression', 'Immunization', 'DiagnosticReport', 'DocumentManifest', 'MolecularSequence']));
  });

  it('refuses the kinds with teeth by name, each with its reason, and does not know kinds that are not about a patient', () => {
    for (const closed of ['MedicationRequest', 'ServiceRequest', 'Appointment', 'Patient', 'Coverage', 'RiskAssessment', 'Observation', 'Provenance']) {
      expect(CLOSED_KINDS[closed]).toBeTruthy();
      expect(kindIssue(closed)).toMatch(new RegExp(`^${closed} is not a kind a shape may write: .+`));
      expect(isOpenKind(closed)).toBe(false);
    }
    // The policy may name kinds the rule would never open (Appointment, Practitioner): the author then hears why, not "unknown".
    expect(PATIENT_SCOPED_KINDS).not.toContain('Appointment');
    expect(kindIssue('Appointment')).toContain('scheduling is the appointment extension');
    expect(kindIssue('Basic')).toContain('is not a kind the platform knows');
    expect(kindIssue('Location')).toContain('is not a kind the platform knows');
  });

  it('carries element paths for every open kind, so a shape for any of them resolves its fields', () => {
    const base = new Set((definitions as { entry: { resource: { type: string } }[] }).entry.map((e) => e.resource.type));
    for (const kind of OPEN_KINDS) {
      expect(resolveElement(kind, 'id'), `${kind} has no definition`).toBeDefined();
      // The lean file carries only what the base definitions do not.
      if (!base.has(kind)) expect(resolveElement(kind, 'meta')).toBeDefined();
    }
  });

  it('makes every open kind queryable — written through a shape, read back with `list` — after the platform\'s own list', () => {
    expect(QUERY_RESOURCES.slice(0, BASE_QUERY_RESOURCES.length)).toEqual([...BASE_QUERY_RESOURCES]);
    for (const kind of OPEN_KINDS) expect(QUERY_RESOURCES).toContain(kind);
    expect(new Set(QUERY_RESOURCES).size).toBe(QUERY_RESOURCES.length);
    expect(QUERY_RESOURCES).not.toContain('Appointment');
  });

  const exported = resolve(__dirname, '../../../infra/lambdas/dispatcher/data/record-kinds.json');
  it.skipIf(!existsSync(exported))('is what the dispatcher reads (run `npm run export:kinds` after changing the rule or the policy)', () => {
    expect(JSON.parse(readFileSync(exported, 'utf8'))).toEqual(recordKinds());
  });
});
