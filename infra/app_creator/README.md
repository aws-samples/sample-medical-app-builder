# app_creator — the drafting agent

A clinician describes an app; the agent turns the conversation into an **AppSpec** and the platform's
compiler turns the spec into a manifest. The agent never writes a manifest, a layout or a data scope: it
edits a typed draft through tools, asks about whatever the readiness check says is still open, and calls
the compiler for the authoritative verdict.

```
user ──▶ Drafter.turn(session, text) ──▶ Strands Agent (Bedrock) ──tools──▶ Draft (partial AppSpec)
                                                                     │
                                       ManifestService ◀─────────────┘  readiness / compile (TypeScript, the only implementation)
```

| File | What it is |
|---|---|
| `draft.py` | The partial spec plus every change to it. Typed operations validate against `docs/app-spec.schema.json` *before* applying: a wrong value is rejected with the schema's reason (nothing changes), a missing required field is an **open item** — also inside a tagged union (a section of a summary or a composed page whose `kind` is known but whose fields are not all there yet); a `kind` that matches no branch is the rejection. |
| `catalog.py` | `application-catalog.yaml` and the JSON Schema as the agent sees them: buildable archetypes (those with a schema variant), knob docs, the not-yet-buildable ones, refusals, terminology hints, role patterns. |
| `vocabulary.py` | The record's vocabulary as the agent reads it: the codes actually present on the connected FHIR server with display texts and counts (`lambdas/dispatcher/vocabulary.py` builds the document), searched by display in any spelling (`Hämoglobin` → `hamoglobin`, a stem of five letters) and by code; loaded from S3 (deployed), a file (`MEDAPP_VOCABULARY_FILE`) or not at all; `VocabularyRefresher` reloads it hourly in the worker. |
| `tools.py` | The agent's only means of change: `choose_archetype`, `set_app`, `set_knobs`, `add_role` / `update_role` / `remove_role` / `set_default_role`, `set_governance`, `get_draft`, `check_readiness`, `compile_preview`, `list_record_shapes`, `list_groups`, `lookup_codes`, `record_refusal`. Every result carries the open items. `list_record_shapes` is the record-shape library (`shapes.py`: the published artifacts from the registry, `RegistryShapes`, or a fixed list); `set_knobs` refuses `shape: <id>` for a shape nobody has published, and `check_readiness` / `compile_preview` hand the library to the compiler so the references resolve. `lookup_codes` answers from the hints *and* the record's vocabulary: each hint says whether the record carries it (`record`: display, count, patients), and codes only the record knows come after, with their system as the catalog's alias. |
| `prompts.py` | The system prompt, generated from the catalog — it cannot describe an app the renderer cannot build. Per archetype it carries what is needed to choose (summary, scope, typical requests, the knobs by name); the knob fields, defaults, descriptions and the limits come back from `choose_archetype`, so the prompt stays around 20k characters as the catalog grows (a test guards the size). |
| `language.py` | Which language the author writes in (`en`/`de`), decided per turn by a marker-word heuristic and stated to the model as an instruction — reply language and the app's display language (`app.language`, names, titles). Short replies inherit the conversation's language (`DraftSession.language`); the German in the prompt (hospital name, example requests) is explicitly not a signal. |
| `agent.py` | `Drafter.turn()`: one exchange, runtime-agnostic. Lambda, AgentCore and the terminal harness all call exactly this. |
| `session.py` | `DraftSession` (spec, events, refusals, Strands messages) and stores: memory, files; DynamoDB comes with the API. |
| `manifest_service.py` | `ManifestService` protocol; `CliManifestService` runs `med_app/scripts/appspec.mjs`; the Node Lambda gets an HTTP implementation. `summarize_manifest()` is the plain-language review note. |
| `groups.py` | Existing hospital groups a role may be bound to (static list, or live from Cognito); platform and per-app groups are never offered. |
| `harness.py` | Terminal chat against Bedrock. |
| `eval/` | Scripted conversations with expectations on the resulting draft, and the runner. |
| `testing.py` | `ScriptedModel`: a Strands `Model` that answers from a script, so the whole loop runs in tests without Bedrock. |
| `dynamo_store.py` | `DynamoSessionStore`: sessions in the drafts table (TTL, author index, `turn` progress updates). |
| `lambda_manifest_service.py` | `LambdaManifestService`: the deployed manifest-service Lambda, invoked directly by platform components. |
| `lambda_agent.py` | The async turn worker (`TurnWorker`): queued → running (progress per tool) → done / failed; the Lambda entry point. |

## Running it

```bash
cd infra && pip install -r requirements-dev.txt
export MEDAPP_APP_DIR=../med_app            # a checkout with node_modules (the compiler CLI runs there)
export AWS_REGION=eu-central-1              # Bedrock region; the model id defaults to Strands' default
python -m app_creator.harness
```

Inside the chat, `/open` shows what is still missing, `/spec` the draft, `/compile` the manifest summary,
`/save spec.yaml` and `/manifest app.yaml` write files, and the session id printed at start resumes later
with `--session`. The groups a role can be bound to are read from the deployed user pool (discovered
through SSM, or `--user-pool <id>`); if the pool cannot be listed, no existing groups are offered at all —
`--demo-groups` substitutes a fake list, for demos only, because a role bound to a group that does not exist
grants access to nobody. The model is the deployment's (`model_id` in `infra/cdk.json`, or `MEDAPP_MODEL_ID`);
`--model <bedrock model id or inference profile>` overrides it (for EU residency use an `eu.` profile — the deployment enforces this at synth through `data_residency` in `cdk.json`).

