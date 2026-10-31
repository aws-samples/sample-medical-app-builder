import { z } from 'zod';
import { recordKinds } from '../../fhir/kinds';
import type { EffectiveScope } from '../../manifest/roles';
import { isDicomOperationInScope, isFhirResourceInScope } from '../../manifest/roles';
import { PrimitiveConfigError, ScopeViolationError, UnknownPrimitiveError } from './types';

/**
 * Data primitive catalog v0. Each entry declares:
 *  - the config schema the agent pipeline must satisfy (validated after $references resolve)
 *  - the data access it needs, checked against the role's effective scope before execution
 *
 * Execution lives in the executors; this file is the contract both sides agree on.
 */

const patientRef = z.string().min(1).describe('Patient id or Patient/{id} reference');

/** Resource types `data.fhir.query` may search: the platform's own list plus every kind open to administrators' shapes. */
export const QUERY_RESOURCES: readonly string[] = recordKinds().query_resources;
export type QueryResource = string;
const codeList = z.array(z.string().min(1)).min(1).describe('LOINC/SNOMED codes, optionally system|code');

export const PRIMITIVE_CONFIG_SCHEMAS = {
  'data.fhir.patient.read': z.strictObject({
    patient: patientRef,
  }),
  'data.fhir.observation.by_code': z.strictObject({
    patient: patientRef,
    codes: codeList,
    since: z.string().optional().describe('ISO date or relative (now-2y, now-90d)'),
    count: z.number().int().positive().max(1000).default(500),
  }),
  'data.fhir.query': z.strictObject({
    resource: z.enum(QUERY_RESOURCES as [string, ...string[]]),
    params: z.record(z.string(), z.string()).default({}),
    count: z.number().int().positive().max(1000).default(100),
  }),
  'data.fhir.questionnaire.read': z.strictObject({
    /** Canonical URL (Questionnaire.url) or a Questionnaire id. */
    questionnaire: z.string().min(1),
  }),
  'write.fhir.questionnaire_response.submit': z.strictObject({
    /** Canonical URL of the Questionnaire the response answers; the dispatcher validates against it. */
    questionnaire: z.string().min(1),
    subject: patientRef,
    /** Answers also written as Observations on submission: the item (linkId), the Observation code (qualified), its display and unit. Needs Observation.create in the scope. */
    extract: z.array(z.strictObject({ link_id: z.string().min(1), code: z.string().min(1), display: z.string().min(1).optional(), unit: z.string().min(1).optional() })).min(1).optional(),
    /** The QuestionnaireResponse produced by the form (resolved from $ui at action time). */
    response: z.custom<{ resourceType: 'QuestionnaireResponse' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'QuestionnaireResponse', {
      message: 'response must be a QuestionnaireResponse',
    }),
  }),
  'write.fhir.observation.create': z.strictObject({
    subject: patientRef,
    /** Observation codes this form may record (qualified system|code); the payload's code must be one of them. */
    codes: codeList,
    /** For a panel (e.g. blood pressure): the component codes the payload must carry, each with a value. */
    components: z.array(z.string().min(1)).optional(),
    unit: z.string().min(1).optional(),
    /** Observation category code (vital-signs, laboratory, …) stamped on the stored record. */
    category: z.string().min(1).optional(),
    /** Plausibility range per code — a data-quality rule, not a clinical judgement. */
    ranges: z.record(z.string(), z.strictObject({ min: z.number().optional(), max: z.number().optional() })).optional(),
    /** Relations between a panel's components: one must be above another (systolic above diastolic) — a swapped pair is refused. */
    rules: z.array(z.strictObject({ component: z.string().min(1), above: z.string().min(1), message: z.string().min(1).optional() })).optional(),
    max_backdate_days: z.number().int().min(0).max(365).default(7),
    /** Whether a side of the body is asked (left, right, both → bodySite, SNOMED laterality); absent: a side in the payload is refused. */
    side: z.enum(['optional', 'required']).optional(),
    /** The structure measured (qualified code), the only non-laterality coding bodySite may carry. */
    body_site: z.string().min(1).optional(),
    /** Test conditions (qualified codes) the payload's `method` must be one of; absent: a method is refused. */
    conditions: z.array(z.string().min(1)).optional(),
    /** The Observation produced by the entry form (resolved from $ui at action time). */
    observation: z.custom<{ resourceType: 'Observation' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Observation', {
      message: 'observation must be an Observation',
    }),
  }),
  'write.fhir.condition.create': z.strictObject({
    subject: patientRef,
    /** The diagnoses this form may add (qualified system|code); the payload's code must be one of them. */
    codes: codeList,
    /** Verification statuses the clinician may choose; the first is the default when the payload names none. */
    verification: z.array(z.string().min(1)).min(1).default(['confirmed']),
    /** Condition category stamped on the stored record. */
    category: z.enum(['problem-list-item', 'encounter-diagnosis']).default('problem-list-item'),
    /** Whether the form offers a severity (mild / moderate / severe). */
    severity: z.boolean().default(false),
    /** The Condition produced by the entry form (resolved from $ui at action time). */
    condition: z.custom<{ resourceType: 'Condition' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Condition', {
      message: 'condition must be a Condition',
    }),
  }),
  'write.fhir.allergy_intolerance.create': z.strictObject({
    subject: patientRef,
    /** The substances or agents this form may record (qualified system|code). */
    codes: codeList,
    types: z.array(z.enum(['allergy', 'intolerance'])).min(1).default(['allergy', 'intolerance']),
    categories: z.array(z.enum(['food', 'medication', 'environment', 'biologic'])).min(1).default(['medication', 'food', 'environment']),
    verification: z.array(z.string().min(1)).min(1).default(['confirmed', 'unconfirmed']),
    /** Whether the form offers a criticality (low / high / unable-to-assess). */
    criticality: z.boolean().default(true),
    /** Whether the form takes a reaction (manifestation text and severity). */
    reaction: z.boolean().default(true),
    /** The AllergyIntolerance produced by the entry form (resolved from $ui at action time). */
    allergy: z.custom<{ resourceType: 'AllergyIntolerance' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'AllergyIntolerance', {
      message: 'allergy must be an AllergyIntolerance',
    }),
  }),
  'write.fhir.procedure.create': z.strictObject({
    subject: patientRef,
    /** The procedures this form may record (qualified system|code, OPS on the hospital record). */
    codes: codeList,
    /** Statuses the clinician may record; the payload must name one. */
    statuses: z.array(z.enum(['completed', 'in-progress', 'not-done', 'stopped'])).min(1).default(['completed']),
    max_backdate_days: z.number().int().min(0).max(3650).default(30),
    /** Whether the form takes a body site (free text). */
    body_site: z.boolean().default(false),
    /** Whether the form takes an outcome (free text). */
    outcome: z.boolean().default(false),
    /** The Procedure produced by the entry form (resolved from $ui at action time). */
    procedure: z.custom<{ resourceType: 'Procedure' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Procedure', {
      message: 'procedure must be a Procedure',
    }),
  }),
  'data.fhir.questionnaire_response.answers': z.strictObject({
    patient: patientRef,
    /** Canonical URL of the Questionnaire whose answers are read. */
    questionnaire: z.string().min(1),
    /** The questions (linkIds) whose numeric answers become points; each answer is one derived Observation coded by its linkId. */
    link_ids: z.array(z.string().min(1)).min(1).max(20),
    count: z.number().int().positive().max(1000).default(200),
  }),
  'data.cohort.assessment_due': z.strictObject({
    /** Canonical URL of the Questionnaire whose answers count as "done" — the record's, or an app-authored form's. */
    questionnaire: z.string().min(1),
    /** How often the assessment is due, in days from the last one. */
    every_days: z.number().int().positive().max(3650),
    /** The population: the members of a cohort (`$bindings.cohort.patients`); omitted = everyone with an earlier answer. */
    patients: z.array(z.custom<{ resourceType: 'Patient'; id?: string }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Patient')).optional(),
    /** Also list those due within this many days from today (0 = only those due or overdue). */
    upcoming_days: z.number().int().min(0).max(365).default(0),
    count: z.number().int().positive().max(1000).default(200),
  }),
  'data.task.worklist': z.strictObject({
    /** Task codes (qualified system|code) the list is about; omitted = every task. */
    codes: z.array(z.string().min(1)).optional(),
    statuses: z.array(z.enum(['requested', 'in-progress', 'completed', 'cancelled', 'on-hold'])).min(1).default(['requested', 'in-progress']),
    count: z.number().int().positive().max(1000).default(200),
  }),
  'write.fhir.record.create': z.strictObject({
    subject: patientRef,
    /** The resource type the shape writes — one the record engine allows (spec/record.ts RECORD_RESOURCES). */
    resource: z.string().min(1),
    /** The declared fields: id, label, type, element path, encoding and the field's own rules (recordShape.ts). */
    fields: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          label: z.string().min(1),
          type: z.enum(['text', 'long_text', 'number', 'integer', 'date', 'datetime', 'boolean', 'code', 'choice']),
          path: z.string().min(1),
          as: z.enum(['string', 'concept_text', 'quantity', 'decimal', 'integer', 'codeable_concept', 'coding', 'code', 'date', 'datetime', 'boolean', 'attachment_text']),
          required: z.boolean().optional(),
          unit: z.string().min(1).optional(),
          range: z.strictObject({ min: z.number().optional(), max: z.number().optional() }).optional(),
          past_days: z.number().int().min(0).optional(),
          future_days: z.number().int().min(0).optional(),
          max_length: z.number().int().positive().optional(),
          codes: z.array(z.strictObject({ system: z.string().min(1), code: z.string().min(1), display: z.string().min(1) })).optional(),
          options: z.array(z.strictObject({ code: z.string().min(1), display: z.string().min(1) })).optional(),
          system: z.string().min(1).optional(),
        })
      )
      .min(1),
    /** What the platform writes on every record of this shape (status, subject, author, dates): path and value, with $patient/$author/$now/$today filled in. */
    stamps: z.array(z.strictObject({ path: z.string().min(1), value: z.unknown() })),
    /** The library shape these rules came from, pinned by checksum and version; `tag` is the `meta.tag` every record written with it carries (the shape and its version, on the record itself). */
    shape: z.strictObject({ id: z.string().min(1), checksum: z.string().min(1), version: z.string().min(1).optional(), open_kind: z.boolean().optional(), tag: z.strictObject({ system: z.string().min(1), code: z.string().min(1), version: z.string().min(1), display: z.string().min(1) }) }).optional(),
    /** The resource the entry form produced (resolved from $ui at action time). */
    record: z.custom<{ resourceType: string }>((v) => typeof v === 'object' && v !== null && typeof (v as { resourceType?: unknown }).resourceType === 'string', { message: 'record must be a FHIR resource' }),
  }),
  'write.fhir.media.create': z.strictObject({
    subject: patientRef,
    /** What a photo may document (qualified urn:medapp:photo|code); the payload's reasonCode must be one of them. */
    kinds: codeList,
    /** Whether the form takes a body site (free text). */
    body_site: z.boolean().default(true),
    /** The largest image accepted, in bytes (after the browser's downscale). */
    max_bytes: z.number().int().positive().max(8_000_000).default(1_500_000),
    max_backdate_days: z.number().int().min(0).max(365).default(30),
    /** The Media produced by the form, its image in content.data (resolved from $ui at action time). */
    media: z.custom<{ resourceType: 'Media' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Media', { message: 'media must be a Media' }),
  }),
  'write.fhir.task.create': z.strictObject({
    subject: patientRef,
    /** The task codes this form may create (qualified system|code); the payload's code must be one of them. */
    codes: codeList,
    priorities: z.array(z.enum(['routine', 'urgent', 'asap', 'stat'])).min(1).default(['routine', 'urgent']),
    /** Whether the form takes a due date. */
    due: z.boolean().default(true),
    /** The Task produced by the form (resolved from $ui at action time). */
    task: z.custom<{ resourceType: 'Task' }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Task', { message: 'task must be a Task' }),
  }),
  'write.fhir.task.update_status': z.strictObject({
    /** Which patient's tasks; `$context.patient_id` on a patient page, absent on a worklist (any patient the row names). */
    subject: patientRef.optional(),
    /** Target statuses the app may set (in-progress, completed, cancelled). */
    allowed: z.array(z.string().min(1)).min(1),
    /** { id, status, versionId?, note? } from the list's action. */
    change: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null, { message: 'change must be an object' }),
  }),
  'write.fhir.condition.update_status': z.strictObject({
    subject: patientRef,
    /** Target clinical statuses the app may set (resolved, inactive, remission, active). */
    allowed: z.array(z.string().min(1)).min(1),
    /** { id, status, versionId?, note? } from the list's action (resolved from $ui at action time). */
    change: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null, { message: 'change must be an object' }),
  }),
  'write.fhir.medication_request.update_status': z.strictObject({
    subject: patientRef,
    /** Target statuses the app may set (stopped, completed, on-hold, cancelled, active). */
    allowed: z.array(z.string().min(1)).min(1),
    /** { id, status, versionId?, reason?, note? } from the list's action. */
    change: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null, { message: 'change must be an object' }),
  }),
  'data.dicom.studies.for_patient': z.strictObject({
    patient: patientRef,
    modalities: z.array(z.string()).optional(),
  }),
  'data.cohort.by_condition': z.strictObject({
    condition_codes: codeList,
    clinical_status: z.enum(['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']).optional(),
  }),
  'data.cohort.latest_observation': z.strictObject({
    patients: z.array(z.custom<{ resourceType: 'Patient'; id?: string }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Patient')),
    codes: codeList,
    /** Which component of a panel is the member's compared value (`compared` on every row); the observation's own value otherwise. */
    component_code: z.string().optional(),
    threshold: z
      .strictObject({
        component_code: z.string().optional(),
        value: z.number(),
      })
      .optional(),
  }),
  'data.cohort.with_imaging': z.strictObject({
    patients: z.array(z.custom<{ resourceType: 'Patient'; id?: string }>((v) => typeof v === 'object' && v !== null && (v as { resourceType?: string }).resourceType === 'Patient')),
    /** DICOM modality codes a study must carry to count (CT, MR, …); empty: any study. */
    modalities: z.array(z.string().min(1)).optional(),
    /** Only studies started from this date (`now-2y`, ISO date); omitted: the whole record. */
    since: z.string().min(1).optional(),
    /** How many matching studies a member needs to stay in the cohort. */
    min_studies: z.number().int().positive().default(1),
  }),
} as const;

