"""
The catalog as the agent sees it: which archetypes exist, which of them the compiler can build today
(the JSON Schema has a variant for each), what their knobs mean, what is refused and why, and the
terminology hints. Loaded from the same two files the frontend publishes — nothing is restated here.
Beside the hints sits the record's vocabulary (`vocabulary.py`): the codes actually present on the
connected server, so `lookup_codes` can answer for concepts the hand-written hints never named and can
say which hints the record carries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from .paths import catalog_path, spec_schema_path
from .vocabulary import RecordCode, RecordVocabulary


@dataclass(frozen=True)
class KnobDoc:
    name: str
    description: str
    required: bool
    default: Any = None
    type: str | None = None
    enum: tuple[str, ...] | None = None
    # For a list of tagged items (the sections of a composed page): the kinds an item may be.
    item_kinds: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ArchetypeDoc:
    id: str
    name: str
    intent_class: str
    patient_scope: str
    summary: str
    buildable: bool
    example_requests: dict[str, list[str]]
    triage_signals: tuple[str, ...]
    requires_context: tuple[str, ...]
    role_pattern: str
    limits: tuple[str, ...]
    knobs: tuple[KnobDoc, ...] = ()


@dataclass(frozen=True)
class RefusalDoc:
    id: str
    description: str
    triggers: tuple[str, ...]
    reason: str
    unlock: str


@dataclass(frozen=True)
class CodeHint:
    name: str
    system: str
    code: str
    unit: str | None = None
    components: dict[str, str] = field(default_factory=dict)
    # What the connected record says about this code (`RecordCode.presence()`), or None: not seen there, or no record read.
    record: dict[str, Any] | None = None
    # "hint": from the catalog's hand-written list; "record": found on the connected server alone.
    origin: str = "hint"


def _inline_refs(node: Any, defs: dict[str, Any]) -> Any:
    """`{"$ref": "#/$defs/x"}` → the definition's body, once; references inside the body itself are left as they are."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/") and ref[len("#/$defs/") :] in defs:
            body = defs[ref[len("#/$defs/") :]]
            return {**body, **{k: v for k, v in node.items() if k != "$ref"}}
        return {k: _inline_refs(v, defs) for k, v in node.items()}
    if isinstance(node, list):
        return [_inline_refs(v, defs) for v in node]
    return node


