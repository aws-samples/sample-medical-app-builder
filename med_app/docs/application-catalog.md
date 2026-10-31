# Supported applications — catalog v0

**Design system 1.0.0 · data catalog 1.0.0 · 2026-09-11**

This document describes every kind of application the platform can currently build from a
clinician's request. It is derived from the two catalogs the renderer enforces — the UI
components (`src/primitives/catalog.ts`) and the data primitives (`src/primitives/data/dataCatalog.ts`)
— together with the composition rules of the manifest schema. Nothing outside this document can be
expressed in a manifest; a request that falls outside it is refused with "not in the catalog yet"
rather than approximated. Extending the catalog is a platform release under change control.

The live, always-current list of components and primitives is available inside the app at `/catalog`.
For how to ask the builder for each of these kinds — a request per archetype, follow-ups that refine a
draft, and what is declined — see [example-prompts.md](example-prompts.md).

---

## 1. Building blocks

### 1.1 Data primitives

Every piece of data an app shows arrives through one of these. They run in declaration order; a
later primitive may consume an earlier one's output through `$bindings.<name>`. Each call is
scope-checked against the active role and produces an audit record.

| Kind | Input | Output | Scope required |
|---|---|---|---|
| `data.fhir.patient.read` | `patient` | one `Patient` | `Patient.read` |
| `data.fhir.observation.by_code` | `patient`, `codes[]` (LOINC, matches `Observation.code` **and** `component[].code`), `since` (ISO or `now-2y` / `now-6m` / `now-90d`), `count` ≤ 1000 | `Observation[]`, newest first | `Observation.search` |
| `data.fhir.query` | `resource` ∈ Condition · MedicationRequest · Observation · ImagingStudy · Encounter · DiagnosticReport · Questionnaire · QuestionnaireResponse · AllergyIntolerance · Procedure · Immunization · DocumentReference; `params` (`patient`, `code`, `clinical-status`, `status`, `category`, `type`, `date=ge…`, `_sort`); `count` ≤ 1000 | `Resource[]` | `<resource>.search` |
| `data.dicom.studies.for_patient` | `patient`, `modalities[]` | `ImagingStudy[]`, newest first | `dicom.qido` |
| `data.cohort.by_condition` | `condition_codes[]` (SNOMED), `clinical_status` | `{ patients[], conditions[], count }` | `Condition.search`, `Patient.read`, `patient_scope: cohort` or `population` |
| `data.cohort.with_imaging` | `patients` (from a cohort binding), `modalities[]` (DICOM codes; empty: any), `since` (ISO or `now-2y`), `min_studies` (default 1) | `{ rows[], patients[], count, studies_total }` — one row per member who has at least `min_studies` matching studies: `study_count`, `latest_study { uid, started, modalities[], description, series, instances }`, `modalities[]`; `patients` is the narrowed cohort for the next step. Studies are asked of the PACS (QIDO, by MRN, one query per member, no series) where one is configured, of the record's `ImagingStudy` otherwise | `ImagingStudy.search`, `dicom.qido`, `patient_scope: cohort` or `population` |
| `data.cohort.latest_observation` | `patients` (from a cohort binding), `codes[]`, `threshold { component_code?, value }` | `{ rows[], above_threshold_count }` — one row per patient with latest matching observation, systolic/diastolic or value, and an `above_threshold` flag | `Observation.search` |
| `data.fhir.questionnaire.read` | `questionnaire` (canonical URL or id) | one `Questionnaire` | `Questionnaire.read` |
| `write.fhir.questionnaire_response.submit` — **runs only through an action** | `questionnaire`, `subject`, `response` (from `$ui`) | the stored `QuestionnaireResponse` with id and provenance; refused with the list of problems if it does not validate against the Questionnaire | `QuestionnaireResponse.create`, `Provenance.create` |
| `write.fhir.observation.create` — **action only** | `subject`, `codes[]` (what may be recorded), `components[]` (a panel's component codes), `unit`, `category`, `ranges{code: {min, max}}`, `max_backdate_days`, `observation` (from `$ui`) | the stored `Observation` (status final, subject, performer, issued, provenance stamped by the platform); refused with reasons: code not allowed, value not numeric / wrong unit / outside the range, missing component, date in the future or too old, another patient | `Observation.create`, `Provenance.create` |
| `write.fhir.condition.update_status` — **action only** | `subject`, `allowed[]` (target statuses), `change` `{id, status, versionId?, note?}` (from `$ui`) | the updated `Condition` (clinicalStatus, abatement when resolved, an attributed note); refused if the status is not allowed, the record belongs to another patient or is already in that status; **409** if `versionId` is no longer current | `Condition.update`, `Provenance.create` |
| `write.fhir.medication_request.update_status` — **action only** | `subject`, `allowed[]`, `change` `{id, status, versionId?, reason?, note?}` | the updated `MedicationRequest` (status, statusReason); same refusals and version conflict | `MedicationRequest.update`, `Provenance.create` |

### 1.2 Components

| Group | Component | Renders | Notable props |
|---|---|---|---|
| Layout | `PageShell` | page title and subtitle, vertical flow | `title`, `subtitle` |
| | `TwoColumn` | two responsive columns | `ratio` e.g. `[8, 4]` |
| | `Grid` | equal-width responsive grid | `columns` |
| | `Section` | bordered block with heading | `title`, `description` |
| | `Tabs` / `Tab` | tab strip, one panel per `Tab` | `default_tab`; `label` |
| Patient identity | `PatientBanner` | avatar, name, sex, DOB/age, MRN, address, phone, email — **each field shown only if the role's scope allows it**; a field another role of the same app may see is announced as "… hidden", a field no role sees is omitted; `compact` drops the contact row | `patient`, `visible_fields`, `compact` |
| | `PatientHeader` | Medplum's stock patient header (no masking) | `patient` |
| | `ResourceDetails` | schema-driven view of **any single** FHIR resource (Medplum `ResourceTable`); references resolved to display names | `resource`, `title` |
| Clinical lists | `VitalsTable` | observations table; handles `valueQuantity`, `valueCodeableConcept`, `valueString`, `component[]` (e.g. BP as "135/83 mmHg") | `observations`, `max_rows`, `compact` |
| | `ProblemList` | conditions with onset, clinical and verification status | `conditions` |
| | `MedicationList` | medication requests with dosage text, start, status | `medications` |
| | `ObservationTimeline` | line chart over time; series by observation code or component code; dashed threshold lines | `series[]`, `thresholds[]`, `unit`, `height_px` |
| Imaging | `ImagingStudyList` | selectable study list (date, modality, description, series/images); writes the selection to `$ui.<selection_key>` | `studies`, `selection_key` |
| | `DicomViewer` | OHIF viewer for the selected StudyInstanceUID (viewer URL is deployment config, never manifest data); opens as a 2-D stack, MPR or MPR with a 3-D volume rendering (switchable in its header), with expand-over-the-page and full-screen buttons; study metadata when no viewer is configured | `study_uid`, `studies`, `height_px`, `layout` |
| Cohort | `StatCard` | one headline number with label and hint | `label`, `value`, `hint`, `tone` |
| | `CohortTable` | member rows: `rows` from `data.cohort.latest_observation` (latest value, threshold badge) and/or `imaging` from `data.cohort.with_imaging` (study count, latest study as date · modality · description), joined by patient when both are given; with `range` (`$ui` of a `RangeFilter`) only the members in that range, "N of M" in the heading; with `open_in` an "Open imaging" link per member to that app on that patient | `rows`, `imaging`, `value_label`, `range`, `unit`, `open_in` |
| | `RangeFilter` | two-handle slider over the members' compared values (bounds from the knob or the data); writes `{min, max}` to `$ui.<selection_key>` — a view filter, nothing is read again | `selection_key`, `label`, `unit`, `min`, `max`, `step`, `initial`, `rows` |
| | `CohortRangeCard` | headline count of the members in the selected range, following the slider live | `label`, `rows`, `range`, `unit` |
| The rest of the record | `AllergyList` | allergies and intolerances: substance, category, criticality (high in red), reactions with severity, status, recorded date; an empty list says "none recorded" | `allergies`, `title` |
| | `EncounterList` | visits: date, type, setting (class), reason, clinician, status | `encounters`, `title`, `max_rows` |
| | `ReportList` | diagnostic reports as cards: name, category, status, date, performer, result count, and the conclusion text | `reports`, `title`, `max_rows` |
| | `DocumentList` | notes and letters as cards: title, date, author, and the text itself when the attachment is plain text (long notes fold); other attachments are named, not rendered | `documents`, `title`, `max_rows` |
| | `ResourceList` | any allow-listed resource type as a table; each column is a label and a field path (`code`, `performedDateTime`, `reaction[0].manifestation`), rendered by type — dates, concepts, quantities, periods, references — with an optional status badge | `resources`, `columns`, `title`, `max_rows`, `empty_text` |
| Data entry | `ObservationEntryForm` | records one measurement — a single value or a panel such as blood pressure — as an Observation through an action; the form checks code, unit, plausibility range and date before the request, the dispatcher checks them again | `action`, `state_key`, `code`, `components`, `unit`, `range`, `max_backdate_days`, `note`, `title`, `submit_label` |
| | `ProblemList` with `resolve_action` / `MedicationList` with `stop_action` | a row action on each active entry ("Mark resolved", "Stop") with an optional remark or reason; the change carries the record's version so a concurrent edit is not overwritten | `resolve_action`, `stop_action`, `state_key` |
| | `AssessmentForm` | a FHIR Questionnaire rendered as a form (Medplum `QuestionnaireForm`); the response is submitted through a manifest action | `questionnaire`, `action`, `state_key`, `submit_label` |
| | `SubmissionList` | earlier QuestionnaireResponses, expandable to their answers | `responses`, `title` |
| Photos | `PhotoGallery` | the patient's photo documentation (Media): thumbnails newest first with what each documents, body site and date; one opens full size with remark, who took it, size | `media`, `title`, `max_rows` |
| | `PhotoEntryForm` | takes a photo with the device camera or picks one, downscales it in the browser, and records it through an action — kind from a fixed list, body site, taken-at, remark; validated before and after the request | `action`, `state_key`, `kinds`, `body_site`, `note`, `max_bytes`, `max_backdate_days` |
| Records | `RecordEntryForm` | the form of a declared-shape record: one input per declared field by type, written at its element path into the declared resource (Goal, CarePlan, Encounter, DocumentReference); validated before and after the request | `action`, `state_key`, `title`, `submit_label`, `resource`, `fields` |

### 1.3 Cross-cutting capabilities every app gets

Roles come from Cognito groups (`app-{app_id}-{role}`); each role has a data scope, scopes can
`inherit` one another, and the effective scope decides both what the dispatcher will serve and which
PHI fields the banner shows. Any layout node can be limited to roles with `show_only_if_role_in`,
and any primitive with `only_for_roles`, so one manifest can serve a read-only viewer and a
reviewer with different data plans. Apps declare their launch context (`patient_id` from a SMART
launch or the panel, an optional `window_start` with a default such as `now-2y`). Values flow
through lookups only — `$bindings.x.y[0]`, `$context.patient_id`, `$metadata.name`,
`$auth.effective.phi_fields_visible`, `$ui.selected_study` — plus `.length` on arrays; there is
no arithmetic, templating or code. Every app has a lifecycle state (`draft → in_review → approved →
published → deprecated`) and an audit trail of one record per primitive call.

---

## 2. Supported application archetypes

Each archetype below is a shape the planner can produce today. "Requests" are illustrative
phrasings in English and German; "knobs" are the parameters that make one instance differ from
another without any catalog change.

### APP-01 · Patient summary (chart overview)

A single-patient overview: identity header, then tabs or sections for active problems, current
medication, recent vitals and labs, and the raw FHIR record. Answers "what do I need to know about
this patient before I walk in".

Requests — *"Give me an overview of the patient: problems, medication and recent vitals."* ·
*"Zeig mir eine Übersicht des Patienten mit Diagnosen, Medikation und letzten Vitalwerten."*

Context: `patient_id` (required), `window_start` (default `now-2y`).
Data: `patient.read`, `query Condition` (`clinical-status=active`), `query MedicationRequest` (`status=active`), `observation.by_code` with a vitals/labs code list.
Layout: `PageShell` → `PatientHeader` or `PatientBanner` → `Tabs` (`ProblemList`, `MedicationList`, `VitalsTable`, `ResourceDetails`) — or the same content as stacked `Section`s or a `Grid`.
Knobs: which observation codes count as "vitals", window length, active-only vs all conditions/medication, tabs vs sections, masking per role.
Reference: `fixtures/manifests/patient-summary.yaml` (hand-authored fixture); the showcase app `manifests/patient-360.yaml` is the composed-page form of it.

### APP-02 · Longitudinal observation trend

One or more numeric observations for a patient plotted over time, with guideline thresholds, and
the latest readings alongside. Works for anything coded as a quantity: blood pressure (systolic and
diastolic as two series from one panel), HbA1c, eGFR, weight, heart rate, lab analytes.

Requests — *"Blood pressure over the last two years against Stage 1 thresholds."* ·
*"HbA1c-Verlauf der letzten drei Jahre mit Zielwert 7 %."*

Context: `patient_id`, `window_start`.
Data: `patient.read`, `observation.by_code` (codes of the series); optionally a reviewer-only `query Condition` (`only_for_roles`) for clinical context.
Layout: `PatientBanner` → `TwoColumn` (`ObservationTimeline` | `VitalsTable compact`) — or the chart alone, or several charts in a `Grid`; optionally a role-gated `Section` with a `ProblemList`.
Knobs: codes and series (by `code` or `component_code`), threshold values and labels, window, chart height, column ratio, number of rows in the readings table.
Reference: `fixtures/manifests/bp-trend.yaml` (hand-authored fixture); charts with reference lines are in the showcase app `manifests/cardio-renal-follow-up.yaml`.
Limits: values are aggregated to one point per day per series; only quantity values are plotted (coded results appear in the table, not the chart).

### APP-03 · Observation flowsheet

A tabular history of many observations for one patient over a window — vitals, labs, social
history — in one list, newest first, with mixed value types rendered correctly.

Requests — *"All vitals and lab results from the last six months in a table."* ·
*"Alle Vital- und Laborwerte der letzten sechs Monate tabellarisch."*

Context: `patient_id`, `window_start`.
Data: `observation.by_code` (a broad code list) or `query Observation`.
Layout: `PatientBanner` → `VitalsTable`; optionally one `VitalsTable` per category in `Tabs`.
Knobs: codes, window, `max_rows`, compact mode, grouping into tabs.

### APP-04 · Problem list and medication review

A focused view of the patient's conditions and/or medication requests, filtered by status.

Requests — *"Active problems and current medication for this patient."* ·
*"Aktive Diagnosen und aktuelle Medikation."*

Context: `patient_id`.
Data: `query Condition`, `query MedicationRequest` (status filters as params).
Layout: `PatientBanner` → `TwoColumn` or `Grid` (`ProblemList` | `MedicationList`).
Knobs: clinical/verification status filters, resolved vs active, side-by-side vs stacked.

### APP-05 · Imaging study review

The patient's imaging studies, filterable by modality, with a viewer that opens the selected
study. Read-only (QIDO/WADO); no upload, no measurement, no annotation persistence.

Requests — *"Show this patient's CT and MR studies and let me open them."* ·
*"CT- und MRT-Untersuchungen des Patienten anzeigen und öffnen."*

Context: `patient_id`.
Data: `patient.read`, `dicom.studies.for_patient` (`modalities`).
Layout: `PatientBanner compact` → `TwoColumn` (`ImagingStudyList selection_key` | `DicomViewer study_uid: $ui.<key>`).
Knobs: modality filter, column ratio, viewer height, whether clinical context (problems, vitals) sits alongside.
Reference: `manifests/imaging-review-3d.yaml` (showcase app, opens studies as a volume); `fixtures/manifests/dicom-study-review.yaml` is the hand-authored fixture.

### APP-06 · Disease-specific follow-up dashboard

A composition for a named condition: the relevant trend(s), the relevant medication, the
problem list, and identity — the "consultation view" for a chronic disease clinic. One word
(`template`) fills every clinical knob; anything given explicitly wins. Three templates:

| Template | Trend series (LOINC) | Thresholds (source shown under the chart) | Therapy (ATC classes) | Problem codes (SNOMED · ICD-10-GM category) |
|---|---|---|---|---|
| Hypertension follow-up | 8480-6 / 8462-4 | ≥ 140 systolic, ≥ 90 diastolic — ESC/ESH 2023 | C09A, C09C, C08CA, C03, C07 | 38341003 · I10 |
| Diabetes follow-up | 4548-4 (HbA1c), 29463-7 (weight) | ≥ 7.0 % — ADA Standards of Care | A10B, A10A | 44054006 · E11 |
| CKD monitoring | 33914-3 (eGFR) | marker at 60 / 45 — KDIGO 2024 | C09A, C09C, C03C | 433144002 · N18 |

A template works on both records the platform meets: its conditions carry the SNOMED code the
synthetic record uses and the ICD-10-GM *category* the hospital's uses (`I10` covers `I10.00`,
`I10.90`, …), and its therapy is ATC *classes* rather than named drugs (`C09A` covers every ACE
inhibitor). The dispatcher and the mock match a class or category against every code under it;
a real FHIR server would match the token exactly, so the dispatcher keeps such codes out of the
request and filters the patient's own records itself. The guideline a template's lines come from is
stated under the chart (`thresholds_source`; own thresholds carry their own source or none) — a
reference, never a flag or a score.

