"""
Imaging from a PACS: the QIDO-RS client against a local DICOMweb endpoint, the DICOM JSON → ImagingStudy mapping
the renderer relies on, the MRN join, and the primitive taking the PACS path when a DICOMweb source is configured
while the FHIR record still supplies the patient. Also the seed's imaging verification.
"""

import glob
import importlib.util
import json
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))

from medapp_shared import registry_model as rm  # noqa: E402

spec = importlib.util.spec_from_file_location("dispatcher_handler_dw", DISPATCHER_DIR / "handler.py")
handler = importlib.util.module_from_spec(spec)
sys.modules["dispatcher_handler_dw"] = handler
spec.loader.exec_module(handler)  # type: ignore[union-attr]

import dicomweb  # noqa: E402
import primitives  # noqa: E402
import seed as seeding  # noqa: E402
from fhir_source import InMemoryFhirSource, UpstreamError  # noqa: E402

BUNDLE = DISPATCHER_DIR / "data" / "synthetic-musterstadt.bundle.json"
MANIFEST_DIR = ROOT.parent / "med_app" / "fixtures" / "manifests"  # the hand-authored reference manifests the tests exercise

# A QIDO-RS study result as Orthanc renders it (DICOM JSON), for Anneliese Krüger's CT.
CT_STUDY = {
    "00080020": {"vr": "DA", "Value": ["20251103"]},
    "00080030": {"vr": "TM", "Value": ["091200"]},
    "00080050": {"vr": "SH", "Value": ["ACC00000001"]},
    "00080061": {"vr": "CS", "Value": ["CT"]},
    "00080090": {"vr": "PN", "Value": [{"Alphabetic": "Hoffmann^Lukas^^Dr. med."}]},
    "00080201": {"vr": "SH", "Value": ["+0100"]},
    "00081030": {"vr": "LO", "Value": ["CT Thorax mit Kontrastmittel"]},
    "00100010": {"vr": "PN", "Value": [{"Alphabetic": "Krüger^Anneliese"}]},
    "00100020": {"vr": "LO", "Value": ["KMS-0048213"]},
    "0020000D": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001"]},
    "00200010": {"vr": "SH", "Value": ["img-kms-0001"]},
    "00201206": {"vr": "IS", "Value": [3]},
    "00201208": {"vr": "IS", "Value": [412]},
}
SERIES = {
    "1.2.276.0.7230010.3.1.2.8323329.1001": [
        {"0020000E": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001.1"]}, "00200011": {"vr": "IS", "Value": [1]}, "00080060": {"vr": "CS", "Value": ["CT"]}, "0008103E": {"vr": "LO", "Value": ["Topogram"]}, "00201209": {"vr": "IS", "Value": [2]}},
        {"0020000E": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001.2"]}, "00200011": {"vr": "IS", "Value": [2]}, "00080060": {"vr": "CS", "Value": ["CT"]}, "0008103E": {"vr": "LO", "Value": ["Thorax axial 1 mm"]}, "00201209": {"vr": "IS", "Value": [350]}, "00180015": {"vr": "CS", "Value": ["CHEST"]}},
        {"0020000E": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001.3"]}, "00200011": {"vr": "IS", "Value": [3]}, "00080060": {"vr": "CS", "Value": ["CT"]}, "0008103E": {"vr": "LO", "Value": ["Coronale MPR"]}, "00201209": {"vr": "IS", "Value": [60]}},
    ]
}
MARKER = "dicom-seed-2 0123456789ab"
INSTANCES = {  # QIDO instance results (one per study is enough for the verification) and the WADO-RS metadata of that instance
    "1.2.276.0.7230010.3.1.2.8323329.1001": {"00080018": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001.1.1"]}, "0020000E": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1001.1"]}},
    "1.2.276.0.7230010.3.1.2.8323329.1002": {"00080018": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1002.1.1"]}, "0020000E": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1002.1"]}},
}
METADATA = {"00080060": {"vr": "CS", "Value": ["CT"]}, "00181020": {"vr": "LO", "Value": [MARKER]}, "00280010": {"vr": "US", "Value": [256]}}
DX_STUDY = {
    "00080020": {"vr": "DA", "Value": ["20240612"]},
    "00080030": {"vr": "TM", "Value": ["144000"]},
    "00080061": {"vr": "CS", "Value": ["DX"]},
    "00081030": {"vr": "LO", "Value": ["Röntgen Knie rechts in 2 Ebenen"]},
    "00100020": {"vr": "LO", "Value": ["KMS-0048213"]},
    "0020000D": {"vr": "UI", "Value": ["1.2.276.0.7230010.3.1.2.8323329.1002"]},
    "00201206": {"vr": "IS", "Value": [2]},
    "00201208": {"vr": "IS", "Value": [2]},
}


