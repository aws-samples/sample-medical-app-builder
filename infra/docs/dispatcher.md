# Primitive dispatcher

`lambdas/dispatcher/` is the enforcement point of the platform: every piece of clinical data an app
shows passes through `POST /primitives/{kind}`. The frontend is an untrusted client; nothing it
sends is believed except as a *request*.

## The request

```jsonc
POST /primitives/data.fhir.observation.by_code
Authorization: Bearer <Cognito ID token>
{
  "app_id": "app_bp_trend", "manifest_version": "0.3.0",
  "primitive_id": "p_series", "role": "viewer",
  "config":  { "patient": "pat-kms-0001", "codes": ["http://loinc.org|8480-6", "http://loinc.org|8462-4"], "since": "now-2y", "count": 500 },
  "context": { "patient_id": "pat-kms-0001", "window_start": "now-2y" }
}
→ 200 { "output": [ …Observation… ], "audit_id": "…", "outcome": "ok" }
→ 403 { "message": "…", "requirement": "DiagnosticReport.search", … }   refused (state / role / data plan / scope)
→ 400 { "message": "…", … }                                              config differs from the manifest's, context does not fit, kind ≠ manifest
→ 404 { "message": "…", … }                                              unknown app version / primitive / catalog kind
→ 422 { "message": "…", "problems": ["\"home_bp\" is required"], … }     write payload refused; nothing stored
→ 409 { "message": "…", … }                                              conditional create ambiguous; nothing stored
```

Every answer — the refusals and errors too — carries `audit_id` and `outcome`: the id and the verdict of the record the
dispatcher just wrote to the trail (`docs/audit.md`). The panel keeps them on its own, browser-side view of the call (the
app's inspector), so a row there can be opened in the Audit trail and shows the server's outcome rather than the
browser's reading of an HTTP status.

## What is checked, in order (`handler.py::Dispatcher.dispatch`)

1. **The manifest version exists** — one `GetItem` on the immutable VERSION item; its `state`/`signoff`
   are overlaid on the frozen `manifest_json` (`present_version`).
2. **Published, or staff** — clinicians only run published versions; authors, approvers and admins
   may run drafts and versions in review (that is how they are previewed and signed off).
3. **The role is granted** — `runnable_roles(groups, …)` from the token's `cognito:groups`: per-app
   `app-{app_id}-{role}` groups (`group`), blanket access → `default_role` (`blanket`), and for
   approvers/admins — or the owning author — every declared role (`staff_preview`, so an app can be
   reviewed as each of its roles). The requested role must be among them; how it was obtained goes on
   the audit record as `role_source`.
4. **The primitive is in the manifest** with that id and that kind, and not `only_for_roles`-gated to
   other roles.
5. **The role's effective scope grants it** — `effective_scope` resolves `inherits`;
   `primitives.assert_scope_allows` mirrors `med_app/src/primitives/data/dataCatalog.ts`.
6. **The configuration is the manifest's, not the request's** (`declared_config.py`). The panel resolves the
   primitive's declared `config` — `$context.*` from the launch context, `$ui.*` from what the person entered,
   `$bindings.*` from an earlier primitive's output — and sends the result; the dispatcher resolves the same
   declaration itself and executes *its* result. The launch context is first validated against the app's
   `context_inputs` (declared inputs only, typed — a `fhir.reference` is a resource id, an `iso8601` a date or a
   `now-90d` window — required ones present, declared defaults filled; anything else is a 400 "The launch context does
   not fit this app"). Then every literal — the codes an app reads, the patient filter, the window, a write's `ranges`,
   `rules`, `allowed` statuses, `max_bytes`, the record shape and its fields — is taken from the published manifest, and
   `$context`/`$metadata` references are resolved on the server. Only `$ui` and `$bindings` references are taken from
   the request, because by their nature they are the client's; every rule that applies to them (the write validation
   below, the scope) still runs here. The request's config is compared with the result: a literal it spells
   differently — a widened code list, a `patient` that is not the one in context, a loosened range — is a **400,
   refused and recorded** (`config_mismatch: ["codes", "params.patient"]` on the audit record) rather than silently
   corrected, so a tampered or broken client fails visibly; keys the manifest does not declare are dropped and noted
   (`config_dropped`). A request that omits a declared key simply runs with the manifest's value.
7. **Execute** against the `FhirSource`, then emit **one audit record**: `audit_id, timestamp, app_id,
   manifest_version, primitive_id, kind, role, user_sub, patient_context, data_scope_hash, outcome
   (ok | refused | error), duration_ms, detail` — plus `user_name`/`user_email` from the token, so the trail
   reads as people. The record goes to CloudWatch Logs as JSON (`{"audit": …}`) and, through `AuditSink`, to the
   audit table the panel's Audit trail reads (`docs/audit.md`); the store is fail-open — a store that is down costs
   the indexed copy, never the clinician's request.

Refusals are audited too — a refused request is exactly the kind of event a notified body wants to
see recorded.

What remains the client's, by design: the values behind `$ui` (a form's answers, a status change — validated as the
table below says) and `$bindings` (an earlier primitive's output fed into a later one: a register's cohort primitive
lists the patients, and the next primitive reads their latest observations from that list). A cohort-scoped role may
read across patients in any case; the dispatcher does not re-derive that the list is the cohort's. Re-running the
source primitive on the server would close that, at the price of one extra query per request.

