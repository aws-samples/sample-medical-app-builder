"""
The record vocabulary — which codes the connected FHIR server actually holds, read from the server itself.

The drafting assistant resolves a clinician's words ("ferritin over two years") to codes through `lookup_codes`. Its
hand-written hints (application-catalog.yaml) cover a few dozen concepts; a hospital's record holds hundreds of
laboratory codes alone, with display texts in its own language. This module reads the record's distinct codes — one
`_elements` search per resource type, pages of 500, no patient data kept beyond a count of distinct subjects — and
writes one JSON document the assistant searches by display text and by code:

    {"version": 1, "built_at": "…", "source": "https://…/fhir", "complete": true,
     "scanned": {"Observation": 62314, "Condition": 977, …},
     "codes": [{"resource": "Observation", "system": "http://loinc.org", "code": "718-7", "display": "Hämoglobin",
                "displays": ["Hämoglobin", "Hemoglobin"], "count": 3180, "patients": 50, "unit": "g/dL",
                "category": "laboratory", "components": [], "component_of": [], "also_coded_as": []}, …]}

`also_coded_as` lists the other codings the record puts on the same resources (a Condition carrying both SNOMED CT and
ICD-10-GM): what lets the assistant move from the coding a hint knows to the coding the hospital uses.

Built by the seed function of whichever stack is the data source (at deploy, and nightly), stored in the authoring
stack's bucket, read by the drafting agent at start. The scan watches a time budget: a record too large to finish is
stored as far as it got (`complete: false`) and completed by the next refresh — a deployment never waits on it.
"""

from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Iterator

from fhir_source import Resource, UpstreamError

VERSION = 1
DEFAULT_KEY = "record-vocabulary.json"
PAGE_SIZE = 500
DEFAULT_BUDGET_S = 150.0
MAX_DISPLAYS = 3
MAX_ALTERNATES = 5


@dataclass(frozen=True)
class ResourceSpec:
    """Where a resource type keeps its code and its patient, and which other elements the vocabulary reads."""

    resource_type: str
    code_element: str = "code"
    subject_element: str = "subject"
    extra_elements: tuple[str, ...] = ()

    @property
    def elements(self) -> str:
        return ",".join((self.code_element, self.subject_element, *self.extra_elements))


# The types the catalog's primitives search by code. Observations also carry the unit, the category (laboratory,
# vital-signs) and the components of a panel (blood pressure); reports their category.
RESOURCE_SPECS: tuple[ResourceSpec, ...] = (
    ResourceSpec("Observation", extra_elements=("category", "valueQuantity", "component")),
    ResourceSpec("Condition"),
    ResourceSpec("Procedure"),
    ResourceSpec("MedicationRequest", code_element="medicationCodeableConcept"),
    ResourceSpec("MedicationStatement", code_element="medicationCodeableConcept"),
    ResourceSpec("DiagnosticReport", extra_elements=("category",)),
    ResourceSpec("AllergyIntolerance", subject_element="patient"),
    ResourceSpec("Immunization", code_element="vaccineCode", subject_element="patient"),
)


@dataclass
class _Tally:
    count: int = 0
    patients: set[str] = field(default_factory=set)
    displays: Counter = field(default_factory=Counter)
    units: Counter = field(default_factory=Counter)
    categories: Counter = field(default_factory=Counter)
    components: set[str] = field(default_factory=set)
    component_of: set[str] = field(default_factory=set)
    # The other codings the record puts on the same resources — a Condition coded in SNOMED CT *and* ICD-10-GM.
    alternates: Counter = field(default_factory=Counter)
    alternate_displays: dict[tuple[str, str], Counter] = field(default_factory=lambda: defaultdict(Counter))

    def entry(self, resource_type: str, system: str, code: str) -> dict[str, Any]:
        displays = [d for d, _ in self.displays.most_common(MAX_DISPLAYS) if d]
        also = [
            {"system": alt_system, "code": alt_code, "display": _most_common(self.alternate_displays[(alt_system, alt_code)]) or "", "count": n}
            for (alt_system, alt_code), n in self.alternates.most_common(MAX_ALTERNATES)
        ]
        return {
            "resource": resource_type,
            "system": system,
            "code": code,
            "display": displays[0] if displays else "",
            "displays": displays,
            "count": self.count,
            "patients": len(self.patients),
            "unit": _most_common(self.units),
            "category": _most_common(self.categories),
            "components": sorted(self.components),
            "component_of": sorted(self.component_of),
            "also_coded_as": also,
        }


def _most_common(counter: Counter) -> str | None:
    return next((value for value, _ in counter.most_common(1) if value), None)


def _codings(concept: Any) -> list[tuple[str, str, str]]:
    """(system, code, display) for each coding of a CodeableConcept; a concept with only a text yields nothing."""
    if not isinstance(concept, dict):
        return []
    out = []
    for coding in concept.get("coding") or []:
        if isinstance(coding, dict) and coding.get("code"):
            out.append((str(coding.get("system") or ""), str(coding["code"]), str(coding.get("display") or concept.get("text") or "")))
    return out


def _quantity_unit(quantity: Any) -> str | None:
    """The UCUM code when the record has one (`mm[Hg]`, what the catalog's hints and the specs use), else the unit text."""
    if not isinstance(quantity, dict):
        return None
    return str(quantity.get("code") or quantity.get("unit") or "") or None


def _category(resource: Resource) -> str | None:
    for concept in resource.get("category") or []:
        for _system, code, _display in _codings(concept):
            return code
    return None


