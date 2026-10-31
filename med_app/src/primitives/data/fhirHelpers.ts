import type { CodeableConcept, Observation, Patient, Quantity, Resource } from '@medplum/fhirtypes';

/** Accepts `abc`, `Patient/abc` → `abc`. */
export function patientIdOf(ref: string): string {
  return ref.startsWith('Patient/') ? ref.slice('Patient/'.length) : ref;
}

const ATC = 'http://www.whocc.no/atc';
const ICD10GM = 'http://fhir.de/CodeSystem/bfarm/icd-10-gm';

/**
 * Two code systems carry their hierarchy in the code itself, and a filter may name a level above the leaf: an ATC
 * class (fewer than the seven characters of a substance — `C09A` ACE inhibitors covers `C09AA05` ramipril) or an
 * ICD-10-GM category (the three characters before the dot — `I10` covers `I10.00`, `I10.90`). Mirror of
 * `code_matches` in infra/lambdas/dispatcher/fhir_source.py; a real server matches tokens exactly, so the dispatcher
 * filters such codes itself (primitives.py `fhir_query`).
 */
export function isClassCode(system: string | undefined, code: string): boolean {
  if (system === ATC) return code.length < 7;
  if (system === ICD10GM) return !code.includes('.') && code.length === 3;
  return false;
}

/** One coding against one wanted `system|code` (or bare code): equal, or under it in a hierarchy the system carries. */
export function codeMatches(coding: { system?: string; code?: string }, wantedSystem: string | undefined, wantedCode: string): boolean {
  if (!coding.code) return false;
  if (wantedSystem && coding.system !== wantedSystem) return false;
  if (coding.code === wantedCode) return true;
  if (!wantedSystem || !isClassCode(wantedSystem, wantedCode)) return false;
  return wantedSystem === ATC ? coding.code.startsWith(wantedCode) : coding.code.startsWith(`${wantedCode}.`);
}

/** `system|code` or bare `code` matches a CodeableConcept — a class or category matches every code under it. */
export function conceptMatches(concept: CodeableConcept | undefined, wanted: readonly string[]): boolean {
  if (!concept?.coding) return false;
  return concept.coding.some((c) =>
    wanted.some((w) => {
      const [sys, code] = w.includes('|') ? w.split('|', 2) : [undefined, w];
      return codeMatches(c, sys === '' ? undefined : sys, code ?? '');
    })
  );
}

/** The patient a resource is about: `subject` on most types, `patient` on AllergyIntolerance and Immunization, `for` on Task. */
export function subjectIs(resource: { subject?: { reference?: string }; patient?: { reference?: string }; for?: { reference?: string } }, patientId: string): boolean {
  return (resource.subject?.reference ?? resource.patient?.reference ?? resource.for?.reference) === `Patient/${patientId}`;
}

/** FHIR token search over a CodeableConcept or a list of them (`category`, `type`): `code` or `system|code`. */
export function tokenInConcepts(concepts: CodeableConcept | CodeableConcept[] | undefined, token: string): boolean {
  const list = Array.isArray(concepts) ? concepts : concepts ? [concepts] : [];
  return list.some((c) => conceptMatches(c, [token]));
}

/**
 * The clinically meaningful timestamp of a resource, whatever its type — what lists sort by and what a
 * `date=ge…` filter compares. Mirrors `resource_date` in the dispatcher.
 */
