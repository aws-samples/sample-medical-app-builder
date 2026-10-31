# The hospital's servers — connecting the platform to a hospital's own FHIR server and DICOMweb gateway

The shipped configuration runs on the reference servers (`reference-servers.md`). A hospital that has a FHIR R4
server and a DICOMweb gateway of its own — typically behind an API gateway, authenticated with OAuth 2.0 client
credentials from a token endpoint (one client id and secret for the platform, tokens valid for about an hour) —
connects them with one block of configuration and one secret. This page is how the platform uses them: what is
configured where, how to set it up and verify it, what a real hospital record tends to look like and what that
means for the apps (the lessons of the first integration, a HAPI FHIR facade and an Orthanc-backed DICOMweb gateway
behind Amazon API Gateway), and what is still a prototype limitation. The reference servers stay deployable; when
the hospital block is present they only serve the integration tests.

## Shape

| Piece | Where | What it does |
|---|---|---|
| Endpoints and settings | `hospitals/<id>.json` → `hospital_servers` | FHIR base URL, DICOMweb base URL, token URL, OAuth scope, the *name* of the credentials secret, how imaging joins patients (`dicom_patient_id: resource_id`). Nothing in the block is secret; the block refuses `client_id`/`client_secret` keys |
| Credentials | Secrets Manager `medapp/<hospital>/hospital-client` | `{"client_id", "client_secret"}`, written by `scripts/set-hospital-credentials.py` (prompts, never a command-line argument, never printed). Read by the dispatcher, the viewer door and the seed function — nothing else |
| `HospitalServersStack` | `stacks/hospital_servers_stack.py` | References the secret, hands the dispatcher its environment, runs the viewer door and the definitions seed, publishes SSM parameters under `/medapp/<hospital>/hospital/*` |
| Token client | `medapp_shared/oauth2.py` | `ClientCredentials`: one cached token per process, renewed shortly before expiry, re-reads the secret when a token is refused (rotation). The dispatcher, the viewer door and the CLI share it |
| Dispatcher | `ApiStack` env from `hospital.dispatcher_environment` | `FHIR_AUTH=oauth2`, `FHIR_TOKEN_URL`, `FHIR_OAUTH_SCOPE`, `FHIR_CREDENTIALS_SECRET`, `DICOMWEB_BASE_URL`, `DICOM_PATIENT_ID_SOURCE=resource_id`. Same primitives, same enforcement, same audit records as against the reference servers |
| Viewer door | HTTP API in the hospital stack, `GET /viewer/dicom-web/{proxy+}` | The API's JWT authorizer admits the panel's users (Cognito ID token: pool as issuer, web client as audience); a Lambda (`lambdas/viewer_door`) forwards each request to the hospital's DICOMweb with the hospital's access token and returns the answer — large JSON gzipped, frames base64. The user's token stops at the authorizer; the hospital's never leaves the function |
| Viewer config | `ViewerRuntimeConfig` in the hospital stack | OHIF's `app-config.js` points at the door and re-prefixes the gateway's absolute `BulkDataURI`s onto it |
| Definitions seed | `Custom::MedAppHospitalDefinitions` | PUTs the Questionnaires the apps need (by id, idempotent) and verifies the server: capability statement is R4, a patient exists, QIDO answers. Patients and their records are never written |
| CLI | `scripts/fhir-get.py --hospital …` | A request as the dispatcher would make it, settings from SSM, credentials from the secret |

Two request paths:

```
panel ── POST /primitives/{kind} ── dispatcher ── Bearer <hospital token> ── https://…/fhir, https://…/dicom-web
                                        └── token from the hospital's token endpoint (client credentials, cached ~1 h)

OHIF (iframe) ── GET <door>/viewer/dicom-web/… + Cognito ID token
                   └── JWT authorizer (the panel's users) ── door Lambda: + Bearer <hospital token> ── https://…/dicom-web/…
```

## Setting it up

