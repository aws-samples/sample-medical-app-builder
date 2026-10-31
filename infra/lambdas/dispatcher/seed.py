"""
Seeding the reference FHIR server with the synthetic record — the same bundle the in-memory source serves.

`to_transaction()` turns the collection bundle into a FHIR transaction of `PUT <type>/<id>` entries, so the ids
every test, manifest and screenshot refers to (`pat-kms-0001`, `cond-kms-0003`, …) are the ids on the server
too, and re-running it is a reset rather than a duplicate: a PUT with unchanged content is a no-op on HAPI, a
record changed by a demo goes back to its seeded state as a new version (the history of the demo stays).

The same code runs in two places: `scripts/seed-reference.py` from a laptop (signed with your credentials), and
the reference stack's custom resource once the server is stable — on create, and again whenever the seed's hash
changes. `verify()` then asks the server the questions the primitives will ask, so a server that indexes
differently from the in-memory source is found at deploy time, not in a demo.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))  # `fhir_source` when imported from scripts/ or the custom resource

from fhir_source import HttpFhirSource, UpstreamError, http_source_from_env  # noqa: E402

DEFAULT_BUNDLE = Path(__file__).resolve().parent / "data" / "synthetic-musterstadt.bundle.json"

# Questions the primitives ask of the record, with the answers the seeded data must give. Each is (label,
# resource type, search parameters, minimum number of results). Zero where at least one is expected means the
# server does not index that parameter the way the in-memory source does — the very thing a reference server exists to reveal.
VERIFICATIONS: list[tuple[str, str, dict[str, str], int]] = [
    ("blood pressure by combo-code (panel found through a component code)", "Observation", {"patient": "pat-kms-0001", "combo-code": "http://loinc.org|8480-6", "_count": "5"}, 1),
    ("readings in a window, newest first", "Observation", {"patient": "pat-kms-0001", "combo-code": "http://loinc.org|85354-9", "date": "ge2020-01-01", "_sort": "-date", "_count": "5"}, 1),
    ("active problems", "Condition", {"patient": "pat-kms-0001", "clinical-status": "active", "_sort": "-recorded-date"}, 1),
    ("hypertension cohort by condition code", "Condition", {"code": "http://snomed.info/sct|38341003", "clinical-status": "active"}, 1),
    ("active medication", "MedicationRequest", {"patient": "pat-kms-0001", "status": "active", "_sort": "-authoredon"}, 1),
    ("questionnaire by canonical url", "Questionnaire", {"url": "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"}, 1),
    ("earlier assessments by questionnaire canonical", "QuestionnaireResponse", {"patient": "pat-kms-0001", "questionnaire": "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"}, 1),
    ("imaging studies", "ImagingStudy", {"patient": "pat-kms-0001", "_sort": "-started"}, 1),
    ("allergies (patient parameter)", "AllergyIntolerance", {"patient": "pat-kms-0001", "clinical-status": "active"}, 1),
    ("radiology reports by category", "DiagnosticReport", {"patient": "pat-kms-0001", "category": "RAD"}, 1),
    ("visits", "Encounter", {"patient": "pat-kms-0001", "_sort": "-date"}, 1),
    ("notes", "DocumentReference", {"patient": "pat-kms-0001", "_sort": "-date"}, 1),
    ("procedures", "Procedure", {"patient": "pat-kms-0001", "_sort": "-date"}, 1),
    ("immunizations", "Immunization", {"patient": "pat-kms-0001", "_sort": "-date"}, 1),
]


@dataclass
class SeedReport:
    total: int = 0
    created: int = 0
    updated: int = 0
    failed: list[str] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"total": self.total, "created": self.created, "updated": self.updated, "failed": self.failed, "findings": self.findings}

    @property
    def ok(self) -> bool:
        return not self.failed and not self.findings


def load_bundle(path: str | Path | None = None) -> dict[str, Any]:
    with open(path or DEFAULT_BUNDLE, encoding="utf-8") as f:
        return json.load(f)


def seed_hash(bundle: dict[str, Any]) -> str:
    """Content hash of the seed: the custom resource re-runs when it changes."""
    return hashlib.sha256(json.dumps(bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def to_transaction(bundle: dict[str, Any]) -> dict[str, Any]:
    """A collection of resources with ids → one transaction of PUTs (update-as-create keeps the ids)."""
    entries = []
    for entry in bundle.get("entry", []):
        resource = entry.get("resource") or {}
        rt, rid = resource.get("resourceType"), resource.get("id")
        if not rt or not rid:
            continue
        entries.append({"fullUrl": f"{rt}/{rid}", "resource": resource, "request": {"method": "PUT", "url": f"{rt}/{rid}"}})
    return {"resourceType": "Bundle", "type": "transaction", "entry": entries}


def apply(source: HttpFhirSource, bundle: dict[str, Any]) -> SeedReport:
    """Load the bundle as one transaction; the report counts created vs. updated (or unchanged) resources."""
    transaction = to_transaction(bundle)
    report = SeedReport(total=len(transaction["entry"]))
    response = source.transaction(transaction)
    for sent, got in zip(transaction["entry"], response.get("entry") or []):
        status = str((got.get("response") or {}).get("status") or "")
        if status.startswith("201"):
            report.created += 1
        elif status.startswith("200"):
            report.updated += 1
        else:
            report.failed.append(f"{sent['request']['url']}: {status or 'no response entry'}")
    if not response.get("entry"):
        report.failed.append("the server returned no response entries")
    return report


def verify(source: HttpFhirSource) -> list[str]:
    """What a primitive would find on this server; one line per question the seeded data fails to answer."""
    findings: list[str] = []
    patient = source.read("Patient", "pat-kms-0001")
    if not patient:
        findings.append("Patient/pat-kms-0001 is not readable by id")
    for label, resource_type, params, minimum in VERIFICATIONS:
        try:
            found = source.search(resource_type, params)
        except UpstreamError as err:
            findings.append(f"{label}: the server refused the search ({err})")
            continue
        if len(found) < minimum:
            findings.append(f"{label}: expected at least {minimum} {resource_type}, found {len(found)}")
    return findings


def expected_dicom_studies(bundle: dict[str, Any], patient_id_system: str = "https://klinikum-musterstadt.example/fhir/sid/mrn") -> dict[str, list[str]]:
    """MRN → StudyInstanceUIDs the PACS must return for that patient: the bundle's ImagingStudy resources, by subject."""
    mrn_of: dict[str, str] = {}
    for entry in bundle.get("entry", []):
        r = entry.get("resource") or {}
        if r.get("resourceType") == "Patient":
            idents = r.get("identifier") or []
            mrn = next((i.get("value") for i in idents if i.get("system") == patient_id_system), None) or next((i.get("value") for i in idents if i.get("value")), None)
            if mrn:
                mrn_of[r["id"]] = str(mrn)
    expected: dict[str, list[str]] = {}
    for entry in bundle.get("entry", []):
        r = entry.get("resource") or {}
        if r.get("resourceType") != "ImagingStudy":
            continue
        patient_id = str((r.get("subject") or {}).get("reference", "")).removeprefix("Patient/")
        uid = next((str(i["value"])[len("urn:oid:") :] for i in r.get("identifier") or [] if i.get("system") == "urn:dicom:uid" and str(i.get("value", "")).startswith("urn:oid:")), None)
        if patient_id in mrn_of and uid:
            expected.setdefault(mrn_of[patient_id], []).append(uid)
    return expected


