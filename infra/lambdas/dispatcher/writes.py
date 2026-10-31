"""
Validation of the record changes an app may make besides a form submission:

  - recording a measurement — an Observation whose code, value, unit, plausibility range and date the
    app's manifest fixed in advance (`write.fhir.observation.create`);
  - adding a coded entry — a problem (`write.fhir.condition.create`), an allergy
    (`write.fhir.allergy_intolerance.create`), a procedure (`write.fhir.procedure.create`) — from a fixed
    list of codes, with the few fields the form took, always for the patient in context;
  - changing the status of a problem or a prescription — one field, one allowed set of target values,
    on a resource that belongs to the patient in context (`write.fhir.condition.update_status`,
    `write.fhir.medication_request.update_status`).

Mirror of med_app/src/primitives/data/writes.ts — same rules, same messages; the shared cases in
med_app/src/primitives/data/writeCases.json are asserted by both test suites. These are data-quality
rules (a number where a number belongs, within the range the form declared, dated plausibly), never
clinical interpretation.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

Resource = dict[str, Any]

# The side of the body an observation is about, as the entry form writes it into bodySite: SNOMED laterality qualifiers.
# Mirror of fhirHelpers.ts LATERALITY.
SNOMED_SYSTEM = "http://snomed.info/sct"
LATERALITY = {"7771000": "left", "24028007": "right", "51440002": "both"}


def _parse_iso(value: str) -> datetime | None:
    try:
        text = value.replace("Z", "+00:00")
        if len(text) == 10:  # a bare date
            text += "T00:00:00+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _qualified(concept: Any) -> str | None:
    """`system|code` of the first coding, or `code` alone when the coding has no system."""
    for coding in ((concept or {}).get("coding") or []):
        if coding.get("code"):
            return f"{coding['system']}|{coding['code']}" if coding.get("system") else str(coding["code"])
    return None


def _bare(token: str) -> str:
    return token.split("|", 1)[1] if "|" in token else token


def _matches(qualified: str | None, allowed: list[str]) -> bool:
    """Allowed entries and the payload's coding may each be `system|code` or a bare code; a bare side matches on the code."""
    if qualified is None:
        return False
    for a in allowed:
        if a == qualified or (("|" not in a or "|" not in qualified) and _bare(a) == _bare(qualified)):
            return True
    return False


def _range_for(code: str | None, ranges: dict[str, Any]) -> dict[str, Any] | None:
    if code is None:
        return None
    if code in ranges:
        return ranges[code]
    for key, value in ranges.items():
        if _bare(key) == _bare(code):
            return value
    return None


def _check_quantity(label: str, quantity: Any, unit: str | None, rng: dict[str, Any] | None, problems: list[str]) -> None:
    if not isinstance(quantity, dict) or not isinstance(quantity.get("value"), (int, float)) or isinstance(quantity.get("value"), bool):
        problems.append(f"{label}: a numeric value is required")
        return
    value = quantity["value"]
    given_unit, given_code = quantity.get("unit"), quantity.get("code")
    # The unit is fixed by the form; a payload may repeat it as the display unit or the UCUM code, or omit it.
    if unit and not (given_unit == unit or given_code == unit) and (given_unit is not None or given_code is not None):
        problems.append(f"{label}: the value must be in {unit}, not {given_unit or given_code}")
    if rng is not None:
        lo, hi = rng.get("min"), rng.get("max")
        if (lo is not None and value < lo) or (hi is not None and value > hi):
            shown_unit = f" {unit}" if unit else ""
            problems.append(f"{label}: {value:g}{shown_unit} is outside the accepted range {lo:g}–{hi:g}")


def _component_value(components: list[Any], code: str) -> float | None:
    """The numeric value of the component with this (qualified or bare) code, if present and numeric."""
    for comp in components:
        if isinstance(comp, dict) and _matches(_qualified(comp.get("code")), [code]):
            value = (comp.get("valueQuantity") or {}).get("value") if isinstance(comp.get("valueQuantity"), dict) else None
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    return None


def _number(n: float) -> str:
    """A number as JavaScript prints it: no trailing .0 on whole numbers — the two validators must agree to the character."""
    return str(int(n)) if float(n).is_integer() else str(n)


