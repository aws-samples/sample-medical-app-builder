"""
Data primitive catalog v0 — server-side implementations and their scope requirements.

This is the authoritative behaviour; med_app/src/primitives/data/mock/mockExecutor.ts mirrors it
for local development and its tests assert the same numbers. Keep the two in step.

Every primitive takes the already-resolved `config` (all $references replaced by the frontend) and
returns exactly the shape the design-system components are typed against.

`data.*` primitives read; `write.*` primitives change the record and run only through a manifest
action. A write validates its payload, then stamps provenance from the verified caller (never from
the payload) before handing the resource to the FhirSource.
"""

from __future__ import annotations

import copy
import json

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from fhir_source import FhirSource, Resource, component_quantity, concept_matches, is_class_code, newest_first, patient_id_of, resource_date, subject_is
from questionnaire import extract_answers, validate_questionnaire_response
from media_store import MediaStore, present_media
from record_shape import apply_stamps, validate_record_entry
from writes import validate_allergy_entry, validate_condition_entry, validate_media_entry, validate_observation_entry, validate_procedure_entry, validate_status_change, validate_task_entry

# The kinds of record, written by the panel's `npm run export:kinds` from the rule in med_app/src/fhir/kinds.ts: the
# kinds the platform admits, the kinds it opens to administrators' shapes (every patient-scoped R4 type it does not
# refuse), the refused kinds with their reasons, and the query allow-list (the platform's own types plus the open kinds,
# written through shapes and read back with the generic query). The frontend test suite fails when the file lags the rule.
_KINDS_PATH = Path(__file__).resolve().parent / "data" / "record-kinds.json"
with _KINDS_PATH.open(encoding="utf-8") as _f:
    RECORD_KINDS: dict[str, Any] = json.load(_f)
QUERY_RESOURCES: tuple[str, ...] = tuple(RECORD_KINDS["query_resources"])
ADMITTED_KINDS: tuple[str, ...] = tuple(RECORD_KINDS["admitted"])
OPEN_KINDS: tuple[str, ...] = tuple(RECORD_KINDS["open"])

SUBMISSION_IDENTIFIER_SYSTEM = "urn:medapp:submission"
AUTHOR_IDENTIFIER_SYSTEM = "urn:medapp:cognito-sub"


@dataclass(frozen=True)
class ExecutionContext:
    """What a primitive may know about the call beyond its config: the clock and, for writes, who is writing through which app."""

    now: datetime
    user_sub: str = ""
    user_display: str | None = None
    app_id: str = ""
    manifest_version: str = ""
    # Whether the role's scope lets this app leave a Provenance beside each record it writes (manifests compiled
    # before provenance existed lack the grant; their writes still land, audited in the platform's own log).
    provenance_allowed: bool = False
    # The imaging source (DICOMweb / QIDO-RS) when one is configured; None means imaging comes from the FHIR
    # record's ImagingStudy resources. Deployment configuration handed to each execution, like the clock.
    dicom: Any = None
    # The manifest's own FHIR definitions (`artifacts`: the Questionnaires behind its forms). A form the app carries
    # is read from here, not from the record — it was reviewed and signed with the app.
    artifacts: dict[str, Any] | None = None
    # Where the bytes of photos live (media_store.py): the record keeps the Media resource and a storage URL, the
    # store keeps the image and hands out short-lived URLs for reading. None = no photos in this deployment.
    media: MediaStore | None = None
    # The hospital this deployment serves — the prefix under which its media objects are kept.
    hospital_id: str = ""

    @property
    def provenance_source(self) -> str:
        return f"urn:medapp:{self.app_id}@{self.manifest_version}"

    @property
    def stamp(self) -> str:
        return self.now.isoformat().replace("+00:00", "Z")

    def author(self) -> dict[str, Any]:
        who: dict[str, Any] = {"identifier": {"system": AUTHOR_IDENTIFIER_SYSTEM, "value": self.user_sub}}
        if self.user_display:
            who["display"] = self.user_display
        return who


def is_write_kind(kind: str) -> bool:
    return kind.startswith("write.")


class PrimitiveConfigError(ValueError):
    pass


class WriteRejected(ValueError):
    """The payload of a write primitive is invalid; nothing was stored. `problems` explains why."""

    def __init__(self, primitive_id: str, problems: list[str]):
        super().__init__(problems[0] if len(problems) == 1 else f"{len(problems)} problems: {'; '.join(problems)}")
        self.primitive_id = primitive_id
        self.problems = problems


class ScopeViolation(PermissionError):
    def __init__(self, primitive_id: str, requirement: str):
        super().__init__(f'Primitive "{primitive_id}" requires {requirement}, which the active role\'s data scope does not grant.')
        self.requirement = requirement


class UnknownPrimitive(KeyError):
    pass


# ── scope requirements (mirror of med_app/src/primitives/data/dataCatalog.ts::assertScopeAllows) ──


def _fhir_allowed(scope: dict[str, Any], resource: str, op: str) -> bool:
    return any(e.get("resource") == resource and op in (e.get("operations") or []) for e in scope.get("fhir", []))


def scope_allows(scope: dict[str, Any], resource: str, op: str) -> bool:
    """Whether a role's effective scope grants an operation on a resource type (public name of the check)."""
    return _fhir_allowed(scope, resource, op)


def _dicom_allowed(scope: dict[str, Any], op: str) -> bool:
    return any(op in (e.get("operations") or []) for e in scope.get("dicom", []))


