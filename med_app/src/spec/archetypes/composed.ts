import { z } from 'zod';
import type { QuestionnaireArtifact } from '../../manifest/artifacts';
import type { ActionDecl, LayoutNode } from '../../manifest/schema';
import { PHI_FIELDS } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildContext, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, identifier, type Code, type SpecIssue } from '../common';
import { FormSchema, compileForm, formExtraction, formIssues, questionnaireCanonical } from '../forms';
import { RECORD_RESOURCES, RecordFieldSchema, RecordStatusSchema, checkRecordSection, recordRules } from '../record';
import { recordShapeTag } from '../shapes';
import {
  REF,
  allergyIntoleranceCreate,
  clean,
  conditionCreate,
  conditionStatusUpdate,
  describeWindow,
  dicomStudies,
  fhirQuery,
  formAnswers,
  mediaCreate,
  medicationStatusUpdate,
  node,
  observationCreate,
  procedureCreate,
  observationsByCode,
  patientContextInput,
  patientIdentity,
  patientRead,
  questionnaireRead,
  questionnaireResponseSubmit,
  PHOTO_SYSTEM,
  recordCreate,
  submitAction,
  TASK_SYSTEM,
  taskCreate,
  taskStatusUpdate,
  windowContextInput,
} from '../blocks';
import { qualified, systemUrl } from '../terminology';
import { QUERY_RESOURCES, type QueryResource } from '../../primitives/data/dataCatalog';
import { MODALITY } from './imaging';
import { QUERYABLE } from './inspector';
import { TASK_STATUSES, TaskCodeSchema } from './worklist';
import { SeriesSchema } from './trend';

/**
 * APP-12 · Composed page — one patient, the page the clinician describes rather than the nearest
 * template: an ordered list of sections, each one of the blocks the named archetypes are built from
 * (a trend chart, a readings table, problems, medication, imaging, an assessment form, a resource
 * view, headline counts). Stacked sections share a row while their widths fit; or every section is a
 * tab. A section may be gated to roles: only they see it and only they issue its data requests, so
 * each role's scope is derived from its part of the page exactly as in the named archetypes.
 *
 * What can be composed is still the closed catalog — the section kinds below are the whole
 * vocabulary, and each one is the block a named archetype already verifies.
 */

const RATIO = z.tuple([z.number().int().min(1).max(11), z.number().int().min(1).max(11)]);

/** Resource types a generic list may show — the query allow-list minus the definitional Questionnaire. */
export const LIST_RESOURCES = QUERY_RESOURCES.filter((r) => r !== 'Questionnaire') as [string, ...string[]];

const RangeSchema = z.strictObject({ min: z.number().optional(), max: z.number().optional() }).refine((r) => r.min === undefined || r.max === undefined || r.min < r.max, { message: 'min must be below max' });

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?)*$/;
const ColumnSchema = z.strictObject({
  label: z.string().min(1),
  path: z.string().regex(FIELD_PATH, 'a field path such as code, performedDateTime or reaction[0].manifestation'),
  status: z.boolean().optional().describe('Render the value as a status badge'),
});

/** What every section carries besides its own settings. */
const common = {
  id: identifier.optional().describe('Names the section in the data plan (its primitive is p_<id>, its binding <id>); defaults to the kind, numbered when a kind repeats'),
  label: z.string().min(1).optional().describe('Tab label when the page is arranged as tabs; defaults to the kind'),
  span: z.literal([4, 6, 8, 12]).default(12).describe('Width out of 12 when stacked: consecutive sections share a row while their widths fit (8 + 4, 6 + 6, 4 + 4 + 4); a role-gated section always takes a whole row'),
  roles: z.array(identifier).min(1).optional().describe('Only these roles see the section — and only they issue its data requests; omit for everyone'),
};

