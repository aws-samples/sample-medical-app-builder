# The audit trail

Every data access and every write an app makes through the dispatcher, every account change an administrator makes,
every lifecycle step of an app — one record each, written as the work happens, kept indefinitely, readable by
administrators in the panel's **Audit trail** section. This document is the design: what is recorded, where it is
kept, who reads it, what it costs when it fails.

The records themselves are not new. The dispatcher has written one per primitive call since the first version
(`docs/dispatcher.md`, step 6), user administration one per change (`docs/identity.md`), the registry one per
lifecycle step — all as JSON lines in each function's CloudWatch log. What this adds is a **store an auditor can
query** — by day, by person, by app, by patient — and the section that reads it. The log line stays: it is the second
copy, and the only one when the store is unreachable.

## What is recorded

| Source | Kinds | Fields beyond the common ones |
|---|---|---|
| `lambdas/dispatcher` | `data.*` (reads: `data.fhir.patient.read`, `data.fhir.query`, `data.cohort.by_condition`, `data.dicom.studies.for_patient`, …), `write.*` (`write.fhir.observation.create`, `write.fhir.questionnaire_response.submit`, …), `platform.patient.search` | `app_id`, `manifest_version`, `primitive_id`, `role`, `role_source` (`group` · `staff_preview` · `default`), `patient_context`, `duration_ms`, `data_scope_hash`, `result_summary`; writes add `resource_ref`, `payload_hash`, `provenance`; a request whose config differed from the published manifest's adds `config_mismatch` (the paths — refused, `outcome: refused`), one that sent undeclared keys adds `config_dropped`; patient searches add `query` and `result_summary` |
| `lambdas/user_admin` | `platform.user.create` · `groups` · `enable` · `disable` · `invite` | `target_username`, `email`, `groups_added`, `groups_removed` |
| `lambdas/registry_write` | `lifecycle.created` (a new app, a new version), `lifecycle.revised` (a draft replaced), `lifecycle.in_review` · `approved` · `published` · `deprecated` · `draft` (a transition, named after the state entered) | `app_id`, `manifest_version`, `from_state`, `to_state`, `parent_version` |

Common to all (`medapp_shared/audit_model.py::new_record`): `audit_id` (uuid4), `timestamp` (ISO 8601, UTC), `kind`,
`user_sub`, `user_name`, `user_email` (from the caller's token — so the trail reads as people, not subs, even after
an account is gone), `outcome` (`ok` · `refused` · `error`), `detail` (one line: why a request was refused, what
changed, the transition notes), and `source` — which function wrote it.

Refusals and errors are records too: a clinician's request outside their role's scope is `refused` with the reason,
a FHIR server that did not answer is `error`. **Patients appear as ids only** (`patient_context`): the trail says
*which* record was read, never who the patient is; the name is one lookup away in the record for someone entitled
to make it.

The registry's own `EVENT` items (`docs/registry-table.md`) remain its history, written in the same transaction as
the state change. The lifecycle records here are the auditor's copy — one trail to read, next to the data accesses the
published version then caused.

## Where it is kept — `stacks/audit_stack.py`

One DynamoDB table per hospital deployment, `medapp-<hospital_id>-audit`, encrypted with its own customer-managed KMS
key (`alias/medapp/<hospital_id>/audit`), point-in-time recovery on, deletion protection on, `RETAIN` on stack
removal, **no TTL**. Records are kept indefinitely; the hospital's retention policy, when there is one, is a TTL
attribute added later — nothing in the platform removes a record.

```
PK   DAY#<yyyy-mm-dd>        SK      <timestamp>#<audit_id>     the day's records, read newest first
GSI1 USER#<sub>              GSI1SK  <timestamp>#<audit_id>     a person's trail
GSI2 APP#<app_id>            GSI2SK  <timestamp>#<audit_id>     an app's (records with an app)
GSI3 PATIENT#<patient_id>    GSI3SK  <timestamp>#<audit_id>     a patient's (records with a patient in context)
```

Partitioning by UTC day keeps the un-filtered question ("what happened this week?") a handful of partition reads,
newest day first, and keeps any one partition small. The three indexes project everything (records are small) so each
of the three other questions is answered from the index alone. Floats travel as `Decimal`; `None` fields are not
stored.

Two managed policies say who may do what. **Writers** — the dispatcher, user administration, the registry write API —
hold `medapp-<h>-audit-write`: `dynamodb:PutItem` and the key's encrypt/decrypt, nothing else. No `UpdateItem`, no
`DeleteItem`, no `BatchWriteItem`: the functions that produce the trail cannot rewrite it. **Readers** — the audit
API — hold `medapp-<h>-audit-read`: `Query`/`GetItem` on the table and its indexes. Discovery through SSM
(`/medapp/<h>/audit/table-name`, `/kms-key-arn`), like the registry.

### Writing is fail-open

`AuditSink.emit` (`medapp_shared/audit_model.py`) prints the JSON line first — the log copy — then `PutItem`s the
item. If the store refuses (throttled, unreachable, misconfigured), the failure is itself logged
(`{"audit_store_failed": {...}}`) and **the request it describes still succeeds**. The reasoning: a down audit store
must not take the clinic down with it, and the log line is a complete record the store copy can be rebuilt from.
Without `AUDIT_TABLE_NAME` in the environment (a deployment without the stack, the local harness) the sink is the
log line alone, exactly as before.

