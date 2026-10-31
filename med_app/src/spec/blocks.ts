import type { ActionDecl, ContextInput, FhirScopeEntry, LayoutNode, PhiField } from '../manifest/schema';
import { PHI_FIELDS } from '../manifest/schema';
import { DATA_CATALOG, type DataPrimitiveKind, type QueryResource } from '../primitives/data/dataCatalog';
import type { RecordEntryRules } from '../primitives/data/recordShape';
import type { BlockPrimitive } from './archetype';
import type { Code } from './common';
import type { ExtractRule } from './forms';
import { qualified } from './terminology';

/**
 * The block library: the recurring pieces archetypes are assembled from. A data block returns
 * the primitive declaration together with the FHIR access it needs, so a role's data scope is
 * *derived* from what its part of the app requests — never typed in by an author.
 */

/** The references every single-patient app uses. Fixed names: the launch context supplies them. */
export const REF = Object.freeze({
  patient: '$context.patient_id',
  window: '$context.window_start',
});

const SUBJECT_FILTER = 'subject={context.patient_id}';
/** AllergyIntolerance names its person `patient`, not `subject`. */
const PATIENT_FILTER = 'patient={context.patient_id}';
const SUBJECT_WINDOW_FILTER = 'subject={context.patient_id}&date=ge{context.window_start}';

const version = (kind: DataPrimitiveKind): string => DATA_CATALOG[kind].version;

/** Drop undefined values so emitted manifests carry no `key: undefined` noise. */
export function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// ── data blocks ─────────────────────────────────────────────────────────────

export function patientRead(): BlockPrimitive {
  return {
    decl: { id: 'p_patient', kind: 'data.fhir.patient.read', catalog_version: version('data.fhir.patient.read'), config: { patient: REF.patient }, output_binding: 'patient' },
    fhir: [{ resource: 'Patient', operations: ['read'] }],
  };
}

export interface ObservationsByCodeOpts {
  readonly id: string;
  readonly binding: string;
  readonly codes: readonly Code[];
  /** Restrict to the launch window (`$context.window_start`). */
  readonly windowed: boolean;
  readonly count: number;
  readonly only_for_roles?: readonly string[];
}

export function observationsByCode(o: ObservationsByCodeOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: clean({
      id: o.id,
      kind: 'data.fhir.observation.by_code',
      catalog_version: version('data.fhir.observation.by_code'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ patient: REF.patient, codes, since: o.windowed ? REF.window : undefined, count: o.count }),
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Observation', operations: ['search'], codes, filter: o.windowed ? SUBJECT_WINDOW_FILTER : SUBJECT_FILTER }],
  };
}

export interface FhirQueryOpts {
  readonly id: string;
  readonly binding: string;
  readonly resource: QueryResource;
  /** Search parameters; `patient: REF.patient` scopes the query to the launch patient. */
  readonly params: Readonly<Record<string, string>>;
  readonly only_for_roles?: readonly string[];
}

export function fhirQuery(o: FhirQueryOpts): BlockPrimitive {
  const perPatient = o.params['patient'] === REF.patient || o.params['subject'] === REF.patient;
  return {
    decl: clean({
      id: o.id,
      kind: 'data.fhir.query',
      catalog_version: version('data.fhir.query'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { resource: o.resource, params: { ...o.params } },
      output_binding: o.binding,
    }),
    fhir: [clean({ resource: o.resource, operations: ['search'], filter: perPatient ? SUBJECT_FILTER : undefined })],
  };
}

export interface CohortByConditionOpts {
  readonly codes: readonly Code[];
  readonly clinical_status?: string | undefined;
}

export function cohortByCondition(o: CohortByConditionOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: {
      id: 'p_cohort',
      kind: 'data.cohort.by_condition',
      catalog_version: version('data.cohort.by_condition'),
      config: clean({ condition_codes: codes, clinical_status: o.clinical_status }),
      output_binding: 'cohort',
    },
    // Membership reads the patients it finds and searches their conditions.
    fhir: [
      { resource: 'Patient', operations: ['read'] },
      { resource: 'Condition', operations: ['search'], codes },
    ],
  };
}

