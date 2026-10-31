# App registry — DynamoDB design

The registry is the system of record for **what apps exist, which versions of each exist, what
state each version is in, and the exact manifest that was validated for it**. It stores no patient
data. One table per hospital deployment, so the hospital never appears in a key.

Everything below is derived from the questions the four consumers ask:

| Consumer | Question | Frequency | Latency need |
|---|---|---|---|
| Doctor Panel (launcher) | Which apps exist, in what state, with which roles? | per page load | interactive |
| App runtime | Give me the manifest for app X, version Y (or the published one) | per launch | interactive |
| Primitive dispatcher (Lambda) | Load the manifest for the `app_id`@`manifest_version` named in the request; derive the caller's role from the token's groups; enforce that version's scope | **every data call** | single read, hot path |
| Pipeline (app_creator) | Create a new immutable version; move a version through its lifecycle; record sign-off | rare | consistency over speed |
| Reviewer queue | Which versions are `in_review`? Which apps are `published`? | occasional | interactive |

## 1. Keys and item types

Single table, generic keys `PK` / `SK` (strings), one sparse GSI.

| Item | PK | SK | Purpose |
|---|---|---|---|
| **HEAD** — one per app | `APP#{app_id}` | `HEAD` | mutable pointer record: name, intent class, owner, `latest_version`, `active_version` (the one published version), denormalised roles for the launcher |
| **VERSION** — one per version | `APP#{app_id}` | `V#{vpad}` | the validated manifest (canonical JSON) + its hash, lifecycle `state`, `signoff`, provenance, renderer output, per-role `data_scope_hashes`. **Manifest content is never updated.** |
| **EVENT** — append-only | `APP#{app_id}` | `EVT#{vpad}#{iso_ts}` | every lifecycle transition: actor, from → to, notes, signature |
| **COLLECTION** — one per collection | `COLLECTION#{collection_id}` | `HEAD` | how the hospital groups its apps for the launcher: name, description, ordered `app_ids` (overlapping — an app may sit in several), who last changed it. Organisation, not a clinical change: edited by approvers and admins without any version moving; removing one changes its index key (`COLLECTIONS#deleted`), the item stays |
| **SHAPE** — one per record shape | `SHAPE#{shape_id}` | `HEAD` | the record-shape library's pointer record: name, description, `resource`, owner, `latest_version` / `latest_state`, `active_version` (the one published version) |
| **SHAPE_VERSION** — one per version | `SHAPE#{shape_id}` | `V#{vpad}` | the RecordShape document (`document_json`, canonical) and the artifact the compiler made of it (`artifact_json`: the runtime rules plus `checksum`), lifecycle `state`. A draft is revised in place; from publication on never touched |
| **EVENT** (shapes) | `SHAPE#{shape_id}` | `EVT#{vpad}#{iso_ts}` | creation, revision, publication, deprecation of a shape version — same shape as an app's events, never signed |
| **ARTIFACT** (later) | `ARTIFACT#{type}#{name}` | `V#{vpad}` | shared cohort definitions, prompt templates, report templates |

`vpad` is the exact semver zero-padded to five digits per component — `0.3.0` → `00000.00003.00000` —
so lexical order in the sort key **is** version order. That makes "newest version" a
`Query PK, begins_with(SK, 'V#'), ScanIndexForward=false, Limit=1`, and keeps events (`EVT#…`)
out of that range. The manifest schema already forces exact `x.y.z` versions, so no pre-release
tags need sorting.

### GSI1 (sparse, `INCLUDE` projection)

| Item | GSI1PK | GSI1SK | Serves |
|---|---|---|---|
| HEAD | `REGISTRY` | `NAME#{name_lower}#{app_id}` | launcher list, alphabetical |
| VERSION | `STATE#{state}` | `{updated_at}#{app_id}#{vpad}` | reviewer queue (`in_review`), all `published`, all `deprecated` |
| EVENT | — | — | not indexed |
| COLLECTION | `COLLECTIONS` | `NAME#{name_lower}#{collection_id}` | the launcher's collections, alphabetical (removed ones sit under `COLLECTIONS#deleted`) |
| SHAPE | `SHAPES` | `NAME#{name_lower}#{shape_id}` | the record-shape library, alphabetical (a deprecated shape stays listed with `active_version` null — a new draft revives it) |

