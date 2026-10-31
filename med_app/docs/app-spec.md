# AppSpec and the compiler

The drafting conversation does not write manifests. It produces an **AppSpec** — a small, typed
document — and a deterministic **compiler** turns a complete spec into an `AppManifest`. The agent
edits the spec through tools; the compiler, the manifest schema and the catalog decide what comes
out. This keeps the generated part of an app where it can be verified once: in code with tests, not
in a prompt.

```
conversation ──tools──▶ AppSpec ──compile──▶ AppManifest ──validate──▶ registry draft
                          ▲  readiness()                      (same zod schema the renderer uses)
                          └── "what is still unclear" drives the agent's questions
```

Code: `src/spec/` · fixtures: `specs/*.yaml` · JSON Schema for other languages: `docs/app-spec.schema.json`
· CLI: `npm run appspec -- <command>` · tests: `src/tests/specCompiler.test.ts`.

## The spec

```yaml
apiVersion: medapp.eu/v1
kind: AppSpec
app:            { app_id, version, parent_version?, name, description?, language }
archetype:      APP-02                       # which kind of app — one of the catalog's archetypes
knobs:          { … }                        # that archetype's parameters (see below)
roles:                                       # who may use it, and what identity fields each sees
  - { id, display_name, group: {kind: app_group | existing, name?}, inherits?, phi_fields_visible: [...], capabilities }
default_role:   viewer                       # what blanket-access users get
governance:     { clinical_context, intended_users, intended_purpose, mdr_classification, data_categories? }
```

Three things are deliberately *not* in the spec. FHIR operations — the data scope of a role is
derived from the primitives its part of the app runs, never typed in. Layout — the archetype
decides it from the knobs. Lifecycle — state, sign-off and provenance belong to the registry.

The knobs are per archetype and are the only part that differs between kinds of app:

| Archetype | Knobs (defaults in brackets) |
|---|---|
| **APP-01** Patient summary | `identity` header \| banner [header], `arrangement` tabs \| stack [tabs], `window` [now-2y], `sections[]` in display order: `problems {status, label, title}`, `medication {status, label, title}`, `vitals {codes, label, title, rows}`, `record {label, title}` |
| **APP-02** Longitudinal trend | `codes[]` requested, `series[]` plotted (`label` + `code` or `component_code`), `thresholds[]`, `unit`, `by_side` [false] (one line per side of the body), `compare` [false] (first against latest under the chart), `window` [now-2y], `max_observations` [500], `chart_title`, `chart_height_px` [380], `readings_title`, `readings_rows` [10], `column_ratio` [8,4], `conditions_section {roles, title, description, list_title}` (role-gated) |
| **APP-03** Observation flowsheet | `groups[]` (`label`, `codes[]`, `title`, `rows` [40]) — one tab each when several, `window` [now-1y], `compact` [true] |
| **APP-04** Problems & medication | `identity` header \| banner [banner], `arrangement` side_by_side \| stacked, `problems {status, title}`, `medication {status, title}` |
| **APP-05** Imaging review | `modalities[]` [CT, MR, DX, US] (also the role's DICOM scope), `list_title`, `viewer_height_px` [560], `column_ratio` [5,7], `viewer_layout` stack \| mpr \| volume [stack] |
| **APP-06** Disease follow-up dashboard | `template` hypertension_follow_up \| diabetes_follow_up \| ckd_monitoring fills the clinical knobs (series, thresholds and their guideline source, ATC therapy classes, SNOMED + ICD-10-GM condition codes); explicit knobs win: `codes[]`, `series[]`, `thresholds[]`, `thresholds_source`, `unit`, `window` [now-2y], `chart_title`, `chart_height_px`, `readings_title`, `readings_rows` [8], `medication {codes[], status, title}`, `conditions {codes[], title}` |
| **APP-07** Pre-consultation snapshot | `vitals_codes[]`, `window` [now-90d], `rows` [8], `cards {problems, medication, readings}` — counts are list lengths |
| **APP-08** Resource inspector | `panels[]`: `{kind: patient, label, title}` or `{kind: latest, resource, id, label, title, params}` (the most recent instance of a type, by index) |
| **APP-09** Cohort register | `condition {codes, clinical_status, label}`, `imaging? {modalities[] (CT, MR, …; empty: any), within? (now-2y), min_studies [1], label, card_label?, open_in? (app_id of a published APP-05 app)}` — narrows membership to patients with imaging on record (`data.cohort.with_imaging`); the table gains the study count and the latest study per member and, with `open_in`, an "Open imaging" link —, `value? {codes, component_code, name, unit, threshold, label, range? {min, max, step [1], default [low, high], label, card_label}}` — the range is a client-side slider over the compared value: a `RangeFilter` writing `$ui.cohort_range`, a `CohortRangeCard`, and the table filtered by it —, `cards {count_label, count_hint, threshold_label, threshold_hint, scope_card}`, `table_title`. At least one of `imaging` and `value` |
| **APP-10** Cohort KPI tiles | APP-09's `condition`, `imaging`, `value` and `cards`; no member table |
| **APP-11** Structured assessment | `questionnaire` (canonical URL of a form on the record — the catalog lists the available ones) **or** `form {id, title, description?, items[] {id, text, type text\|long_text\|integer\|decimal\|boolean\|date\|choice\|multiple_choice\|heading\|note, required?, unit?, min?, max?, options[] {display, code?, system?}, show_when? {question, is \| is_not \| answered \| at_least \| at_most} (one or a list that must all hold; on a heading, for the whole section), as_observation? {system, code, display?} (a number also written as an Observation on submission — the item's code and SDC's observationExtract marker on the Questionnaire, `extract` on the submit primitive, Observation.create in the scope), items[] (under a heading)}}` — a form designed in the conversation, compiled into a FHIR Questionnaire the app carries (`artifacts.questionnaires`, canonical `https://<hospital>.medapp.eu/Questionnaire/<app-id>.<form-id>`; `min`/`max` → `minValue`/`maxValue`, an option's `system` + `code` → the `answerOption` coding, `show_when` → `enableWhen` typed after the target, `enableBehavior: all` for a list) and written to the record at publish —, `action_label`, `success_message`, `confirm`, `form_title`, `submissions_title`, `column_ratio` [7,5]; the write runs only through the app's action, and a role needs a capability beyond `view` |
| **APP-12** Composed page | `identity` banner \| compact_banner \| header \| none [banner], `arrangement` stack \| tabs [stack], `window` [now-2y], `sections[]` in display order — each `{kind, id?, label?, span 4\|6\|8\|12 [12], roles?}` plus its own settings: `trend {codes, series, thresholds, thresholds_source, unit, title, height_px, by_side (one line per side of the body, from bodySite laterality), compare (under the chart, first and latest value per series and side with dates and the difference — `ObservationComparison`)}`, `form_trend {questionnaire | form, questions[] {link_id, label}, unit, thresholds, thresholds_source, title, height_px}`, `latest_answers {questionnaire | form, title}`, `readings {codes, title, rows, compact}`, `problems {status, codes?, title}`, `medication {status, codes?, title}`, `imaging {modalities, list_title, viewer_height_px, ratio, layout stack\|mpr\|volume}`, `assessment {questionnaire | form, action_label, success_message, confirm, form_title, submissions, submissions_title, ratio}`, `details {resource, params, title}`, `counts {problems, medication, readings_codes?}`, `record_observation {code, components[] {code, label, range}, unit, range, rules[] {component, above} (blood pressure: systolic above diastolic by default), category, title, action_label, success_message, confirm, max_backdate_days, note, side none\|optional\|required (left, right or both → bodySite, SNOMED laterality 7771000 / 24028007 / 51440002), body_site (the structure, a second bodySite coding), conditions[] (test conditions → method)}`, `record_problem {codes[], verification[], category, onset, severity, note, title, action_label, success_message, confirm}`, `record_allergy {codes[], types[], categories[], verification[], criticality, reaction, onset, note, …}`, `record_procedure {codes[], statuses[], max_backdate_days, body_site, outcome, note, …}`, `tasks {codes[]?, statuses[], title, complete, cancel}`, `create_task {codes[] {code, display}, priorities[], due, description, title, action_label, success_message, confirm}`, `photos {kinds[]? {code, display}, title, rows}`, `record_photo {kinds[] {code, display}, body_site, note, max_size_kb, max_backdate_days, title, action_label, success_message, confirm}`, `record {shape (a published record shape, by id) **or** resource Goal\|CarePlan\|Encounter\|DocumentReference\|Consent + fields[] {id, label, type text\|long_text\|number\|integer\|date\|datetime\|boolean\|code\|choice, path, required, unit, range, past_days, future_days, max_length, codes[], options[], system} + status, title, action_label, success_message, confirm}` (every path checked against the FHIR definitions; status/subject/author/dates are stamped, never fields; with `shape` the library's rules are embedded and pinned by checksum — see *Record shapes* below), `problems.resolve` / `medication.stop` (+ `resolve_label` / `stop_label`), `allergies {status, title}`, `encounters {title, rows}`, `reports {category?, title, rows}`, `notes {type?, title, rows}`, `procedures {title, rows}`, `immunizations {title, rows}`, `list {resource, params?, columns[] {label, path, status?}, title, rows, empty_text?}`; consecutive spans that fit share a row, a gated section takes its own |
| **APP-13** Worklist | `source` tasks \| assessment_due [tasks]; for assessment_due: `due {questionnaire, every_days, label, cohort {codes[], clinical_status, label}?, upcoming_days [0]}` (a cohort read `data.cohort.by_condition` → `data.cohort.assessment_due`, no row actions); for tasks: `codes[] {code, display}` (empty = every open task), `statuses[]` [requested, in-progress], `title`, `complete` [true], `cancel` [false], `mine` [true], `open_in` app_id, `cards {open_label, overdue_label, scope_card}`; a cohort read (`data.task.worklist`) plus the row write `write.fhir.task.update_status` behind an action; the role's scope is `Task` search/update + `Patient` read, patient scope cohort |

Codes are objects — `{ system: loinc | snomed | atc | icd10gm | ops | <url>, code, display? }` — so the compiler
can write fully qualified `system|code` tokens into primitive configs and data scopes (`icd10gm` is
`http://fhir.de/CodeSystem/bfarm/icd-10-gm` and `ops` `http://fhir.de/CodeSystem/bfarm/ops`, the German
hospital codings German hospital records use for diagnoses and procedures; `src/spec/terminology.ts`). Display
texts have deterministic defaults ("HbA1c, last five years"; "Patients with active hypertension";
"Name, date of birth and MRN visible; no contact details") and may be overridden — this is where an
agent writes German or a clinician's preferred wording. Nothing else the agent says lands in the
manifest.

## Record shapes — a second document kind

A `record` section can declare its fields inline, or name a shape from the library: `shape: measurable_goal`. A shape
is its own document (`med_app/shapes/*.yaml`, `src/spec/shapes.ts`):

```yaml
apiVersion: medapp.eu/v1
kind: RecordShape
shape:
  id: measurable_goal          # stable — apps refer to it
  name: Measurable goal
  description: A therapy goal bound to a measurement …
  resource: Goal               # Goal | CarePlan | Encounter | DocumentReference | Consent
  status: active               # stamped by the platform, never a field
  fields: [ … the same fields a record section declares … ]
```

`compileShape(doc)` runs the record section's checks (`shapeIssues`) and returns an **artifact**: `{ id, name,
description, resource, fields, status, rules, checksum }` — `rules` being exactly what `recordRules` would produce for the
inline form (fields with their encodings, the stamps), `checksum` an FNV-1a 64 over the canonical document. A compile
takes the library as an option (`compileSpec(spec, { shapes: shapeLookup(artifacts) })`, `readiness(spec, { shapes })`;
CLI `--shapes <dir|file>`; the Lambda's `shapes` in the request): a `shape:` reference resolves to the artifact's rules
and the manifest's `write.fhir.record.create` carries `shape: { id, checksum }`, so an app keeps the version it was
compiled with whatever the library does later. A reference to a shape the library has not published is a readiness
issue (`no published record shape "x" — the library has: …`). The registry stores shapes as versioned items with their
own lifecycle (`infra/docs/registry-table.md`); the panel's *Record shapes* section edits, previews (a synthetic
composed page around the shape, `src/panel/shapes/`) and publishes them; `loadBundledShapes()` is the mock registry's
library and what the bundled fixtures compile against.

**Kinds.** A shape names one of the kinds the platform admits — `RECORD_RESOURCES`: Goal, CarePlan, Encounter,
DocumentReference, Consent — whose stamps (status, patient, author, dates) the platform knows; or one of the kinds it
*opens to administrators*. Which kinds those are is a rule, not a list (`src/fhir/kinds.ts`): every resource type of
FHIR R4 that is **about a patient** — its `subject` or `patient` element is a Reference to Patient, computed from the
definitions by the extraction script (`patient_scoped`, 54 types) — and that the platform neither admits nor refuses is
open (`OPEN_KINDS`, 18 today: AdverseEvent, BodyStructure, CareTeam, ClinicalImpression, Communication, Composition,
DetectedIssue, DeviceUseStatement, DiagnosticReport, DocumentManifest, EpisodeOfCare, FamilyMemberHistory, Flag,
Immunization, List, MedicationStatement, MolecularSequence, Specimen). For such a kind the shape declares the stamps
itself (`stamps: [{path, value}]`, a literal or `$patient` / `$author` / `$now` / `$today`; it must name the patient,
every stamp must land on an element of the right type, and the resource's required elements must be covered by a stamp
or a required field). Only an administrator may create or revise such a shape (the write API and the panel refuse
others), the artifact is marked `open_kind`, the manifest's write carries the mark and the review page says so. The
refusals are the only list — `src/fhir/closed-kinds.json`, a name and a reason each, reviewed like code (`CLOSED_KINDS`:
prescriptions and orders, scheduling, identity, billing, anything computed, the kinds that have a tailored section of
their own, and what the platform writes itself — Provenance, AuditEvent); the reason is what the author reads. Opening a
kind is therefore nobody's code change; refusing one is a line in that file. The open kinds' element paths ship lean in
`src/fhir/open-kind-definitions.json` (path, cardinality, types — 52 KB), generated by the same extraction script, and
every open kind is queryable on both sides: `npm run export:kinds` writes the outcome of the rule (admitted, open, closed,
`query_resources`) to `infra/lambdas/dispatcher/data/record-kinds.json`, which `primitives.py` reads instead of naming
any kind — a test on each side fails when the file lags the rule. Inline `record` sections stay with admitted kinds; an
open kind reaches an app only through a published shape.

The library hands each artifact over with its registry `version`, and the compiler puts a **tag** into the write's
config — `{ system: https://<hospital>.medapp.eu/CodeSystem/record-shape, code: <shape id>, version: <version, or the
checksum for an artifact without one>, display: <name> }` — which both executors stamp as `meta.tag` on every record
written with the shape. So a record says on itself which shape, which version, produced it, and
`GET /Goal?_tag=<system>|measurable_goal` finds all of them across apps without going through our audit trail.

What a shape is *not*, by decision (2026-10-15): a FHIR `StructureDefinition` published to the server. The artifact
holds everything a profile would (resolved element paths, cardinalities implied by `required`, bindings implied by
`codes`/`options`, the fixed status), so a profile generator is a pure function over it whenever the hospital wants
one — for other systems to validate against or to share the definitions — but nothing consumes such a profile today, the
servers in play do not validate against profiles on write, and the registry (artifact, checksum pinned in the manifest,
signed version) already governs the definition. The tag, not a `meta.profile` claim, is what records carry, because a
profile claim naming a definition the server does not hold is what a strict validator would one day reject.

## What the compiler does

For every archetype, identically: roles → `auth` (`cognito_group` is `app-<app_id>-<role>` for an
app group, or the existing group's name) and `data_scopes` (`scope_<role>`; PHI list in canonical
order; FHIR entries merged per resource from the role's primitives; a role that `inherits` lists
only its additions); governance → `audit` (`data_categories` derived unless given); `metadata` from
the app section plus `hospital_id` and `created_at` supplied by the caller; a `draft` lifecycle with
the compiler version as provenance. Per archetype: the primitives and the layout under the standard
`PageShell`. The result is passed through `validateManifest` before it is returned — a failure
there is a compiler bug, not a spec problem.

`readiness(spec)` is the deterministic "is this clear enough?": every schema problem of a partial
draft is an open point (`roles: is required`, `knobs.value: is required`), every archetype check a
contradiction (`identity "header" shows all fields but the role masks some`). A designed form adds
its own (`src/spec/forms.ts`): a range on a non-number, `max` below `min`, a decimal range on an
integer, a terminology code without its system, a condition on a question the form does not have or
on a heading looking at a question inside it, a condition whose value does not fit the target (`is: true` on a number, an option
the choice does not offer). The agent asks only about those, and `ready` is true exactly when the
spec compiles.

## The golden rule

`compile(specs/<name>.yaml)` must equal `manifests/<name>.yaml` for every reference manifest, byte
for byte after canonicalisation (lifecycle excluded). The hand-authored apps we trust are therefore
the compiler's specification; if a block or an archetype changes, that test says so. Archetypes that
have no hand-authored manifest (APP-03/04/06/07/08/10) are pinned the other way round: their fixture
compiles to a checked-in golden under `specs/expected/`, which a compiler change must regenerate
deliberately (`npm run appspec -- compile specs/<name>.yaml`). Every fixture is also rendered by the
real renderer against the synthetic record, with no unresolved references allowed.

## Adding an archetype (a platform release)

1. `src/spec/archetypes/<name>.ts`: a knobs schema (zod, closed objects, `.describe()` on every
   field — it becomes the agent's documentation), `check()` for knob/role contradictions, `build()`
   composing blocks from `src/spec/blocks.ts`.
2. Register it in `src/spec/archetypes/index.ts` and add its variant to `AppSpecSchema` in
   `src/spec/appSpec.ts`.
3. A fixture in `specs/` and its golden — a reference manifest in `manifests/` when one is hand-authored,
   otherwise the compiled output in `specs/expected/` — plus the golden test and the render check.
4. The archetype entry in `docs/application-catalog.yaml` (its `knobs` should name the same knobs).
5. `npm run appspec -- schema --out docs/app-spec.schema.json` — the test fails until you do.