export type DataPrimitiveKind = keyof typeof PRIMITIVE_CONFIG_SCHEMAS;

export type PrimitiveConfig<K extends DataPrimitiveKind> = z.infer<(typeof PRIMITIVE_CONFIG_SCHEMAS)[K]>;

export interface DataPrimitiveEntry {
  readonly kind: DataPrimitiveKind;
  readonly version: string;
  readonly description: string;
  readonly output: string;
}

export const DATA_CATALOG: Record<DataPrimitiveKind, DataPrimitiveEntry> = {
  'data.fhir.patient.read': {
    kind: 'data.fhir.patient.read',
    version: '1.0.0',
    description: 'Read a single Patient resource from the launch context.',
    output: 'Patient',
  },
  'data.fhir.observation.by_code': {
    kind: 'data.fhir.observation.by_code',
    version: '1.0.0',
    description: 'Observations for a patient filtered by code (matches Observation.code and component codes), newest first.',
    output: 'Observation[]',
  },
  'data.fhir.query': {
    kind: 'data.fhir.query',
    version: '1.0.0',
    description: 'Constrained FHIR search on an allow-listed resource type.',
    output: 'Resource[]',
  },
  'data.dicom.studies.for_patient': {
    kind: 'data.dicom.studies.for_patient',
    version: '1.0.0',
    description: 'Imaging studies for a patient (QIDO-RS via the dispatcher; ImagingStudy resources in mock mode).',
    output: 'ImagingStudy[]',
  },
  'data.cohort.by_condition': {
    kind: 'data.cohort.by_condition',
    version: '1.0.0',
    description: 'Patients with at least one Condition matching the given codes.',
    output: '{ patients: Patient[]; conditions: Condition[]; count: number }',
  },
  'data.cohort.latest_observation': {
    kind: 'data.cohort.latest_observation',
    version: '1.0.0',
    description: 'Latest matching observation per patient — each row with the compared value (a panel component or the value itself) and an optional threshold flag; the range of compared values across the cohort.',
    output: '{ rows: CohortObservationRow[]; above_threshold_count: number; compared_min?: number; compared_max?: number }',
  },
  'data.cohort.with_imaging': {
    kind: 'data.cohort.with_imaging',
    version: '1.0.0',
    description:
      'Narrows a cohort to the members with imaging studies of the given modalities (QIDO-RS per member where a PACS is configured, FHIR ImagingStudy otherwise): a row per member with the study count, the latest matching study and its modalities; `patients` is the narrowed cohort.',
    output: '{ rows: CohortImagingRow[]; patients: Patient[]; count: number; studies_total: number }',
  },
  'data.fhir.questionnaire.read': {
    kind: 'data.fhir.questionnaire.read',
    version: '1.0.0',
    description: 'A Questionnaire (form definition) by canonical URL or id.',
    output: 'Questionnaire',
  },
  'write.fhir.questionnaire_response.submit': {
    kind: 'write.fhir.questionnaire_response.submit',
    version: '1.0.0',
    description: 'Writes a completed QuestionnaireResponse to the patient record after validating it against its Questionnaire. Runs only through an action.',
    output: 'QuestionnaireResponse (as stored, with id and provenance)',
  },
  'write.fhir.observation.create': {
    kind: 'write.fhir.observation.create',
    version: '1.0.0',
    description: 'Records a measurement: an Observation whose code, unit, plausibility range and date the manifest fixed in advance; stamps status, subject, performer, time and provenance. Runs only through an action.',
    output: 'Observation (as stored, with id and provenance)',
  },
  'write.fhir.condition.create': {
    kind: 'write.fhir.condition.create',
    version: '1.0.0',
    description: 'Adds a diagnosis to the problem list: an active Condition whose code is one the manifest allows, with the verification status, onset, severity and note the form took; stamps category, subject, recorder, recorded date and provenance. Runs only through an action.',
    output: 'Condition (as stored, with id and provenance)',
  },
  'write.fhir.allergy_intolerance.create': {
    kind: 'write.fhir.allergy_intolerance.create',
    version: '1.0.0',
    description: 'Records an allergy or intolerance: an active AllergyIntolerance whose substance is one the manifest allows, with type, category, criticality, verification, reaction and note from the form; stamps patient, recorder, recorded date and provenance. Runs only through an action.',
    output: 'AllergyIntolerance (as stored, with id and provenance)',
  },
  'write.fhir.procedure.create': {
    kind: 'write.fhir.procedure.create',
    version: '1.0.0',
    description: 'Records a procedure performed: a Procedure whose code is one the manifest allows, dated within a window, with status, body site, outcome and note from the form; stamps subject, performer, recorder and provenance. Runs only through an action.',
    output: 'Procedure (as stored, with id and provenance)',
  },
  'data.fhir.questionnaire_response.answers': {
    kind: 'data.fhir.questionnaire_response.answers',
    version: '1.0.0',
    description: "A form's answers over time as data: every numeric answer to the named questions, across the patient's responses to one Questionnaire, as a derived Observation (code = the questionnaire URL | linkId, value and unit from the answer, dated when answered, derivedFrom the response) — so the trend chart and the readings table draw them like any measurement. Nothing is written.",
    output: 'Observation[] (derived, not stored)',
  },
  'data.cohort.assessment_due': {
    kind: 'data.cohort.assessment_due',
    version: '1.0.0',
    description: "Who is due an assessment: the members of a cohort (or everyone assessed before) against their latest QuestionnaireResponse to one Questionnaire — never assessed, overdue, due, or upcoming within a window; one row per patient, the never-assessed and the longest overdue first.",
    output: '{ rows: AssessmentDueRow[]; count: number; never_count: number; overdue_count: number }',
  },
  'data.task.worklist': {
    kind: 'data.task.worklist',
    version: '1.0.0',
    description: 'The open tasks across patients — by task code and status — each with the patient it is for; sorted overdue first, then by due date. The population is whoever has such a task.',
    output: '{ rows: WorklistRow[]; count: number; overdue_count: number }',
  },
  'write.fhir.record.create': {
    kind: 'write.fhir.record.create',
    version: '1.0.0',
    description: 'Writes a record of a declared shape — a resource type the engine allows (Goal, CarePlan, Encounter, DocumentReference, Consent) with exactly the fields the manifest declares, each typed and mapped to an element path; any element outside the declared fields and the platform stamps is refused. Status, subject, author and dates are stamped by the dispatcher; the write leaves a Provenance. Runs only through an action.',
    output: 'the stored resource',
  },
  'write.fhir.media.create': {
    kind: 'write.fhir.media.create',
    version: '1.0.0',
    description: "Records a photo of the patient in context: the image goes to the platform's media store (encrypted, never public), the record gets a Media resource — what it documents (a kind from the manifest's list), body site, when it was taken, who took it, size and hash, and a storage URL that reads back as a short-lived link. Runs only through an action.",
    output: 'Media (as stored, the image as a link the panel can load)',
  },
  'write.fhir.task.create': {
    kind: 'write.fhir.task.create',
    version: '1.0.0',
    description: 'Puts a task on the list for the patient in context: a code from the ones the manifest allows, a priority the form offers, a due date, a description; stamps status requested, intent, requester, authoredOn and provenance. Runs only through an action.',
    output: 'Task (as stored, with id and provenance)',
  },
  'write.fhir.task.update_status': {
    kind: 'write.fhir.task.update_status',
    version: '1.0.0',
    description: "Moves a task on — in progress, completed, cancelled — within an allowed set, version-aware; the person doing it becomes its owner, completion is timed; leaves a Provenance. Runs only through an action.",
    output: 'Task (as updated)',
  },
  'write.fhir.condition.update_status': {
    kind: 'write.fhir.condition.update_status',
    version: '1.0.0',
    description: "Changes a problem's clinical status within an allowed set (e.g. active → resolved), version-aware, on the patient in context only; leaves a Provenance. Runs only through an action.",
    output: 'Condition (as updated)',
  },
  'write.fhir.medication_request.update_status': {
    kind: 'write.fhir.medication_request.update_status',
    version: '1.0.0',
    description: "Changes a prescription's status within an allowed set (e.g. active → stopped) with an optional reason, version-aware, on the patient in context only; never prescribes. Runs only through an action.",
    output: 'MedicationRequest (as updated)',
  },
};

