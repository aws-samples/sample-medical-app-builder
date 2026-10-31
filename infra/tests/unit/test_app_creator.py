"""
The drafting agent without a language model: the draft's rules, the tools, the catalog view, session
persistence, and the whole Strands loop driven by a scripted model. The compiler itself is exercised
through the CLI when a med_app checkout with node_modules is available (MEDAPP_APP_DIR), otherwise
those cases are skipped — the compiler has its own tests on the TypeScript side.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app_creator.agent import Drafter
from app_creator.catalog import Catalog
from app_creator.draft import Draft, InvalidChange
from app_creator.eval.run_corpus import contains, evaluate, form_items, looks_german, turns_of
from app_creator.groups import GroupInfo, StaticGroups, is_bindable
from app_creator.manifest_service import CliManifestService, ManifestServiceUnavailable, summarize_manifest
from app_creator.prompts import build_system_prompt
from app_creator.session import DraftSession, FileSessionStore, InMemorySessionStore
from app_creator.testing import ScriptedModel, text, use
from app_creator.tools import make_tools

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load()


@pytest.fixture(scope="module")
def service() -> CliManifestService | None:
    svc = CliManifestService()
    try:
        svc.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec"})
    except ManifestServiceUnavailable:
        return None
    return svc


def tool_by_name(tools: list, name: str):  # type: ignore[type-arg]
    return next(t for t in tools if t.tool_name == name)


# ── catalog ───────────────────────────────────────────────────────────────────


def test_catalog_knows_what_is_buildable_and_where_codes_are(catalog: Catalog) -> None:
    assert catalog.buildable_ids == [f"APP-{n:02d}" for n in range(1, 14)], "every catalog archetype compiles now"
    ids = {a.id: a.buildable for a in catalog.archetypes()}
    assert all(ids.values())
    assert catalog.questionnaires()[0]["url"] == "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"
    assert catalog.known_questionnaire("https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup") and not catalog.known_questionnaire("https://example.org/Questionnaire/x")
    trend = catalog.archetype("APP-02")
    assert trend is not None and {k.name for k in trend.knobs if k.required} == {"codes", "series"}
    assert all(k.description for k in trend.knobs), "every knob documents itself for the model"
    bp = catalog.lookup_codes("blood pressure")
    assert [h.code for h in bp] == ["85354-9"] and bp[0].components == {"systolic": "8480-6", "diastolic": "8462-4"}
    # One name, three codings: SNOMED for the synthetic record, ICD-10-GM for the hospital's — the two subcodes and the category I10 that covers them.
    assert [h.code for h in catalog.lookup_codes("hypertension")] == ["38341003", "I10.90", "I10.00", "I10"]
    assert [h.system for h in catalog.lookup_codes("hypertension")] == ["snomed", "icd10gm", "icd10gm", "icd10gm"]
    assert catalog.lookup_codes("haemodialysis")[0].system == "ops" and catalog.record_notes()[0].startswith("Conditions on the hospital's record are coded in ICD-10-GM")
    assert catalog.lookup_codes("unicorn horn density") == []
    assert "computation" in catalog.refusal_ids() and "writes" in catalog.refusal_ids()
    assert catalog.phi_fields() == ["name", "dob", "gender", "mrn", "address", "phone", "email"]


def test_system_prompt_is_built_from_the_catalog(catalog: Catalog) -> None:
    prompt = build_system_prompt(catalog, "Klinikum Musterstadt", "hsp-musterstadt")
    assert "### APP-02" in prompt and "### APP-09" in prompt and "### APP-01" in prompt
    assert "### APP-05 · Imaging study review" in prompt and "### APP-11 · Structured assessment" in prompt
    assert "## Forms (assessments" in prompt and "htn-followup" in prompt and "Never invent a URL for a form that is not listed: design it" in prompt
    assert "set `form` instead of `questionnaire`" in prompt and "multiple_choice" in prompt and "never computes a score" in prompt
    assert "call list_record_shapes and set `shape: <id>`" in prompt, "the library is offered before fields are declared by hand"
    assert "- computation:" in prompt and "record_refusal" in prompt
    assert "Never ask for or repeat patient data" in prompt
    assert "### APP-12 · Composed page" in prompt and "sections (required) — items of the kinds trend, form_trend, latest_answers, readings, problems, medication, imaging, assessment, details, counts, record_observation, record_problem, record_allergy, record_procedure, tasks, create_task, photos, record_photo, record, allergies, encounters, reports, notes, procedures, immunizations, list" in prompt
    assert "### APP-13 · Worklist" in prompt
    assert "encounter_report_lists" not in prompt, "visit and report lists are buildable now — the refusal is gone"
    assert "record_observation" in prompt and "Supported writes" in prompt, "the writes refusal names what IS supported"
    # The archetype sections carry what is needed to choose — summary, scope, typical requests, the knobs by name; the
    # knob fields, defaults, descriptions and the limits come back from choose_archetype. Was ~29.6k with them inline.
    assert len(prompt) < 24000, "the prompt grows with the catalog; this guard makes the growth a decision (~20.8k after moving knob detail behind choose_archetype; ~21.9k with forms round two, 2026-10-11; ~23.5k with the thirteenth archetype, the worklist, 2026-10-12; ~23.7k with photo documentation after tightening the APP-12 summary and the writes refusal, 2026-10-12; ~23.9k with the record section, 2026-10-15; ~23.9k again with the record-shape library line after trimming the form prose and the rules, 2026-10-15 — the next growth must trim)"
    assert "Knobs: condition (required); imaging; value; cards; table_title." in prompt and "Threshold direction" not in prompt, "knob prose and limits live in the choose_archetype answer, not the prompt"
    assert "arrangement — one of tabs, stack" in prompt, "the enumerated values stay: a request's own words must find their knob"
    assert "choose_archetype answers with the archetype's knob schema" in prompt
    assert "Named archetypes first" in prompt and "choose the composed page (APP-12)" in prompt
    # The first demo round: asked "Shall I save it?" and told "Yes", the agent claimed the app was saved, deployed and
    # launchable. The prompt now states what it cannot do and the lifecycle other people own, and bans the claim.
    assert "you do not save, submit, approve, publish or deploy anything" in prompt
    assert '"Save to registry" button' in prompt and "an approver (never the author of that version)" in prompt and "only a published app appears in clinicians' launcher" in prompt
    assert "Never say that an app is saved, available, deployed or launchable, in any language" in prompt
    assert "before saving" not in prompt, "the old wording implied the agent saves"


# ── draft ─────────────────────────────────────────────────────────────────────


def test_draft_distinguishes_open_from_invalid(catalog: Catalog) -> None:
    d = Draft(catalog)
    assert [i.path for i in d.open_items()] == ["archetype", "app", "roles", "default_role", "governance"]
    d.set_app(app_id="app_hba1c", name="HbA1c trend")
    d.choose_archetype("APP-02", "a value over time")
    assert [i.path for i in d.open_items()] == ["roles", "default_role", "governance", "knobs"]

    with pytest.raises(InvalidChange, match="knobs.codes.0.system: 'icd' is not one of"):
        d.patch_knobs({"codes": [{"system": "icd", "code": "I10"}]})
    with pytest.raises(InvalidChange, match="'colour' is not a field of the spec"):
        d.patch_knobs({"colour": "red"})
    with pytest.raises(InvalidChange, match="knobs.window: 'yesterday' does not match"):
        d.patch_knobs({"window": "yesterday"})
    assert "knobs" not in d.spec, "a rejected change leaves the draft untouched"

    d.patch_knobs({"codes": [{"system": "loinc", "code": "4548-4"}], "series": [{"label": "HbA1c", "code": "4548-4"}], "unit": "%"})
    assert [i.path for i in d.open_items()] == ["roles", "default_role", "governance"]

    with pytest.raises(InvalidChange, match="phi_fields_visible.1: 'dobb' is not one of"):
        d.add_role({"id": "clinician", "display_name": "Clinician", "phi_fields_visible": ["name", "dobb"]})
    d.add_role({"id": "clinician", "display_name": "Clinician", "phi_fields_visible": ["name", "dob", "mrn"]})
    assert d.spec["default_role"] == "clinician", "the first role becomes the default"
    d.patch_governance({"clinical_context": "diabetes_clinic", "intended_users": ["diabetologist"], "intended_purpose": "Display only."})
    assert d.open_items() == []
    assert [e["tool"] for e in d.events] == ["set_app", "choose_archetype", "set_knobs", "add_role", "set_governance"]

    with pytest.raises(InvalidChange, match="APP-99 cannot be built"):
        d.choose_archetype("APP-99")
    d.choose_archetype("APP-09")
    assert "knobs" not in d.spec, "knobs belong to an archetype"


def test_draft_names_the_precise_problem_inside_unions(catalog: Catalog) -> None:
    d = Draft(catalog)
    d.choose_archetype("APP-01")
    with pytest.raises(InvalidChange, match="knobs.sections.0.kind: 'wibble' is not one of \\['problems', 'medication', 'vitals', 'record'\\]"):
        d.patch_knobs({"sections": [{"kind": "wibble"}]})
    # A section whose kind is known but whose fields are not all there yet is an open point, not a rejection —
    # the same rule as for any other missing field (and what the panel's local mirror does).
    open_items = d.patch_knobs({"sections": [{"kind": "problems"}, {"kind": "vitals"}]})
    assert [(i.path, i.message) for i in open_items if i.path.startswith("knobs")] == [("knobs.sections.1.codes", "is required")]
    with pytest.raises(InvalidChange, match="knobs.sections.1.rows: 0 is less than or equal to the minimum of 0"):
        d.patch_knobs({"sections": [{"kind": "problems"}, {"kind": "vitals", "codes": [{"system": "loinc", "code": "8867-4"}], "rows": 0}]})
    open_items = d.add_role({"id": "n", "display_name": "N", "phi_fields_visible": ["name"], "group": {"kind": "existing"}})
    assert ("roles.0.group.name", "is required") in [(i.path, i.message) for i in open_items]
    with pytest.raises(InvalidChange, match="roles.1.group.kind: 'ldap' is not one of"):
        d.add_role({"id": "m", "display_name": "M", "phi_fields_visible": ["name"], "group": {"kind": "ldap", "name": "x"}})


def test_draft_composes_a_page_from_sections(catalog: Catalog) -> None:
    d = Draft(catalog)
    d.choose_archetype("APP-12")
    open_items = d.patch_knobs({"sections": [{"kind": "trend", "span": 8}, {"kind": "medication", "span": 4}]})
    assert [(i.path, i.message) for i in open_items if i.path.startswith("knobs")] == [("knobs.sections.0.codes", "is required"), ("knobs.sections.0.series", "is required")]
    with pytest.raises(InvalidChange, match="knobs.sections.0.span: 5 is not one of \\[4, 6, 8, 12\\]"):
        d.patch_knobs({"sections": [{"kind": "trend", "span": 5}]})
    with pytest.raises(InvalidChange, match="knobs.sections.0.kind: 'chart' is not one of"):
        d.patch_knobs({"sections": [{"kind": "chart"}]})
    assert catalog.unknown_questionnaires({"sections": [{"kind": "assessment", "questionnaire": "https://example.org/Questionnaire/x"}, {"kind": "assessment", "questionnaire": "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"}]}) == [
        ("knobs.sections.0.questionnaire", "https://example.org/Questionnaire/x")
    ]
    composed = catalog.archetype("APP-12")
    assert composed is not None and composed.buildable
    sections = next(k for k in composed.knobs if k.name == "sections")
    assert sections.required and sections.item_kinds == ("trend", "form_trend", "latest_answers", "readings", "problems", "medication", "imaging", "assessment", "details", "counts", "record_observation", "record_problem", "record_allergy", "record_procedure", "tasks", "create_task", "photos", "record_photo", "record", "allergies", "encounters", "reports", "notes", "procedures", "immunizations", "list")
    # The record sections and the generic list validate like any other: a known kind with a missing field is open, a wrong field is rejected.
    open_items = d.patch_knobs({"sections": [{"kind": "allergies"}, {"kind": "list", "resource": "Encounter"}]})
    assert [(i.path, i.message) for i in open_items if i.path.startswith("knobs")] == [("knobs.sections.1.columns", "is required")]
    with pytest.raises(InvalidChange, match="knobs.sections.0.resource: 'Questionnaire' is not one of"):
        d.patch_knobs({"sections": [{"kind": "list", "resource": "Questionnaire", "columns": [{"label": "Title", "path": "title"}]}]})
    with pytest.raises(InvalidChange, match="knobs.sections.0.columns.0.path"):
        d.patch_knobs({"sections": [{"kind": "list", "resource": "Encounter", "columns": [{"label": "Date", "path": "period..start"}]}]})


def test_draft_role_operations(catalog: Catalog) -> None:
    d = Draft(catalog)
    d.add_role({"id": "viewer", "display_name": "Viewer", "phi_fields_visible": ["name", "dob", "mrn"]})
    d.add_role({"id": "reviewer", "display_name": "Reviewer", "phi_fields_visible": ["name", "dob", "gender", "mrn", "address"], "inherits": "viewer"})
    assert d.spec["default_role"] == "viewer"
    d.update_role("reviewer", {"display_name": "Clinical reviewer"})
    assert d.spec["roles"][1]["display_name"] == "Clinical reviewer"
    with pytest.raises(InvalidChange, match='no role "ghost"'):
        d.update_role("ghost", {})
    with pytest.raises(InvalidChange, match='"ghost" is not a declared role'):
        d.set_default_role("ghost")
    d.remove_role("viewer")
    assert [r["id"] for r in d.spec["roles"]] == ["reviewer"]
    assert "default_role" not in d.spec and "inherits" not in d.spec["roles"][0], "removing a role clears what pointed at it"
    with pytest.raises(InvalidChange, match="unknown refusal id"):
        d.record_refusal("magic", "x")
    d.record_refusal("computation", "risk score")
    assert d.refusals[0]["refusal"] == "computation"


# ── tools ─────────────────────────────────────────────────────────────────────


def test_tools_apply_changes_and_report_rejections_without_raising(catalog: Catalog) -> None:
    draft = Draft(catalog)
    tools = make_tools(draft, catalog, None, StaticGroups([GroupInfo("kardiologie", "Cardiology"), GroupInfo("medapp-admins"), GroupInfo("app-app_x-viewer")]), "hsp-musterstadt")
    assert {t.tool_name for t in tools} >= {"choose_archetype", "set_knobs", "add_role", "compile_preview", "record_refusal", "lookup_codes", "list_groups"}

    r = json.loads(tool_by_name(tools, "choose_archetype")(archetype="APP-02", reason="trend"))
    assert r["ok"] and r["knob_schema"]["required"] == ["codes", "series"] and {"path": "knobs", "message": "is required"} in r["open"]

    r = json.loads(tool_by_name(tools, "set_knobs")(patch={"codes": [{"system": "icd", "code": "x"}]}))
    assert r["ok"] is False and r["rejected"][0]["path"] == "knobs.codes.0.system" and "Nothing was changed" in r["hint"]

    r = json.loads(tool_by_name(tools, "add_role")(id="nurse", display_name="Nurse", phi_fields_visible=["name", "dob", "mrn"], existing_group="kardiologie"))
    assert r["ok"] and r["roles"][0]["group"] == {"kind": "existing", "name": "kardiologie"} and r["default_role"] == "nurse"

    r = json.loads(tool_by_name(tools, "list_groups")())
    assert [g["name"] for g in r["groups"]] == ["kardiologie"], "platform and per-app groups are not offered"

    # A group the pool does not have cannot be bound — whatever the model believes exists.
    r = json.loads(tool_by_name(tools, "add_role")(id="doc", display_name="Doctor", phi_fields_visible=["name"], existing_group="diabetologie"))
    assert r["ok"] is False and '"diabetologie" is not an existing group' in r["rejected"][0]["message"] and "kardiologie" in r["rejected"][0]["message"]
    assert [x["id"] for x in draft.spec["roles"]] == ["nurse"], "the rejected role was not added"
    r = json.loads(tool_by_name(tools, "update_role")(id="nurse", patch={"group": {"kind": "existing", "name": "radiologie"}}))
    assert r["ok"] is False and draft.spec["roles"][0]["group"] == {"kind": "existing", "name": "kardiologie"}
    r = json.loads(tool_by_name(tools, "update_role")(id="nurse", patch={"group": {"kind": "app_group"}}))
    assert r["ok"] and draft.spec["roles"][0]["group"] == {"kind": "app_group"}
    assert is_bindable("kardiologie") and not is_bindable("medapp-viewers") and not is_bindable("app-app_x-nurse")

    r = json.loads(tool_by_name(tools, "lookup_codes")(term="metformin"))
    assert r["codes"][0]["code"] == "A10BA02"
    r = json.loads(tool_by_name(tools, "lookup_codes")(term="unicorn"))
    assert r["codes"] == [] and "do not guess" in r["note"]

    r = json.loads(tool_by_name(tools, "check_readiness")())
    assert r["ok"] and r["ready"] is False and "local check only" in r["note"]
    r = json.loads(tool_by_name(tools, "compile_preview")())
    assert r["ok"] is False and "not connected" in r["error"]

    r = json.loads(tool_by_name(tools, "record_refusal")(refusal_id="llm_content", detail="AI summary"))
    assert r["ok"] and draft.refusals[0]["refusal"] == "llm_content"


# ── the loop, with a scripted model ───────────────────────────────────────────


def hba1c_script() -> list[list[dict]]:  # type: ignore[type-arg]
    return [
        [use("lookup_codes", term="HbA1c"), use("choose_archetype", archetype="APP-02", reason="a value over time")],
        [
            use("set_app", app_id="app_hba1c_trend", name="HbA1c over time", description="Glycated haemoglobin against the 7 % target."),
            use("set_knobs", patch={"codes": [{"system": "loinc", "code": "4548-4"}], "series": [{"label": "HbA1c", "code": "4548-4"}], "unit": "%", "thresholds": [{"value": 7, "label": "Target ≤ 7 %"}]}),
        ],
        [text("I set up an HbA1c trend. Who should use it, and what is it for?")],
    ]


def test_drafter_runs_the_strands_loop_and_persists_the_session(catalog: Catalog) -> None:
    model = ScriptedModel(hba1c_script())
    drafter = Drafter(model, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt")
    store = InMemorySessionStore()
    session = DraftSession.new("hsp-musterstadt", author_sub="author-1")

    result = drafter.turn(session, "I want to see a patient's HbA1c over the years against the 7% target")
    assert result.reply == "I set up an HbA1c trend. Who should use it, and what is it for?"
    assert result.tool_calls == ["lookup_codes", "choose_archetype", "set_app", "set_knobs"]
    assert [i["path"] for i in result.open] == ["roles", "default_role", "governance"]
    assert result.session.spec["knobs"]["unit"] == "%"
    store.save(result.session)

    # The model saw the system prompt and the tools; the tool results went back to it.
    assert model.calls[0]["system_prompt"].startswith("You are the app builder")
    assert "choose_archetype" in model.calls[0]["tools"]
    # The author's language is decided by code and stated to the model — the prompt's German (hospital
    # name, example requests) must not pull the reply or the display texts into German.
    assert "The author writes in English. Reply in English." in model.calls[0]["system_prompt"]
    assert 'set app.language to "en"' in model.calls[0]["system_prompt"]
    assert result.session.language == "en"
    fed_back = [json.loads(r["content"][0]["text"]) for r in model.tool_results()]
    assert fed_back[0]["codes"][0]["code"] == "4548-4"  # lookup_codes
    assert fed_back[1]["archetype"] == "APP-02"  # choose_archetype

    # Next turn continues from the saved conversation.
    reloaded = store.load(session.session_id)
    assert reloaded is not None and len(reloaded.messages) == 6 and reloaded.spec["archetype"] == "APP-02"
    model2 = ScriptedModel(
        [
            [use("add_role", id="clinician", display_name="Diabetes clinician", phi_fields_visible=["name", "dob", "gender", "mrn"]), use("set_governance", clinical_context="diabetes_clinic", intended_users=["diabetologist"], intended_purpose="Display of HbA1c values over time. Not for diagnosis.")],
            [text("Done — clinicians see name, date of birth, sex and MRN with the HbA1c curve.")],
        ]
    )
    result2 = Drafter(model2, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt").turn(reloaded, "Diabetes clinicians; display only, not for diagnosis")
    assert result2.open == [] and result2.session.spec["default_role"] == "clinician"
    assert len(model2.calls[0]["messages"]) == 7, "the earlier conversation was replayed to the model"
    assert [e["tool"] for e in result2.session.events] == ["choose_archetype", "set_app", "set_knobs", "add_role", "set_governance"]


def test_conversation_language_follows_the_author_and_survives_short_replies(catalog: Catalog) -> None:
    from app_creator.language import conversation_language, detect_language, language_instruction

    assert detect_language("I want to see a patient's HbA1c over the last five years against the 7 % target") == "en"
    assert detect_language("Ich möchte den HbA1c-Verlauf der letzten fünf Jahre sehen, mit der 7 %-Zielmarke") == "de"
    # Names, dates and codes are not a signal; a word or two is not evidence either.
    assert detect_language("Anneliese Krüger, 14.03.1958, KMS-0048213") is None
    assert detect_language("ok") is None
    assert detect_language("HbA1c 4548-4") is None

    assert conversation_language("ok", "de") == "de", "a short reply inherits the conversation's language"
    assert conversation_language("ok", None) == "en", "nothing to go on: English"
    assert conversation_language("Bitte auch den Blutdruck der letzten zwei Jahre anzeigen.", "en") == "de", "a clear switch is honoured"
    assert 'set app.language to "de"' in language_instruction("de") and "Reply in German" in language_instruction("de")

    # Through the Drafter: a German first message sets the session language; "passt" keeps it.
    model = ScriptedModel([[text("Verstanden — wer soll die App nutzen?")], [text("Gut.")]])
    drafter = Drafter(model, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt")
    session = DraftSession.new("hsp-musterstadt", author_sub="author-1")
    drafter.turn(session, "Ich brauche eine Übersicht der Patienten mit aktiver Hypertonie und ihrem letzten Blutdruck.")
    assert session.language == "de" and "The author writes in German. Reply in German." in model.calls[0]["system_prompt"]
    drafter.turn(session, "passt")
    assert session.language == "de" and "Reply in German" in model.calls[1]["system_prompt"]


def test_a_draft_seeded_from_an_existing_app_puts_that_app_in_front_of_the_model(catalog: Catalog) -> None:
    """
    Demo-round bug: "iterate on this app" on a showcase app (no conversation behind it) seeded the draft with its spec,
    the author asked for suggestions, and the model — which only knew the draft through a tool it did not call —
    answered that it had no app to go on. The draft's state now travels in the system prompt every turn.
    """
    import yaml

    spec = yaml.safe_load((Path(__file__).resolve().parents[2].parent / "med_app" / "specs" / "hypertension-register.yaml").read_text(encoding="utf-8"))
    seeded = DraftSession.new("hsp-musterstadt", author_sub="author-1")
    seeded.spec = {k: v for k, v in spec.items() if k not in ("apiVersion", "kind")}
    seeded.iterates = {"app_id": "app_hypertension_register", "version": "1.0.0"}
    model = ScriptedModel([[text("Two ideas: a slider over the systolic value, and the latest HbA1c beside the blood pressure.")]])
    result = Drafter(model, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt").turn(seeded, "Suggest relevant features for this app")
    prompt = model.calls[0]["system_prompt"]
    assert "## The draft so far" in prompt
    assert "iterates on the existing app `app_hypertension_register` version 1.0.0" in prompt and "saved as a new version" in prompt
    assert '"archetype":"APP-09"' in prompt and '"name":"Hypertension register"' in prompt and '"8480-6"' in prompt, "the whole spec, compactly"
    assert "Do not start over or ask what the app should be" in prompt and "Asked for suggestions" in prompt
    assert "Nothing is open" in prompt, "a published app's spec is complete"
    assert "Two ideas" in result.reply
    assert len(model.calls[0]["messages"]) == 1, "no conversation behind it — the prompt is what carries the context"

    # A fresh draft says nothing of the kind; a draft with earlier turns carries its state too, with what is still open.
    blank = ScriptedModel([[text("What should it show?")]])
    Drafter(blank, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt").turn(DraftSession.new("hsp-musterstadt"), "An app")
    assert "## The draft so far" not in blank.calls[0]["system_prompt"]
    partial = DraftSession.new("hsp-musterstadt", author_sub="author-1")
    partial.spec = {"archetype": "APP-02", "app": {"app_id": "app_hba1c", "name": "HbA1c", "description": "HbA1c over time"}}
    later = ScriptedModel([[text("Noted.")]])
    Drafter(later, catalog, None, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt").turn(partial, "fine")
    block = later.calls[0]["system_prompt"].split("## The draft so far", 1)[1]
    assert "The draft already holds the following" in block and "Still open before it can be saved:" in block and "roles" in block


def test_a_form_designed_in_the_conversation_passes_the_drafts_validation_and_the_model_can_read_its_shape(catalog: Catalog) -> None:
    """
    First real run of the forms corpus case: every set_knobs with a `form` was refused — the knob schema's recursive
    items are a `$ref` into the document's `$defs`, and the archetype variant the draft validates against had been cut
    out of the document without them. The falls-risk form (specs/falls-risk-form.yaml — the showcase ships the same form
    on a composed page) must go through the agent's own tool, and the knob schema the model reads must show the item
    fields, not a bare pointer.
    """
    import yaml

    from app_creator.groups import StaticGroups
    from app_creator.tools import make_tools

    spec = yaml.safe_load((Path(__file__).resolve().parents[2].parent / "med_app" / "specs" / "falls-risk-form.yaml").read_text(encoding="utf-8"))
    draft = Draft(catalog)
    tools = {t.tool_name: t for t in make_tools(draft, catalog, None, StaticGroups(), "hsp-musterstadt")}
    tools["choose_archetype"](archetype="APP-11", reason="a screen written to the record")
    out = json.loads(tools["set_knobs"](patch=spec["knobs"]))
    assert out["ok"] is True, out
    assert draft.spec["knobs"]["form"]["items"][1]["items"][0]["id"] == "fell_last_year", "nested items under a heading are kept"
    assert draft.invalid_items() == []
    # The same form, broken, is refused with the path to the problem — the schema is applied, not bypassed.
    broken = json.loads(json.dumps(spec["knobs"]))
    broken["form"]["items"][1]["items"][0]["type"] = "yes_no"
    refused = json.loads(tools["set_knobs"](patch=broken))
    assert refused["ok"] is False and "knobs.form.items.1.items.0.type" in json.dumps(refused["rejected"])
    # A made-up URL for a form is still refused, and the refusal points at `form`.
    refused = json.loads(tools["set_knobs"](patch={"questionnaire": "https://klinikum-musterstadt.example/fhir/Questionnaire/falls"}))
    assert refused["ok"] is False and "design it with `form`" in refused["rejected"][0]["message"]
    # What the model reads before set_knobs: the item fields written out, with the recursion's definition alongside.
    text = catalog.knob_schema_text("APP-11")
    assert '"heading"' in text and '"multiple_choice"' in text and '"required"' in text and '"options"' in text and '"$defs"' in text
    assert text.count('"$ref"') <= 2, "one pointer for the recursion, not one per use"
    # And the readiness check sees the whole spec as sound once roles and governance are there.
    for key in ("roles", "default_role", "governance", "app"):
        draft.spec[key] = spec[key]
    assert draft.invalid_items() == [] and draft.open_items() == []


def test_structured_assessment_only_renders_a_questionnaire_on_the_record(catalog: Catalog) -> None:
    from app_creator.groups import StaticGroups
    from app_creator.tools import make_tools

    draft = Draft(catalog)
    tools = {t.tool_name: t for t in make_tools(draft, catalog, None, StaticGroups(), "hsp-musterstadt")}
    tools["choose_archetype"](archetype="APP-11", reason="a follow-up form")
    invented = json.loads(tools["set_knobs"](patch={"questionnaire": "https://example.org/Questionnaire/made-up"}))
    assert invented["ok"] is False and "not a Questionnaire on this record" in invented["rejected"][0]["message"] and "htn-followup" in invented["rejected"][0]["message"]
    assert "knobs" not in draft.spec
    ok = json.loads(tools["set_knobs"](patch={"questionnaire": "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"}))
    assert ok["ok"] is True and draft.spec["knobs"]["questionnaire"].endswith("htn-followup")


def test_record_sections_write_with_published_shapes_the_library_lists(catalog: Catalog) -> None:
    """
    The library is what the model offers before it designs fields by hand: list_record_shapes summarises the published
    artifacts, `shape: <id>` is accepted for those and refused — with the list — for any other; the readiness and compile
    calls are handed the same artifacts so the compiler resolves the references.
    """
    from app_creator.groups import StaticGroups
    from app_creator.manifest_service import CompileResult, Readiness
    from app_creator.shapes import StaticShapes, shape_summary, unknown_shapes
    from app_creator.tools import make_tools

    goal = {"id": "measurable_goal", "name": "Measurable goal", "description": "A therapy goal with a target.", "resource": "Goal", "fields": [{"id": "goal", "label": "Goal", "type": "text", "path": "description", "required": True}, {"id": "target", "label": "Target value", "type": "number", "path": "target[0].detailQuantity", "unit": "s"}], "rules": {"resource": "Goal", "fields": [], "stamps": []}, "checksum": "fnv1a64:aaaa"}
    library = StaticShapes([goal])
    assert shape_summary(goal) == {"id": "measurable_goal", "name": "Measurable goal", "description": "A therapy goal with a target.", "resource": "Goal", "fields": ["Goal (text, required)", "Target value (number)"]}
    assert unknown_shapes({"sections": [{"id": "a", "kind": "record", "shape": "measurable_goal"}, {"id": "b", "kind": "record", "shape": "progress_note"}, {"id": "c", "kind": "list", "resource": "Goal"}]}, library) == [("knobs.sections.1.shape", "progress_note")]
    assert unknown_shapes({"sections": [{"id": "a", "kind": "record", "shape": "x"}]}, None) == [("knobs.sections.0.shape", "x")]

    class Service:
        calls: list[tuple[str, list[dict] | None]] = []

        def readiness(self, spec, shapes=None):  # type: ignore[no-untyped-def]
            self.calls.append(("readiness", shapes))
            return Readiness(ready=False, missing=[])

        def compile(self, spec, hospital_id, created_by_sub=None, created_at=None, shapes=None):  # type: ignore[no-untyped-def]
            self.calls.append(("compile", shapes))
            return CompileResult(ok=False, issues=[])

    service = Service()
    draft = Draft(catalog)
    tools = {t.tool_name: t for t in make_tools(draft, catalog, service, StaticGroups(), "hsp-musterstadt", shapes=library)}
    listed = json.loads(tools["list_record_shapes"]())
    assert listed["ok"] is True and listed["shapes"] == [shape_summary(goal)] and listed["note"] is None
    tools["choose_archetype"](archetype="APP-12", reason="a therapy page")
    refused = json.loads(tools["set_knobs"](patch={"sections": [{"id": "goals", "kind": "list", "resource": "Goal"}, {"id": "new_note", "kind": "record", "shape": "progress_note"}]}))
    assert refused["ok"] is False and refused["rejected"][0]["path"] == "knobs.sections.1.shape"
    assert "not a published record shape. Published: measurable_goal." in refused["rejected"][0]["message"] and "declare `resource` and `fields`" in refused["rejected"][0]["message"]
    assert "knobs" not in draft.spec
    accepted = json.loads(tools["set_knobs"](patch={"sections": [{"id": "goals", "kind": "list", "resource": "Goal"}, {"id": "new_goal", "kind": "record", "shape": "measurable_goal"}]}))
    assert accepted["ok"] is True and draft.spec["knobs"]["sections"][1]["shape"] == "measurable_goal"
    tools["check_readiness"]()
    tools["compile_preview"]()
    assert service.calls == [("readiness", [goal]), ("compile", [goal])], "the compiler is handed the published artifacts"

    # Without a library connected the tool says so, and the compiler is handed nothing (not an empty list: no opinion).
    bare = {t.tool_name: t for t in make_tools(Draft(catalog), catalog, service, StaticGroups(), "hsp-musterstadt")}
    empty = json.loads(bare["list_record_shapes"]())
    assert empty["shapes"] == [] and "no shape is published yet" in empty["note"]
    bare["check_readiness"]()
    assert service.calls[-1] == ("readiness", None)


def test_the_registry_library_reads_published_artifacts_by_key_after_the_index_and_caches_briefly() -> None:
    """GSI1 names the shapes; the HEAD says which version is published; that version's artifact is what a compile gets."""
    from app_creator.shapes import RegistryShapes
    from medapp_shared import registry_model as rm

    doc = {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "measurable_goal", "name": "Measurable goal", "resource": "Goal", "fields": [{"id": "goal", "label": "Goal", "type": "text", "path": "description", "required": True}]}}
    art = {"id": "measurable_goal", "name": "Measurable goal", "resource": "Goal", "fields": doc["shape"]["fields"], "rules": {"resource": "Goal", "fields": [], "stamps": []}, "checksum": "fnv1a64:aaaa"}
    v1 = rm.shape_version_item(doc, art, version="0.1.0", created_by_sub="a", now="t", state="published")
    v2 = rm.shape_version_item(doc, {**art, "checksum": "fnv1a64:bbbb"}, version="0.2.0", created_by_sub="a", now="t")
    head = rm.shape_head_item(art, owner_sub="a", now="t", latest_version="0.2.0", active_version="0.1.0", latest_state="draft")
    note_art = {"id": "ward_note", "name": "Ward note", "resource": "DocumentReference", "fields": [], "rules": {"resource": "DocumentReference", "fields": [], "stamps": []}, "checksum": "fnv1a64:cccc"}
    note_head = rm.shape_head_item(note_art, owner_sub="b", now="t", latest_version="0.1.0")  # never published
    items = {(i["PK"], i["SK"]): i for i in [v1, v2, head, note_head, rm.shape_version_item(doc, note_art, version="0.1.0", created_by_sub="b", now="t")]}

    class Table:
        queries = 0

        def query(self, **kwargs):  # type: ignore[no-untyped-def]
            self.queries += 1
            assert kwargs["IndexName"] == "GSI1"
            return {"Items": [{k: v for k, v in i.items() if k in ("PK", "SK", "GSI1PK", "GSI1SK", "name")} for i in items.values() if i.get("GSI1PK") == kwargs["ExpressionAttributeValues"][":pk"]]}

        def get_item(self, **kwargs):  # type: ignore[no-untyped-def]
            item = items.get((kwargs["Key"]["PK"], kwargs["Key"]["SK"]))
            return {"Item": item} if item else {}

    table = Table()
    tick = iter([0.0, 10.0, 100.0])
    library = RegistryShapes("registry", client=table, ttl_s=60, clock=lambda: next(tick))
    assert library.published() == [{**art, "version": "0.1.0"}], "the published version's artifact with its version (it goes onto every record's tag), not the newer draft's; the unpublished shape is absent"
    assert library.published() == [{**art, "version": "0.1.0"}] and table.queries == 1, "within the ttl the answer is cached"
    library.published()
    assert table.queries == 2, "after it, read again"