A deployment that wants the opposite trade — no access without its audit record — would make `emit` raise and the
dispatcher refuse; the place to do it is marked in `AuditSink.emit`.

## Who reads it — `lambdas/audit_api`

```
GET /audit?from=<iso|date>&to=<iso|date>&user=<sub>&app=<app_id>&patient=<id>&kind=<group|prefix>&outcome=<ok|refused|error>&limit=<n>&cursor=<c>
→ 200 { records: [Record], cursor: <c> | null, range: { from, to } }
```

`medapp-admins` on the caller's token, checked by the function itself (the authorizer only checks the token) —
anyone else gets 403. Newest first. The range defaults to the last seven days and is capped at **92 days per query**
(wider questions are asked in pieces); a bare date means the start (`from`) or the end (`to`) of that day. `kind` is
a group — `reads` (`data.*`), `writes` (`write.*`), `platform`, `lifecycle` — or a prefix (`lifecycle.pub`).
`limit` is at most 200, 50 by default.

The most selective filter chooses the index: a patient's trail on GSI3, else a person's on GSI1, else an app's on
GSI2; with none of those, the day partitions themselves, newest day first. The other filters are applied as the items
come back, so a page can be shorter than `limit` without being the last — the cursor says. The cursor is an opaque,
base64 state (`{day, key}` or `{key}`) that an administrator's browser passes back; a malformed one is a 400.

The read API is read-only by construction: beyond logging, its role holds the read policy alone, and the function
has one route.

## The panel's section — `med_app/src/panel/AuditPage.tsx`

Administrators see **Audit trail** in the sidebar, after User management. A time range (today · 7 · 30 · 90 days ·
custom dates), then one field per filter: the app (named after the registry), the person (the accounts of the pool, by
name), a patient id, the kind group, the outcome. The table reads time · who · action (kind, and under it the app,
version and role — or the account changed, or the step taken) · patient · outcome · detail; a row opens the record in
full, with pivots to *this person's*, *this app's* and *this patient's* trail; "Load more" follows the cursor. The
API's refusals (a range too wide, a bad date) are shown as they come.

Two clients behind one interface (`med_app/src/audit/`): the **remote** one calls `GET /audit`; the **local** one
(mock mode, `VITE_REGISTRY_MODE=local`) keeps a few sample records and every record the apps opened in that browser
produce, in `sessionStorage`, and answers with the same rules — default window, 92-day cap, newest first, cursor —
so the section can be tried, and is tested, without the backend.

### The app's inspector and the trail — one record, two views

An open app's inspector (`AppRuntime`, for staff) shows the **browser's** view of the app's calls: one row per data
primitive the renderer ran, with the browser's clock and round-trip time. The trail holds the **data source's**
record of the same call. The two are linked by id: the dispatcher's every answer — the refusals and errors too —
names the record it just wrote (`audit_id`) and the verdict it holds (`outcome`), the executor hands both back
(`PrimitiveExecutor.run` → `ExecutionResult`; a `DispatcherRequestError` carries them for an error status), and the
renderer puts them on its own record. So an inspector row shows the server's outcome (`refused`, where a bare HTTP 403
would have read as an error) and, for an administrator, carries a trail icon that opens that record:
`/audit?id=<audit_id>&at=<timestamp>` — the page looks in the day before and after, filters to the one id and opens it.
A call the browser refused itself, before any request (`assertScopeAllows` in the executor), has no record in the trail;
the inspector says so with a dash. In mock mode the mock executor mints the ids and the local trail keeps the forwarded
records under them, so the link works the same way without a backend.

## Operating it

- **Deploy**: `AuditStack` is a new stack; `ApiStack` and `AuthoringStack` gain the table name and the policies —
  `cdk deploy AuditStack ApiStack AuthoringStack` (or `--all`). Records flow from the next invocation; nothing is
  back-filled from the logs (a one-off script over the log groups could, since the lines are the same JSON).
- **Reading outside the panel**: `aws dynamodb query --table-name medapp-<h>-audit --index-name GSI3 --key-condition-expression 'GSI3PK = :p' --expression-attribute-values '{":p":{"S":"PATIENT#<id>"}}'` — or the API with an administrator's token.
- **Retention**: indefinite by design. To adopt a policy later, add a TTL attribute at write time (`expires_at`) and
  enable TTL on the table — a stack change and one line in `audit_item`; existing records without the attribute are
  kept.
- **Cost**: on-demand; a record is a few hundred bytes, one write request each, read on demand by administrators.
  At a hospital's scale (tens of thousands of primitive calls a day) this is a few euros a month.
- **Second copy**: the CloudWatch log groups of the three functions. Their retention is the platform's default;
  a deployment that wants the log copy kept as long as the table sets it on the functions' log groups.

## What it does not do yet

- **Legal hold / WORM**: DynamoDB with an append-only IAM policy keeps the *functions* from rewriting the trail; an
  account administrator still could. Where that is not enough, the next step is an S3 Object Lock export (the same
  JSON lines, by day) — the records already have the shape.
- **Export** for an external audit (CSV of a range) and **alerting** on refusals — both read from the same API.
- **Hospital identity**: `user_sub`/`user_name`/`user_email` are the pool's; once the hospital federates its
  directory (`docs/identity.md`), the hospital's employee id belongs on the record too.