def served_seed_marker(dicom: Any, study_uid: str) -> str | None:
    """
    Which seed the PACS serves: the SoftwareVersions the generator wrote into every instance, read back through
    QIDO-RS (one instance of the study) and WADO-RS metadata (that instance's dataset). None when the study has no
    instances yet or the tag is absent.
    """
    from dicomweb import TAG_SERIES_UID, TAG_SOFTWARE_VERSIONS, TAG_SOP_UID, value

    instances = dicom.instances(study_uid, limit=1)
    if not instances:
        return None
    series_uid, sop_uid = value(instances[0], TAG_SERIES_UID), value(instances[0], TAG_SOP_UID)
    if not series_uid or not sop_uid:
        return None
    metadata = dicom.metadata(study_uid, str(series_uid), str(sop_uid))
    if not metadata:
        return None
    marker = value(metadata[0], TAG_SOFTWARE_VERSIONS)
    return str(marker) if marker else None


def verify_dicom(dicom: Any, bundle: dict[str, Any] | None = None, wait_s: float = 0, poll_s: float = 10, expected_marker: str | None = None) -> list[str]:
    """
    The PACS answers QIDO-RS by MRN with every study the record declares for that patient, and — when the
    deployment says which seed it shipped (`expected_marker`) — the instances it serves are from that seed, not
    from an earlier one a task kept after the bucket changed. `wait_s` lets a freshly started server finish
    indexing its seed (the Indexer plugin scans every few seconds).
    """
    from dicomweb import TAG_STUDY_UID, value

    expected = expected_dicom_studies(bundle or load_bundle(), getattr(dicom, "patient_id_system", "https://klinikum-musterstadt.example/fhir/sid/mrn"))
    deadline = time.monotonic() + wait_s
    while True:
        findings: list[str] = []
        for mrn, uids in expected.items():
            try:
                found = {str(value(s, TAG_STUDY_UID) or "") for s in dicom.studies(mrn)}
            except UpstreamError as err:
                findings.append(f"studies of {mrn}: the DICOMweb server refused the query ({err})")
                continue
            missing = [u for u in uids if u not in found]
            if missing:
                findings.append(f"studies of {mrn}: expected {len(uids)}, found {len(found & set(uids))} — missing {', '.join(missing)}")
        if not findings and expected_marker:
            first_uid = next((uids[0] for uids in expected.values() if uids), None)
            try:
                served = served_seed_marker(dicom, first_uid) if first_uid else None
            except UpstreamError as err:
                served = None
                findings.append(f"seed marker: the DICOMweb server refused the request ({err})")
            if served != expected_marker and not findings:
                findings.append(f"seed marker: the PACS serves '{served or 'no marker'}' but this deployment's seed is '{expected_marker}' — the Orthanc task is still on an earlier seed (it copies the seed only at start)")
        if not findings or time.monotonic() >= deadline:
            return findings
        time.sleep(poll_s)