Requests — *"A hypertension follow-up view: BP trend, antihypertensives, problems."* ·
*"Eine Diabetes-Sprechstundenansicht mit HbA1c-Verlauf, Gewicht und Medikation."*

Context: `patient_id`, `window_start`.
Data: `patient.read`, `observation.by_code`, `query MedicationRequest` (`code` filter), `query Condition`.
Layout: `PatientBanner` → `TwoColumn` (`ObservationTimeline` | `MedicationList`) → `ProblemList`; or a `Grid` of two charts.
Knobs: `template`, then everything in APP-02 and APP-04 combined, plus `thresholds_source`.

### APP-07 · Pre-consultation snapshot

A dense one-screen view: compact banner, a few counts, latest readings and active problems and
medication. Uses `StatCard` with `.length` lookups (e.g. `value: $bindings.conditions.length`)
to show counts without any computation primitive.

Requests — *"A one-screen snapshot before I see the patient."* · *"Kurzübersicht vor dem Patientenkontakt."*

Context: `patient_id`, `window_start` (short, e.g. `now-90d`).
Data: `patient.read`, `query Condition`, `query MedicationRequest`, `observation.by_code`.
Layout: `PatientBanner compact` → `Grid columns: 3` (`StatCard` × 3) → `TwoColumn` (`VitalsTable compact` | `ProblemList`) → `MedicationList`.
Knobs: which counts, window, density.

