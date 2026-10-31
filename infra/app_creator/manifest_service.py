"""
The compiler as a service. The TypeScript code in med_app/src/spec is the only implementation of
"spec → manifest" and of the authoritative readiness check; the agent reaches it through this
interface. Today that is the CLI in a checkout (`node scripts/appspec.mjs`); the Node manifest-service
Lambda is reached through `LambdaManifestService` with the same methods.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import yaml

from .paths import med_app_dir


@dataclass(frozen=True)
class ServiceIssue:
    path: str
    message: str


@dataclass(frozen=True)
class Readiness:
    ready: bool
    missing: list[ServiceIssue] = field(default_factory=list)


@dataclass(frozen=True)
class CompileResult:
    ok: bool
    manifest: dict[str, Any] | None = None
    issues: list[ServiceIssue] = field(default_factory=list)


@dataclass(frozen=True)
class ShapeCompileResult:
    ok: bool
    artifact: dict[str, Any] | None = None
    issues: list[ServiceIssue] = field(default_factory=list)


class ManifestService(Protocol):
    """
    `shapes` is the library a spec may refer to with `shape: <id>` in a `record` section — the published artifacts
    (as `compile_shape` returns them); without it such a reference is an issue, as it should be for a shape nobody
    has published.
    """

    def readiness(self, spec: dict[str, Any], shapes: list[dict[str, Any]] | None = None) -> Readiness: ...
    def compile(self, spec: dict[str, Any], hospital_id: str, created_by_sub: str | None = None, created_at: str | None = None, shapes: list[dict[str, Any]] | None = None) -> CompileResult: ...
    def compile_shape(self, document: dict[str, Any]) -> ShapeCompileResult: ...


class ManifestServiceUnavailable(RuntimeError):
    pass


class CliManifestService:
    """Runs the compiler CLI in a med_app checkout that has node_modules (esbuild)."""

    def __init__(self, app_dir: Path | None = None, node: str | None = None, timeout_s: float = 60.0):
        self._dir = app_dir or med_app_dir()
        self._node = node or os.environ.get("MEDAPP_NODE", "node")
        self._timeout = timeout_s

    def _run(self, command: str, *flags: str, spec: dict[str, Any], shapes: list[dict[str, Any]] | None = None) -> tuple[int, str, str]:
        """`appspec <command> <file> [flags]` — the file first: the CLI reads the token after any `--flag` as its value, so `--json <file>` would swallow it."""
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as f:
            yaml.safe_dump(spec, f, allow_unicode=True, sort_keys=False)
            path = f.name
        shapes_path: str | None = None
        if shapes is not None:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as g:
                json.dump({"shapes": shapes}, g)
                shapes_path = g.name
            flags = (*flags, "--shapes", shapes_path)
        try:
            proc = subprocess.run([self._node, "scripts/appspec.mjs", command, path, *flags], cwd=str(self._dir), capture_output=True, text=True, timeout=self._timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ManifestServiceUnavailable(f"could not run the compiler CLI in {self._dir}: {e}") from e
        finally:
            Path(path).unlink(missing_ok=True)
            if shapes_path:
                Path(shapes_path).unlink(missing_ok=True)
        return proc.returncode, proc.stdout, proc.stderr

    def readiness(self, spec: dict[str, Any], shapes: list[dict[str, Any]] | None = None) -> Readiness:
        code, out, err = self._run("readiness", spec=spec, shapes=shapes)
        if code not in (0, 2) or not out.strip():
            raise ManifestServiceUnavailable(f"readiness failed ({code}): {err.strip() or out.strip()}")
        data = json.loads(out)
        return Readiness(ready=bool(data["ready"]), missing=[ServiceIssue(i["path"], i["message"]) for i in data.get("missing", [])])

    def compile(self, spec: dict[str, Any], hospital_id: str, created_by_sub: str | None = None, created_at: str | None = None, shapes: list[dict[str, Any]] | None = None) -> CompileResult:
        flags = ["--json", "--hospital", hospital_id]
        if created_by_sub:
            flags += ["--created-by", created_by_sub]
        if created_at:
            flags += ["--created-at", created_at]
        code, out, err = self._run("compile", *flags, spec=spec, shapes=shapes)
        if not out.strip():
            raise ManifestServiceUnavailable(f"compile failed ({code}): {err.strip()}")
        data = json.loads(out)
        if data.get("ok"):
            return CompileResult(ok=True, manifest=data["manifest"])
        return CompileResult(ok=False, issues=[ServiceIssue(i["path"], i["message"]) for i in data.get("issues", [])])

    def compile_shape(self, document: dict[str, Any]) -> ShapeCompileResult:
        code, out, err = self._run("shape", "--json", spec=document)
        if not out.strip():
            raise ManifestServiceUnavailable(f"shape compile failed ({code}): {err.strip()}")
        data = json.loads(out)
        if data.get("ok"):
            return ShapeCompileResult(ok=True, artifact=data["artifact"])
        return ShapeCompileResult(ok=False, issues=[ServiceIssue(i["path"], i["message"]) for i in data.get("issues", [])])


def summarize_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """What an author (or an approver) should read about a compiled manifest, without the YAML."""

    def outline(node: dict[str, Any], depth: int = 0) -> list[str]:
        gate = f" [only {', '.join(node['show_only_if_role_in'])}]" if node.get("show_only_if_role_in") else ""
        title = node.get("props", {}).get("title") or node.get("props", {}).get("label") or ""
        title = "" if isinstance(title, str) and title.startswith("$") else (f" — {title}" if title else "")
        lines = [f"{'  ' * depth}{node['component']}{title}{gate}"]
        for child in node.get("children", []) or []:
            lines.extend(outline(child, depth + 1))
        return lines

    scopes = {}
    for role in manifest["auth"]["roles"]:
        scope = manifest["data_scopes"][role["data_scope_ref"]]
        scopes[role["id"]] = {
            "group": role["cognito_group"],
            "inherits": scope.get("inherits"),
            "phi_fields_visible": scope.get("phi_fields_visible", []),
            "fhir": [f"{e['resource']}: {', '.join(e['operations'])}" for e in scope.get("fhir", [])],
        }
    return {
        "app": f"{manifest['metadata']['app_id']}@{manifest['metadata']['version']} — {manifest['metadata']['name']}",
        "intent_class": manifest["metadata"]["intent_class"],
        "primitives": [f"{p['id']}: {p['kind']}" + (f" [only {', '.join(p['only_for_roles'])}]" if p.get("only_for_roles") else "") for p in manifest["primitives"]],
        "roles": scopes,
        "layout": outline(manifest["layout"]["root"]),
        "context_inputs": [c["name"] for c in manifest.get("context_inputs", [])],
        "audit": manifest.get("audit", {}),
    }
