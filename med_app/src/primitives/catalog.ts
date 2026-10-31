import type { ComponentType } from 'react';
import { GridLayout, PageShell, Section, Tab, TabsLayout, TwoColumn } from './layout';
import { PatientBanner } from './ui/PatientBanner';
import { PatientHeader, ResourceDetails } from './ui/MedplumWrappers';
import { MedicationList, ProblemList, VitalsTable } from './ui/ClinicalLists';
import { AllergyList, DocumentList, EncounterList, ReportList, ResourceList } from './ui/RecordLists';
import { ObservationEntryForm } from './ui/ObservationEntry';
import { AllergyEntryForm, ProblemEntryForm, ProcedureEntryForm } from './ui/CodedEntry';
import { AssessmentDueList, TaskEntryForm, TaskList, Worklist } from './ui/Tasks';
import { PhotoEntryForm, PhotoGallery } from './ui/Photos';
import { RecordEntryForm } from './ui/RecordEntry';
import { ObservationTimeline } from './ui/ObservationTimeline';
import { ObservationComparison } from './ui/ObservationComparison';
import { DicomViewer, ImagingStudyList } from './ui/Imaging';
import { CohortTable, StatCard } from './ui/Cohort';
import { CohortRangeCard, RangeFilter } from './ui/RangeFilter';
import { AssessmentForm, LatestAnswers, SubmissionList } from './ui/Assessment';

export interface UiCatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly kind: 'layout' | 'display';
  readonly description: string;
  /** Prop names the pipeline may set. Documentation for the planner; enforcement is TypeScript + runtime. */
  readonly props: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly component: ComponentType<any>;
  /** Layout components that need their children's manifest nodes (e.g. Tabs for labels). */
  readonly wantsChildNodes?: boolean;
}

export { DESIGN_SYSTEM_VERSION } from './versions';

/**
 * UI catalog v0 — the complete set of components a manifest may reference.
 * If a name is not here, the renderer refuses it. Adding an entry is a platform release.
 */
