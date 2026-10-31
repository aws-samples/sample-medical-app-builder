"""
The dispatcher against the deployed reference FHIR server — the same enforcement path as production, the real
HTTP client, IAM-signed requests. Skipped unless the endpoint is configured:

    export MEDAPP_FHIR_BASE_URL=$(aws ssm get-parameter --name /medapp/hsp-musterstadt/reference/fhir-base-url --query Parameter.Value --output text)
    export MEDAPP_DICOMWEB_BASE_URL=$(aws ssm get-parameter --name /medapp/hsp-musterstadt/reference/dicomweb-base-url --query Parameter.Value --output text)
    pytest tests/integration -v            # AWS_PROFILE / AWS_REGION as for any AWS call

What it proves, in order: the seed is on the server and searchable the way the primitives search (combo-code,
date window, canonical questionnaire, clinical-status); a reading recorded through the write primitive is in the
very next trend search (no result cache), a replay of the same submission is one record, and the Provenance is
there; a problem resolved with the version the client saw becomes a new version with history, a stale version is
refused with 409; a prescription is stopped with its reason; the PACS answers QIDO-RS by MRN with every study the record declares and
the imaging primitive returns them as ImagingStudy resources. The record is reset to the seed at start and end.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))

BASE_URL = os.environ.get("MEDAPP_FHIR_BASE_URL")
DICOMWEB_URL = os.environ.get("MEDAPP_DICOMWEB_BASE_URL")  # the reference PACS; imaging tests skip without it
# These tests reset the server to the synthetic record: they are for the reference server only. A hospital's server
# (MEDAPP_FHIR_AUTH=oauth2) is exercised read-only by test_hospital_servers.py.
pytestmark = pytest.mark.skipif(
    not BASE_URL or (os.environ.get("MEDAPP_FHIR_AUTH") or "sigv4").lower() == "oauth2",
    reason="MEDAPP_FHIR_BASE_URL is not set (no reference FHIR server to test against), or it names a hospital server (oauth2): these tests write the synthetic record and must not run there",
)

if BASE_URL:
    from medapp_shared import registry_model as rm  # noqa: E402
    from medapp_shared.sigv4 import SigV4Signer  # noqa: E402

    spec = importlib.util.spec_from_file_location("dispatcher_handler_it", DISPATCHER_DIR / "handler.py")
    handler = importlib.util.module_from_spec(spec)
    sys.modules["dispatcher_handler_it"] = handler
    spec.loader.exec_module(handler)  # type: ignore[union-attr]
    import dicomweb  # noqa: E402
    import seed as seeding  # noqa: E402
    from fhir_source import HttpFhirSource  # noqa: E402

PATIENT = "pat-kms-0001"
KNEE = "cond-kms-0003"  # knee osteoarthritis, active in the seed
AMLODIPINE = "medrx-kms-0003"  # active in the seed
BP, SYS, DIA = "http://loinc.org|85354-9", "http://loinc.org|8480-6", "http://loinc.org|8462-4"
QUESTIONNAIRE = "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"
WARD_GROUPS = "[app-app_ward_it-ward]"


def ward_manifest() -> dict:
    scope = {
        "patient_scope": "individual",
        "phi_fields_visible": ["name", "dob", "mrn"],
        "fhir": [
            {"resource": "Patient", "operations": ["read"]},
            {"resource": "Observation", "operations": ["search", "create"], "codes": [BP], "filter": "subject={context.patient_id}"},
            {"resource": "Condition", "operations": ["search", "update"], "filter": "subject={context.patient_id}"},
            {"resource": "MedicationRequest", "operations": ["search", "update"], "filter": "subject={context.patient_id}"},
            {"resource": "QuestionnaireResponse", "operations": ["search"], "filter": "subject={context.patient_id}"},
            {"resource": "Provenance", "operations": ["create"]},
        ],
        "dicom": [{"operations": ["qido"], "modalities": ["CT", "MR", "DX", "US"], "study_filter": "PatientID={context.patient_mrn}"}],
    }
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_ward_it", "version": "0.1.0", "name": "Ward (integration)", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-17T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "ward", "display_name": "Ward", "cognito_group": "app-app_ward_it-ward", "data_scope_ref": "scope_ward", "ui_capabilities": ["view"]}], "default_role": "ward"},
        "data_scopes": {"scope_ward": scope},
        "primitives": [
            {"id": "p_patient", "kind": "data.fhir.patient.read", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id"}, "output_binding": "patient"},
            {"id": "p_bp", "kind": "data.fhir.observation.by_code", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id", "codes": [BP], "since": "now-2y"}, "output_binding": "bp"},
            {"id": "p_problems", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "Condition", "params": {"patient": "$context.patient_id", "clinical-status": "active"}}, "output_binding": "problems"},
            {"id": "p_meds", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "MedicationRequest", "params": {"patient": "$context.patient_id", "status": "active"}}, "output_binding": "meds"},
            {"id": "p_earlier", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "QuestionnaireResponse", "params": {"patient": "$context.patient_id", "questionnaire": QUESTIONNAIRE}}, "output_binding": "earlier"},
            {"id": "p_bp_entry", "kind": "write.fhir.observation.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [BP], "components": [SYS, DIA], "unit": "mmHg", "category": "vital-signs", "ranges": {SYS: {"min": 50, "max": 300}, DIA: {"min": 30, "max": 200}}, "max_backdate_days": 7, "observation": "$ui.bp_entry"}, "output_binding": "bp_recorded"},
            {"id": "p_resolve", "kind": "write.fhir.condition.update_status", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "allowed": ["resolved", "inactive"], "change": "$ui.resolve"}, "output_binding": "resolved"},
            {"id": "p_studies", "kind": "data.dicom.studies.for_patient", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id", "modalities": ["CT", "MR", "DX", "US"]}, "output_binding": "studies"},
            {"id": "p_stop", "kind": "write.fhir.medication_request.update_status", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "allowed": ["stopped", "completed", "on-hold"], "change": "$ui.stop"}, "output_binding": "stopped"},
        ],
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Ward"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": True, "source": ["smart_launch"]}],
        "actions": [
            {"id": "record_bp", "label": "Record", "primitive": "p_bp_entry", "on_success": "reload"},
            {"id": "resolve", "label": "Resolve", "primitive": "p_resolve", "on_success": "reload"},
            {"id": "stop", "label": "Stop", "primitive": "p_stop", "on_success": "reload"},
        ],
        "audit": {"clinical_context": "ward", "intended_users": ["nurse"], "intended_purpose": "integration test", "mdr_classification": "none", "data_categories": ["phi"]},
    }


class FakeTable:
    def __init__(self, items):
        self.items = {(i["PK"], i["SK"]): i for i in items}

    def get_item(self, **kwargs):
        item = self.items.get((kwargs["Key"]["PK"], kwargs["Key"]["SK"]))
        return {"Item": item} if item else {}


@pytest.fixture(scope="module")
def source():
    import boto3

    session = boto3.session.Session()
    signer = SigV4Signer(service="execute-api", region=session.region_name, credentials=session.get_credentials())
    src = HttpFhirSource(BASE_URL, timeout_s=60.0, signer=signer)
    report = seeding.seed(src)  # reset to the seed before, so the assertions below hold on any run
    assert not report.failed, report.failed
    yield src
    seeding.seed(src, check=False)  # and after: the demo data is back to its seeded state


@pytest.fixture(scope="module")
def audit():
    return []


@pytest.fixture(scope="module")
def dispatcher(source, audit):
    item = rm.version_item(ward_manifest(), created_by_sub="seed", now="2026-09-17T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([item]), source, emit_audit=audit.append)


def call(dispatcher, kind, primitive_id, config, sub="nurse-it"):
    event = {
        "routeKey": "POST /primitives/{kind}",
        "pathParameters": {"kind": kind},
        "body": json.dumps({"app_id": "app_ward_it", "manifest_version": "0.1.0", "primitive_id": primitive_id, "role": "ward", "config": config, "context": {"patient_id": PATIENT}}),
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": WARD_GROUPS, "email": "nurse@klinikum-musterstadt.example"}}}},
    }
    res = handler.handle(event, dispatcher)
    return res["statusCode"], json.loads(res["body"])


def bp_config(observation):
    return {"subject": PATIENT, "codes": [BP], "components": [SYS, DIA], "unit": "mmHg", "category": "vital-signs", "ranges": {SYS: {"min": 50, "max": 300}, DIA: {"min": 30, "max": 200}}, "max_backdate_days": 7, "observation": observation}


def reading(sys_value, dia_value, submission):
    when = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    return {
        "resourceType": "Observation",
        "identifier": [{"system": "urn:medapp:submission", "value": submission}],
        "code": {"coding": [{"system": "http://loinc.org", "code": "85354-9", "display": "Blood pressure panel"}]},
        "effectiveDateTime": when,
        "component": [
            {"code": {"coding": [{"system": "http://loinc.org", "code": "8480-6"}]}, "valueQuantity": {"value": sys_value, "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
            {"code": {"coding": [{"system": "http://loinc.org", "code": "8462-4"}]}, "valueQuantity": {"value": dia_value, "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
        ],
    }


def test_the_server_says_who_it_is(source):
    capability = source.capability_statement()
    assert capability["resourceType"] == "CapabilityStatement" and capability["fhirVersion"].startswith("4.0")


def test_the_seed_answers_every_search_the_primitives_make(source):
    assert seeding.verify(source) == []


def test_reads_through_the_dispatcher(dispatcher):
    status, out = call(dispatcher, "data.fhir.patient.read", "p_patient", {"patient": PATIENT})
    assert status == 200 and out["output"]["identifier"][0]["value"] == "KMS-0048213"

    status, out = call(dispatcher, "data.fhir.observation.by_code", "p_bp", {"patient": PATIENT, "codes": [BP], "since": "now-2y"})
    assert status == 200 and len(out["output"]) >= 10, "two years of blood pressure readings, found by the panel code"
    dates = [o.get("effectiveDateTime") for o in out["output"]]
    assert dates == sorted(dates, reverse=True), "newest first"

    status, out = call(dispatcher, "data.fhir.query", "p_problems", {"resource": "Condition", "params": {"patient": PATIENT, "clinical-status": "active"}})
    assert status == 200 and {c["id"] for c in out["output"]} >= {KNEE}

    status, out = call(dispatcher, "data.fhir.query", "p_earlier", {"resource": "QuestionnaireResponse", "params": {"patient": PATIENT, "questionnaire": QUESTIONNAIRE}})
    assert status == 200 and len(out["output"]) >= 1, "earlier assessments are found by the questionnaire's canonical URL"


def test_a_recorded_reading_is_in_the_next_search_and_a_replay_is_one_record(dispatcher, source, audit):
    before = call(dispatcher, "data.fhir.observation.by_code", "p_bp", {"patient": PATIENT, "codes": [BP], "since": "now-2y"})[1]["output"]
    submission = f"it-{uuid.uuid4()}"

    status, out = call(dispatcher, "write.fhir.observation.create", "p_bp_entry", bp_config(reading(138, 86, submission)))
    assert status == 200, out
    stored = out["output"]
    assert stored["status"] == "final" and stored["subject"] == {"reference": f"Patient/{PATIENT}"}
    assert stored["meta"]["versionId"] == "1" and stored["performer"][0]["identifier"]["value"] == "nurse-it"
    assert stored.get("meta", {}).get("source", "").startswith("urn:medapp:app_ward_it@0.1.0"), "meta.source is stamped (a server may append its request id)"

    after = call(dispatcher, "data.fhir.observation.by_code", "p_bp", {"patient": PATIENT, "codes": [BP], "since": "now-2y"})[1]["output"]
    assert len(after) == len(before) + 1, "no search-result cache between a write and the next read"
    assert after[0]["id"] == stored["id"], "the new reading is the newest"

    again = call(dispatcher, "write.fhir.observation.create", "p_bp_entry", bp_config(reading(138, 86, submission)))
    assert again[0] == 200 and again[1]["output"]["id"] == stored["id"], "the same submission twice is one record"
    assert len(call(dispatcher, "data.fhir.observation.by_code", "p_bp", {"patient": PATIENT, "codes": [BP], "since": "now-2y"})[1]["output"]) == len(before) + 1

    provenance = source.search("Provenance", {"target": f"Observation/{stored['id']}"})
    assert len(provenance) == 1, "one Provenance for one write, even after the replay"
    assert provenance[0]["agent"][0]["who"]["identifier"]["value"] == "nurse-it"

    refused = call(dispatcher, "write.fhir.observation.create", "p_bp_entry", bp_config(reading(900, 86, f"it-{uuid.uuid4()}")))
    assert refused[0] == 422 and any("900" in p for p in refused[1]["problems"])


def test_resolving_a_problem_is_a_new_version_with_history_and_a_stale_version_is_refused(dispatcher, source):
    current = source.read("Condition", KNEE)
    assert current["clinicalStatus"]["coding"][0]["code"] == "active"
    version = current["meta"]["versionId"]

    status, out = call(dispatcher, "write.fhir.condition.update_status", "p_resolve", {"subject": PATIENT, "allowed": ["resolved", "inactive"], "change": {"id": KNEE, "status": "resolved", "versionId": version, "note": "Beschwerdefrei."}})
    assert status == 200, out
    resolved = out["output"]
    assert resolved["clinicalStatus"]["coding"][0]["code"] == "resolved" and resolved.get("abatementDateTime")
    assert int(resolved["meta"]["versionId"]) == int(version) + 1
    assert any(n.get("text") == "Beschwerdefrei." for n in resolved.get("note", []))

    history = source.get(f"Condition/{KNEE}/_history")
    assert history["resourceType"] == "Bundle" and len(history["entry"]) >= 2, "the previous version is kept"

    stale = call(dispatcher, "write.fhir.condition.update_status", "p_resolve", {"subject": PATIENT, "allowed": ["resolved", "inactive"], "change": {"id": KNEE, "status": "inactive", "versionId": version}})
    assert stale[0] == 409 and "changed by someone else" in stale[1]["message"]

    active_now = call(dispatcher, "data.fhir.query", "p_problems", {"resource": "Condition", "params": {"patient": PATIENT, "clinical-status": "active"}})[1]["output"]
    assert KNEE not in {c["id"] for c in active_now}

    provenance = source.search("Provenance", {"target": f"Condition/{KNEE}"})
    assert provenance and any(e.get("role") == "revision" for p in provenance for e in p.get("entity", []))


def test_the_pacs_answers_qido_by_mrn_with_every_study_of_the_record(source):
    """Imaging: the reference PACS (Orthanc) holds the generated studies and answers QIDO-RS by hospital MRN."""
    if not DICOMWEB_URL:
        pytest.skip("MEDAPP_DICOMWEB_BASE_URL is not set: no reference PACS to test against")
    dicom = dicomweb.DicomWebSource(DICOMWEB_URL, timeout_s=60.0, signer=source._signer)  # noqa: SLF001 — the same identity
    assert seeding.verify_dicom(dicom, wait_s=60) == []
    studies = dicom.studies("KMS-0048213")
    assert {str(dicomweb.value(s, dicomweb.TAG_STUDY_UID)) for s in studies} == {"1.2.276.0.7230010.3.1.2.8323329.1001", "1.2.276.0.7230010.3.1.2.8323329.1002"}
    ct = next(s for s in studies if dicomweb.value(s, dicomweb.TAG_STUDY_UID) == "1.2.276.0.7230010.3.1.2.8323329.1001")
    assert dicomweb.value(ct, dicomweb.TAG_N_INSTANCES) in (412, "412"), "every declared instance was indexed"
    assert dicomweb.values(ct, dicomweb.TAG_MODALITIES) == ["CT"] and dicomweb.value(ct, dicomweb.TAG_DESCRIPTION) == "CT Thorax mit Kontrastmittel"


def test_imaging_through_the_dispatcher_comes_from_the_pacs(source, audit):
    if not DICOMWEB_URL:
        pytest.skip("MEDAPP_DICOMWEB_BASE_URL is not set: no reference PACS to test against")
    dicom = dicomweb.DicomWebSource(DICOMWEB_URL, timeout_s=60.0, signer=source._signer)  # noqa: SLF001
    item = rm.version_item(ward_manifest(), created_by_sub="seed", now="2026-09-17T00:00:00Z", state="published")
    with_pacs = handler.Dispatcher(FakeTable([item]), source, emit_audit=audit.append, dicom=dicom)
    status, out = call(with_pacs, "data.dicom.studies.for_patient", "p_studies", {"patient": PATIENT, "modalities": ["CT", "MR", "DX", "US"]})
    assert status == 200, out
    studies = out["output"]
    assert [s["identifier"][0]["value"] for s in studies] == ["urn:oid:1.2.276.0.7230010.3.1.2.8323329.1001", "urn:oid:1.2.276.0.7230010.3.1.2.8323329.1002"], "newest first, by MRN"
    assert studies[0]["numberOfSeries"] == 3 and studies[0]["numberOfInstances"] == 412 and studies[0]["started"].startswith("2025-11-03T09:12:00")
    assert studies[0]["subject"]["reference"] == f"Patient/{PATIENT}"
    only_dx = call(with_pacs, "data.dicom.studies.for_patient", "p_studies", {"patient": PATIENT, "modalities": ["DX"]})[1]["output"]
    assert [s["modality"][0]["code"] for s in only_dx] == ["DX"]


def test_stopping_a_prescription_records_the_reason(dispatcher, source):
    current = source.read("MedicationRequest", AMLODIPINE)
    status, out = call(dispatcher, "write.fhir.medication_request.update_status", "p_stop", {"subject": PATIENT, "allowed": ["stopped", "completed", "on-hold"], "change": {"id": AMLODIPINE, "status": "stopped", "versionId": current["meta"]["versionId"], "reason": "Knöchelödeme"}})
    assert status == 200, out
    assert out["output"]["status"] == "stopped" and out["output"]["statusReason"]["text"] == "Knöchelödeme"
    active = call(dispatcher, "data.fhir.query", "p_meds", {"resource": "MedicationRequest", "params": {"patient": PATIENT, "status": "active"}})[1]["output"]
    assert AMLODIPINE not in {m["id"] for m in active}