## Writes (`write.*` primitives)

An app changes the record only through a **manifest action**: the manifest declares a `write.*`
primitive and an action that runs it (`actions: [{ id, label, primitive, on_success: reload }]`);
the schema refuses a write primitive no action drives, and the renderer never runs `write.*` kinds
at load. The action's payload comes from `$ui` (a form component's output). The dispatcher does
not know or care about actions — a write arrives as the same request as a read, goes through the
same six checks, and adds:

- **Scope operation** — the role's scope must list the operation on that resource
  (`QuestionnaireResponse: [search, create]`); `create` and `update` are distinct grants.
- **Payload validation** — the resource is checked against what it claims to answer
  (`questionnaire.py`, mirrored by `med_app/src/primitives/data/questionnaire.ts`). Invalid → `422`
  with the full list of problems; **nothing is written**; the audit record says `refused` with
  `detail: invalid payload: …`.
- **Provenance from the token, not the payload** — only the answers (`identifier`, `item`,
  `encounter`, `language`) are taken from the client. `status`, `subject` (the patient in context),
  `authored` (server clock), `author` (the caller's `sub` as an identifier, display from the verified
  `name`/`email` claims), `meta.source = urn:medapp:{app_id}@{version}` are stamped here. A client
  that claims another author, another patient or another time is overruled or refused.
- **Idempotency** — the client generates a submission identifier (`urn:medapp:submission|<uuid>`);
  the write is a FHIR *conditional create* (`If-None-Exist: identifier=…`) so a retried or
  double-clicked submit yields one record. Two existing matches → `409`, nothing written.
- **Audit** — the record additionally carries `payload_hash` (sha256 of the canonical payload,
  computed *before* validation so refused payloads are on record too), on success
  `resource_ref` (`QuestionnaireResponse/<id>`), and `provenance`: `recorded` when the role's scope
  grants `Provenance.create` (every manifest the compiler produces for a writer does), `not_granted`
  for a manifest published before that grant existed — the write still lands, the audit record is
  then its only trail, and republishing the app is the fix.

The catalog's write primitives:

| Kind | Payload from `$ui` | What the dispatcher checks (`writes.py`, mirrored by `writes.ts`) | Effect |
|---|---|---|---|
| `write.fhir.questionnaire_response.submit` | a `QuestionnaireResponse` | structural validity against the Questionnaire (`questionnaire.py`) — the app's own form from the manifest (`artifacts.questionnaires`, by canonical URL or id) when it carries one, the record's otherwise; `data.fhir.questionnaire.read` resolves the same way. Problems name the question as the clinician reads it (the linkId only for an item without text). Checked: every linkId is an item of the form; `required` items answered — but only when the item is **enabled**: `enableWhen` (`=`, `!=`, `exists`, `<`, `<=`, `>`, `>=`; `enableBehavior` all/any; a parent group's conditions apply to its children) is evaluated against the submitted answers, a required-but-hidden item is not demanded, and an answer on a hidden item is refused (`"How many falls? (0–20)" is not asked (its condition is not met) and cannot carry answers`); answer types match the item type; a choice answer is one of the offered `answerOption`s, by `code` **and** `system` when the option carries one (`"Walking aid": system\|code is not one of the offered options`); a number is within `minValue`/`maxValue` (`"How many falls? (0–20)": 25 is above the maximum 20`) | conditional create; with `config.extract` (answers flagged `as_observation` in the spec) one Observation per flagged numeric answer is written beside the response — the item's code and unit, category survey, `derivedFrom` the response, its own Provenance, idempotent on `<submission>-<linkId>` — and the scope must grant `Observation.create` for those codes |
| `write.fhir.observation.create` | an `Observation` from an entry form | the code is one the manifest allows; a numeric value (or every declared component) in the declared unit and within the declared plausibility range; the manifest's `rules` between components hold (`component` above `above` — the compiler puts systolic-above-diastolic on the blood pressure panel; judged once both values are numeric, named as the form labels them: "Systolic must be above diastolic (90 vs 120 mmHg)"); effective date not in the future and at most `max_backdate_days` old; the patient in context; `bodySite` carries at most one SNOMED laterality qualifier (left 7771000, right 24028007, both 51440002) and only when the manifest has `side` (required: it must), plus the declared `body_site` structure and nothing else; `method` is one of the declared `conditions`, or absent | conditional create; `status`, `subject`, `performer`, `issued`, `category`, `meta.source` stamped; `bodySite` and `method` kept as sent |
| `write.fhir.condition.create` | a `Condition` from an entry form | the code is one the manifest's `codes` allows; the patient in context; `clinicalStatus`, if sent, is `active`; `verificationStatus` is one the manifest offers (`verification`, the first stamped when none is sent); a `severity` only when the manifest allows it, and then mild / moderate / severe (SNOMED); `onsetDateTime` a date not in the future | conditional create; `clinicalStatus` active, `verificationStatus`, `category`, `subject`, `recordedDate`, `recorder`, `asserter`, `meta.source` stamped; notes attributed |
| `write.fhir.allergy_intolerance.create` | an `AllergyIntolerance` from an entry form | the substance is one the manifest allows; the patient in context; `type` and every `category` (at least one) among those offered; `criticality` only when offered, then low / high / unable-to-assess; `verificationStatus` as offered; a `reaction` only when offered, with a manifestation and a severity of mild / moderate / severe; `onsetDateTime` not in the future | conditional create; `clinicalStatus` active, `verificationStatus`, `patient`, `recordedDate`, `recorder`, `asserter`, `meta.source` stamped |
| `write.fhir.procedure.create` | a `Procedure` from an entry form | the code is one the manifest allows; the patient in context; `status` one of the manifest's `statuses`; `performedDateTime` present, not in the future, at most `max_backdate_days` old; `bodySite` / `outcome` only when the manifest takes them | conditional create; `subject`, `recorder`, `asserter`, `performer` (the signed-in person), `meta.source` stamped |
| `write.fhir.task.create` | a `Task` from an entry form | the code is one the manifest allows (the author's task vocabulary, `urn:medapp:task`); the patient in context (`for`); `status`, if sent, is `requested`; `priority` one the manifest offers; a due date (`restriction.period.end`) only when the form has one, a valid date, today or later; `description` text of at most 500 characters | conditional create; `status` requested, `intent` order, `for`, `requester`, `authoredOn`, `lastModified`, `meta.source` stamped; only the due *day* of the client's restriction is kept |
| `write.fhir.media.create` | a `Media` from the photo form, the image as base64 in `content.data` | `type`, if sent, is `photo`; what it documents (`reasonCode`, the author's kinds, `urn:medapp:photo`) is one the manifest allows; the patient in context; `content.contentType` is JPEG, PNG or WebP; the data is valid base64 and decodes to at most `max_bytes`; `bodySite` only when the form takes one; `createdDateTime` not in the future, at most `max_backdate_days` old | the bytes go to the media store (`media_store.py`: the stack's `MEDIA_BUCKET`, key `<hospital>/<patient>/<submission>.<ext>`; an in-memory store without one); conditional create of the Media with `content.url = medapp-media://…`, `size`, `hash` (SHA-1), `status completed`, `subject`, `issued`, `operator` (the signed-in person), attributed notes, `meta.source`, plus the Provenance; the answer — and every Media a `data.fhir.query` returns — carries a presigned GET (15 min) in `content.url` instead, so the panel can load the picture; the record never holds the bytes. Without a media store the write is refused (404, "no media store") |
| `write.fhir.record.create` | a resource of the declared type (Goal, CarePlan, Encounter, DocumentReference, Consent), the values at the declared element paths | the resource type matches `config.resource`; the patient in context; each declared field (`config.fields`: path, encoding, required, unit/range, date window, max length, codes/options) is present when required and well-formed; **no element outside the declared fields and the stamps** — each stray leaf is refused by name (`record_shape.py`, mirrored by `recordShape.ts`; `writeCases.json` `record_cases`) | the stamps (`config.stamps`: status, subject, author, dates — `$patient`, `$author`, `$now`, `$today` filled in) overwrite whatever the client sent; `meta.source`; when the manifest's rules came from a library shape (`config.shape`: id, checksum, version, `tag`) the record carries that shape and version as `meta.tag` — `_tag=https://<hospital>.medapp.eu/CodeSystem/record-shape|<shape id>` finds every record written with it, whatever the app; conditional create on the submission identifier; Provenance. The scope must grant `<resource>.create` for that type |
| `write.fhir.task.update_status` | `{ id, status, versionId?, note? }` | the target status is in the manifest's `allowed` set (in-progress, completed, cancelled); the Task exists and belongs to the patient in context — or, on a worklist with no patient in context, to whichever patient it names; it is not already in that status | versioned update of `status`; `owner` = the signed-in person when none yet (whoever takes a task on owns it), `executionPeriod.start` on in-progress, `.end` on completed, `lastModified`, an attributed note |
| `write.fhir.condition.update_status` | `{ id, status, versionId?, note? }` | the target status is in the manifest's `allowed` set; the record exists and belongs to the patient in context; it is not already in that status | versioned update of `clinicalStatus` (+ `abatementDateTime` when resolved, an attributed note) |
| `write.fhir.medication_request.update_status` | `{ id, status, versionId?, reason?, note? }` | same, on `status` | versioned update of `status` (+ `statusReason`) |

**Versioned updates.** A status change carries the `meta.versionId` the client saw (the list hands it
to the row action); the update is sent with `If-Match: W/"<versionId>"`, and a record changed by someone
else in the meantime is not overwritten — `409` with "The record was changed by someone else in the
meantime; nothing was written. Reload and try again." (`VersionConflict`; the in-memory source keeps a
version history so the check works on the bundled data too). Updates never touch the clinical content:
what is prescribed, which diagnosis, stays as it was; only the status field, a reason and a note change.

**Provenance.** Every write leaves a `Provenance` beside the record: `target` (the created or updated
resource), `recorded` (server clock), `agent` (the caller's `sub` as an identifier, display from the
token), `activity` `CREATE` or `UPDATE`, `policy` `urn:medapp:{app_id}@{version}`, and for an update an
`entity` of role `revision` pointing at the version it replaced (`Condition/<id>/_history/<n>`). The
compiler grants `Provenance.create` to every role that writes; a manifest compiled before provenance
existed lacks the grant, and for it the dispatcher skips the Provenance (the write itself is still
audited in the platform log) — so older published apps keep working until they are republished.

Orders, prescriptions of new medication, free edits of clinical content and deletes are not primitives
and therefore cannot be expressed by any manifest.

In `bundle` mode writes live in the warm Lambda container's memory and vanish on cold start — enough
for demos, and the reason the hospital's FHIR server is the system of record in `fhir` mode.

## Where the data comes from

`fhir_source.py` defines the only interface primitives use: `read(type, id)`,
`search(type, params)` with the parameter subset the catalog needs (`patient`/`subject`, `code`,
`combo-code` — Observation searches use it so a panel is found by a component code on a real server —
`clinical-status`, `status`, `date=ge…`, `questionnaire`, `url`, `identifier`, `category`, `type`,
`_sort`, `_count`), `create(resource, if_none_exist)` and `update(resource, if_match)`.

| `DATA_SOURCE` | Implementation | Use |
|---|---|---|
| `bundle` (default) | `InMemoryFhirSource` over `data/synthetic-musterstadt.bundle.json` | until a FHIR server is reachable; unit tests |
| `fhir` | `HttpFhirSource` over `FHIR_BASE_URL`, authenticating as `FHIR_AUTH` says | the reference server (`docs/reference-servers.md`) or the hospital gateway |

`FHIR_AUTH` is `sigv4` (requests signed with the Lambda's role — the reference server's IAM-authorised API,
`FHIR_SIGV4_SERVICE` defaults to `execute-api`), `oauth2` (a bearer token from the hospital's token endpoint by
the client-credentials grant — `FHIR_TOKEN_URL`, `FHIR_OAUTH_SCOPE`, and the client id and secret from the
Secrets Manager secret `FHIR_CREDENTIALS_SECRET`, or `FHIR_CLIENT_ID`/`FHIR_CLIENT_SECRET` on a developer
machine; `medapp_shared/oauth2.py` caches the token per process, renews it before it expires and re-reads the
secret when a token is refused), `bearer` (`FHIR_BEARER_TOKEN` as `Authorization: Bearer`) or `none`. TLS is
verified against the platform store, or the AWS SDK's bundle when the Python at hand reads no system store
(macOS builds); `FHIR_CA_BUNDLE` names a PEM bundle explicitly for a server behind a private CA. The reference
servers (`reference_servers` in the hospital's file, `hospitals/<id>.json`) set all of this for SigV4, the hospital's servers (`hospital_servers`,
`docs/hospital-servers.md`) for OAuth2; a gateway with a static token is `-c data_source=fhir
-c fhir_base_url=https://… -c fhir_auth=bearer` with the token placed in the dispatcher's environment out of
band. Enforcement is identical in every mode; only the last step changes. Paging links a server writes with
the wrong scheme or host (HAPI behind a gateway writes `http://…`) are rebased onto the configured base URL
before they are followed.

Three things the primitives do so that a real server behaves like the bundle. Searches carry `_sort`
(newest first, the date parameter of each type: `-date`, `-recorded-date` for Condition, `-authoredon` for
MedicationRequest, `-started` for ImagingStudy, `-authored` for QuestionnaireResponse) and `_count`, so the
server does the ordering and the truncation and a `count` never drops the most recent records; results are
ordered again locally (`newest_first`) so both sources answer identically, and a manifest that sets its own
`_sort` keeps it. And every server error the primitives cannot act on — a rejected search parameter, a
timeout, an unreachable host — is an `UpstreamError` the handler turns into **502** with the server's
OperationOutcome text and an audit record with outcome `error`, never an unlogged 500. And a `code`
filter that names a level above the leaf — an ATC class (`C09A`, fewer than the seven characters of a
substance) or an ICD-10-GM category (`I10`, the three characters before the dot), as the disease
templates do for a therapy or a diagnosis — is kept out of the request (a server matches tokens
exactly and would answer with nothing) and applied by `fhir_query` to the patient's records of that type,
through `concept_matches`, which knows the two hierarchies (`is_class_code`, `code_matches`; mirrored in
`fhirHelpers.ts`). Exact codes go to the server as they are.

**Imaging** has its own source (`dicomweb.py`). With `DICOMWEB_BASE_URL` set — the reference PACS, or a
hospital gateway — `data.dicom.studies.for_patient` reads the FHIR Patient, takes the identifier of the MRN
system (`DICOM_PATIENT_ID_SYSTEM`; falls back to one typed MR/MRN) — or, with `DICOM_PATIENT_ID_SOURCE=resource_id`,
the Patient's resource id, which is what some hospital PACS gateways key studies by — queries QIDO-RS
`studies?PatientID=<id>` and maps the DICOM JSON to the `ImagingStudy` shape the renderer already consumes
(identifier `urn:oid:<StudyInstanceUID>`, `started` with the PACS's timezone, modalities, counts, description,
accession, referrer, and the series with their instance counts so the viewer knows which one is the volume). Authentication follows `DICOMWEB_AUTH` (default: `FHIR_AUTH`); the scope check is `dicom.qido` as
before; 204 from the PACS is an empty list. Without the variable the primitive reads `ImagingStudy` resources
from the FHIR source, as the bundle mode always did. The `Dispatcher` receives the source once
(`Dispatcher(table, source, dicom=…)`) and hands it to each execution through `ExecutionContext.dicom`.

The imaging cohort (`data.cohort.with_imaging`) takes the same two paths for a whole cohort: for each member
of `patients` (a cohort binding) one QIDO query by MRN *without* the per-study series calls — a register
needs counts and the latest study, not the volume to render — or, without a PACS, one `ImagingStudy?patient=`
search; the studies are kept to `modalities` (empty: any), to those started from `since` (`now-2y` or ISO) and
a member stays with at least `min_studies` of them. The lookups run in parallel like the latest observation's,
the rows keep the cohort's order and carry `study_count`, `latest_study` (uid, started, modalities,
description, series and instance counts — enough to name a study and open it elsewhere, never pixels) and
the member's `modalities`; `patients` is the narrowed cohort, so a `data.cohort.latest_observation` step can
follow on exactly those members. Its scope rule asks for both `ImagingStudy.search` and `dicom.qido` (the
compiler grants both, so one manifest runs on either kind of deployment) and a cohort `patient_scope`.

**Patient lookup** (`GET /patients?name=…`) is the one read that is not a primitive: the launch context. A
hospital's record holds patients the panel has never seen and, on some records, no MRN to type, so the launcher's
picker searches the same data source by name through the dispatcher — at least two characters, at most
fifty hits, the few fields a picker shows — and every lookup is an audit record of kind
`platform.patient.search` with the query text and the number of hits. Without a name it answers the first
page of the record by family name (twenty, one page, `_sort=family`), so the picker is not empty before
anyone types; that lookup is audited too, with an empty query. The panel remembers the chosen patient for
the tab, so opening an app and coming back keeps the context. Any signed-in user of the panel may
look a patient up, which opening an app for them already implies; a hospital launch (SMART, the EHR's
context) replaces this.

The bundle is **exported, not hand-written**: `med_app/scripts/export-seed.ts` (`npm run export:seed`)
writes it from the frontend's TypeScript seed, and `med_app/src/tests/seedBundle.test.ts` fails if
the two drift. Mock mode in the browser and dispatcher mode therefore show the same three synthetic
patients, and the frontend's numbers (37 vitals, 24 BP readings, cohort of 2 with 1 flagged) are
asserted on both sides.

## Primitive implementations

`primitives.py` is the authoritative behaviour of the catalog (`data.fhir.patient.read`,
`data.fhir.observation.by_code`, `data.fhir.query`, `data.dicom.studies.for_patient`,
`data.cohort.by_condition`, `data.cohort.with_imaging`, `data.cohort.latest_observation`, `data.fhir.questionnaire.read`,
`write.fhir.questionnaire_response.submit`, `write.fhir.observation.create`, `write.fhir.condition.create`,
`write.fhir.allergy_intolerance.create`, `write.fhir.procedure.create`, `data.task.worklist`, `data.cohort.assessment_due`,
`data.fhir.questionnaire_response.answers` (a form's numeric answers as derived, unstored Observations), `write.fhir.media.create`
(photo bytes to the media bucket, the Media to the record; `media_store.py`), `write.fhir.record.create` (a declared-shape record;
`record_shape.py`), `write.fhir.task.create`,
`write.fhir.task.update_status`, `write.fhir.condition.update_status`, `write.fhir.medication_request.update_status`); the frontend's
`mockExecutor.ts` mirrors it for local work. Adding a primitive means: implementation + scope requirement here, the config schema + scope
requirement in `dataCatalog.ts`, the mock implementation, and an entry in
`docs/application-catalog.yaml` — the catalog test will remind you. A write primitive additionally
needs its validator here and in `med_app/src/primitives/data/questionnaire.ts` (or a sibling), with
the same problem strings on both sides — `test_validator_matches_the_frontend_rules` and
`writePath.test.ts` assert identical output for identical input.

`data.fhir.query` searches one of the allow-listed resource types — Condition, MedicationRequest,
Observation, ImagingStudy, Encounter, DiagnosticReport, Questionnaire, QuestionnaireResponse,
AllergyIntolerance, Procedure, Immunization, DocumentReference, Task, Media, Goal, CarePlan, Consent, plus every kind of
record the platform opens to administrators' shapes (`QUERY_RESOURCES`, read from `data/record-kinds.json`, which the
panel writes from its rule with `npm run export:kinds` — `med_app/src/fhir/kinds.ts`; the frontend test suite fails when
the file lags) — always for the patient in context. Two filters are applied by the
dispatcher rather than the server: a `code` that names an ATC class or an ICD-10-GM category (the hierarchy,
`concept_matches`), and any `code` on Media (FHIR has no such search parameter there; it matches what the photo
documents, `reasonCode`). The in-memory source honours
`patient`/`subject` (also for types that call the field `patient`, such as AllergyIntolerance and
Immunization), `code`/`combo-code`, `clinical-status`, `status`, `category`, `type`, `questionnaire`,
`url`, `identifier`, `date=ge…`, `_sort=date` and `_count`; against a real server the parameters pass
through unchanged. Adding one of the platform's own resource types is a platform release: `queryResources.ts` (then
`npm run export:kinds`), seed data for it (and the bundle re-export), a list component or a composed-page section, and the
StructureDefinition in `base-definitions.json` so `ResourceDetails` can render it. An open kind joins by rule.
