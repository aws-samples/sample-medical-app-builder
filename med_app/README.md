# med_app — manifest-driven clinical app runtime

The browser half of the "clinicians describe an app, the platform renders it" prototype.
An app is **data** (a YAML manifest), never LLM-authored code. This project is the deterministic
renderer for those manifests plus the design-system catalog it renders from, wired to Cognito
for sign-in and to Medplum React for FHIR-correct display components.

```
manifest (YAML) ──validate──▶ data plan (primitives) ──execute──▶ bindings ──render──▶ React tree
                 zod, strict   scope-checked, audited   $bindings.*    catalog only
```

## Quick start

```bash
npm install            # .npmrc sets legacy-peer-deps (npm 10 hits an arborist bug otherwise)
cp .env.example .env   # already present with mock defaults for local work
npm run dev            # http://localhost:5173
```

Sign in with any username in mock mode. Append roles to hold them for every app, e.g.
`dr.hoffmann+viewer,reviewer`; a platform group named as is — `ada+medapp-admins` — is held as that group, which
opens the administrator's user management and audit trail. Pick a synthetic patient, open an app.

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest: manifests validate + render, refusals, roles, expressions
npm run build          # tsc + vite build → dist/
```

## Configuration (`.env`, or `config.json` when deployed)

| Variable | Values | Purpose |
|---|---|---|
| `VITE_HOSPITAL_ID` | string | Deployment id; matches `metadata.hospital_id` in manifests |
| `VITE_AUTH_MODE` | `cognito` \| `mock` | Real Cognito user pool (SRP sign-in, new-password challenge, "Forgot your password?" recovery by emailed code) or dev-only mock (any credentials; any six-digit recovery code) |
| `VITE_COGNITO_REGION`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID` | | The hospital's user pool (one per hospital) |
| `VITE_REGISTRY_MODE` | `local` \| `remote` | The bundled seed set of `VITE_HOSPITAL_ID` (`manifests/<hospital_id>/*.yaml`; every set for an id without one), or the registry API over the hospital's DynamoDB table (`GET {base}/registry/apps`) |
| `VITE_DATA_MODE` | `mock` \| `dispatcher` | In-browser synthetic FHIR (`@medplum/mock`) or the primitive dispatcher (API Gateway → Lambda) |
| `VITE_API_BASE_URL` | URL | The deployment's HTTP API (`/registry/*`, `POST {base}/primitives/{kind}`, `/drafts/*`, `/users/*`, `/audit`) |
| `VITE_OHIF_VIEWER_URL` | URL | OHIF deployment for `DicomViewer`; empty renders study metadata instead |
| `VITE_OHIF_DATA_SOURCE` | name | The viewer data source studies open from (`/viewer/<name>`); default: the viewer's own default on real data, `reference` — the synthetic record's PACS — in mock data mode. Previews always use `reference`, whatever the deployment |
| `VITE_AGENT_MODE` | `offline` \| `replay` | Mock mode only: what answers in the drafting chat — nothing (the chat explains there is no model), or a recorded session replayed turn by turn (`src/authoring/replay/bp-trend.json`, the README's video) |
| `VITE_BRANDING` | JSON | The hospital's look over the defaults of `src/branding.ts`: `{"palette":{"accent":"#1F5FA8"},"logo":{"src":"/branding/logo.svg","alt":"…"}}` — any subset of the ten colours, and/or a logo. Written by the infrastructure from `infra/hospitals/<id>.json`; in `.env` it previews a hospital's look (single-quote the value there, or dotenv cuts it at the first `#`). A malformed value is reported and ignored |

Misconfiguration is reported on the sign-in screen with the exact variable to fix.

Development reads these from `.env`. The deployed panel (S3 + CloudFront, `infra/stacks/hosting_stack.py`)
fetches the same keys from `/config.json` before it starts — written by the infrastructure at deploy with
that hospital's pool, client and API URL — so one build serves any deployment and no `.env` is baked in.

A build also knows which build it is (`__BUILD_ID__`, defined in `vite.config.ts`) and writes the same id to
`/version.json` next to the bundle. A panel left open across a deploy checks the served id when it comes back
into view (and every ten minutes) and offers a reload when it differs (`src/panel/UpdateNotice.tsx`): the
registry it keeps polling may by then carry manifests its own, older schema refuses — the launcher names such
a refusal (only unknown keys) as the newer platform's work and points at the reload.

## Where things live

```
showcase/<hospital_id>.yaml   a hospital's seed set: its apps (spec → sign-off note) and the collections that group them
manifests/<hospital_id>/      that set compiled (npm run showcase) — the local app registry, what the seed script writes to DynamoDB
specs/                        AppSpecs — the seed apps' sources, the compiler fixtures; what a drafting conversation produces
shapes/                       the bundled record shapes (kind: RecordShape: a measurable goal, a progress note, a consent decision per purpose, a patient alert — the example of an administrator-defined kind) — the mock library's published seed; src/spec/shapes.ts compiles them
src/spec/                     AppSpec schema, readiness check, archetype functions, blocks, spec → manifest compiler, CLI; forms.ts — a form designed in the spec → FHIR Questionnaire
src/manifest/schema.ts        AppManifest v0 as a zod schema + cross-field integrity checks
src/manifest/artifacts.ts     the FHIR definitions an app carries (its own Questionnaires), as a constrained schema
src/manifest/roles.ts         Cognito groups → roles; inherits → effective data scope
src/manifest/registry.ts      loads + validates the configured hospital's manifests/<id>/*.yaml (rejections are shown, not hidden)
src/renderer/expressions.ts   the only dynamic syntax: $bindings/$context/$metadata/$auth/$ui lookups
src/renderer/ManifestApp.tsx  runs primitives in order, enforces scope, writes audit records
src/renderer/RenderNode.tsx   layout node → catalog component; unknown names render a refusal
src/primitives/catalog.ts     UI catalog v0 (the whitelist)
src/primitives/data/          data primitive catalog, mock executor, dispatcher executor, seed data
src/primitives/ui/            design-system components wrapping @medplum/react
src/primitives/layout/        PageShell, TwoColumn, Grid, Section, Tabs/Tab
src/medplum/MedplumShell.tsx  MedplumProvider + StructureDefinition indexing (offline, both modes)
src/auth/                     Cognito (amazon-cognito-identity-js) and mock providers, sign-in screen (first-sign-in challenge, password recovery)
src/panel/                    the panel: PanelShell (top bar + the staff sidebar — App registry · Record shapes · Components and data primitives · User management · Audit trail), launcher, app runtime shell (role switcher, audit drawer, lifecycle), catalog page, drafting page, user management and audit trail (admins)
src/panel/shapes/             the Record shapes section: the library list with "How the library grows" (an author's steps beside the platform's steps to admit a resource type; the admitted types read from the engine), one shape's editor (YAML with the compiler's live checks, the fields, a preview — a synthetic composed page around the shape on the synthetic record — save / publish / deprecate, history) and "Open as an app" (a draft seeded with the resource on record beside the shape's form)
src/shapes/                   the record-shape library client — remote over GET /registry/shapes + the registry write API + POST /manifest/shape, local in mock mode over the bundled shapes; publishedArtifacts() is what every compile is handed
src/authoring/                the authoring API client (drafts, compile, registry writes) — remote over the deployed API, local in mock mode
src/users/                    the user administration client (accounts, groups, invitations) — remote over the deployed API, local over seeded accounts in mock mode
src/audit/                    the audit trail client (records by range, person, app, patient, kind, outcome; cursor) — remote over GET /audit, local in mock mode over sample records plus what the apps opened in this browser do
src/review/                   what a version changes against the published one, for the approver: roles and effective scopes (widenings first), data, actions, forms, purpose, the spec's knobs; a line diff of the texts
src/manifest/history.ts       a version's lifecycle events as people read them (submitted · sent back and why · recalled · approved · published · superseded); panel/VersionHistory.tsx renders them
src/manifest/facets.ts        what an app is about, derived from its manifest (kind, who it is about, what it shows and records, imaging, forms, intended for, context, codes, search text); chips, counts and the search over them
src/collections/              the hospital's collections (how it groups published apps for the launcher) — remote over the registry API, local seeded in mock mode; panel/browse.tsx (chips, cards, your apps, collections) and panel/CollectionsDrawer.tsx (curation, approvers and admins)
src/panel/personal.ts         the person's own corner of the launcher — pinned and recently opened apps — in localStorage per hospital and person
src/fhir/base-definitions.json  curated R4 StructureDefinitions (see scripts/extract-fhir-definitions.mjs); open-kind-definitions.json — element paths only, for the kinds administrators may define shapes for
```

## What can be built from this catalog

See [docs/application-catalog.md](docs/application-catalog.md) — the supported application
archetypes, their data plans and layouts, the parameter space, and what is explicitly refused in v0.
The machine-readable twin, [docs/application-catalog.yaml](docs/application-catalog.yaml), is what the
planning pipeline loads; `src/tests/applicationCatalog.test.ts` verifies that every component, prop,
primitive, config key, manifest and triage route it names exists in the renderer, so the planner's
picture of "possible" cannot drift from what the renderer accepts. For what to say to the builder,
[docs/example-prompts.md](docs/example-prompts.md) has a request per kind of app, the follow-ups that
refine a draft, and the requests the builder declines.

## From conversation to manifest

The agent never writes a manifest. It fills an **AppSpec** (archetype, knobs, roles with PHI
allow-lists and group bindings, governance) through tools, and `src/spec/compiler.ts` turns a complete
spec into a manifest deterministically — for all thirteen catalog archetypes, including the structured
assessment (a write through an action), imaging review (a DICOM scope), the worklist (APP-13: the ward's
open FHIR Tasks across patients, started and completed from the row) and the composed page (APP-12:
the page described as an ordered list of sections drawn from the same blocks — plus the rest of the
record: allergies, visits, reports, notes, procedures, immunizations, or any allow-listed resource as a
table with named columns — the entry forms that write, the patient's tasks, forms read back as data, and
photo documentation taken with the device's camera — rows from spans or tabs, role-gated sections) — data scopes derived from
the primitives each role runs, layout
from the archetype, everything validated by the same schema the renderer uses. `readiness(spec)` lists
what a partial draft still lacks, which is what the agent asks about. The reference manifests are the
compiler's golden outputs: `compile(specs/x.yaml)` must equal `manifests/x.yaml`. See
[docs/app-spec.md](docs/app-spec.md); JSON Schema for other languages in `docs/app-spec.schema.json`;
`npm run appspec -- compile|readiness|validate|schema` from a terminal.

### Drafting an app in the panel

Clinicians browse: **Your apps** first (what they pinned and what they opened lately — kept in this browser, per
hospital and person), then the hospital's **collections** (how approvers and admins group the published apps for a
clinic, a ward, a team — each person seeing the apps of a collection they may open, a collection with none of them not
shown at all), then **All apps** as cards narrowed by chips and a search. The chips are derived from the manifests and
nothing else — `src/manifest/facets.ts`: the kind of app read off its shape (trend, patient view, cohort register,
assessment, imaging review, documentation), who it is about (one patient, a cohort, the population), what it shows (the
clinical domains behind the FHIR resources its roles may read), what it records, its imaging, who it is for and in what
context (from the governance the approver signed) — so browsing stays true as apps are published, and the search box
finds an app by a diagnosis, a code, a role or a purpose as well as by its name. Each chip says what choosing it would
leave; a facet that would not narrow anything is not offered. Approvers and admins curate the collections from
*Manage collections* (`src/panel/CollectionsDrawer.tsx`): name, description, the apps as check boxes — changes gather in
the form and leave in one request. Staff see one list with the same chips and the collections strip, then three tabs — **Apps** (published),
**Drafts** (authors only — one list with a *Stage* column: conversations not yet saved, and versions
saved to the registry but not yet submitted, which can be submitted from the row) and **Pending sign-off** (versions in review or approved and waiting to
be published). A published app and its newer draft are two rows in two tabs: the registry API returns
both to staff, and `/apps/:appId/:version` opens a specific version (`/apps/:appId` is the published
one). Authors (`medapp-authors`, admins — anyone in mock mode) get **New app**. `/drafts/:id` is the drafting page: the conversation with the drafting assistant on the
left, the draft it produces on the right. An empty conversation offers the catalog's own example requests to send with one
click (`drafting/starters.ts` reads `archetypes[].example_requests` from `docs/application-catalog.yaml`: four that show the
breadth, the rest behind *More ideas*, English or German), so someone who does not yet know what to ask can see what the
assistant builds. Both change the same server-side draft through validated
operations — the chat via the agent's tools, the panel via `PATCH /drafts/{id}` — so a checkbox in
*Roles & access* and a sentence in the chat are the same kind of edit. The right side shows what is still
open (the readiness checklist), the app's name and kind, the roles with their PHI allow-lists and group
bindings (existing groups come from the hospital's user pool, nothing invented), governance, the
archetype's settings as a readable summary (staff can edit the YAML), and a *Preview* that compiles the
spec and renders it with the real renderer on synthetic data. *Save to registry* writes a draft version —
and while that version is still a draft the conversation stays open: keep changing it and *Save changes*
revises the same version in place (the button waits until something actually differs from what is saved;
so does *Save as new version* when iterating). *Submit for review* is a separate step, from which on the
conversation is frozen; approving, publishing and *Iterate on this app* live in the app page's inspector — and on the
**review page** (`/apps/:appId/:version/review`, *Review* in the Pending sign-off tab, *What changed* in the inspector),
which shows the approver what the version changes against the published one before they sign: the verdict on access
first (a role added, a scope widened — any step that lets a role reach data, patients or identity fields it could not
before is a *widening*, said first; the reverse a *narrowing*), then the purpose, the roles and their effective scopes,
the data read and written, the actions, the forms question by question, the author's settings (the spec's knobs, when both
versions have one), the layout, and the full text of the two specs as a line diff. A first version is reviewed whole.
`src/review/` is the comparison — pure functions over two registry entries, no React. Every version also carries its
**history** (`meta.history`, the registry's lifecycle events newest first; `src/manifest/history.ts` names them as
people read them: submitted, sent back and why, recalled, approved and signed with what notes, published, superseded).
It shows under the lifecycle row of the inspector and on the review page; a draft that a reviewer sent back carries the
reason on its row in the Drafts tab and in the drafting page's *Saved as* box until the author resubmits it. Showcase
manifests without events fall back to their sign-off. In mock mode the local authoring client writes the same events.
The way back into the editor depends on where the version stands: *Continue editing* reopens your own
conversation as it is while the version is a draft; *Recall and edit* on a version in review or approved
first takes it off the reviewers' desk (back to draft, sign-off removed — confirmed in place, because
changing an app while someone reviews a stale copy helps nobody) and then reopens the same conversation;
*Iterate on this app* on a published or deprecated version continues the conversation in a new draft that
becomes the next version, since what clinicians use must not move (someone else's app starts from its
stored spec, since their conversation is not yours to read). The assistant does none of these — when the draft is complete the chat shows the same
*Save to registry* button with what follows it (review, approval by someone else, publication), so the
conversation ends on the author's own click rather than on a claim. In mock mode (`VITE_REGISTRY_MODE=local`) the whole loop runs in the browser — drafts
and saved apps in `sessionStorage`, the compiler in-process — except the assistant itself, which only
exists behind the deployed API (the chat says so).