def seed(source: HttpFhirSource, bundle: dict[str, Any] | None = None, check: bool = True, dicom: Any = None, dicom_wait_s: float = 0, dicom_marker: str | None = None) -> SeedReport:
    bundle = bundle or load_bundle()
    report = apply(source, bundle)
    if check:
        report.findings = verify(source)
        if dicom is not None:
            report.findings += verify_dicom(dicom, bundle, wait_s=dicom_wait_s, expected_marker=dicom_marker)
    return report


# ── The hospital's own server: definitions only ──────────────────────────────────────────────────────────

# What the platform may write into a hospital's server without anyone's say-so: the definitions its apps need —
# the questionnaires behind the assessment apps — never patients or their records. Those are the hospital's.
DEFINITION_TYPES = ("Questionnaire", "ValueSet", "CodeSystem")


def definitions(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    return [e["resource"] for e in bundle.get("entry", []) if (e.get("resource") or {}).get("resourceType") in DEFINITION_TYPES and e["resource"].get("id")]


def write_definitions(source: HttpFhirSource, resources: list[dict[str, Any]]) -> SeedReport:
    """
    An app's own definitions — the Questionnaires behind its forms — PUT by id when the app is published (the registry
    write API invokes this with `task: definitions`). Only definition types are written, whatever the caller sent; each
    is then looked up by its canonical URL so a form that did not land is a finding, not a silent gap.
    """
    items = [r for r in resources if isinstance(r, dict) and r.get("resourceType") in DEFINITION_TYPES and r.get("id")]
    report = SeedReport(total=len(items))
    skipped = len(resources) - len(items)
    if skipped:
        report.findings.append(f"{skipped} resource(s) were not definitions and were not written")
    for resource in items:
        label = f"{resource['resourceType']}/{resource['id']}"
        try:
            before = source.read(resource["resourceType"], resource["id"])
        except (UpstreamError, LookupError):
            before = None
        try:
            source.update(resource)
        except UpstreamError as err:
            report.failed.append(f"{label}: {err}")
            continue
        if before is None:
            report.created += 1
        else:
            report.updated += 1
        if resource["resourceType"] == "Questionnaire" and resource.get("url"):
            try:
                if not source.search("Questionnaire", {"url": resource["url"]}):
                    report.findings.append(f"questionnaire {resource['url']}: not found by canonical url after writing it")
            except UpstreamError as err:
                report.findings.append(f"questionnaire {resource['url']}: the server refused the search ({err})")
    return report


def seed_definitions(source: HttpFhirSource, bundle: dict[str, Any] | None = None, dicom: Any = None) -> SeedReport:
    """
    PUT each definition by its id (an unchanged one is a no-op, a changed one a new version), then verify what the
    deployment relies on: each questionnaire is findable by its canonical URL, the server answers the capability
    statement, there are patients to open apps for, and — with a PACS — QIDO answers. Nothing else is written.
    """
    bundle = bundle or load_bundle()
    items = definitions(bundle)
    report = SeedReport(total=len(items))
    for resource in items:
        label = f"{resource['resourceType']}/{resource['id']}"
        try:
            before = source.read(resource["resourceType"], resource["id"])
        except (UpstreamError, LookupError):
            before = None
        try:
            source.update(resource)
        except UpstreamError as err:
            report.failed.append(f"{label}: {err}")
            continue
        if before is None:
            report.created += 1
        else:
            report.updated += 1
    for resource in items:
        if resource["resourceType"] == "Questionnaire" and resource.get("url"):
            try:
                found = source.search("Questionnaire", {"url": resource["url"]})
            except UpstreamError as err:
                report.findings.append(f"questionnaire {resource['url']}: the server refused the search ({err})")
                continue
            if not found:
                report.findings.append(f"questionnaire {resource['url']}: not found by canonical url after writing it")
    try:
        statement = source.capability_statement()
        software = (statement.get("software") or {}).get("name") or "unknown software"
        if statement.get("fhirVersion", "4.0").split(".")[0] != "4":
            report.findings.append(f"the server speaks FHIR {statement.get('fhirVersion')}, the platform R4")
        print(json.dumps({"hospital_server": {"software": software, "version": (statement.get("software") or {}).get("version"), "fhirVersion": statement.get("fhirVersion")}}))
    except UpstreamError as err:
        report.findings.append(f"capability statement: {err}")
    try:
        patients = source.search("Patient", {"_count": "1"})
        if not patients:
            report.findings.append("the server has no Patient resources: apps open on a patient and would find none")
    except UpstreamError as err:
        report.findings.append(f"patient search: {err}")
    if dicom is not None:
        try:
            dicom.studies("medapp-connectivity-check")  # 204 is a fine answer; a refusal is a finding
        except UpstreamError as err:
            report.findings.append(f"DICOMweb: {err}")
    return report


# ── The record vocabulary: which codes the server holds, for the drafting assistant ─────────────────────


def refresh_vocabulary(source: HttpFhirSource, budget_s: float | None = None, s3_client: Any = None) -> str | None:
    """
    Read the record's distinct codes and store them where the drafting agent reads them (`RECORD_VOCABULARY_BUCKET`,
    set by the stack that owns the data source). Returns a one-line summary, or None when no bucket is configured.
    A failure here is a finding, never a failed deployment: the apps work without the vocabulary, the assistant
    merely falls back to its hand-written hints.
    """
    bucket = os.environ.get("RECORD_VOCABULARY_BUCKET")
    if not bucket:
        return None
    from vocabulary import DEFAULT_BUDGET_S, DEFAULT_KEY, build_vocabulary, store_vocabulary, summarize

    key = os.environ.get("RECORD_VOCABULARY_KEY") or DEFAULT_KEY
    try:
        doc = build_vocabulary(source, budget_s=budget_s if budget_s is not None else float(os.environ.get("VOCABULARY_BUDGET_S") or DEFAULT_BUDGET_S))
        uri = store_vocabulary(doc, bucket, key, client=s3_client)
    except Exception as err:  # noqa: BLE001 — reported, not raised: see the docstring
        line = f"record vocabulary: not refreshed ({type(err).__name__}: {str(err)[:200]})"
        print(json.dumps({"vocabulary": line}))
        return line
    line = f"record vocabulary: {summarize(doc)} → {uri}"
    print(json.dumps({"vocabulary": {"summary": summarize(doc), "uri": uri, "duration_s": doc.get("duration_s"), "complete": doc.get("complete")}}))
    return line


# ── CloudFormation custom resource (the provider framework's onEvent handler) ────────────────────────────


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("task") == "definitions":
        # The registry write API, at publish: an app's own forms into the record. Asynchronous; the report is the log.
        source = http_source_from_env(os.environ["FHIR_BASE_URL"])
        report = write_definitions(source, list(event.get("resources") or []))
        print(json.dumps({"definitions": {"app_id": event.get("app_id"), "version": event.get("version"), **report.as_dict()}}, default=str))
        return {"definitions": report.as_dict()}
    if event.get("task") == "vocabulary":
        # Not CloudFormation: the nightly schedule (or a hand invoke) asking for the vocabulary alone.
        source = http_source_from_env(os.environ["FHIR_BASE_URL"])
        budget = event.get("budget_s")
        return {"vocabulary": refresh_vocabulary(source, budget_s=float(budget) if budget is not None else None) or "no RECORD_VOCABULARY_BUCKET configured"}
    request_type = event.get("RequestType")
    physical_id = event.get("PhysicalResourceId") or f"medapp-reference-seed-{os.environ.get('HOSPITAL_ID', 'hospital')}"
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_id}
    from dicomweb import dicomweb_source_from_env

    source = http_source_from_env(os.environ["FHIR_BASE_URL"])
    if (os.environ.get("SEED_MODE") or "full") == "definitions":
        # A hospital's server: only the definitions the apps need are written; the record is theirs.
        report = seed_definitions(source, dicom=dicomweb_source_from_env())
    else:
        # The PACS indexes its seed after starting; give it up to two minutes before calling a study missing. The
        # stack says which seed it shipped (`dicom_seed_marker`); the PACS must be serving that one.
        marker = (event.get("ResourceProperties") or {}).get("dicom_seed_marker") or None
        report = seed(source, dicom=dicomweb_source_from_env(), dicom_wait_s=float(os.environ.get("DICOM_VERIFY_WAIT_S") or 120), dicom_marker=marker)
    print(json.dumps({"seed": report.as_dict()}, default=str))
    if report.failed:
        raise RuntimeError("seeding failed for: " + "; ".join(report.failed[:10]))
    # The record is in place: read its vocabulary for the drafting assistant (a finding either way, never a failure).
    vocabulary = refresh_vocabulary(source)
    if vocabulary:
        report.findings.append(vocabulary)
    # Findings do not fail the deployment: the stack is up, the data is there, and the finding is the point.
    data = {"total": str(report.total), "created": str(report.created), "updated": str(report.updated), "findings": "; ".join(report.findings) or "none"}
    return {"PhysicalResourceId": physical_id, "Data": data}