export const UI_CATALOG: Readonly<Record<string, UiCatalogEntry>> = Object.freeze({
  // ── layout ────────────────────────────────────────────────────────────────
  PageShell: {
    name: 'PageShell',
    version: '1.0.0',
    kind: 'layout',
    description: 'Page root with title and subtitle.',
    props: ['title', 'subtitle'],
    component: PageShell,
  },
  TwoColumn: {
    name: 'TwoColumn',
    version: '1.0.0',
    kind: 'layout',
    description: 'Two responsive columns; ratio like [7, 5].',
    props: ['ratio'],
    component: TwoColumn,
  },
  Grid: {
    name: 'Grid',
    version: '1.0.0',
    kind: 'layout',
    description: 'Equal-width responsive grid.',
    props: ['columns'],
    component: GridLayout,
  },
  Section: {
    name: 'Section',
    version: '1.0.0',
    kind: 'layout',
    description: 'Bordered section with optional title and description.',
    props: ['title', 'description'],
    component: Section,
  },
  Tabs: {
    name: 'Tabs',
    version: '1.0.0',
    kind: 'layout',
    description: 'Tab strip; children must be Tab nodes.',
    props: ['default_tab'],
    component: TabsLayout,
    wantsChildNodes: true,
  },
  Tab: {
    name: 'Tab',
    version: '1.0.0',
    kind: 'layout',
    description: 'One tab panel; `label` is shown in the strip.',
    props: ['label'],
    component: Tab,
  },

  // ── patient identity ─────────────────────────────────────────────────────
  PatientBanner: {
    name: 'PatientBanner',
    version: '1.0.0',
    kind: 'display',
    description: 'Patient identification with PHI masking from the role scope (Medplum display components). A field another role of the app may see is announced as "hidden"; one no role sees is omitted.',
    props: ['patient', 'visible_fields', 'compact', 'mrn_system'],
    component: PatientBanner,
  },
  PatientHeader: {
    name: 'PatientHeader',
    version: '1.0.0',
    kind: 'display',
    description: 'Medplum PatientHeader as-is (no masking; use only where the role sees full PHI).',
    props: ['patient'],
    component: PatientHeader,
  },
  ResourceDetails: {
    name: 'ResourceDetails',
    version: '1.0.0',
    kind: 'display',
    description: 'Schema-driven view of any FHIR resource (Medplum ResourceTable).',
    props: ['resource', 'title', 'ignore_missing'],
    component: ResourceDetails,
  },

  // ── clinical lists ───────────────────────────────────────────────────────
  VitalsTable: {
    name: 'VitalsTable',
    version: '1.0.0',
    kind: 'display',
    description: 'Observation table handling value[x] and component[] polymorphism.',
    props: ['observations', 'title', 'max_rows', 'compact'],
    component: VitalsTable,
  },
  ProblemList: {
    name: 'ProblemList',
    version: '1.0.0',
    kind: 'display',
    description: 'Condition list with clinical and verification status; with `resolve_action`, active problems offer "Mark resolved" (a versioned status update through the action).',
    props: ['conditions', 'title', 'resolve_action', 'state_key', 'resolve_label'],
    component: ProblemList,
  },
  MedicationList: {
    name: 'MedicationList',
    version: '1.0.0',
    kind: 'display',
    description: 'MedicationRequest list with dosage text; with `stop_action`, active prescriptions offer "Stop" with a reason (a versioned status update through the action).',
    props: ['medications', 'title', 'stop_action', 'state_key', 'stop_label'],
    component: MedicationList,
  },
  ObservationTimeline: {
    name: 'ObservationTimeline',
    version: '1.0.0',
    kind: 'display',
    description: 'Longitudinal line chart over Observation series with threshold lines.',
    props: ['observations', 'series', 'thresholds', 'unit', 'title', 'height_px', 'caption', 'split_by_side'],
    component: ObservationTimeline,
  },
  ObservationComparison: {
    name: 'ObservationComparison',
    version: '1.0.0',
    kind: 'display',
    description: 'First and latest value of each Observation series (and side), their dates and the arithmetic difference; nothing graded.',
    props: ['observations', 'series', 'split_by_side', 'unit', 'title'],
    component: ObservationComparison,
  },

  // ── the rest of the record ───────────────────────────────────────────────
  AllergyList: {
    name: 'AllergyList',
    version: '1.0.0',
    kind: 'display',
    description: 'AllergyIntolerance list: substance, category, criticality (high in red), reactions, status, recorded date; "none recorded" is stated.',
    props: ['allergies', 'title'],
    component: AllergyList,
  },
  EncounterList: {
    name: 'EncounterList',
    version: '1.0.0',
    kind: 'display',
    description: 'Encounter list: date, visit type, setting (class), reason, clinician, status.',
    props: ['encounters', 'title', 'max_rows'],
    component: EncounterList,
  },
  ReportList: {
    name: 'ReportList',
    version: '1.0.0',
    kind: 'display',
    description: 'DiagnosticReport cards with category, status, date, performer and the conclusion text.',
    props: ['reports', 'title', 'max_rows'],
    component: ReportList,
  },
  DocumentList: {
    name: 'DocumentList',
    version: '1.0.0',
    kind: 'display',
    description: 'DocumentReference cards (notes, letters): title, date, author, and inline plain-text content, folded when long.',
    props: ['documents', 'title', 'max_rows'],
    component: DocumentList,
  },
  ResourceList: {
    name: 'ResourceList',
    version: '1.0.0',
    kind: 'display',
    description: 'Any allow-listed resource type as a table; columns are field paths rendered by type (dates, concepts, quantities, periods, references).',
    props: ['resources', 'title', 'columns', 'max_rows', 'empty_text'],
    component: ResourceList,
  },

  // ── imaging ──────────────────────────────────────────────────────────────
  ImagingStudyList: {
    name: 'ImagingStudyList',
    version: '1.0.0',
    kind: 'display',
    description: 'Selectable list of ImagingStudy resources; writes $ui.<selection_key>.',
    props: ['studies', 'title', 'selection_key'],
    component: ImagingStudyList,
  },
  DicomViewer: {
    name: 'DicomViewer',
    version: '1.0.0',
    kind: 'display',
    description: 'OHIF viewer for a StudyInstanceUID (viewer URL comes from deployment config); opens as a 2-D stack, MPR or MPR with a 3-D volume rendering, switchable in its header.',
    props: ['study_uid', 'studies', 'height_px', 'title', 'layout'],
    component: DicomViewer,
  },

  // ── cohort ───────────────────────────────────────────────────────────────
  StatCard: {
    name: 'StatCard',
    version: '1.0.0',
    kind: 'display',
    description: 'Single headline number with label and hint.',
    props: ['label', 'value', 'hint', 'tone'],
    component: StatCard,
  },
  CohortTable: {
    name: 'CohortTable',
    version: '1.0.0',
    kind: 'display',
    description:
      'Member rows: `rows` from data.cohort.latest_observation (latest value, threshold flag), `imaging` from data.cohort.with_imaging (study count, latest study) — either alone or joined by patient; with `range` ($ui of a RangeFilter) only the members in that range; `open_in` links each member to an imaging app.',
    props: ['rows', 'imaging', 'title', 'value_label', 'mrn_system', 'range', 'unit', 'open_in'],
    component: CohortTable,
  },
  RangeFilter: {
    name: 'RangeFilter',
    version: '1.0.0',
    kind: 'display',
    description: 'Two-handle slider over the cohort\'s compared values; writes {min, max} to $ui.<selection_key>. Filters the view, never the data request.',
    props: ['selection_key', 'label', 'unit', 'min', 'max', 'step', 'initial', 'rows', 'hint'],
    component: RangeFilter,
  },
  CohortRangeCard: {
    name: 'CohortRangeCard',
    version: '1.0.0',
    kind: 'display',
    description: 'Headline count of the members whose compared value lies in the selected range; follows the RangeFilter live.',
    props: ['label', 'rows', 'range', 'unit', 'hint'],
    component: CohortRangeCard,
  },

  // ── structured data entry ────────────────────────────────────────────────
  AssessmentForm: {
    name: 'AssessmentForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Renders a FHIR Questionnaire (Medplum QuestionnaireForm) and submits the QuestionnaireResponse through a manifest action.',
    props: ['questionnaire', 'action', 'state_key', 'title', 'submit_label'],
    component: AssessmentForm,
  },
  ObservationEntryForm: {
    name: 'ObservationEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Records one measurement (a single value or a panel such as blood pressure) as an Observation through an action; validates code, unit, plausibility range and date before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'code', 'label', 'components', 'unit', 'range', 'rules', 'max_backdate_days', 'note', 'side', 'body_site', 'conditions'],
    component: ObservationEntryForm,
  },
  ProblemEntryForm: {
    name: 'ProblemEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Adds a diagnosis to the problem list through an action: one of a fixed list of codes, verification status, onset, severity and a remark; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'codes', 'verification', 'onset', 'severity', 'note'],
    component: ProblemEntryForm,
  },
  AllergyEntryForm: {
    name: 'AllergyEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Records an allergy or intolerance through an action: one of a fixed list of substances, type, category, criticality, verification, reaction and a remark; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'codes', 'types', 'categories', 'verification', 'criticality', 'reaction', 'onset', 'note'],
    component: AllergyEntryForm,
  },
  ProcedureEntryForm: {
    name: 'ProcedureEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Records a procedure performed through an action: one of a fixed list of codes, status, date within a window, body site, outcome and a remark; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'codes', 'statuses', 'max_backdate_days', 'body_site', 'outcome', 'note'],
    component: ProcedureEntryForm,
  },
  TaskList: {
    name: 'TaskList',
    version: '1.0.0',
    kind: 'display',
    description: "The patient's tasks — kind, due date (overdue marked), priority, status, owner — with Start / Complete (and Cancel) row actions that run write.fhir.task.update_status through an action.",
    props: ['tasks', 'title', 'status_action', 'state_key', 'cancel'],
    component: TaskList,
  },
  TaskEntryForm: {
    name: 'TaskEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Puts a task on the list for the patient in context through an action: a kind from a fixed list, a priority, a due date, a line of description; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'codes', 'priorities', 'due', 'description'],
    component: TaskEntryForm,
  },
  Worklist: {
    name: 'Worklist',
    version: '1.0.0',
    kind: 'display',
    description: 'The open tasks across patients (data.task.worklist rows), overdue first: patient, MRN, task, due, priority, status, owner; a Mine / Everyone switch, Start / Complete row actions and a link that opens the patient in another app.',
    props: ['rows', 'title', 'status_action', 'state_key', 'cancel', 'mine', 'open_in', 'mrn_system'],
    component: Worklist,
  },
  RecordEntryForm: {
    name: 'RecordEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'The form of a declared-shape record (write.fhir.record.create): one input per declared field by type — text, number with unit, date, yes/no, code or option from a fixed list — written at its element path into the declared resource; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'resource', 'fields'],
    component: RecordEntryForm,
  },
  PhotoGallery: {
    name: 'PhotoGallery',
    version: '1.0.0',
    kind: 'display',
    description: "The patient's photo documentation (Media resources, newest first): thumbnails with what each documents, the body site and the date; one opens full size with its remark, who took it and its size.",
    props: ['media', 'title', 'max_rows'],
    component: PhotoGallery,
  },
  PhotoEntryForm: {
    name: 'PhotoEntryForm',
    version: '1.0.0',
    kind: 'display',
    description: 'Records a photo for the patient in context through an action: taken with the device camera or chosen, downscaled in the browser, what it documents from a fixed list, body site, taken-at, remark; validated before and after the request.',
    props: ['action', 'state_key', 'title', 'submit_label', 'kinds', 'body_site', 'note', 'max_bytes', 'max_backdate_days'],
    component: PhotoEntryForm,
  },
  AssessmentDueList: {
    name: 'AssessmentDueList',
    version: '1.0.0',
    kind: 'display',
    description: 'Who is due an assessment (data.cohort.assessment_due rows): patient, MRN, last answer, standing — never assessed, overdue by N days, due today, upcoming — and a link that opens the patient in the assessment app.',
    props: ['rows', 'title', 'label', 'every_days', 'open_in', 'mrn_system'],
    component: AssessmentDueList,
  },
  LatestAnswers: {
    name: 'LatestAnswers',
    version: '1.0.0',
    kind: 'display',
    description: "The patient's most recent QuestionnaireResponse to a form, question by question, with when and by whom.",
    props: ['response', 'title'],
    component: LatestAnswers,
  },
  SubmissionList: {
    name: 'SubmissionList',
    version: '1.0.0',
    kind: 'display',
    description: 'Earlier QuestionnaireResponses, newest first, each expandable to its answers.',
    props: ['responses', 'title'],
    component: SubmissionList,
  },
});

export function listCatalog(): UiCatalogEntry[] {
  return Object.values(UI_CATALOG);
}