class FakeDicomWeb:
    """`/dicom-web/studies?PatientID=…` over a dict of PatientID → study results, `/studies/{uid}/series` over SERIES; 204 when nothing matches."""

    def __init__(self, by_patient: dict[str, list[dict]]):
        self.requests: list[dict] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                params = urllib.parse.parse_qs(parsed.query)
                server.requests.append({"path": parsed.path, "query": parsed.query, "params": params, "headers": {k.lower(): v for k, v in self.headers.items()}})
                if parsed.path.endswith("/metadata"):  # WADO-RS: …/studies/{s}/series/{se}/instances/{i}/metadata
                    body = json.dumps([dict(METADATA, **{"00080018": {"vr": "UI", "Value": [parsed.path.split("/")[-2]]}})]).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/dicom+json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if parsed.path.endswith("/instances"):
                    study_uid = parsed.path.split("/")[-2]
                    found = [INSTANCES[study_uid]] if study_uid in INSTANCES else []
                    if not found:
                        self.send_response(204)
                        self.end_headers()
                        return
                    body = json.dumps(found).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/dicom+json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if parsed.path.endswith("/series"):
                    study_uid = parsed.path.split("/")[-2]
                    found = SERIES.get(study_uid, [])
                    if not found:
                        self.send_response(204)
                        self.end_headers()
                        return
                    body = json.dumps(found).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/dicom+json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if not parsed.path.endswith("/studies"):
                    self.send_response(400)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":"only studies"}')
                    return
                found = by_patient.get(params.get("PatientID", [""])[0], [])
                if not found:
                    self.send_response(204)
                    self.end_headers()
                    return
                body = json.dumps(found).encode()
                self.send_response(200)
                self.send_header("content-type", "application/dicom+json")
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.httpd.shutdown()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/dicom-web"


@pytest.fixture
def pacs():
    with FakeDicomWeb({"KMS-0048213": [DX_STUDY, CT_STUDY]}) as s:
        yield s


def test_qido_result_becomes_the_imaging_study_the_renderer_consumes():
    study = dicomweb.imaging_study_from_qido(CT_STUDY, "pat-kms-0001", "Anneliese Krüger")
    assert study["resourceType"] == "ImagingStudy" and study["status"] == "available"
    assert study["identifier"][0] == {"system": "urn:dicom:uid", "value": "urn:oid:1.2.276.0.7230010.3.1.2.8323329.1001"}, "what studyInstanceUid() in the frontend reads"
    assert study["subject"] == {"reference": "Patient/pat-kms-0001", "display": "Anneliese Krüger"}
    assert study["modality"] == [{"system": dicomweb.DCM, "code": "CT"}]
    assert study["started"] == "2025-11-03T09:12:00+01:00", "the record's local time, with the zone the PACS kept"
    assert study["numberOfSeries"] == 3 and study["numberOfInstances"] == 412
    assert study["description"] == "CT Thorax mit Kontrastmittel"
    assert study["referrer"] == {"display": "Dr. med. Lukas Hoffmann"}
    assert any(i.get("value") == "ACC00000001" for i in study["identifier"])
    assert len(study["id"]) <= 64 and study["id"] == dicomweb.study_resource_id("1.2.276.0.7230010.3.1.2.8323329.1001")
    with pytest.raises(ValueError):
        dicomweb.imaging_study_from_qido({"00080020": {"vr": "DA", "Value": ["20250101"]}}, "p")


def test_dicom_dates_and_names_are_tolerant():
    assert dicomweb.dicom_datetime("20250103", None, None) == "2025-01-03"
    assert dicomweb.dicom_datetime("20250103", "0912", None) == "2025-01-03T09:12:00"
    assert dicomweb.dicom_datetime("20250103", "091259.123456", "-0500") == "2025-01-03T09:12:59-05:00"
    assert dicomweb.dicom_datetime("", "091200", None) is None and dicomweb.dicom_datetime("2025", None, None) is None
    assert dicomweb.person_name("Hoffmann^Lukas") == "Lukas Hoffmann" and dicomweb.person_name("Hoffmann") == "Hoffmann" and dicomweb.person_name(None) is None