export interface CohortWithImagingOpts {
  /** DICOM modality codes a study must carry (CT, MR, …); empty: any study. */
  readonly modalities: readonly string[];
  /** Only studies started from this date (`now-2y`, ISO); omitted: ever. */
  readonly since?: string | undefined;
  readonly min_studies?: number | undefined;
}

/**
 * The cohort narrowed to the members with imaging — the doctor's "patients with this diagnosis who have had a CT".
 * Studies come from the PACS by QIDO where one is configured and from the record's ImagingStudy otherwise, so the
 * block grants both: a search on ImagingStudy and a DICOM query, kept to the modalities — a cohort query, never a
 * retrieve (no `wado`: the register names studies, the imaging app opens them).
 */
export function cohortWithImaging(o: CohortWithImagingOpts): BlockPrimitive {
  const modalities = o.modalities.length ? [...o.modalities] : undefined;
  return {
    decl: {
      id: 'p_imaging',
      kind: 'data.cohort.with_imaging',
      catalog_version: version('data.cohort.with_imaging'),
      config: clean({ patients: '$bindings.cohort.patients', modalities, since: o.since, min_studies: o.min_studies }),
      output_binding: 'imaging',
    },
    fhir: [{ resource: 'ImagingStudy', operations: ['search'] }],
    dicom: [clean({ operations: ['qido'], modalities })],
  };
}

export interface CohortLatestOpts {
  /** The members whose latest value is read; the condition cohort unless an imaging step narrowed it first. */
  readonly patients?: string | undefined;
  readonly codes: readonly Code[];
  /** The panel component that is each member's compared value (`compared` on the rows) — for a range filter without a threshold. */
  readonly component_code?: string | undefined;
  readonly threshold?: { readonly component_code?: string | undefined; readonly value: number } | undefined;
}

export function cohortLatestObservation(o: CohortLatestOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: {
      id: 'p_latest',
      kind: 'data.cohort.latest_observation',
      catalog_version: version('data.cohort.latest_observation'),
      config: clean({
        patients: o.patients ?? '$bindings.cohort.patients',
        codes,
        component_code: o.component_code,
        threshold: o.threshold ? clean({ component_code: o.threshold.component_code, value: o.threshold.value }) : undefined,
      }),
      output_binding: 'latest',
    },
    fhir: [{ resource: 'Observation', operations: ['search'], codes }],
  };
}

export interface QuestionnaireReadOpts {
  /** Canonical URL of the Questionnaire on the record. */
  readonly url: string;
  /** Primitive id and output binding; the defaults suit an app with one form. */
  readonly id?: string;
  readonly binding?: string;
  readonly only_for_roles?: readonly string[];
}

/** The form definition, fetched from the record — the app never carries a form of its own. */
export function questionnaireRead(o: QuestionnaireReadOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id ?? 'p_questionnaire',
      kind: 'data.fhir.questionnaire.read',
      catalog_version: version('data.fhir.questionnaire.read'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { questionnaire: o.url },
      output_binding: o.binding ?? 'questionnaire',
    }),
    fhir: [{ resource: 'Questionnaire', operations: ['read'] }],
  };
}

/** Every write leaves a Provenance beside the record it creates or changes; the role needs the grant for that. */
export const PROVENANCE_SCOPE: FhirScopeEntry = { resource: 'Provenance', operations: ['create'] };

export interface QuestionnaireResponseSubmitOpts {
  readonly url: string;
  /** The `$ui` key the form writes its answers to. */
  readonly stateKey: string;
  readonly id?: string;
  readonly binding?: string;
  readonly only_for_roles?: readonly string[];
  /** Answers also written as Observations (a form designed in the spec with `as_observation` items); the role then needs Observation.create too. */
  readonly extract?: readonly ExtractRule[];
}

