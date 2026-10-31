"""
The dispatcher's clients against a hospital's own servers — read-only, with the OAuth2
client credentials, exactly the code path the deployed dispatcher runs. Skipped unless the endpoint is configured:

    export MEDAPP_HOSPITAL_FHIR_BASE_URL=https://fhir.hospital.example/fhir
    export MEDAPP_HOSPITAL_DICOMWEB_BASE_URL=https://fhir.hospital.example/dicom-web
    export MEDAPP_HOSPITAL_TOKEN_URL=https://auth.hospital.example/oauth2/token
    export MEDAPP_HOSPITAL_SCOPE='fhir/read fhir/write'
    export MEDAPP_HOSPITAL_CLIENT_ID=… MEDAPP_HOSPITAL_CLIENT_SECRET=…        # or MEDAPP_HOSPITAL_CREDENTIALS_SECRET=<Secrets Manager name>
    pytest tests/integration/test_hospital_servers.py -v -s

What it proves: one token serves every request; the capability statement is R4; paging through the gateway works
(a HAPI behind a gateway writes http:// next links and the gateway has no root route — both handled); the searches the primitives
make answer on the hospital's data (observations by LOINC code, conditions, procedures, reports); the patient lookup finds
people by name; QIDO joins studies on the Patient's resource id and the series call answers; and, once the
HospitalServersStack has run, the questionnaire the assessment app needs is on the server. Nothing is written.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))

BASE_URL = os.environ.get("MEDAPP_HOSPITAL_FHIR_BASE_URL")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="MEDAPP_HOSPITAL_FHIR_BASE_URL is not set: no hospital server to test against")

if BASE_URL:
    import dicomweb  # noqa: E402
    import primitives  # noqa: E402
    from fhir_source import HttpFhirSource  # noqa: E402
    from medapp_shared.oauth2 import ClientCredentials, Credentials, credentials_from_secret  # noqa: E402

QUESTIONNAIRE = "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"
SCOPE = {
    "patient_scope": "individual",
    "phi_fields_visible": ["name", "dob", "gender"],
    "fhir": [{"resource": r, "operations": ["read", "search"]} for r in ("Patient", "Observation", "Condition", "Procedure", "DiagnosticReport", "ImagingStudy", "Questionnaire")],
    "dicom": [{"operations": ["qido"], "modalities": ["CT", "MR", "DX", "US"]}],
}


@pytest.fixture(scope="module")
def provider():
    token_url = os.environ["MEDAPP_HOSPITAL_TOKEN_URL"]
    scope = os.environ.get("MEDAPP_HOSPITAL_SCOPE")
    if os.environ.get("MEDAPP_HOSPITAL_CLIENT_ID"):
        credentials = Credentials(os.environ["MEDAPP_HOSPITAL_CLIENT_ID"], os.environ["MEDAPP_HOSPITAL_CLIENT_SECRET"])
    else:
        credentials = credentials_from_secret(os.environ["MEDAPP_HOSPITAL_CREDENTIALS_SECRET"])
    return ClientCredentials(token_url, credentials, scope=scope)


@pytest.fixture(scope="module")
def source(provider):
    return HttpFhirSource(BASE_URL, timeout_s=30.0, token_provider=provider)


@pytest.fixture(scope="module")
def dicom(provider):
    url = os.environ.get("MEDAPP_HOSPITAL_DICOMWEB_BASE_URL")
    if not url:
        pytest.skip("MEDAPP_HOSPITAL_DICOMWEB_BASE_URL is not set")
    return dicomweb.DicomWebSource(url, timeout_s=30.0, token_provider=provider, patient_id_source=os.environ.get("MEDAPP_HOSPITAL_DICOM_PATIENT_ID", "resource_id"))


def test_the_server_is_r4_and_one_token_serves_everything(source, provider):
    statement = source.capability_statement()
    assert statement["fhirVersion"].startswith("4.")
    print(f"\n{statement.get('software', {}).get('name')} {statement.get('software', {}).get('version')} · FHIR {statement['fhirVersion']}")
    patients = source.search("Patient", {"_count": "5"})
    assert patients, "no patients on the server"
    assert provider.fetches == 1, "the token is fetched once and reused"


def test_paging_through_the_gateway(source):
    # Three per page, several pages: the server's next links are rewritten onto the gateway's https address and its root route.
    studies = source.search("ImagingStudy", {"_count": "3"})
    assert len(studies) > 3, f"expected several pages, got {len(studies)}"
    assert source._root_paging_slash in (True, False)  # noqa: SLF001 — learned or not needed; either way we got the pages


def test_the_primitives_searches_answer_on_the_hospitals_data(source, dicom):
    patient = source.search("Patient", {"_count": "1"})[0]
    pid = patient["id"]
    ctx = primitives.ExecutionContext(now=datetime.now(timezone.utc), dicom=dicom)
    started = time.monotonic()
    observations = primitives.execute("data.fhir.observation.by_code", "p", {"patient": pid, "codes": ["http://loinc.org|8867-4", "http://loinc.org|85354-9", "http://loinc.org|62238-1"], "since": "now-10y", "count": 50}, SCOPE, source, ctx=ctx)
    conditions = primitives.execute("data.fhir.query", "p", {"resource": "Condition", "params": {"patient": pid}, "count": 50}, SCOPE, source, ctx=ctx)
    reports = primitives.execute("data.fhir.query", "p", {"resource": "DiagnosticReport", "params": {"patient": pid}, "count": 20}, SCOPE, source, ctx=ctx)
    print(f"\npatient {pid}: {len(observations)} observations (HR/BP/eGFR), {len(conditions)} conditions, {len(reports)} reports in {(time.monotonic() - started) * 1000:.0f} ms")
    assert isinstance(observations, list) and isinstance(conditions, list) and isinstance(reports, list)
    for condition in conditions:
        systems = {c.get("system") for c in (condition.get("code") or {}).get("coding", [])}
        assert "http://fhir.de/CodeSystem/bfarm/icd-10-gm" in systems, "the hospital codes conditions in ICD-10-GM — what the catalog's record notes say"


def test_patients_are_found_by_name_the_way_the_picker_asks(source):
    sample = source.search("Patient", {"_count": "1"})[0]
    family = sample["name"][0]["family"]
    hits = source.search("Patient", {"name": family[:4], "_count": "20"})
    assert any(h["id"] == sample["id"] for h in hits), f"{family[:4]} should find {sample['id']}"


def test_imaging_joins_on_the_patient_resource_id(source, dicom):
    study = source.search("ImagingStudy", {"_count": "1"})[0]
    pid = study["subject"]["reference"].split("/")[1]
    patient = source.read("Patient", pid)
    found = dicom.imaging_studies(patient)
    assert found, f"QIDO found no studies for PatientID={pid}"
    uids = {s["identifier"][0]["value"] for s in found}
    assert study["identifier"][0]["value"] in uids, "the FHIR ImagingStudy and the PACS agree on the study"
    with_series = [s for s in found if s.get("series")]
    assert with_series, "the series call answered"
    print(f"\n{len(found)} studies for {pid}; first: {found[0].get('description')} {[m['code'] for m in found[0].get('modality', [])]} {found[0].get('numberOfInstances')} instances")


def test_the_assessment_questionnaire_is_on_the_server_once_the_stack_has_run(source):
    found = source.search("Questionnaire", {"url": QUESTIONNAIRE})
    if not found:
        pytest.skip("the HospitalServersStack has not seeded the definitions yet (cdk deploy HospitalServersStack)")
    assert found[0]["url"] == QUESTIONNAIRE