class Catalog:
    def __init__(self, catalog: dict[str, Any], schema: dict[str, Any], vocabulary: RecordVocabulary | None = None):
        self._catalog = catalog
        self._schema = schema
        self._vocabulary = vocabulary if vocabulary is not None else RecordVocabulary.empty_vocabulary()
        self._variants: dict[str, dict[str, Any]] = {}
        # Recursive schemas (a form's items under a heading) are `$ref`s to the document's `$defs`; a variant is validated
        # on its own, so each carries the definitions — without them every `form` knob was refused as unresolvable.
        defs = schema.get("$defs") or {}
        for variant in schema.get("oneOf", []):
            const = variant.get("properties", {}).get("archetype", {}).get("const")
            if const:
                self._variants[const] = {**variant, "$defs": defs} if defs else variant

    @classmethod
    def load(cls, catalog_file: Path | None = None, schema_file: Path | None = None, vocabulary: RecordVocabulary | None = None) -> "Catalog":
        c = yaml.safe_load((catalog_file or catalog_path()).read_text(encoding="utf-8"))
        s = json.loads((schema_file or spec_schema_path()).read_text(encoding="utf-8"))
        return cls(c, s, vocabulary)

    @property
    def vocabulary(self) -> RecordVocabulary:
        return self._vocabulary

    def set_vocabulary(self, vocabulary: RecordVocabulary) -> None:
        """A fresher document (the worker reloads hourly); the prompt is rebuilt from it on the next turn."""
        self._vocabulary = vocabulary

    # ── schema access ──────────────────────────────────────────────────────

    @property
    def schema(self) -> dict[str, Any]:
        return self._schema

    @property
    def buildable_ids(self) -> list[str]:
        return sorted(self._variants)

    def variant_schema(self, archetype_id: str) -> dict[str, Any]:
        try:
            return self._variants[archetype_id]
        except KeyError as e:
            raise KeyError(f"{archetype_id} is not a buildable archetype (have: {', '.join(self.buildable_ids)})") from e

    def common_schema(self) -> dict[str, Any]:
        """Any variant with the archetype-specific parts removed — validates a draft before an archetype is chosen."""
        base = json.loads(json.dumps(next(iter(self._variants.values()))))
        base.get("properties", {}).pop("knobs", None)
        base.get("properties", {}).pop("archetype", None)
        base["required"] = [r for r in base.get("required", []) if r not in ("knobs", "archetype")]
        return base

    # ── archetypes ─────────────────────────────────────────────────────────

    def archetypes(self) -> list[ArchetypeDoc]:
        out = []
        for a in self._catalog.get("archetypes", []):
            aid = a["id"]
            out.append(
                ArchetypeDoc(
                    id=aid,
                    name=a["name"],
                    intent_class=a.get("intent_class", ""),
                    patient_scope=a.get("patient_scope", ""),
                    summary=" ".join(str(a.get("summary", "")).split()),
                    buildable=aid in self._variants,
                    example_requests={k: list(v) for k, v in (a.get("example_requests") or {}).items()},
                    triage_signals=tuple(str(s) for s in a.get("triage_signals", [])),
                    requires_context=tuple(a.get("requires_context", [])),
                    role_pattern=a.get("role_pattern", ""),
                    limits=tuple(a.get("limits", [])),
                    knobs=tuple(self._knob_docs(aid)),
                )
            )
        return out

    def archetype(self, archetype_id: str) -> ArchetypeDoc | None:
        return next((a for a in self.archetypes() if a.id == archetype_id), None)

    def _knob_docs(self, archetype_id: str) -> list[KnobDoc]:
        variant = self._variants.get(archetype_id)
        if not variant:
            return []
        knobs = variant.get("properties", {}).get("knobs", {})
        required = set(knobs.get("required", []))
        docs = []
        for name, prop in knobs.get("properties", {}).items():
            docs.append(
                KnobDoc(
                    name=name,
                    description=prop.get("description", ""),
                    required=name in required,
                    default=prop.get("default"),
                    type=prop.get("type") if isinstance(prop.get("type"), str) else None,
                    enum=tuple(prop["enum"]) if isinstance(prop.get("enum"), list) else None,
                    item_kinds=_item_kinds(prop),
                )
            )
        return docs

    def knob_schema_text(self, archetype_id: str) -> str:
        """
        The archetype's knob object as compact JSON Schema — what the model reads before calling set_knobs. A `$ref`
        to one of the document's definitions (a form's items) is written out once where it appears, so the model sees
        the fields rather than a pointer; the definition's own recursion stays a `$ref`, with `$defs` alongside.
        """
        variant = self._variants.get(archetype_id)
        if not variant:
            return "{}"
        defs = variant.get("$defs") or {}
        knobs = _inline_refs(variant.get("properties", {}).get("knobs", {}), defs)
        text = {**knobs, "$defs": defs} if defs and "$ref" in json.dumps(knobs) else knobs
        return json.dumps(text, ensure_ascii=False)

    # ── refusals and roles ─────────────────────────────────────────────────

    def refusals(self) -> list[RefusalDoc]:
        return [
            RefusalDoc(id=r["id"], description=" ".join(str(r.get("description", "")).split()), triggers=tuple(str(t) for t in r.get("triggers", [])), reason=" ".join(str(r.get("reason", "")).split()), unlock=" ".join(str(r.get("unlock", "")).split()))
            for r in self._catalog.get("refusals", [])
        ]

    def refusal_ids(self) -> list[str]:
        return [r.id for r in self.refusals()]

    def role_patterns(self) -> dict[str, Any]:
        return dict(self._catalog.get("role_patterns", {}))

    def phi_fields(self) -> list[str]:
        role_items = self.common_schema()["properties"]["roles"]["items"]
        return list(role_items["properties"]["phi_fields_visible"]["items"]["enum"])

    # ── terminology ────────────────────────────────────────────────────────

    def code_hints(self) -> list[CodeHint]:
        hints: list[CodeHint] = []
        common = (self._catalog.get("terminology") or {}).get("common_codes") or {}
        for group, entries in common.items():
            if not isinstance(entries, dict):
                continue
            for name, entry in entries.items():
                if not isinstance(entry, dict) or "code" not in entry:
                    continue
                hints.append(CodeHint(name=f"{name} ({group})", system=str(entry.get("system", "")), code=str(entry["code"]), unit=entry.get("unit"), components={k: str(v) for k, v in (entry.get("components") or {}).items()}))
        return hints

    def record_notes(self) -> list[str]:
        """How the hospital's record is coded and what it lacks — what to assume when the clinician names no code."""
        notes = (self._catalog.get("terminology") or {}).get("record_notes") or []
        return [str(n) for n in notes if n]

    def questionnaires(self) -> list[dict[str, str]]:
        """The Questionnaires on the record a structured assessment may render — {url, title, description}."""
        items = (self._catalog.get("terminology") or {}).get("questionnaires") or []
        return [{"url": str(q.get("url", "")), "title": str(q.get("title", "")), "description": str(q.get("description", ""))} for q in items if isinstance(q, dict) and q.get("url")]

    def known_questionnaire(self, url: str) -> bool:
        return any(q["url"] == url for q in self.questionnaires())

    def unknown_questionnaires(self, patch: Any) -> list[tuple[str, str]]:
        """(path, url) for every Questionnaire URL in a knobs patch that is not on the record — the knob of a
        structured assessment (`questionnaire`) and the assessment sections of a composed page (`sections[i].questionnaire`)."""
        found: list[tuple[str, str]] = []
        if not isinstance(patch, dict):
            return found
        url = patch.get("questionnaire")
        if url is not None and not self.known_questionnaire(str(url)):
            found.append(("knobs.questionnaire", str(url)))
        for i, section in enumerate(patch.get("sections") or []):
            if isinstance(section, dict) and section.get("questionnaire") is not None and not self.known_questionnaire(str(section["questionnaire"])):
                found.append((f"knobs.sections.{i}.questionnaire", str(section["questionnaire"])))
        return found

    def systems(self) -> dict[str, str]:
        """Alias → system URL, as `terminology.systems` lists them (loinc → http://loinc.org)."""
        raw = (self._catalog.get("terminology") or {}).get("systems") or {}
        return {str(k): str(v) for k, v in raw.items() if v}

    def system_alias(self, system_url: str) -> str:
        """The catalog's alias for a system URL, or the URL itself (the spec accepts either)."""
        return next((alias for alias, url in self.systems().items() if url == system_url), system_url)

    def _hint_matches(self, term: str) -> list[CodeHint]:
        """Substring match on the hint names (e.g. "blood pressure", "hba1c", "hypertension")."""
        needle = term.lower().replace(" ", "_").replace("-", "_")
        words = [w for w in term.lower().split() if len(w) > 2]
        out = []
        for h in self.code_hints():
            hay = h.name.lower()
            if needle in hay or any(w in hay for w in words) or term.strip() == h.code:
                out.append(h)
        return out

    def lookup_codes(self, term: str) -> list[CodeHint]:
        """
        The hints that match, each marked with what the record says about it (`record`, None when the record does not
        carry the code or none was read), followed by codes found on the record alone (`origin == "record"`) — their
        display as the hospital wrote it, their system as the catalog's alias where it has one.
        """
        hints = self._hint_matches(term)
        vocabulary = self._vocabulary
        if vocabulary.empty:
            return hints
        systems = self.systems()
        out: list[CodeHint] = []
        seen: set[tuple[str, str]] = set()
        for hint in hints:
            url = systems.get(hint.system, hint.system)
            found = vocabulary.lookup(url, hint.code)
            seen.add((url, hint.code))
            out.append(replace(hint, record=self._presence(found) if found else None, unit=hint.unit or (found.unit if found else None)))
        for found in vocabulary.find(term):
            if (found.system, found.code) in seen:
                continue
            seen.add((found.system, found.code))
            out.append(self._from_record(found))
        return out

    def _presence(self, found: RecordCode) -> dict[str, Any]:
        """`RecordCode.presence()` with the systems of the alternate codings as the catalog's aliases, ready for a spec."""
        presence = found.presence()
        presence["also_coded_as"] = [{**alt, "system": self.system_alias(alt["system"])} for alt in presence["also_coded_as"]]
        return presence

    def _from_record(self, found: RecordCode) -> CodeHint:
        return CodeHint(
            name=f"{found.display or found.code} ({found.resource}, record)",
            system=self.system_alias(found.system),
            code=found.code,
            unit=found.unit,
            components={c: c for c in found.components},
            record=self._presence(found),
            origin="record",
        )

    def record_summary(self) -> dict[str, Any]:
        """What the prompt and the tools say about the record's vocabulary: when it was read, how much, in which systems."""
        vocabulary = self._vocabulary
        if vocabulary.empty:
            return {"available": False}
        counts, systems, scanned = vocabulary.by_resource(), vocabulary.systems_by_resource(), vocabulary.scanned
        resources = {
            resource: {"codes": n, "systems": sorted(self.system_alias(s) for s in systems.get(resource, set())), "scanned": scanned.get(resource, 0)}
            for resource, n in sorted(counts.items(), key=lambda kv: -kv[1])
        }
        return {"available": True, "built_at": vocabulary.built_at, "complete": vocabulary.complete, "source": vocabulary.source, "resources": resources, "notes": vocabulary.notes}


def _item_kinds(prop: dict[str, Any]) -> tuple[str, ...] | None:
    """The `kind` tags of a tagged-union array (`items.oneOf[*].properties.kind.const`), or None."""
    items = prop.get("items") if isinstance(prop, dict) else None
    branches = items.get("oneOf") or items.get("anyOf") if isinstance(items, dict) else None
    if not isinstance(branches, list):
        return None
    kinds = [b.get("properties", {}).get("kind", {}).get("const") for b in branches if isinstance(b, dict)]
    return tuple(str(k) for k in kinds if k is not None) or None
