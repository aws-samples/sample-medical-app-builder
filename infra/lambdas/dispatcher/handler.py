"""
Primitive dispatcher — the enforcement point of the platform.

    POST /primitives/{kind}
    Authorization: Bearer <Cognito ID token>
    { app_id, manifest_version, primitive_id, role, config, context }   →   { output }

For every call, in this order, all server-side:
  1. the manifest version named in the request is loaded from the registry (immutable item)
  2. the version must be published — unless the caller is staff (authors/approvers/admins preview)
  3. the caller's roles for the app come from the token's groups (effective_roles); the requested
     role must be one of them
  4. the primitive must exist in that manifest with that id and kind, and not be gated to other roles
  5. the role's effective scope (inherits resolved) must grant what the primitive needs
  6. the primitive runs against the FhirSource; one audit record is emitted per call

Writes (`write.*` kinds) go through the same six steps. In addition the payload is validated (422 with
the list of problems when it is not acceptable — nothing stored), provenance is stamped from the
verified token rather than the payload, and the audit record carries the payload hash and the
reference of the resource that was created.

The frontend performs 4–5 as a pre-check to explain refusals; nothing it does is trusted here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

import primitives
from declared_config import ConfigMismatch, resolve_declared, validate_context
from fhir_source import ConditionalCreateAmbiguous, FhirSource, UpstreamError, VersionConflict
from medapp_shared.audit_model import AuditSink
from medapp_shared.identity_model import GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS, runnable_roles
from medapp_shared.registry_model import HEAD_SK, app_pk, effective_scope, present_version, version_sk

STAFF_GROUPS = frozenset({GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS})


class TableLike(Protocol):
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Caller:
    sub: str
    groups: tuple[str, ...]
    display: str | None = None  # what to call the person on records they create (from verified claims)
    email: str | None = None

    @property
    def is_staff(self) -> bool:
        return bool(STAFF_GROUPS & set(self.groups))


def parse_groups(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(g) for g in raw]
    text = str(raw).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [g.strip().strip('"') for g in re.split(r"[\s,]+", text) if g.strip()]


def caller_from_event(event: dict[str, Any]) -> Caller:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    display = claims.get("name") or " ".join(p for p in (claims.get("given_name"), claims.get("family_name")) if p) or claims.get("email")
    return Caller(sub=str(claims.get("sub", "")), groups=tuple(parse_groups(claims.get("cognito:groups"))), display=str(display) if display else None, email=str(claims["email"]) if claims.get("email") else None)


class Refused(Exception):
    def __init__(self, status: int, message: str, outcome: str = "refused"):
        super().__init__(message)
        self.status = status
        self.outcome = outcome


class Dispatcher:
    def __init__(self, table: TableLike, source: FhirSource, now: datetime | None = None, emit_audit=None, dicom: Any = None, media: Any = None, hospital_id: str | None = None):
        self._table = table
        self._source = source
        self._dicom = dicom  # a DICOMweb source when the deployment has one; imaging then comes from the PACS, not the FHIR record
        self._media = media  # where photos' bytes live (media_store.py); None = photos cannot be saved in this deployment
        self._hospital_id = hospital_id if hospital_id is not None else os.environ.get("HOSPITAL_ID", "")
        self._now = now
        self._emit = emit_audit or AuditSink.from_env("dispatcher", os.environ).emit

    def _load_version(self, app_id: str, version: str) -> dict[str, Any]:
        item = self._table.get_item(Key={"PK": app_pk(app_id), "SK": version_sk(version)}).get("Item")
        if not item:
            raise Refused(404, f"No such app version: {app_id}@{version}.", outcome="error")
        return item

    def _owner_sub(self, app_id: str) -> str | None:
        head = self._table.get_item(Key={"PK": app_pk(app_id), "SK": HEAD_SK}).get("Item")
        return (head or {}).get("owner_sub")

    def search_patients(self, caller: Caller, name: str, count: str = "20") -> dict[str, Any]:
        """
        The launch context: who a single-patient app is about. A hospital's record has patients the panel has never
        heard of, so the picker searches them by name here — through the same data source, audited like a primitive
        (`kind: platform.patient.search`, the query text, the number of hits), limited to twenty hits with the few
        fields a picker shows. An empty name lists the first page of the record by family name (also audited, with
        an empty query), so the picker has something to show before anyone types. A hospital launch (SMART, the EHR's context) makes this unnecessary; until then any
        signed-in user of the panel may look a patient up, which is what opening an app for them already implies.
        """
        started = time.monotonic()
        text = name.strip()
        try:
            limit = max(1, min(int(count), 50))
        except ValueError:
            limit = 20
        record: dict[str, Any] = {
            "audit_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "kind": "platform.patient.search",
            "user_sub": caller.sub,
            "user_name": caller.display,
            "user_email": caller.email,
            "query": text,
        }
        if 0 < len(text) < 2:
            record.update(outcome="refused", detail="at least two characters", duration_ms=0)
            return self._answer(record, 400, {"message": "Type at least two characters of the patient's name."})
        try:
            # No name: the first page of the record by family name, so the picker is not empty before anyone types —
            # one page only (`max_pages=1`), which is what a small record shows whole and a large one shows the top of.
            params = {"name": text, "_count": str(limit)} if text else {"_sort": "family", "_count": str(limit)}
            found = self._source.search("Patient", params, max_pages=1)
        except UpstreamError as err:
            record.update(outcome="error", duration_ms=round((time.monotonic() - started) * 1000), detail=f"upstream {err.method} {err.url}: {err}")
            return self._answer(record, 502, {"message": "The clinical data source did not complete the request.", "detail": str(err)})
        hits = [patient_summary(p) for p in found[:limit]]
        record.update(outcome="ok", duration_ms=round((time.monotonic() - started) * 1000), result_summary=f"{len(hits)} patients")
        return self._answer(record, 200, {"patients": hits})

    def _answer(self, record: dict[str, Any], status: int, body: dict[str, Any]) -> dict[str, Any]:
        """Emit the record, then answer — every answer names its record (`audit_id`) and the outcome the trail holds,
        so the browser's own view of the call (the app's inspector) can point at the authoritative one."""
        self._emit(record)
        return {"statusCode": status, "body": {**body, "audit_id": record["audit_id"], "outcome": record["outcome"]}}

    def dispatch(self, caller: Caller, kind: str, body: dict[str, Any]) -> dict[str, Any]:
        started = time.monotonic()
        app_id = str(body.get("app_id") or "")
        version = str(body.get("manifest_version") or "")
        primitive_id = str(body.get("primitive_id") or "")
        role = str(body.get("role") or "")
        config = body.get("config") if isinstance(body.get("config"), dict) else {}
        context = body.get("context") if isinstance(body.get("context"), dict) else {}
        patient_context = context.get("patient_id") if isinstance(context.get("patient_id"), str) else None

        record: dict[str, Any] = {
            "audit_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "app_id": app_id,
            "manifest_version": version,
            "primitive_id": primitive_id,
            "kind": kind,
            "role": role,
            "user_sub": caller.sub,
            "user_name": caller.display,
            "user_email": caller.email,
            "patient_context": patient_context,
        }

        try:
            if not (app_id and version and primitive_id and role):
                raise Refused(400, "app_id, manifest_version, primitive_id and role are required.", outcome="error")

            item = self._load_version(app_id, version)
            manifest = present_version(item)

            if item["state"] != "published" and not caller.is_staff:
                raise Refused(403, f"Version {version} of {app_id} is {item['state']}, not published.")

            # Authors may preview any role of the apps they own; that needs the HEAD's owner, but only
            # when the caller is an author without a direct role — everyone else is decided from groups.
            owner_sub = self._owner_sub(app_id) if GROUP_AUTHORS in caller.groups else None
            declared = manifest["auth"]["roles"]
            roles = runnable_roles(
                caller.groups,
                app_id,
                [r["id"] for r in declared],
                manifest["auth"]["default_role"],
                caller_sub=caller.sub,
                owner_sub=owner_sub,
                role_groups={r["id"]: r["cognito_group"] for r in declared},  # the manifest's bindings, not a naming convention
            )
            if role not in roles:
                raise Refused(403, f"Your groups do not grant the role '{role}' for this app.")
            record["role_source"] = roles[role]  # group | blanket | staff_preview — a reviewer looking as a reviewer is on record

            decl = next((p for p in manifest["primitives"] if p["id"] == primitive_id), None)
            if not decl:
                raise Refused(404, f"Primitive '{primitive_id}' is not declared by {app_id}@{version}.")
            if decl["kind"] != kind:
                raise Refused(400, f"Primitive '{primitive_id}' is {decl['kind']}, not {kind}.", outcome="error")
            if decl.get("only_for_roles") and role not in decl["only_for_roles"]:
                raise Refused(403, f"Primitive '{primitive_id}' is not part of the '{role}' data plan.")

            scope = effective_scope(manifest, role)
            record["data_scope_hash"] = (item.get("data_scope_hashes") or {}).get(role)

            # The configuration the primitive runs with is the manifest's, not the browser's (declared_config.py): the
            # launch context is validated against the app's declared inputs, the declared literals — codes, patient filter,
            # window, a write's ranges and allowed values — come from the published manifest, and only what the manifest
            # marks as the person's input (`$ui.*`) or an earlier primitive's output (`$bindings.*`) is taken from the
            # request. A client that spells a declared value differently is refused, and the attempt is on record.
            try:
                launch = validate_context(manifest, context)
            except ConfigMismatch as err:
                raise Refused(400, "The launch context does not fit this app: " + "; ".join(err.problems), outcome="refused") from err
            resolution = resolve_declared(decl.get("config"), client=config, context=launch, metadata=manifest["metadata"], role=role, scope=scope)
            if resolution.mismatches:
                record["config_mismatch"] = resolution.mismatches
                raise Refused(400, f"The request's config differs from what {app_id}@{version} declares for '{primitive_id}' ({', '.join(resolution.mismatches)}); the dispatcher executes the published configuration only.", outcome="refused")
            if resolution.dropped:
                record["config_dropped"] = resolution.dropped
            config = resolution.config
            patient_context = launch.get("patient_id") if isinstance(launch.get("patient_id"), str) else patient_context
            record["patient_context"] = patient_context

            is_write = primitives.is_write_kind(kind)
            if is_write:
                # What was asked to be written, hashed before validation: a rejected payload is on record too.
                record["payload_hash"] = _payload_hash(config)

            ctx = primitives.ExecutionContext(
                now=self._now or datetime.now(timezone.utc),
                user_sub=caller.sub,
                user_display=caller.display,
                app_id=app_id,
                manifest_version=version,
                provenance_allowed=primitives.scope_allows(scope, "Provenance", "create"),
                dicom=self._dicom,
                artifacts=manifest.get("artifacts"),
                media=self._media,
                hospital_id=self._hospital_id,
            )
            if is_write:
                # A manifest published before the Provenance grant existed still writes; the audit record is then the
                # only trail, and says so — the fix is republishing the app (the compiler grants Provenance.create to every writer).
                record["provenance"] = "recorded" if ctx.provenance_allowed else "not_granted"
            output = primitives.execute(kind, primitive_id, config, scope, self._source, ctx=ctx)

            if is_write and isinstance(output, dict) and output.get("resourceType") and output.get("id"):
                record["resource_ref"] = f"{output['resourceType']}/{output['id']}"
            record.update(outcome="ok", duration_ms=round((time.monotonic() - started) * 1000), detail=_summarize(output))
            return self._answer(record, 200, {"output": output})

        except primitives.WriteRejected as err:
            record.update(outcome="refused", duration_ms=round((time.monotonic() - started) * 1000), detail="invalid payload: " + "; ".join(err.problems))
            return self._answer(record, 422, {"message": "The record was not saved: the submission does not match the form.", "problems": err.problems})
        except ConditionalCreateAmbiguous as err:
            record.update(outcome="error", duration_ms=round((time.monotonic() - started) * 1000), detail=f"conditional create ambiguous: {err}")
            return self._answer(record, 409, {"message": "More than one existing record matches this submission; nothing was written."})
        except VersionConflict as err:
            record.update(outcome="refused", duration_ms=round((time.monotonic() - started) * 1000), detail=f"version conflict: {err}")
            return self._answer(record, 409, {"message": "The record was changed by someone else in the meantime; nothing was written. Reload and try again."})
        except primitives.ScopeViolation as err:
            record.update(outcome="refused", duration_ms=round((time.monotonic() - started) * 1000), detail=err.requirement)
            return self._answer(record, 403, {"message": str(err), "requirement": err.requirement})
        except primitives.UnknownPrimitive as err:
            record.update(outcome="refused", duration_ms=round((time.monotonic() - started) * 1000), detail=f"unknown primitive {err}")
            return self._answer(record, 404, {"message": f"Data primitive {kind} is not in the catalog."})
        except primitives.PrimitiveConfigError as err:
            record.update(outcome="error", duration_ms=round((time.monotonic() - started) * 1000), detail=str(err))
            return self._answer(record, 400, {"message": str(err)})
        except Refused as err:
            record.update(outcome=err.outcome, duration_ms=round((time.monotonic() - started) * 1000), detail=str(err))
            return self._answer(record, err.status, {"message": str(err)})
        except LookupError as err:
            record.update(outcome="error", duration_ms=round((time.monotonic() - started) * 1000), detail=str(err))
            return self._answer(record, 404, {"message": str(err)})
        except UpstreamError as err:
            # The FHIR server failed or refused the request: audited as an error, reported as such, never a 500 without a trace.
            record.update(outcome="error", duration_ms=round((time.monotonic() - started) * 1000), detail=f"upstream {err.method} {err.url}: {err}")
            return self._answer(record, 502, {"message": "The clinical data source did not complete the request.", "detail": str(err)})


def _payload_hash(config: dict[str, Any]) -> str:
    """sha256 over the canonical JSON of the write payload (`config.response`, else the whole config)."""
    payload = config.get("response") if isinstance(config.get("response"), dict) else config
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")).hexdigest()


def _summarize(output: Any) -> str:
    if isinstance(output, list):
        return f"{len(output)} resources"
    if isinstance(output, dict):
        if output.get("resourceType"):
            return f"{output['resourceType']}/{output['id']}" if output.get("id") else str(output["resourceType"])
        if "count" in output:
            return f"{output['count']} patients"
        if "rows" in output:
            return f"{len(output['rows'])} rows"
    return type(output).__name__


# ── Lambda entry point ────────────────────────────────────────────────────────────────────

_dispatcher: Dispatcher | None = None


def _get_dispatcher() -> Dispatcher:
    global _dispatcher
    if _dispatcher is None:
        import boto3  # local import keeps unit tests free of the SDK

        from dicomweb import dicomweb_source_from_env
        from fhir_source import source_from_env
        from media_store import media_store_from_env

        table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        _dispatcher = Dispatcher(table, source_from_env(), dicom=dicomweb_source_from_env(), media=media_store_from_env())
    return _dispatcher


def patient_summary(patient: dict[str, Any]) -> dict[str, Any]:
    """What a picker shows: id, a display name, birth date, sex, and the identifiers with a system (an MRN if there is one)."""
    name = next(iter(patient.get("name") or []), {}) or {}
    display = name.get("text") or " ".join(p for p in (" ".join(name.get("given") or []), name.get("family")) if p) or patient.get("id")
    identifiers = [{"system": i.get("system"), "value": i.get("value")} for i in patient.get("identifier") or [] if isinstance(i, dict) and i.get("value")]
    return {"id": str(patient.get("id") or ""), "name": display, "birthDate": patient.get("birthDate"), "gender": patient.get("gender"), "identifiers": identifiers}


def _response(status: int, body: Any) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store"}, "body": json.dumps(body, default=str)}


def handle(event: dict[str, Any], dispatcher: Dispatcher) -> dict[str, Any]:
    caller = caller_from_event(event)
    if not caller.sub:
        return _response(401, {"message": "No authenticated caller."})
    if event.get("routeKey") == "GET /patients":
        params = event.get("queryStringParameters") or {}
        result = dispatcher.search_patients(caller, str(params.get("name") or ""), str(params.get("count") or "20"))
        return _response(result["statusCode"], result["body"])
    if event.get("routeKey") != "POST /primitives/{kind}":
        return _response(404, {"message": f"Unknown route {event.get('routeKey')}"})
    kind = (event.get("pathParameters") or {}).get("kind", "")
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"message": "Body must be JSON."})
    if not isinstance(body, dict):
        return _response(400, {"message": "Body must be a JSON object."})
    result = dispatcher.dispatch(caller, kind, body)
    return _response(result["statusCode"], result["body"])


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_dispatcher())
