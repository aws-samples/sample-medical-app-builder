# Drafting, compiling and publishing — the authoring API

How a conversation becomes a registered app, in the deployed platform. Everything below sits behind the
hospital's HTTP API with the Cognito JWT authorizer; the functions live in the `AuthoringStack`.

```
panel ──POST /drafts/{id}/turns──▶ drafts API ──async invoke──▶ drafting agent ──tools──▶ draft (DynamoDB)
  │                                    │                              │
  │◀── GET /drafts/{id} (poll) ────────┘                              └──▶ manifest service (readiness / compile)
  │
  └──POST /registry/apps {session_id}──▶ registry write ──compile──▶ manifest service ──▶ HEAD + VERSION (+ spec) in draft
                                             └── transitions: in_review → approved (KMS-signed) → published (groups created)
```

## Drafting sessions — `/drafts` (authors and admins)

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/drafts` | `{ message?, spec?, iterates?, from_session? }` | `201 { session_id, turn }` — a new draft; with a message, the first turn is queued; with `from_session` (one of the caller's saved drafts) the new draft continues that conversation — messages, spec, refusals — as a new version of the app it was saved as (`iterates` overrides), `404` if the draft is not the caller's, `409` while the agent still works on it; with a `spec` (and `iterates: {app_id, version}`) the draft starts from a saved app's spec alone, `422 { rejected }` if that spec does not validate |
| `GET` | `/drafts` | | `200 { drafts: [ { session_id, title, archetype, updated_at, turn_status, saved_as } ] }` — the caller's drafts |
| `GET` | `/drafts/{id}` | | `200 { session_id, title, spec, open, refusals, transcript, turn, saved_as, iterates, … }` |
| `GET` | `/groups` | | `200 { groups: [ { name, description } ] }` — the hospital groups a role may bind to (the same list the agent's `list_groups` tool sees) |
| `PATCH` | `/drafts/{id}` | `{ ops: [ { op, args } ] }` | `200 { spec, open }` · `422 { rejected }` · `409` while a turn runs or after saving |
| `DELETE` | `/drafts/{id}` | | `204` — the conversation is removed for good · `409` while a turn runs, or once it has been saved (it is then the version's record; deprecate the version instead) |
| `POST` | `/drafts/{id}/turns` | `{ message }` | `202 { turn }` · `409` while a turn runs or after saving |

A draft is visible to its author only — admins included, nobody else can list, read, edit or save it
(a `404`, so there is no oracle for other people's drafts); oversight begins when a version is saved to
the registry. `open` is the readiness checklist — what the conversation
still has to settle — computed the same way the agent computes it.

**Turns are asynchronous.** `POST …/turns` records `turn = { id, status: "queued", message, progress: [] }`,
invokes the agent worker and returns. The panel polls `GET /drafts/{id}`: `status` moves to `running`,
`progress` fills with tool names as they run (`lookup_codes`, `set_knobs`, `add_role`, …), and ends `done`
with `reply`, `tool_calls` and `open`, or `failed` with a short `error`. A second message before that is a
`409`. The worker never replays a turn (`MaximumRetryAttempts: 0`); a crash leaves `failed`, and the user
sends the message again.

**PATCH is the panel's structured editor.** Its operations are the agent's tools with the same validation
(`app_creator.draft.Draft`): `choose_archetype {archetype, reason}`, `set_app {app_id?, name?, description?,
language?}`, `set_knobs {patch}`, `add_role {role}`, `update_role {id, patch}`, `remove_role {id}`,
`set_default_role {id}`, `set_governance {patch}`. A batch applies atomically — one rejected value
(`knobs.window: 'yesterday' does not match …`, `"onkologie" is not an existing group`) rejects the whole
batch with `422` and the precise path. Nothing can enter a draft from the form that the conversation could
not have produced, and vice versa.

**The panel.** `med_app/src/panel/DraftingPage.tsx` is the UI over these routes: the conversation on the
left (`POST …/turns`, polling `GET /drafts/{id}` every 2 s while a turn is queued or running), the draft on
the right — a readiness checklist from `open`, and tabs App / Roles & access / Governance / Settings /
Preview whose form controls each send one `PATCH` operation. Settings are shown as a readable summary
(the chat is the way to change them; staff get a YAML editor that goes through the same `set_knobs`
operation). Preview calls `POST /manifest/compile` and renders the manifest with the real renderer on
synthetic data. "Save to registry" is `POST /registry/apps` (or `…/{app_id}/versions` when the draft
`iterates` on an app, or `PUT …/versions/{version}` — "Save changes" — while the version the draft was
saved as is still a draft: the conversation stays editable until submission, and the registry writer
stamps `saved_as.state` on it so the panel and the drafts API know when it froze); "Submit for review"
is a separate transition. The app page's inspector drawer and the review page
(`/apps/:appId/:version/review` — what the version changes against the published one: access first, then data, actions,
forms, purpose and the spec's settings; `med_app/src/review/`) carry the rest of the lifecycle (approve, publish, send
back, deprecate) and "Iterate on this app",
which opens `POST /drafts` with `from_session` when the caller's own saved draft produced that version —
the conversation continues in the new draft — and with the stored `spec` alone otherwise. `med_app/src/authoring/` holds the client; the same
page runs in mock mode over `localAuthoringClient` (the draft operations mirrored in TypeScript, the
compiler in-process, a local registry store) — without the agent, which only exists behind the API.

## Manifest service — `/manifest` (staff)

`POST /manifest/compile { spec }` → `200 { ok, manifest }` or `422 { ok: false, issues }`;
`POST /manifest/readiness { spec }` → `{ ready, missing }`; `POST /manifest/validate { manifest }`.
This is `med_app/src/spec` bundled as a Node.js Lambda (`scripts/bundle-lambda.mjs`, staged at synth) — the
only place a manifest is produced in the deployed platform. The agent worker and the registry writer invoke
the same function directly with `{ action, spec, … }`.

## Registry writes — `/registry/apps` (staff; who-may rules from `identity_model`)

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/registry/apps` | `{ session_id }` | `201 { app_id, version: "0.1.0", state: "draft", manifest_hash }` — authors/admins |
| `POST` | `/registry/apps/{app_id}/versions` | `{ session_id }` | `201 { app_id, version, parent_version, … }` — the owner or an admin; the minor version is bumped |
| `PUT` | `/registry/apps/{app_id}/versions/{version}` | `{ session_id }` | `200 { app_id, version, state, revised }` — revise a **draft** version in place from the conversation it was saved from (owner or admin, `409` once it is `in_review` or beyond — iterate instead); every revision is a lifecycle event |
| `POST` | `/registry/apps/{app_id}/versions/{version}/transitions` | `{ to, notes? }` | `200 { app_id, version, state, signoff? }` — `notes` are read by the other side: a reviewer's reason for sending a version back is shown to its author (Drafts tab, drafting page, inspector) until they resubmit; an approver's notes stay on the version as its sign-off. Every event records who, as a name and email from the token |