def validate_observation_entry(config: Resource, observation: Any, patient_id: str, now: datetime) -> list[str]:
    """The Observation an entry form produced, against what the manifest allows it to record.

    config: codes (qualified, allowed as Observation.code), components (qualified codes a panel must carry,
    optional), unit, ranges ({qualified code: {min, max}}), max_backdate_days, rules ([{component, above, message?}]:
    one component's value must be above another's — systolic above diastolic; judged once both are numeric).
    """
    problems: list[str] = []
    if not isinstance(observation, dict) or observation.get("resourceType") != "Observation":
        return ["payload must be an Observation"]

    allowed_codes = [str(c) for c in (config.get("codes") or [])]
    code = _qualified(observation.get("code"))
    if not _matches(code, allowed_codes):
        problems.append(f"code {code or '(none)'} is not one this form may record ({', '.join(allowed_codes)})")

    claimed = (observation.get("subject") or {}).get("reference")
    if claimed and claimed != f"Patient/{patient_id}":
        problems.append(f"observation subject {claimed} is not the patient in context")

    unit = config.get("unit")
    ranges = config.get("ranges") or {}
    components_expected = [str(c) for c in (config.get("components") or [])]
    components = observation.get("component")
    if components_expected:
        given = components if isinstance(components, list) else []
        seen: list[str] = []
        for comp in given:
            comp_code = _qualified(comp.get("code")) if isinstance(comp, dict) else None
            if not _matches(comp_code, components_expected):
                problems.append(f"component {comp_code or '(none)'} is not part of this form")
                continue
            seen.append(comp_code or "")
            _check_quantity(f"component {comp_code}", comp.get("valueQuantity"), unit, _range_for(comp_code, ranges), problems)
        for expected in components_expected:
            if not any(_matches(s, [expected]) for s in seen):
                problems.append(f"component {expected} is missing")
        if observation.get("valueQuantity") is not None:
            problems.append("a panel carries its values in components, not a single value")
        # Relations between components — a swapped systolic/diastolic is a common slip and a physiologically impossible
        # panel; only judged when both values are there and numeric (their own problems are named above).
        for rule in config.get("rules") or []:
            if not isinstance(rule, dict):
                continue
            a = _component_value(given, str(rule.get("component", "")))
            b = _component_value(given, str(rule.get("above", "")))
            if a is None or b is None or a > b:
                continue
            what = rule.get("message") or f"component {rule.get('component')} must be above component {rule.get('above')}"
            problems.append(f"{what} ({_number(a)} vs {_number(b)}{f' {unit}' if unit else ''})")
    else:
        if components:
            problems.append("this form records a single value, not components")
        _check_quantity("value", observation.get("valueQuantity"), unit, _range_for(code, ranges), problems)

    effective = observation.get("effectiveDateTime")
    if effective is not None:
        when = _parse_iso(str(effective))
        if when is None:
            problems.append("effective date is not a valid date-time")
        else:
            if when > now + timedelta(minutes=5):
                problems.append("effective date must not be in the future")
            max_days = int(config.get("max_backdate_days", 7) or 0)
            if when < now - timedelta(days=max_days):
                problems.append(f"effective date must not be more than {max_days} days ago")

    # The side of the body and the structure measured, as bodySite codings: one SNOMED laterality qualifier when the form
    # asks for a side (and only then), the declared structure and nothing else besides.
    side = config.get("side")
    body_site = config.get("body_site")
    codings = [c for c in ((observation.get("bodySite") or {}).get("coding") or []) if isinstance(c, dict)]
    sides = [c for c in codings if c.get("system") == SNOMED_SYSTEM and str(c.get("code")) in LATERALITY]
    others = [c for c in codings if c not in sides]
    if len(sides) > 1:
        problems.append("bodySite names more than one side")
    if sides and not side:
        problems.append("this form does not record a side of the body")
    if side == "required" and not sides:
        problems.append("the side of the body is required: left, right or both")
    for c in others:
        q = f"{c['system']}|{c.get('code', '')}" if c.get("system") else str(c.get("code") or "")
        if not body_site or not _matches(q, [str(body_site)]):
            problems.append(f"bodySite {q or '(none)'} is not the structure this form records" + (f" ({body_site})" if body_site else ""))
    # Test conditions: one of the offered codes, or none; a form that offers none takes none.
    conditions = [str(c) for c in (config.get("conditions") or [])]
    if observation.get("method") is not None:
        method = _qualified(observation.get("method"))
        if not conditions:
            problems.append("this form does not record test conditions")
        elif not _matches(method, conditions):
            problems.append(f"method {method or '(none)'} is not one of the test conditions this form offers ({', '.join(conditions)})")
    return problems