## The seed sets — one per hospital

Each hospital ships with a seed set: `showcase/<hospital_id>.yaml` names its apps by spec with the clinical note of an
example sign-off and groups them into collections for the launcher; `npm run showcase` compiles the set into
`manifests/<hospital_id>/*.yaml`, every app **published**, stamped with the hospital's id — the deterministic compiler's
output for its spec (the tests fail when spec and manifest disagree, and when a set's folder and its file drift apart).
`infra/scripts/seed-registry.py` writes the set of `HOSPITAL_ID` into that hospital's registry; the mock registry shows
the set of `VITE_HOSPITAL_ID`. One set ships, Klinikum Musterstadt's; a second hospital adds its own file.

### Klinikum Musterstadt (`showcase/hsp-musterstadt.yaml`)

Thirteen apps built for the connected hospital record (`infra/docs/hospital-servers.md`) that render on the synthetic
record too:

| File | Archetype | What it shows |
|---|---|---|
| `patient-360.yaml` | composed page, two roles | Everything the record holds about one patient in rows of mixed width: headline tiles, problems and medication, the blood-pressure trend with reference lines beside the latest vitals, allergies and visits, reports and letters, procedures and immunizations, laboratory results, and — for the senior clinician only — the FHIR record itself |
| `cardio-renal-follow-up.yaml` | composed page, charts + writes | Blood pressure, eGFR (two codes in one chart) and weight over three years with reference lines; the nurse's blood-pressure entry form; the physician's "mark resolved" and "stop" on problems and medication — each write validated, versioned, attributed |
| `diabetes-follow-up.yaml` | disease follow-up dashboard, from a template | One word — `diabetes_follow_up` — fills the HbA1c chart with the ADA goal line and its source, the therapy by ATC class (A10B, A10A) and the related conditions by SNOMED and ICD-10-GM category; the composer's answer to "a diabetes dashboard" |
| `tumour-board.yaml` | composed page, imaging in MPR | Diagnoses and procedures as the record codes them, radiology reports, haemoglobin, CRP and leukocyte trends over five years, the imaging studies opening as reconstructed planes, the letters |
| `imaging-review-3d.yaml` | imaging review | The study list beside OHIF, opening each study as the three planes plus a 3-D volume rendering; the app the registers link to |
| `hypertension-register.yaml` | cohort dashboard | Every patient with a hypertension diagnosis — SNOMED 38341003 or ICD-10-GM I10.00/I10.90, whichever the record uses — with the latest blood pressure, flagged from 140 mmHg systolic, and a slider over the systolic value that narrows the register live |
| `ckd-imaging-register.yaml` | cohort dashboard, narrowed by imaging | Patients with chronic kidney disease kept to those with a CT or ultrasound on record (asked of the PACS, or of the record's ImagingStudy), each row with the number of studies, the latest one, the latest eGFR, and a link opening the patient in the imaging review |
| `hypertension-follow-up.yaml` | composed page, structured assessment | The clinic's own follow-up form (one the record holds) written with provenance, earlier submissions beside it, the blood-pressure trend and readings, problems and medication for context |
| `follow-up-due.yaml` | worklist, derived from the record | Who among the hypertension patients is due that follow-up assessment — never assessed first, then the longest overdue — from their latest answers against a 90-day interval; a row opens the follow-up app |
| `falls-risk-assessment.yaml` | composed page, designed form read back as data | A falls-risk screen whose form was designed in the spec (`form`, with conditions and ranges): the compiler turned it into a FHIR Questionnaire the app carries (`artifacts.questionnaires`) and publishes to the record; beside it the timed up-and-go across the earlier screens as a chart with the literature's line (`form_trend`), the last screen in full, the problem list |
| `ward-documentation.yaml` | composed page, coded entries + tasks | Each list beside the form that adds to it: a diagnosis onto the problem list, an allergy, a procedure — from fixed lists of ICD-10-GM, ATC and OPS codes — and the patient's tasks with a form for a new one; the ward's everyday documentation |
| `ward-open-tasks.yaml` | worklist, tasks | The ward's open tasks across patients, overdue first, with Mine / Everyone; a row is started, completed or cancelled here and opens the patient in the ward documentation app |
| `wound-documentation.yaml` | composed page, photo documentation | The patient's wound photos, newest first, beside a form that takes one with the device camera — kind, body site, remark — the bytes in the platform's media bucket, the Media in the record |

Together they cover every capability the composer offers, once each: the single-purpose archetypes (APP-01…04,
07, 08, 10) are not shipped on their own because their blocks are inside these pages; the composer still builds
them on request. The set's collections — *Ward — everyday chores*, *Chronic disease clinics*, *Case review and
imaging* — group it for the launcher.

### Adding a set

Write `showcase/<hospital_id>.yaml` (`hospital_id`, `apps: [{ spec, note }]`, `collections`), the specs under `specs/`,
then `npm run showcase -- <hospital_id>`; commit the compiled `manifests/<hospital_id>/` with it. `specCompiler.test.ts`
checks spec against manifest for every set, `seedSets.test.tsx` renders every app of every set on the mock record.

The hand-authored reference manifests the compiler reproduces and the tests exercise — two inherited roles, a
draft and a version in review, a cohort chain, the first write, an intentionally broken file — live in
`fixtures/manifests/`; they are fixtures, not registry entries.

## Adding to the catalog (a platform release)

1. **Component** — write it under `src/primitives/ui/`, typed to FHIR (`@medplum/fhirtypes`), composing `@medplum/react` display components. Register it in `src/primitives/catalog.ts` with its allowed props. A component that **writes** through an action composes `ActionForm` / `useActionForm` (`src/primitives/ui/ActionForm.tsx`) and only decides what the form looks like and how input becomes the payload; saving / saved / error / "record another" are implemented and tested once there.
2. **Data primitive** — add the config schema to `PRIMITIVE_CONFIG_SCHEMAS`, the entry to `DATA_CATALOG`, its scope requirement to `assertScopeAllows`, and its behaviour to `MockPrimitiveExecutor` (the Lambda must return the same shape).
3. If a new FHIR resource type is displayed through `ResourceDetails`, add it to `scripts/extract-fhir-definitions.mjs` and re-run it.
4. Bump the catalog/design-system version and pin it in manifests.

## Design rules the code enforces

- **No LLM-authored code runs.** Manifests carry component names, props and primitive configs; the renderer refuses anything not in the catalog and says so on screen.
- **The frontend is untrusted.** Scope is checked before a primitive runs (and again by the dispatcher); PHI masking is derived from the role's effective scope, not chosen by the component.
- **Deterministic data plan.** Primitives run in declaration order; `only_for_roles` keeps a role's requests inside its scope; every call produces an audit record.
- **Writes only on intent.** `write.*` primitives never run at load — only through a declared action, with a payload from `$ui`. The dispatcher validates the payload, stamps who/when/through-which-app from the verified token, and refuses (422, nothing stored) rather than repairs.
- **Lookups, not expressions.** `$bindings.cohort.patients[0].id` is allowed; templates, arithmetic and function calls are not. A sandboxed CEL escape valve is a separate, later step.

## Branding (`src/branding.ts`)

One file makes the panel a hospital's own: `src/branding.ts` holds the **palette** (ten colours — page, surface,
ink, muted, line, accent, data, data2, data3, alert) and an optional **logo**. Everything else derives from it in
`src/theme.ts`: the design tokens the components read (`tokens`), Mantine's colour scales (`clinical` built around
the accent, `ink` around the neutral anchors), the shadows, and the CSS variables `styles.css` uses (`--ds-page`,
`--ds-ink`, `--ds-hairline`, …), written on the document root by `applyBranding()` before the first render. No other
file names a colour; `branding.test.tsx` fails if one creeps into `styles.css`, and checks that a changed palette keeps
its contrast and its order of lightness.