def test_the_patient_id_a_pacs_knows_is_the_mrn():
    patient = {"identifier": [{"system": "urn:other", "value": "X-1"}, {"type": {"text": "MRN"}, "system": dicomweb.DEFAULT_PATIENT_ID_SYSTEM, "value": "KMS-0048213"}]}
    assert dicomweb.patient_dicom_id(patient, dicomweb.DEFAULT_PATIENT_ID_SYSTEM) == "KMS-0048213"
    typed = {"identifier": [{"system": "urn:other", "value": "X-1"}, {"type": {"coding": [{"code": "MR"}]}, "value": "MR-7"}]}
    assert dicomweb.patient_dicom_id(typed, "https://nowhere") == "MR-7", "falls back to the identifier typed as a medical record number"
    assert dicomweb.patient_dicom_id({"identifier": [{"value": "only"}]}, "https://nowhere") == "only"
    assert dicomweb.patient_dicom_id({}, "https://nowhere") is None


def test_qido_client_queries_by_patient_id_and_maps_204_to_nothing(pacs):
    source = dicomweb.DicomWebSource(pacs.base_url)
    found = source.studies("KMS-0048213")
    assert [dicomweb.value(s, dicomweb.TAG_STUDY_UID) for s in found] == ["1.2.276.0.7230010.3.1.2.8323329.1002", "1.2.276.0.7230010.3.1.2.8323329.1001"]
    request = pacs.requests[-1]
    assert request["path"] == "/dicom-web/studies" and request["params"]["PatientID"] == ["KMS-0048213"]
    assert "StudyDescription" in request["params"]["includefield"] and "NumberOfStudyRelatedInstances" in request["params"]["includefield"]
    assert request["headers"]["accept"] == "application/dicom+json"
    assert source.studies("KMS-nobody") == []
    assert [dicomweb.value(s, dicomweb.TAG_STUDY_UID) for s in source.studies("KMS-0048213", ["CT"])] == ["1.2.276.0.7230010.3.1.2.8323329.1001"], "modalities filter"
    with pytest.raises(UpstreamError):
        source._qido("nothing", {})  # noqa: SLF001 — the fake refuses paths it does not know


def test_imaging_studies_for_a_patient_are_newest_first_and_carry_the_patient_reference(pacs):
    source = dicomweb.DicomWebSource(pacs.base_url)
    patient = InMemoryFhirSource.from_file(BUNDLE).read("Patient", "pat-kms-0001")
    studies = source.imaging_studies(patient)
    assert [s["started"][:10] for s in studies] == ["2025-11-03", "2024-06-12"]
    assert all(s["subject"]["reference"] == "Patient/pat-kms-0001" and s["subject"]["display"] == "Anneliese Krüger" for s in studies)
    # The series come along, so a viewer knows which one is the volume to reconstruct (the 350-slice axial, not the topogram).
    series_requests = [r for r in pacs.requests if r["path"].endswith("/series")]
    assert [r["path"] for r in series_requests] == [f"/dicom-web/studies/1.2.276.0.7230010.3.1.2.8323329.{n}/series" for n in ("1002", "1001")], "one per study, in the PACS's order"
    assert series_requests[0]["query"] == "includefield=SeriesDescription&includefield=NumberOfSeriesRelatedInstances&includefield=BodyPartExamined"
    for request in pacs.requests:  # every query is well-formed: no empty pair, which SigV4 signs and API Gateway drops (→ 403 on AWS only)
        assert all(pair and "=" in pair for pair in request["query"].split("&")) if request["query"] else True, request
    ct = studies[0]
    assert [x["uid"] for x in ct["series"]] == ["1.2.276.0.7230010.3.1.2.8323329.1001.1", "1.2.276.0.7230010.3.1.2.8323329.1001.2", "1.2.276.0.7230010.3.1.2.8323329.1001.3"]
    assert ct["series"][1] == {"uid": "1.2.276.0.7230010.3.1.2.8323329.1001.2", "number": 2, "modality": {"system": dicomweb.DCM, "code": "CT"}, "description": "Thorax axial 1 mm", "numberOfInstances": 350, "bodySite": {"display": "CHEST"}}
    assert "series" not in studies[1], "a study whose series the PACS does not list stays without them"
    assert source.imaging_studies(patient, with_series=False)[0].get("series") is None
    assert source.imaging_studies({"resourceType": "Patient", "id": "x"}) == [], "no identifier, nothing to ask the PACS"