1. Put the block in the hospital's file, `hospitals/<id>.json` (the shipped `hospitals/hsp-musterstadt.json` has none — it runs on the reference servers):

   ```json
   "hospital_servers": {
     "fhir_base_url": "https://fhir.hospital.example/fhir",
     "dicomweb_base_url": "https://fhir.hospital.example/dicom-web",
     "token_url": "https://auth.hospital.example/oauth2/token",
     "scope": "fhir/read fhir/write",
     "credentials_secret": "medapp/hsp-musterstadt/hospital-client",
     "dicom_patient_id": "resource_id"
   }
   ```

2. Store the credentials — once, before the first deploy; again to rotate:

   ```bash
   scripts/set-hospital-credentials.py            # asks for the client id and, hidden, the secret
   scripts/set-hospital-credentials.py --check    # obtains a token with what is stored, prints its lifetime
   ```

3. Deploy. `HospitalServersStack` is new; `ApiStack` changes (the dispatcher's environment); `ViewerStack`'s
   `app-config.js` is now written by the hospital stack and no longer by the reference stack:

   ```bash
   cdk deploy --all
   ```

   The hospital stack's `SeedSummary` output ends with `findings: none` when the server answered
   everything; `ViewerDicomWebUrl` is the door; the panel's `config.json` keeps pointing at the viewer.

   If a creation of the stack ever rolls back, check for log groups it left behind before trying again:
   CDK's managed Lambda log groups are retained, so a rolled-back creation leaves `/aws/lambda/<function>`
   in place and the next creation fails with `AlreadyExists`. The stack now declares the groups of its named
   functions itself (deleted with a rollback), but groups from an earlier attempt must go by hand:

   ```bash
   aws logs describe-log-groups --log-group-name-prefix /aws/lambda/medapp-hsp-musterstadt- --query 'logGroups[].logGroupName'
   aws logs delete-log-group --log-group-name /aws/lambda/medapp-hsp-musterstadt-viewer-door
   aws logs delete-log-group --log-group-name /aws/lambda/medapp-hsp-musterstadt-hospital-seed
   ```

4. Verify from your machine, with the same code the Lambdas run:

   ```bash
   scripts/fhir-get.py --hospital 'Patient?_summary=count'
   scripts/fhir-get.py --hospital --dicomweb 'studies?limit=5' --summary
   export MEDAPP_HOSPITAL_FHIR_BASE_URL=https://fhir.hospital.example/fhir
   export MEDAPP_HOSPITAL_DICOMWEB_BASE_URL=https://fhir.hospital.example/dicom-web
   export MEDAPP_HOSPITAL_TOKEN_URL=https://auth.hospital.example/oauth2/token
   export MEDAPP_HOSPITAL_SCOPE='fhir/read fhir/write'
   export MEDAPP_HOSPITAL_CREDENTIALS_SECRET=medapp/hsp-musterstadt/hospital-client
   pytest tests/integration/test_hospital_servers.py -v -s
   ```

   The integration tests read nothing but the hospital's record and write nothing. Six of them: one token serves
   everything and the server is R4; paging through the gateway works; the primitives' searches answer on
   the hospital's data; the picker finds patients by name; imaging joins on the Patient's resource id and the series
   call answers; the assessment questionnaire is on the server (skipped until the stack has deployed).

To go back to the reference servers, remove the `hospital_servers` block and deploy again: the dispatcher
returns to SigV4 against the reference API and the reference stack writes the viewer's config.

## What a hospital record looks like — lessons from the first integration

The first server connected was a HAPI FHIR 7.6 (R4, full CRUD with conditional create and versioned updates, ETags), so
the write path — `If-Match`, Provenance, conditional create on identifiers — worked unchanged; the DICOMweb gateway
held the same patients' studies (CT, MR, DX; 512×512 16-bit frames of ~0.5 MB, series metadata of ~2 MB). Expect
some of the following on any real record; each shaped the platform:

**Patients may have no MRN.** A research cohort's only identifier can be a study-name system, and a PACS may key studies by
the FHIR `Patient.id`. `dicom_patient_id: resource_id` makes the QIDO join use the resource id; the
launcher's patient picker searches the server by name (`GET /patients?name=…`, audited as
`platform.patient.search`), since no MRN can be typed.