### APP-08 · FHIR resource inspector

A schema-driven rendering of a single resource with references resolved — useful for data-quality
review, for showing the most recent report or encounter, or as the "raw record" tab in another app.
The renderer indexes base R4 StructureDefinitions for Patient, Observation, Condition,
MedicationRequest, ImagingStudy, Encounter, DiagnosticReport, Practitioner and Organization.

Requests — *"Show me the patient's latest diagnostic report in full."* ·
*"Den letzten Befundbericht vollständig anzeigen."*

Context: `patient_id`.
Data: `patient.read`, or `query DiagnosticReport` / `query Encounter` then `resource: $bindings.reports[0]`.
Layout: `PatientBanner` → `ResourceDetails`.
Limits: one resource per component (index into a list with `[0]`); for *lists* of visits or reports, compose a page (APP-12).

### APP-09 · Condition-defined cohort register

A population view with no patient in context: every patient with an active coded condition —
optionally only those with imaging studies on record — each with their most recent value of a
chosen observation, flagged against a threshold, plus headline counts. Membership is by Condition
code, narrowed by imaging when asked (modality, window, minimum number of studies); a register may
be defined by diagnosis and imaging alone. The register *names* studies (count, date, modality,
description) and can link each member to an imaging app; it never retrieves pixels.