def test_the_primitive_takes_the_pacs_path_when_a_dicomweb_source_is_configured(pacs):
    manifest = next(yaml.safe_load(Path(f).read_text(encoding="utf-8")) for f in glob.glob(str(MANIFEST_DIR / "dicom-study-review.yaml")))
    item = rm.version_item(manifest, created_by_sub="seed", now="2026-09-17T00:00:00Z", state="published")
    fhir = InMemoryFhirSource.from_file(BUNDLE)
    audit = []
    dicom = dicomweb.DicomWebSource(pacs.base_url)

    class Table:
        def get_item(self, **kwargs):
            return {"Item": item} if kwargs["Key"]["SK"] == rm.version_sk(manifest["metadata"]["version"]) else {}

    def call(dispatcher, config, version=None):
        event = {
            "routeKey": "POST /primitives/{kind}",
            "pathParameters": {"kind": "data.dicom.studies.for_patient"},
            "body": json.dumps({"app_id": manifest["metadata"]["app_id"], "manifest_version": version or manifest["metadata"]["version"], "primitive_id": "p_studies", "role": "radiologist", "config": config, "context": {"patient_id": "pat-kms-0001"}}),
            "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "rad-1", "cognito:groups": "[medapp-admins]"}}}},
        }
        res = handler.handle(event, dispatcher)
        return res["statusCode"], json.loads(res["body"])

    with_pacs = handler.Dispatcher(Table(), fhir, now=datetime(2026, 9, 17, tzinfo=timezone.utc), emit_audit=audit.append, dicom=dicom)
    status, out = call(with_pacs, {"patient": "pat-kms-0001", "modalities": ["CT", "MR", "DX", "US"]})
    assert status == 200, out
    assert [s["identifier"][0]["value"] for s in out["output"]] == ["urn:oid:1.2.276.0.7230010.3.1.2.8323329.1001", "urn:oid:1.2.276.0.7230010.3.1.2.8323329.1002"]
    study_requests = [r for r in pacs.requests if r["path"].endswith("/studies")]
    assert out["output"][0]["numberOfInstances"] == 412 and study_requests[-1]["params"]["PatientID"] == ["KMS-0048213"], "the PACS was asked by MRN"
    assert [x["numberOfInstances"] for x in out["output"][0]["series"]] == [2, 350, 60], "and for each study's series, so the viewer can pick the volume"
    assert audit[-1]["outcome"] == "ok"

    # An app declared for MR only (the modalities are the manifest's; a request narrowing or widening them is refused).
    mr_only = json.loads(json.dumps(manifest))
    mr_only["metadata"]["version"] = "0.1.1"
    next(p for p in mr_only["primitives"] if p["id"] == "p_studies")["config"]["modalities"] = ["MR"]
    mr_item = rm.version_item(mr_only, created_by_sub="seed", now="2026-09-17T00:00:00Z", state="published")

    class Both:
        def get_item(self, **kwargs):
            return {"Item": {rm.version_sk("0.1.1"): mr_item}.get(kwargs["Key"]["SK"], item)} if kwargs["Key"]["SK"] in (rm.version_sk("0.1.1"), rm.version_sk(manifest["metadata"]["version"])) else {}

    status, out = call(handler.Dispatcher(Both(), fhir, now=datetime(2026, 9, 17, tzinfo=timezone.utc), emit_audit=audit.append, dicom=dicom), {"patient": "pat-kms-0001", "modalities": ["MR"]}, version="0.1.1")
    assert status == 200 and out["output"] == []
    status, out = call(with_pacs, {"patient": "pat-kms-0001", "modalities": ["MR"]})
    assert status == 400 and "modalities" in out["message"]

    without = handler.Dispatcher(Table(), fhir, now=datetime(2026, 9, 17, tzinfo=timezone.utc), emit_audit=audit.append)
    status, out = call(without, {"patient": "pat-kms-0001", "modalities": ["CT", "MR", "DX", "US"]})
    assert status == 200 and [s["id"] for s in out["output"]] == ["img-kms-0001", "img-kms-0002"], "no PACS configured: the FHIR record's ImagingStudy resources, as before"


def test_the_imaging_cohort_asks_the_pacs_per_member_without_series(pacs):
    """
    With a PACS configured the cohort's studies come from QIDO, one query per member by MRN and without the per-study
    series calls (a cohort needs counts and the latest study, not the volume to render); without one, the record's
    ImagingStudy resources answer the same question.
    """
    fhir = InMemoryFhirSource.from_file(BUNDLE)
    patients = fhir.search("Patient", {})
    assert len(patients) == 3
    with_pacs = primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc), dicom=dicomweb.DicomWebSource(pacs.base_url))
    before = len(pacs.requests)
    out = primitives.cohort_with_imaging({"patients": patients, "modalities": ["CT"]}, fhir, "p_imaging", with_pacs)
    asked = pacs.requests[before:]
    assert [r["patient"]["name"][0]["family"] for r in out["rows"]] == ["Krüger"], "the fake PACS only knows Anneliese's studies"
    assert out["rows"][0]["latest_study"]["uid"] == "1.2.276.0.7230010.3.1.2.8323329.1001" and out["rows"][0]["latest_study"]["instances"] == 412
    assert sorted(r["params"]["PatientID"][0] for r in asked if r["path"].endswith("/studies")) == sorted(p["identifier"][0]["value"] for p in patients), "one QIDO query per member, by MRN"
    assert not any(r["path"].endswith("/series") for r in asked), "no series calls for a cohort"

    without = primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc))
    out = primitives.cohort_with_imaging({"patients": patients, "modalities": ["CT"]}, fhir, "p_imaging", without)
    assert sorted(r["patient"]["name"][0]["family"] for r in out["rows"]) == ["Krüger", "Yıldız"], "the record's ImagingStudy resources when no PACS is configured"