Creating compiles the draft's spec through the manifest service and writes, in one `TransactWriteItems`,
the VERSION item (frozen `manifest_json`, its hash, and `spec_json` — the AppSpec, so "iterate" reopens
exactly what was built), the HEAD item (or its advance with an optimistic `latest_version` check) and a
creation EVENT. The draft is then marked `saved_as` and closed. Refused before anything is written: a spec
that does not compile (`422` with the issues), an `app_id` that exists (`409`), a role bound to a group the
user pool does not have (`409`, `missing_groups`).

Transitions follow `LIFECYCLE_TRANSITIONS` (`draft → in_review → approved → published → deprecated`,
`in_review → draft` as rejection, `approved → draft` to reopen) with these rules:

| To | Who |
|---|---|
| `in_review` | the app's owner, or an admin |
| `approved`, `published` | approvers and admins — **never the version's own author** (`can_approve`) |
| `draft` (back) | a reviewer, or the owner |
| `deprecated` | owner, approver or admin |

At **approval** the stored `manifest_hash` is signed with the hospital's KMS key (`alias/medapp/<hospital>/signoff`,
ECC P-256): `signoff = { approver_sub, approved_at, signature: "kms:ECDSA_SHA_256:<base64>", clinical_notes }`
on the VERSION item and on the EVENT. At **publication** every role bound to an existing group is checked
against the pool (`409` if any is missing), the app's own groups `app-<app_id>-<role>` are created
(idempotently), `HEAD.active_version` moves, and the version that was published before becomes `deprecated`
with its own EVENT — one transaction, so there is never more than one published version. Every transition is
conditioned on the current state (`state = :from`), so a concurrent change fails closed with `409`.

