"""
Declared-shape records — the dispatcher's half, the mirror of med_app/src/primitives/data/recordShape.ts. A
`write.fhir.record.create` config carries the resource type, the fields (each with its element path and encoding, as the
compiler resolved them against the StructureDefinitions) and the stamps. This module reads and writes values at paths,
validates a payload against the declared fields — refusing by name any element the shape did not declare — and applies
the stamps. Same rules, same words as the TypeScript side; writeCases.json `record_cases` asserts both.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime, timedelta, timezone
from typing import Any

_SEGMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$")
_INDEX = re.compile(r"\[\d+\]")

ALWAYS_ALLOWED = ("resourceType", "identifier", "meta")


def parse_path(path: str) -> list[tuple[str, int | None]]:
    out: list[tuple[str, int | None]] = []
    for part in path.split("."):
        m = _SEGMENT.match(part)
        if not m:
            raise ValueError(f'bad path segment "{part}" in "{path}"')
        out.append((m.group(1), int(m.group(2)) if m.group(2) is not None else None))
    return out


def get_path(root: Any, path: str) -> Any:
    cur = root
    for key, index in parse_path(path):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
        if index is not None:
            cur = cur[index] if isinstance(cur, list) and index < len(cur) else None
    return cur


def set_path(root: dict[str, Any], path: str, value: Any) -> None:
    """Writes `value` at `path`, creating objects and arrays on the way; None removes the leaf."""
    segs = parse_path(path)
    cur: Any = root
    for i, (key, index) in enumerate(segs):
        last = i == len(segs) - 1
        if index is None:
            if last:
                if value is None:
                    cur.pop(key, None)
                else:
                    cur[key] = value
                return
            if not isinstance(cur.get(key), dict):
                cur[key] = {}
            cur = cur[key]
        else:
            if not isinstance(cur.get(key), list):
                cur[key] = []
            arr = cur[key]
            while len(arr) <= index:
                arr.append({})
            if last:
                if value is None:
                    del arr[index]
                else:
                    arr[index] = value
                return
            if not isinstance(arr[index], dict):
                arr[index] = {}
            cur = arr[index]


def leaf_paths(value: Any, prefix: str = "") -> list[str]:
    if not isinstance(value, (dict, list)):
        return [prefix] if prefix else []
    if isinstance(value, list):
        return [p for i, v in enumerate(value) for p in leaf_paths(v, f"{prefix}[{i}]")]
    if not value:
        return [prefix] if prefix else []
    return [p for k, v in value.items() for p in leaf_paths(v, f"{prefix}.{k}" if prefix else k)]


def _covers(declared: str, leaf: str) -> bool:
    return leaf == declared or leaf.startswith(f"{declared}.")


def _num(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def _parse_iso(value: str) -> datetime | None:
    try:
        text = value[:-1] + "+00:00" if value.endswith("Z") else value
        d = datetime.fromisoformat(text)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _from_base64(data: Any) -> str | None:
    if not isinstance(data, str):
        return None
    try:
        return base64.b64decode(data, validate=True).decode("utf-8")
    except Exception:  # noqa: BLE001
        return None


def _check_field(field: dict[str, Any], value: Any, now: datetime, problems: list[str]) -> None:
    name = f'"{field.get("label")}"'
    if value is None:
        if field.get("required"):
            problems.append(f"{name} is required")
        return
    enc = field.get("as")
    if enc in ("string", "concept_text", "attachment_text"):
        if enc == "string":
            text = value
        elif enc == "concept_text":
            text = value.get("text") if isinstance(value, dict) else None
        else:
            text = _from_base64(value.get("data")) if isinstance(value, dict) else None
        if not isinstance(text, str) or not text.strip():
            problems.append(f"{name}: text is required")
            return
        if enc == "attachment_text" and value.get("contentType") != "text/plain":
            problems.append(f"{name}: the attachment must be text/plain")
        max_length = field.get("max_length")
        if max_length and len(text) > max_length:
            problems.append(f"{name}: {len(text)} characters is more than the {max_length} allowed")
        return
    if enc in ("quantity", "decimal", "integer"):
        n = value.get("value") if enc == "quantity" and isinstance(value, dict) else value
        if isinstance(n, bool) or not isinstance(n, (int, float)):
            problems.append(f"{name}: a numeric value is required")
            return
        if enc == "integer" and not float(n).is_integer():
            problems.append(f"{name}: a whole number is required")
        unit = field.get("unit")
        if enc == "quantity" and unit and isinstance(value, dict):
            given = value.get("unit", value.get("code"))
            if given is not None and given != unit:
                problems.append(f"{name}: the value must be in {unit}, not {given}")
        rng = field.get("range") or {}
        lo, hi = rng.get("min"), rng.get("max")
        if (lo is not None and n < lo) or (hi is not None and n > hi):
            shown_unit = f" {unit}" if unit else ""
            problems.append(f"{name}: {_num(n)}{shown_unit} is outside the accepted range {_num(lo) if lo is not None else '…'}–{_num(hi) if hi is not None else '…'}")
        return
    if enc == "boolean":
        if not isinstance(value, bool):
            problems.append(f"{name}: yes or no")
        return
    if enc in ("date", "datetime"):
        if not isinstance(value, str):
            problems.append(f"{name} is not a valid date")
            return
        if enc == "date" and not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            problems.append(f"{name} is not a valid date")
            return
        when = _parse_iso(value)
        if when is None:
            problems.append(f"{name} is not a valid date")
            return
        past, future = field.get("past_days"), field.get("future_days")
        if past is not None and when < now - timedelta(days=past):
            problems.append(f"{name} must not be more than {past} days ago")
        if future is not None and when > now + timedelta(days=future + 1):
            problems.append(f"{name} must not be more than {future} days ahead")
        return
    if enc in ("codeable_concept", "coding", "code"):
        if enc == "codeable_concept":
            codings = value.get("coding") if isinstance(value, dict) else None
            coding = codings[0] if isinstance(codings, list) and codings and isinstance(codings[0], dict) else {}
        elif enc == "coding":
            coding = value if isinstance(value, dict) else {}
        else:
            coding = {"code": value}
        codes = field.get("codes")
        system = field.get("system")
        if codes:
            allowed = [f"{c['system']}|{c['code']}" for c in codes]
        else:
            allowed = [f"{system}|{o['code']}" if system and enc != "code" else o["code"] for o in field.get("options") or []]
        code = coding.get("code")
        if code is None:
            given = None
        elif enc == "code" or (not system and not codes):
            given = str(code)
        else:
            given = f"{coding.get('system') or ''}|{code}"
        if given is None or given not in allowed:
            problems.append(f"{name}: {given if given is not None else '(none)'} is not one of the offered options ({', '.join(allowed)})")
        return


def validate_record_entry(config: dict[str, Any], payload: Any, patient_id: str, now: datetime) -> list[str]:
    """The payload against the shape: resource type, each declared field, and nothing the shape did not declare."""
    resource = str(config.get("resource"))
    if not isinstance(payload, dict) or payload.get("resourceType") != resource:
        return [f"payload must be a {resource}"]
    problems: list[str] = []
    subject = (payload.get("subject") or {}).get("reference") if isinstance(payload.get("subject"), dict) else None
    if subject and subject != f"Patient/{patient_id}":
        problems.append(f"subject {subject} is not the patient in context")
    fields = [f for f in (config.get("fields") or []) if isinstance(f, dict)]
    for field in fields:
        _check_field(field, get_path(payload, str(field.get("path"))), now, problems)
    declared = [str(f.get("path")) for f in fields] + [str(s.get("path")) for s in (config.get("stamps") or []) if isinstance(s, dict)] + list(ALWAYS_ALLOWED)
    seen: set[str] = set()
    for leaf in leaf_paths(payload):
        bare = _INDEX.sub("", leaf)
        if any(_covers(d, leaf) or _covers(_INDEX.sub("", d), bare) for d in declared):
            continue
        if leaf not in seen:
            seen.add(leaf)
            problems.append(f"element {leaf} is not part of this form")
    return problems


def apply_stamps(resource: dict[str, Any], stamps: list[Any] | None, *, patient_id: str, author: Any, now: str) -> None:
    """The stamps with their placeholders filled: who, when, for whom."""
    for s in stamps or []:
        if not isinstance(s, dict):
            continue
        v = s.get("value")
        if v == "$patient":
            v = {"reference": f"Patient/{patient_id}"}
        elif v == "$author":
            v = author
        elif v == "$now":
            v = now
        elif v == "$today":
            v = now[:10]
        set_path(resource, str(s.get("path")), v)


__all__ = ["validate_record_entry", "apply_stamps", "get_path", "set_path", "leaf_paths", "parse_path"]