Projected non-key attributes: `type, app_id, name, intent_class, version, state, updated_at,
latest_version, active_version, roles, manifest_hash, created_by_sub` (`GSI1_PROJECTED_ATTRIBUTES` in
`registry_model.py`; the stack reads the same list). The manifest body is **not** projected — list views
never need it and it would multiply index storage. The consequence for readers: **the index names items, it
does not hold them.** Anything outside that list — a HEAD's `owner_sub`, a VERSION's `manifest_json`, a
COLLECTION's `collection_id`, `description` and `app_ids`, a SHAPE's `shape_id`, `resource` and every artifact — must be fetched by key after the index query.
`RegistryReader` does so (`list_apps` reads each head and each deprecated version by key, `list_collection_items`
each collection), and the unit tests' fake table answers index queries with the projected attributes only, since
a fake that returned whole items once hid exactly this: the first collection seeded into the real table came back
from the index without its `app_ids` and `GET /registry/collections` answered 500.

## 2. Item shapes

```jsonc
// HEAD
{
  "PK": "APP#app_bp_trend", "SK": "HEAD", "type": "HEAD",
  "app_id": "app_bp_trend", "hospital_id": "hsp-musterstadt",
  "name": "Longitudinal blood pressure", "intent_class": "viewer",
  "description": "Systolic and diastolic readings over time …",
  "owner_sub": "e4f2…8a1c",
  "created_at": "2026-09-11T09:10:00Z", "updated_at": "2026-09-12T14:02:11Z",
  "latest_version": "0.3.0",          // newest version of any state (authors work here)
  "active_version": "0.2.1",          // the single published version served to users, or null
  "latest_state": "in_review",
  "roles": [ { "id": "viewer", "display_name": "Read-only viewer", "cognito_group": "app-app_bp_trend-viewer" }, … ],
  "GSI1PK": "REGISTRY", "GSI1SK": "NAME#longitudinal blood pressure#app_bp_trend"
}

// VERSION
{
  "PK": "APP#app_bp_trend", "SK": "V#00000.00003.00000", "type": "VERSION",
  "app_id": "app_bp_trend", "version": "0.3.0", "parent_version": "0.2.1",
  "state": "in_review",
  "manifest_json": "{\"apiVersion\":\"medapp.eu/v1\",…}",   // canonical JSON; immutable from submission (revisable while draft)
  "manifest_hash": "sha256:9c1a…",                          // over manifest_json
  "data_scope_hashes": { "viewer": "sha256:…", "reviewer": "sha256:…" },   // per-role scope digest: audit + version diffing
  "signoff": null,                                           // { approver_sub, approved_at, signature, clinical_notes }
  "provenance": { "generated_by_pipeline_version": "1.4.2", "llm_trace_id": "trc-…", "prompt_hash": "sha256:…" },
  "renderer": null,                                          // { bundle_hash, bundle_s3_key, cloudfront_path }
  "created_at": "2026-09-12T13:58:40Z", "created_by_sub": "e4f2…8a1c", "updated_at": "2026-09-12T14:02:11Z",
  "author": { "name": "Lukas Hoffmann", "email": "lukas.hoffmann@klinikum-musterstadt.example" },   // from the token at save time; shown as "By: …" to everyone; null before names were kept
  "GSI1PK": "STATE#in_review", "GSI1SK": "2026-09-12T14:02:11Z#app_bp_trend#00000.00003.00000"
}

// EVENT
{
  "PK": "APP#app_bp_trend", "SK": "EVT#00000.00003.00000#2026-09-12T14:02:11Z", "type": "EVENT",
  "version": "0.3.0", "ts": "2026-09-12T14:02:11Z",
  "actor_sub": "e4f2…8a1c", "actor": { "name": "Lukas Hoffmann", "email": "lukas.hoffmann@klinikum-musterstadt.example" },   // the person, from the token; absent on events written before names were kept
  "from_state": "draft", "to_state": "in_review",
  "notes": "Ready for clinical review", "signature": null
}
```

The EVENT items are not only the audit of the registry: they are the **version's history as people read it**.
The read API returns them per version to staff (`history`, newest first, the signature reduced to `signed`), and
the panel shows them under the version — in the inspector's lifecycle row, on the review page, and on a draft's row
in the Drafts tab when the last decision about it was a reviewer's: a send-back and its reason stay with the version
until the author resubmits. That is why a transition's `notes` matter beyond the record: they are what the other
person reads.