def validate_status_change(config: Resource, change: Any, current: Resource | None, resource_type: str, status_field: str, patient_id: str) -> list[str]:
    """A status change {id, status, versionId?, reason?} for a Condition, MedicationRequest or Task of the patient in context.

    config: allowed (target status codes). `current` is the resource as read from the record (None if absent).
    """
    problems: list[str] = []
    if not isinstance(change, dict):
        return ["payload must be a status change {id, status}"]
    target_id = change.get("id")
    if not isinstance(target_id, str) or not target_id:
        problems.append("target id is required")
    allowed = [str(s) for s in (config.get("allowed") or [])]
    status = change.get("status")
    if not isinstance(status, str) or status not in allowed:
        shown = status if isinstance(status, str) else "(none)"
        problems.append(f"status '{shown}' is not one of {', '.join(allowed)}")
    if problems:
        return problems
    if current is None:
        return [f"{resource_type}/{target_id} was not found"]
    subject = (current.get("subject") or current.get("patient") or current.get("for") or {}).get("reference")  # Task names its patient `for`
    if subject != f"Patient/{patient_id}":
        return [f"{resource_type}/{target_id} belongs to another patient"]
    current_status = _current_status(current, status_field)
    if current_status == status:
        problems.append(f"{resource_type}/{target_id} is already {status}")
    return problems


def _current_status(resource: Resource, status_field: str) -> str | None:
    value = resource.get(status_field)
    if isinstance(value, dict):  # a CodeableConcept such as Condition.clinicalStatus
        for coding in value.get("coding") or []:
            if coding.get("code"):
                return str(coding["code"])
        return None
    return str(value) if value is not None else None


# ── coded entries: a problem, an allergy, a procedure ─────────────────────────────────────────

# SNOMED CT severity codes — the only ones a severity may carry (Condition.severity; a reaction's severity is a code).
SEVERITY_CODES = {"255604002": "mild", "6736007": "moderate", "24484000": "severe"}
REACTION_SEVERITIES = ("mild", "moderate", "severe")
CRITICALITIES = ("low", "high", "unable-to-assess")


def _code_of(concept: Any) -> str | None:
    for coding in ((concept or {}).get("coding") or []) if isinstance(concept, dict) else []:
        if isinstance(coding, dict) and coding.get("code"):
            return str(coding["code"])
    return None


def _check_past_date(label: str, value: Any, now: datetime, problems: list[str], max_days: int | None = None) -> None:
    """A date or date-time that must parse and must not lie in the future (five minutes of clock skew allowed)."""
    if value is None:
        return
    when = _parse_iso(str(value)) if isinstance(value, str) else None
    if when is None:
        problems.append(f"{label} is not a valid date")
        return
    if when > now + timedelta(minutes=5):
        problems.append(f"{label} must not be in the future")
    if max_days is not None and when < now - timedelta(days=max_days):
        problems.append(f"{label} must not be more than {max_days} days ago")


def _check_one_of(label: str, value: Any, allowed: list[str], problems: list[str]) -> None:
    if not isinstance(value, str) or value not in allowed:
        shown = value if isinstance(value, str) else "(none)"
        problems.append(f"{label} '{shown}' is not one of {', '.join(allowed)}")


def _check_code(payload_code: str | None, allowed: list[str], problems: list[str]) -> None:
    if not _matches(payload_code, allowed):
        problems.append(f"code {payload_code or '(none)'} is not one this form may record ({', '.join(allowed)})")


def _check_subject(label: str, claimed: Any, patient_id: str, problems: list[str]) -> None:
    if claimed and claimed != f"Patient/{patient_id}":
        problems.append(f"{label} {claimed} is not the patient in context")


def _strs(config: Resource, key: str, default: list[str]) -> list[str]:
    value = config.get(key)
    return [str(v) for v in value] if isinstance(value, list) and value else default


