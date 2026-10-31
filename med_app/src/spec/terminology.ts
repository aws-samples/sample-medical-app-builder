/**
 * Code systems the spec may name by alias. The compiler always writes fully qualified
 * `system|code` tokens into primitive configs and data scopes; components that look inside a
 * panel (e.g. a systolic component) receive bare codes, because the panel fixes the system.
 * Mirrors `terminology.systems` in docs/application-catalog.yaml.
 */
export const SYSTEM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  atc: 'http://www.whocc.no/atc',
  // The German hospital codings for diagnoses and procedures (ICD-10-GM, OPS).
  icd10gm: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm',
  ops: 'http://fhir.de/CodeSystem/bfarm/ops',
  ucum: 'http://unitsofmeasure.org',
  dicom_modality: 'http://dicom.nema.org/resources/ontology/DCM',
});

const SYSTEM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'http://loinc.org': 'LOINC',
  'http://snomed.info/sct': 'SNOMED CT',
  'http://www.whocc.no/atc': 'ATC',
  'http://fhir.de/CodeSystem/bfarm/icd-10-gm': 'ICD-10-GM',
  'http://fhir.de/CodeSystem/bfarm/ops': 'OPS',
  'http://unitsofmeasure.org': 'UCUM',
});

export interface Code {
  readonly system: string;
  readonly code: string;
  readonly display?: string | undefined;
}

export function isSystemUrl(system: string): boolean {
  return /^(https?:\/\/|urn:)/.test(system);
}

/** Alias → URL; URLs pass through. Unknown aliases are rejected by the spec schema before this runs. */
export function systemUrl(system: string): string {
  if (isSystemUrl(system)) return system;
  const url = SYSTEM_ALIASES[system];
  if (!url) throw new Error(`Unknown code system alias "${system}"`);
  return url;
}

export function qualified(code: Code): string {
  return `${systemUrl(code.system)}|${code.code}`;
}

export function systemLabel(code: Code): string {
  const url = systemUrl(code.system);
  return SYSTEM_LABELS[url] ?? url;
}
