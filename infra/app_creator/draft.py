"""
The draft: the AppSpec a conversation is building, plus every change made to it. All edits go
through typed operations that validate against the published JSON Schema before they take:
a wrong value (unknown PHI field, bad code system, an unknown knob) is rejected immediately with
the schema's reason, while a missing required field is simply "still open" — that is what the
agent asks about next.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

from .catalog import Catalog

SPEC_HEADER = {"apiVersion": "medapp.eu/v1", "kind": "AppSpec"}


@dataclass(frozen=True)
class Issue:
    path: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "message": self.message}


class InvalidChange(ValueError):
    """The change would make the draft invalid; nothing was applied."""

    def __init__(self, issues: list[Issue]):
        super().__init__("; ".join(f"{i.path}: {i.message}" for i in issues))
        self.issues = issues


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Recursive merge; a `None` in the patch deletes the key; lists replace."""
    out = dict(base)
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _path(err_path: Any) -> str:
    return ".".join(str(p) for p in err_path) or "(root)"


def _message(err: Any) -> str:
    if err.validator == "required":
        return "is required"
    if err.validator == "additionalProperties":
        return err.message.replace("were unexpected", "are not fields of the spec").replace("was unexpected", "is not a field of the spec")
    return err.message


class Draft:
    def __init__(self, catalog: Catalog, spec: dict[str, Any] | None = None, events: list[dict[str, Any]] | None = None, refusals: list[dict[str, Any]] | None = None):
        self._catalog = catalog
        self.spec: dict[str, Any] = spec or {}
        self.events: list[dict[str, Any]] = events or []
        self.refusals: list[dict[str, Any]] = refusals or []

    # ── validation ─────────────────────────────────────────────────────────

    def _schema_for(self, spec: dict[str, Any]) -> dict[str, Any]:
        archetype = spec.get("archetype")
        if archetype in self._catalog.buildable_ids:
            return self._catalog.variant_schema(archetype)
        return self._catalog.common_schema()

    def _errors(self, spec: dict[str, Any]) -> tuple[list[Issue], list[Issue]]:
        """(open, invalid): required-missing fields vs. everything else."""
        full = {**SPEC_HEADER, **spec}
        validator = Draft202012Validator(self._schema_for(full))
        open_items: list[Issue] = []
        invalid: list[Issue] = []
        for err in sorted(validator.iter_errors(full), key=lambda e: list(map(str, e.path))):
            _classify(err, list(err.path), open_items, invalid)
        if "archetype" not in full:
            open_items.insert(0, Issue("archetype", "is required"))
        return _dedupe(open_items), _dedupe(invalid)

    def open_items(self) -> list[Issue]:
        return self._errors(self.spec)[0]

    def invalid_items(self) -> list[Issue]:
        return self._errors(self.spec)[1]

    def _apply(self, tool: str, args: dict[str, Any], new_spec: dict[str, Any]) -> list[Issue]:
        _open, invalid = self._errors(new_spec)
        if invalid:
            raise InvalidChange(invalid)
        self.spec = new_spec
        self.events.append({"at": _now(), "tool": tool, "args": json.loads(json.dumps(args, default=str))})
        return _open

    # ── operations (what the tools call) ────────────────────────────────────

    def choose_archetype(self, archetype_id: str, reason: str = "") -> list[Issue]:
        if archetype_id not in self._catalog.buildable_ids:
            raise InvalidChange([Issue("archetype", f"{archetype_id} cannot be built by this deployment; buildable: {', '.join(self._catalog.buildable_ids)}")])
        new = dict(self.spec)
        if new.get("archetype") != archetype_id:
            new.pop("knobs", None)  # knobs belong to an archetype
        new["archetype"] = archetype_id
        return self._apply("choose_archetype", {"archetype": archetype_id, "reason": reason}, new)

    def set_app(self, **fields: Any) -> list[Issue]:
        patch = {k: v for k, v in fields.items() if v is not None}
        new = dict(self.spec)
        new["app"] = deep_merge(new.get("app", {}), patch)
        return self._apply("set_app", patch, new)

    def patch_knobs(self, patch: dict[str, Any]) -> list[Issue]:
        if "archetype" not in self.spec:
            raise InvalidChange([Issue("archetype", "choose an archetype before setting knobs")])
        new = dict(self.spec)
        new["knobs"] = deep_merge(new.get("knobs", {}), patch)
        return self._apply("set_knobs", patch, new)

    def add_role(self, role: dict[str, Any]) -> list[Issue]:
        roles = [r for r in self.spec.get("roles", []) if r.get("id") != role.get("id")]
        roles.append({k: v for k, v in role.items() if v is not None})
        new = dict(self.spec)
        new["roles"] = roles
        if len(roles) == 1 and "default_role" not in new:
            new["default_role"] = role["id"]
        return self._apply("add_role", role, new)

    def update_role(self, role_id: str, patch: dict[str, Any]) -> list[Issue]:
        roles = list(self.spec.get("roles", []))
        idx = next((i for i, r in enumerate(roles) if r.get("id") == role_id), None)
        if idx is None:
            raise InvalidChange([Issue("roles", f'no role "{role_id}"')])
        # `group` is a tagged union: a new binding replaces the old one, it does not merge with it.
        merged = deep_merge(roles[idx], {k: v for k, v in patch.items() if k != "group"})
        if "group" in patch:
            merged.pop("group", None)
            if patch["group"] is not None:
                merged["group"] = copy.deepcopy(patch["group"])
        roles[idx] = merged
        new = dict(self.spec)
        new["roles"] = roles
        return self._apply("update_role", {"id": role_id, **patch}, new)

    def remove_role(self, role_id: str) -> list[Issue]:
        roles = [r for r in self.spec.get("roles", []) if r.get("id") != role_id]
        new = dict(self.spec)
        new["roles"] = roles
        if new.get("default_role") == role_id:
            new.pop("default_role", None)
        for r in roles:
            if r.get("inherits") == role_id:
                r.pop("inherits", None)
        return self._apply("remove_role", {"id": role_id}, new)

    def set_default_role(self, role_id: str) -> list[Issue]:
        if role_id not in [r.get("id") for r in self.spec.get("roles", [])]:
            raise InvalidChange([Issue("default_role", f'"{role_id}" is not a declared role')])
        new = dict(self.spec)
        new["default_role"] = role_id
        return self._apply("set_default_role", {"id": role_id}, new)

    def patch_governance(self, patch: dict[str, Any]) -> list[Issue]:
        new = dict(self.spec)
        new["governance"] = deep_merge(new.get("governance", {}), {k: v for k, v in patch.items() if v is not None})
        return self._apply("set_governance", patch, new)

    def record_refusal(self, refusal_id: str, detail: str) -> None:
        if refusal_id not in self._catalog.refusal_ids():
            raise InvalidChange([Issue("refusal", f"unknown refusal id {refusal_id}; known: {', '.join(self._catalog.refusal_ids())}")])
        self.refusals.append({"at": _now(), "refusal": refusal_id, "detail": detail})
        self.events.append({"at": _now(), "tool": "record_refusal", "args": {"refusal": refusal_id, "detail": detail}})

    # ── views ──────────────────────────────────────────────────────────────

    def full_spec(self) -> dict[str, Any]:
        """The spec as the compiler expects it (with header)."""
        return {**SPEC_HEADER, **copy.deepcopy(self.spec)}

    def summary(self) -> dict[str, Any]:
        return {"spec": self.full_spec(), "open": [i.as_dict() for i in self.open_items()], "refusals": list(self.refusals)}