def validate_condition_entry(config: Resource, condition: Any, patient_id: str, now: datetime) -> list[str]:
    """The Condition an entry form produced: one of the allowed codes, active, verified as offered, with an onset in the past."""
    problems: list[str] = []
    if not isinstance(condition, dict) or condition.get("resourceType") != "Condition":
        return ["payload must be a Condition"]
    _check_code(_qualified(condition.get("code")), [str(c) for c in (config.get("codes") or [])], problems)
    _check_subject("condition subject", (condition.get("subject") or {}).get("reference"), patient_id, problems)
    clinical = _code_of(condition.get("clinicalStatus"))
    if clinical is not None and clinical != "active":
        problems.append(f"a new problem is recorded as active, not '{clinical}'")
    verification = _code_of(condition.get("verificationStatus"))
    if verification is not None:
        _check_one_of("verification status", verification, _strs(config, "verification", ["confirmed"]), problems)
    if condition.get("severity") is not None:
        severity = _code_of(condition.get("severity"))
        if not config.get("severity"):
            problems.append("severity is not part of this form")
        elif not severity or severity not in SEVERITY_CODES:
            problems.append(f"severity '{severity or '(none)'}' is not mild, moderate or severe")
    _check_past_date("onset", condition.get("onsetDateTime"), now, problems)
    return problems


def validate_allergy_entry(config: Resource, allergy: Any, patient_id: str, now: datetime) -> list[str]:
    """The AllergyIntolerance an entry form produced: an allowed substance, active, typed and categorised as offered."""
    problems: list[str] = []
    if not isinstance(allergy, dict) or allergy.get("resourceType") != "AllergyIntolerance":
        return ["payload must be an AllergyIntolerance"]
    _check_code(_qualified(allergy.get("code")), [str(c) for c in (config.get("codes") or [])], problems)
    _check_subject("allergy patient", (allergy.get("patient") or {}).get("reference"), patient_id, problems)
    clinical = _code_of(allergy.get("clinicalStatus"))
    if clinical is not None and clinical != "active":
        problems.append(f"a new allergy is recorded as active, not '{clinical}'")
    verification = _code_of(allergy.get("verificationStatus"))
    if verification is not None:
        _check_one_of("verification status", verification, _strs(config, "verification", ["confirmed", "unconfirmed"]), problems)
    if allergy.get("type") is not None:
        _check_one_of("type", allergy.get("type"), _strs(config, "types", ["allergy", "intolerance"]), problems)
    categories = allergy.get("category") if isinstance(allergy.get("category"), list) else []
    if not categories:
        problems.append("a category is required")
    for cat in categories:
        _check_one_of("category", cat, _strs(config, "categories", ["medication", "food", "environment"]), problems)
    if allergy.get("criticality") is not None:
        if config.get("criticality") is False:
            problems.append("criticality is not part of this form")
        elif allergy.get("criticality") not in CRITICALITIES:
            problems.append(f"criticality '{allergy.get('criticality')}' is not low, high or unable-to-assess")
    reactions = allergy.get("reaction") if isinstance(allergy.get("reaction"), list) else []
    if reactions and config.get("reaction") is False:
        problems.append("a reaction is not part of this form")
    for r in reactions:
        manifestation = r.get("manifestation") if isinstance(r, dict) and isinstance(r.get("manifestation"), list) else []
        if not any(isinstance(m, dict) and ((isinstance(m.get("text"), str) and m["text"].strip()) or _code_of(m)) for m in manifestation):
            problems.append("a reaction needs its manifestation")
        if isinstance(r, dict) and r.get("severity") is not None and r.get("severity") not in REACTION_SEVERITIES:
            problems.append(f"reaction severity '{r.get('severity')}' is not mild, moderate or severe")
    _check_past_date("onset", allergy.get("onsetDateTime"), now, problems)
    return problems


def validate_procedure_entry(config: Resource, procedure: Any, patient_id: str, now: datetime) -> list[str]:
    """The Procedure an entry form produced: an allowed code, an offered status, performed within the window."""
    problems: list[str] = []
    if not isinstance(procedure, dict) or procedure.get("resourceType") != "Procedure":
        return ["payload must be a Procedure"]
    _check_code(_qualified(procedure.get("code")), [str(c) for c in (config.get("codes") or [])], problems)
    _check_subject("procedure subject", (procedure.get("subject") or {}).get("reference"), patient_id, problems)
    _check_one_of("status", procedure.get("status"), _strs(config, "statuses", ["completed"]), problems)
    if procedure.get("performedDateTime") is None:
        problems.append("performed date is required")
    else:
        _check_past_date("performed date", procedure.get("performedDateTime"), now, problems, int(config.get("max_backdate_days", 30) or 0))
    if procedure.get("bodySite") and not config.get("body_site"):
        problems.append("body site is not part of this form")
    if procedure.get("outcome") is not None and not config.get("outcome"):
        problems.append("outcome is not part of this form")
    return problems


