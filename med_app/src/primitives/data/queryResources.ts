/**
 * Resource types `data.fhir.query` may search before any shape opens more — the allow-list the dispatcher enforces too
 * (infra/lambdas/dispatcher/primitives.py QUERY_RESOURCES, read from data/record-kinds.json). Adding one here is a
 * platform release: seed data, a list component or a section kind. The open kinds (src/fhir/kinds.ts) join the list by
 * rule — written through administrators' shapes, read back with `list` — so this file stays the platform's own part.
 */
export const BASE_QUERY_RESOURCES = [
  'Condition',
  'MedicationRequest',
  'Observation',
  'ImagingStudy',
  'Encounter',
  'DiagnosticReport',
  'Questionnaire',
  'QuestionnaireResponse',
  'AllergyIntolerance',
  'Procedure',
  'Immunization',
  'DocumentReference',
  'Task',
  'Media',
  'Goal',
  'CarePlan',
  'Consent',
] as const;