**National codings.** On a German record, conditions are ICD-10-GM (`I10.90 Essentielle Hypertonie`, `C83.3`, `D63.0` …),
procedures OPS (`8-522.91` radiotherapy, `1-632.0` gastroscopy …), labs a German LOINC panel
(Erythrozyten, Hämoglobin, CRP, Kalium …). The vital signs match the catalog (blood pressure panel
85354-9 with components, heart rate, weight, HbA1c, smoking status); eGFR may be 62238-1 (CKD-EPI) rather than
33914-3. The catalog therefore knows `icd10gm` and `ops` as code systems, carries hints for their codes,
and tells the assistant to prefer the record's coding when a request names a diagnosis without a code
(`terminology.record_notes` in `med_app/docs/application-catalog.yaml`).

**The record's vocabulary.** Hints cover a few dozen concepts; a real record holds hundreds of laboratory
codes with local display texts. The seed function therefore reads the record's distinct codes — one
`_elements` search per resource type (Observation with unit, category and panel components; Condition,
Procedure, MedicationRequest/Statement, DiagnosticReport, AllergyIntolerance, Immunization), pages of 500,
within a time budget (150 s at deploy, 240 s nightly at 03:20 UTC), keeping counts of resources and of
distinct patients but nothing per patient — and stores one JSON document in the authoring stack's bucket
(`RecordVocabularyUri` output; `lambdas/dispatcher/vocabulary.py`). The drafting agent loads it at start,
reloads it hourly, and `lookup_codes` searches it by display text and by code, so "Ferritin" or "Kalium"
resolve to the codes the record actually uses and a hint the record lacks is said to show no data here;
each code also lists the other codings the record puts on the same resources (`also_coded_as`), so a
diagnosis found through an English SNOMED hint is answered with the record's ICD-10-GM code beside it.
The deployment's findings (`SeedSummary`) report what was read; a scan that runs out of budget is stored
as far as it got and completed by the next refresh. `scripts/record-vocabulary.py --hospital --out
vocab.json` reads the same document by hand, `--find Hämoglobin` searches it, `--upload` refreshes the
deployed one right after the record changed. See `app_creator/README.md`.

**Empty resource types.** A record may hold no MedicationRequest, Encounter, Questionnaire, QuestionnaireResponse,
Provenance, AllergyIntolerance, Immunization or DocumentReference at all. Medication lists are then empty;
the hypertension follow-up Questionnaire is written by the definitions seed so the assessment app
works; QuestionnaireResponses and Provenance appear as the apps write them.

**Gateway quirks.** HAPI behind a gateway writes `http://` paging links (it does not know its public address) while the
gateway serves HTTPS only, so the client rebases `next` links onto the configured base URL
(`HttpFhirSource.rebase`). The gateway has no CORS and the metadata carries absolute `BulkDataURI`s on
the gateway's own host — the reasons the browser goes through the door and OHIF re-prefixes those URIs.

**HAPI's search-result cache.** HAPI's default `reuse_cached_search_results_millis` (60 000) answers an identical
search within a minute from the first one's result set: an assessment just recorded did not show up under "earlier
assessments" for about a minute — the app's second search was word for word the first. The dispatcher now sends `Cache-Control: no-cache`
with every search (HAPI honours it; reads by id are not cached that way), so what an app writes is what it
reads back. The reference server sets the value to 0 for the same reason; worth asking the hospital to do
the same (`hapi.fhir.reuse_cached_search_results_millis: 0`), which also removes the ~1.5 s
HAPI spends creating a cached search for small `_count` values.

## Limits, as they stand

- **Identity, not authorisation, at the door.** Any signed-in user of the panel may open any study by UID
  through the viewer door — the same gap as the reference door. The door Lambda is where study-scoped grants
  will be checked.
- **One client for everything.** The dispatcher requests `fhir/read fhir/write` because the apps
  write; the viewer door obtains the same scope with the same client. Separate clients (read-only for the
  door) are a hospital-side change worth asking for.