def test_seed_verifies_the_pacs_has_every_study_of_every_patient(pacs):
    bundle = seeding.load_bundle()
    expected = seeding.expected_dicom_studies(bundle)
    assert expected == {"KMS-0048213": ["1.2.276.0.7230010.3.1.2.8323329.1001", "1.2.276.0.7230010.3.1.2.8323329.1002"], "KMS-0102377": ["1.2.276.0.7230010.3.1.2.8323329.2001"], "KMS-0077501": ["1.2.276.0.7230010.3.1.2.8323329.3001", "1.2.276.0.7230010.3.1.2.8323329.3002"]}
    findings = seeding.verify_dicom(dicomweb.DicomWebSource(pacs.base_url), bundle)
    assert len(findings) == 2, findings  # the fake knows Anneliese's studies only
    assert all("expected" in f and "missing" in f for f in findings) and not any("KMS-0048213" in f for f in findings)


def test_seed_verifies_the_pacs_serves_the_deployed_seed_not_an_earlier_one(pacs):
    # Only Anneliese in this bundle, so the study check passes and the marker check runs: QIDO one instance, WADO-RS its metadata.
    bundle = {"entry": [e for e in seeding.load_bundle()["entry"] if e["resource"].get("id") in ("pat-kms-0001", "img-kms-0001", "img-kms-0002")]}
    source = dicomweb.DicomWebSource(pacs.base_url)
    assert seeding.served_seed_marker(source, "1.2.276.0.7230010.3.1.2.8323329.1001") == MARKER
    metadata_request = next(r for r in pacs.requests if r["path"].endswith("/metadata"))
    assert metadata_request["path"] == "/dicom-web/studies/1.2.276.0.7230010.3.1.2.8323329.1001/series/1.2.276.0.7230010.3.1.2.8323329.1001.1/instances/1.2.276.0.7230010.3.1.2.8323329.1001.1.1/metadata"
    assert seeding.verify_dicom(source, bundle, expected_marker=MARKER) == []
    stale = seeding.verify_dicom(source, bundle, expected_marker="dicom-seed-3 fedcba987654")
    assert len(stale) == 1 and "serves 'dicom-seed-2 0123456789ab'" in stale[0] and "'dicom-seed-3 fedcba987654'" in stale[0] and "earlier seed" in stale[0]
    assert seeding.verify_dicom(source, bundle) == [], "without a marker to expect (an older stack), the study check alone decides"


def test_dicomweb_source_from_env(monkeypatch):
    monkeypatch.delenv("DICOMWEB_BASE_URL", raising=False)
    assert dicomweb.dicomweb_source_from_env() is None
    monkeypatch.setenv("DICOMWEB_BASE_URL", "https://x/dicom-web")
    monkeypatch.setenv("FHIR_AUTH", "sigv4")
    monkeypatch.setenv("AWS_REGION", "eu-central-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    source = dicomweb.dicomweb_source_from_env()
    assert source is not None and source.base_url == "https://x/dicom-web" and source.patient_id_system == dicomweb.DEFAULT_PATIENT_ID_SYSTEM
    assert source._http._signer is not None, "DICOMWEB_AUTH defaults to FHIR_AUTH"  # noqa: SLF001
    monkeypatch.setenv("DICOMWEB_AUTH", "none")
    monkeypatch.setenv("DICOM_PATIENT_ID_SYSTEM", "urn:hospital:mrn")
    plain = dicomweb.dicomweb_source_from_env()
    assert plain._http._signer is None and plain.patient_id_system == "urn:hospital:mrn"  # noqa: SLF001
    monkeypatch.setenv("DICOMWEB_AUTH", "bearer")
    monkeypatch.delenv("FHIR_BEARER_TOKEN", raising=False)
    with pytest.raises(ValueError):
        dicomweb.dicomweb_source_from_env()