/**
 * The write: a completed QuestionnaireResponse into the record. Declared like any primitive, but the
 * renderer runs it only through the action that names it — never at load (see actionFor).
 */
export function questionnaireResponseSubmit(o: QuestionnaireResponseSubmitOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id ?? 'p_submit',
      kind: 'write.fhir.questionnaire_response.submit',
      catalog_version: version('write.fhir.questionnaire_response.submit'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ questionnaire: o.url, subject: REF.patient, extract: o.extract?.length ? o.extract.map((r) => clean({ ...r })) : undefined, response: `$ui.${o.stateKey}` }),
      output_binding: o.binding ?? 'submitted',
    }),
    fhir: [
      { resource: 'QuestionnaireResponse', operations: ['create'], filter: SUBJECT_FILTER },
      ...(o.extract?.length ? [{ resource: 'Observation', operations: ['create'], codes: o.extract.map((r) => r.code), filter: SUBJECT_FILTER } satisfies FhirScopeEntry] : []),
      PROVENANCE_SCOPE,
    ],
  };
}

export interface ObservationCreateOpts {
  readonly id: string;
  readonly binding: string;
  /** The Observation code(s) the form may record — one for a single value, the panel code for a panel. */
  readonly codes: readonly Code[];
  /** Component codes a panel must carry (systolic and diastolic for blood pressure). */
  readonly components?: readonly Code[];
  readonly unit: string;
  readonly category: string;
  /** Plausibility range per code (qualified). */
  readonly ranges: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>;
  /** Relations between components (qualified codes): `component` must be above `above`. */
  readonly rules?: readonly { readonly component: string; readonly above: string; readonly message?: string }[];
  /** Whether the form asks which side of the body (left, right, both → Observation.bodySite, SNOMED laterality); absent: no side is recorded. */
  readonly side?: 'optional' | 'required';
  /** The structure measured, stamped into bodySite beside the side. */
  readonly body_site?: Code;
  /** Test conditions the form offers one of (→ Observation.method). */
  readonly conditions?: readonly Code[];
  readonly max_backdate_days: number;
  /** The `$ui` key the entry form writes its Observation to. */
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

/**
 * Record a measurement. The scope it needs is `Observation.create` for exactly these codes — the
 * dispatcher refuses any other code — plus the Provenance every write leaves.
 */
export function observationCreate(o: ObservationCreateOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  const components = o.components?.length ? o.components.map(qualified) : undefined;
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.observation.create',
      catalog_version: version('write.fhir.observation.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({
        subject: REF.patient,
        codes,
        components,
        unit: o.unit,
        category: o.category,
        ranges: Object.keys(o.ranges).length ? { ...o.ranges } : undefined,
        rules: o.rules?.length ? o.rules.map((r) => clean({ ...r })) : undefined,
        max_backdate_days: o.max_backdate_days,
        side: o.side,
        body_site: o.body_site ? qualified(o.body_site) : undefined,
        conditions: o.conditions?.length ? o.conditions.map(qualified) : undefined,
        observation: `$ui.${o.stateKey}`,
      }),
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Observation', operations: ['create'], codes: [...codes, ...(components ?? [])], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

/** What the three coded-entry blocks share: the codes the form may record, the `$ui` key its payload arrives under. */
interface CodedEntryOpts {
  readonly id: string;
  readonly binding: string;
  readonly codes: readonly Code[];
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

export interface ConditionCreateOpts extends CodedEntryOpts {
  readonly verification: readonly string[];
  readonly category: 'problem-list-item' | 'encounter-diagnosis';
  readonly severity: boolean;
}

/**
 * Add a diagnosis to the problem list. The scope it needs is `Condition.create` plus the Provenance every write
 * leaves; which codes may be added is the primitive's own rule (the dispatcher refuses any other), not a `codes`
 * filter on the scope entry — that would read as a restriction on the problem list's search, which shares the
 * entry. The new problem is always active; its status is changed later through the list's own action, never here.
 */
export function conditionCreate(o: ConditionCreateOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.condition.create',
      catalog_version: version('write.fhir.condition.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, codes, verification: [...o.verification], category: o.category, severity: o.severity, condition: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Condition', operations: ['create'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface AllergyCreateOpts extends CodedEntryOpts {
  readonly types: readonly string[];
  readonly categories: readonly string[];
  readonly verification: readonly string[];
  readonly criticality: boolean;
  readonly reaction: boolean;
}

/** Record an allergy or intolerance to one of the listed substances — `AllergyIntolerance.create`; the codes are the primitive's rule. */
export function allergyIntoleranceCreate(o: AllergyCreateOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.allergy_intolerance.create',
      catalog_version: version('write.fhir.allergy_intolerance.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, codes, types: [...o.types], categories: [...o.categories], verification: [...o.verification], criticality: o.criticality, reaction: o.reaction, allergy: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'AllergyIntolerance', operations: ['create'], filter: PATIENT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface ProcedureCreateOpts extends CodedEntryOpts {
  readonly statuses: readonly string[];
  readonly max_backdate_days: number;
  readonly body_site: boolean;
  readonly outcome: boolean;
}

/** Record a procedure performed — `Procedure.create`, the codes the primitive's rule, dated within the window. */
export function procedureCreate(o: ProcedureCreateOpts): BlockPrimitive {
  const codes = o.codes.map(qualified);
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.procedure.create',
      catalog_version: version('write.fhir.procedure.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, codes, statuses: [...o.statuses], max_backdate_days: o.max_backdate_days, body_site: o.body_site, outcome: o.outcome, procedure: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Procedure', operations: ['create'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

// ── tasks ───────────────────────────────────────────────────────────────────

/** The code system every app-made Task carries: the author's own task vocabulary, as `src/primitives/data/mock/seed.ts` TASK_SYSTEM. */
export const TASK_SYSTEM = 'urn:medapp:task';

export interface TaskCode {
  readonly code: string;
  readonly display: string;
}

export const qualifiedTask = (c: TaskCode): string => `${TASK_SYSTEM}|${c.code}`;

export interface TaskWorklistOpts {
  readonly id?: string;
  readonly binding?: string;
  /** The task kinds the list is about; empty = every task. */
  readonly codes: readonly TaskCode[];
  readonly statuses: readonly string[];
  readonly only_for_roles?: readonly string[];
}

/** The open tasks across patients, with the patient each is for — a cohort read: Task search plus one Patient read per member. */
export function taskWorklist(o: TaskWorklistOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id ?? 'p_worklist',
      kind: 'data.task.worklist',
      catalog_version: version('data.task.worklist'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ codes: o.codes.length ? o.codes.map(qualifiedTask) : undefined, statuses: [...o.statuses] }),
      output_binding: o.binding ?? 'worklist',
    }),
    fhir: [
      { resource: 'Patient', operations: ['read'] },
      { resource: 'Task', operations: ['search'] },
    ],
  };
}

export interface FormAnswersOpts {
  readonly id: string;
  readonly binding: string;
  readonly questionnaire: string;
  readonly link_ids: readonly string[];
  readonly only_for_roles?: readonly string[];
}

/** A form's numeric answers over time as derived Observations — a read of the patient's responses to one Questionnaire (and the form, for texts and units). */
export function formAnswers(o: FormAnswersOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'data.fhir.questionnaire_response.answers',
      catalog_version: version('data.fhir.questionnaire_response.answers'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { patient: REF.patient, questionnaire: o.questionnaire, link_ids: [...o.link_ids] },
      output_binding: o.binding,
    }),
    fhir: [
      { resource: 'QuestionnaireResponse', operations: ['search'], filter: SUBJECT_FILTER },
      { resource: 'Questionnaire', operations: ['read'] },
    ],
  };
}

export interface AssessmentDueOpts {
  readonly questionnaire: string;
  readonly every_days: number;
  /** The cohort binding whose members are checked; omitted = everyone assessed before. */
  readonly patients?: string | undefined;
  readonly upcoming_days: number;
}

/** Who is due an assessment — a cohort read: QuestionnaireResponse search for the questionnaire, one Patient read per member. */
export function assessmentDue(o: AssessmentDueOpts): BlockPrimitive {
  return {
    decl: {
      id: 'p_due',
      kind: 'data.cohort.assessment_due',
      catalog_version: version('data.cohort.assessment_due'),
      config: clean({ questionnaire: o.questionnaire, every_days: o.every_days, patients: o.patients, upcoming_days: o.upcoming_days || undefined }),
      output_binding: 'due',
    },
    fhir: [
      { resource: 'Patient', operations: ['read'] },
      { resource: 'QuestionnaireResponse', operations: ['search'], filter: `questionnaire=${o.questionnaire}` },
    ],
  };
}

export const PHOTO_SYSTEM = 'urn:medapp:photo';

export interface MediaCreateOpts {
  readonly id: string;
  readonly binding: string;
  /** What a photo may document — the ward's own words. */
  readonly kinds: readonly TaskCode[];
  readonly body_site: boolean;
  readonly max_bytes: number;
  readonly max_backdate_days: number;
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

/** Record a photo of the patient in context — `Media.create`; the image goes to the platform's store, the record keeps the Media. */
export function mediaCreate(o: MediaCreateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.media.create',
      catalog_version: version('write.fhir.media.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, kinds: o.kinds.map((k) => `${PHOTO_SYSTEM}|${k.code}`), body_site: o.body_site, max_bytes: o.max_bytes, max_backdate_days: o.max_backdate_days, media: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Media', operations: ['create'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface RecordCreateOpts {
  readonly id: string;
  readonly binding: string;
  /** The runtime rules of the shape: resource, fields with their encodings, stamps (spec/record.ts `recordRules`). */
  readonly rules: RecordEntryRules;
  /** When the rules came from a library shape: which one, pinned by its checksum and version, and the `meta.tag` the executors stamp on every record written with it. */
  readonly shape?: { readonly id: string; readonly checksum: string; readonly version?: string; readonly open_kind?: boolean; readonly tag: { readonly system: string; readonly code: string; readonly version: string; readonly display: string } } | undefined;
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

/**
 * Write a record of a declared shape — any resource type the engine allows, with the fields the author declared and
 * nothing else. The scope it needs is `<resource>.create` for the patient in context, plus the Provenance every write
 * leaves; the dispatcher validates the payload against the same rules the form used and applies the stamps.
 */
export function recordCreate(o: RecordCreateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.record.create',
      catalog_version: version('write.fhir.record.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ subject: REF.patient, resource: o.rules.resource, fields: o.rules.fields.map((f) => ({ ...f })), stamps: (o.rules.stamps ?? []).map((st) => ({ ...st })), shape: o.shape ? clean({ ...o.shape, tag: { ...o.shape.tag } }) : undefined, record: `$ui.${o.stateKey}` }),
      output_binding: o.binding,
    }),
    fhir: [{ resource: o.rules.resource, operations: ['create'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface TaskCreateOpts {
  readonly id: string;
  readonly binding: string;
  readonly codes: readonly TaskCode[];
  readonly priorities: readonly string[];
  readonly due: boolean;
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

/** Put a task on the list for the patient in context — `Task.create`; which kinds is the primitive's own rule. */
export function taskCreate(o: TaskCreateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.task.create',
      catalog_version: version('write.fhir.task.create'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, codes: o.codes.map(qualifiedTask), priorities: [...o.priorities], due: o.due, task: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Task', operations: ['create'], filter: PATIENT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface TaskStatusUpdateOpts {
  readonly id: string;
  readonly binding: string;
  readonly allowed: readonly string[];
  readonly stateKey: string;
  /** False on a worklist: there is no patient in context, the task's own patient is the one in question. */
  readonly perPatient: boolean;
  readonly only_for_roles?: readonly string[];
}

/** Start, complete or cancel a task — one field, an allowed set; whoever does it owns the task. */
export function taskStatusUpdate(o: TaskStatusUpdateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.task.update_status',
      catalog_version: version('write.fhir.task.update_status'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ subject: o.perPatient ? REF.patient : undefined, allowed: [...o.allowed], change: `$ui.${o.stateKey}` }),
      output_binding: o.binding,
    }),
    fhir: [clean({ resource: 'Task', operations: ['update'], filter: o.perPatient ? PATIENT_FILTER : undefined }), PROVENANCE_SCOPE],
  };
}

export interface StatusUpdateOpts {
  readonly id: string;
  readonly binding: string;
  /** Target statuses the app may set. */
  readonly allowed: readonly string[];
  /** The `$ui` key the list's row action writes its change to. */
  readonly stateKey: string;
  readonly only_for_roles?: readonly string[];
}

/** Mark a problem resolved (or inactive, or active again): a versioned update of one field on the patient's own record. */
export function conditionStatusUpdate(o: StatusUpdateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.condition.update_status',
      catalog_version: version('write.fhir.condition.update_status'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, allowed: [...o.allowed], change: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'Condition', operations: ['update'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

/** Stop, complete or hold a prescription — never prescribe. */
export function medicationStatusUpdate(o: StatusUpdateOpts): BlockPrimitive {
  return {
    decl: clean({
      id: o.id,
      kind: 'write.fhir.medication_request.update_status',
      catalog_version: version('write.fhir.medication_request.update_status'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: { subject: REF.patient, allowed: [...o.allowed], change: `$ui.${o.stateKey}` },
      output_binding: o.binding,
    }),
    fhir: [{ resource: 'MedicationRequest', operations: ['update'], filter: SUBJECT_FILTER }, PROVENANCE_SCOPE],
  };
}

export interface SubmitActionOpts {
  readonly id: string;
  readonly label: string;
  readonly primitive: string;
  readonly success_message?: string | undefined;
  readonly confirm?: string | undefined;
}

/** The user intent that runs a write primitive; the data plan reloads afterwards so the new record shows. */
export function submitAction(o: SubmitActionOpts): ActionDecl {
  return clean({ id: o.id, label: o.label, primitive: o.primitive, on_success: 'reload' as const, confirm: o.confirm, success_message: o.success_message });
}

export interface DicomStudiesOpts {
  /** DICOM modality codes (CT, MR, …); empty = every modality. */
  readonly modalities: readonly string[];
  readonly id?: string;
  readonly binding?: string;
  readonly only_for_roles?: readonly string[];
}

/**
 * The patient's imaging studies (QIDO-RS through the dispatcher). Its access is a DICOM scope entry,
 * not a FHIR one: query and retrieve, the same modalities, studies of the patient in context only.
 */
export function dicomStudies(o: DicomStudiesOpts): BlockPrimitive {
  const modalities = o.modalities.length ? [...o.modalities] : undefined;
  return {
    decl: clean({
      id: o.id ?? 'p_studies',
      kind: 'data.dicom.studies.for_patient',
      catalog_version: version('data.dicom.studies.for_patient'),
      only_for_roles: o.only_for_roles ? [...o.only_for_roles] : undefined,
      config: clean({ patient: REF.patient, modalities }),
      output_binding: o.binding ?? 'studies',
    }),
    fhir: [],
    dicom: [clean({ operations: ['qido', 'wado'], modalities, study_filter: 'PatientID={context.patient_mrn}' })],
  };
}

// ── layout blocks ───────────────────────────────────────────────────────────

export function node(component: string, props?: Record<string, unknown>, children?: readonly LayoutNode[], show_only_if_role_in?: readonly string[]): LayoutNode {
  return clean({
    component,
    props: props ? clean(props) : undefined,
    children: children && children.length ? [...children] : undefined,
    show_only_if_role_in: show_only_if_role_in ? [...show_only_if_role_in] : undefined,
  });
}

/** Every app's root: the manifest's own name and description as title and subtitle. */
export function pageShell(children: readonly LayoutNode[]): LayoutNode {
  return node('PageShell', { title: '$metadata.name', subtitle: '$metadata.description' }, children);
}
/** Who the patient is: Medplum's stock header (full PHI) or the masking banner driven by the role's scope. */
export function patientIdentity(kind: 'header' | 'banner', opts: { readonly compact?: boolean } = {}): LayoutNode {
  if (kind === 'header') return node('PatientHeader', { patient: '$bindings.patient' });
  return node('PatientBanner', { patient: '$bindings.patient', visible_fields: '$auth.effective.phi_fields_visible', compact: opts.compact ? true : undefined });
}

export function patientContextInput(): ContextInput {
  return { name: 'patient_id', type: 'fhir.reference', required: true, source: ['smart_launch', 'panel_selection'] };
}

export function windowContextInput(defaultWindow: string): ContextInput {
  return { name: 'window_start', type: 'iso8601', required: false, source: ['panel_selection'], default: defaultWindow };
}

// ── text helpers (deterministic wording for defaults and summaries) ─────────

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** `now-2y` → "Last two years", `now-1y` → "Last year", `now-6m` → "Last six months", `now-90d` → "Last 90 days", ISO date → "Since 2025-01-01". */
export function describeWindow(window: string): string {
  const m = /^now-(\d+)([dmy])$/.exec(window);
  if (!m) return window === 'now' ? 'Today' : `Since ${window}`;
  const n = Number(m[1]);
  const unit = m[2] === 'd' ? 'day' : m[2] === 'm' ? 'month' : 'year';
  if (n === 1) return `Last ${unit}`;
  const count = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return `Last ${count} ${unit}s`;
}

const PHI_LABELS: Record<PhiField, string> = {
  name: 'Name',
  dob: 'date of birth',
  gender: 'sex',
  mrn: 'MRN',
  address: 'address',
  phone: 'phone',
  email: 'email',
};
const CONTACT_FIELDS: readonly PhiField[] = ['address', 'phone', 'email'];

function joinNatural(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Fields in the canonical PHI order, so specs may list them in any order. */
export function orderPhi(fields: readonly PhiField[]): PhiField[] {
  return PHI_FIELDS.filter((f) => fields.includes(f));
}

/** `[name, dob, mrn]` → "Name, date of birth and MRN visible; no contact details". */
export function describePhi(fields: readonly PhiField[]): string {
  const ordered = orderPhi(fields);
  const identity = ordered.filter((f) => !CONTACT_FIELDS.includes(f)).map((f) => PHI_LABELS[f]);
  const contact = ordered.filter((f) => CONTACT_FIELDS.includes(f)).map((f) => PHI_LABELS[f]);
  const first = identity.length ? `${joinNatural(identity)} visible` : 'No identity fields visible';
  const second = contact.length ? `${joinNatural(contact)} visible` : 'no contact details';
  return `${first}; ${second}`;
}

/** Scope entries per resource, merged: operations and codes are unioned, the first filter wins. */
export function mergeScopeEntries(entries: readonly FhirScopeEntry[]): FhirScopeEntry[] {
  const out: FhirScopeEntry[] = [];
  for (const e of entries) {
    const existing = out.find((x) => x.resource === e.resource);
    if (!existing) {
      out.push(clean({ resource: e.resource, operations: [...e.operations], codes: e.codes ? [...e.codes] : undefined, filter: e.filter }));
      continue;
    }
    for (const op of e.operations) if (!existing.operations.includes(op)) existing.operations.push(op);
    if (e.codes) {
      const codes = existing.codes ? [...existing.codes] : [];
      for (const c of e.codes) if (!codes.includes(c)) codes.push(c);
      existing.codes = codes;
    }
    if (!existing.filter && e.filter) existing.filter = e.filter;
  }
  return out;
}