What to type: `med_app/docs/example-prompts.md` has a request per kind of app (each within the terminology
the builder resolves on its own), the follow-ups that refine a draft, and the requests it declines.

## The record's vocabulary

The hand-written hints in `application-catalog.yaml` name a few dozen concepts; a hospital's record holds
hundreds of codes, with display texts in its own language. So the assistant also searches the **record's
vocabulary**: a JSON document of every distinct code on the connected FHIR server — resource type, system,
code, the display texts the record uses, how many resources carry it and for how many patients, the unit,
the category, a panel's components — built by the data source's seed function at deploy and every night
(`lambdas/dispatcher/vocabulary.py`, one `_elements` search per type, nothing per patient kept) and stored
in the authoring stack's bucket (`RecordVocabularyUri` output). The deployed worker loads it at start and
reloads it hourly; the prompt tells the model what it holds and that `lookup_codes` searches it by display
text — in the record's language too, "Hämoglobin" as well as "haemoglobin" — and by code, so a code the
model knows from memory is verified against the record before it is used. A hint the record does not
carry is returned unmarked (with a note to search the record's own spelling), and the model is told to
say that the app would show no data for it. Each code also lists the *other codings the record puts on the
same resources* (`also_coded_as`: a Condition carrying SNOMED CT and ICD-10-GM at once), which is how an
English search lands on the hospital's coding without a translation layer — the record notes say which
coding the hospital uses, and the prompt tells the model to take that one from the list.

Locally: `scripts/record-vocabulary.py --hospital --out vocab.json` reads the hospital's record (or `--bundle`
the synthetic one, no AWS), `--find Migräne` searches a document, `--upload` refreshes the deployed one;
`MEDAPP_VOCABULARY_FILE=vocab.json python -m app_creator.harness` gives the harness the same knowledge the
deployed agent has. Without any document the assistant works from the hints alone, as before.

## The corpus

`python -m app_creator.eval.run_corpus` plays the conversations in `eval/corpus.yaml` against the real
model and checks the resulting drafts: right archetype, the codes and thresholds it should have found,
roles and readiness, refusals recorded for a risk score and an AI summary, a plain "not available" for a
page no kind covers, the listed form offered instead of an invented one, no patient details in the spec
after a user pastes some, and a German request resolved to a code only the record's vocabulary knows
(`record_vocabulary_german_code`; the runner loads `eval/record-vocabulary.synthetic.json`, the synthetic
record's vocabulary — regenerate it with `scripts/record-vocabulary.py --bundle --out …` when the bundle
changes), a "yes, save it" that must not be answered with a claim (`reply_not_matching`: regular
expressions no reply may match), and requests that used to be refused — tasks, photos — which must now be built
without a refusal (`no_refusal`: the tool call is checked, not the wording, since the agent may truthfully say
what the app does not do), and a form the library already has, which must be referenced rather than redesigned
(`therapy_goal_from_library_en`: `tools_called` names the tools a turn must have used, `knobs_exclude_text` what the
knobs must not spell out; the runner's library is the bundled `med_app/shapes`, compiled), and a physiotherapy
set as the `physio_*` cases — the buildable ones in German with the record's own physiotherapy codes, two refused
(`refusal_any` accepts one of several refusal ids: a risk prediction, an automatic plan change), two answered honestly:
the `workflow` refusal for appointments recorded, nothing named Appointment in the knobs, and the part that exists built.
Transcripts land in `.eval/`. This is the gate for prompt and catalog changes; it needs Bedrock
credentials, so it is not part of `pytest`.

## What the agent is told it cannot do

The agent fills a draft; it saves, submits, approves, publishes and deploys nothing, and it cannot make an
app available to anyone. The prompt states this and the lifecycle that follows the draft — the author saves
a version with the panel's *Save to registry* button and submits it for review, an approver who is not the
author approves (which signs the manifest) and publishes, and only a published app reaches clinicians'
launcher — and forbids claiming any of those steps happened, in any language. The first demo round is why:
asked "Shall I save it?" and told "Yes", the agent announced a saved, deployed, launchable app. When the
draft is complete the panel's chat shows the real save button with the same explanation (`ChatPane`
hand-off), so the conversation ends on the author's own click. The corpus case
`lifecycle_is_not_the_agents_to_claim` guards the reply with `reply_not_matching` patterns.

## Rules the code enforces (not the prompt)

- Only buildable archetypes can be chosen; the others are named in the prompt as "not available yet".
- No value enters the draft that the schema rejects: unknown knobs, unknown identity fields, an unknown code
  system, a section kind that does not exist — each comes back with a precise path and reason.
- A role can only be bound to a group the directory actually lists (`add_role` / `update_role` reject any
  other name); `list_groups` never offers platform or per-app groups.
- Refusals are recorded against the catalog's refusal ids only.
- Readiness and compilation are the compiler's — the local schema check only makes the loop fast.