- **Data residency.** The platform runs in eu-central-1, a European hospital's servers too, and `data_residency: eu` in
  the hospital's file keeps it that way at synth (`stacks/residency.py`): the deployment region must be an EU
  member-state region (London and Zurich carry the `eu-` name and are refused) and the drafting agent's
  `model_id` must be an `eu.` cross-region profile, a plain model id invoked in-region, or an application
  inference profile created in an EU region — `us.` runs inference in the United States, `global.` may route
  anywhere, both fail the synth with the fix in the message. The agent's Bedrock permissions are narrowed to
  `arn:aws:bedrock:eu-*` as well, so a later change of model id cannot quietly reach a model elsewhere. Why it
  matters even though the composer sends no patient data by design: the conversation is free text, and
  nothing stops a clinician from pasting a patient detail into it; the model's geography has to hold on its
  own. Two things to confirm with a hospital rather than assume: the regions AWS puts in the `eu.` geography
  (`aws bedrock get-inference-profile --inference-profile-identifier eu.anthropic.claude-sonnet-5-5` lists
  them) and that every one of them is acceptable to them.
- **Why a Lambda in the viewer's data path.** The first design was an HTTP proxy integration whose parameter
  mapping wrote the hospital's token into the upstream `Authorization` header; API Gateway refuses that
  ("Operations on header authorization are restricted" — the first deploy failed on it), so a function adds the
  header per request. The price is Lambda's 6 MB response limit, base64 included: their series metadata (2 MB)
  and study metadata (4.3 MB) are gzipped by the door when the browser accepts it (0.06 and 0.12 MB on the wire,
  measured), frames of 0.5–2 MB pass as they are. Anything larger — a radiograph's single frame is 8–15 MB, and
  the viewer showed `got status 413` on one — is **spilled**: the door writes the answer to a private bucket of
  the stack (`ViewerSpillBucket` output; objects expire after a day) under a random key and answers 307 with a
  presigned URL good for two minutes. The browser follows the redirect on its own and, because it crosses
  origins, drops the `Authorization` header (S3 refuses a request carrying both a signature and a bearer token)
  and presents `Origin: null` — which is why the bucket's CORS rule allows every origin for GET/HEAD: no
  allow-list can name `null`, and the signature in the URL is the protection, not CORS. Verified in headless
  Chromium against a simulated door and bucket: redirect followed, header dropped, body and content type intact.
  Without a bucket, or if the put fails, the door still answers 413 with a message. In the Network tab a large
  frame now shows as a 307 from the door followed by a 200 from `*.s3.eu-central-1.amazonaws.com`.
- **Their gateway's 10 MB.** The hospital's DICOMweb sits behind an API Gateway of their own, whose payload
  quota is 10 MB and cannot be raised. An uncompressed radiograph frame (12–18 MB) is refused *there* —
  `413 {"message":"Request Entity Too Large"}` is API Gateway's canned body, which the door passed through
  unchanged, so the error read as ours — and never reaches the door, where the spill could have carried it. The
  door therefore asks the PACS again for a frame (or instance) that came back 413, naming a lossless compressed
  transfer syntax in the `Accept` header: JPEG-LS (`1.2.840.10008.1.2.4.80`), then JPEG 2000 lossless, then RLE.
  Orthanc's DICOMweb plugin transcodes on request (RetrieveInstance since 1.3, frames since 1.16; JPEG-LS and
  RLE are built into Orthanc, JPEG 2000 needs its GDCM plugin), a radiograph lands at a third or less, and OHIF
  decodes all three — the part's content type names the syntax. What got through is remembered for the rest of
  that series, so only the first frame pays the extra round trip. If nothing fits, the door answers 413 itself,
  naming the gateway's limit and what it tried. The clean fix is on the hospital's side and is one line of
  `orthanc.json`: `"IngestTranscoding": "1.2.840.10008.1.2.4.80"` stores every instance as JPEG-LS at ingest,
  so every frame is small from the start and the viewer is faster for everyone — worth asking for, along with
  (longer term) exposing the PACS through something without a payload quota (an ALB or CloudFront in front of
  Orthanc rather than API Gateway). API Gateway caps a response at 30 s on both sides.