export function isWritePrimitiveKind(kind: string): boolean {
  return kind.startsWith('write.');
}

export function isDataPrimitiveKind(kind: string): kind is DataPrimitiveKind {
  return kind in DATA_CATALOG;
}

export function parsePrimitiveConfig<K extends DataPrimitiveKind>(kind: K, primitiveId: string, config: unknown): PrimitiveConfig<K> {
  const schema = PRIMITIVE_CONFIG_SCHEMAS[kind];
  const result = schema.safeParse(config);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new PrimitiveConfigError(primitiveId, detail);
  }
  return result.data as PrimitiveConfig<K>;
}

/**
 * Client-side mirror of the dispatcher's scope enforcement. The server check is the one
 * that matters; this one exists so a refusal is explained in the UI before a request leaves.
 */
export function assertScopeAllows(kind: string, primitiveId: string, config: Record<string, unknown>, scope: EffectiveScope): void {
  if (!isDataPrimitiveKind(kind)) throw new UnknownPrimitiveError(kind);
  const need = (resource: string, op: 'read' | 'search' | 'create' | 'update') => {
    if (!isFhirResourceInScope(scope, resource, op)) throw new ScopeViolationError(primitiveId, `${resource}.${op}`);
  };
  switch (kind) {
    case 'data.fhir.patient.read':
      need('Patient', 'read');
      break;
    case 'data.fhir.observation.by_code':
      need('Observation', 'search');
      break;
    case 'data.fhir.query':
      need(String(config['resource']), 'search');
      break;
    case 'data.dicom.studies.for_patient':
      if (!isDicomOperationInScope(scope, 'qido')) throw new ScopeViolationError(primitiveId, 'dicom.qido');
      break;
    case 'data.cohort.by_condition':
      need('Condition', 'search');
      need('Patient', 'read');
      if (scope.patient_scope === 'individual') throw new ScopeViolationError(primitiveId, 'patient_scope: cohort');
      break;
    case 'data.cohort.latest_observation':
      need('Observation', 'search');
      break;
    case 'data.cohort.with_imaging':
      // Granted both ways so the same app runs where the studies live: the PACS (QIDO) or the record's ImagingStudy.
      need('ImagingStudy', 'search');
      if (!isDicomOperationInScope(scope, 'qido')) throw new ScopeViolationError(primitiveId, 'dicom.qido');
      if (scope.patient_scope === 'individual') throw new ScopeViolationError(primitiveId, 'patient_scope: cohort');
      break;
    case 'data.fhir.questionnaire.read':
      need('Questionnaire', 'read');
      break;
    case 'write.fhir.questionnaire_response.submit':
      need('QuestionnaireResponse', 'create');
      if (Array.isArray((config as { extract?: unknown }).extract) && ((config as { extract: unknown[] }).extract.length ?? 0) > 0) need('Observation', 'create');
      break;
    case 'write.fhir.observation.create':
      need('Observation', 'create');
      break;
    case 'write.fhir.condition.create':
      need('Condition', 'create');
      break;
    case 'write.fhir.allergy_intolerance.create':
      need('AllergyIntolerance', 'create');
      break;
    case 'write.fhir.procedure.create':
      need('Procedure', 'create');
      break;
    case 'data.task.worklist':
      need('Task', 'search');
      need('Patient', 'read');
      if (scope.patient_scope === 'individual') throw new ScopeViolationError(primitiveId, 'patient_scope: cohort');
      break;
    case 'data.cohort.assessment_due':
      need('QuestionnaireResponse', 'search');
      need('Patient', 'read');
      if (scope.patient_scope === 'individual') throw new ScopeViolationError(primitiveId, 'patient_scope: cohort');
      break;
    case 'data.fhir.questionnaire_response.answers':
      need('QuestionnaireResponse', 'search');
      need('Questionnaire', 'read');
      break;
    case 'write.fhir.media.create':
      need('Media', 'create');
      break;
    case 'write.fhir.record.create': {
      // The resource comes from the config: the scope must grant its creation for the patient in context.
      const resource = (config as { resource?: unknown }).resource;
      if (typeof resource !== 'string') throw new PrimitiveConfigError(primitiveId, "config.resource must name the resource type");
      need(resource, 'create');
      break;
    }
    case 'write.fhir.task.create':
      need('Task', 'create');
      break;
    case 'write.fhir.task.update_status':
      need('Task', 'update');
      break;
    case 'write.fhir.condition.update_status':
      need('Condition', 'update');
      break;
    case 'write.fhir.medication_request.update_status':
      need('MedicationRequest', 'update');
      break;
  }
}

/** `now-2y`, `now-90d`, `now-6m` → ISO date; ISO strings pass through. */
export function resolveDateExpression(value: string | undefined, now = new Date()): string | undefined {
  if (!value) return undefined;
  const m = /^now(?:-(\d+)([dmy]))?$/.exec(value.trim());
  if (!m) return value;
  const d = new Date(now);
  const n = Number(m[1] ?? 0);
  if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - n);
  if (m[2] === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  if (m[2] === 'y') d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString();
}
