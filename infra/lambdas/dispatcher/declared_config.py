"""
The primitive's configuration comes from the published manifest, not from the browser.

A manifest primitive declares its configuration once: literal values (the codes an app reads, the patient filter, the
plausibility ranges and allowed statuses a write is checked against, the window) and references the panel fills at run
time — `$context.<input>` (the launch context: which patient, which window), `$ui.<name>` (what the person entered or
selected: a form's answers, a slider's range, a status change), `$bindings.<name>` (the output of an earlier primitive of
the same page), `$metadata.<field>` and `$auth.<field>`. The panel resolves those and sends the result; the dispatcher
used to execute what it received. That left every declared value to the client's honesty: a tampered request could widen
`codes`, point `patient` at someone else, or loosen a write's `ranges`.

Here the dispatcher resolves the declared configuration itself. Literals are the manifest's. `$context` references come
from the request's context, validated against the manifest's `context_inputs` (types, required inputs, declared
defaults). `$ui` and `$bindings` references are, by their nature, the client's — they are taken from the client's
configuration at the same path, and every rule that applies to them (the write validation, the scope) still runs on the
server. `$metadata` and `$auth` are resolved from the manifest and the call. The client's configuration is then compared
with the result: a literal it spells differently is a mismatch, and the call is refused and recorded rather than silently
corrected — a tampered or broken client should fail visibly. Keys the client sends that the manifest does not declare are
dropped.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

REF = re.compile(r"^\$(bindings|context|metadata|auth|ui)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$")
_SEGMENT = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]")

# What a context input of each declared type may look like. `fhir.reference` is a resource id (the panel sends the
# Patient's id, never a full URL); `iso8601` a date, a date-time, or the relative window expression the catalog allows.
CONTEXT_TYPES: dict[str, re.Pattern[str]] = {
    "fhir.reference": re.compile(r"^[A-Za-z0-9][A-Za-z0-9\-.]{0,63}$"),
    "iso8601": re.compile(r"^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?|now(-\d{1,4}[dmy])?)$"),
    "string": re.compile(r"^[^\x00-\x1f]{1,256}$"),
}


class ConfigMismatch(Exception):
    """The client's configuration disagrees with the published one, or the context does not fit the manifest."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class Resolution:
    config: dict[str, Any]
    #: paths the client spelled differently from the manifest (`codes`, `params.patient`, …)
    mismatches: list[str] = field(default_factory=list)
    #: client keys the manifest does not declare — dropped
    dropped: list[str] = field(default_factory=list)


def validate_context(manifest: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    """The request's context as the manifest declares it: declared inputs only, typed, defaults filled, required present."""
    inputs = manifest.get("context_inputs") or []
    out: dict[str, Any] = {}
    problems: list[str] = []
    for spec in inputs:
        name = str(spec.get("name"))
        value = context.get(name)
        if value is None or value == "":
            if spec.get("default") is not None:
                out[name] = spec["default"]
            elif spec.get("required"):
                problems.append(f"context.{name} is required by this app")
            continue
        if not isinstance(value, str):
            problems.append(f"context.{name} must be a string")
            continue
        pattern = CONTEXT_TYPES.get(str(spec.get("type") or "string"), CONTEXT_TYPES["string"])
        if not pattern.match(value):
            problems.append(f"context.{name} is not a valid {spec.get('type', 'string')}")
            continue
        out[name] = value
    if problems:
        raise ConfigMismatch(problems)
    return out


def _lookup(root: Any, path: str) -> tuple[bool, Any]:
    cur = root
    for m in _SEGMENT.finditer(path):
        key: Any = m.group(1) if m.group(1) is not None else int(m.group(2))
        if isinstance(key, int):
            if not isinstance(cur, list) or key >= len(cur):
                return False, None
            cur = cur[key]
        elif isinstance(cur, Mapping) and key in cur:
            cur = cur[key]
        elif key == "length" and isinstance(cur, list):
            cur = len(cur)
        else:
            return False, None
    return True, cur


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def resolve_declared(
    declared: Mapping[str, Any] | None,
    *,
    client: Mapping[str, Any] | None,
    context: Mapping[str, Any],
    metadata: Mapping[str, Any],
    role: str,
    scope: Mapping[str, Any],
) -> Resolution:
    """The configuration the primitive runs with, built from the manifest; see the module docstring."""
    client = client or {}
    result = Resolution(config={})
    env = {"context": context, "metadata": metadata, "auth": {"role": role, "effective": scope}}

    def resolve(node: Any, sent: Any, path: str) -> Any:
        if isinstance(node, str) and (m := REF.match(node)):
            root, rest = m.group(1), m.group(2)
            if root in ("ui", "bindings"):
                return sent  # the person's input, or an earlier primitive's output: the client's by nature
            found, value = _lookup(env[root], rest)
            resolved = value if found else None
            # The client resolved the same reference; a different answer (`patient` ≠ context.patient_id) is the probe this module exists for.
            if sent is not None and resolved is not None and _canonical(sent) != _canonical(resolved):
                result.mismatches.append(path)
            return resolved
        if isinstance(node, Mapping):
            out: dict[str, Any] = {}
            sent_map = sent if isinstance(sent, Mapping) else {}
            for key, child in node.items():
                value = resolve(child, sent_map.get(key), f"{path}.{key}" if path else key)
                if value is not None:
                    out[key] = value
            if path == "":
                result.dropped.extend(sorted(k for k in sent_map if k not in node))
            return out
        if isinstance(node, list):
            sent_list = sent if isinstance(sent, list) else []
            if any(isinstance(c, str) and REF.match(c) or isinstance(c, (Mapping, list)) for c in node):
                # element-wise; a client list of another length (a `rules` list emptied) is a mismatch of the list itself
                if isinstance(sent, list) and len(sent) != len(node):
                    result.mismatches.append(path)
                return [resolve(child, sent_list[i] if i < len(sent_list) else None, f"{path}[{i}]") for i, child in enumerate(node)]
            if sent is not None and _canonical(sent) != _canonical(node):
                result.mismatches.append(path)
            return list(node)
        # a literal: the manifest's value; a client that sent something else is noted
        if sent is not None and _canonical(sent) != _canonical(node):
            result.mismatches.append(path)
        return node

    result.config = resolve(dict(declared or {}), client, "")
    return result


__all__ = ["CONTEXT_TYPES", "ConfigMismatch", "Resolution", "resolve_declared", "validate_context"]