class Tallies:
    """The aggregation: (resource type, system, code) → what the record says about that code."""

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str, str], _Tally] = defaultdict(_Tally)

    def add(self, spec: ResourceSpec, resource: Resource) -> None:
        subject = str(((resource.get(spec.subject_element) or {}).get("reference")) or "")
        unit = _quantity_unit(resource.get("valueQuantity"))
        category = _category(resource)
        parents = _codings(resource.get(spec.code_element))
        for system, code, display in parents:
            tally = self._by_key[(spec.resource_type, system, code)]
            tally.count += 1
            if subject:
                tally.patients.add(subject)
            if display:
                tally.displays[display] += 1
            if unit:
                tally.units[unit] += 1
            if category:
                tally.categories[category] += 1
            for alt_system, alt_code, alt_display in parents:
                if (alt_system, alt_code) != (system, code):
                    tally.alternates[(alt_system, alt_code)] += 1
                    if alt_display:
                        tally.alternate_displays[(alt_system, alt_code)][alt_display] += 1
        for component in resource.get("component") or []:
            if not isinstance(component, dict):
                continue
            component_unit = _quantity_unit(component.get("valueQuantity"))
            for system, code, display in _codings(component.get("code")):
                tally = self._by_key[(spec.resource_type, system, code)]
                tally.count += 1
                if subject:
                    tally.patients.add(subject)
                if display:
                    tally.displays[display] += 1
                if component_unit:
                    tally.units[component_unit] += 1
                if category:
                    tally.categories[category] += 1
                for _psystem, pcode, _pdisplay in parents:
                    tally.component_of.add(pcode)
                    self._by_key[(spec.resource_type, _psystem, pcode)].components.add(code)

    def entries(self) -> list[dict[str, Any]]:
        order = {spec.resource_type: i for i, spec in enumerate(RESOURCE_SPECS)}
        items = [tally.entry(resource_type, system, code) for (resource_type, system, code), tally in self._by_key.items()]
        # By type, then the commonest first; a panel's components (as common as the panel itself) follow the panel.
        return sorted(items, key=lambda e: (order.get(e["resource"], len(order)), -e["count"], 1 if e["component_of"] and not e["components"] else 0, e["system"], e["code"]))


def count_resources(source: Any, resource_type: str) -> int | None:
    """How many resources of a type the server holds (`_summary=count`); None when the server will not say."""
    get = getattr(source, "get", None)
    if get is None:
        return len(source.search(resource_type, {}))
    try:
        bundle = get(f"{resource_type}?_summary=count")
    except UpstreamError:
        return None
    total = bundle.get("total") if isinstance(bundle, dict) else None
    return int(total) if total is not None else None


def _pages(source: Any, spec: ResourceSpec, page_size: int) -> Iterator[list[Resource]]:
    params = {"_elements": spec.elements, "_count": str(page_size)}
    iterate = getattr(source, "iter_search", None)
    if iterate is not None:
        yield from iterate(spec.resource_type, params, max_pages=1_000_000)
    else:
        yield source.search(spec.resource_type, params)


def build_vocabulary(
    source: Any,
    specs: Iterable[ResourceSpec] = RESOURCE_SPECS,
    budget_s: float = DEFAULT_BUDGET_S,
    page_size: int = PAGE_SIZE,
    clock: Callable[[], float] = time.monotonic,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Read the distinct codes of every listed type within `budget_s` seconds. Each type is counted first (one cheap
    call), then paged; a type the server refuses is noted and skipped; when the budget runs out the document says so
    and lists what was not (fully) read. Nothing per patient is kept — subjects are counted, not stored.
    """
    started = clock()
    tallies = Tallies()
    scanned: dict[str, int] = {}
    totals: dict[str, int | None] = {}
    notes: list[str] = []
    complete = True
    for spec in specs:
        if clock() - started > budget_s:
            complete = False
            notes.append(f"{spec.resource_type}: not read, the time budget ran out")
            continue
        try:
            total = count_resources(source, spec.resource_type)
        except UpstreamError as err:
            notes.append(f"{spec.resource_type}: {err}")
            continue
        totals[spec.resource_type] = total
        if total == 0:
            scanned[spec.resource_type] = 0
            continue
        read = 0
        try:
            for page in _pages(source, spec, page_size):
                for resource in page:
                    tallies.add(spec, resource)
                read += len(page)
                if clock() - started > budget_s:
                    complete = False
                    notes.append(f"{spec.resource_type}: {read} of {total if total is not None else '?'} read before the time budget ran out")
                    break
        except UpstreamError as err:
            notes.append(f"{spec.resource_type}: {err} after {read} resources")
        scanned[spec.resource_type] = read
    codes = tallies.entries()
    return {
        "version": VERSION,
        "built_at": (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": str(getattr(source, "base_url", "") or ""),
        "complete": complete,
        "duration_s": round(clock() - started, 1),
        "scanned": scanned,
        "totals": {k: v for k, v in totals.items() if v is not None},
        "notes": notes,
        "codes": codes,
    }


def summarize(doc: dict[str, Any]) -> str:
    """One line for a deployment's findings: '412 codes from 63,710 resources (Observation 62,314, Condition 977, …)'."""
    scanned = doc.get("scanned") or {}
    parts = ", ".join(f"{k} {v:,}" for k, v in scanned.items() if v)
    line = f"{len(doc.get('codes') or []):,} codes from {sum(scanned.values()):,} resources" + (f" ({parts})" if parts else "")
    if not doc.get("complete", True):
        line += " — partial: " + "; ".join(doc.get("notes") or ["the time budget ran out"])
    return line


def store_vocabulary(doc: dict[str, Any], bucket: str, key: str = DEFAULT_KEY, client: Any = None) -> str:
    """Write the document to the bucket (one object, replaced each time) and return its s3:// URI."""
    if client is None:
        import boto3

        client = boto3.client("s3")
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json; charset=utf-8", CacheControl="no-cache")
    return f"s3://{bucket}/{key}"