def assert_scope_allows(kind: str, primitive_id: str, config: dict[str, Any], scope: dict[str, Any]) -> None:
    def need(resource: str, op: str) -> None:
        if not _fhir_allowed(scope, resource, op):
            raise ScopeViolation(primitive_id, f"{resource}.{op}")

    if kind == "data.fhir.patient.read":
        need("Patient", "read")
    elif kind == "data.fhir.observation.by_code":
        need("Observation", "search")
    elif kind == "data.fhir.query":
        need(str(config.get("resource")), "search")
    elif kind == "data.dicom.studies.for_patient":
        if not _dicom_allowed(scope, "qido"):
            raise ScopeViolation(primitive_id, "dicom.qido")
    elif kind == "data.cohort.by_condition":
        need("Condition", "search")
        need("Patient", "read")
        if scope.get("patient_scope", "individual") == "individual":
            raise ScopeViolation(primitive_id, "patient_scope: cohort")
    elif kind == "data.cohort.latest_observation":
        need("Observation", "search")
    elif kind == "data.cohort.with_imaging":
        # Studies come from the PACS (QIDO) where one is configured and from FHIR ImagingStudy otherwise; the manifest
        # grants both, so the same app runs on either deployment — and the scope stays a cohort scope.
        need("ImagingStudy", "search")
        if not _dicom_allowed(scope, "qido"):
            raise ScopeViolation(primitive_id, "dicom.qido")
        if scope.get("patient_scope", "individual") == "individual":
            raise ScopeViolation(primitive_id, "patient_scope: cohort")
    elif kind == "data.fhir.questionnaire.read":
        need("Questionnaire", "read")
    elif kind == "write.fhir.questionnaire_response.submit":
        need("QuestionnaireResponse", "create")
        if config.get("extract"):
            need("Observation", "create")
    elif kind == "write.fhir.observation.create":
        need("Observation", "create")
    elif kind == "data.task.worklist":
        need("Task", "search")
        need("Patient", "read")
        if scope.get("patient_scope", "individual") == "individual":
            raise ScopeViolation(primitive_id, "patient_scope: cohort")
    elif kind == "data.cohort.assessment_due":
        need("QuestionnaireResponse", "search")
        need("Patient", "read")
        if scope.get("patient_scope", "individual") == "individual":
            raise ScopeViolation(primitive_id, "patient_scope: cohort")
    elif kind == "data.fhir.questionnaire_response.answers":
        need("QuestionnaireResponse", "search")
        need("Questionnaire", "read")
    elif kind == "write.fhir.record.create":
        # The resource comes from the config: the scope must grant its creation for the patient in context.
        resource = config.get("resource")
        if not isinstance(resource, str) or not resource:
            raise PrimitiveConfigError(f'Primitive "{primitive_id}": config.resource must name the resource type')
        need(resource, "create")
        need("Provenance", "create")
    elif kind == "write.fhir.media.create":
        need("Media", "create")
    elif kind == "write.fhir.task.create":
        need("Task", "create")
    elif kind == "write.fhir.task.update_status":
        need("Task", "update")
    elif kind == "write.fhir.condition.create":
        need("Condition", "create")
    elif kind == "write.fhir.allergy_intolerance.create":
        need("AllergyIntolerance", "create")
    elif kind == "write.fhir.procedure.create":
        need("Procedure", "create")
    elif kind == "write.fhir.condition.update_status":
        need("Condition", "update")
    elif kind == "write.fhir.medication_request.update_status":
        need("MedicationRequest", "update")
    else:
        raise UnknownPrimitive(kind)


# ── config validation (the zod schemas, minimally) ────────────────────────────────────────


def _require(config: dict[str, Any], key: str, typ: type | tuple[type, ...], primitive_id: str) -> Any:
    if key not in config:
        raise PrimitiveConfigError(f'Primitive "{primitive_id}": config.{key} is required')
    if not isinstance(config[key], typ):
        raise PrimitiveConfigError(f'Primitive "{primitive_id}": config.{key} has the wrong type')
    return config[key]


def _codes(config: dict[str, Any], key: str, primitive_id: str) -> list[str]:
    codes = _require(config, key, list, primitive_id)
    if not codes or not all(isinstance(c, str) and c for c in codes):
        raise PrimitiveConfigError(f'Primitive "{primitive_id}": config.{key} must be a non-empty list of codes')
    return codes


def _count(config: dict[str, Any], default: int, primitive_id: str) -> int:
    n = config.get("count", default)
    if not isinstance(n, int) or n <= 0 or n > 1000:
        raise PrimitiveConfigError(f'Primitive "{primitive_id}": config.count must be 1..1000')
    return n


def resolve_date_expression(value: str | None, now: datetime) -> str | None:
    """`now-2y`, `now-6m`, `now-90d` → ISO; ISO strings pass through."""
    if not value:
        return None
    v = value.strip()
    if v == "now":
        return now.isoformat().replace("+00:00", "Z")
    if v.startswith("now-") and len(v) > 4 and v[-1] in "dmy" and v[4:-1].isdigit():
        n, unit = int(v[4:-1]), v[-1]
        d = now
        if unit == "d":
            d = now - timedelta(days=n)
        elif unit == "m":
            month = now.month - n
            year = now.year + (month - 1) // 12
            month = (month - 1) % 12 + 1
            d = now.replace(year=year, month=month, day=min(now.day, 28))
        elif unit == "y":
            d = now.replace(year=now.year - n)
        return d.isoformat().replace("+00:00", "Z")
    return v


# ── implementations ──────────────────────────────────────────────────────────────────────


# The "newest first" sort a real server can do itself, per resource type: R4 search parameters of type date that
# correspond to `resource_date()`. Sent as `_sort` so that `_count` can be applied server-side without dropping
# recent records; results are still ordered here (`newest_first`) so both sources answer identically. The
# in-memory source ignores `_sort` values other than `date`.
SORT_NEWEST_FIRST: dict[str, str] = {
    "Observation": "-date",
    "Condition": "-recorded-date",
    "MedicationRequest": "-authoredon",
    "ImagingStudy": "-started",
    "Encounter": "-date",
    "DiagnosticReport": "-date",
    "Questionnaire": "-date",
    "QuestionnaireResponse": "-authored",
    "AllergyIntolerance": "-date",
    "Procedure": "-date",
    "Immunization": "-date",
    "DocumentReference": "-date",
    "Task": "-authored-on",
    "Media": "-created",
}


def server_params(resource: str, params: dict[str, str], count: int) -> dict[str, str]:
    """The manifest's search parameters plus `_sort` (newest first) and `_count`, unless the manifest set them."""
    out = dict(params)
    if "_sort" not in out and resource in SORT_NEWEST_FIRST:
        out["_sort"] = SORT_NEWEST_FIRST[resource]
    out.setdefault("_count", str(count))
    return out