def test_drafter_rejection_is_returned_to_the_model_not_raised(catalog: Catalog) -> None:
    model = ScriptedModel([[use("choose_archetype", archetype="APP-99", reason="unknown kind")], [text("That kind of app is not available in this deployment.")]])
    result = Drafter(model, catalog, None, hospital_id="h", hospital_name="H").turn(DraftSession.new("h"), "Show me the CT scans")
    assert "not available" in result.reply
    fed_back = json.loads(model.tool_results()[0]["content"][0]["text"])
    assert fed_back["ok"] is False and "APP-99 cannot be built" in fed_back["rejected"][0]["message"]
    assert result.session.spec == {}


def test_drafter_reply_keeps_what_the_model_said_before_a_tool_call(catalog: Catalog) -> None:
    # A refusal is typically explained in the same message as record_refusal; that explanation must reach the user.
    model = ScriptedModel(
        [
            [text("A risk score is a computation the platform cannot perform."), use("record_refusal", refusal_id="computation", detail="cardiovascular risk score")],
            [text("What I can build instead is a trend of the values that feed the score.")],
        ]
    )
    result = Drafter(model, catalog, None, hospital_id="h", hospital_name="H").turn(DraftSession.new("h"), "Build me a risk score calculator")
    assert result.reply == "A risk score is a computation the platform cannot perform.\n\nWhat I can build instead is a trend of the values that feed the score."
    assert result.session.refusals[0]["refusal"] == "computation" and result.tool_calls == ["record_refusal"]


