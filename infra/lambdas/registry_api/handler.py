"""
Registry read API — Lambda behind API Gateway (HTTP API, Cognito JWT authorizer).

    GET /registry/apps                                  → { apps: [ { app_id, version, state, roles, manifest, … } ] }
    GET /registry/apps/{app_id}/versions/{version}      → { app_id, version, state, roles, manifest_hash, manifest, … }
                                                          version ∈ exact semver | active | latest
    GET /registry/collections                           → { collections: [ { collection_id, name, description, app_ids, … } ] }
                                                          a clinician's collections name only the apps they may open; empty ones are left out
    GET /registry/shapes                                → { shapes: [ { shape_id, name, resource, latest_version, latest_state, active_version, latest, published, … } ] }
    GET /registry/shapes/{shape_id}                     → the same, plus every version and the shape's history (staff only — the
                                                          library is an authoring concern; apps embed the artifact they were compiled with)

Staff additionally get, per version: the spec it was compiled from, who owns and who built it, and its `history` —
the lifecycle events newest first (who, when, from → to, notes, whether signed): the send-back an author needs to
read, the sign-off notes an approver left.

Visibility is decided here, server-side, with the same rule the frontend mirrors:
  - the caller's roles for an app = effective_roles(groups, …): per-app groups + blanket access
  - clinicians see the *published* version only (HEAD.active_version) and need a role
  - staff (authors / approvers / admins) see the *latest* version of every app, and every *deprecated* one — the
    versions a newer publication superseded and the retired ones — so the panel's Deprecated tab is complete
The frontend re-validates every manifest it receives; this API is trusted, not blindly.

`RegistryReader` is pure Python over a boto3 Table-like object so it can be unit-tested with a fake.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Iterable, Protocol
from medapp_shared.identity_model import GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS, effective_roles, runnable_roles
from medapp_shared.registry_model import COLLECTIONS_GSI1PK, HEAD_SK, REGISTRY_GSI1PK, SHAPES_GSI1PK, app_pk, pad_version, present_collection, present_event, present_shape, present_shape_version, present_version, shape_pk, version_sk

import json
import os
import re

STAFF_GROUPS = frozenset({GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS})


class TableLike(Protocol):
    def query(self, **kwargs: Any) -> dict[str, Any]: ...
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Caller:
    sub: str
    groups: tuple[str, ...]

    @property
    def is_staff(self) -> bool:
        return bool(STAFF_GROUPS & set(self.groups))


def parse_groups(raw: Any) -> list[str]:
    """
    HTTP API JWT authorizers pass array claims to Lambda as a string like "[medapp-viewers medapp-admins]".
    Accept that, a JSON list, or a comma/space separated string.
    """
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
    return Caller(sub=str(claims.get("sub", "")), groups=tuple(parse_groups(claims.get("cognito:groups"))))


class RegistryReader:
    def __init__(self, table: TableLike):
        self._table = table

    # ── raw reads ─────────────────────────────────────────────────────────────────────────

    def list_heads(self) -> list[dict[str, Any]]:
        """Every app's HEAD through the index — keys and projected attributes only (no owner_sub); see list_apps."""
        heads: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "IndexName": "GSI1",
            "KeyConditionExpression": "GSI1PK = :pk",
            "ExpressionAttributeValues": {":pk": REGISTRY_GSI1PK},
        }

        while True:
            page = self._table.query(**kwargs)
            heads.extend(page.get("Items", []))
            last = page.get("LastEvaluatedKey")

            if not last:
                return heads

            kwargs["ExclusiveStartKey"] = last

    def get_head(self, app_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": app_pk(app_id), "SK": HEAD_SK}).get("Item")

    def get_version(self, app_id: str, version: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": app_pk(app_id), "SK": version_sk(version)}).get("Item")

    def _gsi1(self, pk: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "IndexName": "GSI1",
            "KeyConditionExpression": "GSI1PK = :pk",
            "ExpressionAttributeValues": {":pk": pk},
        }

        while True:
            page = self._table.query(**kwargs)
            items.extend(page.get("Items", []))
            last = page.get("LastEvaluatedKey")

            if not last:
                return items

            kwargs["ExclusiveStartKey"] = last

    def list_by_state(self, state: str) -> list[dict[str, Any]]:
        """Every VERSION in a lifecycle state, through the state index (one query, all apps) — keys and projected attributes only."""
        return self._gsi1(f"STATE#{state}")

    def list_collection_items(self) -> list[dict[str, Any]]:
        """
        The hospital's collections, by name (removed ones have left this index key). GSI1 projects a fixed attribute list
        — a collection's `collection_id`, `description` and `app_ids` are not in it — so the index only names the items
        and each is then read by key. Collections are a handful; one read each is fine.
        """
        out: list[dict[str, Any]] = []
        for named in self._gsi1(COLLECTIONS_GSI1PK):
            item = self._table.get_item(Key={"PK": named["PK"], "SK": named["SK"]}).get("Item")
            if item and not str(item.get("GSI1PK", "")).endswith("#deleted"):
                out.append(item)
        return out

    def list_events(self, app_id: str, version: str) -> list[dict[str, Any]]:
        """The version's lifecycle events, newest first (`EVT#<padded version>#<ts>` sorts by time)."""
        return self._by_prefix(app_pk(app_id), f"EVT#{pad_version(version)}#", newest_first=True)

    def _by_prefix(self, pk: str, prefix: str, *, newest_first: bool = False) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "PK = :pk AND begins_with(SK, :prefix)",
            "ExpressionAttributeValues": {":pk": pk, ":prefix": prefix},
            "ScanIndexForward": not newest_first,
        }

        while True:
            page = self._table.query(**kwargs)
            items.extend(page.get("Items", []))
            last = page.get("LastEvaluatedKey")

            if not last:
                return items

            kwargs["ExclusiveStartKey"] = last

    def _shape_head(self, pk: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": pk, "SK": HEAD_SK}).get("Item")

    def _shape_entry(self, head: dict[str, Any]) -> dict[str, Any]:
        """A shape with its latest version whole and the published artifact — two reads by key, like the writer's."""
        latest = self._table.get_item(Key={"PK": head["PK"], "SK": version_sk(str(head["latest_version"]))}).get("Item")
        active = head.get("active_version")
        published = latest if active and latest and latest.get("version") == active else (self._table.get_item(Key={"PK": head["PK"], "SK": version_sk(str(active))}).get("Item") if active else None)
        return present_shape(head, latest=latest, published=published if published and published.get("state") == "published" else None)

    def list_shape_items(self) -> list[dict[str, Any]]:
        """Every shape's HEAD: the index names them (by name), each is read by key."""
        out: list[dict[str, Any]] = []
        for named in self._gsi1(SHAPES_GSI1PK):
            head = self._shape_head(named["PK"])
            if head:
                out.append(head)
        return out

    # ── visibility ────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _roles_for(caller: Caller, manifest: dict[str, Any]) -> list[str]:
        auth = manifest["auth"]
        return effective_roles(
            caller.groups,
            manifest["metadata"]["app_id"],
            [r["id"] for r in auth["roles"]],
            auth["default_role"],
            role_groups={r["id"]: r["cognito_group"] for r in auth["roles"]},
        )

    def _visible(self, caller: Caller, head: dict[str, Any] | None, item: dict[str, Any]) -> dict[str, Any] | None:
        manifest = present_version(item)
        roles = self._roles_for(caller, manifest)
        owner = (head or {}).get("owner_sub")

        if caller.is_staff:
            # Approvers/admins have blanket access; authors may see what they own even without a role.
            if not roles and owner != caller.sub:
                return None
        else:
            if not roles or item["state"] != "published":
                return None

        auth = manifest["auth"]
        return {
            "app_id": item["app_id"],
            "version": item["version"],
            "state": item["state"],
            # roles the caller holds as a clinician would; runnable_roles adds staff preview roles
            "roles": roles,
            "runnable_roles": runnable_roles(
                caller.groups,
                item["app_id"],
                [r["id"] for r in auth["roles"]],
                auth["default_role"],
                caller_sub=caller.sub,
                owner_sub=owner,
                role_groups={r["id"]: r["cognito_group"] for r in auth["roles"]},
            ),
            "manifest_hash": item["manifest_hash"],
            "manifest": manifest,
            # Who built this version, as a name (or an email) — attribution anyone may see; the subs below are for the rules.
            "author": item.get("author") or None,
            # The AppSpec the version was compiled from (absent for hand-authored manifests): what
            # "iterate on this app" reopens. Staff only — clinicians have no use for it.
            "spec": json.loads(item["spec_json"]) if caller.is_staff and item.get("spec_json") else None,
            "owner_sub": owner if caller.is_staff else None,
            # Who compiled this version: the panel hides "approve" from that person (separation of duties).
            "created_by_sub": item.get("created_by_sub") if caller.is_staff else None,
            # The version's lifecycle so far, newest first — a send-back and its reason, a sign-off and its notes.
            "history": [present_event(e) for e in self.list_events(item["app_id"], item["version"])] if caller.is_staff else None,
        }

    def list_apps(self, caller: Caller) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        listed: set[tuple[str, str]] = set()
        # The index names the apps; the head item itself carries `owner_sub` (not projected), which decides what an
        # author sees of their own drafts — so each head is read by key. Tens of apps, one read each.
        heads: dict[str, dict[str, Any]] = {}
        for named in self.list_heads():
            head = self.get_head(str(named["app_id"])) or named
            heads[str(head["app_id"])] = head

        for head in heads.values():
            # Clinicians: the published version. Staff: the published version and, while a newer one is
            # being drafted or reviewed, that one too — one row per version, so the panel can list the
            # app under "Apps" and its successor under "Drafts" / "Pending sign-off" at the same time.
            versions = [head.get("active_version")]
            if caller.is_staff and head.get("latest_version") not in versions:
                versions.append(head.get("latest_version"))

            for version in versions:
                if not version:
                    continue

                item = self.get_version(head["app_id"], version)

                if not item:
                    continue

                shown = self._visible(caller, head, item)

                if shown:
                    out.append(shown)
                    listed.add((head["app_id"], str(version)))

        if caller.is_staff:
            # The versions out of service — superseded when a newer one was published, or retired — for the
            # Deprecated tab. A retired app's deprecated version is already its latest; a superseded one is neither
            # active nor latest and would otherwise never be listed. Clinicians never receive these.
            for named in self.list_by_state("deprecated"):
                key = (str(named["app_id"]), str(named["version"]))

                if key in listed:
                    continue

                item = self.get_version(*key)  # the index has no manifest_json; the version item does

                if not item:
                    continue

                shown = self._visible(caller, heads.get(key[0]), item)

                if shown:
                    out.append(shown)
                    listed.add(key)

        return out

    def list_collections(self, caller: Caller) -> list[dict[str, Any]]:
        """
        The collections as this caller may see them. Staff get them whole. A clinician's collections name only the
        apps the caller could open (what `list_apps` would return), and a collection left with none is not shown —
        so neither a name nor a count tells a clinician about apps they have no access to.
        """
        items = self.list_collection_items()

        if caller.is_staff:
            return [present_collection(i) for i in items]

        visible = {a["app_id"] for a in self.list_apps(caller)}
        out: list[dict[str, Any]] = []

        for item in items:
            ids = [a for a in item.get("app_ids") or [] if a in visible]

            if ids:
                out.append(present_collection(item, app_ids=ids))

        return out

    def list_shapes(self, caller: Caller) -> list[dict[str, Any]] | None:
        """The record-shape library, for staff; None for anyone else (a clinician never needs it: their apps carry the rules)."""
        if not caller.is_staff:
            return None
        return [self._shape_entry(h) for h in self.list_shape_items()]

    def get_shape(self, caller: Caller, shape_id: str) -> dict[str, Any] | None:
        """One shape with every version (document and artifact) and its history, newest first."""
        if not caller.is_staff:
            return None
        head = self._shape_head(shape_pk(shape_id))
        if not head:
            return None
        shown = self._shape_entry(head)
        versions = self._by_prefix(head["PK"], "V#", newest_first=True)
        shown["versions"] = [present_shape_version(v) for v in versions]
        # A shape's history spans its versions, so each step says which one it concerns.
        shown["history"] = [{**present_event(e), "version": e.get("version")} for e in self._by_prefix(head["PK"], "EVT#", newest_first=True)]
        return shown

    def get_app_version(self, caller: Caller, app_id: str, version: str) -> dict[str, Any] | None:
        head = self.get_head(app_id)

        if not head:
            return None

        if version in ("active", "latest"):
            if version == "latest" and not caller.is_staff:
                version = "active"  # clinicians never get drafts through an alias

            resolved = head.get("active_version") if version == "active" else head.get("latest_version")

            if not resolved:
                return None
            version = resolved

        item = self.get_version(app_id, version)

        if not item:
            return None

        return self._visible(caller, head, item)


# ── Lambda entry point ────────────────────────────────────────────────────────────────────

_reader: RegistryReader | None = None


def _get_reader() -> RegistryReader:
    global _reader

    if _reader is None:
        import boto3  # local import keeps unit tests free of the SDK

        table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        _reader = RegistryReader(table)

    return _reader


def _response(status: int, body: Any) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, default=str),
    }