export function resourceDate(r: Resource): string {
  const x = r as unknown as Record<string, unknown> & {
    effectivePeriod?: { start?: string };
    performedPeriod?: { start?: string };
    period?: { start?: string };
  };
  return (
    (x.createdDateTime as string | undefined) ?? // Media
    (x.effectiveDateTime as string | undefined) ??
    x.effectivePeriod?.start ??
    (x.issued as string | undefined) ??
    (x.onsetDateTime as string | undefined) ??
    (x.recordedDate as string | undefined) ??
    (x.performedDateTime as string | undefined) ??
    x.performedPeriod?.start ??
    (x.occurrenceDateTime as string | undefined) ??
    x.period?.start ??
    (x.statusDate as string | undefined) ?? // Goal
    (x.created as string | undefined) ?? // CarePlan
    (x.dateTime as string | undefined) ?? // Consent
    (x.date as string | undefined) ??
    (x.authoredOn as string | undefined) ??
    (x.authored as string | undefined) ??
    (x.started as string | undefined) ??
    ((x.meta as { lastUpdated?: string } | undefined)?.lastUpdated as string | undefined) ?? // a kind with no date of its own: when it was written
    ''
  );
}

/**
 * Which side of the body an observation is about, read from `bodySite`: the SNOMED laterality qualifiers the entry
 * form writes (7771000 left, 24028007 right, 51440002 both). The one place laterality is decoded — the trend's side
 * split, the readings table and the write validator all read it from here.
 */
export const SNOMED_SYSTEM = 'http://snomed.info/sct';
export const LATERALITY: Readonly<Record<string, Side>> = { '7771000': 'left', '24028007': 'right', '51440002': 'both' };
export const LATERALITY_CODE: Readonly<Record<Side, string>> = { left: '7771000', right: '24028007', both: '51440002' };
export const SIDE_WORD: Readonly<Record<Side, string>> = { left: 'left', right: 'right', both: 'both sides' };
export type Side = 'left' | 'right' | 'both';

export function lateralityOf(obs: Pick<Observation, 'bodySite'>): Side | undefined {
  for (const c of obs.bodySite?.coding ?? []) {
    if (c.system === SNOMED_SYSTEM && c.code && LATERALITY[c.code]) return LATERALITY[c.code];
  }
  return undefined;
}

export function observationDate(obs: Observation): string {
  return obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued ?? '';
}

export function newestFirst<T>(items: T[], date: (t: T) => string): T[] {
  return [...items].sort((a, b) => date(b).localeCompare(date(a)));
}

/** Systolic/diastolic-style lookup: a component's valueQuantity by its code. */
export function componentQuantity(obs: Observation, code: string): Quantity | undefined {
  return obs.component?.find((c) => conceptMatches(c.code, [code]))?.valueQuantity;
}

/**
 * The one place value[x] polymorphism is flattened for display. Every design-system
 * component uses this rather than reaching into `valueQuantity` directly.
 */
export type FlatValue =
  | { kind: 'quantity'; quantity: Quantity }
  | { kind: 'concept'; concept: CodeableConcept }
  | { kind: 'string'; text: string }
  | { kind: 'components'; parts: { label: string; quantity?: Quantity; concept?: CodeableConcept }[] }
  | { kind: 'none' };

export function flattenObservationValue(obs: Observation): FlatValue {
  if (obs.valueQuantity) return { kind: 'quantity', quantity: obs.valueQuantity };
  if (obs.valueCodeableConcept) return { kind: 'concept', concept: obs.valueCodeableConcept };
  if (typeof obs.valueString === 'string') return { kind: 'string', text: obs.valueString };
  if (typeof obs.valueBoolean === 'boolean') return { kind: 'string', text: obs.valueBoolean ? 'Yes' : 'No' };
  if (typeof obs.valueInteger === 'number') return { kind: 'string', text: String(obs.valueInteger) };
  if (obs.component?.length) {
    return {
      kind: 'components',
      parts: obs.component.map((c) => ({
        label: c.code?.coding?.[0]?.display ?? c.code?.text ?? c.code?.coding?.[0]?.code ?? 'component',
        quantity: c.valueQuantity,
        concept: c.valueCodeableConcept,
      })),
    };
  }
  return { kind: 'none' };
}

export function displayOf(concept: CodeableConcept | undefined): string {
  return concept?.text ?? concept?.coding?.[0]?.display ?? concept?.coding?.[0]?.code ?? '';
}

export function isPatient(r: Resource | undefined): r is Patient {
  return r?.resourceType === 'Patient';
}