def test_drafter_with_the_real_compiler(catalog: Catalog, service: CliManifestService | None) -> None:
    if service is None:
        pytest.skip("compiler CLI not available (set MEDAPP_APP_DIR to a med_app checkout with node_modules)")
    session = DraftSession.new("hsp-musterstadt")
    Drafter(ScriptedModel(hba1c_script()), catalog, service, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt").turn(session, "HbA1c trend please")
    model = ScriptedModel(
        [
            [use("add_role", id="clinician", display_name="Diabetes clinician", phi_fields_visible=["name", "dob", "gender", "mrn"], existing_group="diabetologie"), use("set_governance", clinical_context="diabetes_clinic", intended_users=["diabetologist"], intended_purpose="Display of HbA1c values over time. Not for diagnosis.")],
            [use("check_readiness")],
            [use("compile_preview")],
            [text("Ready.")],
        ]
    )
    result = Drafter(model, catalog, service, hospital_id="hsp-musterstadt", hospital_name="Klinikum Musterstadt", groups=StaticGroups([GroupInfo("diabetologie")])).turn(session, "Diabetes clinicians in diabetologie")
    fed_back = [json.loads(r["content"][0]["text"]) for r in model.tool_results()]
    readiness = next(f for f in fed_back if "ready" in f)
    assert readiness == {"ok": True, "ready": True, "missing": []}
    summary = next(f for f in fed_back if "summary" in f)["summary"]
    assert summary["roles"]["clinician"]["group"] == "diabetologie"
    assert summary["roles"]["clinician"]["fhir"] == ["Patient: read", "Observation: search"]
    assert summary["primitives"] == ["p_patient: data.fhir.patient.read", "p_series: data.fhir.observation.by_code"]
    assert any(line.startswith("    ObservationTimeline") for line in summary["layout"])
    assert result.session.events[-1]["tool"] == "compile_preview"

    partial = service.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", "archetype": "APP-09", "app": {"app_id": "app_x", "name": "X"}})
    assert not partial.ready and {i.path for i in partial.missing} >= {"roles", "governance", "knobs"}


# ── sessions and evaluation helpers ────────────────────────────────────────────


def test_group_directory_defaults_to_the_real_pool_and_never_invents_groups(catalog: Catalog) -> None:
    from app_creator.groups import CognitoGroups, discover_user_pool_id
    from app_creator.harness import group_directory

    class FakeSsm:
        def get_parameter(self, Name: str) -> dict:  # noqa: N803 — boto3 casing
            assert Name == "/medapp/hsp-musterstadt/identity/user-pool-id"
            return {"Parameter": {"Value": "eu-central-1_TEST"}}

    assert discover_user_pool_id("hsp-musterstadt", FakeSsm()) == "eu-central-1_TEST"

    class FakeCognito:
        def list_groups(self, **kwargs: object) -> dict:
            return {"Groups": [{"GroupName": "kardiologie", "Description": "Cardiology"}, {"GroupName": "medapp-admins"}, {"GroupName": "app-app_x-viewer"}]}

    assert [g.name for g in CognitoGroups("pool", FakeCognito()).list_groups()] == ["kardiologie"]
    # Without a reachable pool the directory is empty — no fakes — unless demo groups are explicitly requested.
    assert group_directory("hsp-nowhere", "pool-that-does-not-exist", demo=False).list_groups() == []
    assert "diabetologie" in [g.name for g in group_directory("hsp-nowhere", None, demo=True).list_groups()]


def test_file_session_store_roundtrip(tmp_path: Path) -> None:
    store = FileSessionStore(tmp_path)
    s = DraftSession.new("hsp-musterstadt", author_sub="a")
    s.spec = {"archetype": "APP-02"}
    s.messages = [{"role": "user", "content": [{"text": "hi"}]}]
    store.save(s)
    back = store.load(s.session_id)
    assert back is not None and back.spec == {"archetype": "APP-02"} and back.messages == s.messages and back.updated_at >= back.created_at
    assert store.load("nope") is None


def test_partial_match_and_case_evaluation() -> None:
    assert contains({"codes": [{"system": "loinc", "code": "4548-4", "display": "x"}], "unit": "%"}, {"codes": [{"code": "4548-4"}]})
    assert not contains({"codes": [{"code": "1"}]}, {"codes": [{"code": "2"}]})
    assert looks_german("Die App ist fertig. Soll ich sie so speichern?") and not looks_german("The app is ready for Anneliese Krüger's ward. Shall I save it?")
    alternatives = {"expect": {"knobs_contain_any": [{"codes": [{"code": "85354-9"}]}, {"codes": [{"code": "8480-6"}, {"code": "8462-4"}]}]}}
    panel = DraftSession.new("h")
    panel.spec = {"knobs": {"codes": [{"system": "loinc", "code": "85354-9"}]}}
    assert evaluate(alternatives, panel, ["ok"], True) == []
    neither = DraftSession.new("h")
    neither.spec = {"knobs": {"codes": [{"system": "loinc", "code": "8867-4"}]}}
    assert evaluate(alternatives, neither, ["ok"], True)[0].startswith("knobs match none of the alternatives")
    english_expected = {"expect": {"reply_language": "en"}}
    assert evaluate(english_expected, panel, ["Gut. Jetzt fehlen noch Rollen und Governance für die Patienten."], True) == ["last reply looks German, the request was English"]
    session = DraftSession.new("h")
    session.spec = {"archetype": "APP-02", "knobs": {"codes": [{"system": "loinc", "code": "4548-4"}], "window": "now-5y"}, "roles": [{"id": "c"}], "default_role": "c"}
    case = {"expect": {"archetype": "APP-02", "knobs_contain": {"window": "now-5y"}, "roles_min": 1, "ready": True, "reply_language": "de", "spec_excludes_text": ["Krüger"]}}
    assert evaluate(case, session, ["Der Verlauf ist fertig für die Patienten."], True) == []
    failures = evaluate({"expect": {"archetype": "APP-09", "refusal": "computation", "roles_min": 2}}, session, ["ok"], False)
    assert len(failures) == 3
    # `refusal_any`: one of several refusal ids will do — a request that is both a computation and a recommendation may be refused as either.
    refused = DraftSession.new("h")
    refused.refusals = [{"refusal": "llm_content", "detail": "an automatic proposal"}]
    assert evaluate({"expect": {"refusal_any": ["computation", "llm_content"]}}, refused, ["ok"], False) == []
    assert evaluate({"expect": {"refusal_any": ["computation"]}}, refused, ["ok"], False) == ["none of the refusals ['computation'] recorded (recorded: ['llm_content'])"]
    # Claims the agent must never make: a forbidden pattern in any reply is a failure, a truthful hand-over is not.
    forbidden = {"expect": {"reply_not_matching": ["is now (saved|live|available)", "I('ve| have)? saved", "ist (jetzt )?gespeichert"]}}
    assert evaluate(forbidden, session, ["Looks complete. Save it with the Save to registry button; after review and approval an approver publishes it."], True) == []
    assert evaluate(forbidden, session, ["Fine.", "The app is now saved and clinicians can launch it."], True) == ["a reply matches the forbidden /is now (saved|live|available)/: 'The app is now saved and clinicians can launch it.'"]
    assert evaluate(forbidden, session, ["Die App ist jetzt gespeichert."], True)[0].startswith("a reply matches the forbidden /ist (jetzt )?gespeichert/")
    # A library case: the shape is referenced, no fields spelt out, and the tool that lists the library was called.
    library = {"expect": {"knobs_contain": {"sections": [{"kind": "record", "shape": "measurable_goal"}]}, "knobs_exclude_text": ["detailQuantity"], "tools_called": ["list_record_shapes"]}}
    by_ref = DraftSession.new("h")
    by_ref.spec = {"archetype": "APP-12", "knobs": {"sections": [{"kind": "list", "id": "goals", "resource": "Goal"}, {"kind": "record", "id": "new_goal", "shape": "measurable_goal"}]}}
    assert evaluate(library, by_ref, ["ok"], True, [["choose_archetype", "list_record_shapes", "set_knobs"]]) == []
    by_hand = DraftSession.new("h")
    by_hand.spec = {"archetype": "APP-12", "knobs": {"sections": [{"kind": "record", "id": "new_goal", "resource": "Goal", "fields": [{"id": "t", "label": "T", "type": "number", "path": "target[0].detailQuantity", "unit": "s"}]}]}}
    assert evaluate(library, by_hand, ["ok"], True, [["choose_archetype", "set_knobs"]]) == ["knobs missing expected values: " + json.dumps(library["expect"]["knobs_contain"], ensure_ascii=False) + " in " + json.dumps(by_hand.spec["knobs"], ensure_ascii=False), "knobs contain 'detailQuantity', which the case excludes", "tool list_record_shapes was never called (called: ['choose_archetype', 'set_knobs'])"]
    # A request that is buildable now must not be refused — checked on the tool call, so a truthful "measuring is not possible" in the reply passes.
    assert evaluate({"expect": {"no_refusal": True}}, session, ["Zur Vermessung: das ist nicht möglich, aber das entspricht Ihrer Vorgabe."], True) == []
    refused = DraftSession.new("h")
    refused.refusals = [{"refusal": "writes", "reason": "photos"}]
    assert evaluate({"expect": {"no_refusal": True}}, refused, ["ok"], True) == ["a refusal was recorded where none was expected: ['writes']"]
    # Two kinds can be a fair answer to one request; an unquoted ": " in a turn is the case's mistake, named, not a crash.
    assert evaluate({"expect": {"archetype_any": ["APP-01", "APP-02"]}}, session, ["ok"], True) == []
    assert evaluate({"expect": {"archetype_any": ["APP-08", "APP-12"]}}, session, ["ok"], True) == ["archetype: expected one of APP-08, APP-12, got APP-02"]
    assert turns_of({"id": "x", "turns": ["one", "two"]}) == ["one", "two"]
    with pytest.raises(ValueError, match="case 'tabs': turn 1 is not text"):
        turns_of({"id": "tabs", "turns": [{"Eine Seite mit Reitern": "zuerst Kennzahlen"}]})


def test_a_heading_condition_reaches_the_questions_the_corpus_checks() -> None:
    """
    First Bedrock run of form_with_conditions_and_ranges: the model put `show_when` on the headings ("Pain details" only if pain
    is yes) — the shape we want — and the case failed, because the runner flattened headings away and lost the condition.
    What a case checks is what the form asks and when; a question under a conditioned heading is asked under that condition.
    """
    form = {
        "items": [
            {"id": "pain", "type": "choice", "required": True, "options": [{"display": "Yes", "code": "yes"}, {"display": "No", "code": "no"}]},
            {
                "id": "details",
                "type": "heading",
                "show_when": {"question": "pain", "is": "yes"},
                "items": [
                    {"id": "where", "type": "multiple_choice", "options": [{"display": "Head"}]},
                    {"id": "how_bad", "type": "integer", "min": 0, "max": 10, "show_when": {"question": "where", "answered": True}},
                ],
            },
            {"id": "notes", "type": "long_text"},
        ]
    }
    questions = form_items({"knobs": {"form": form}})
    assert [q["id"] for q in questions] == ["pain", "where", "how_bad", "notes"]
    assert "show_when" not in questions[0] and "show_when" not in questions[3]
    assert questions[1]["show_when"] == {"question": "pain", "is": "yes"}  # inherited from the heading
    assert questions[2]["show_when"] == [{"question": "pain", "is": "yes"}, {"question": "where", "answered": True}]  # the heading's and its own
    assert contains(questions, [{"type": "integer", "min": 0, "max": 10}]) and contains(questions, [{"show_when": {"is": "yes"}}])
    assert form["items"][1]["items"][0] == {"id": "where", "type": "multiple_choice", "options": [{"display": "Head"}]}  # the spec itself is untouched


def test_a_corpus_case_can_ask_for_a_list_of_some_length_without_naming_its_items() -> None:
    """Task kinds are the ward's own words: the first run wrote falls_risk_screen where the case said falls_screen — both right."""
    assert contains({"codes": [{"code": "a"}, {"code": "b"}, {"code": "c"}]}, {"codes": {"_min_items": 3}})
    assert not contains({"codes": [{"code": "a"}]}, {"codes": {"_min_items": 3}})
    assert not contains({"codes": "a,b,c"}, {"codes": {"_min_items": 1}})
    assert contains([{"kind": "create_task", "codes": [1, 2, 3, 4]}], [{"kind": "create_task", "codes": {"_min_items": 4}}])


def test_the_corpus_file_is_well_formed() -> None:
    """Every turn is text (a ': ' inside an unquoted line would make YAML read a mapping) and every expectation key is one the runner checks."""
    import yaml

    cases = yaml.safe_load((Path(__file__).resolve().parents[2] / "app_creator" / "eval" / "corpus.yaml").read_text(encoding="utf-8"))["cases"]
    known = {"archetype", "archetype_any", "knobs_contain", "knobs_contain_any", "spec_contain", "form_items_contain", "form_items_contain_any", "roles_min", "default_role", "ready", "refusal", "no_refusal", "reply_contains_any", "reply_not_matching", "reply_language", "spec_excludes_text", "knobs_exclude_text", "tools_called", "refusal_any"}
    for case in cases:
        turns_of(case)
        unknown = set(case.get("expect", {})) - known
        assert not unknown, f"{case['id']}: unknown expectation keys {unknown}"
        assert not any("condition_codes" in json.dumps(alt) for alt in case.get("expect", {}).get("knobs_contain_any", [])), f"{case['id']}: the knob is condition.codes"


def test_summarize_manifest_reads_like_a_review_note() -> None:
    manifest = {
        "metadata": {"app_id": "app_x", "version": "0.1.0", "name": "X", "intent_class": "viewer"},
        "auth": {"roles": [{"id": "viewer", "cognito_group": "app-app_x-viewer", "data_scope_ref": "scope_viewer"}]},
        "data_scopes": {"scope_viewer": {"phi_fields_visible": ["name"], "fhir": [{"resource": "Patient", "operations": ["read"]}]}},
        "primitives": [{"id": "p_patient", "kind": "data.fhir.patient.read"}, {"id": "p_c", "kind": "data.fhir.query", "only_for_roles": ["reviewer"]}],
        "layout": {"root": {"component": "PageShell", "props": {"title": "$metadata.name"}, "children": [{"component": "Section", "props": {"title": "Ctx"}, "show_only_if_role_in": ["reviewer"]}]}},
        "context_inputs": [{"name": "patient_id"}],
    }
    s = summarize_manifest(manifest)
    assert s["primitives"] == ["p_patient: data.fhir.patient.read", "p_c: data.fhir.query [only reviewer]"]
    assert s["layout"] == ["PageShell", "  Section — Ctx [only reviewer]"]
    assert s["roles"]["viewer"]["fhir"] == ["Patient: read"]