def _classify(err: Any, path: list[Any], open_items: list[Issue], invalid: list[Issue]) -> None:
    """One schema error into open points (a required field that is not there yet) or rejections (everything else).

    Inside a tagged union (the section kinds of a summary or a composed page, the two group bindings, code
    systems) the branch the tag selects is the one that counts: its own missing fields are open points, like
    anywhere else in the draft, and its other problems are rejections with their full path. A tag that selects
    no branch is the problem itself; a union without a tag reports its most relevant branch's problem."""
    if err.validator == "required":
        for missing in [m for m in err.validator_value if m not in err.instance]:
            open_items.append(Issue(_path(path + [missing]), "is required"))
        return
    if err.validator in ("oneOf", "anyOf") and err.context:
        discriminator = _discriminator_problem(err)
        if discriminator:
            invalid.append(Issue(_path(path + [discriminator[0]]), discriminator[1]))
            return
        chosen = _tagged_branch(err)
        if chosen is not None:
            branch_errors = [e for e in err.context if e.relative_schema_path and e.relative_schema_path[0] == chosen]
            for inner in sorted(branch_errors, key=lambda e: list(map(str, e.relative_path))):
                _classify(inner, path + list(inner.relative_path), open_items, invalid)
            return
        inner = best_match(err.context)
        inner_path = path + list(inner.relative_path)
        if inner.validator == "required":
            for missing in [m for m in inner.validator_value if m not in inner.instance]:
                invalid.append(Issue(_path(inner_path + [missing]), "is required"))
        else:
            invalid.append(Issue(_path(inner_path), _message(inner)))
        return
    invalid.append(Issue(_path(path), _message(err)))


def _tags(err: Any) -> tuple[str, list[str]] | None:
    """(tag name, allowed values in branch order) when every branch of the union is an object with one shared `const` tag."""
    branches = err.validator_value if isinstance(err.validator_value, list) else []
    tags: dict[str, list[str]] = {}
    for branch in branches:
        for name, prop in (branch.get("properties") or {}).items():
            if isinstance(prop, dict) and "const" in prop:
                tags.setdefault(name, []).append(str(prop["const"]))
    if len(tags) != 1:
        return None
    tag, allowed = next(iter(tags.items()))
    return (tag, allowed) if len(allowed) == len(branches) else None


def _tagged_branch(err: Any) -> int | None:
    """The index of the branch the instance's tag selects, when the union is tagged and the tag is valid."""
    tags = _tags(err)
    if tags is None or not isinstance(err.instance, dict):
        return None
    tag, allowed = tags
    given = err.instance.get(tag)
    return allowed.index(str(given)) if given is not None and str(given) in allowed else None


def _discriminator_problem(err: Any) -> tuple[str, str] | None:
    """For a tagged union (`kind: literal`), a tag that matches no branch is the real problem — say so instead of picking a branch."""
    tags = _tags(err)
    if tags is None or not isinstance(err.instance, dict):
        return None
    tag, allowed = tags
    given = err.instance.get(tag)
    if given is None:
        return (tag, "is required")
    if str(given) not in allowed:
        return (tag, f"{given!r} is not one of {allowed}")
    return None


def _dedupe(items: list[Issue]) -> list[Issue]:
    seen: set[tuple[str, str]] = set()
    out = []
    for i in items:
        key = (i.path, i.message)
        if key in seen:
            continue
        seen.add(key)
        out.append(i)
    return out
