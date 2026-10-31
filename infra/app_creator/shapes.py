"""
The record-shape library as the assistant sees it: the published artifacts a `record` section may refer to with
`shape: <id>` — so the model offers a shape the hospital has reviewed instead of designing the same fields again,
and so a reference to a shape nobody has published is refused where it is made (the same rule the compiler applies,
with the list of what exists). The registry is the source (RegistryShapes); tests and the local harness use a fixed
list (StaticShapes), the harness compiling the bundled med_app/shapes/*.yaml through the manifest service.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Protocol

import yaml

from .paths import med_app_dir


class ShapeLibrary(Protocol):
    def published(self) -> list[dict[str, Any]]:
        """The compiled artifacts of every shape with a published version — what a compile is handed."""
        ...


class StaticShapes:
    """A fixed list — for tests and the local harness."""

    def __init__(self, artifacts: list[dict[str, Any]] | None = None):
        self._artifacts = list(artifacts or [])

    def published(self) -> list[dict[str, Any]]:
        return list(self._artifacts)


class RegistryShapes:
    """
    The library from the registry table: GSI1 names the shapes (`SHAPES`), each HEAD is read by key and, when it has
    a published version, that version's artifact. Cached for a short while — a turn calls readiness and compile more
    than once, and a shape published a minute ago is soon enough.
    """

    def __init__(self, table_name: str, client: Any | None = None, ttl_s: float = 60.0, clock: Any = time.monotonic):
        self._table_name = table_name
        self._client = client
        self._ttl = ttl_s
        self._clock = clock
        self._cached: tuple[float, list[dict[str, Any]]] | None = None

    def _table(self) -> Any:
        if self._client is None:
            import boto3  # local import keeps unit tests free of the SDK

            self._client = boto3.resource("dynamodb").Table(self._table_name)
        return self._client

    def published(self) -> list[dict[str, Any]]:
        now = self._clock()
        if self._cached and now - self._cached[0] < self._ttl:
            return list(self._cached[1])
        import json

        from medapp_shared.registry_model import HEAD_SK, SHAPES_GSI1PK, version_sk

        table = self._table()
        out: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"IndexName": "GSI1", "KeyConditionExpression": "GSI1PK = :pk", "ExpressionAttributeValues": {":pk": SHAPES_GSI1PK}}
        named: list[dict[str, Any]] = []
        while True:
            page = table.query(**kwargs)
            named.extend(page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last:
                break
            kwargs["ExclusiveStartKey"] = last
        for entry in named:
            head = table.get_item(Key={"PK": entry["PK"], "SK": HEAD_SK}).get("Item")
            if not head or not head.get("active_version"):
                continue
            version = table.get_item(Key={"PK": entry["PK"], "SK": version_sk(str(head["active_version"]))}).get("Item")
            if version and version.get("state") == "published" and version.get("artifact_json"):
                out.append({**json.loads(version["artifact_json"]), "version": str(version["version"])})
        self._cached = (now, out)
        return list(out)


def bundled_shapes(service: Any, directory: Path | None = None) -> list[dict[str, Any]]:
    """The shapes shipped with the panel (med_app/shapes/*.yaml), compiled — the local harness's library."""
    folder = directory or (med_app_dir() / "shapes")
    out: list[dict[str, Any]] = []
    for file in sorted(folder.glob("*.yaml")):
        result = service.compile_shape(yaml.safe_load(file.read_text(encoding="utf-8")))
        if result.ok and result.artifact:
            out.append(result.artifact)
    return out


def shape_summary(artifact: dict[str, Any]) -> dict[str, Any]:
    """What the model needs to offer a shape: its id, name, what it writes, and the fields in a line each."""
    return {
        "id": artifact["id"],
        "name": artifact["name"],
        **({"description": artifact["description"]} if artifact.get("description") else {}),
        "resource": artifact["resource"],
        **({"note": "a kind the platform has not admitted — defined by an administrator with its own stamps; only a published shape may write it, never inline fields"} if artifact.get("open_kind") else {}),
        "fields": [f"{f['label']} ({f['type']}{', required' if f.get('required') else ''})" for f in artifact.get("fields") or []],
    }


def unknown_shapes(patch: Any, library: ShapeLibrary | None) -> list[tuple[str, str]]:
    """(path, id) for every `shape` a knobs patch's sections name that has no published version."""
    found: list[tuple[str, str]] = []
    if not isinstance(patch, dict):
        return found
    known = {a["id"] for a in (library.published() if library else [])}
    for i, section in enumerate(patch.get("sections") or []):
        if isinstance(section, dict) and section.get("shape") is not None and str(section["shape"]) not in known:
            found.append((f"knobs.sections.{i}.shape", str(section["shape"])))
    return found