## Storage and permissions

| Table | Purpose |
|---|---|
| `medapp-<hospital>-drafts` (AuthoringStack) | sessions: spec, conversation (Strands messages, older tool results trimmed), events, refusals, `turn`, `saved_as`; TTL `expires_at` (30 days); GSI `ByAuthor` projecting only summary attributes; own CMK; **transient** (no retain) |
| `medapp-<hospital>-registry` (RegistryStack) | the record: HEAD / VERSION (now with `spec_json`) / EVENT — unchanged design, see `registry-table.md` |
| `medapp-<hospital>-audit` (AuditStack) | the audit trail: the registry write API appends one `lifecycle.*` record per create, revision and transition (append-only policy, fail-open) — see `audit.md` |

| Function | May |
|---|---|
| drafting agent | read/write drafts; invoke the manifest service; `bedrock:InvokeModel*` on foundation models and inference profiles; `cognito-idp:ListGroups` |
| drafts API | read/write drafts; invoke the agent; `cognito-idp:ListGroups` |
| registry write | registry writer policy (Put/Update/Get/Query + KMS); read/write drafts (`saved_as`); invoke the manifest service; `kms:Sign` on the sign-off key; the identity group-provisioning policy; the audit write policy (PutItem only) |
| manifest service | nothing beyond logs — pure computation |

## Synth-time staging

`cdk synth` stages three assets into `infra/.build/` (git-ignored): the shared layer (`medapp_shared`),
the manifest-service bundle (`node scripts/bundle-lambda.mjs` in `med_app` — needs `node_modules` there;
`MEDAPP_APP_DIR` points elsewhere if needed), and the agent dependency layer (`pip install` of
`app_creator/requirements.txt` with platform-targeted wheels for arm64 / CPython 3.14, cached by hash;
boto3 dropped because the runtime provides it). The Python functions share one code asset:
`app_creator/`, the two handlers, and the catalog files the agent reads (`MEDAPP_CATALOG_DIR=/var/task/data`).

Model choice: `model_id` in the hospital's file (`hospitals/<id>.json`; required, like `hospital_id` — there is no
library default), published as SSM `/medapp/<hospital>/authoring/model-id` and used by the terminal
harness and the corpus runner too. The hospital's display name the agent uses comes from the IdentityStack
(`hospital_name` in the hospital's file, also published as SSM `/medapp/<hospital>/name` and the `ViteHospitalName`
output for the frontend's `.env`). For EU data residency use an `eu.` inference profile. The turn worker runs
with 1 GB and a 5-minute limit.

## Smoke test after a deploy

`scripts/smoke-authoring.py --email <author>` (with `MEDAPP_PASSWORD` set, `pip install pycognito`) runs the whole
loop through the API: a draft with a first message, polling the asynchronous turn with its progress, a follow-up
turn, compile, save to the registry (the app stays in `draft`, as it will from the panel) — with `--submit` it is
submitted for review, and with `--approver-email` a second user approves (KMS signature) and publishes (groups created). `--from-spec ../med_app/specs/bp-trend.yaml` skips the model and
PATCHes a complete spec instead, which checks everything except Bedrock. `--app-id` picks another id when the
default one already exists.
