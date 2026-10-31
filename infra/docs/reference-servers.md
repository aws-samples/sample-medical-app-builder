# Reference servers

A FHIR R4 server and a DICOMweb PACS that stand in for the hospital's systems until those are reachable,
seeded with the same synthetic record the in-memory source serves. Part of the deployment while
`"reference_servers": true` is in the hospital's file (`hospitals/<id>.json`), and standards-plain on purpose: the day a hospital gives you a
gateway URL, the switch is configuration, not a redesign.

## Why

Until this stack existed, every deployment served the synthetic bundle from the dispatcher's memory. The HTTP
path of the dispatcher — search parameters, paging through `next` links, conditional creates, versioned
updates, the 409 on a stale version — had only ever run against the in-memory source and unit tests. A real
server is where the assumptions get tested, and where writes become demonstrable: a nurse records a reading and
the Observation, its Provenance and the Condition's version history are sitting in a server anyone can inspect.
It also changes the conversation with the hospital from "prototype on fake data" to "point it at your FHIR
facade": authentication, network and TLS become concrete questions. The PACS does the same for imaging: until
it existed, `data.dicom.studies.for_patient` was a FHIR `ImagingStudy` search in disguise and the viewer had
never had a backend. Now the primitive does a real QIDO-RS query by hospital MRN — the join a real PACS
offers — and OHIF has something to point at.

## Shape

```
                                     ┌──────────────────── ReferenceServersStack ──────────────────────────────────┐
  dispatcher Lambda ── SigV4 ──▶  HTTP API (HTTPS, IAM) ── VPC link ──▶ internal ALB :80 ─┬─ /fhir* ──────▶ HAPI FHIR (Fargate, ARM64, 1 vCPU/2 GB)
  seed function     ── SigV4 ──▶   /fhir/{proxy+}                        isolated subnets   │                       │ public subnet, SG: ALB only
  scripts/…         ── SigV4 ──▶   /dicom-web/{proxy+}                                      │              RDS Postgres 16 (db.t4g.micro), isolated
                                                                                             └─ /dicom-web* ─▶ Orthanc (Fargate, ARM64, ½ vCPU/1 GB)
                                                                                                                 init container: aws s3 sync ──▶ /seed
                                                                                                                 S3 seed bucket ◀── BucketDeployment (generated at synth)
```

Cost first: no NAT gateway and no interface endpoints. The Fargate tasks sit in a public subnet so they can
pull their images through the internet gateway; their security groups admit only the load balancer. The
database, the load balancer and the API's VPC link sit in isolated subnets. The dispatcher stays outside the
VPC — it needs Cognito, DynamoDB and Bedrock as before — and reaches both servers through the API with
SigV4-signed requests. Nothing here is reachable from the internet without an IAM identity allowed to invoke
the API; neither server has authentication of its own, which is exactly why they are never exposed directly.