Two storage decisions worth being explicit about. The manifest is stored as a **canonical JSON
string**, not a DynamoDB map: the hash is computed over exactly those bytes, so any consumer can
re-verify integrity with one `sha256`, and no attribute-level projection can accidentally serve a
partial manifest. And the renderer's outputs (`bundle_hash`, S3 key, CloudFront path) live in a
**separate attribute**, not inside the manifest — the earlier manifest draft had a `renderer:`
section, but if the renderer wrote into the manifest the hash would change after validation, and
the manifest would stop being the signed artifact. Same for `lifecycle.signoff`: persisted as the
`signoff` attribute and an EVENT item, never patched into `manifest_json`.

There is no per-app Cognito client id anywhere in the table: the hospital has one web client, and
access to an app is a role-group membership (see `docs/identity.md`).

## 3. Write protocols

**Create a version** (pipeline) — one `TransactWriteItems`:

1. `Put VERSION` with `ConditionExpression: attribute_not_exists(PK)` — a version number is never reused.
2. `Update HEAD`: set `latest_version`, `latest_state = 'draft'`, `updated_at`; `ConditionExpression: latest_version = :expected_previous` (optimistic concurrency — two agents iterating the same app cannot both win). On first version, `Put HEAD` with `attribute_not_exists(PK)` instead.

**Revise a draft version** (pipeline, `PUT …/versions/{version}`) — one `TransactWriteItems`. A version
nobody has reviewed is its author's to change: the conversation it was saved from (`session_id` on the
item) is edited further and saved again under the same number, instead of producing `0.2.0`, `0.3.0`…
for an app that has not left the author's desk.

1. `Update VERSION`: set `manifest_json`, `manifest_hash`, `spec_json`, `data_scope_hashes`, `updated_at`;
   `ConditionExpression: state = 'draft'` — from `in_review` on, nothing is rewritten, ever; a change is a new version.
   `created_at`/`created_by_sub` stay (the compile is deterministic: the same spec gives the same hash).
2. `Put EVENT` `draft → draft` ("revised from draft …") — every revision is on the record.
3. `Update HEAD` (`name`, `description`, `updated_at`) when the revised version is the latest.

**Transition a version** (`draft → in_review → approved → published → deprecated`, with
`in_review → draft` and `approved → draft` for a reviewer's rejection or the author's recall) — one
`TransactWriteItems`:

1. `Update VERSION`: `SET state = :to, updated_at = :now, GSI1PK = :state_key, GSI1SK = :state_sk [, signoff = :signoff]`
   with `ConditionExpression: state = :from` — the allowed transitions are checked in code **and** the
   condition guarantees no lost update. A return to `draft` sets `signoff = null`: the version is the
   author's to change again, so nothing signed may stay attached to it; the version's drafting
   conversation is stamped with the new state (`session_id`) and thaws with it.
2. `Put EVENT` (append-only; `attribute_not_exists(PK)`).
3. If `:to = published`: `Update HEAD` set `active_version`; `Update` the previously published
   VERSION to `deprecated` (condition `state = 'published'`); and — outside DynamoDB, in the same
   Lambda — create the app's role groups in Cognito (idempotent). At most one published version per
   app is an invariant enforced by this transaction.

**Who may write** (checked from the token's groups before any of the above; rules in
`medapp_shared/identity_model.py`): first drafts by `medapp-authors`; new versions by the app's
owner or an admin; `approved`/`published` by `medapp-approvers` or admins but never the version's
own author.

**Read paths**