- **Re-colour:** edit the hex values in `branding.ts`. The accent is the one colour with meaning (approved, in scope,
  buttons, links, the hospital's name in the top bar); alert stays for thresholds and refusals. Run `npm test`.
- **Logo:** put the file under `public/branding/` and set `logo: { src: '/branding/logo.svg', alt: '…', height: 28 }`.
  It appears in the top bar before the hospital's name (`hideName: true` for a wordmark that already says it). The
  sign-in screen's brand panel is dark; give it a light variant as `srcOnDark` to show the logo there too.
- **Per hospital, without a build:** what `branding.ts` holds is the default. A deployed hospital overrides it from its
  file in `infra/hospitals/` (`branding.palette`, `branding.logo`, the logo files in `infra/hospitals/<id>/`): the
  infrastructure puts the palette and logo into `config.json` as `VITE_BRANDING` and serves the files under
  `/branding/`, and `main.tsx` applies them at boot (`resolveBranding` merges, `applyBranding` refills `tokens`,
  `scales`, `theme` and the CSS variables before the first render). The same contrast rules are checked at `cdk synth`
  (`infra/stacks/hospitals.py`), so an unreadable palette never deploys; the user pool's emails take the palette too.

## The visual system (`src/theme.ts`, `src/styles.css`)

Three rules, applied once through the Mantine theme so every component (the panel's and the ones rendered inside
apps) follows them without local styling:

- **Type.** Geist and Geist Mono, self-hosted (`@fontsource-variable`, imported in `main.tsx`; no font CDN).
  Headings slightly tracked in; tables, tiles and badges use lining tabular figures so numbers align;
  identifiers (MRNs, study UIDs, codes) are set in the mono face (`.ds-mono`).
- **Shape and depth.** Cards are 12 px with a hairline and a shadow tinted with the ink colour that falls away
  from the card; controls and inputs 8 px; badges 6 px. Cards sharing a row are the row's height, and a chart
  grows to fill it. Table heads are quiet (12 px, muted); rules are one step lighter than text; chart grids
  lighter still, so the data is the darkest ink in a plot. One accent colour (the validated green); red only
  for thresholds and refusals.
- **Motion.** Transform and opacity only, under 200 ms, ease-out: pressable things scale to 0.98 on press, a
  section whose data arrives fades up once from its placeholder, nothing else moves. All of it is off under
  `prefers-reduced-motion`. The reveal fills backwards only: an animation that kept a transform applied would make
  its wrapper the containing block of any `position: fixed` descendant (the viewer's expand overlay once stayed
  the size of its card for exactly that reason).
- **Facts, not pills.** Properties of a thing (the inspector's App section) are a definition list — quiet labels in
  a narrow column, values beside them, one hairline per row (`.ds-facts`); a pill is reserved for a state. Rows of
  actions put the one step forward as the filled button, the alternatives in the quiet outlined style, and the
  destructive one at the far right, asking before it acts.

## Known gaps / next steps

- The dispatcher (`infra/lambdas/dispatcher`) serves a synthetic FHIR bundle exported from `src/primitives/data/mock/seed.ts` (`npm run export:seed`; `src/tests/seedBundle.test.ts` guards against drift) until the hospital FHIR server is connected. In that mode, writes live in the warm Lambda's memory and are gone after a cold start.
- Writes are a Questionnaire-defined assessment (create only; the form from the record or designed in chat — coded options, ranges and conditional questions included, but no attachments, computed fields or scoring), a coded measurement within a declared range, a coded entry — a diagnosis, an allergy, a procedure, a task — from a list the author fixed, and a status change within an allowed set (problems, prescriptions, tasks). Amending a submission, scheduling and notifications are later steps.
- Medplum's own `PatientHeader` labels identifiers by system URL; use `PatientBanner` where the label matters or where PHI must be masked.
- `@medplum/mock` is bundled in all builds; split it out before a production build.
- The panel's chat → manifest pipeline (AgentCore) lives in `app_creator/`; this project only consumes manifests.