| Piece | Choice | Why |
|---|---|---|
| FHIR server | `hapiproject/hapi:v8.12.0-1` (HAPI FHIR JPA starter), pinned, ARM64, 1 vCPU / 2 GB | the reference implementation; whatever runs behind the hospital's facade, HAPI-compatible is the right target |
| Database | RDS Postgres 16, `db.t4g.micro`, 20 GB gp3, single AZ, encrypted, `DESTROY` on delete | persistence across task restarts so demo writes survive a redeploy; synthetic data, so disposable |
| PACS | `orthancteam/orthanc:26.9.0`, pinned, ARM64, ½ vCPU / 1 GB, DICOMweb and Indexer plugins, no DICOM network port (`orthanc_settings()`) | the open-source reference PACS; QIDO-RS/WADO-RS is what a hospital gateway speaks |
| Imaging seed | generated at synth by `seeding/dicom_seed.py` from the bundle's `ImagingStudy` resources (1005 instances, 111 MB), deployed to a private S3 bucket; an init container (`aws s3 sync`) copies it into the task at every start; the Indexer plugin publishes the folder | the seed is the truth and a restart rebuilds the PACS — no EFS, no second database, nothing to back up; imaging is read-only in this slice |
| Front door | HTTP API with `HttpIamAuthorizer` on `ANY /fhir`, `/fhir/{proxy+}`, `/dicom-web`, `/dicom-web/{proxy+}`; one private integration to the ALB, which routes by path | HTTPS without a certificate of our own, IAM instead of a shared secret, and the same door OHIF will use later with a JWT authorizer |
| Settings | `SPRING_APPLICATION_JSON` (see `hapi_settings()` in the stack) | exact property names; `server_address` = the API URL so `next` links resolve, `reuse_cached_search_results_millis: 0` so a reading recorded a second ago is in the next search, `allow_external_references` for canonical questionnaire URLs, page sizes 100/500, everything unused (OpenAPI, MDM, CQL, CDS Hooks, bulk, the MCP endpoint) off |
| Health | ALB health check on `/actuator/health`, 5 min grace, one task at a time (`min 0 % / max 100 %`), circuit breaker with rollback | a JVM plus schema creation on a small database takes minutes; two HAPI instances migrating one schema is not wanted |
| Seed | `Custom::MedAppReferenceSeed` → `seed.lambda_handler` (the dispatcher's package) | runs once both services are stable and the routes and its permission exist; again when the bundle's or the imaging seed's hash changes; verifies FHIR searches and QIDO by MRN |
| Viewer door | `GET /viewer/dicom-web/{proxy+}` with a Cognito JWT authorizer, path rewritten to `/dicom-web/…`, CORS for the viewer and panel origins | browsers (the OHIF viewer) read the PACS with the panel's session; see "The viewer" |
| Discovery | SSM `/medapp/<hospital>/reference/fhir-base-url`, `…/dicomweb-base-url`, `…/viewer-dicomweb-base-url`, `…/api-id`; outputs `FhirBaseUrl`, `DicomWebBaseUrl`, `ViewerDicomWebUrl`, `SeedSummary` | scripts and people find the endpoints without reading CloudFormation |

Running cost, roughly: Fargate ≈ €36 + €18 / month, RDS ≈ €15, the load balancer ≈ €17, S3, CloudFront for
the viewer, logs and the API a few euros — about €90 / month; HealthLake alone would be about twice that.
`cdk destroy ReferenceServersStack ViewerStack` removes everything including the database, the seed bucket
and the viewer.

## Deploying

```bash
cd infra
cdk deploy --all                                      # first time: the VPC's AZ lookup lands in cdk.context.json — commit it
```

`"reference_servers": true` in the hospital's file makes `app.py` create the stack and hand the ApiStack
`data_source=fhir`, `fhir_base_url=<api>/fhir`, `fhir_auth=sigv4` and `dicomweb_base_url=<api>/dicom-web`,
and grant the dispatcher's role `execute-api:Invoke` on the FHIR and DICOMweb routes. Synth generates the
imaging seed (`pydicom` and `numpy` are in `requirements.txt` for that), cached under `.build/dicom-seed` by
the hash of the bundle's imaging and patient resources. It is deployment configuration rather than a per-deploy switch on
purpose: a deploy without it would not just skip this stack, it would redeploy the ApiStack with the in-memory
bundle. To turn the servers off, set it to `false` (or `-c reference_servers=false` once), deploy, then
`cdk destroy ReferenceServersStack` — the stack is not part of the app while the flag is off, so nothing
destroys it implicitly. The first deployment takes a while: the database (~10 min), then the service, then the
seed. The `SeedSummary` output says `none` when every search the primitives rely on was answered by the seeded
data, or lists what was not.

## The seed

`lambdas/dispatcher/seed.py` turns the collection bundle into one FHIR transaction of `PUT <type>/<id>`
entries, so the ids every manifest, test and screenshot refers to (`pat-kms-0001`, `cond-kms-0003`, …)
are the ids on the server too. Re-running is a reset, not a duplicate: a PUT with unchanged content is a no-op
on HAPI; a record a demo changed goes back to its seeded state as a new version, so the demo's history stays.
Resources a demo created — recorded readings, Provenance — stay as well.

```bash
scripts/seed-reference.py                 # reset to the seed, then verify
scripts/seed-reference.py --verify-only   # only the checks
```

The verification (`seed.VERIFICATIONS`) asks the server the questions the primitives ask — the blood-pressure
panel found through a component code (`combo-code`), a readings window newest first, active problems, the
hypertension cohort by SNOMED code, active medication, the questionnaire by canonical URL and earlier
responses by that URL, imaging studies, allergies through the `patient` parameter, radiology reports by
category, visits, notes, procedures, immunizations — and reports every one the server answers differently
from the in-memory source. That list is the point of a reference server: a difference shows up at deploy
time, not in a demo. The same code runs against a local fake server in `tests/unit/test_http_fhir_source.py`,
so the seed's own logic is tested without AWS.

The PACS is not seeded by the custom resource — its studies arrive with the task, see above — but it is
verified by it: `seed.verify_dicom()` asks QIDO-RS for every MRN and expects every `StudyInstanceUID` the
bundle declares for that patient, waiting up to two minutes for the Indexer's first pass after a fresh start.
It then reads one instance's WADO-RS metadata and expects `SoftwareVersions` to be this deployment's seed
marker (`dicom-seed-2 <first twelve hex digits of the seed hash>`, written into every generated instance),
because the task copies the seed only when it starts: the seed hash is therefore also an environment variable
of the Orthanc container, so a changed seed is a new task definition and ECS replaces the task — and if a task
were ever left serving an earlier seed, the `SeedSummary` output says so instead of the viewer quietly showing
old images.
The generated studies (`seeding/dicom_seed.py`) carry exactly the declared series and instance counts and UIDs,
the record's dates with their timezone, the MRN as `PatientID` with the MRN system as its issuer, the patient's
name, birth date and sex, modality-specific SOP classes and the geometry a viewer needs to scroll and
reconstruct. The pixels are analytic phantoms (`seeding/phantoms.py`): every volume is a function of patient
coordinates in millimetres — a thorax with lungs, a contrast-filled heart and aorta, a spine with discs, a rib
cage, sternum and a nodule; an abdomen with liver, spleen, kidneys, bladder, lower ribs, pelvis and femoral
heads; a head with skull, grey and white matter, ventricles, sulci, eyes and a lesion, rendered with T1, FLAIR,
DWI and SWI intensities — so the axial series, its coronal reformat and a sagittal series cut the same body,
and a viewer's MPR and 3-D volume rendering see consistent anatomy wherever they slice. CT is 256×256 with
1 mm (thorax) or 3 mm (abdomen) slices in Hounsfield units, MR 192×192, radiographs and ultrasound 2-D images;
111 MB in all. Nothing here is or resembles a real patient's image — the shapes are ellipsoids and cylinders,
obviously synthetic to anyone who looks — and generation is byte-for-byte deterministic so the asset hash only
changes when the seed does (`GENERATOR_VERSION` in `dicom_seed.py`; bump it when the phantoms change).

## Looking at the servers

Requests need an IAM signature, so plain `curl` gets `Forbidden` (and so does `awscurl` when it cannot resolve
the profile's credentials the way boto3 does). `scripts/fhir-get.py` signs the way the dispatcher does, with the
credential chain the AWS CLI uses:

```bash
scripts/fhir-get.py 'Provenance?_sort=-recorded&_count=3' --summary    # who wrote what, most recent first
scripts/fhir-get.py Condition/cond-kms-0003/_history --summary       # every version of a record
scripts/fhir-get.py Patient/pat-kms-0001 | jq .identifier
scripts/fhir-get.py --dicomweb 'studies?PatientID=KMS-0048213' --summary   # the PACS, QIDO-RS by MRN
```

This is the demo moment after a nurse records a reading or resolves a problem in the panel: the record, its
Provenance and its version history in a standard FHIR server, not in our UI.

## Verifying the dispatcher against it

```bash
export MEDAPP_FHIR_BASE_URL=$(aws ssm get-parameter --name /medapp/hsp-musterstadt/reference/fhir-base-url --query Parameter.Value --output text)
export MEDAPP_DICOMWEB_BASE_URL=$(aws ssm get-parameter --name /medapp/hsp-musterstadt/reference/dicomweb-base-url --query Parameter.Value --output text)
pytest tests/integration -v
```

`tests/integration/test_reference_fhir.py` runs the real `Dispatcher` (enforcement, primitives, audit) with the
real HTTP client against the server, signed with your credentials: reads (patient, two years of blood pressure
by panel code newest first, active problems, earlier assessments by canonical URL); a reading recorded through
`write.fhir.observation.create` that is in the very next trend search, a replay of the same submission that is
one record with one Provenance, an implausible value refused with 422; a problem resolved with the version the
client saw (new version, history kept, note, Provenance with the revision), a stale version refused with 409;
a prescription stopped with its reason; and, with the PACS URL set, QIDO-RS by MRN returning every declared
study with the right counts, and `data.dicom.studies.for_patient` through the dispatcher returning them as
`ImagingStudy` resources newest first, filtered by modality. The record is reset to the seed before and after.
The tests are skipped when the URLs are unset, so `pytest` stays green offline.

TLS trust: the client verifies against the platform's certificate store when it has one (Lambda), and otherwise
against the CA bundle the AWS SDK carries — python.org and pyenv builds of Python on macOS read no system store,
and without this every HTTPS call from a laptop failed with `CERTIFICATE_VERIFY_FAILED: unable to get local
issuer certificate`. `FHIR_CA_BUNDLE=/path/to/ca.pem` names the trust explicitly (a hospital gateway with a
private CA, a corporate proxy that re-signs TLS); it then replaces the platform store rather than adding to it.

## Imaging in the dispatcher

With `DICOMWEB_BASE_URL` set (the ApiStack sets it from the stack), `data.dicom.studies.for_patient` reads the
FHIR Patient, takes the identifier of the MRN system (`DICOM_PATIENT_ID_SYSTEM`, default the record's
`https://klinikum-musterstadt.example/fhir/sid/mrn`; falls back to an identifier typed MR/MRN), queries
`studies?PatientID=<mrn>` with `includefield`s for description, modalities and counts, and maps the DICOM JSON
to the `ImagingStudy` shape the renderer already consumes — `identifier urn:oid:<StudyInstanceUID>`, `started`
from StudyDate/StudyTime with the PACS's `TimezoneOffsetFromUTC`, modalities, series/instance counts,
description, accession number, referrer — and, with one more QIDO call per study (`studies/{uid}/series`),
the study's series with their instance counts, so the viewer knows which series is the volume to reconstruct.
Manifests, scopes (`dicom.qido`) and components do not change; without the variable the primitive keeps reading
`ImagingStudy` resources from the FHIR source (bundle mode). `DICOMWEB_AUTH` defaults to `FHIR_AUTH`;
`lambdas/dispatcher/dicomweb.py` is the whole of it.

## What changes for the hospital's servers

Nothing in the platform. `FHIR_BASE_URL` points at the facade, `FHIR_AUTH` says how to authenticate (`bearer`
today; SigV4 also fits a managed FHIR service such as HealthLake), `DICOMWEB_BASE_URL` at the PACS gateway's
QIDO-RS root, and the manifests, scopes and primitives are untouched. What the reference server cannot tell us is what the facade will support: the verification list
above is the checklist to run against it on day one (`scripts/seed-reference.py --verify-only --base-url …` with
the corresponding synthetic patients loaded, or the equivalent searches by hand).

## The viewer

`ViewerStack` (`stacks/viewer_stack.py`) serves the OHIF Viewer as its own site — a private S3 bucket behind
CloudFront, like the panel — and the panel's `DicomViewer` component embeds it on the selected study:

```
panel (CloudFront)  ── <iframe src="https://<viewer>/viewer?StudyInstanceUIDs=<uid>#token=<Cognito ID token>">
   viewer (CloudFront, OHIF)  ── app-config.js: fragment → sessionStorage → Authorization header
      ── GET https://<api>/viewer/dicom-web/…  (HTTP API, Cognito JWT authorizer, GET only)
         ── path rewritten to /dicom-web/…  ── VPC link ── ALB ── Orthanc (QIDO-RS, WADO-RS metadata and frames)
```

OHIF is the published build of `@ohif/app` from npm (pinned version and sha512 in the stack; downloaded once at
synth into `.build/ohif`, integrity-checked, filtered: no source maps, no ONNX runtime, no whole-slide viewer,
no Netlify files — 45 MB instead of 200). Nothing is built or forked; upgrading is bumping two constants.
Its `app-config.js` is ours, written at deploy by the ReferenceServersStack (`ViewerRuntimeConfig`, the same
pattern as the panel's `config.json`): one DICOMweb data source pointing at the browser door, `wadors` for
images and thumbnails, uploads and rejects off, and the token bridge.

The token bridge is how a separate origin gets the user's identity without a second login. The panel puts the
session's Cognito ID token in the **URL fragment** of the iframe — fragments are never sent to a server and
never appear in access logs — and app-config.js reads it once, keeps it in the tab's `sessionStorage`, removes
it from the URL, and attaches it as `Authorization: Bearer …` to every request to the PACS door. OHIF 3.12
takes that header from its own `userAuthenticationService` (filled by an OIDC login flow this deployment does
not have), not from the data source's `requestOptions.auth`, so app-config.js attaches it at the transport —
`XMLHttpRequest` and `fetch`, for URLs under the door only — and registers the same function with the service
once OHIF has created it. Two more things the published build needed: `__filename` defined (its ONNX runtime
glue, compiled with Node checks folded to true, touches it when the chunk loads — a `ReferenceError` that
stopped the viewer), and the onboarding tour switched off. The viewer's CloudFront distribution sends a
`frame-ancestors` CSP naming the panel (and localhost for development) instead of `X-Frame-Options`, so the
panel may embed it and nobody else may.

**Two data sources, one viewer.** When the hospital's servers are configured, the hospital stack writes the
app-config with the hospital's door as the default data source (`medapp`) and this stack's door as a second
one named `reference` — the synthetic record. OHIF registers a route per data source, so the panel opens a
study as `/viewer?StudyInstanceUIDs=…` for a clinician and as `/viewer/reference?StudyInstanceUIDs=…` whenever
the data on screen is synthetic: every preview in the drafting page, and a panel running in mock data mode
(`SYNTHETIC_VIEWER_SOURCE` in `med_app/src/config/env.ts`, `VITE_OHIF_DATA_SOURCE` overrides). First demo
round: previews listed the synthetic studies and the viewer asked the hospital's PACS for UIDs it could not
have. The hospital's PACS now never sees a synthetic UID, and a preview never touches a patient's study; the
token bridge covers both doors. Without a hospital block, this stack's door is both sources.

A reading viewer wants the whole screen, not a column: the panel's `DicomViewer` has two buttons in its header —
*expand*, which lays the same iframe over the page (no reload; Esc or the button brings the page back), and *full
screen*, the browser's own. The manifest's column ratio stays what the clinician asked for.

Next to them sits the layout control — **2D / MPR / 3D**. 2D opens the study as OHIF lays it out itself, the
stack of the first series. MPR opens OHIF's `mpr` hanging protocol (axial, coronal and sagittal reconstructed
from the volume), 3D its `fourUp` (the three planes and a volume rendering — CT-Bone preset for CT, MR-Default
for MR; the viewport's own menu changes the preset and lets the user rotate, crop and window it). Not
`mprAnd3DVolumeViewport`, which looks the same but only matches CT and leaves an MR study with four empty
viewports. Both are URL parameters — `hangingProtocolId`, and `SeriesInstanceUIDs` for the series the panel
considers the volume — nothing in OHIF is configured or forked. OHIF 3.12 chooses the series to reconstruct
itself (the reconstructable one with the most images, so never the two-image topogram) and treats the series
parameter as a hint at most; the panel still sends it. When the largest series has fewer than twelve images — a
radiograph, an ultrasound sweep — MPR and 3D are disabled and the study opens 2-D. A manifest may open studies
reconstructed from the start: the imaging archetype's `viewer_layout` knob and the composed page's
`imaging.layout` (stack | mpr | volume) become the component's `layout` prop; the control still lets the user
switch. The phantoms were made for this — see *The seed* above.

One OHIF bug is worked around in app-config.js. The MPR viewports carry a Crosshairs tool whose centre OHIF
recomputes on every camera reset as the intersection of the three viewport planes. Give a viewport an
orientation another one already has (the viewport's orientation menu: axial → sagittal next to the sagittal
view) and two planes are parallel, the intersection is NaN, and the tool moves every camera of the group to
NaN — three black viewports, "the views reset and nothing is shown". app-config.js wraps
`CrosshairsTool.prototype.setToolCenter` to ignore a centre that is not a point; the cameras stay where they
are and the viewport shows the orientation that was asked for. Verified in the harness for `mpr` and `fourUp`.

All of this is verified in a real browser without AWS: `scripts/viewer-local.py --check` serves the staged OHIF
with the same `app-config.js` the stack writes and a minimal DICOMweb server over the generated seed, drives
headless Chromium through a study, and reports the PACS requests (every one must carry the token), the frames
loaded and the console errors; `--screenshot` shows what rendered. `--hanging-protocol fourUp --whole-series`
opens the 3-D layout and waits for every slice of the volume before the screenshot. Without `--check` it just serves both, for looking at the viewer by hand on
`http://127.0.0.1:8081` — and, with the panel started as `npx vite --mode browsercheck` on an env file that
sets `VITE_AUTH_MODE=mock`, `VITE_DATA_MODE=mock` and `VITE_OHIF_VIEWER_URL=http://127.0.0.1:8081`, for
clicking through the panel's viewer, 3D control included, against the generated seed.

The browser door is a second set of routes on the reference API: `GET /viewer/dicom-web/{proxy+}` with a JWT
authorizer for the hospital's user pool and the panel's client, the path rewritten to `/dicom-web/{proxy}` by a
parameter mapping, CORS for the viewer and panel origins, and Orthanc's `DicomWeb.PublicRoot` set to that door
so the links it writes into metadata resolve. The dispatcher's IAM door is untouched, and a Cognito token opens
nothing there.

**What this door does not do**, and must before a hospital sees it: it checks identity, not authorisation.
Any signed-in user may open any study by UID, whereas the dispatcher only lists a patient's studies to a role
whose manifest scope allows it. The fix is a study-scoped grant — the dispatcher, having authorised the QIDO
result, mints a short-lived token naming the StudyInstanceUIDs, and the door checks that instead of the
session token — which is the imaging half of record-level grants (roadmap item 4). Until then the viewer is a
prototype capability, not a production one, and the reference stack is where it lives.

Verifying it, as a browser would:

```bash
export MEDAPP_TEST_USER=you@example.org MEDAPP_TEST_PASSWORD=…     # a user of the pool (scripts/create-user.sh); pip install pycognito
pytest tests/integration/test_viewer_door.py -v -s
```

signs in with SRP, reads the studies of `KMS-0048213` through the door (200), checks an anonymous request
gets 401 and the token gets 403 at the IAM door, and retrieves one WADO-RS frame of the phantom through the
API — printing its size and round-trip time, the number to know before a hospital's PACS: the HTTP API allows 10 MB
per response and 30 seconds, which is fine for these 128 KB frames and for series metadata, and a real
constraint for large real-world instances that a hospital gateway would have to stream differently.

## With the hospital's servers

A deployment may also know the hospital's own servers (`hospital_servers` in the hospital's file,
`docs/hospital-servers.md`). While that block is present the dispatcher and the viewer use them: the ApiStack
points at the hospital's FHIR server and DICOMweb with OAuth2 client credentials, and the viewer's
`app-config.js` is written by the HospitalServersStack, whose door swaps the user's Cognito token for the
hospital's. The reference stack still deploys while `reference_servers` is true, but then only for the
integration tests and the local harness; remove `hospital_servers` and it is the data source again.

## Next

Slice 4 of the reference environment is the authorisation gap above (study-scoped grants) — now with two doors
to close, the reference one and the hospital one. Beyond that, the roadmap resumes with record-level grants
for FHIR, worklists, and the audit ledger.