def handle(event: dict[str, Any], reader: RegistryReader) -> dict[str, Any]:
    caller = caller_from_event(event)

    if not caller.sub:
        return _response(401, {"message": "No authenticated caller."})

    route = event.get("routeKey", "")
    params = event.get("pathParameters") or {}

    if route == "GET /registry/apps":
        return _response(200, {"apps": reader.list_apps(caller)})

    if route == "GET /registry/collections":
        return _response(200, {"collections": reader.list_collections(caller)})

    if route == "GET /registry/shapes":
        shapes = reader.list_shapes(caller)

        if shapes is None:
            return _response(403, {"message": "The record-shape library is for authors, approvers and admins."})

        return _response(200, {"shapes": shapes})

    if route == "GET /registry/shapes/{shape_id}":
        shape = reader.get_shape(caller, params.get("shape_id", ""))

        if shape is None:
            return _response(404, {"message": "No such shape, or the library is not available to you."})

        return _response(200, shape)

    if route == "GET /registry/apps/{app_id}/versions/{version}":
        shown = reader.get_app_version(caller, params.get("app_id", ""), params.get("version", "active"))

        if not shown:
            # 404 for both "does not exist" and "not visible to you": no oracle for hidden apps.
            return _response(404, {"message": "No such app version, or it is not available to you."})

        return _response(200, shown)

    return _response(404, {"message": f"Unknown route {route}"})


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_reader())