export const SectionSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('trend'),
      ...common,
      codes: z.array(CodeSchema).min(1).describe('Observation codes requested from the record (the panel or the single-value codes)'),
      series: z.array(SeriesSchema).min(1).describe('What is plotted, in legend order'),
      thresholds: z.array(z.strictObject({ value: z.number(), label: z.string().min(1) })).default([]).describe('Horizontal reference lines — visual only'),
      thresholds_source: z.string().min(1).max(200).optional().describe('Where the reference lines come from (guideline and value), shown under the chart'),
      unit: z.string().min(1).optional().describe('Axis unit label, e.g. mmHg'),
      title: z.string().min(1).optional().describe('Defaults to the series labels and the window'),
      height_px: z.number().int().min(160).max(800).default(320),
      max_observations: z.number().int().positive().max(1000).default(500),
      by_side: z.boolean().default(false).describe('Plot each series once per side of the body (left, right, both — read from Observation.bodySite), so a side comparison is one chart: knee flexion left against right'),
      compare: z.boolean().default(false).describe('Under the chart, a table of the first and the latest value of each series (and side) with their dates and the difference between them — "first finding against today", the two numbers as recorded, nothing graded'),
    })
    .describe('A chart of observations over time against reference lines'),
  z
    .strictObject({
      kind: z.literal('form_trend'),
      ...common,
      questionnaire: z.string().min(1).optional().describe('Canonical URL of the form whose answers are charted — the record\'s, or another app\'s; or name a form designed in this spec with `form`'),
      form: identifier.optional().describe('The id of a form designed in this spec (an assessment section\'s `form.id`): its answers are charted'),
      questions: z
        .array(z.strictObject({ link_id: identifier.describe('The question\'s id (its linkId)'), label: z.string().min(1).describe('Legend label') }))
        .min(1)
        .max(4)
        .describe('The numeric questions plotted, in legend order — integers and decimals; other answer types have no value to plot'),
      unit: z.string().min(1).optional().describe('Axis unit label; defaults to the first question\'s unit'),
      thresholds: z.array(z.strictObject({ value: z.number(), label: z.string().min(1) })).default([]).describe('Horizontal reference lines — visual only'),
      thresholds_source: z.string().min(1).max(200).optional().describe('Where the reference lines come from, shown under the chart'),
      title: z.string().min(1).optional().describe('Defaults to the question labels and the window'),
      height_px: z.number().int().min(160).max(800).default(320),
      max_responses: z.number().int().positive().max(1000).default(200),
    })
    .describe("A chart of a form's numeric answers over time — the course of a timed up-and-go across screens, pain scores over a stay — drawn from the patient's responses to one Questionnaire"),
  z
    .strictObject({
      kind: z.literal('latest_answers'),
      ...common,
      questionnaire: z.string().min(1).optional().describe('Canonical URL of the form whose latest response is shown; or name a form designed in this spec with `form`'),
      form: identifier.optional().describe('The id of a form designed in this spec (an assessment section\'s `form.id`)'),
      title: z.string().min(1).optional().describe('Defaults to "Latest answers"'),
    })
    .describe("The patient's most recent response to a form, question by question, with when and by whom — the last falls screen on a patient overview"),
  z
    .strictObject({
      kind: z.literal('readings'),
      ...common,
      codes: z.array(CodeSchema).min(1).describe('Observation codes listed, newest first'),
      title: z.string().min(1).optional().describe('Defaults to the label and the window'),
      rows: z.number().int().positive().max(200).default(20),
      compact: z.boolean().default(true).describe('Dense rows'),
    })
    .describe('A table of observations within the window'),
  z
    .strictObject({
      kind: z.literal('problems'),
      ...common,
      status: z.enum(['active', 'all']).default('active').describe('Active problems only, or the full history'),
      codes: z.array(CodeSchema).optional().describe('Restrict to these diagnosis codes (SNOMED); omit for every problem'),
      title: z.string().min(1).optional().describe('Defaults to "Active problems" / "Problem list"'),
      resolve: z.boolean().default(false).describe('Let the role mark an active problem as resolved (a versioned status update on the record — the app becomes a workflow app)'),
      resolve_label: z.string().min(1).default('Mark resolved'),
    })
    .describe('The problem list, optionally with "mark resolved"'),
  z
    .strictObject({
      kind: z.literal('medication'),
      ...common,
      status: z.enum(['active', 'all']).default('active').describe('Active prescriptions only, or the history'),
      codes: z.array(CodeSchema).optional().describe('Restrict to these medication classes (ATC); omit for every prescription'),
      title: z.string().min(1).optional().describe('Defaults to "Active medication" / "Medication history"'),
      stop: z.boolean().default(false).describe('Let the role stop an active prescription with a reason (a versioned status update; nothing is prescribed — the app becomes a workflow app)'),
      stop_label: z.string().min(1).default('Stop'),
    })
    .describe('The medication list, optionally with "stop"'),
  z
    .strictObject({
      kind: z.literal('imaging'),
      ...common,
      modalities: z.array(MODALITY).min(1).default(['CT', 'MR', 'DX', 'US']).describe('DICOM modalities to list; the role may retrieve only these'),
      list_title: z.string().min(1).default('Available studies'),
      viewer_height_px: z.number().int().min(240).max(1200).default(560),
      ratio: RATIO.default([5, 7]).describe('List vs viewer width, out of 12'),
      layout: z.enum(['stack', 'mpr', 'volume']).default('stack').describe('How a study opens: 2-D stack, reconstructed planes (mpr), or planes plus a 3-D volume rendering (volume)'),
    })
    .describe('The patient’s imaging studies with a viewer for the selected one'),
  z
    .strictObject({
      kind: z.literal('assessment'),
      ...common,
      questionnaire: z
        .string()
        .regex(/^(https?:\/\/|urn:)\S+$/, 'a canonical URL')
        .optional()
        .describe("Canonical URL of a Questionnaire (form definition) the record already holds — one of this deployment's available forms. Either this or `form`"),
      form: FormSchema.optional().describe('A form designed in this conversation, compiled into a Questionnaire the app carries. Either this or `questionnaire`'),
      action_label: z.string().min(1).default('Submit assessment').describe('The submit button'),
      success_message: z.string().min(1).default('The assessment is now part of the patient record.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
      form_title: z.string().min(1).optional().describe("Defaults to the Questionnaire's own title"),
      submissions: z.boolean().default(true).describe('List the earlier submissions beside the form'),
      submissions_title: z.string().min(1).default('Previous assessments'),
      ratio: RATIO.default([7, 5]).describe('Form vs list width, out of 12'),
    })
    .describe('A structured form written to the record through an action — makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('details'),
      ...common,
      resource: z.enum(['Patient', ...QUERYABLE]).describe('The patient record itself, or the most recent resource of this type for the patient'),
      params: z.record(z.string(), z.string()).optional().describe('Extra search parameters for a "most recent" view, e.g. { status: final }'),
      title: z.string().min(1).optional(),
    })
    .describe('One FHIR resource rendered from its schema, references resolved'),
  z
    .strictObject({
      kind: z.literal('counts'),
      ...common,
      problems: z.boolean().default(true).describe('A tile with the number of active problems'),
      medication: z.boolean().default(true).describe('A tile with the number of active prescriptions'),
      readings_codes: z.array(CodeSchema).min(1).optional().describe('Given: a tile with the number of these observations in the window'),
    })
    .describe('Headline tiles — list lengths, no computation'),
  z
    .strictObject({
      kind: z.literal('record_observation'),
      ...common,
      code: CodeSchema.describe('What is recorded — the Observation code (the panel code for a panel such as blood pressure 85354-9)'),
      components: z
        .array(z.strictObject({ code: CodeSchema, label: z.string().min(1), range: RangeSchema.optional() }))
        .optional()
        .describe('For a panel: one input per component (e.g. systolic 8480-6, diastolic 8462-4), each with a label and a plausibility range'),
      unit: z.string().min(1).describe('The unit every value is recorded in, e.g. mmHg, kg, %'),
      range: RangeSchema.optional().describe('Plausibility range of a single value — a data-quality rule (impossible entries are refused), not a clinical threshold'),
      rules: z
        .array(z.strictObject({ component: CodeSchema.describe('The component that must be the greater'), above: CodeSchema.describe('The component it must exceed') }))
        .max(10)
        .optional()
        .describe('Relations between the components of a panel — "this one above that one" — refused when violated, so a swapped pair never reaches the record. The blood pressure panel (85354-9 with 8480-6 and 8462-4) gets "systolic above diastolic" by itself; state it only for other panels'),
      category: z.enum(['vital-signs', 'laboratory', 'survey', 'exam', 'social-history']).default('vital-signs').describe('Observation category stamped on the record'),
      title: z.string().min(1).optional().describe("Heading of the entry form; defaults to the code's display"),
      action_label: z.string().min(1).default('Record').describe('The submit button'),
      success_message: z.string().min(1).default('Saved to the patient record.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
      max_backdate_days: z.number().int().min(0).max(365).default(7).describe('How far back a measurement may be dated'),
      note: z.boolean().default(true).describe('Offer a free-text remark stored with the observation'),
      side: z
        .enum(['none', 'optional', 'required'])
        .default('none')
        .describe('Ask which side of the body the value is about — left, right or both — written to Observation.bodySite as the SNOMED laterality qualifier; `required` for paired measurements (range of motion, strength), `optional` when a measurement is sometimes bilateral'),
      body_site: CodeSchema.optional().describe('The structure measured (SNOMED body structure, e.g. knee joint structure 49076000), stamped into Observation.bodySite beside the side'),
      conditions: z
        .array(CodeSchema)
        .max(12)
        .optional()
        .describe("Test conditions the clinician picks one of — active or passive, with or without a walking aid, after warm-up — written to Observation.method; codes from lookup_codes or the hospital's own system, each with a display"),
    })
    .describe('An entry form that records one measurement as an Observation the rest of the record can see — makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('record_problem'),
      ...common,
      codes: z.array(CodeSchema).min(1).max(50).describe('The diagnoses this form may add — codes from lookup_codes (ICD-10-GM on the hospital record); the clinician picks one'),
      verification: z.array(z.enum(['confirmed', 'provisional', 'differential', 'unconfirmed'])).min(1).default(['confirmed', 'provisional']).describe('The verification statuses offered; the first is preselected'),
      category: z.enum(['problem-list-item', 'encounter-diagnosis']).default('problem-list-item').describe('Stamped on the record: an entry of the problem list, or a diagnosis of this encounter'),
      onset: z.boolean().default(true).describe('Ask for the onset date (optional for the clinician, never in the future)'),
      severity: z.boolean().default(false).describe('Offer mild / moderate / severe'),
      note: z.boolean().default(true).describe('Offer a free-text remark stored with the problem'),
      title: z.string().min(1).optional().describe('Heading of the entry form; defaults to "Add a problem"'),
      action_label: z.string().min(1).default('Add problem').describe('The submit button'),
      success_message: z.string().min(1).default('Added to the problem list.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe('An entry form that adds a diagnosis to the problem list — an active Condition from a fixed list of codes; makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('record_allergy'),
      ...common,
      codes: z.array(CodeSchema).min(1).max(50).describe('The substances or agents this form may record — codes from lookup_codes (a drug by ATC, a substance by SNOMED); the clinician picks one'),
      types: z.array(z.enum(['allergy', 'intolerance'])).min(1).default(['allergy', 'intolerance']).describe('Allergy, intolerance, or let the clinician say which'),
      categories: z.array(z.enum(['food', 'medication', 'environment', 'biologic'])).min(1).default(['medication', 'food', 'environment']).describe('The categories offered; one is required'),
      verification: z.array(z.enum(['confirmed', 'unconfirmed', 'presumed', 'refuted'])).min(1).default(['confirmed', 'unconfirmed']).describe('The verification statuses offered; the first is preselected'),
      criticality: z.boolean().default(true).describe('Ask for the criticality (low / high / unable to assess)'),
      reaction: z.boolean().default(true).describe('Take the reaction: what happened (free text) and how severe'),
      onset: z.boolean().default(true).describe('Ask when it was first noticed (optional, never in the future)'),
      note: z.boolean().default(true).describe('Offer a free-text remark stored with the allergy'),
      title: z.string().min(1).optional().describe('Heading of the entry form; defaults to "Record an allergy or intolerance"'),
      action_label: z.string().min(1).default('Record allergy').describe('The submit button'),
      success_message: z.string().min(1).default('Recorded on the allergy list.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe('An entry form that records an allergy or intolerance — an active AllergyIntolerance to one of a fixed list of substances; makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('record_procedure'),
      ...common,
      codes: z.array(CodeSchema).min(1).max(50).describe('The procedures this form may record — codes from lookup_codes (OPS on the hospital record); the clinician picks one'),
      statuses: z.array(z.enum(['completed', 'in-progress', 'not-done', 'stopped'])).min(1).default(['completed']).describe('The statuses the clinician may record; one entry means it is fixed'),
      max_backdate_days: z.number().int().min(0).max(3650).default(30).describe('How far back the procedure may be dated'),
      body_site: z.boolean().default(false).describe('Take the body site as free text'),
      outcome: z.boolean().default(false).describe('Take the outcome as free text'),
      note: z.boolean().default(true).describe('Offer a free-text remark stored with the procedure'),
      title: z.string().min(1).optional().describe('Heading of the entry form; defaults to "Record a procedure"'),
      action_label: z.string().min(1).default('Record procedure').describe('The submit button'),
      success_message: z.string().min(1).default('Added to the procedures.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe('An entry form that records a procedure performed — a Procedure from a fixed list of codes, dated within a window; makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('tasks'),
      ...common,
      codes: z.array(TaskCodeSchema).max(20).optional().describe('Only tasks of these kinds; omitted = every task of the patient'),
      statuses: z.array(z.enum(TASK_STATUSES)).min(1).default(['requested', 'in-progress']).describe('Which tasks are listed; the defaults are the open ones'),
      title: z.string().min(1).optional().describe('Defaults to "Tasks"'),
      complete: z.boolean().default(true).describe('Offer "Start" and "Complete" on each row — status changes the record keeps, attributed to whoever did them'),
      cancel: z.boolean().default(false).describe('Offer "Cancel" on each row as well'),
    })
    .describe("The patient's tasks — what is to be done, by when, how urgent, who has taken it — optionally with the row actions that move a task on; makes the app a workflow app when it has them"),
  z
    .strictObject({
      kind: z.literal('create_task'),
      ...common,
      codes: z.array(TaskCodeSchema).min(1).max(20).describe('The task kinds this form may create — the ward\'s own words, e.g. falls_screen "Falls risk screen"; the clinician picks one'),
      priorities: z.array(z.enum(['routine', 'urgent', 'asap', 'stat'])).min(1).default(['routine', 'urgent']).describe('The priorities offered; the first is preselected'),
      due: z.boolean().default(true).describe('Ask for a due date (today or later)'),
      description: z.boolean().default(true).describe('Take a free-text line saying what exactly is to be done'),
      title: z.string().min(1).optional().describe('Heading of the form; defaults to "New task"'),
      action_label: z.string().min(1).default('Create task').describe('The submit button'),
      success_message: z.string().min(1).default('The task is on the list.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe('A form that puts a task on the list for the patient in context — a kind from a fixed list, a priority, a due date, a line of description; makes the app a workflow app'),
  z
    .strictObject({
      kind: z.literal('photos'),
      ...common,
      kinds: z.array(TaskCodeSchema).max(20).optional().describe('Only photos documenting these kinds; omitted = every photo of the patient'),
      title: z.string().min(1).optional().describe('Defaults to "Photos"'),
      rows: z.number().int().positive().max(100).default(24).describe('How many photos, newest first'),
    })
    .describe("The patient's photo documentation — thumbnails with what each documents, the body site and the date; a photo opens full size with its note and who took it"),
  z
    .strictObject({
      kind: z.literal('record_photo'),
      ...common,
      kinds: z.array(TaskCodeSchema).min(1).max(20).describe('What a photo may document — the ward\'s own words, e.g. wound "Wound", pressure_ulcer "Pressure ulcer"; the clinician picks one'),
      body_site: z.boolean().default(true).describe('Take the body site as free text'),
      note: z.boolean().default(true).describe('Offer a free-text remark stored with the photo'),
      max_size_kb: z.number().int().min(100).max(8000).default(1500).describe('The largest image accepted after the browser has downscaled it'),
      max_backdate_days: z.number().int().min(0).max(365).default(30).describe('How far back a photo may be dated'),
      title: z.string().min(1).optional().describe('Heading of the form; defaults to "Add a photo"'),
      action_label: z.string().min(1).default('Save photo').describe('The submit button'),
      success_message: z.string().min(1).default('The photo is part of the patient record.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe("A form that records a photo of the patient — taken with the device's camera or chosen from it, downscaled in the browser, documenting one of a fixed list of kinds, with body site and remark; the image is stored encrypted by the platform and the record keeps the Media; makes the app a workflow app"),
  z
    .strictObject({
      kind: z.literal('record'),
      ...common,
      shape: identifier.optional().describe('A published record shape from the library, by id — its resource, fields and status apply; give either `shape` or `resource` + `fields`'),
      resource: z.enum(RECORD_RESOURCES).optional().describe('The FHIR resource the form writes — Goal (a measurable goal), CarePlan, Encounter (a visit), DocumentReference (a note or letter as text), Consent (one consent decision per purpose: scope, category, permit or deny)'),
      fields: z.array(RecordFieldSchema).min(1).max(20).optional().describe("The fields, each typed and mapped to an element path of that resource; the form has exactly these, the record gets exactly these plus the platform's stamps (status, subject, author, dates)"),
      status: RecordStatusSchema,
      title: z.string().min(1).optional().describe('Heading of the form; defaults to the resource in words'),
      action_label: z.string().min(1).default('Save').describe('The submit button'),
      success_message: z.string().min(1).default('Saved to the patient record.'),
      confirm: z.string().min(1).optional().describe('A confirmation asked before writing'),
    })
    .describe("A form that writes a record of a declared shape — a resource type the engine allows, with the fields you declare mapped to its elements (a Goal with a measurable target and due date, a CarePlan, a visit, a clinical note, a consent decision) and nothing else; validated on both sides, stamped by the platform; makes the app a workflow app. Read it back with a `list` of the same resource"),
  z
    .strictObject({
      kind: z.literal('allergies'),
      ...common,
      status: z.enum(['active', 'all']).default('active').describe('Active allergies only, or everything ever recorded'),
      title: z.string().min(1).optional().describe('Defaults to "Allergies and intolerances"'),
    })
    .describe('Allergies and intolerances — the safety list; says "none recorded" when the record has none'),
  z
    .strictObject({
      kind: z.literal('encounters'),
      ...common,
      title: z.string().min(1).optional().describe('Defaults to "Visits"'),
      rows: z.number().int().positive().max(200).default(20),
    })
    .describe('Visits: date, type, setting, reason and clinician, newest first'),
  z
    .strictObject({
      kind: z.literal('reports'),
      ...common,
      category: z.string().min(1).optional().describe('Restrict to one report category (HL7 v2-0074 code: RAD radiology, LAB laboratory, PAT pathology, MB microbiology); omit for all'),
      title: z.string().min(1).optional().describe('Defaults to "Reports"'),
      rows: z.number().int().positive().max(100).default(10),
    })
    .describe('Diagnostic reports with their conclusion text (radiology, laboratory, pathology, …)'),
  z
    .strictObject({
      kind: z.literal('notes'),
      ...common,
      type: z.string().min(1).optional().describe('Restrict to one document type (LOINC code: 11488-4 consult note, 18842-5 discharge summary, 34117-2 history and physical); omit for all'),
      title: z.string().min(1).optional().describe('Defaults to "Notes and letters"'),
      rows: z.number().int().positive().max(100).default(10),
    })
    .describe('Clinical notes and letters (DocumentReference) with their text shown inline when it is plain text'),
  z
    .strictObject({
      kind: z.literal('procedures'),
      ...common,
      title: z.string().min(1).optional().describe('Defaults to "Procedures"'),
      rows: z.number().int().positive().max(200).default(20),
    })
    .describe('Procedures: date, procedure, body site, outcome, status'),
  z
    .strictObject({
      kind: z.literal('immunizations'),
      ...common,
      title: z.string().min(1).optional().describe('Defaults to "Immunizations"'),
      rows: z.number().int().positive().max(200).default(20),
    })
    .describe('Immunizations: date, vaccine, lot, status'),
  z
    .strictObject({
      kind: z.literal('list'),
      ...common,
      resource: z.enum(LIST_RESOURCES).describe('The resource type to list — any allow-listed type, always for the patient in context'),
      params: z.record(z.string(), z.string()).optional().describe('Extra FHIR search parameters, e.g. { category: laboratory, status: final }'),
      columns: z.array(ColumnSchema).min(1).describe('Columns in order: a label and a field path on the resource, e.g. { label: Date, path: effectiveDateTime }; add status: true for a status badge'),
      title: z.string().min(1).optional().describe('Defaults to the resource type'),
      rows: z.number().int().positive().max(200).default(20),
      empty_text: z.string().min(1).optional().describe('Shown when nothing is recorded; defaults to "Nothing recorded."'),
    })
    .describe('Any allow-listed resource type as a table with the columns you name — the long tail'),
]);

export type ComposedSection = z.infer<typeof SectionSchema>;
export type SectionKind = ComposedSection['kind'];

export const ComposedKnobsSchema = z.strictObject({
  identity: z.enum(['banner', 'compact_banner', 'header', 'none']).default('banner').describe("Who the patient is, at the top: the masking banner (per role), its one-line form, Medplum's stock header (full PHI), or nothing when the host already shows it"),
  arrangement: z.enum(['stack', 'tabs']).default('stack').describe('Sections down the page (sharing rows by span) or one tab each'),
  window: WindowSchema.default('now-2y').describe('How far back charts, readings tables and readings counts look'),
  sections: z.array(SectionSchema).min(1).describe('The page, top to bottom (or tab by tab); each section is one block from the catalog'),
});

export type ComposedKnobs = z.infer<typeof ComposedKnobsSchema>;

export const SECTION_KINDS = ['trend', 'form_trend', 'latest_answers', 'readings', 'problems', 'medication', 'imaging', 'assessment', 'details', 'counts', 'record_observation', 'record_problem', 'record_allergy', 'record_procedure', 'tasks', 'create_task', 'photos', 'record_photo', 'record', 'allergies', 'encounters', 'reports', 'notes', 'procedures', 'immunizations', 'list'] as const satisfies readonly SectionKind[];

const DEFAULT_LABEL: Record<SectionKind, string> = {
  trend: 'Trend',
  form_trend: 'Trend',
  latest_answers: 'Latest answers',
  readings: 'Readings',
  problems: 'Problems',
  medication: 'Medication',
  imaging: 'Imaging',
  assessment: 'Assessment',
  details: 'Record',
  counts: 'Overview',
  record_observation: 'Record',
  record_problem: 'Add problem',
  record_allergy: 'Record allergy',
  record_procedure: 'Record procedure',
  tasks: 'Tasks',
  create_task: 'New task',
  photos: 'Photos',
  record_photo: 'Add photo',
  record: 'New record',
  allergies: 'Allergies',
  encounters: 'Visits',
  reports: 'Reports',
  notes: 'Notes',
  procedures: 'Procedures',
  immunizations: 'Immunizations',
  list: 'List',
};

/** The data category a declared-shape record falls under, and the form's default heading. */
const RECORD_CATEGORY: Record<(typeof RECORD_RESOURCES)[number], string> = { Goal: 'care_plans', CarePlan: 'care_plans', Encounter: 'encounters', DocumentReference: 'clinical_documentation', Consent: 'consent' };
const RECORD_TITLE: Record<(typeof RECORD_RESOURCES)[number], string> = { Goal: 'Set a goal', CarePlan: 'New care plan', Encounter: 'Record a visit', DocumentReference: 'New note', Consent: 'Record a consent' };

/** The blood pressure panel as LOINC codes it: the one panel whose component relation the compiler knows by itself. */
const BP_PANEL = 'http://loinc.org|85354-9';
const BP_SYSTOLIC = 'http://loinc.org|8480-6';
const BP_DIASTOLIC = 'http://loinc.org|8462-4';

/**
 * The relations a panel's write enforces (qualified codes, a message naming the components as the form labels them).
 * Stated rules win; a blood pressure panel with both components and no stated rule gets systolic-above-diastolic — a
 * swapped pair is the common slip, and a diastolic above the systolic is not a reading the record should hold.
 */
function panelRules(code: Code, components: readonly { code: Code; label: string }[], stated: readonly { component: Code; above: Code }[]): { component: string; above: string; message: string }[] {
  const labelOf = (q: string) => components.find((c) => qualified(c.code) === q)?.label ?? q;
  const make = (component: string, above: string) => ({ component, above, message: `${labelOf(component)} must be above ${labelOf(above).replace(/^(\p{Lu})(\p{Ll})/u, (_m, a: string, b: string) => a.toLowerCase() + b)}` });
  if (stated.length) return stated.map((r) => make(qualified(r.component), qualified(r.above)));
  const codes = components.map((c) => qualified(c.code));
  if (qualified(code) === BP_PANEL && codes.includes(BP_SYSTOLIC) && codes.includes(BP_DIASTOLIC)) return [make(BP_SYSTOLIC, BP_DIASTOLIC)];
  return [];
}

const CATEGORY_ORDER = ['clinical_measurements', 'medication', 'allergies', 'imaging', 'encounters', 'procedures', 'immunizations', 'clinical_documentation', 'tasks', 'photos', 'care_plans', 'consent', 'other_records'] as const;

/** The columns the opinionated lists use; a `list` section names its own. */
const PROCEDURE_COLUMNS = [
  { label: 'Date', path: 'performedDateTime' },
  { label: 'Procedure', path: 'code' },
  { label: 'Body site', path: 'bodySite[0]' },
  { label: 'Outcome', path: 'outcome' },
  { label: 'Status', path: 'status', status: true },
];
const IMMUNIZATION_COLUMNS = [
  { label: 'Date', path: 'occurrenceDateTime' },
  { label: 'Vaccine', path: 'vaccineCode' },
  { label: 'Lot', path: 'lotNumber' },
  { label: 'Status', path: 'status', status: true },
];

/** The category a list section's resource type belongs to, for the audit's data_categories. */
const LIST_CATEGORY: Record<string, string> = {
  Observation: 'clinical_measurements',
  MedicationRequest: 'medication',
  AllergyIntolerance: 'allergies',
  ImagingStudy: 'imaging',
  Encounter: 'encounters',
  Procedure: 'procedures',
  Immunization: 'immunizations',
  Task: 'tasks',
  Media: 'photos',
  Goal: 'care_plans',
  CarePlan: 'care_plans',
  DocumentReference: 'clinical_documentation',
  DiagnosticReport: 'clinical_documentation',
  Consent: 'consent',
};

/** A section's id: its own, else its kind — numbered from the second occurrence of a kind. */
export function sectionIds(sections: readonly { id?: string | undefined; kind: string }[]): string[] {
  const seen = new Map<string, number>();
  return sections.map((s) => {
    if (s.id) return s.id;
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    return n === 1 ? s.kind : `${s.kind}_${n}`;
  });
}

/** The primitive ids a section declares — so a clash between two sections is caught before the compiler sees it. */
function primitiveIdsOf(s: ComposedSection, id: string): string[] {
  switch (s.kind) {
    case 'assessment':
      return [`p_${id}_questionnaire`, ...(s.submissions ? [`p_${id}_submissions`] : []), `p_${id}_submit`];
    case 'counts':
      return [...(s.problems ? [`p_${id}_conditions`] : []), ...(s.medication ? [`p_${id}_medications`] : []), ...(s.readings_codes ? [`p_${id}_readings`] : [])];
    case 'details':
      return s.resource === 'Patient' ? [] : [`p_${id}`];
    case 'problems':
      return [`p_${id}`, ...(s.resolve ? [`p_${id}_resolve`] : [])];
    case 'medication':
      return [`p_${id}`, ...(s.stop ? [`p_${id}_stop`] : [])];
    case 'tasks':
      return [`p_${id}`, ...(s.complete ? [`p_${id}_status`] : [])];
    default:
      return [`p_${id}`];
  }
}

const readable = (resource: string): string => resource.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** A spec code as a component prop: the system spelled out, so the form writes exactly what the scope was derived from. */
const codeProp = (c: { system: string; code: string; display?: string | undefined }) => clean({ system: systemUrl(c.system), code: c.code, display: c.display });

interface BuiltSection {
  readonly label: string;
  readonly span: number;
  readonly gate: readonly string[] | undefined;
  readonly content: LayoutNode;
}

/** Stacked sections share a row while their spans fit into 12; a full-width or gated section is a row of its own. */
export function packRows<T extends { span: number }>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  let current: T[] = [];
  let used = 0;
  const flush = () => {
    if (current.length) rows.push(current);
    current = [];
    used = 0;
  };
  for (const item of items) {
    if (item.span >= 12) {
      flush();
      rows.push([item]);
      continue;
    }
    if (used + item.span > 12) flush();
    current.push(item);
    used += item.span;
    if (used === 12) flush();
  }
  flush();
  return rows;
}

export const composed: ArchetypeDef<ComposedKnobs> = {
  id: 'APP-12',
  name: 'Composed page',
  knobs: ComposedKnobsSchema,

  check(ctx: BuildContext, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const roleIds = new Set(ctx.roles.map((r) => r.id));
    const ids = sectionIds(k.sections);
    const seenIds = new Set<string>();
    const seenPrimitives = new Set<string>(['p_patient']);
    const seenForms = new Set<string>();
    const designedForms = new Set(k.sections.flatMap((s) => (s.kind === 'assessment' && s.form ? [s.form.id] : [])));
    for (const [i, s] of k.sections.entries()) {
      const id = ids[i] ?? s.kind;
      const p = `knobs.sections.${i}`;
      if (id === 'patient') issues.push({ path: `${p}.id`, message: '"patient" is the patient record itself — give the section another id' });
      if (seenIds.has(id)) {
        issues.push({ path: `${p}.id`, message: `two sections are called "${id}" — give one of them its own id` });
      } else {
        // Distinct section ids can still meet in the data plan (a section "a" with counts and a section "a_conditions").
        for (const pid of primitiveIdsOf(s, id)) {
          if (seenPrimitives.has(pid)) issues.push({ path: `${p}.id`, message: `section "${id}" would reuse the data request ${pid} of another section — give it another id` });
          seenPrimitives.add(pid);
        }
      }
      seenIds.add(id);
      for (const [j, r] of (s.roles ?? []).entries()) {
        if (!roleIds.has(r)) issues.push({ path: `${p}.roles.${j}`, message: `"${r}" is not a declared role` });
      }
      switch (s.kind) {
        case 'imaging':
          if (s.ratio[0] + s.ratio[1] !== 12) issues.push({ path: `${p}.ratio`, message: 'the two widths must add up to 12' });
          if (new Set(s.modalities).size !== s.modalities.length) issues.push({ path: `${p}.modalities`, message: 'each modality at most once' });
          break;
        case 'assessment':
          if (s.ratio[0] + s.ratio[1] !== 12) issues.push({ path: `${p}.ratio`, message: 'the two widths must add up to 12' });
          if (!s.questionnaire && !s.form) issues.push({ path: `${p}.questionnaire`, message: 'name a Questionnaire the record holds (questionnaire), or design the form here (form)' });
          if (s.questionnaire && s.form) issues.push({ path: `${p}.form`, message: 'either a Questionnaire of the record or a form designed here, not both' });
          if (s.form) {
            issues.push(...formIssues(s.form, `${p}.form`));
            if (seenForms.has(s.form.id)) issues.push({ path: `${p}.form.id`, message: `two forms are called "${s.form.id}" — give one of them its own id` });
            seenForms.add(s.form.id);
          }
          break;
        case 'details':
          if (s.params && ('patient' in s.params || 'subject' in s.params)) issues.push({ path: `${p}.params`, message: 'the patient is the launch context; do not set it as a parameter' });
          if (s.resource === 'Patient' && s.params) issues.push({ path: `${p}.params`, message: 'the patient record takes no search parameters' });
          break;
        case 'list':
          if (s.params && ('patient' in s.params || 'subject' in s.params)) issues.push({ path: `${p}.params`, message: 'the patient is the launch context; do not set it as a parameter' });
          if (new Set(s.columns.map((c) => c.label)).size !== s.columns.length) issues.push({ path: `${p}.columns`, message: 'each column label at most once' });
          break;
        case 'counts':
          if (!s.problems && !s.medication && !s.readings_codes) issues.push({ path: p, message: 'show at least one count' });
          break;
        case 'record_observation': {
          const codes = (s.components ?? []).map((c) => qualified(c.code));
          if (new Set(codes).size !== codes.length) issues.push({ path: `${p}.components`, message: 'each component code at most once' });
          if (s.components?.length && s.range) issues.push({ path: `${p}.range`, message: 'a panel carries its ranges on the components' });
          if (s.conditions?.some((c) => !c.display)) issues.push({ path: `${p}.conditions`, message: 'every test condition needs its display text — it is what the clinician picks from' });
          if (s.conditions && new Set(s.conditions.map(qualified)).size !== s.conditions.length) issues.push({ path: `${p}.conditions`, message: 'each test condition at most once' });
          for (const [i, r] of (s.rules ?? []).entries()) {
            if (!codes.length) issues.push({ path: `${p}.rules`, message: 'rules relate the components of a panel; this form records a single value' });
            else {
              for (const side of ['component', 'above'] as const) if (!codes.includes(qualified(r[side]))) issues.push({ path: `${p}.rules.${i}.${side}`, message: `${qualified(r[side])} is not a component of this panel` });
              if (qualified(r.component) === qualified(r.above)) issues.push({ path: `${p}.rules.${i}`, message: 'a component cannot be above itself' });
            }
          }
          break;
        }
        case 'record_problem':
        case 'record_allergy':
        case 'record_procedure': {
          const codes = s.codes.map(qualified);
          if (new Set(codes).size !== codes.length) issues.push({ path: `${p}.codes`, message: 'each code at most once' });
          if (s.codes.some((c) => !c.display)) issues.push({ path: `${p}.codes`, message: 'every code needs its display text — it is what the clinician picks from' });
          break;
        }
        case 'form_trend':
        case 'latest_answers': {
          if (!s.questionnaire && !s.form) issues.push({ path: `${p}.questionnaire`, message: 'name the form: a Questionnaire the record holds (questionnaire), or a form designed in this spec (form)' });
          if (s.questionnaire && s.form) issues.push({ path: `${p}.form`, message: 'either a Questionnaire of the record or a form designed here, not both' });
          if (s.form && !designedForms.has(s.form)) issues.push({ path: `${p}.form`, message: `no form "${s.form}" is designed in this spec — an assessment section's form.id` });
          if (s.kind === 'form_trend' && new Set(s.questions.map((q) => q.link_id)).size !== s.questions.length) issues.push({ path: `${p}.questions`, message: 'each question at most once' });
          break;
        }
        case 'tasks':
          if (s.cancel && !s.complete) issues.push({ path: `${p}.cancel`, message: 'cancelling needs the row actions (complete: true)' });
          if (s.codes && new Set(s.codes.map((c) => c.code)).size !== s.codes.length) issues.push({ path: `${p}.codes`, message: 'each task kind at most once' });
          break;
        case 'create_task':
          if (new Set(s.codes.map((c) => c.code)).size !== s.codes.length) issues.push({ path: `${p}.codes`, message: 'each task kind at most once' });
          break;
        case 'photos':
          if (s.kinds && new Set(s.kinds.map((c) => c.code)).size !== s.kinds.length) issues.push({ path: `${p}.kinds`, message: 'each kind at most once' });
          break;
        case 'record': {
          if (s.shape) {
            if (s.resource || s.fields) issues.push({ path: `${p}.shape`, message: 'a shape from the library brings its own resource and fields — give either shape, or resource and fields' });
            else if (!ctx.shapes?.has(s.shape)) issues.push({ path: `${p}.shape`, message: `no published record shape "${s.shape}"${ctx.shapes?.size ? ` — the library has: ${[...ctx.shapes.keys()].join(', ')}` : ' — the library has none yet'}` });
          } else if (!s.resource || !s.fields) issues.push({ path: `${p}.resource`, message: 'say what the form writes: a shape from the library (shape), or the resource and its fields' });
          else issues.push(...checkRecordSection({ resource: s.resource, fields: s.fields, status: s.status }, p));
          break;
        }
        case 'record_photo':
          if (new Set(s.kinds.map((c) => c.code)).size !== s.kinds.length) issues.push({ path: `${p}.kinds`, message: 'each kind at most once' });
          break;
        default:
          break;
      }
    }
    if (k.identity === 'header') {
      // The stock header cannot mask: every role of this app would see the full identity.
      for (const [i, r] of ctx.roles.entries()) {
        if (PHI_FIELDS.some((f) => !r.phi_fields_visible.includes(f))) {
          issues.push({ path: `roles.${i}.phi_fields_visible`, message: `role "${r.id}" masks identity fields, but identity "header" shows them all — use identity "banner"` });
        }
      }
    }
    return issues;
  },

  build(ctx, k): BuildOutput {
    const primitives: BlockPrimitive[] = [patientRead()];
    const actions: ActionDecl[] = [];
    const questionnaires: QuestionnaireArtifact[] = [];
    const categories = new Set<string>();
    let windowed = false;
    const windowText = describeWindow(k.window).toLowerCase();
    const ids = sectionIds(k.sections);

    const built: BuiltSection[] = k.sections.map((s, i) => {
      const id = ids[i] ?? s.kind;
      const gate = s.roles;
      let content: LayoutNode;
      switch (s.kind) {
        case 'trend': {
          windowed = true;
          categories.add('clinical_measurements');
          primitives.push(observationsByCode({ id: `p_${id}`, binding: id, codes: s.codes, windowed: true, count: s.max_observations, only_for_roles: gate }));
          content = node('ObservationTimeline', {
            title: s.title ?? `${s.series.map((x) => x.label).join(' / ')}, ${windowText}`,
            observations: `$bindings.${id}`,
            unit: s.unit,
            height_px: s.height_px,
            series: s.series.map((x) => (x.code ? { label: x.label, code: x.code } : { label: x.label, component_code: x.component_code })),
            thresholds: s.thresholds.length ? s.thresholds.map((t) => ({ value: t.value, label: t.label })) : undefined,
            caption: s.thresholds.length && s.thresholds_source ? `Reference lines: ${s.thresholds_source}.` : undefined,
            split_by_side: s.by_side ? true : undefined,
          });
          if (s.compare) {
            // The chart and, under it, the first-against-latest table over the same observations — one section, stacked.
            const comparison = node('ObservationComparison', clean({ observations: `$bindings.${id}`, series: s.series.map((x) => (x.code ? { label: x.label, code: x.code } : { label: x.label, component_code: x.component_code })), split_by_side: s.by_side ? true : undefined, unit: s.unit }));
            content = node('Grid', { columns: 1 }, [content, comparison]);
          }
          break;
        }
        case 'form_trend': {
          categories.add('clinical_documentation');
          const url = s.questionnaire ?? questionnaireCanonical(ctx.questionnaire_base, ctx.app.app_id, s.form!);
          primitives.push(formAnswers({ id: `p_${id}`, binding: id, questionnaire: url, link_ids: s.questions.map((q) => q.link_id), only_for_roles: gate }));
          content = node('ObservationTimeline', {
            title: s.title ?? `${s.questions.map((q) => q.label).join(' / ')}, across responses`,
            observations: `$bindings.${id}`,
            unit: s.unit,
            height_px: s.height_px,
            series: s.questions.map((q) => ({ label: q.label, code: q.link_id })),
            thresholds: s.thresholds.length ? s.thresholds.map((t) => ({ value: t.value, label: t.label })) : undefined,
            caption: s.thresholds.length && s.thresholds_source ? `Reference lines: ${s.thresholds_source}.` : undefined,
          });
          break;
        }
        case 'latest_answers': {
          categories.add('clinical_documentation');
          const url = s.questionnaire ?? questionnaireCanonical(ctx.questionnaire_base, ctx.app.app_id, s.form!);
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'QuestionnaireResponse', params: { patient: REF.patient, questionnaire: url }, only_for_roles: gate }));
          content = node('LatestAnswers', { response: `$bindings.${id}[0]`, title: s.title ?? 'Latest answers' });
          break;
        }
        case 'readings': {
          windowed = true;
          categories.add('clinical_measurements');
          primitives.push(observationsByCode({ id: `p_${id}`, binding: id, codes: s.codes, windowed: true, count: s.rows, only_for_roles: gate }));
          content = node('VitalsTable', { observations: `$bindings.${id}`, title: s.title ?? `${s.label ?? DEFAULT_LABEL.readings}, ${windowText}`, max_rows: s.rows, compact: s.compact ? true : undefined });
          break;
        }
        case 'problems': {
          const params: Record<string, string> = { patient: REF.patient };
          if (s.status === 'active') params['clinical-status'] = 'active';
          if (s.codes?.length) params['code'] = s.codes.map(qualified).join(',');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Condition', params, only_for_roles: gate }));
          let resolve: { action: string; state: string } | undefined;
          if (s.resolve) {
            resolve = { action: `resolve_${id}`, state: `${id}_resolve` };
            primitives.push(conditionStatusUpdate({ id: `p_${id}_resolve`, binding: `${id}_resolved`, allowed: ['resolved', 'inactive'], stateKey: resolve.state, only_for_roles: gate }));
            actions.push(submitAction({ id: resolve.action, label: s.resolve_label, primitive: `p_${id}_resolve`, success_message: 'The problem is now marked as resolved.' }));
          }
          content = node('ProblemList', { conditions: `$bindings.${id}`, title: s.title ?? (s.status === 'active' ? 'Active problems' : 'Problem list'), resolve_action: resolve?.action, state_key: resolve?.state, resolve_label: resolve ? s.resolve_label : undefined });
          break;
        }
        case 'medication': {
          categories.add('medication');
          const params: Record<string, string> = { patient: REF.patient };
          if (s.status === 'active') params['status'] = 'active';
          if (s.codes?.length) params['code'] = s.codes.map(qualified).join(',');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'MedicationRequest', params, only_for_roles: gate }));
          let stop: { action: string; state: string } | undefined;
          if (s.stop) {
            stop = { action: `stop_${id}`, state: `${id}_stop` };
            primitives.push(medicationStatusUpdate({ id: `p_${id}_stop`, binding: `${id}_stopped`, allowed: ['stopped', 'completed', 'on-hold'], stateKey: stop.state, only_for_roles: gate }));
            actions.push(submitAction({ id: stop.action, label: s.stop_label, primitive: `p_${id}_stop`, success_message: 'The prescription is now marked as stopped.' }));
          }
          content = node('MedicationList', { medications: `$bindings.${id}`, title: s.title ?? (s.status === 'active' ? 'Active medication' : 'Medication history'), stop_action: stop?.action, state_key: stop?.state, stop_label: stop ? s.stop_label : undefined });
          break;
        }
        case 'record_observation': {
          categories.add('clinical_measurements');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          const ranges: Record<string, { min?: number; max?: number }> = {};
          for (const c of s.components ?? []) if (c.range) ranges[qualified(c.code)] = clean({ min: c.range.min, max: c.range.max });
          if (!s.components?.length && s.range) ranges[qualified(s.code)] = clean({ min: s.range.min, max: s.range.max });
          const rules = panelRules(s.code, s.components ?? [], s.rules ?? []);
          primitives.push(
            observationCreate({
              id: `p_${id}`,
              binding: `${id}_recorded`,
              codes: [s.code],
              components: s.components?.map((c) => c.code),
              unit: s.unit,
              category: s.category,
              ranges,
              rules,
              max_backdate_days: s.max_backdate_days,
              side: s.side === 'none' ? undefined : s.side,
              body_site: s.body_site,
              conditions: s.conditions,
              stateKey,
              only_for_roles: gate,
            })
          );
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          const asProp = (c: { system: string; code: string; display?: string | undefined }) => clean({ system: systemUrl(c.system), code: c.code, display: c.display });
          content = node('ObservationEntryForm', {
            action: actionId,
            state_key: stateKey,
            title: s.title,
            submit_label: s.action_label,
            code: asProp(s.code),
            components: s.components?.length ? s.components.map((c) => clean({ code: asProp(c.code), label: c.label, range: c.range ? clean({ min: c.range.min, max: c.range.max }) : undefined })) : undefined,
            unit: s.unit,
            range: !s.components?.length && s.range ? clean({ min: s.range.min, max: s.range.max }) : undefined,
            rules: rules.length ? rules : undefined,
            max_backdate_days: s.max_backdate_days,
            note: s.note ? undefined : false,
            side: s.side === 'none' ? undefined : s.side,
            body_site: s.body_site ? asProp(s.body_site) : undefined,
            conditions: s.conditions?.length ? s.conditions.map(asProp) : undefined,
          });
          break;
        }
        case 'record_problem': {
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(conditionCreate({ id: `p_${id}`, binding: `${id}_recorded`, codes: s.codes, verification: s.verification, category: s.category, severity: s.severity, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('ProblemEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title, submit_label: s.action_label, codes: s.codes.map(codeProp), verification: [...s.verification], onset: s.onset ? undefined : false, severity: s.severity ? true : undefined, note: s.note ? undefined : false }));
          break;
        }
        case 'record_allergy': {
          categories.add('allergies');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(allergyIntoleranceCreate({ id: `p_${id}`, binding: `${id}_recorded`, codes: s.codes, types: s.types, categories: s.categories, verification: s.verification, criticality: s.criticality, reaction: s.reaction, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('AllergyEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title, submit_label: s.action_label, codes: s.codes.map(codeProp), types: [...s.types], categories: [...s.categories], verification: [...s.verification], criticality: s.criticality ? undefined : false, reaction: s.reaction ? undefined : false, onset: s.onset ? undefined : false, note: s.note ? undefined : false }));
          break;
        }
        case 'record_procedure': {
          categories.add('procedures');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(procedureCreate({ id: `p_${id}`, binding: `${id}_recorded`, codes: s.codes, statuses: s.statuses, max_backdate_days: s.max_backdate_days, body_site: s.body_site, outcome: s.outcome, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('ProcedureEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title, submit_label: s.action_label, codes: s.codes.map(codeProp), statuses: [...s.statuses], max_backdate_days: s.max_backdate_days, body_site: s.body_site ? true : undefined, outcome: s.outcome ? true : undefined, note: s.note ? undefined : false }));
          break;
        }
        case 'tasks': {
          categories.add('tasks');
          const params: Record<string, string> = { patient: REF.patient, status: s.statuses.join(',') };
          if (s.codes?.length) params['code'] = s.codes.map((c) => `${TASK_SYSTEM}|${c.code}`).join(',');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Task', params, only_for_roles: gate }));
          let status: { action: string; state: string } | undefined;
          if (s.complete) {
            status = { action: `update_${id}`, state: `${id}_status` };
            primitives.push(taskStatusUpdate({ id: `p_${id}_status`, binding: `${id}_updated`, allowed: ['in-progress', 'completed', ...(s.cancel ? ['cancelled'] : [])], stateKey: status.state, perPatient: true, only_for_roles: gate }));
            actions.push(submitAction({ id: status.action, label: 'Update task', primitive: `p_${id}_status`, success_message: 'The task was updated.' }));
          }
          content = node('TaskList', clean({ tasks: `$bindings.${id}`, title: s.title ?? 'Tasks', status_action: status?.action, state_key: status?.state, cancel: s.cancel ? true : undefined }));
          break;
        }
        case 'create_task': {
          categories.add('tasks');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(taskCreate({ id: `p_${id}`, binding: `${id}_created`, codes: s.codes, priorities: s.priorities, due: s.due, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('TaskEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title, submit_label: s.action_label, codes: s.codes.map((c) => ({ code: c.code, display: c.display })), priorities: [...s.priorities], due: s.due ? undefined : false, description: s.description ? undefined : false }));
          break;
        }
        case 'photos': {
          categories.add('photos');
          const params: Record<string, string> = { patient: REF.patient, type: 'photo' };
          if (s.kinds?.length) params['code'] = s.kinds.map((k) => `${PHOTO_SYSTEM}|${k.code}`).join(',');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Media', params, only_for_roles: gate }));
          content = node('PhotoGallery', { media: `$bindings.${id}`, title: s.title ?? 'Photos', max_rows: s.rows });
          break;
        }
        case 'record_photo': {
          categories.add('photos');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(mediaCreate({ id: `p_${id}`, binding: `${id}_recorded`, kinds: s.kinds, body_site: s.body_site, max_bytes: s.max_size_kb * 1000, max_backdate_days: s.max_backdate_days, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('PhotoEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title, submit_label: s.action_label, kinds: s.kinds.map((k) => ({ code: k.code, display: k.display })), body_site: s.body_site ? undefined : false, note: s.note ? undefined : false, max_bytes: s.max_size_kb * 1000, max_backdate_days: s.max_backdate_days }));
          break;
        }
        case 'record': {
          // Inline or from the library: either way the rules below are what the manifest carries; a library shape is pinned by its checksum.
          const shape = s.shape ? ctx.shapes?.get(s.shape) : undefined;
          const resource = shape?.resource ?? s.resource!;
          const rules = shape ? shape.rules : recordRules({ resource, fields: s.fields ?? [], status: s.status });
          categories.add(RECORD_CATEGORY[resource as (typeof RECORD_RESOURCES)[number]] ?? 'other_records');
          const stateKey = `${id}_entry`;
          const actionId = `record_${id}`;
          primitives.push(recordCreate({ id: `p_${id}`, binding: `${id}_recorded`, rules, shape: shape ? { id: shape.id, checksum: shape.checksum, version: shape.version, open_kind: shape.open_kind, tag: recordShapeTag(shape, ctx.hospital_id) } : undefined, stateKey, only_for_roles: gate }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: `p_${id}`, success_message: s.success_message, confirm: s.confirm }));
          content = node('RecordEntryForm', clean({ action: actionId, state_key: stateKey, title: s.title ?? shape?.name ?? RECORD_TITLE[resource as (typeof RECORD_RESOURCES)[number]] ?? `New ${resource}`, submit_label: s.action_label, resource, fields: rules.fields.map((f) => ({ ...f })) }));
          break;
        }
        case 'imaging': {
          categories.add('imaging');
          primitives.push(dicomStudies({ id: `p_${id}`, binding: id, modalities: s.modalities, only_for_roles: gate }));
          const key = `${id}_selected`;
          content = node('TwoColumn', { ratio: [...s.ratio] }, [
            node('ImagingStudyList', { studies: `$bindings.${id}`, title: s.list_title, selection_key: key }),
            node('DicomViewer', { study_uid: `$ui.${key}`, studies: `$bindings.${id}`, height_px: s.viewer_height_px, ...(s.layout !== 'stack' ? { layout: s.layout } : {}) }),
          ]);
          break;
        }
        case 'assessment': {
          categories.add('clinical_documentation');
          const questionnaire = `${id}_questionnaire`;
          const submissions = `${id}_submissions`;
          const submit = `p_${id}_submit`;
          const stateKey = `${id}_response`;
          const actionId = `submit_${id}`;
          // The record's form, or one designed here and carried by the app — the same primitives, the URL decides.
          if (s.form) questionnaires.push(compileForm(s.form, { app_id: ctx.app.app_id, version: ctx.app.version, base: ctx.questionnaire_base, date: ctx.created_at, language: ctx.app.language }));
          const url = s.questionnaire ?? questionnaireCanonical(ctx.questionnaire_base, ctx.app.app_id, s.form!.id);
          primitives.push(questionnaireRead({ id: `p_${questionnaire}`, binding: questionnaire, url, only_for_roles: gate }));
          if (s.submissions) {
            primitives.push(fhirQuery({ id: `p_${submissions}`, binding: submissions, resource: 'QuestionnaireResponse', params: { patient: REF.patient, questionnaire: url }, only_for_roles: gate }));
          }
          primitives.push(questionnaireResponseSubmit({ id: submit, binding: `${id}_submitted`, url, stateKey, only_for_roles: gate, extract: s.form ? formExtraction(s.form) : undefined }));
          actions.push(submitAction({ id: actionId, label: s.action_label, primitive: submit, success_message: s.success_message, confirm: s.confirm }));
          const form = node('AssessmentForm', { questionnaire: `$bindings.${questionnaire}`, action: actionId, state_key: stateKey, title: s.form_title, submit_label: s.action_label === 'Submit assessment' ? undefined : s.action_label });
          content = s.submissions ? node('TwoColumn', { ratio: [...s.ratio] }, [form, node('SubmissionList', { responses: `$bindings.${submissions}`, title: s.submissions_title })]) : form;
          break;
        }
        case 'details': {
          categories.add('clinical_documentation');
          if (s.resource === 'Patient') {
            content = node('ResourceDetails', { resource: '$bindings.patient', title: s.title ?? 'Patient resource' });
          } else {
            primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: s.resource, params: { patient: REF.patient, ...(s.params ?? {}) }, only_for_roles: gate }));
            content = node('ResourceDetails', { resource: `$bindings.${id}[0]`, title: s.title ?? `Most recent ${readable(s.resource)}` });
          }
          break;
        }
        case 'counts': {
          const cards: LayoutNode[] = [];
          if (s.problems) {
            primitives.push(fhirQuery({ id: `p_${id}_conditions`, binding: `${id}_conditions`, resource: 'Condition', params: { patient: REF.patient, 'clinical-status': 'active' }, only_for_roles: gate }));
            cards.push(node('StatCard', { label: 'Active problems', value: `$bindings.${id}_conditions.length`, hint: 'On the problem list now' }));
          }
          if (s.medication) {
            categories.add('medication');
            primitives.push(fhirQuery({ id: `p_${id}_medications`, binding: `${id}_medications`, resource: 'MedicationRequest', params: { patient: REF.patient, status: 'active' }, only_for_roles: gate }));
            cards.push(node('StatCard', { label: 'Current medication', value: `$bindings.${id}_medications.length`, hint: 'Active prescriptions' }));
          }
          if (s.readings_codes) {
            windowed = true;
            categories.add('clinical_measurements');
            primitives.push(observationsByCode({ id: `p_${id}_readings`, binding: `${id}_readings`, codes: s.readings_codes, windowed: true, count: 100, only_for_roles: gate }));
            cards.push(node('StatCard', { label: `Readings, ${windowText}`, value: `$bindings.${id}_readings.length`, hint: 'Vitals and key labs recorded in the window', tone: 'accent' }));
          }
          content = node('Grid', { columns: cards.length }, cards);
          break;
        }
        case 'allergies': {
          categories.add('allergies');
          const params: Record<string, string> = { patient: REF.patient };
          if (s.status === 'active') params['clinical-status'] = 'active';
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'AllergyIntolerance', params, only_for_roles: gate }));
          content = node('AllergyList', { allergies: `$bindings.${id}`, title: s.title });
          break;
        }
        case 'encounters': {
          categories.add('encounters');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Encounter', params: { patient: REF.patient }, only_for_roles: gate }));
          content = node('EncounterList', { encounters: `$bindings.${id}`, title: s.title ?? 'Visits', max_rows: s.rows });
          break;
        }
        case 'reports': {
          categories.add('clinical_documentation');
          const params: Record<string, string> = { patient: REF.patient };
          if (s.category) params['category'] = s.category;
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'DiagnosticReport', params, only_for_roles: gate }));
          content = node('ReportList', { reports: `$bindings.${id}`, title: s.title ?? 'Reports', max_rows: s.rows });
          break;
        }
        case 'notes': {
          categories.add('clinical_documentation');
          const params: Record<string, string> = { patient: REF.patient };
          if (s.type) params['type'] = s.type;
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'DocumentReference', params, only_for_roles: gate }));
          content = node('DocumentList', { documents: `$bindings.${id}`, title: s.title ?? 'Notes and letters', max_rows: s.rows });
          break;
        }
        case 'procedures': {
          categories.add('procedures');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Procedure', params: { patient: REF.patient }, only_for_roles: gate }));
          content = node('ResourceList', { resources: `$bindings.${id}`, title: s.title ?? 'Procedures', columns: PROCEDURE_COLUMNS, max_rows: s.rows, empty_text: 'No procedures recorded.' });
          break;
        }
        case 'immunizations': {
          categories.add('immunizations');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: 'Immunization', params: { patient: REF.patient }, only_for_roles: gate }));
          content = node('ResourceList', { resources: `$bindings.${id}`, title: s.title ?? 'Immunizations', columns: IMMUNIZATION_COLUMNS, max_rows: s.rows, empty_text: 'No immunizations recorded.' });
          break;
        }
        case 'list': {
          categories.add(LIST_CATEGORY[s.resource] ?? 'other_records');
          primitives.push(fhirQuery({ id: `p_${id}`, binding: id, resource: s.resource as QueryResource, params: { patient: REF.patient, ...(s.params ?? {}) }, only_for_roles: gate }));
          content = node('ResourceList', {
            resources: `$bindings.${id}`,
            title: s.title ?? `${readable(s.resource).replace(/^./, (c) => c.toUpperCase())}s`,
            columns: s.columns.map((c) => clean({ label: c.label, path: c.path, status: c.status ? true : undefined })),
            max_rows: s.rows,
            empty_text: s.empty_text,
          });
          break;
        }
      }
      // A gated section takes a whole row: beside an ungated one it would leave an empty column for the other roles.
      return { label: s.label ?? DEFAULT_LABEL[s.kind], span: gate ? 12 : s.span, gate, content };
    });

    const gated = (b: BuiltSection): LayoutNode => (b.gate ? { ...b.content, show_only_if_role_in: [...b.gate] } : b.content);
    const body: LayoutNode[] =
      k.arrangement === 'tabs'
        ? [node('Tabs', { default_tab: built[0]?.label }, built.map((b) => node('Tab', { label: b.label }, [b.content], b.gate)))]
        : packRows(built).map((row) => {
            const [first, second] = row;
            if (row.length === 1 && first) return gated(first);
            if (row.length === 2 && first && second) return node('TwoColumn', { ratio: [first.span, second.span] }, [first.content, second.content]);
            return node('Grid', { columns: row.length }, row.map((b) => b.content));
          });

    const identity: LayoutNode[] =
      k.identity === 'none' ? [] : k.identity === 'header' ? [patientIdentity('header')] : [patientIdentity('banner', { compact: k.identity === 'compact_banner' })];

    return {
      intent_class: actions.length ? 'workflow' : 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [...identity, ...body],
      context_inputs: windowed ? [patientContextInput(), windowContextInput(k.window)] : [patientContextInput()],
      actions: actions.length ? actions : undefined,
      data_categories: CATEGORY_ORDER.filter((c) => categories.has(c)),
      questionnaires: questionnaires.length ? questionnaires : undefined,
    };
  },
};
