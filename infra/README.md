# Infrastructure (AWS CDK, Python)

One CDK app, any number of hospitals: one JSON file per hospital under `hospitals/`, one CDK stage per file, so
several hospitals deploy from the same checkout into the same account and region as `<hospital_id>-<Stack>`
(`hsp-musterstadt-ApiStack`) without touching each other — every resource name, SSM path and secret already carries the
hospital id. Region defaults to `eu-central-1`.

| Path | What |
|---|---|
| `hospitals/<hospital_id>.json` · `hospitals/<hospital_id>/` · `stacks/hospitals.py` | A hospital's deployment settings (`hospital_id`, `hospital_name`, `model_id`, `data_residency`, `reference_servers`, `hospital_servers`, `branding`, …; see *Adding a hospital*), validated at synth: unknown keys, a file not named after its id, an id that would not fit the resource names, credentials in the file, a palette that would not read, a logo file that is not in the hospital's folder are all refused. Nothing secret lives here — `hospital_servers.credentials_secret` is the *name* of the Secrets Manager secret |
| `app.py` | One `HospitalDeployment` stage per hospital file (`-c hospitals=hsp-a,hsp-b` for a subset), each `build(stage, hospital)` instantiating that hospital's stacks; refuses to synthesize a hospital whose `data_residency` would be broken by its region or the agent's model — see `stacks/residency.py` |
| `stacks/nag.py` · `tests/unit/test_cdk_nag.py` | cdk-nag: `app.py` runs the AWS Solutions rules (`AwsSolutionsChecks(reports=True, verbose=True)`) over every stack at synth; an error-level finding fails the synth. `stacks/nag.py` is the register of what the platform accepts and why — by shape for what the construct library produces (the Lambda logging policy, the `grant_*` prefixes on one named bucket/table/function, CDK's own custom-resource providers; anchored patterns, so a real `*` in our code is still an error), and per resource where the prototype leaves a thing to the hospital's operations team (access logs, WAF, Plus-tier user pool) or where the rule does not apply (the reference servers hold the synthetic record only; the default CloudFront certificate fixes the TLS policy). The report of every rule applied lands in `cdk.out/AwsSolutions-<hospital_id>-<hospital_id>-<Stack>-NagReport.csv` (cdk-nag prefixes the stage's id to the stack's name); the test synthesises a whole hospital and fails on any finding left — and checks the reports exist, because aspects do not cross stage boundaries and a rule pack added on the app would visit nothing |
| `stacks/residency.py` | Data residency as a synth-time check: under `data_residency: eu` the region must be an EU member-state region and `model_id` an `eu.` profile, an in-region model id or an EU application inference profile (`us.`/`global.` refused); also narrows the agent's Bedrock permissions to `eu-*` |
| `stacks/identity_stack.py` | The hospital's single Cognito user pool, the one web app client, platform groups (authors/approvers/admins), group-provisioning policy for publish time; the pool's emails from `stacks/email_templates.py` — invitation and recovery code in the panel's look, with the hospital's name and the panel's URL (the hosting stack's origin or `panel_url`), `invitation_language` en / de; `scripts/preview-emails.py` renders them to `.build/emails/` |
| `stacks/registry_stack.py` | App registry: DynamoDB table + KMS + least-privilege managed policies + SSM discovery |
| `stacks/app_registry_guard_stack.py` · `lambdas/registry_guard_alert/` | Optional guardrails on the registry table (deployed when the `app_registry_guard_admin_email` context is set): a table resource policy that denies item writes to every principal but the registry write Lambda and the operator roles in `app_registry_guard_allowed_principals` (administrators included — the seed scripts say so when denied); a CloudTrail trail of the table's data events; EventBridge rules for denied writes, writes from anyone else and tampering with the table or the trail, each an email through SNS written by a Lambda that can publish and nothing else |
| `stacks/audit_stack.py` · `medapp_shared/audit_model.py` · `docs/audit.md` | The audit trail: one DynamoDB table per hospital (records by UTC day, indexes by person, app and patient), its own KMS key, PITR, deletion protection, no TTL — records are kept indefinitely; an append-only write policy (PutItem, nothing else) for the dispatcher, user administration and the registry write API, a read policy for the audit API; `AuditSink` writes the log line and the item, fail-open |
| `stacks/api_stack.py` | HTTP API + Cognito JWT authorizer + the registry read Lambda (`lambdas/registry_api`) + the primitive dispatcher (`lambdas/dispatcher`) + user administration (`lambdas/user_admin`) + the audit read API (`lambdas/audit_api`); all share `medapp_shared` through a layer. The media bucket for photo documentation (private, encrypted, versioned, retained; `MEDIA_BUCKET` of the dispatcher, which alone puts and presigns — `lambdas/dispatcher/media_store.py`) |
| `medapp_shared/registry_model.py` → shapes, `lambdas/registry_api` + `lambdas/registry_write`, `app_creator/shapes.py` | The record-shape library — what a composed page's `record` section writes with (`shape: <id>`): `SHAPE#<id>` HEAD + versions (document + compiled artifact) under `draft → published → deprecated`, one published version at a time; authors create and revise (`POST/PUT /registry/shapes…`), approvers and admins publish and deprecate (`…/transitions`), staff read (`GET /registry/shapes[/{id}]`); every app compile is handed the published artifacts (the writer's `published_shapes()`, the agent's `RegistryShapes`, the panel's `GET`), the agent offers them through `list_record_shapes` and refuses an unpublished reference; audited `platform.shape.*` — see `docs/registry-table.md` |
| `medapp_shared/registry_model.py` → collections, `lambdas/registry_api` + `lambdas/registry_write` | Collections — how the hospital groups its published apps for the launcher: one item per collection (name, description, ordered app ids), listed to everyone with a clinician's view narrowed to the apps they may open, curated by approvers and admins (`can_curate`) through `POST/PUT/DELETE /registry/collections…` without any version moving; every change an audit record (`platform.collection.*`) — see `docs/registry-table.md` |
| `lambdas/audit_api/` | `GET /audit`, administrators only: the trail newest first within a range (seven days by default, 92 at most per query), narrowed by person, app, patient, kind group and outcome, read from whichever index the filters select, with a cursor — what the panel's Audit trail section shows — see `docs/audit.md` |
| `lambdas/user_admin/` | The panel's user management, administrators only: accounts of the pool with their groups (one `ListUsersInGroup` per group, not per user), register (create + invitation email), enable/disable, add to and remove from the platform groups, app role groups and the hospital's own, re-send an invitation; the two lock-out guards (never disable yourself, never leave `medapp-admins` yourself); one audit record per change (`platform.user.*`) — see `docs/identity.md` |
| `lambdas/dispatcher/` | Enforcement (version → published/staff → role → primitive → scope), primitive implementations, `FhirSource` (the bundled synthetic record, or a FHIR server over HTTP — SigV4 or bearer), the media store (photo bytes in S3, the Media in the record, presigned links for the panel), audit records — see `docs/dispatcher.md`; `seed.py` loads the record into a server |
| `stacks/reference_servers_stack.py` · `docs/reference-servers.md` | While `reference_servers` is true in the hospital's file: a HAPI FHIR server (Fargate + RDS) and an Orthanc PACS (Fargate, DICOMweb) behind one IAM-authorised HTTP API, seeded with the synthetic record and verified at deploy; the dispatcher is pointed at both. The stand-ins for the hospital's FHIR facade and PACS gateway |
| `stacks/viewer_stack.py` | With the reference or the hospital's servers: the OHIF Viewer (published `@ohif/app` build, pinned) on S3 + CloudFront, embedded by the panel on a selected study; whichever stack is its data source runs a Cognito-authenticated door for it and writes its `app-config.js` at deploy — with the reference door as a second data source named `reference`, which previews and mock-data panels open synthetic studies from (`/viewer/reference?…`) — see `docs/reference-servers.md` |
| `stacks/hospital_servers_stack.py` · `docs/hospital-servers.md` | While `hospital_servers` is set in the hospital's file: the hospital's own FHIR server and DICOMweb gateway reached with OAuth2 client credentials from Secrets Manager; the dispatcher's environment, a viewer door (JWT authorizer for the panel's users, a Lambda that forwards to the hospital's DICOMweb with the hospital's token), a definitions-only seed (questionnaires, never patients) that verifies the server answers |
| `lambdas/viewer_door/`, `medapp_shared/oauth2.py`, `medapp_shared/jwt_rs256.py` | The door Lambda (gzips large metadata, base64 frames; a frame the hospital's 10 MB gateway refuses is asked for again in a lossless compressed transfer syntax — JPEG-LS, JPEG 2000, RLE — which Orthanc transcodes on request; an answer over Lambda's 6 MB is spilled to a private, self-emptying bucket and the browser redirected to a two-minute presigned URL); the client-credentials token client (cached, renewed, re-reads the secret on rotation); Cognito token verification against the pool's JWKS |
| `seeding/dicom_seed.py`, `seeding/phantoms.py` | Generates the PACS seed at synth from the bundle's `ImagingStudy` resources: every declared series and instance sampled from analytic anatomy phantoms (CT thorax and abdomen, MR head, radiograph, ultrasound) with real geometry — so MPR and 3-D reconstruct — and the record's UIDs, dates and the MRN as `PatientID` (pydicom + numpy) |
| `lambdas/dispatcher/vocabulary.py` | The record's vocabulary: every distinct code on the connected FHIR server with display texts, counts, patients, units and panel components, read with `_elements` searches within a time budget by the data source's seed (at deploy and nightly) into the authoring stack's bucket — what the drafting assistant's `lookup_codes` searches beside the hand-written hints (`app_creator/vocabulary.py`) |
| `lambdas/dispatcher/dicomweb.py` | The imaging source: QIDO-RS by MRN (or by the Patient's resource id, `DICOM_PATIENT_ID_SOURCE=resource_id`, as the hospital's PACS keys studies), DICOM JSON → `ImagingStudy` with its series — what `data.dicom.studies.for_patient` uses when `DICOMWEB_BASE_URL` is set |
| `stacks/authoring_stack.py` | Drafting sessions table (TTL), the manifest service (Node.js — `med_app/src/spec` bundled at synth), the drafts API, the drafting agent worker (async; reads the record's vocabulary from the stack's `RecordVocabulary` bucket, which the data source's seed writes), the registry write API with the KMS sign-off key — see `docs/drafting-api.md` |
| `app_creator/` | The drafting agent (Strands on Bedrock): a conversation fills an AppSpec through tools; the TypeScript compiler in `med_app/src/spec` makes the manifest. Runtime-agnostic (`Drafter.turn`), terminal harness, evaluation corpus — see `app_creator/README.md` |
| `lambdas/drafts_api/`, `lambdas/registry_write/` | Sessions and async turns; create / iterate / lifecycle transitions with separation of duties; at publish the app's own forms (manifest `artifacts.questionnaires`) go to the record through the data source's seed Lambda (`task: definitions`, named by SSM `/medapp/<h>/data-source/definitions-writer` — `stacks/definitions.py`), asynchronously and best effort |
| `medapp_shared/http_auth.py` | Caller parsing from the JWT authorizer, shared by the API Lambdas |
| `scripts/seed-registry.py` | Loads `med_app/manifests/*.yaml` — the published showcase apps — into the table (HEAD + VERSION items, state from each manifest) and creates their Cognito role groups, as publishing through the API would; `--owner-name` / `--owner-email` put a person behind the seeded versions ("By: …" in the panel). Then the showcase collections (`med_app/collections/showcase.yaml`, the same file the mock registry shows) as COLLECTION items, ids from their names; then the bundled record shapes (`med_app/shapes/*.yaml`, compiled with the CLI — med_app needs its node_modules) as published SHAPE items so `shape: <id>` resolves in the deployed composer; `--force` overwrites, `--no-collections` / `--no-shapes` skip |
| `scripts/reset-registry.py` | A clean start: empties the registry (reports first, deletes with `--yes`), optionally the drafting sessions (`--drafts`) and the per-app Cognito groups (`--app-groups`), then re-seeds (`--seed`) |
| `scripts/create-user.sh` | Creates a Cognito user and adds groups — users are not stack resources |
| `scripts/reset-password.sh` | Resets a user's password (a temporary one, changed at the next sign-in; or `--email-code` for a recovery code) — for accounts that cannot use the sign-in screen's "Forgot your password?" (never signed in, no verified email) |
| `scripts/seed-reference.py` | Resets the reference FHIR server to the synthetic record and checks it answers the searches the primitives make, and that the PACS answers QIDO-RS by MRN with every declared study (`--verify-only` for the checks alone) |
| `scripts/viewer-local.py` | The OHIF viewer on your laptop against a DICOMweb server over the generated seed — no AWS; `--check` drives headless Chromium through a study and reports token, frames and console errors |
| `scripts/fhir-get.py` | Signed GET against the reference servers as yourself — a record, its `_history`, the latest Provenance, or with `--dicomweb` a QIDO-RS query — for demos and for looking at what the platform wrote; `--hospital` does the same against the hospital's servers with the stored client credentials |
| `scripts/record-vocabulary.py` | The record's vocabulary by hand: build it from the hospital's record (`--hospital`), the reference server or the bundle (`--bundle`, no AWS), write it (`--out`), refresh the deployed document (`--upload`), inspect (`--show`) or search it (`--find Hämoglobin`); `MEDAPP_VOCABULARY_FILE` feeds the harness |
| `scripts/set-hospital-credentials.py` | Stores (or rotates) the hospital's OAuth2 client id and secret in Secrets Manager under the name the hospital's file gives; `--check` obtains a token with what is stored. Like every script here it works on `HOSPITAL_ID`, or on the only hospital configured (`scripts/_hospital.py`) |
| `medapp_shared/sigv4.py` | Request signing for IAM-authorised endpoints (the reference server's API; a managed FHIR service later) |
| `scripts/smoke-authoring.py` | Exercises the deployed authoring loop through the real API as your user: draft (agent or `--from-spec`), compile, save, submit, optionally approve + publish |
| `medapp_shared/identity_model.py` | Group naming conventions and the who-may-author/approve rules — shared with the Lambdas, mirrored in the frontend |
| `medapp_shared/registry_model.py` | Keys, item shapes, lifecycle rules, scope hashing — shared by stacks and Lambda handlers |
| `docs/identity.md` | Pool design, what comes at publish time, planned token claims, federation |
| `docs/audit.md` | The audit trail: what each function records, the table and its indexes, append-only and fail-open by design, the read API, the panel's section, retention and what is not there yet |
| `docs/registry-table.md` | The registry table design: access patterns, item shapes, write protocols, immutability guardrails, API surface |
| `docs/drafting-api.md` | The authoring API: drafting sessions and the async turn protocol, PATCH operations, the manifest service, registry writes and the lifecycle rules, staging at synth |
| `stacks/hosting_stack.py` · `docs/hosting.md` | The panel on CloudFront: private S3 origin, SPA routing, security headers, the frontend built once at synth and shared by every hospital, `config.json` written at deploy (pool, API, modes, `VITE_BRANDING`), the hospital's logo files under `/branding/` |
| `tests/unit/`, `tests/integration/` | `pytest` from this folder; the integration tests run the dispatcher against the deployed reference servers (skipped unless `MEDAPP_FHIR_BASE_URL` is set), the viewer door as a browser (skipped unless `MEDAPP_TEST_USER`/`MEDAPP_TEST_PASSWORD` are set), and read-only against a hospital's own servers (skipped unless `MEDAPP_HOSPITAL_FHIR_BASE_URL` is set — see `docs/hospital-servers.md`) |

```bash
source .venv/bin/activate && pip install -r requirements-dev.txt
pytest
cdk synth                                    # every hospital under hospitals/; -c hospitals=hsp-musterstadt for one
scripts/set-hospital-credentials.py          # once, before the first deploy with hospital_servers: the client id and secret → Secrets Manager
cdk deploy --profile <isengard-profile> 'hsp-musterstadt/*'   # that hospital's stacks: incl. the reference servers while reference_servers is true, the hospital stack while hospital_servers is set
scripts/create-user.sh you@example.org medapp-admins medapp-authors medapp-approvers   # users are not stack resources
scripts/seed-registry.py                                                               # the hospital's seed set (med_app/showcase/<id>.yaml: apps + collections) + record shapes → DynamoDB (reset-registry.py --yes --seed replaces an older set)
scripts/seed-reference.py                                                              # reset the reference FHIR server to the seed and verify
# Registry guardrails (optional; seed first — the deny policy then blocks the seed scripts unless their role is listed):
# set app_registry_guard_admin_email (and app_registry_guard_allowed_principals) in the hospital's file, then
cdk deploy hsp-musterstadt/AppRegistryGuardStack                                          # confirm the SNS subscription email
```

With several hospitals configured, `HOSPITAL_ID=hsp-… ` in front of a script names the one it works on. Every stack
lives in a stage, so the CLI's `--all` (main-assembly stacks only) finds nothing — `cdk deploy '**'` deploys every
hospital, `cdk list` shows the `hsp-musterstadt/ApiStack` paths the patterns match. `cdk destroy 'hsp-musterstadt/*'` removes
one hospital's stacks; what it leaves behind on purpose (`RETAIN`) must go by hand before the same id deploys again,
because the names are fixed: the DynamoDB tables `medapp-<id>-registry` and `-audit` (deletion protection on — switch
it off first) and `-drafts`, the user pool `medapp-<id>` (deletion protection on), the Lambda log groups
`/aws/lambda/medapp-<id>-*` (CDK-managed, retained), plus the unnamed trail bucket and the KMS keys (schedule deletion).
The retained **media bucket** is different: the photos the record's Media resources point at live there, by a
bucket-relative key (`medapp-media://<key>`), so a hospital whose record outlives the deployment keeps its pictures by
copying the objects into the new deployment's bucket — `aws s3 sync s3://<old apistack-mediabucket…>
s3://<new hsp-<id>-apistack-mediabucket…>` — and only then deleting the old one; without the copy every existing photo
loads as 403. The hospital's credentials secret is not a stack resource and stays. Deleting the file removes the hospital
from the app.

### Adding a hospital

1. Copy `hospitals/hsp-musterstadt.json` to `hospitals/<hospital_id>.json` and edit it. `hospital_id` (3–15 lowercase
   letters, digits, hyphens) names the file and every resource — it never changes once deployed. Keys and their meaning:
   `hospital_name`, `invitation_language` (en | de), `model_id` and `data_residency` (`eu` checks region and model at
   synth), `region` (default `eu-central-1`), `mfa_required`, `cognito_domain_prefix` (globally unique, so one per
   hospital), `panel_url`, `frontend_origins`, `reference_servers`, `hospital_servers` (the hospital's FHIR and DICOMweb
   base URLs, token URL, scope, the **name** of the credentials secret — `medapp/<hospital_id>/hospital-client` by
   convention — and how imaging joins patients), `data_source`/`fhir_base_url`/`fhir_auth`/`dicomweb_base_url`/
   `ohif_viewer_url` for a plain gateway without the two stacks, `app_registry_guard_admin_email` and
   `app_registry_guard_allowed_principals`. Unknown keys fail the synth, so a typo cannot silently fall back to a default.
   `branding` gives the hospital its own look without a build: `"palette"` overrides any of the panel's ten colours
   (`page, surface, ink, muted, line, accent, data, data2, data3, alert`, `#RRGGBB`; the rest keep the defaults of
   `med_app/src/branding.ts`) and `"logo"` names files in `hospitals/<hospital_id>/` (`src`, `alt`, optional `height`
   12–64 px, `srcOnDark` for the dark sign-in panel, `hideName` for a wordmark). The HostingStack serves the folder under
   `/branding/`, config.json carries the palette and logo to the panel (`VITE_BRANDING`), the user pool's emails take the
   palette, and the panel's contrast rules (text on page and cards, accent and alerts on white, light text on the dark
   panel, neutrals from dark to light) run at synth — an unreadable palette does not deploy. The shipped
   `hospitals/hsp-musterstadt.json` + `hospitals/hsp-musterstadt/` is the worked example (a blue accent, a wordmark and its
   light variant); leave `branding` out for the defaults of `med_app/src/branding.ts`.
2. `HOSPITAL_ID=<hospital_id> scripts/set-hospital-credentials.py` if it has `hospital_servers`.
3. `cdk synth -c hospitals=<hospital_id>` — the residency check, the hospital-servers validation and cdk-nag run on
   the new deployment alone — then `cdk deploy '<hospital_id>/*'`, the user and seed scripts with `HOSPITAL_ID` set.
4. Its apps: a seed set `med_app/showcase/<hospital_id>.yaml` compiled with `npm run showcase` (see `med_app/README.md`,
   *The seed sets*); `HOSPITAL_ID=<hospital_id> scripts/seed-registry.py` writes it. Without one, the registry starts empty.

Account- and region-wide limits to keep in mind as hospitals accumulate: each `reference_servers: true` is a VPC
(default quota 5 per region), each guardrails stack a CloudTrail trail (5 per region), and all hospitals share the
account's Lambda concurrency and Bedrock quotas.

The panel is live at the HostingStack's `SiteUrl` output (CloudFront) once the hospital has deployed: the
frontend is built at synth time from `../med_app` and reads its Cognito/API settings from a `config.json`
the ApiStack writes at deploy, so no `.env` is involved (see `docs/hosting.md`). For the dev server
against the deployed backend, `med_app/.env` takes the identity stack's `ViteCognito*` and
`ViteHospitalName` outputs with `VITE_AUTH_MODE=cognito`, and the API stack's `ViteApiBaseUrl` as
`VITE_API_BASE_URL` with `VITE_REGISTRY_MODE=remote` and `VITE_DATA_MODE=dispatcher`. The launcher lists
what `GET /registry/apps` returns for the signed-in person, and every data call goes through
`POST /primitives/{kind}` — served from the synthetic bundle, from the reference FHIR server while
`reference_servers` is true, or from the hospital's own servers while `hospital_servers` is set (OAuth2 client
credentials, `docs/hospital-servers.md`); a plain gateway with a static token is `"data_source": "fhir"` with
`fhir_base_url` and `fhir_auth` (`bearer` | `none`) in the hospital's file.

---

# Welcome to your CDK Python project!

This is a blank project for CDK development with Python.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

This project is set up like a standard Python project.  The initialization
process also creates a virtualenv within this project, stored under the `.venv`
directory.  To create the virtualenv it assumes that there is a `python3`
(or `python` for Windows) executable in your path with access to the `venv`
package. If for any reason the automatic creation of the virtualenv fails,
you can create the virtualenv manually.

To manually create a virtualenv on MacOS and Linux:

```
$ python3 -m venv .venv
```

After the init process completes and the virtualenv is created, you can use the following
step to activate your virtualenv.

```
$ source .venv/bin/activate
```

If you are a Windows platform, you would activate the virtualenv like this:

```
% .venv\Scripts\activate.bat
```

Once the virtualenv is activated, you can install the required dependencies.

```
$ pip install -r requirements.txt
```

At this point you can now synthesize the CloudFormation template for this code.

```
$ cdk synth
```

To add additional dependencies, for example other CDK libraries, just add
them to your `requirements.txt` file and rerun the `python -m pip install -r requirements.txt`
command.

## Useful commands

 * `cdk ls`          list all stacks in the app
 * `cdk synth`       emits the synthesized CloudFormation template
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk docs`        open CDK documentation

Enjoy!