- Launcher: `Query GSI1 where GSI1PK = 'REGISTRY'` → HEAD items (roles are denormalised, so no second read); the panel shows the apps whose role groups the caller holds, plus the caller's own drafts.
- Runtime launch: `GetItem HEAD` → `active_version` (or the caller's explicit version) → `GetItem VERSION`.
- Dispatcher: `GetItem VERSION` for the `app_id`@`manifest_version` named in the request — one read; roles = `effective_roles(groups, app_id, manifest roles, default_role)` (the caller's `app-{app_id}-*` groups, plus `default_role` for blanket-access groups); refuse if empty or if the version is not `published` (authors may preview their own `draft`/`in_review` versions); enforce the stored scope for the requested role, which must be one of those; record `data_scope_hashes[role]` on the audit record.
- Review queue: `Query GSI1 where GSI1PK = 'STATE#in_review'` (oldest first by `updated_at`).
- Version history / rollback: `Query PK = APP#x, begins_with(SK, 'V#')` descending.

## 4. Immutability guardrails (the MDR angle)

The property a notified body wants is "the manifest that was validated is the manifest that ran".
Four layers, cheapest first:

1. **Condition expressions** — versions are put with `attribute_not_exists`; the only code path that `SET`s `manifest_json` is the draft revision above, conditioned on `state = 'draft'` — once a version has been submitted for review, nothing rewrites it.
2. **IAM attribute allow-lists** — the lifecycle Lambda's role may `UpdateItem` only with
   `dynamodb:Attributes ∈ {state, updated_at, signoff, renderer, GSI1PK, GSI1SK}` (`ForAllValues:StringEquals`
   plus `dynamodb:ReturnValues`/`Select` conditions). Even a bug cannot touch `manifest_json`. The
   pipeline's role gets `PutItem` only. Nobody gets `DeleteItem`; the table has deletion protection.
3. **Stream integrity monitor** — DynamoDB Streams (`NEW_AND_OLD_IMAGES`) → a small Lambda that
   alarms if a `MODIFY` event ever changes `manifest_json`/`manifest_hash` on a VERSION item.
4. **Legal copy** — on creation the pipeline also writes `manifest_json` to
   `s3://…/registry/{app_id}/{vpad}.json` in a bucket with **Object Lock (compliance mode)**. DynamoDB is
   the index and hot path; S3 Object Lock is the record.

Point-in-time recovery is on, encryption uses the hospital's customer-managed KMS key, and the
table is `RETAIN` on stack deletion.

## 5. API surface the frontend will consume

The browser never talks to DynamoDB. A registry API (API Gateway + Lambda, Cognito JWT authorizer)
exposes read paths; the pipeline uses the write paths with its own role.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/registry/apps` | `{ apps: [...] }` — one row per presented version: clinicians get each app's `active_version` (published, and only with a role); staff get the published version **and**, while `latest_version` differs, that one too — so the panel lists an app under *Apps* and its successor under *Drafts* / *Pending sign-off* at the same time. Staff also get every **deprecated** version — superseded ones (neither active nor latest, found through the `STATE#deprecated` index) and retired ones — so the Deprecated tab is complete. Staff rows carry `spec`, `owner_sub`, `created_by_sub` and `history` (the version's EVENT items, newest first: `{ ts, actor_sub, actor, from_state, to_state, notes, signed }`) |
| `GET` | `/registry/apps/{app_id}` | `{ head, versions: VersionSummary[] }` |
| `GET` | `/registry/apps/{app_id}/versions/{version}` — `version` may be `active` or `latest` | `{ version, state, manifest, manifest_hash, signoff, renderer }` |
| `POST` | `/registry/apps` | `{ session_id }` — a drafting session becomes an app in `draft` (see `drafting-api.md`) |
| `POST` | `/registry/apps/{app_id}/versions` | `{ session_id }` — a new version from a session; the minor version is bumped, `parent_version` set |
| `POST` | `/registry/apps/{app_id}/versions/{version}/transitions` | `{ to, notes? }` — KMS-signed sign-off at `approved`, group provisioning at `published` |
| `GET` | `/registry/collections` | `{ collections: [{ collection_id, name, description, app_ids, updated_at, updated_by }] }` — staff get them whole; a clinician's collections name only the apps they may open, and one left with none is not sent, so neither a name nor a count tells them about apps they have no access to |
| `POST` | `/registry/collections` | `{ name, description?, app_ids }` — approvers and admins (`can_curate`); the id is `col_<slug of the name>` and stays through renames; every app id must exist (`404` names the unknown ones); `409` for a name whose slug exists |
| `PUT` | `/registry/collections/{collection_id}` | `{ name?, description?, app_ids? }` — one request for all the changes gathered in the form; nothing changed, nothing written |
| `DELETE` | `/registry/collections/{collection_id}` | removes it from the listing (the item stays, index key `COLLECTIONS#deleted`) |

Collections are audited like account changes (`platform.collection.created | updated | deleted`, with what changed in
one line) and never touch a version: the registry's immutability guardrails do not apply to them because nothing
clinical is in them.

### Record shapes — the library a `record` section writes with

A shape is a `RecordShape` document (a resource type — Goal, CarePlan, Encounter, DocumentReference — and the fields a
form for it has; see `med_app/docs/app-spec.md`) compiled by the manifest service to an artifact: the runtime rules the
composer embeds when an app says `shape: <id>`, plus a checksum. Shapes are versioned like apps under a lighter lifecycle
— `draft → published → deprecated`, no review step of their own, because the review that matters is the one of the app
that writes with them (the approver sees the fields in that manifest). One version is published at a time; apps keep the
artifact they were compiled with (pinned by checksum in the manifest), so superseding or deprecating a shape changes
nothing already in the registry.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/registry/shapes` | `{ shapes: [{ shape_id, name, description, resource, owner_sub, latest_version, latest_state, active_version, updated_at, updated_by, latest: { version, state, document, artifact, checksum, … }, published: { version, checksum, artifact } \| null }] }` — staff only (`403` otherwise: a clinician never needs the library, their apps carry the rules). `published.artifact` is what a compile resolves `shape: <id>` to |
| `GET` | `/registry/shapes/{shape_id}` | the same, plus `versions` (every version, newest first, each with its document and artifact) and `history` (the shape's events, newest first, each with its `version`) |
| `POST` | `/registry/shapes` | `{ document }` — authors and admins (`can_author`); the manifest service compiles the document (`422` with the compiler's issues otherwise); a shape for a kind the platform has not admitted (the artifact's `open_kind`) is administrators' alone (`403` otherwise); the id is the document's and `409` when it exists; `HEAD` + `V#0.1.0` (draft) + the creation event in one transaction |
| `PUT` | `/registry/shapes/{shape_id}` | `{ document }` — the owner (an author), approvers and admins; the id in the document must be the shape's. A latest version in `draft` is revised in place (the same document: nothing written); a published or deprecated one is followed by a new draft version (`next_minor`) |
| `POST` | `/registry/shapes/{shape_id}/versions/{version}/transitions` | `{ to: published \| deprecated, notes? }` — approvers and admins (`can_curate`). Publishing sets `active_version` and deprecates the version published before in the same transaction; deprecating the published version leaves `active_version` null |

The published artifact is handed to compiles with its `version`, which ends up — with the shape id — as the `meta.tag`
of every record written with the shape (see `dispatcher.md`, `write.fhir.record.create`).
Every step is a `platform.shape.created | revised | published | deprecated` audit record and an EVENT item on the shape.
`RegistryWriter.published_shapes()` is what an app compile is handed (`ManifestCompiler.compile(..., shapes=…)`); the
drafting agent and the drafts API read the same list through `app_creator.shapes.RegistryShapes` (the registry read
policy, `REGISTRY_TABLE_NAME`) and the panel through `GET /registry/shapes`, sending the published artifacts along with
`POST /manifest/compile` — the compiler never reads the table.

VERSION items created through the API also carry `spec_json`: the AppSpec the manifest was compiled from,
canonical JSON, immutable like `manifest_json`. Hand-authored versions (seeded) have none.

The frontend keeps validating each manifest with the same zod schema after fetching it — the
registry is trusted, but defence in depth costs nothing and catches a server/renderer schema skew
immediately. In `med_app` this becomes a `RegistrySource` interface with two implementations:
`LocalYamlRegistry` (today's `manifests/*.yaml`) and `RemoteRegistry` (the API above), selected by
`VITE_REGISTRY_MODE=local|remote`.

## 6. Things deliberately left out

- No `hospital_id` in keys — one table per deployment. If multi-tenancy ever happens, prefix `PK` with `HSP#{hospital_id}#` and nothing else changes.
- No TTL — versions are never deleted; superseded versions become `deprecated`.
- No audit records here — every primitive call is written by the dispatcher to Kinesis Firehose → S3 Object Lock; the registry only stores lifecycle events.
- No patient data, ever. A manifest describes an app, not a patient; this table can sit outside the PHI boundary.