def patient_read(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    patient_id = patient_id_of(_require(cfg, "patient", str, pid))
    patient = src.read("Patient", patient_id)
    if not patient:
        raise LookupError(f"Patient {patient_id} was not found.")
    return patient


def observation_by_code(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    patient_id = patient_id_of(_require(cfg, "patient", str, pid))
    codes = _codes(cfg, "codes", pid)
    since = resolve_date_expression(cfg.get("since"), ctx.now)
    count = _count(cfg, 500, pid)
    # combo-code = Observation.code OR component.code: a blood-pressure panel is found by its systolic code too.
    params = {"patient": patient_id, "combo-code": ",".join(codes)}
    if since:
        params["date"] = f"ge{since}"
    return newest_first(src.search("Observation", server_params("Observation", params, count)))[:count]


# The field a `code` search parameter looks at, per resource type (FHIR R4 search parameter definitions).
CODE_FIELD: dict[str, str] = {"MedicationRequest": "medicationCodeableConcept", "Immunization": "vaccineCode", "AllergyIntolerance": "code"}


def _has_class_code(tokens: list[str]) -> bool:
    for t in tokens:
        system, code = (t.split("|", 1) if "|" in t else (None, t))
        if is_class_code(system, code):
            return True
    return False


def fhir_query(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    resource = _require(cfg, "resource", str, pid)
    if resource not in QUERY_RESOURCES:
        raise PrimitiveConfigError(f'Primitive "{pid}": resource {resource!r} is not allow-listed')
    params = {str(k): str(v) for k, v in (cfg.get("params") or {}).items()}
    count = _count(cfg, 100, pid)
    # A filter that names an ATC class or an ICD-10-GM category: a server matches tokens exactly and would answer with
    # nothing, so the code filter is taken out of the request (the patient and the rest stay) and applied here, where
    # `concept_matches` knows the hierarchy. Pages are bounded by the patient's own records of that type.
    codes = [c.strip() for c in params.get("code", "").split(",") if c.strip()]
    # Media has no `code` search parameter at all: what a photo documents is its reasonCode, matched here as well.
    local_filter = _has_class_code(codes) or (resource == "Media" and bool(codes))
    sent = {k: v for k, v in params.items() if not (local_filter and k == "code")}
    results = src.search(resource, server_params(resource, sent, count if not local_filter else 1000))
    if local_filter and resource == "Media":
        results = [r for r in results if any(concept_matches(c, codes) for c in r.get("reasonCode") or [])]
    elif local_filter:
        field = CODE_FIELD.get(resource, "code")
        results = [r for r in results if concept_matches(r.get(field), codes)]
    if "_sort" not in params:
        results = newest_first(results)  # a manifest that asked for an order keeps the server's
    if resource == "Media":
        results = [present_media(ctx.media, r) for r in results]  # the storage URL becomes one the panel can load, briefly
    return results[:count]


DUE_RANK = {"never": 0, "overdue": 1, "due": 2, "upcoming": 3}


def due_status(last_authored: str | None, every_days: int, today: date, upcoming_days: int) -> dict[str, Any] | None:
    """Where one patient stands from the day of their latest answer, as of today — mirror of mockExecutor.ts `dueStatus`."""
    if not last_authored:
        return {"status": "never"}
    last = date.fromisoformat(str(last_authored)[:10])
    due_on = last + timedelta(days=every_days)
    days = (today - due_on).days
    if days > 0:
        return {"last_authored": last_authored, "due_on": due_on.isoformat(), "status": "overdue", "overdue_days": days}
    if days == 0:
        return {"last_authored": last_authored, "due_on": due_on.isoformat(), "status": "due", "overdue_days": 0}
    if -days <= upcoming_days:
        return {"last_authored": last_authored, "due_on": due_on.isoformat(), "status": "upcoming"}
    return None  # assessed recently enough: not on the list


def cohort_assessment_due(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Who is due an assessment: the cohort handed in (or everyone assessed before) against their latest
    QuestionnaireResponse to one Questionnaire. Never assessed first, then the longest overdue. Mirrors mockExecutor.ts."""
    questionnaire = _require(cfg, "questionnaire", str, pid)
    every_days = cfg.get("every_days")
    if not isinstance(every_days, int) or every_days <= 0:
        raise PrimitiveConfigError(f'Primitive "{pid}": config.every_days must be a positive number of days')
    upcoming_days = int(cfg.get("upcoming_days") or 0)
    count = _count(cfg, 200, pid)
    given = cfg.get("patients")
    patients: list[Resource] | None = [p for p in given if isinstance(p, dict)] if isinstance(given, list) else None
    # Every answer to this questionnaire — for the cohort, per member; without one, across the record (the population is then whoever answered).
    if patients is not None:
        pages = _in_parallel(lambda p: src.search("QuestionnaireResponse", server_params("QuestionnaireResponse", {"patient": str(p.get("id") or ""), "questionnaire": questionnaire}, 50), max_pages=1), patients)
        responses = [r for page in pages for r in page]
    else:
        responses = src.search("QuestionnaireResponse", server_params("QuestionnaireResponse", {"questionnaire": questionnaire}, 1000))
    latest_by: dict[str, str] = {}
    for r in responses:
        if r.get("status") == "entered-in-error":
            continue
        patient_id = patient_id_of((r.get("subject") or {}).get("reference") or "")
        authored = str(r.get("authored") or "")
        if patient_id and authored and latest_by.get(patient_id, "") < authored:
            latest_by[patient_id] = authored
    if patients is None:
        ids = sorted(latest_by)
        patients = [p for p in _in_parallel(lambda i: src.read("Patient", i), ids) if p]
    today = ctx.now.date()
    rows = []
    for patient in patients:
        standing = due_status(latest_by.get(str(patient.get("id") or "")), every_days, today, upcoming_days)
        if standing:
            rows.append({"patient": patient, **standing})
    rows.sort(key=lambda r: (DUE_RANK[r["status"]], -int(r.get("overdue_days") or 0), str(r.get("due_on") or "")))
    rows = rows[:count]
    return {"rows": rows, "count": len(rows), "never_count": sum(1 for r in rows if r["status"] == "never"), "overdue_count": sum(1 for r in rows if r["status"] == "overdue")}


def _task_due(task: Resource) -> str | None:
    end = ((task.get("restriction") or {}).get("period") or {}).get("end")
    return str(end)[:10] if end else None


def task_worklist(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """The open tasks across patients, each with the patient it is for — overdue first, then by due date, then newest
    request first. The population is whoever has such a task; a server search by status (and code), one Patient read
    per distinct patient, in parallel. Mirrors mockExecutor.ts `data.task.worklist`."""
    statuses = [str(x) for x in (cfg.get("statuses") or ["requested", "in-progress"])]
    codes = [str(c) for c in (cfg.get("codes") or [])]
    count = _count(cfg, 200, pid)
    params: dict[str, str] = {"status": ",".join(statuses)}
    if codes and not _has_class_code(codes):
        params["code"] = ",".join(codes)
    tasks = src.search("Task", server_params("Task", params, 1000))
    if codes:
        tasks = [t for t in tasks if concept_matches(t.get("code"), codes)]
    refs = sorted({str((t.get("for") or {}).get("reference") or "") for t in tasks if (t.get("for") or {}).get("reference")})
    patients = _in_parallel(lambda ref: src.read("Patient", patient_id_of(ref)), refs)
    by_ref = {ref: p for ref, p in zip(refs, patients) if p}
    today = ctx.now.date().isoformat()
    rows = []
    for t in tasks:
        patient = by_ref.get(str((t.get("for") or {}).get("reference") or ""))
        if not patient:
            continue
        due = _task_due(t)
        rows.append({"task": t, "patient": patient, "overdue": bool(due and due < today and t.get("status") not in ("completed", "cancelled"))})
    # Two stable sorts: newest request first, then overdue first and by due date (tasks without one last).
    rows.sort(key=lambda r: str(r["task"].get("authoredOn") or ""), reverse=True)
    rows.sort(key=lambda r: (not r["overdue"], _task_due(r["task"]) or "9999"))
    rows = rows[:count]
    return {"rows": rows, "count": len(rows), "overdue_count": sum(1 for r in rows if r["overdue"])}


def dicom_studies_for_patient(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    patient_id = patient_id_of(_require(cfg, "patient", str, pid))
    modalities = [str(m) for m in (cfg.get("modalities") or [])]
    if ctx.dicom is not None:
        # A PACS answers by the patient's MRN: the FHIR Patient supplies it, QIDO-RS supplies the studies, and the
        # result is the same ImagingStudy shape the record would give — the renderer cannot tell the two apart.
        patient = src.read("Patient", patient_id)
        if not patient:
            raise LookupError(f"Patient {patient_id} was not found.")
        return ctx.dicom.imaging_studies(patient, modalities or None)
    studies = src.search("ImagingStudy", server_params("ImagingStudy", {"patient": patient_id}, 200))
    if modalities:
        studies = [s for s in studies if any(m.get("code") in modalities for m in s.get("modality") or [])]
    return sorted(studies, key=lambda s: s.get("started") or "", reverse=True)


def cohort_by_condition(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    codes = _codes(cfg, "condition_codes", pid)
    params = {"code": ",".join(codes), "_count": "500"}
    if cfg.get("clinical_status"):
        params["clinical-status"] = str(cfg["clinical_status"])
    conditions = src.search("Condition", params)
    ids: list[str] = []
    for c in conditions:
        ref = patient_id_of((c.get("subject") or {}).get("reference") or "")
        if ref and ref not in ids:
            ids.append(ref)
    # One read per patient, in parallel: twenty sequential reads through a gateway are three seconds, together under one.
    patients = [p for p in _in_parallel(lambda i: src.read("Patient", i), ids) if p]
    return {"patients": patients, "conditions": conditions, "count": len(patients)}


def _study_summary(study: Resource) -> dict[str, Any]:
    """What a cohort row says about a study: enough to name it and to open it, never the pixels."""
    uid = next((i.get("value", "")[8:] for i in study.get("identifier") or [] if str(i.get("value", "")).startswith("urn:oid:")), None) or study.get("id")
    return {
        "uid": uid,
        "started": study.get("started"),
        "modalities": sorted({str(m.get("code")) for m in study.get("modality") or [] if m.get("code")}),
        "description": study.get("description"),
        "series": study.get("numberOfSeries"),
        "instances": study.get("numberOfInstances"),
    }


def cohort_with_imaging(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """
    Narrow a cohort to the members with imaging: for each member, their studies (the PACS by QIDO where one is
    configured, FHIR ImagingStudy otherwise), kept to the requested modalities and, with `since`, to studies started
    from that date; a member stays when at least `min_studies` match. One lookup per member, in parallel, like the
    latest observation. The rows carry the count and the latest matching study; `patients` is the narrowed cohort, so
    a latest-observation step can follow on exactly these members.
    """
    patients = _require(cfg, "patients", list, pid)
    for p in patients:
        if not isinstance(p, dict) or p.get("resourceType") != "Patient":
            raise PrimitiveConfigError(f'Primitive "{pid}": config.patients must be Patient resources')
    modalities = [str(m) for m in (cfg.get("modalities") or [])]
    since = resolve_date_expression(cfg.get("since"), ctx.now)
    min_studies = cfg.get("min_studies", 1)
    if not isinstance(min_studies, int) or min_studies < 1:
        raise PrimitiveConfigError(f'Primitive "{pid}": config.min_studies must be a positive integer')

    def studies_of(patient: Resource) -> list[Resource]:
        if ctx.dicom is not None:
            studies = ctx.dicom.imaging_studies(patient, modalities or None, with_series=False)
        else:
            studies = src.search("ImagingStudy", server_params("ImagingStudy", {"patient": str(patient.get("id", ""))}, 200))
            if modalities:
                studies = [s for s in studies if any(m.get("code") in modalities for m in s.get("modality") or [])]
        if since:
            studies = [s for s in studies if str(s.get("started") or "") >= since]
        return sorted(studies, key=lambda s: s.get("started") or "", reverse=True)

    rows: list[dict[str, Any]] = []
    studies_total = 0
    for patient, studies in zip(patients, _in_parallel(studies_of, patients)):
        if len(studies) < min_studies:
            continue
        studies_total += len(studies)
        rows.append(
            {
                "patient": patient,
                "study_count": len(studies),
                "latest_study": _study_summary(studies[0]),
                "modalities": sorted({m for s in studies for m in _study_summary(s)["modalities"]}),
            }
        )
    return {"rows": rows, "patients": [r["patient"] for r in rows], "count": len(rows), "studies_total": studies_total}


def _in_parallel(fn: Callable[[Any], Any], items: list[Any], workers: int = 8) -> list[Any]:
    """`[fn(x) for x in items]`, the calls overlapping on threads; the results in the items' order whatever the threads did."""
    if len(items) <= 1:
        return [fn(x) for x in items]
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(fn, items))


# "The latest reading per patient" is one search per patient: FHIR has no group-by, and a comma list of patients on
# one search is not reliable across servers (one hospital's HAPI silently returned everyone for a list of twenty). Each
# search asks for one page of the newest readings (`_sort`, `_count=LATEST_PAGE`, no paging) — a `_count=1` makes
# HAPI build a cached search, five times slower — and the patients are fetched in parallel; the result order is
# the cohort's order whatever the threads did.
LATEST_PAGE = 100


def _latest_observation(src: FhirSource, patient_id: str, codes: list[str]) -> Resource | None:
    page = src.search("Observation", server_params("Observation", {"patient": patient_id, "combo-code": ",".join(codes)}, LATEST_PAGE), max_pages=1)
    ordered = newest_first(page)
    return ordered[0] if ordered else None


def cohort_latest_observation(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    patients = _require(cfg, "patients", list, pid)
    codes = _codes(cfg, "codes", pid)
    threshold = cfg.get("threshold")
    for p in patients:
        if not isinstance(p, dict) or p.get("resourceType") != "Patient":
            raise PrimitiveConfigError(f'Primitive "{pid}": config.patients must be Patient resources')
    # The value a threshold and a range filter look at: the configured panel component, else the value itself (or systolic).
    component_code = (threshold or {}).get("component_code") or cfg.get("component_code")
    latests = _in_parallel(lambda p: _latest_observation(src, str(p.get("id", "")), codes), patients)
    rows: list[dict[str, Any]] = []
    for p, latest in zip(patients, latests):
        systolic = (component_quantity(latest, "8480-6") or {}).get("value") if latest else None
        diastolic = (component_quantity(latest, "8462-4") or {}).get("value") if latest else None
        value = (latest or {}).get("valueQuantity", {}).get("value") if latest else None
        compared = None
        unit = ((latest or {}).get("valueQuantity") or {}).get("unit") if latest else None
        if latest:
            if component_code:
                component = component_quantity(latest, component_code) or {}
                compared = component.get("value")
                unit = unit or component.get("unit")
            else:
                compared = value if value is not None else systolic
        rows.append(
            {
                "patient": p,
                "observation": latest,
                "date": resource_date(latest) if latest else None,
                "systolic": systolic,
                "diastolic": diastolic,
                "value": value,
                "unit": unit,
                "compared": compared,
                "above_threshold": bool(threshold) and compared is not None and compared >= threshold["value"],
            }
        )
    compared_values = [r["compared"] for r in rows if isinstance(r["compared"], (int, float))]
    out: dict[str, Any] = {"rows": rows, "above_threshold_count": sum(1 for r in rows if r["above_threshold"])}
    if compared_values:
        # The span of the cohort's compared values — a range filter's slider is bounded by it when the app sets no bounds.
        out["compared_min"], out["compared_max"] = min(compared_values), max(compared_values)
    return out


def own_questionnaire(artifacts: dict[str, Any] | None, ref: str) -> Resource | None:
    """The app's own form, by canonical URL or id, when the manifest carries one."""
    for q in (artifacts or {}).get("questionnaires") or []:
        if isinstance(q, dict) and (q.get("url") == ref or q.get("id") == ref):
            return q
    return None


def _find_questionnaire(src: FhirSource, ref: str, ctx: ExecutionContext | None = None) -> Resource | None:
    """
    The app's own form first (carried in the manifest, reviewed with it), then the record: a canonical URL
    (`https://…/Questionnaire/x`, `urn:…`) is searched by `url`; anything else is an id.
    """
    own = own_questionnaire(ctx.artifacts if ctx else None, ref)
    if own is not None:
        return own
    if "/" in ref or ":" in ref:
        found = src.search("Questionnaire", {"url": ref})
        return found[0] if found else None
    return src.read("Questionnaire", ref)


def questionnaire_read(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    ref = _require(cfg, "questionnaire", str, pid)
    questionnaire = _find_questionnaire(src, ref, ctx)
    if not questionnaire:
        raise LookupError(f"Questionnaire {ref} was not found.")
    return questionnaire


UNIT_EXTENSION = "http://hl7.org/fhir/StructureDefinition/questionnaire-unit"


def _answers_as_observations(responses: list[Resource], questionnaire: Resource | None, url: str, link_ids: list[str]) -> list[Resource]:
    """A form's numeric answers as derived Observations — one per answer to a named question, coded `url | linkId`, dated when
    the response was authored, the unit from the Questionnaire's item when known. Not stored. Mirrors mockExecutor.ts
    `answersAsObservations`."""
    items: dict[str, Resource] = {}

    def index(nodes: Any) -> None:
        for i in nodes or []:
            if isinstance(i, dict) and i.get("linkId"):
                items[str(i["linkId"])] = i
                index(i.get("item"))

    index((questionnaire or {}).get("item"))

    def unit_of(link_id: str) -> str | None:
        for e in (items.get(link_id) or {}).get("extension") or []:
            if e.get("url") == UNIT_EXTENSION:
                return (e.get("valueCoding") or {}).get("display")
        return None

    def text_of(link_id: str, fallback: Any) -> str:
        return str((items.get(link_id) or {}).get("text") or fallback or link_id)

    out: list[Resource] = []

    def walk(response: Resource, nodes: Any) -> None:
        for item in nodes or []:
            if not isinstance(item, dict):
                continue
            link_id = str(item.get("linkId") or "")
            if link_id in link_ids:
                for a in item.get("answer") or []:
                    value = a.get("valueDecimal", a.get("valueInteger")) if isinstance(a, dict) else None
                    if not isinstance(value, (int, float)) or isinstance(value, bool):
                        continue
                    unit = unit_of(link_id)
                    text = text_of(link_id, item.get("text"))
                    subject = (response.get("subject") or {}).get("reference")
                    out.append(
                        {
                            "resourceType": "Observation",
                            "id": f"qr-{response.get('id')}-{link_id}",
                            "status": "final",
                            "code": {"coding": [{"system": url, "code": link_id, "display": text}], "text": text},
                            **({"subject": {"reference": subject}} if subject else {}),
                            "effectiveDateTime": response.get("authored"),
                            "valueQuantity": {"value": value, **({"unit": unit} if unit else {})},
                            "derivedFrom": [{"reference": f"QuestionnaireResponse/{response.get('id')}"}],
                        }
                    )
            walk(response, item.get("item"))
            for a in item.get("answer") or []:
                if isinstance(a, dict):
                    walk(response, a.get("item"))

    for r in responses:
        walk(r, r.get("item"))
    return out


def questionnaire_response_answers(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """A form's answers over time as data — the patient's responses to one Questionnaire, their numeric answers to the
    named questions as derived Observations, newest first. Nothing is written."""
    patient_id = patient_id_of(_require(cfg, "patient", str, pid))
    url = _require(cfg, "questionnaire", str, pid)
    link_ids = _codes(cfg, "link_ids", pid)
    count = _count(cfg, 200, pid)
    responses = [r for r in src.search("QuestionnaireResponse", server_params("QuestionnaireResponse", {"patient": patient_id, "questionnaire": url}, 500)) if r.get("status") != "entered-in-error"]
    responses = newest_first(responses)
    questionnaire = _find_questionnaire(src, url, ctx)  # for the questions' texts and units; the answers stand without it
    return _answers_as_observations(responses, questionnaire, url, link_ids)[:count]


# Fields of the submitted QuestionnaireResponse that are taken from the client. Everything else —
# id, status, subject, authored, author, source, meta — is set here from verified facts.
SUBMISSION_CLIENT_FIELDS = ("identifier", "item", "encounter", "language")


def questionnaire_response_submit(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    ref = _require(cfg, "questionnaire", str, pid)
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    response = _require(cfg, "response", dict, pid)

    questionnaire = _find_questionnaire(src, ref, ctx)
    if not questionnaire:
        raise LookupError(f"Questionnaire {ref} was not found.")

    problems = validate_questionnaire_response(questionnaire, response)
    claimed_subject = (response.get("subject") or {}).get("reference")
    if claimed_subject and claimed_subject != f"Patient/{subject_id}":
        problems.append(f"response subject {claimed_subject} is not the patient in context")
    if problems:
        raise WriteRejected(pid, problems)

    stamp = ctx.now.isoformat().replace("+00:00", "Z")
    author: dict[str, Any] = {"identifier": {"system": AUTHOR_IDENTIFIER_SYSTEM, "value": ctx.user_sub}}
    if ctx.user_display:
        author["display"] = ctx.user_display
    stored: Resource = {k: response[k] for k in SUBMISSION_CLIENT_FIELDS if k in response}
    stored.update(
        {
            "resourceType": "QuestionnaireResponse",
            "questionnaire": questionnaire.get("url") or f"Questionnaire/{questionnaire.get('id')}",
            "status": "completed",
            "subject": {"reference": f"Patient/{subject_id}"},
            "authored": stamp,
            "author": author,
            "meta": {"source": ctx.provenance_source, "lastUpdated": stamp},
        }
    )

    identifier = response.get("identifier") if isinstance(response.get("identifier"), dict) else None
    if_none_exist = None
    if identifier and identifier.get("value"):
        if_none_exist = {"identifier": f"{identifier.get('system') or SUBMISSION_IDENTIFIER_SYSTEM}|{identifier['value']}"}
    created, fresh = _create_once(src, stored, if_none_exist)
    if fresh:
        _record_provenance(src, ctx, created, "CREATE")
        # The answers the manifest flags as measurements, written as Observations beside the response (category survey,
        # derived from it, their own Provenance) — a pain score from a form and one typed into an entry form share a trend.
        submission = (identifier or {}).get("value") or created.get("id")
        for hit in extract_answers(cfg.get("extract"), response):
            system, _, code = str(hit["code"]).rpartition("|")
            observation: Resource = {
                "resourceType": "Observation",
                "identifier": [{"system": SUBMISSION_IDENTIFIER_SYSTEM, "value": f"{submission}-{hit['link_id']}"}],
                "status": "final",
                "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "survey"}]}],
                "code": {"coding": [{k: v for k, v in (("system", system or None), ("code", code), ("display", hit.get("display"))) if v}], **({"text": hit["display"]} if hit.get("display") else {})},
                "subject": {"reference": f"Patient/{subject_id}"},
                "effectiveDateTime": stamp,
                "issued": stamp,
                "performer": [author],
                "valueQuantity": {"value": hit["value"], **({"unit": hit["unit"]} if hit.get("unit") else {})},
                "derivedFrom": [{"reference": f"QuestionnaireResponse/{created.get('id')}"}],
                "meta": {"source": ctx.provenance_source, "lastUpdated": stamp},
            }
            written, new = _create_once(src, observation, {"identifier": f"{SUBMISSION_IDENTIFIER_SYSTEM}|{submission}-{hit['link_id']}"})
            if new:
                _record_provenance(src, ctx, written, "CREATE")
    return created


def _create_once(src: FhirSource, resource: Resource, if_none_exist: dict[str, str] | None) -> tuple[Resource, bool]:
    """Conditional create that also says whether anything new was written — a replayed submission is the earlier
    record (and must not get a second Provenance)."""
    if if_none_exist:
        existing = src.search(str(resource.get("resourceType")), if_none_exist)
        if len(existing) == 1:
            return existing[0], False
    return src.create(resource, if_none_exist=if_none_exist), True


# ── the other writes: a measurement, a status ─────────────────────────────────────────────────


def _record_provenance(src: FhirSource, ctx: ExecutionContext, target: Resource, activity: str, previous_version: str | None = None) -> None:
    """One Provenance per write — who, when, through which app version, on which record (and, for an update,
    which version it replaced). Written only when the role's scope grants Provenance.create; the platform's
    audit log records the write either way."""
    if not ctx.provenance_allowed:
        return
    target_ref = f"{target.get('resourceType')}/{target.get('id')}"
    provenance: Resource = {
        "resourceType": "Provenance",
        "target": [{"reference": target_ref}],
        "recorded": ctx.stamp,
        "activity": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-DataOperation", "code": activity}]},
        "agent": [{"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/provenance-participant-type", "code": "author"}]}, "who": ctx.author()}],
        "policy": [ctx.provenance_source],
    }
    if previous_version is not None:
        provenance["entity"] = [{"role": "revision", "what": {"reference": f"{target_ref}/_history/{previous_version}"}}]
    src.create(provenance)


# Fields of a submitted Observation that are taken from the client; the rest is stamped from verified facts.
OBSERVATION_CLIENT_FIELDS = ("identifier", "code", "effectiveDateTime", "valueQuantity", "component", "note", "bodySite", "method")


def observation_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Record a measurement: an Observation whose code, unit, plausibility range and date the manifest fixed in advance."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    observation = _require(cfg, "observation", dict, pid)
    _codes(cfg, "codes", pid)
    problems = validate_observation_entry(cfg, observation, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)

    stored: Resource = {k: observation[k] for k in OBSERVATION_CLIENT_FIELDS if k in observation}
    if isinstance(stored.get("note"), list):
        stored["note"] = [{"authorString": ctx.user_display or ctx.user_sub, "time": ctx.stamp, "text": str(n.get("text", ""))} for n in stored["note"] if isinstance(n, dict) and n.get("text")]
    category = cfg.get("category")
    stored.update(
        {
            "resourceType": "Observation",
            "status": "final",
            "subject": {"reference": f"Patient/{subject_id}"},
            "effectiveDateTime": stored.get("effectiveDateTime") or ctx.stamp,
            "issued": ctx.stamp,
            "performer": [ctx.author()],
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    if category:
        stored["category"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": str(category)}]}]

    # Observation.identifier is a list (unlike QuestionnaireResponse.identifier); the form sends one entry.
    identifiers = observation.get("identifier")
    identifier = identifiers[0] if isinstance(identifiers, list) and identifiers and isinstance(identifiers[0], dict) else (identifiers if isinstance(identifiers, dict) else None)
    if identifier is not None:
        stored["identifier"] = [identifier]
    if_none_exist = None
    if identifier and identifier.get("value"):
        if_none_exist = {"identifier": f"{identifier.get('system') or SUBMISSION_IDENTIFIER_SYSTEM}|{identifier['value']}"}
    created, fresh = _create_once(src, stored, if_none_exist)
    if fresh:
        _record_provenance(src, ctx, created, "CREATE")
    return created


# ── coded entries: a problem, an allergy, a procedure ─────────────────────────────────────────

CONDITION_CLIENT_FIELDS = ("identifier", "code", "verificationStatus", "severity", "onsetDateTime", "note")
ALLERGY_CLIENT_FIELDS = ("identifier", "code", "type", "category", "criticality", "verificationStatus", "onsetDateTime", "reaction", "note")
PROCEDURE_CLIENT_FIELDS = ("identifier", "code", "status", "performedDateTime", "bodySite", "outcome", "note")


def _code_of(concept: Any) -> str | None:
    for coding in ((concept or {}).get("coding") or []) if isinstance(concept, dict) else []:
        if isinstance(coding, dict) and coding.get("code"):
            return str(coding["code"])
    return None


def _notes_attributed(stored: Resource, ctx: ExecutionContext) -> None:
    """A free-text remark is kept, attributed and timed by the platform — never by the client."""
    if isinstance(stored.get("note"), list):
        stored["note"] = [{"authorString": ctx.user_display or ctx.user_sub, "time": ctx.stamp, "text": str(n.get("text", ""))} for n in stored["note"] if isinstance(n, dict) and n.get("text")]
        if not stored["note"]:
            del stored["note"]


def _create_coded_entry(src: FhirSource, ctx: ExecutionContext, stored: Resource, payload: Resource) -> Any:
    """Conditional create on the client's submission identifier (a list on these resources), with the Provenance."""
    identifiers = payload.get("identifier")
    identifier = identifiers[0] if isinstance(identifiers, list) and identifiers and isinstance(identifiers[0], dict) else (identifiers if isinstance(identifiers, dict) else None)
    if_none_exist = None
    if identifier is not None:
        stored["identifier"] = [identifier]
        if identifier.get("value"):
            if_none_exist = {"identifier": f"{identifier.get('system') or SUBMISSION_IDENTIFIER_SYSTEM}|{identifier['value']}"}
    created, fresh = _create_once(src, stored, if_none_exist)
    if fresh:
        _record_provenance(src, ctx, created, "CREATE")
    return created


def condition_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Add a diagnosis to the problem list: an active Condition from the codes the manifest allows; the rest is stamped."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    condition = _require(cfg, "condition", dict, pid)
    _codes(cfg, "codes", pid)
    problems = validate_condition_entry(cfg, condition, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    verification = [str(v) for v in (cfg.get("verification") or ["confirmed"])]
    stored: Resource = {k: condition[k] for k in CONDITION_CLIENT_FIELDS if k in condition}
    _notes_attributed(stored, ctx)
    stored.update(
        {
            "resourceType": "Condition",
            "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active", "display": "Active"}]},
            "verificationStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-ver-status", "code": _code_of(condition.get("verificationStatus")) or verification[0]}]},
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": str(cfg.get("category") or "problem-list-item")}]}],
            "subject": {"reference": f"Patient/{subject_id}"},
            "recordedDate": ctx.stamp,
            "recorder": ctx.author(),
            "asserter": ctx.author(),
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    return _create_coded_entry(src, ctx, stored, condition)


def allergy_intolerance_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Record an allergy or intolerance: an active AllergyIntolerance to one of the substances the manifest allows."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    allergy = _require(cfg, "allergy", dict, pid)
    _codes(cfg, "codes", pid)
    problems = validate_allergy_entry(cfg, allergy, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    verification = [str(v) for v in (cfg.get("verification") or ["confirmed", "unconfirmed"])]
    stored: Resource = {k: allergy[k] for k in ALLERGY_CLIENT_FIELDS if k in allergy}
    _notes_attributed(stored, ctx)
    stored.update(
        {
            "resourceType": "AllergyIntolerance",
            "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", "code": "active", "display": "Active"}]},
            "verificationStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification", "code": _code_of(allergy.get("verificationStatus")) or verification[0]}]},
            "patient": {"reference": f"Patient/{subject_id}"},
            "recordedDate": ctx.stamp,
            "recorder": ctx.author(),
            "asserter": ctx.author(),
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    return _create_coded_entry(src, ctx, stored, allergy)


def procedure_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Record a procedure performed: a Procedure from the codes the manifest allows, dated within its window."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    procedure = _require(cfg, "procedure", dict, pid)
    _codes(cfg, "codes", pid)
    problems = validate_procedure_entry(cfg, procedure, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    stored: Resource = {k: procedure[k] for k in PROCEDURE_CLIENT_FIELDS if k in procedure}
    _notes_attributed(stored, ctx)
    stored.update(
        {
            "resourceType": "Procedure",
            "subject": {"reference": f"Patient/{subject_id}"},
            "recorder": ctx.author(),
            "asserter": ctx.author(),
            "performer": [{"actor": ctx.author()}],
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    return _create_coded_entry(src, ctx, stored, procedure)


MEDIA_CLIENT_FIELDS = ("identifier", "reasonCode", "bodySite", "createdDateTime", "note")
IMAGE_EXTENSION = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def media_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Record a photo of the patient in context: the image to the media store, the Media resource — what it documents,
    the body site, when it was taken, who took it, a hash and a size, the storage URL — to the record. The bytes never
    enter the FHIR record."""
    import base64  # noqa: PLC0415
    import hashlib  # noqa: PLC0415

    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    media = _require(cfg, "media", dict, pid)
    _codes(cfg, "kinds", pid)
    problems = validate_media_entry(cfg, media, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    if ctx.media is None:
        raise LookupError("This deployment has no media store; photos cannot be saved here.")
    content = media["content"]
    data = base64.b64decode(str(content["data"]), validate=True)
    content_type = str(content["contentType"])
    identifiers = media.get("identifier")
    identifier = identifiers[0] if isinstance(identifiers, list) and identifiers and isinstance(identifiers[0], dict) else None
    token = str((identifier or {}).get("value") or hashlib.sha256(data).hexdigest()[:24])
    key = f"{ctx.hospital_id or 'hospital'}/{subject_id}/{token}.{IMAGE_EXTENSION[content_type]}"
    url = ctx.media.put(key, data, content_type)  # idempotent on the client's submission identifier: a retry overwrites with the same bytes

    stored: Resource = {k: media[k] for k in MEDIA_CLIENT_FIELDS if k in media}
    _notes_attributed(stored, ctx)
    stored.update(
        {
            "resourceType": "Media",
            "status": "completed",
            "type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/media-type", "code": "photo", "display": "Photo"}]},
            "subject": {"reference": f"Patient/{subject_id}"},
            "createdDateTime": media.get("createdDateTime") or ctx.stamp,
            "issued": ctx.stamp,
            "operator": ctx.author(),
            "content": {
                "contentType": content_type,
                "url": url,
                "size": len(data),
                "hash": base64.b64encode(hashlib.sha1(data).digest()).decode("ascii"),  # FHIR Attachment.hash: SHA-1, base64
                **({"title": str(content["title"])} if content.get("title") else {}),
                "creation": media.get("createdDateTime") or ctx.stamp,
            },
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    created = _create_coded_entry(src, ctx, stored, media)
    return present_media(ctx.media, created)


def record_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Write a record of a declared shape: the resource type and fields the manifest declares, validated against them
    (and nothing outside them accepted), then stamped — status, subject, author, dates — and created with its
    Provenance. The compiler resolved the shape against the FHIR definitions; here only the declaration counts."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    record = _require(cfg, "record", dict, pid)
    resource = _require(cfg, "resource", str, pid)
    if not isinstance(cfg.get("fields"), list) or not cfg["fields"]:
        raise PrimitiveConfigError(f'Primitive "{pid}": config.fields must list the declared fields')
    problems = validate_record_entry(cfg, record, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    stored: Resource = copy.deepcopy(record)
    stored.pop("meta", None)
    apply_stamps(stored, cfg.get("stamps"), patient_id=subject_id, author=ctx.author(), now=ctx.stamp)
    stored["resourceType"] = resource
    stored["meta"] = {"source": ctx.provenance_source, "lastUpdated": ctx.stamp}
    shape = cfg.get("shape")
    if isinstance(shape, dict) and isinstance(shape.get("tag"), dict):
        # A record written with a library shape says so on itself: the shape and its version as a tag (`_tag=<system>|<id>`).
        stored["meta"]["tag"] = [dict(shape["tag"])]
    return _create_coded_entry(src, ctx, stored, record)


TASK_CLIENT_FIELDS = ("identifier", "code", "priority", "description", "restriction")


def task_create(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Put a task on the list for the patient in context: a code the manifest allows, a priority the form offers, a due date."""
    subject_id = patient_id_of(_require(cfg, "subject", str, pid))
    task = _require(cfg, "task", dict, pid)
    _codes(cfg, "codes", pid)
    problems = validate_task_entry(cfg, task, subject_id, ctx.now)
    if problems:
        raise WriteRejected(pid, problems)
    priorities = [str(x) for x in (cfg.get("priorities") or ["routine", "urgent"])]
    stored: Resource = {k: task[k] for k in TASK_CLIENT_FIELDS if k in task and k != "restriction"}
    due = _task_due(task)
    if due:
        stored["restriction"] = {"period": {"end": due}}  # the due day only; nothing else of the client's restriction
    stored.update(
        {
            "resourceType": "Task",
            "status": "requested",
            "intent": "order",
            "priority": str(task.get("priority") or priorities[0]),
            "for": {"reference": f"Patient/{subject_id}"},
            "authoredOn": ctx.stamp,
            "lastModified": ctx.stamp,
            "requester": ctx.author(),
            "meta": {"source": ctx.provenance_source, "lastUpdated": ctx.stamp},
        }
    )
    return _create_coded_entry(src, ctx, stored, task)


def _apply_task_status(resource: Resource, status: str, change: dict[str, Any], ctx: ExecutionContext) -> None:
    """Whoever moves a task on owns it; completion is timed. Mirrors mockExecutor.ts write.fhir.task.update_status."""
    resource["status"] = status
    resource["lastModified"] = ctx.stamp
    if status in ("in-progress", "completed") and not resource.get("owner"):
        resource["owner"] = ctx.author()
    period = dict(resource.get("executionPeriod") or {})
    if status == "in-progress":
        period.setdefault("start", ctx.stamp)
    if status == "completed":
        period["end"] = ctx.stamp
    if period:
        resource["executionPeriod"] = period
    _append_note(resource, change, ctx)


def task_update_status(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Start, complete or cancel a task — one field, an allowed set; on a worklist the task's own patient is the one in question."""
    return _status_update(cfg, src, pid, ctx, "Task", "status", _apply_task_status)


def _status_update(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext, resource_type: str, status_field: str, apply: Callable[[Resource, str, dict[str, Any], ExecutionContext], None]) -> Any:
    change = _require(cfg, "change", dict, pid)
    target_id = change.get("id") if isinstance(change.get("id"), str) else None
    current = src.read(resource_type, target_id) if target_id else None
    # On a patient page the subject is the launch context; on a worklist there is none, and the task's own patient is it.
    subject = cfg.get("subject")
    subject_id = patient_id_of(str(subject)) if isinstance(subject, str) and subject else patient_id_of(str(((current or {}).get("for") or {}).get("reference") or ""))
    problems = validate_status_change(cfg, change, current, resource_type, status_field, subject_id)
    if problems:
        raise WriteRejected(pid, problems)
    assert current is not None
    previous_version = str((current.get("meta") or {}).get("versionId") or "1")
    if_match = str(change["versionId"]) if change.get("versionId") not in (None, "") else None

    updated = dict(current)
    apply(updated, str(change["status"]), change, ctx)
    meta = dict(updated.get("meta") or {})
    meta["source"] = ctx.provenance_source
    meta["lastUpdated"] = ctx.stamp
    updated["meta"] = meta
    stored = src.update(updated, if_match=if_match)
    _record_provenance(src, ctx, stored, "UPDATE", previous_version=previous_version)
    return stored


def _apply_condition_status(resource: Resource, status: str, change: dict[str, Any], ctx: ExecutionContext) -> None:
    resource["clinicalStatus"] = {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": status, "display": status.capitalize()}]}
    if status in ("resolved", "inactive", "remission"):
        resource.setdefault("abatementDateTime", ctx.stamp)
    elif "abatementDateTime" in resource:
        del resource["abatementDateTime"]
    _append_note(resource, change, ctx)


def _apply_medication_status(resource: Resource, status: str, change: dict[str, Any], ctx: ExecutionContext) -> None:
    resource["status"] = status
    reason = change.get("reason")
    if isinstance(reason, str) and reason.strip():
        resource["statusReason"] = {"text": reason.strip()}
    _append_note(resource, change, ctx)


def _append_note(resource: Resource, change: dict[str, Any], ctx: ExecutionContext) -> None:
    """A free-text remark on the change, attributed and timed by the platform, never by the client."""
    text = change.get("note")
    if isinstance(text, str) and text.strip():
        notes = list(resource.get("note") or [])
        notes.append({"authorString": ctx.user_display or ctx.user_sub, "time": ctx.stamp, "text": text.strip()})
        resource["note"] = notes


def condition_update_status(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Mark a problem resolved / inactive (or active again): one field, an allowed set, the patient's own record."""
    return _status_update(cfg, src, pid, ctx, "Condition", "clinicalStatus", _apply_condition_status)


def medication_request_update_status(cfg: dict[str, Any], src: FhirSource, pid: str, ctx: ExecutionContext) -> Any:
    """Stop, complete or hold a prescription — never prescribe: the medication itself is untouched."""
    return _status_update(cfg, src, pid, ctx, "MedicationRequest", "status", _apply_medication_status)


PRIMITIVES: dict[str, Callable[[dict[str, Any], FhirSource, str, ExecutionContext], Any]] = {
    "data.fhir.patient.read": patient_read,
    "data.fhir.observation.by_code": observation_by_code,
    "data.fhir.query": fhir_query,
    "data.dicom.studies.for_patient": dicom_studies_for_patient,
    "data.cohort.by_condition": cohort_by_condition,
    "data.cohort.latest_observation": cohort_latest_observation,
    "data.cohort.with_imaging": cohort_with_imaging,
    "data.fhir.questionnaire.read": questionnaire_read,
    "write.fhir.questionnaire_response.submit": questionnaire_response_submit,
    "write.fhir.observation.create": observation_create,
    "write.fhir.condition.create": condition_create,
    "write.fhir.allergy_intolerance.create": allergy_intolerance_create,
    "write.fhir.procedure.create": procedure_create,
    "data.task.worklist": task_worklist,
    "data.cohort.assessment_due": cohort_assessment_due,
    "data.fhir.questionnaire_response.answers": questionnaire_response_answers,
    "write.fhir.media.create": media_create,
    "write.fhir.record.create": record_create,
    "write.fhir.task.create": task_create,
    "write.fhir.task.update_status": task_update_status,
    "write.fhir.condition.update_status": condition_update_status,
    "write.fhir.medication_request.update_status": medication_request_update_status,
}


def execute(
    kind: str,
    primitive_id: str,
    config: dict[str, Any],
    scope: dict[str, Any],
    source: FhirSource,
    now: datetime | None = None,
    ctx: ExecutionContext | None = None,
) -> Any:
    if kind not in PRIMITIVES:
        raise UnknownPrimitive(kind)
    assert_scope_allows(kind, primitive_id, config, scope)
    ctx = ctx or ExecutionContext(now=now or datetime.now(timezone.utc))
    return PRIMITIVES[kind](config, source, primitive_id, ctx)


__all__ = [
    "execute",
    "assert_scope_allows",
    "scope_allows",
    "is_write_kind",
    "ExecutionContext",
    "PRIMITIVES",
    "PrimitiveConfigError",
    "ScopeViolation",
    "UnknownPrimitive",
    "WriteRejected",
    "resolve_date_expression",
    "subject_is",
]
