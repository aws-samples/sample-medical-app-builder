"""
Where imaging comes from: a DICOMweb endpoint (QIDO-RS) — the reference Orthanc behind the IAM-authorised API,
later the hospital's PACS gateway. The primitive `data.dicom.studies.for_patient` asks it for the studies of the
patient in context and hands the renderer the same `ImagingStudy` shape the FHIR record uses, so manifests,
components and the OHIF hand-off do not know which source answered.

The join is whatever the hospital's PACS was fed as PatientID. Usually the MRN: the dispatcher reads the FHIR
Patient, takes the identifier of the configured system (`DICOM_PATIENT_ID_SYSTEM`) and queries
`studies?PatientID=<mrn>`. Some gateways key studies by the FHIR Patient's resource id instead —
`DICOM_PATIENT_ID_SOURCE=resource_id` joins on that. Authentication is the FHIR client's (`DICOMWEB_AUTH`: sigv4 |
oauth2 | bearer | none, defaulting to FHIR_AUTH; oauth2 shares the FHIR client's token). Without `DICOMWEB_BASE_URL`
the primitive keeps reading `ImagingStudy` resources from the FHIR source (bundle mode).
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
from typing import Any, Callable

from fhir_source import RequestSigner, Resource, UpstreamError, operation_outcome_text

DCM = "http://dicom.nema.org/resources/ontology/DCM"
DEFAULT_PATIENT_ID_SYSTEM = "https://klinikum-musterstadt.example/fhir/sid/mrn"
PATIENT_ID_SOURCES = ("identifier", "resource_id")  # what the PACS holds as PatientID: an identifier of the Patient, or its FHIR id

# DICOM attribute tags (group+element, hexadecimal as DICOM JSON keys them).
TAG_STUDY_UID = "0020000D"
TAG_STUDY_DATE = "00080020"
TAG_STUDY_TIME = "00080030"
TAG_TZ_OFFSET = "00080201"
TAG_ACCESSION = "00080050"
TAG_MODALITIES = "00080061"
TAG_DESCRIPTION = "00081030"
TAG_REFERRER = "00080090"
TAG_PATIENT_NAME = "00100010"
TAG_PATIENT_ID = "00100020"
TAG_N_SERIES = "00201206"
TAG_N_INSTANCES = "00201208"
TAG_STUDY_ID = "00200010"
TAG_SERIES_UID = "0020000E"
TAG_SERIES_NUMBER = "00200011"
TAG_MODALITY = "00080060"
TAG_SERIES_DESCRIPTION = "0008103E"
TAG_N_SERIES_INSTANCES = "00201209"
TAG_BODY_PART = "00180015"
TAG_SOP_UID = "00080018"
TAG_SOFTWARE_VERSIONS = "00181020"
INCLUDE_FIELDS = ("StudyDescription", "ModalitiesInStudy", "NumberOfStudyRelatedSeries", "NumberOfStudyRelatedInstances", "TimezoneOffsetFromUTC", "ReferringPhysicianName")


def value(attributes: dict[str, Any], tag: str) -> Any:
    """First value of a DICOM JSON attribute, or None (absent, or present without Value)."""
    entry = attributes.get(tag)
    if not isinstance(entry, dict):
        return None
    values = entry.get("Value")
    if not values:
        return None
    first = values[0]
    if isinstance(first, dict):  # PN: {"Alphabetic": "Krüger^Anneliese"}
        return first.get("Alphabetic") or first.get("Ideographic") or first.get("Phonetic")
    return first


def values(attributes: dict[str, Any], tag: str) -> list[Any]:
    entry = attributes.get(tag)
    return list(entry.get("Value") or []) if isinstance(entry, dict) else []


def dicom_datetime(date: str | None, time: str | None, offset: str | None) -> str | None:
    """DA + TM (+ TimezoneOffsetFromUTC) → ISO 8601 with the zone the PACS recorded, or a date alone."""
    if not date or len(date) < 8 or not date[:8].isdigit():
        return None
    iso = f"{date[:4]}-{date[4:6]}-{date[6:8]}"
    if not time:
        return iso
    digits = time.split(".")[0].ljust(6, "0")
    if len(digits) < 6 or not digits[:6].isdigit():
        return iso
    iso = f"{iso}T{digits[:2]}:{digits[2:4]}:{digits[4:6]}"
    if offset and len(offset) == 5 and offset[0] in "+-" and offset[1:].isdigit():
        iso = f"{iso}{offset[:3]}:{offset[3:]}"
    return iso


def person_name(pn: str | None) -> str | None:
    """`Hoffmann^Lukas^^Dr. med.` → `Dr. med. Lukas Hoffmann` (the display form a FHIR reference carries)."""
    if not pn:
        return None
    parts = str(pn).split("^")
    family, given = parts[0], parts[1] if len(parts) > 1 else ""
    prefix = parts[3] if len(parts) > 3 else ""
    return " ".join(p for p in (prefix, given, family) if p) or None


def study_resource_id(study_uid: str) -> str:
    """A stable FHIR id (≤ 64 chars) for a study the PACS knows by UID."""
    return "dicom-" + hashlib.sha256(study_uid.encode("utf-8")).hexdigest()[:24]


def imaging_study_from_qido(attributes: dict[str, Any], patient_id: str, patient_display: str | None = None) -> Resource:
    """One QIDO-RS study result → the `ImagingStudy` the renderer already consumes (identifier urn:oid:<uid>)."""
    uid = str(value(attributes, TAG_STUDY_UID) or "")
    if not uid:
        raise ValueError("QIDO study without StudyInstanceUID")
    modalities = [str(m) for m in values(attributes, TAG_MODALITIES) if m]
    study: Resource = {
        "resourceType": "ImagingStudy",
        "id": study_resource_id(uid),
        "identifier": [{"system": "urn:dicom:uid", "value": f"urn:oid:{uid}"}],
        "status": "available",
        "subject": {"reference": f"Patient/{patient_id}", **({"display": patient_display} if patient_display else {})},
    }
    if modalities:
        study["modality"] = [{"system": DCM, "code": m} for m in modalities]
    started = dicom_datetime(value(attributes, TAG_STUDY_DATE), value(attributes, TAG_STUDY_TIME), value(attributes, TAG_TZ_OFFSET))
    if started:
        study["started"] = started
    n_series, n_instances = value(attributes, TAG_N_SERIES), value(attributes, TAG_N_INSTANCES)
    if n_series is not None:
        study["numberOfSeries"] = int(n_series)
    if n_instances is not None:
        study["numberOfInstances"] = int(n_instances)
    description = value(attributes, TAG_DESCRIPTION)
    if description:
        study["description"] = str(description)
    accession = value(attributes, TAG_ACCESSION)
    if accession:
        study["identifier"].append({"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "ACSN"}]}, "value": str(accession)})
    referrer = person_name(value(attributes, TAG_REFERRER))
    if referrer:
        study["referrer"] = {"display": referrer}
    return study


def series_from_qido(attributes: dict[str, Any]) -> dict[str, Any]:
    """One QIDO-RS series result → an `ImagingStudy.series` entry (uid, number, modality, description, instance count)."""
    entry: dict[str, Any] = {"uid": str(value(attributes, TAG_SERIES_UID) or "")}
    number = value(attributes, TAG_SERIES_NUMBER)
    if number is not None:
        entry["number"] = int(number)
    modality = value(attributes, TAG_MODALITY)
    if modality:
        entry["modality"] = {"system": DCM, "code": str(modality)}
    description = value(attributes, TAG_SERIES_DESCRIPTION)
    if description:
        entry["description"] = str(description)
    count = value(attributes, TAG_N_SERIES_INSTANCES)
    if count is not None:
        entry["numberOfInstances"] = int(count)
    body_part = value(attributes, TAG_BODY_PART)
    if body_part:
        entry["bodySite"] = {"display": str(body_part)}
    return entry


def patient_dicom_id(patient: Resource, system: str, source: str = "identifier") -> str | None:
    """
    What the PACS knows the patient by. `resource_id`: the FHIR Patient's id. `identifier` (the usual MRN join): the
    identifier of the configured system, else one typed MR/MRN, else the first.
    """
    if source == "resource_id":
        return str(patient.get("id")) if patient.get("id") else None
    identifiers = [i for i in (patient.get("identifier") or []) if isinstance(i, dict) and i.get("value")]
    for ident in identifiers:
        if ident.get("system") == system:
            return str(ident["value"])
    for ident in identifiers:
        type_ = ident.get("type") or {}
        codes = {c.get("code") for c in type_.get("coding") or []}
        if "MR" in codes or str(type_.get("text") or "").upper() == "MRN":
            return str(ident["value"])
    return str(identifiers[0]["value"]) if identifiers else None


class DicomWebSource:
    """QIDO-RS client over the FHIR client's HTTP machinery: same signer, same TLS trust, same error typing."""

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout_s: float = 8.0,
        signer: RequestSigner | None = None,
        ca_bundle: str | None = None,
        patient_id_system: str = DEFAULT_PATIENT_ID_SYSTEM,
        token_provider: Callable[[], str] | None = None,
        patient_id_source: str = "identifier",
    ):
        from fhir_source import HttpFhirSource

        if patient_id_source not in PATIENT_ID_SOURCES:
            raise ValueError(f"patient_id_source must be one of {PATIENT_ID_SOURCES}, not {patient_id_source!r}")
        self._http = HttpFhirSource(base_url, token=token, timeout_s=timeout_s, signer=signer, ca_bundle=ca_bundle, token_provider=token_provider)
        self._base = base_url.rstrip("/")
        self.patient_id_system = patient_id_system
        self.patient_id_source = patient_id_source

    @property
    def base_url(self) -> str:
        return self._base

    def _qido(self, path: str, params: dict[str, str], include: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        """
        One QIDO-RS search; `include` are repeated `includefield` parameters (attributes beyond the required set).
        The query is built from pairs, never by concatenation: an empty pair (`?&includefield=…`) is signed by
        SigV4 as `=&…` while the API's own canonicalisation drops it — a 403 that only shows up on AWS.
        """
        pairs = [*params.items(), *(("includefield", f) for f in include)]
        query = urllib.parse.urlencode(pairs, quote_via=urllib.parse.quote)
        url = f"{self._base}/{path}" + (f"?{query}" if query else "")
        try:
            status, raw, _ = self._http._send("GET", url, {"accept": "application/dicom+json"})  # noqa: SLF001 — one transport, two protocols
        except urllib.error.HTTPError as err:
            text = operation_outcome_text(err.read())
            raise UpstreamError(err.code, f"DICOMweb server answered {err.code}" + (f": {text}" if text else ""), "GET", url) from err
        if status == 204 or not raw:
            return []  # QIDO-RS: no matches
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []

    def studies(self, dicom_patient_id: str, modalities: list[str] | None = None) -> list[dict[str, Any]]:
        """QIDO-RS study search for one PatientID; modalities are filtered here (multi-valued matching varies by server)."""
        found = self._qido("studies", {"PatientID": dicom_patient_id, "limit": "200"}, include=INCLUDE_FIELDS)
        if modalities:
            wanted = set(modalities)
            found = [s for s in found if wanted & {str(m) for m in values(s, TAG_MODALITIES)}]
        return found

    def series(self, study_uid: str) -> list[dict[str, Any]]:
        """QIDO-RS series of one study (what a viewer reconstructs from: which series is the volume)."""
        return self._qido(f"studies/{urllib.parse.quote(study_uid)}/series", {}, include=("SeriesDescription", "NumberOfSeriesRelatedInstances", "BodyPartExamined"))

    def instances(self, study_uid: str, limit: int = 1) -> list[dict[str, Any]]:
        """QIDO-RS instances of one study (SOPInstanceUID and SeriesInstanceUID come with every result)."""
        return self._qido(f"studies/{urllib.parse.quote(study_uid)}/instances", {"limit": str(limit)})

    def metadata(self, study_uid: str, series_uid: str, sop_uid: str) -> list[dict[str, Any]]:
        """WADO-RS metadata of one instance: the full DICOM JSON dataset, read from the file the PACS serves."""
        return self._qido(f"studies/{urllib.parse.quote(study_uid)}/series/{urllib.parse.quote(series_uid)}/instances/{urllib.parse.quote(sop_uid)}/metadata", {})

    def imaging_studies(self, patient: Resource, modalities: list[str] | None = None, with_series: bool = True) -> list[Resource]:
        """
        The patient's studies from the PACS as ImagingStudy resources, newest first; none when the patient has no
        MRN. With `with_series`, each study carries its series (one more QIDO call per study) so the viewer can pick
        the acquisition volume for MPR and 3-D rather than reconstruct the first series it finds.
        """
        dicom_id = patient_dicom_id(patient, self.patient_id_system, self.patient_id_source)
        if not dicom_id:
            return []
        display = None
        for name in patient.get("name") or []:
            given = " ".join(name.get("given") or [])
            display = " ".join(p for p in (given, name.get("family")) if p) or None
            if display:
                break
        studies = [imaging_study_from_qido(s, str(patient.get("id") or ""), display) for s in self.studies(dicom_id, modalities)]
        if with_series:
            for study in studies:
                uid = study["identifier"][0]["value"][len("urn:oid:") :]
                series = [series_from_qido(s) for s in self.series(uid)]
                series = [s for s in series if s["uid"]]
                if series:
                    study["series"] = sorted(series, key=lambda s: s.get("number", 0))
                    study.setdefault("numberOfSeries", len(series))
        return sorted(studies, key=lambda s: s.get("started") or "", reverse=True)


def dicomweb_source_from_env() -> DicomWebSource | None:
    """DICOMWEB_BASE_URL (+ DICOMWEB_AUTH, defaulting to FHIR_AUTH; DICOM_PATIENT_ID_SYSTEM / DICOM_PATIENT_ID_SOURCE) → a source, or None."""
    base_url = os.environ.get("DICOMWEB_BASE_URL")
    if not base_url:
        return None
    auth = (os.environ.get("DICOMWEB_AUTH") or os.environ.get("FHIR_AUTH") or "none").lower()
    timeout = float(os.environ.get("DICOMWEB_TIMEOUT_S") or os.environ.get("FHIR_TIMEOUT_S") or 8.0)
    system = os.environ.get("DICOM_PATIENT_ID_SYSTEM") or DEFAULT_PATIENT_ID_SYSTEM
    source = os.environ.get("DICOM_PATIENT_ID_SOURCE") or "identifier"
    ca_bundle = os.environ.get("FHIR_CA_BUNDLE") or None
    common = {"timeout_s": timeout, "ca_bundle": ca_bundle, "patient_id_system": system, "patient_id_source": source}
    if auth == "sigv4":
        from medapp_shared.sigv4 import SigV4Signer

        return DicomWebSource(base_url, signer=SigV4Signer(service=os.environ.get("FHIR_SIGV4_SERVICE") or "execute-api"), **common)
    if auth == "oauth2":
        from medapp_shared.oauth2 import shared_client_credentials

        return DicomWebSource(base_url, token_provider=shared_client_credentials("FHIR_"), **common)  # the FHIR client's token endpoint and credentials
    if auth == "bearer":
        token = os.environ.get("DICOMWEB_BEARER_TOKEN") or os.environ.get("FHIR_BEARER_TOKEN")
        if not token:
            raise ValueError("DICOMWEB_AUTH=bearer needs DICOMWEB_BEARER_TOKEN (or FHIR_BEARER_TOKEN)")
        return DicomWebSource(base_url, token=token, **common)
    if auth == "none":
        return DicomWebSource(base_url, **common)
    raise ValueError(f"DICOMWEB_AUTH must be sigv4, oauth2, bearer or none, not {auth!r}")
