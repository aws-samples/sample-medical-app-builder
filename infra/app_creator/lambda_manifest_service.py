"""
The compiler as the deployed manifest-service Lambda, invoked directly (no HTTP, no user token):
the agent worker and the registry writer are platform components, so they call the function.
"""

from __future__ import annotations

import json
from typing import Any

from .manifest_service import CompileResult, ManifestServiceUnavailable, Readiness, ServiceIssue, ShapeCompileResult


class LambdaManifestService:
    def __init__(self, function_name: str, client: Any | None = None):
        self._fn = function_name
        self._client = client

    def _invoke(self, payload: dict[str, Any]) -> dict[str, Any]:
        client = self._client
        if client is None:
            import boto3  # local import keeps unit tests free of the SDK

            client = boto3.client("lambda")
        try:
            res = client.invoke(FunctionName=self._fn, InvocationType="RequestResponse", Payload=json.dumps(payload).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise ManifestServiceUnavailable(f"manifest service invoke failed: {e}") from e
        raw = res["Payload"].read() if hasattr(res.get("Payload"), "read") else res.get("Payload")
        if res.get("FunctionError"):
            raise ManifestServiceUnavailable(f"manifest service error: {raw!r}")
        return json.loads(raw)

    def readiness(self, spec: dict[str, Any], shapes: list[dict[str, Any]] | None = None) -> Readiness:
        payload: dict[str, Any] = {"action": "readiness", "spec": spec}
        if shapes is not None:
            payload["shapes"] = shapes
        data = self._invoke(payload)
        return Readiness(ready=bool(data.get("ready")), missing=[ServiceIssue(i["path"], i["message"]) for i in data.get("missing", [])])

    def compile(self, spec: dict[str, Any], hospital_id: str, created_by_sub: str | None = None, created_at: str | None = None, shapes: list[dict[str, Any]] | None = None) -> CompileResult:
        payload: dict[str, Any] = {"action": "compile", "spec": spec, "hospital_id": hospital_id}
        if created_by_sub:
            payload["created_by_sub"] = created_by_sub
        if created_at:
            payload["created_at"] = created_at
        if shapes is not None:
            payload["shapes"] = shapes
        data = self._invoke(payload)
        if data.get("ok"):
            return CompileResult(ok=True, manifest=data["manifest"])
        return CompileResult(ok=False, issues=[ServiceIssue(i["path"], i["message"]) for i in data.get("issues", [])])

    def compile_shape(self, document: dict[str, Any]) -> ShapeCompileResult:
        data = self._invoke({"action": "compile_shape", "shape": document})
        if data.get("ok"):
            return ShapeCompileResult(ok=True, artifact=data["artifact"])
        return ShapeCompileResult(ok=False, issues=[ServiceIssue(i["path"], i["message"]) for i in data.get("issues", [])])