# ── a task ───────────────────────────────────────────────────────────────────────────────────────


def validate_task_entry(config: Resource, task: Any, patient_id: str, now: datetime) -> list[str]:
    """The Task a form produced: an allowed code, a priority the form offers, requested, due today or later."""
    problems: list[str] = []
    if not isinstance(task, dict) or task.get("resourceType") != "Task":
        return ["payload must be a Task"]
    _check_code(_qualified(task.get("code")), [str(c) for c in (config.get("codes") or [])], problems)
    _check_subject("task patient", (task.get("for") or {}).get("reference"), patient_id, problems)
    if task.get("status") is not None and task.get("status") != "requested":
        problems.append(f"a new task is requested, not '{task.get('status')}'")
    if task.get("priority") is not None:
        _check_one_of("priority", task.get("priority"), _strs(config, "priorities", ["routine", "urgent"]), problems)
    due = ((task.get("restriction") or {}).get("period") or {}).get("end")
    if due is not None:
        if config.get("due") is False:
            problems.append("a due date is not part of this form")
        else:
            when = _parse_iso(str(due)) if isinstance(due, str) else None
            if when is None:
                problems.append("due date is not a valid date")
            elif when < now.replace(hour=0, minute=0, second=0, microsecond=0):
                problems.append("due date must not be in the past")
    description = task.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > 500):
        problems.append("description must be text of at most 500 characters")
    return problems


# ── a photo ──────────────────────────────────────────────────────────────────────────────────────

IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")


def _human_size(n: int) -> str:
    """`1.7 MB` from a megabyte up, `320 KB` below — the same words as writes.ts `humanSize`."""
    return f"{n / 1_000_000:.1f} MB" if n >= 1_000_000 else f"{round(n / 1000)} KB"


def decoded_image_size(data: Any) -> int | None:
    """The byte size of a base64 payload, or None when it is not valid base64."""
    if not isinstance(data, str) or not data:
        return None
    try:
        import base64  # noqa: PLC0415

        return len(base64.b64decode(data, validate=True))
    except (ValueError, TypeError):
        return None


def validate_media_entry(config: Resource, media: Any, patient_id: str, now: datetime) -> list[str]:
    """The Media a photo form produced: a photo of an allowed kind, of the patient in context, an image of an accepted
    type and size, taken within the window. The bytes travel in content.data and are stored elsewhere."""
    problems: list[str] = []
    if not isinstance(media, dict) or media.get("resourceType") != "Media":
        return ["payload must be a Media"]
    media_type = _code_of(media.get("type"))
    if media_type is not None and media_type != "photo":
        problems.append(f"a photo is recorded, not '{media_type}'")
    reasons = media.get("reasonCode") if isinstance(media.get("reasonCode"), list) else []
    _check_code(_qualified(reasons[0]) if reasons else None, [str(c) for c in (config.get("kinds") or [])], problems)
    _check_subject("photo subject", (media.get("subject") or {}).get("reference"), patient_id, problems)
    content = media.get("content") if isinstance(media.get("content"), dict) else {}
    content_type = content.get("contentType")
    if content_type not in IMAGE_TYPES:
        problems.append(f"content type '{content_type or '(none)'}' is not one of {', '.join(IMAGE_TYPES)}")
    size = decoded_image_size(content.get("data"))
    if content.get("data") in (None, ""):
        problems.append("the photo has no image data")
    elif size is None:
        problems.append("image data is not valid base64")
    else:
        max_bytes = int(config.get("max_bytes") or 1_500_000)
        if size > max_bytes:
            problems.append(f"the image is {_human_size(size)}; the form accepts up to {_human_size(max_bytes)}")
    if media.get("bodySite") is not None and not config.get("body_site"):
        problems.append("body site is not part of this form")
    _check_past_date("taken date", media.get("createdDateTime"), now, problems, int(config.get("max_backdate_days", 30) or 0))
    return problems


__all__ = ["validate_observation_entry", "validate_status_change", "validate_condition_entry", "validate_allergy_entry", "validate_procedure_entry", "validate_task_entry", "validate_media_entry", "decoded_image_size", "SEVERITY_CODES", "IMAGE_TYPES"]