Requests — *"All patients with active hypertension and their latest blood pressure, flag anyone at or above 140."* ·
*"Alle Patienten mit aktiver Hypertonie und letztem Blutdruck; ab 140 systolisch markieren."* ·
*"All patients with lung cancer (C34) who have had a CT in the last two years, with a link to the images."* ·
*"Alle Patientinnen und Patienten mit C34.1, die ein CT hatten."*

Context: none (`patient_scope: cohort`).
Data: `cohort.by_condition` → [`cohort.with_imaging` (`patients: $bindings.cohort.patients`)] → `cohort.latest_observation` (`patients:` the cohort's, or the imaging step's, members). Each step reads only the members the previous one kept.
Layout: `PageShell` → `Grid` (`StatCard` for `$bindings.cohort.count`, `$bindings.imaging.count` when imaging is set, `$bindings.latest.above_threshold_count`, …; a `CohortRangeCard` when a range is set) → `RangeFilter` (when a range is set) → `CohortTable` (`rows`, `imaging`, `open_in`).
Knobs: condition codes, clinical status, observation code(s), threshold value and which component it applies to, visible PHI (typically name, DOB, MRN only); `imaging` — `modalities` (CT, MR, US, DX, …; empty for any), `within` (`now-2y`), `min_studies`, `label` ("a CT scan"), `card_label`, `open_in` (the `app_id` of a published APP-05 app the rows link to); `value.range` — slider bounds (or the data's span), step, the range selected at open, labels — for a live, client-side range over the compared value: the cohort and every member's latest value are fetched once, the slider only decides which members are shown and counted.
Reference: `manifests/hypertension-register.yaml` (showcase app, the diagnosis in SNOMED and ICD-10-GM, with the range slider) and `manifests/ckd-imaging-register.yaml` (a register narrowed to members with renal imaging, the latest eGFR shown unflagged, linking to the imaging review app); `fixtures/manifests/hypertension-cohort.yaml` is the hand-authored fixture.
Limits: threshold is "at or above" only; one observation code family per table; imaging narrows by modality, window and count only (not body part, series or report wording) and lists studies rather than displaying them; no age, sex, medication or encounter criteria; no sorting or paging controls.

### APP-10 · Cohort KPI tiles

APP-09 reduced to numbers: counts of patients meeting a coded criterion, of those with imaging
on record when asked, and the count above a threshold, for a wall display or a landing tile.

Data and knobs as APP-09 (including `imaging`); layout `Grid` of `StatCard` only.

### APP-11 · Structured assessment

The first archetype that **writes** to the record. A form is a FHIR Questionnaire — one the record
already holds, named by its canonical URL, or one designed in the conversation: the clinician's
questions (text, numbers with a unit, yes/no, dates, single and multiple choice, headings and notes)
become a Questionnaire the app carries in its manifest (`artifacts.questionnaires`), reviewed and
signed with the app and written to the hospital's FHIR server when the app is published. A designed
form can also say more than the question: an option may carry a terminology coding (`system` + `code`,
from `lookup_codes` — the answer lands on the record as that concept), a number may have the range the
form accepts (`min`/`max` → `minValue`/`maxValue`), and a question may be asked only when another
answer fits (`show_when` → `enableWhen`; `is`, `is_not`, `answered`, `at_least`, `at_most`; a list of
conditions must all hold; on a heading the whole section hinges on it). Either way the form is rendered for the patient in context (Medplum
`QuestionnaireForm`, which hides and shows by `enableWhen`), and the completed QuestionnaireResponse
goes through a manifest *action* to the dispatcher, which validates it against the Questionnaire
(required items, known linkIds, answer types, offered options with their system, ranges, and that no
hidden question carries an answer — each problem named by the question as asked) — read from the manifest for an app-authored form, from the record
otherwise —, stamps provenance and writes it. The mock data source the previews run on applies the
same rules with the same words, so a preview refuses what the dispatcher would refuse. Earlier
submissions are listed alongside and the list refreshes after a save. An answer that is a measurement
in its own right — pain on the 0–10 scale, a timed test — may carry `as_observation` with a code: the
Questionnaire says so the standard way (the item's `code` and SDC's `observationExtract` marker), the
submit primitive carries `extract`, the role's scope gains `Observation.create` for those codes, and on
submission the dispatcher writes one Observation per such answer beside the response — the item's unit,
category *survey*, `derivedFrom` the response, its own Provenance, idempotent on the submission — so the
value charts in a `trend` with measurements typed into an entry form, and the readiness check refuses the
flag on anything but a number. The answer stays in the response too; nothing is computed from it.

Requests — *"A follow-up assessment form for hypertension patients, saved to the record."* ·
*"Ein Verlaufsbogen für Hypertonie-Patienten, der in die Akte gespeichert wird."*

Context: `patient_id`.
Data: `patient.read`, `questionnaire.read` (canonical URL), `query QuestionnaireResponse` (by patient and questionnaire); the write `write.fhir.questionnaire_response.submit` is declared as a primitive but runs **only** through the action.
Layout: `PatientBanner compact` → `TwoColumn` (`AssessmentForm action: submit_assessment` | `SubmissionList`).
Knobs: which Questionnaire (`questionnaire`) or the designed form (`form`: id, title, items — each with `required`, a number's `min`/`max`, an option's `system`/`code`, `show_when`), button wording, which earlier submissions to list, role scope (`QuestionnaireResponse: [search, create]`).
Reference: `fixtures/manifests/htn-assessment.yaml` (hand-authored fixture); the form inside a composed page is the showcase app `manifests/hypertension-follow-up.yaml`; a designed form — with ranges and a section asked only after a fall — is the showcase app `manifests/falls-risk-assessment.yaml`.
Limits: a designed form has the standard item types only — no attachments or computed fields; a coding is one `lookup_codes` returned, never invented; `min`/`max` is a plausibility bound, not a clinical threshold; a condition names another question of the same form (a heading's condition cannot look inside the heading); it never asks for identity and never scores.
Limits: creates only (no amendment of earlier submissions); Questionnaires must exist on the record and use inline `answerOption`; no calculations or scoring from the answers.
Form-definition rules the renderer imposes: a yes/no question that must be answered is a `choice` with Yes/No options — a required `boolean` becomes a checkbox that has to be ticked, so "No" could never be submitted (`boolean` is for optional tick-if-applicable flags only); a multi-select choice carries the `questionnaire-itemControl` `check-box` extension, otherwise it renders as single-select radios.

---

### APP-12 · Composed page

The page the clinician describes rather than the nearest template. One patient; an ordered list of
**sections**, each one of the blocks the named archetypes are built from: `trend` (chart against
reference lines), `readings` (table within the window), `problems`, `medication`, `imaging` (list and
viewer), `assessment` (a form written through an action — the app then has intent class `workflow`),
`details` (one resource rendered from its schema: the patient record or the most recent of a type)
and `counts` (headline tiles from list lengths) — plus the rest of the record: `allergies` (the
safety list; "none recorded" is stated), `encounters` (visits), `reports` (diagnostic reports with
their conclusion, optionally one category), `notes` (letters and notes with inline text, optionally
one document type), `procedures`, `immunizations`, and `list` (any allow-listed resource type with
the columns you name). Six sections **write**: `record_observation` (an entry form that records a
measurement as an Observation — single value or panel, declared unit and plausibility range, dated
within a window; a panel may carry `rules` relating its components, "this one above that one", and the
blood pressure panel gets systolic-above-diastolic by itself, so a swapped pair is refused on both sides;
a paired measurement — range of motion, strength — asks the `side` (left, right or both, written to
`bodySite` as the SNOMED laterality qualifier beside the `body_site` structure) and may offer test
`conditions` (one of the lab's codes, written to `method`), and a `trend` with `by_side` plots each series
once per side, so a side comparison is one chart and the readings table shows the side; `compare` puts the first and the latest value of each series (and side) under the chart with their dates and the arithmetic difference — "first finding against today", as recorded, nothing graded
rather than written); the three coded entries `record_problem` (a diagnosis onto the problem list as an
active Condition: a code from the list the author fixed, verification status, onset, optionally a
severity), `record_allergy` (an active AllergyIntolerance to one of the listed substances: type,
category, criticality, verification, the reaction and its severity) and `record_procedure` (a
Procedure from the listed codes: status, performed date within a window, optionally body site and
outcome) — each with a free-text remark, each refusing a code the form does not list; and `problems`
with `resolve` ("Mark resolved" on active problems) and `medication` with `stop` ("Stop" with a
reason). Two more sections carry the patient's work: `tasks` (the open tasks with Start / Complete
row actions, see APP-13) and `create_task` (a form that puts one on the list). And two read a form
*back as data*: `form_trend` charts a form's numeric answers across the patient's responses — the
timed up-and-go across falls screens, pain scores over a stay — through
`data.fhir.questionnaire_response.answers`, which turns each numeric answer into a derived
Observation (coded `questionnaire URL | linkId`, dated when answered, `derivedFrom` the response, the
unit from the form) so the same `ObservationTimeline` draws it; `latest_answers` shows the most recent
response question by question. Both name the form by canonical URL or, for a form designed in the
same spec, by its id. Two sections carry *photo documentation*: `photos` shows the patient's photos —
thumbnails, newest first, with what each documents, the body site and the date; one opens full size
with its remark and who took it — optionally narrowed to kinds; `record_photo` is a form that takes a
photo with the device's camera (or picks one), downscales it in the browser (longest edge 1600 px,
JPEG) and records it as a FHIR `Media`: what it documents from the fixed list of kinds the author
chose in the ward's own words (`urn:medapp:photo`, e.g. `wound` "Wound", `pressure_ulcer` "Pressure
ulcer"), the body site as free text, when it was taken (within a window), a remark. The record keeps
the Media — who, when, what, where, a hash and a size — and the bytes live in the platform's media
bucket (`write.fhir.media.create`, see `infra/docs/dispatcher.md`), shown through short-lived links;
nothing is measured, compared or interpreted, and existing image files or DICOM are not imported.
One section writes *records of a declared shape*: `record` names a resource type the engine allows —
Goal, CarePlan, Encounter, DocumentReference, Consent — and the fields the form has, each typed (text, number with
unit and range, date within a window, yes/no, a code from a terminology, one of fixed options) and mapped
to an element path of that resource (`description`, `target[0].detailQuantity`, `target[0].dueDate`,
`content[0].attachment` for a note's text). The compiler resolves every path against the FHIR R4
definitions the panel ships, decides the encoding (a text into a CodeableConcept becomes its `text`, a
number into a Quantity carries the unit, a note becomes a text/plain attachment), refuses a path that
names nothing or a type that does not fit, and checks that the resource's required elements are covered
— a Goal needs a required description, an Encounter a required class, a DocumentReference its content, a
Consent its scope and category. Status, subject, author and dates are the platform's stamps, never fields
(a Consent is stamped with status, patient and the moment, never an author: `Consent.performer` is who
consents, and the staff member who recorded it is in the Provenance). A consent decision is one record per
purpose — treatment, communication, research — with permit or deny on `provision.type`; the bundled shape
`consent_per_purpose` is the form, a `list` of Consent the state. At runtime the form writes the
values at their paths, both validators check the payload against the declared fields and refuse any
element outside them by name, and `write.fhir.record.create` stamps and writes it with a Provenance. A
`list` of the same resource reads it back. The review page shows the fields, paths and stamps — exactly
what the app writes. (The pre-shaped `record_*` sections above remain for the types with richer rules.)
The same declaration lives on its own as a *record shape* (`kind: RecordShape`, `shapes/*.yaml`): a resource
type and its fields under a stable id, kept in the registry as versioned items with a lifecycle of their own
(draft → published → deprecated; authors create and revise, approvers and admins publish) and edited,
previewed and published in the panel's *Record shapes* section. A `record` section then says `shape:
measurable_goal` instead of declaring the fields: the compiler embeds the published shape's rules and pins
its checksum in the manifest, so every app writes the same reviewed thing and keeps the version it was built
with when the shape moves on. The assistant lists the published shapes (`list_record_shapes`) and offers
one before designing fields by hand; a reference to a shape nobody has published is refused where it is
made. "Open as an app" on a published shape starts a draft with the resource on record beside the form. Beyond the
admitted kinds, the platform *opens* to administrators every resource type of FHIR R4 that is about a patient and that
it does not refuse by name (`src/fhir/kinds.ts` — a rule, not a list; 18 kinds today: Flag, FamilyMemberHistory,
ClinicalImpression, CareTeam, Immunization, …): a shape for one of them declares the stamps the platform would otherwise
know, only an administrator may define it, apps write it only through the published shape, and the review page marks
the write as a kind the platform did not vet. The kinds with teeth — prescriptions and orders, scheduling, identity,
billing, anything computed, the kinds with a tailored section of their own — are refused by name with a reason
(`src/fhir/closed-kinds.json`, the only list).
Every write is an action → write primitive; the change is versioned (a stale version is
refused), attributed to the signed-in person and leaves a Provenance; what the clinician typed is
kept to the fields the form has (code, the offered choices, dates in the past, a remark) and the rest
— status, subject, recorder, recorded date, category — is stamped by the platform. Every section
carries its own settings, a `span` (4, 6, 8 or 12 of 12) and an optional role gate.

Stacked, consecutive sections share a row while their spans fit — 8 + 4, 6 + 6, 4 + 4 + 4 — and a
full-width or role-gated section takes a row of its own; as tabs, each section is one tab and a
gated tab is absent from the strip for other roles. Gating works exactly as in the named archetypes:
the section's primitives carry `only_for_roles`, the node `show_only_if_role_in`, and each role's
data scope is derived from its part of the page — a viewer never requests what only the reviewer
sees.

Requests — *"The blood pressure trend with the current medication beside it, and the kidney values
and the problem list underneath."* · *"Eine Seite für den Pflegetermin — Kennzahlen, der
Verlaufsbogen und für die Pflegeleitung die Akte selbst."*

Context: `patient_id`; `window_start` when any section is windowed (one window for the page).
Data: per section — `observation.by_code`, `query` (Condition, MedicationRequest, or the resource
of a details section, QuestionnaireResponse, Task, Media, Goal, CarePlan), `dicom.studies.for_patient`, `questionnaire.read`,
and the writes behind actions: `write.fhir.questionnaire_response.submit`, `write.fhir.observation.create`,
`write.fhir.condition.create`, `write.fhir.allergy_intolerance.create`, `write.fhir.procedure.create`,
`write.fhir.task.create`, `write.fhir.task.update_status`, `write.fhir.media.create`, `write.fhir.record.create`,
`write.fhir.condition.update_status`, `write.fhir.medication_request.update_status`.
Layout: identity (`PatientBanner`, its compact form, `PatientHeader`, or none) → rows of
`TwoColumn` / `Grid`, or `Tabs`.
Knobs: `sections[]`, `arrangement` stack | tabs, `identity`, `window`.
Fixtures: `specs/composed-consultation.yaml` (rows, a reviewer-only imaging section),
`specs/composed-nurse-visit.yaml` (tabs, an assessment, a lead-nurse-only record tab),
`specs/composed-record-review.yaml` (allergies, visits, reports, letters, procedures, immunizations and
a laboratory list with named columns), `specs/composed-ward-entry.yaml` (a blood-pressure entry form
beside the trend, resolvable problems, stoppable prescriptions), `specs/composed-ward-documentation.yaml`
(the three coded entries, each beside the list it adds to), `specs/composed-falls-course.yaml` (a form's
answers charted — the timed up-and-go across falls screens — beside the last screen).
Limits: the section kinds are the whole vocabulary — a part no kind covers is a catalog gap, not
a composition problem; all sections are about the patient in context (cohorts and KPI tiles are
not composable yet); one window per page. Named archetypes come first when they fit, because they
carry tuned defaults; compose when the request mixes their parts.

### APP-13 · Worklist

The open tasks of a ward or a team across patients: which patient, what is to be done, by when, how
urgent, who has taken it — overdue first, with a *Mine / Everyone* switch. Tasks are FHIR `Task`
resources carrying the author's own task vocabulary as their code (`urn:medapp:task`, e.g.
`falls_screen` "Falls risk screen"); they come from a `create_task` section on a patient page
(APP-12) or from another system that writes Tasks with the same codes. A row is **started**,
**completed** or (when allowed) **cancelled** right here — `write.fhir.task.update_status`, a
versioned status change the record keeps: whoever moves a task on becomes its owner, completion is
timed, a remark is attributed, a Provenance is left — and can **open the patient** in another app
of the registry (`open_in`). The patient page's `tasks` section is the same list for one patient,
with the same row actions; `create_task` puts a new task on it: a kind from the fixed list, a
priority the form offers, a due date (today or later), a line of description — `write.fhir.task.create`,
with status `requested`, intent, requester and times stamped by the platform.

Requests — *"A worklist for the ward — every open falls screen, discharge letter and follow-up call
across our patients, overdue first; the nurse takes a task on and completes it."* · *"Eine
Aufgabenliste für die Station — alle offenen Sturzrisiko-Screenings, Arztbriefe und Rückrufe,
überfällige zuerst."*

The second **source** derives the work from the record instead: `source: assessment_due` lists *who is
due an assessment* — the members of a cohort (a coded diagnosis, or everyone assessed before) against
their latest QuestionnaireResponse to one Questionnaire, every N days (`data.cohort.assessment_due`):
never assessed first, then the longest overdue, then due today, then upcoming within a window. "Who
on the ward is due a falls screen" is this list with the falls-risk form's canonical URL and the ward's
cohort. It has no row actions: doing the assessment (in the app a row opens) is what clears a row.

Context: none (a cohort read); the row link supplies `patient_id` to the app it opens.
Data: `data.task.worklist` (Task search by status and code, one Patient read per member, ordered
overdue → due date → newest) and the write `write.fhir.task.update_status` behind an action; or
`data.cohort.by_condition` → `data.cohort.assessment_due` (QuestionnaireResponse search per member).
Layout: `Grid` of `StatCard`s (open, overdue, data scope — or due, never assessed, overdue) → `Worklist` or `AssessmentDueList`.
Knobs: `source` tasks | assessment_due, `due {questionnaire, every_days, label, cohort {codes, clinical_status, label}, upcoming_days}`, `codes[]` (empty = every task), `statuses[]`, `title`, `complete`, `cancel`, `mine`, `open_in`, `cards`.
Fixtures: `specs/ward-worklist.yaml`, `specs/htn-assessment-due.yaml`; the patient side is `specs/composed-ward-tasks.yaml`.
Limits: a worklist lists — it does not schedule, remind, notify or recur; a task list shows Tasks a form or another system wrote, a due list counts answers to one questionnaire (an assessment recorded any other way does not count, and without a cohort nobody can be "never assessed"); ownership is by person, not by team, and there is no reassignment; the transitions are start, complete and cancel — no edits of due date or priority, no comment thread.

---

## 3. Patterns that apply to any archetype

**Role differentiation.** Declare two or more roles with scopes that `inherit`; give the reviewer
extra resources and a wider `phi_fields_visible`; gate sections with `show_only_if_role_in` and
their primitives with `only_for_roles`. A viewer then never even requests the reviewer's data.
(`bp-trend.yaml` demonstrates this.)

**PHI minimisation.** `PatientBanner` shows only the fields in the effective scope; a cohort app
typically allows `name, dob, mrn` and nothing else. `PatientHeader` (Medplum stock) should be used
only where the role sees full PHI.

**Time windows.** Any `since` or `window_start` accepts `now-<n>d|m|y`; the default lives in
`context_inputs`, so the same app can be launched with a different window.

**Selection interaction.** A list component writes to `$ui.<key>`; another component reads it. Today
this connects `ImagingStudyList` and `DicomViewer`; it is the mechanism future master–detail
components will use.

**Counts without computation.** `$bindings.<list>.length`, `$bindings.cohort.count` and
`above_threshold_count` feed `StatCard` values.

**Layout vocabulary.** Tabs (many views, one at a time), TwoColumn (chart beside table, list
beside detail), Grid (tiles, several charts), Section (titled group). All display components can be
placed in any layout container.

---

## 4. The parameter space

| Knob | Where | Range |
|---|---|---|
| Observation codes | `observation.by_code.codes`, `query.params.code`, timeline `series` | any LOINC code (optionally `system|code`); panels via `component_code` |
| Condition codes | `cohort.by_condition.condition_codes`, `query.params.code` | any SNOMED CT or ICD-10-GM code — a German hospital record codes diagnoses in ICD-10-GM, the synthetic record in SNOMED; the catalog's `terminology.record_notes` tell the builder which to prefer |
| Procedure codes | `query.params.code` on Procedure, `list` sections | OPS on the hospital's record |
| Medication codes | `query.params.code` on MedicationRequest | ATC or other coding present in the record (a record may hold none) |
| Time window | `since`, `context_inputs.window_start` | ISO date or `now-Nd/m/y` |
| Thresholds | timeline `thresholds`, cohort `threshold` | any numeric value; timeline: any number of lines; cohort: one, "≥" |
| Modalities | `dicom.studies.for_patient.modalities` | DICOM modality codes (CT, MR, DX, US, …) |
| Roles and PHI | `auth.roles`, `data_scopes.*.phi_fields_visible` | any role set; fields ⊆ name, dob, gender, mrn, address, phone, email |
| Result limits | `count`, `max_rows` | ≤ 1000 per primitive; table default 50 |
| Layout | component tree | any nesting of the six layout components |

Any code works at runtime; what the builder can *name* from a clinician's words is another matter. The
hints in `terminology.common_codes` (this file's YAML twin) cover a few dozen concepts; in a deployment
connected to a record, the builder also searches the **record's vocabulary** — every distinct code on the
FHIR server with the display texts the hospital uses, counts and patients, read by the data source's seed
at deploy and nightly (`infra/lambdas/dispatcher/vocabulary.py`, `infra/app_creator/vocabulary.py`) — so a
German lab name or an ICD-10-GM diagnosis the hints never listed still resolves, a hint the record does
not carry is reported as such, and a code found through a hint comes with the other codings the record
puts on the same resources — the bridge from a SNOMED hint to the hospital's ICD-10-GM. The hints remain for what the record cannot supply: panel components,
units for charts, the thresholds of the templates.

---

## 5. Not supported in v0 (refused by the renderer or absent from the catalog)

Requests in these areas should be answered with "not in the catalog yet" and routed to catalog
planning, not approximated. The right-hand column names the platform addition that would unlock each.

| Request type | Why it is refused today | Would require |
|---|---|---|
| Ordering, prescribing new medication, importing existing image files or DICOM, free editing of clinical content, deleting records | writes are confined to what can be validated: a form (APP-11), a coded measurement within a declared range, a coded entry — diagnosis, allergy, procedure, a photo by kind, a task — from a list the author fixed, a status within an allowed set (APP-12 `record_observation`, `record_problem`, `record_allergy`, `record_procedure`, `record_photo`, `create_task`, `problems.resolve`, `medication.stop`) — each versioned, attributed, with a Provenance | further `write.*` primitives, each with its own scope operation and sign-off; orders/prescriptions likely IIa territory |
| Free-text patient search or lookup by name | no search primitive; patient comes from SMART launch or the panel | `data.fhir.patient.search` + a search component |
| AI summaries, extraction, "explain this chart" | no `llm.*` primitives yet (stretch goal) | `llm.summarise` with Bedrock Guardrails and reviewer gate |
| Risk scores, BMI/MAP/eGFR calculation, trends "improving/worsening", any derived value | lookup-only expression language; no computation | CEL escape valve (stretch) and/or computation primitives — regulatory review first |
| Cohorts by age, sex, medication, encounter, observation value, or combined criteria | only `cohort.by_condition` exists | additional cohort primitives |
| "Below" thresholds in cohort tables | `above_threshold` is ≥ only | threshold operator in the primitive |
| Bar, pie, scatter, per-cohort charts | only `ObservationTimeline` (line, single patient) | further chart components |
| Schedules, appointments, reminders, notifications | no scheduling or notification primitives — tasks and worklists *are* supported (APP-13, APP-12 `tasks` / `create_task`), but nothing recurs and nobody is paged | Appointment / Schedule primitives; a notification channel with its own sign-off |
| Structured reporting, PDF/CSV export, printing | `report` intent class is unrealised; `ui_capabilities` are declarative only | export primitive + template artifacts |
| Image measurement, annotation, hanging protocols | OHIF is embedded read-only | OHIF extension surface in the DicomViewer contract |
| Free-form text, HTML, custom colours or branding | layout nodes carry only catalog components and their props; unknown keys fail validation | none — by design |
| Cross-hospital or multi-tenant views | one deployment per hospital | none — by design |

---

## 6. Intent triage for the planning pipeline

| Signal in the request | Route to |
|---|---|
| one patient, "overview / summary / what should I know" | APP-01, or APP-07 if brevity is stressed |
| one patient, a measurable value "over time / trend / course" | APP-02 (compose APP-06 if a disease and medication are named) |
| one patient, "all values / table / flowsheet" | APP-03 |
| one patient, "problems / diagnoses / medication" only | APP-04 |
| one patient, "images / scans / CT / MR / studies" | APP-05 |
| one patient, "the full record / raw resource / latest report" | APP-08 |
| "all patients with …", "registry", "how many", "who is above", "who have had a CT / MRI" | APP-09 or APP-10 |
| one patient, "form / assessment / checklist / questionnaire", "save to the record" | APP-11 |
| one patient, "photo / wound photo / take a picture / Wundfoto" | APP-12 — `photos` + `record_photo` sections |
| one patient, "set a goal / therapy plan / care plan / write a note / record a visit" | APP-12 — `record` section with the resource (Goal, CarePlan, DocumentReference, Encounter) and declared fields, plus a `list` of it |
| one patient, parts of several kinds "beside / underneath / on one page / and also" | APP-12 — compose from sections; a named archetype when one fits on its own |
| one patient, "allergies / visits / reports / letters / procedures / immunizations", or any other list of records | APP-12 — the matching section kind, or a `list` with named columns |
| one patient, "record / enter a blood pressure or weight", "mark resolved", "stop the medication" | APP-12 — `record_observation`, `problems.resolve`, `medication.stop` |
| orders, prescriptions, edits or deletions of existing records; any calculation or score; AI summary; search by name; export | refuse — section 5 |
| intent class `report`, `search` | refuse — no primitives or components realise these yet |

Reference manifests for four of the archetypes are in `manifests/` and pass the render tests in
`src/tests/manifests.test.tsx`, which is the executable definition of "supported".
