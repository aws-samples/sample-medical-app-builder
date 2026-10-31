"""
The record vocabulary: the seed reads the distinct codes of the connected record (counts, patients, units, panel
components, display texts) within a time budget and stores one document; the drafting assistant loads it, searches it
by display text in any spelling and by code, merges it with the hand-written hints, and tells the model it is there.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))

import seed  # noqa: E402
import vocabulary  # noqa: E402
from fhir_source import InMemoryFhirSource, UpstreamError  # noqa: E402

from app_creator.catalog import Catalog  # noqa: E402
from app_creator.prompts import build_system_prompt  # noqa: E402
from app_creator.vocabulary import RecordVocabulary, vocabulary_from_env  # noqa: E402

NOW = datetime(2026, 10, 5, 3, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def bundle():
    return seed.load_bundle()


@pytest.fixture(scope="module")
def record(bundle):
    return InMemoryFhirSource([e["resource"] for e in bundle["entry"]])


@pytest.fixture(scope="module")
def doc(record):
    return vocabulary.build_vocabulary(record, now=NOW)


class FakeS3:
    def __init__(self):
        self.objects: dict[str, dict] = {}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs

    def get_object(self, Bucket, Key):
        from io import BytesIO

        return {"Body": BytesIO(self.objects[Key]["Body"])}


# ── building it ──────────────────────────────────────────────────────────────────────────────────────────


def test_the_scan_reads_every_distinct_code_with_counts_patients_units_and_panel_components(doc):
    assert doc["version"] == 1 and doc["built_at"] == "2026-10-05T03:00:00Z" and doc["complete"] is True and doc["notes"] == []
    assert doc["scanned"]["Observation"] == 125 and doc["scanned"]["Condition"] == 6 and doc["scanned"]["Immunization"] == 5 and doc["scanned"]["MedicationStatement"] == 0
    by_code = {(e["resource"], e["code"]): e for e in doc["codes"]}
    assert len(doc["codes"]) == 40, "38 codings on resources (two of them the lab's own physio codes) plus the two blood-pressure components"

    bp = by_code[("Observation", "85354-9")]
    assert bp["system"] == "http://loinc.org" and bp["count"] == 72 and bp["patients"] == 3 and bp["components"] == ["8462-4", "8480-6"]
    systolic = by_code[("Observation", "8480-6")]
    assert systolic["component_of"] == ["85354-9"] and systolic["count"] == 72 and systolic["unit"] == "mm[Hg]" and systolic["category"] == "vital-signs"
    assert systolic["display"] and systolic["displays"][0] == systolic["display"]

    weight = by_code[("Observation", "29463-7")]
    assert weight["unit"] == "kg" and weight["count"] == 12 and weight["patients"] == 3 and weight["display"] == "Body weight"
    assert by_code[("Observation", "4548-4")]["unit"] == "%" and by_code[("Observation", "72166-2")]["unit"] is None, "a coded value has no unit"

    migraine = by_code[("Condition", "G43.9")]
    assert migraine["system"] == "http://fhir.de/CodeSystem/bfarm/icd-10-gm" and migraine["display"].startswith("Migräne") and migraine["patients"] == 1
    ramipril = by_code[("MedicationRequest", "C09AA05")]
    assert ramipril["count"] == 2 and ramipril["display"].startswith("Ramipril") and sorted(ramipril["displays"]) == ["Ramipril 10 mg", "Ramipril 5 mg"], "every spelling the record uses, the commonest first"
    assert by_code[("Procedure", "179344006")]["display"] == "Arthroscopy of knee" and by_code[("Immunization", "46233009")]["patients"] == 2
    assert by_code[("DiagnosticReport", "24627-2")]["category"] in ("RAD", "LAB", None)
    assert [e["resource"] for e in doc["codes"][:1]] == ["Observation"] and doc["codes"][0]["code"] == "85354-9", "ordered by type then by how common"
    # A Condition coded in SNOMED CT and ICD-10-GM at once: each coding knows the other — the bridge from a hint's coding to the hospital's.
    ckd = by_code[("Condition", "433144002")]
    assert ckd["also_coded_as"] == [{"system": "http://fhir.de/CodeSystem/bfarm/icd-10-gm", "code": "N18.3", "display": "Chronische Nierenkrankheit, Stadium 3", "count": 1}]
    assert by_code[("Condition", "N18.3")]["also_coded_as"][0]["code"] == "433144002" and by_code[("Condition", "I10.90")]["also_coded_as"][0]["count"] == 2
    assert weight["also_coded_as"] == [], "a single coding has no alternates"
    for e in doc["codes"]:
        assert set(e) == {"resource", "system", "code", "display", "displays", "count", "patients", "unit", "category", "components", "component_of", "also_coded_as"}
        assert not any(k.startswith("Patient/") for k in e["displays"]), "no patient data in the document"


def test_the_scan_keeps_to_its_time_budget_and_says_what_it_did_not_finish(record):
    ticks = iter([0.0, 0.0, 1.0, 2.0, 200.0, 201.0, 202.0, 203.0, 204.0, 205.0, 206.0, 207.0, 208.0, 209.0, 210.0, 211.0])
    doc = vocabulary.build_vocabulary(record, budget_s=100.0, clock=lambda: next(ticks), now=NOW)
    assert doc["complete"] is False
    assert doc["scanned"]["Observation"] == 125 and doc["scanned"]["Condition"] == 6, "the page in hand is finished"
    assert "Condition: 6 of 6 read before the time budget ran out" in doc["notes"]
    assert any(n.startswith("Procedure: not read") for n in doc["notes"]) and "Procedure" not in doc["scanned"]
    assert "partial" in vocabulary.summarize(doc)


def test_a_type_the_server_refuses_is_a_note_not_a_failure(record):
    class Refusing:
        base_url = "https://hospital.example/fhir"

        def get(self, path):
            if path.startswith("Procedure"):
                raise UpstreamError(403, "forbidden", "GET", path)
            resource_type = path.split("?")[0]
            return {"resourceType": "Bundle", "total": len(record.search(resource_type, {}))}

        def iter_search(self, resource_type, params, max_pages=None):
            if resource_type == "Procedure":
                raise UpstreamError(403, "forbidden", "GET", resource_type)
            assert params["_elements"].split(",")[0] in ("code", "medicationCodeableConcept", "vaccineCode") and params["_count"] == "500"
            yield record.search(resource_type, {})

    doc = vocabulary.build_vocabulary(Refusing(), now=NOW)
    assert doc["source"] == "https://hospital.example/fhir" and doc["complete"] is True
    assert doc["scanned"].get("Procedure", 0) == 0 and any(n.startswith("Procedure: upstream") or n.startswith("Procedure:") for n in doc["notes"])
    assert not any(e["resource"] == "Procedure" for e in doc["codes"])
    assert doc["totals"]["Observation"] == 125 and {e["resource"] for e in doc["codes"]} >= {"Observation", "Condition", "Immunization"}


def test_the_seed_stores_the_document_and_reports_it_as_a_finding(record, monkeypatch):
    s3 = FakeS3()
    monkeypatch.setenv("RECORD_VOCABULARY_BUCKET", "medapp-vocabulary")
    monkeypatch.delenv("RECORD_VOCABULARY_KEY", raising=False)
    line = seed.refresh_vocabulary(record, s3_client=s3)
    assert line.startswith("record vocabulary: 40 codes from 153 resources (Observation 125, Condition 6, ") and line.endswith("→ s3://medapp-vocabulary/record-vocabulary.json")
    stored = s3.objects["record-vocabulary.json"]
    assert stored["ContentType"].startswith("application/json") and stored["CacheControl"] == "no-cache"
    assert len(json.loads(stored["Body"])["codes"]) == 40
    monkeypatch.delenv("RECORD_VOCABULARY_BUCKET")
    assert seed.refresh_vocabulary(record, s3_client=s3) is None, "no bucket, nothing to do — the reference deployments without one keep working"

    class Broken:
        def put_object(self, **kwargs):
            raise RuntimeError("AccessDenied")

    monkeypatch.setenv("RECORD_VOCABULARY_BUCKET", "medapp-vocabulary")
    assert seed.refresh_vocabulary(record, s3_client=Broken()).startswith("record vocabulary: not refreshed (RuntimeError: AccessDenied"), "a finding, never a failed deployment"


# ── reading it ───────────────────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def vocab(doc):
    return RecordVocabulary(doc)


def test_the_vocabulary_is_searched_by_display_in_any_spelling_and_by_code(vocab):
    assert vocab.codes and vocab.built_at == "2026-10-05T03:00:00Z" and vocab.complete and not vocab.empty
    assert [h.code for h in vocab.find("migrane")] == ["G43.9"], "the German display, without its umlaut"
    assert [h.code for h in vocab.find("MIGRÄNE")] == ["G43.9"] and [h.code for h in vocab.find("migraine")] == ["37796009"], "each language finds its own spelling — the model is told to try both"
    assert {h.code for h in vocab.find("knee")} == {"239873007", "179344006", "knee_flexion"}, "every word of the term must be in the display; 'Gonarthrose' is not found by 'knee'; the lab's knee flexion is"
    assert [h.code for h in vocab.find("chronischer Nierenkrankheit Stadium 3")] == ["N18.3"], "an inflected word matches by its stem"
    assert [h.code for h in vocab.find("Nierenkrankheiten")] == ["N18.3"] and [h.code for h in vocab.find("hypertensive")] == ["38341003"]
    assert vocab.find("knie") == [], "a word the record never uses, too short for the stem rule"
    assert [h.code for h in vocab.find("Gonarthrosen")] == ["M17.9"], "a plural finds its singular"
    assert [h.code for h in vocab.find("blood pressure")][0] == "85354-9", "the most common first"
    assert vocab.find("8480-6")[0].display and vocab.find("8480-6")[0].component_of == ("85354-9",), "an exact code is verified against the record"
    assert vocab.find("unicorn") == [] and vocab.find("") == []
    pollen = vocab.find("pollen")[0]
    assert pollen.resource == "AllergyIntolerance" and pollen.system == "http://snomed.info/sct" and pollen.patients == 1
    by_type = vocab.by_resource()
    assert by_type["Observation"] == 10 and by_type["Condition"] == 10 and by_type["Immunization"] == 4


def test_the_catalog_merges_the_record_with_its_hints(vocab):
    plain = Catalog.load()
    assert plain.vocabulary.empty and plain.lookup_codes("migraine")[0].record is None, "without a record the hints stand alone"
    catalog = Catalog.load(vocabulary=vocab)

    hits = catalog.lookup_codes("migraine")
    assert [(h.system, h.code, h.origin) for h in hits] == [("snomed", "37796009", "hint")], "the hint, marked as present on the record; the record's own SNOMED entry is the same code, not a second row"
    assert hits[0].record == {
        "display": "Migraine", "count": 1, "patients": 1, "resource": "Condition", "category": "problem-list-item", "unit": None,
        "also_coded_as": [{"system": "icd10gm", "code": "G43.9", "display": "Migräne, nicht näher bezeichnet"}],
    }, "the hint is on the record — and the record also codes the same conditions in ICD-10-GM, with the catalog's alias for the system"
    ckd = catalog.lookup_codes("chronic kidney disease stage 3")
    assert (ckd[0].system, ckd[0].code) == ("snomed", "433144002") and ckd[0].record["also_coded_as"] == [{"system": "icd10gm", "code": "N18.3", "display": "Chronische Nierenkrankheit, Stadium 3"}], "an English search reaches the hospital's coding through the alternates"
    german = catalog.lookup_codes("Migräne")
    assert [(h.system, h.code, h.origin) for h in german] == [("icd10gm", "G43.9", "record")], "no hint knows the German word; the record does — its ICD-10-GM code, with the catalog's alias for the system"
    assert german[0].name == "Migräne, nicht näher bezeichnet (Condition, record)" and german[0].record["resource"] == "Condition"

    arthroscopy = catalog.lookup_codes("arthroscopy")
    assert [(h.system, h.code) for h in arthroscopy] == [("snomed", "179344006")], "a code the hints never knew — from the record, with the catalog's alias for its system"
    assert catalog.lookup_codes("hba1c")[0].record["unit"] == "%" and catalog.lookup_codes("hba1c")[0].unit == "%"
    assert catalog.lookup_codes("ferritin") == [], "not in the hints, not on the record: the tool says so and the model asks"
    absent = catalog.lookup_codes("potassium")
    assert absent and absent[0].record is None, "a hint the record does not carry is returned, unmarked — the app would show no data here"
    assert catalog.lookup_codes("C09AA05")[0].record["display"].startswith("Ramipril") and catalog.lookup_codes("C09AA05")[0].origin == "hint", "a code typed in is verified against both"
    systolic = catalog.lookup_codes("8480-6")
    assert systolic and systolic[0].system == "loinc" and systolic[0].record["resource"] == "Observation"

    summary = catalog.record_summary()
    assert summary["available"] is True and summary["built_at"] == "2026-10-05T03:00:00Z" and summary["complete"] is True
    assert summary["resources"]["Observation"] == {"codes": 10, "systems": ["https://hsp-musterstadt.medapp.eu/CodeSystem/physio", "loinc"], "scanned": 125}, "the lab's own system has no alias in the catalog, so it is named by its URL"
    assert summary["resources"]["Condition"]["systems"] == ["icd10gm", "snomed"]


def test_the_prompt_tells_the_model_the_record_is_searchable(vocab):
    without = build_system_prompt(Catalog.load(), "Hospital", "hsp-test")
    assert "record's vocabulary" not in without
    prompt = build_system_prompt(Catalog.load(vocabulary=vocab), "Hospital", "hsp-test")
    assert "## The record's vocabulary (read from the hospital's FHIR server on 2026-10-05)" in prompt
    assert "Observation: 10 codes (https://hsp-musterstadt.medapp.eu/CodeSystem/physio, loinc) in 125 resources" in prompt and "Condition: 10 codes (icd10gm, snomed) in 6 resources" in prompt
    assert "German" in prompt and "lookup_codes" in prompt


def test_loaders_file_s3_and_environment(doc, tmp_path, monkeypatch):
    path = tmp_path / "vocab.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    assert len(RecordVocabulary.from_file(path).codes) == 40
    assert RecordVocabulary.from_file(tmp_path / "missing.json").empty, "a missing file is an empty vocabulary, not a crash"

    s3 = FakeS3()
    vocabulary.store_vocabulary(doc, "medapp-vocabulary", client=s3)
    loaded = RecordVocabulary.from_s3("medapp-vocabulary", "record-vocabulary.json", client=s3)
    assert len(loaded.codes) == 40 and loaded.source == ""

    class NoObject:
        def get_object(self, Bucket, Key):
            raise RuntimeError("NoSuchKey")

    assert RecordVocabulary.from_s3("medapp-vocabulary", "record-vocabulary.json", client=NoObject()).empty, "before the first seed has run: empty, the agent runs on hints"

    monkeypatch.delenv("MEDAPP_VOCABULARY_FILE", raising=False)
    monkeypatch.delenv("RECORD_VOCABULARY_BUCKET", raising=False)
    assert vocabulary_from_env().empty
    monkeypatch.setenv("MEDAPP_VOCABULARY_FILE", str(path))
    assert len(vocabulary_from_env().codes) == 40

    assert RecordVocabulary({"version": 99, "codes": "garbage"}).empty, "an unreadable document is treated as absent"
    assert RecordVocabulary(None).empty


def test_the_tool_tells_the_model_when_hints_are_not_on_the_record(vocab):
    import json as _json

    from app_creator.draft import Draft
    from app_creator.groups import StaticGroups
    from app_creator.tools import make_tools

    catalog = Catalog.load(vocabulary=vocab)
    tools = {t.tool_name: t for t in make_tools(Draft(catalog), catalog, None, StaticGroups(), "hsp-test")}
    lookup = tools["lookup_codes"]

    potassium = _json.loads(lookup(term="potassium"))
    assert potassium["codes"][0]["code"] == "2823-3" and potassium["codes"][0]["record"] is None and potassium["record_vocabulary"] == "read on 2026-10-05"
    assert potassium["note"].startswith("These are catalog hints and none of them is on the record"), "the synthetic record has no potassium: the model is told to search the record's spelling, not to take the hint"

    weight = _json.loads(lookup(term="body weight"))
    assert weight["note"] is None and weight["codes"][0]["record"]["patients"] == 3 and weight["codes"][0]["origin"] == "hint"

    german = _json.loads(lookup(term="Gonarthrose"))
    assert german["codes"][0]["origin"] == "record" and german["codes"][0]["system"] == "icd10gm" and german["codes"][0]["record"]["also_coded_as"][0]["system"] == "snomed"

    nothing = _json.loads(lookup(term="ferritin"))
    assert nothing["codes"] == [] and "Neither the hints nor the record match" in nothing["note"]

