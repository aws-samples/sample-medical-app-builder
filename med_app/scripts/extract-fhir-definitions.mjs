#!/usr/bin/env node
/**
 * Extracts the FHIR R4 StructureDefinitions the design-system catalog needs from
 * @medplum/definitions into a compact bundle at src/fhir/base-definitions.json.
 *
 * Why: Medplum React components (ResourceTable & friends) render from indexed
 * StructureDefinitions. The full bundles are ~37 MB, and in `dispatcher` mode there
 * is no Medplum server to lazily fetch schemas from. Indexing a curated, stripped
 * bundle at startup makes rendering deterministic and offline in every data mode.
 *
 * Re-run whenever a new resource type is added to the primitive catalog:
 *   node scripts/extract-fhir-definitions.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defsDir = resolve(here, '../node_modules/@medplum/definitions/dist/fhir/r4');
const outFile = resolve(here, '../src/fhir/base-definitions.json');

// Resource types that catalog components may hand to a schema-driven Medplum component.
const RESOURCE_TYPES = [
  'Patient',
  'Observation',
  'Condition',
  'MedicationRequest',
  'ImagingStudy',
  'Encounter',
  'DiagnosticReport',
  'Practitioner',
  'Organization',
  'Questionnaire',
  'QuestionnaireResponse',
  'AllergyIntolerance',
  'Procedure',
  'Immunization',
  'DocumentReference',
  // Tasks, photos, and the resources the declared-shape `record` section writes (and the generic `list` reads back).
  'Task',
  'Media',
  'Goal',
  'CarePlan',
  'Consent',
];

/**
 * Every patient-scoped resource of R4 — one whose `subject` or `patient` is a Reference to Patient — with only what the
 * path resolver needs (path, cardinality, types) goes into src/fhir/open-kind-definitions.json. From that list the
 * platform derives the kinds it opens to administrators' shapes (src/fhir/kinds.ts: patient-scoped, minus the admitted,
 * minus the refused), so opening a kind is a rule, not a list anyone edits. Composition has no subject constraint to
 * Patient in R4 (Reference(Any)); it is a clinical document all the same and is kept by name.
 */
const ALWAYS_PATIENT_SCOPED = ['Composition'];
const openOutFile = resolve(here, '../src/fhir/open-kind-definitions.json');
/** The policy: kinds no shape may write (src/fhir/closed-kinds.json) — their element paths are not shipped. */
const CLOSED = Object.keys(JSON.parse(readFileSync(resolve(here, '../src/fhir/closed-kinds.json'), 'utf8'))).filter((k) => !k.startsWith('_'));

const strip = (sd) => ({
  resourceType: 'StructureDefinition',
  id: sd.id,
  url: sd.url,
  name: sd.name,
  status: sd.status,
  kind: sd.kind,
  abstract: sd.abstract,
  type: sd.type,
  baseDefinition: sd.baseDefinition,
  derivation: sd.derivation,
  snapshot: {
    element: (sd.snapshot?.element ?? []).map((el) => {
      const {
        definition, comment, requirements, alias, mapping, constraint, short, // noise for rendering
        ...rest
      } = el;
      void definition; void comment; void requirements; void alias; void mapping; void constraint; void short;
      return rest;
    }),
  },
});

const load = (f) => JSON.parse(readFileSync(resolve(defsDir, f), 'utf8'));

const types = load('profiles-types.json').entry.map((e) => e.resource).filter((r) => r.resourceType === 'StructureDefinition');
const resources = load('profiles-resources.json')
  .entry.map((e) => e.resource)
  .filter((r) => r.resourceType === 'StructureDefinition' && RESOURCE_TYPES.includes(r.name));

const missing = RESOURCE_TYPES.filter((t) => !resources.some((r) => r.name === t));
if (missing.length) {
  throw new Error(`Missing StructureDefinitions: ${missing.join(', ')}`);
}

const bundle = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [...types, ...resources].map((sd) => ({ resource: strip(sd) })),
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(bundle));
const kb = Math.round(Buffer.byteLength(JSON.stringify(bundle)) / 1024);
console.log(`Wrote ${bundle.entry.length} StructureDefinitions (${types.length} types, ${resources.length} resources) → ${outFile} (${kb} KB)`);

const all = load('profiles-resources.json').entry.map((e) => e.resource).filter((r) => r.resourceType === 'StructureDefinition' && r.kind === 'resource' && !r.abstract);
const isPatientScoped = (sd) =>
  ALWAYS_PATIENT_SCOPED.includes(sd.name) ||
  (sd.snapshot?.element ?? []).some((el) => (el.path === `${sd.name}.subject` || el.path === `${sd.name}.patient`) && (el.type ?? []).some((t) => t.code === 'Reference' && (t.targetProfile ?? []).some((p) => p.endsWith('/Patient'))));
const patientScoped = all.filter(isPatientScoped).map((sd) => sd.name).sort();
const paths = {};
for (const name of patientScoped) {
  if (RESOURCE_TYPES.includes(name) || CLOSED.includes(name)) continue; // in the base bundle already, or refused by policy
  const sd = all.find((r) => r.name === name);
  paths[name] = (sd.snapshot?.element ?? []).map((el) => ({
    path: el.path,
    ...(el.min !== undefined ? { min: el.min } : {}),
    ...(el.max !== undefined ? { max: el.max } : {}),
    ...(el.type ? { type: el.type.map((t) => ({ code: t.code })) } : {}),
  }));
}
const open = { patient_scoped: patientScoped, paths };
writeFileSync(openOutFile, JSON.stringify(open));
console.log(`Wrote ${patientScoped.length} patient-scoped kinds (${Object.keys(paths).length} with their element paths) → ${openOutFile} (${Math.round(Buffer.byteLength(JSON.stringify(open)) / 1024)} KB)`);
