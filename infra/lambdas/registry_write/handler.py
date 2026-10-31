"""
Registry write API — how a draft becomes an app, and how an app moves through its lifecycle.

    POST /registry/apps                                        { session_id }        → 201 { app_id, version, state }
    POST /registry/apps/{app_id}/versions                      { session_id }        → 201 { app_id, version, state, parent_version }
    PUT  /registry/apps/{app_id}/versions/{version}            { session_id }        → 200 { app_id, version, state, revised }
    POST /registry/apps/{app_id}/versions/{version}/transitions { to, notes? }        → 200 { app_id, version, state, signoff? }
    POST /registry/shapes                                      { document }          → 201 { shape_id, version, state, … }
    PUT  /registry/shapes/{shape_id}                           { document }          → 200 the shape (a draft revised, or a new draft version)
    POST /registry/shapes/{shape_id}/versions/{version}/transitions { to, notes? }   → 200 the shape

Creating: the drafting session's spec is compiled by the manifest service (the only compiler), the
manifest and the spec are frozen into a VERSION item in `draft`, HEAD is created or advanced — one
transaction. Transitions follow medapp_shared.registry_model.LIFECYCLE_TRANSITIONS with the who-may
rules of identity_model (authors submit, approvers approve — never their own work, admins may do
either); approval signs the manifest hash with the hospital's KMS key; publishing creates the app's
Cognito role groups (existing groups must exist), sets HEAD.active_version and deprecates the version
that was published before — again one transaction, so there is never more than one published version.

Record shapes (the library a `record` section writes with, `shape: <id>`) are versioned the same way, under the
lighter lifecycle of registry_model.SHAPE_TRANSITIONS: authors create and revise drafts, approvers and admins publish
and deprecate; the document is compiled by the manifest service and the artifact frozen with it. An app compile is
handed the published artifacts so its `shape:` references resolve.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Protocol

from medapp_shared.audit_model import AuditSink, new_record
from medapp_shared.http_auth import Caller, caller_from_event, json_body, response
from medapp_shared.identity_model import app_role_group, can_approve, can_author, can_curate, can_iterate, is_admin
from medapp_shared.registry_model import (
    HEAD_SK,
    SHAPE_FIRST_VERSION,
    SHAPES_GSI1PK,
    IllegalTransition,
    app_pk,
    assert_shape_transition,
    assert_transition,
    canonical_json,
    collection_gsi1,
    collection_id_for,
    collection_item,
    collection_pk,
    event_item,
    head_item,
    next_minor,
    present_collection,
    present_shape,
    present_version,
    shape_event_item,
    shape_gsi1,
    shape_head_item,
    shape_pk,
    shape_revision_sets,
    shape_version_item,
    state_gsi1,
    revision_sets,
    version_item,
    version_sk,
)

# ── the tiny persistence interface the writer needs (plain dict items; the boto3 adapter serialises) ──


@dataclass(frozen=True)
class Condition:
    kind: Literal["not_exists", "attr_equals"]
    attr: str | None = None
    value: Any = None


@dataclass(frozen=True)
class Put:
    item: dict[str, Any]
    condition: Condition | None = None


@dataclass(frozen=True)
class Update:
    pk: str
    sk: str
    sets: dict[str, Any]
    condition: Condition | None = None


TxOp = Put | Update


class TransactionFailed(Exception):
    pass


class RegistryClient(Protocol):
    def get(self, pk: str, sk: str) -> dict[str, Any] | None: ...
    def index(self, gsi1pk: str) -> list[dict[str, Any]]:
        """The items under one GSI1 partition — keys and projected attributes only; read what you need by key."""
        ...

    def transact(self, ops: list[TxOp]) -> None: ...


class Signer(Protocol):
    def sign(self, message: str) -> str: ...


class GroupProvisioner(Protocol):
    def exists(self, name: str) -> bool: ...
    def ensure(self, name: str, description: str) -> None: ...


class ManifestCompiler(Protocol):
    def compile(self, spec: dict[str, Any], hospital_id: str, created_by_sub: str | None = None, created_at: str | None = None, shapes: list[dict[str, Any]] | None = None) -> Any: ...
    def compile_shape(self, document: dict[str, Any]) -> Any: ...


class SessionSource(Protocol):
    def load(self, session_id: str) -> Any: ...
    def save(self, session: Any) -> None: ...


def _actor(caller: Caller) -> dict[str, Any]:
    """The person behind an event, as the history will show them."""
    return {"name": caller.display, "email": caller.email}


class Refused(Exception):
    def __init__(self, status: int, message: str, **extra: Any):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class DefinitionsPublisher(Protocol):
    """Writes an app's FHIR definitions (its Questionnaires) to the record when the app is published."""

    def publish(self, app_id: str, version: str, resources: list[dict[str, Any]]) -> str: ...


class NoDefinitionsPublisher:
    """A deployment without a FHIR server to write to (the bundled synthetic record): the forms stay in the manifest, which is their source anyway."""

    def publish(self, app_id: str, version: str, resources: list[dict[str, Any]]) -> str:
        return "unavailable"


@dataclass
class RegistryWriter:
    registry: RegistryClient
    sessions: SessionSource
    compiler: ManifestCompiler
    signer: Signer
    groups: GroupProvisioner
    hospital_id: str
    definitions: DefinitionsPublisher = field(default_factory=NoDefinitionsPublisher)
    now: Any = field(default=_now)
    # Where lifecycle records go: the log, and the audit table when one is configured (the registry's EVENT items stay the
    # registry's own history; the trail is where an auditor sees them beside the data accesses).
    audit: Any = field(default_factory=lambda: AuditSink("registry", None))

    def _trail(self, kind: str, caller: Caller, app_id: str, version: str, detail: str, **fields: Any) -> None:
        self.audit.emit(new_record(kind, user_sub=caller.sub, user_name=caller.display, user_email=caller.email, app_id=app_id, manifest_version=version, detail=detail, **fields))

    # ── helpers ────────────────────────────────────────────────────────────

    def _session_for(self, caller: Caller, session_id: str, revising: tuple[str, str] | None = None) -> Any:
        """The caller's own draft, idle. Unsaved for a new version; saved as exactly `revising` (app_id, version) for a revision."""
        s = self.sessions.load(session_id)
        if s is None or s.author_sub != caller.sub:
            raise Refused(404, "No such draft.")  # only its author saves a draft; admins iterate from their own
        if s.turn_busy:
            raise Refused(409, "The agent is still working on this draft.")
        saved = s.saved_as or {}
        if revising is not None:
            if (str(saved.get("app_id", "")), str(saved.get("version", ""))) != revising:
                raise Refused(409, "This draft is not the conversation that version was saved from.", saved_as=s.saved_as)
        elif s.saved_as:
            raise Refused(409, "This draft has already been saved.", saved_as=s.saved_as)
        return s

    def _compile(self, caller: Caller, spec: dict[str, Any], now: str, created_by_sub: str | None = None) -> dict[str, Any]:
        result = self.compiler.compile(spec, self.hospital_id, created_by_sub=created_by_sub or caller.sub, created_at=now, shapes=self.published_shapes())
        if not result.ok or result.manifest is None:
            raise Refused(422, "The draft does not compile.", issues=[{"path": i.path, "message": i.message} for i in result.issues])
        return result.manifest

    def published_shapes(self) -> list[dict[str, Any]]:
        """The library as a compile sees it: the artifact of every shape's published version (the index names the heads; each is read by key)."""
        out: list[dict[str, Any]] = []
        for named in self.registry.index(SHAPES_GSI1PK):
            head = self.registry.get(named["PK"], HEAD_SK)
            if not head or not head.get("active_version"):
                continue
            version = self.registry.get(head["PK"], version_sk(str(head["active_version"])))
            if version and version.get("state") == "published":
                out.append({**json.loads(version["artifact_json"]), "version": str(version["version"])})  # the version goes onto every record's tag
        return out

    def _existing_groups_must_exist(self, manifest: dict[str, Any]) -> None:
        app_id = manifest["metadata"]["app_id"]
        missing = [r["cognito_group"] for r in manifest["auth"]["roles"] if r["cognito_group"] != app_role_group(app_id, r["id"]) and not self.groups.exists(r["cognito_group"])]
        if missing:
            raise Refused(409, f"Roles are bound to groups that do not exist in the user pool: {', '.join(missing)}.", missing_groups=missing)

    def _mark_saved(self, session: Any, app_id: str, version: str, state: str = "draft") -> None:
        # `state` follows the version (transition() keeps it current): the panel and the drafts API treat the
        # conversation as editable while it is `draft` and frozen from submission on.
        session.saved_as = {"app_id": app_id, "version": version, "at": self.now(), "state": state}
        self.sessions.save(session)

    def _stamp_state(self, item: Mapping[str, Any], to: str) -> None:
        """Tell the drafting conversation that produced a version what state it is in now (no-op for versions without one)."""
        sid = item.get("session_id")
        if not sid:
            return
        s = self.sessions.load(str(sid))
        if s is None or not s.saved_as or s.saved_as.get("version") != item.get("version"):
            return
        s.saved_as = {**s.saved_as, "state": to}
        self.sessions.save(s)

    # ── create / iterate ───────────────────────────────────────────────────

    def create_app(self, caller: Caller, session_id: str) -> dict[str, Any]:
        if not can_author(caller.groups):
            raise Refused(403, "Creating apps is for authors and admins.")
        session = self._session_for(caller, session_id)
        now = self.now()
        spec = json.loads(json.dumps(session.spec))
        spec.setdefault("apiVersion", "medapp.eu/v1")
        spec.setdefault("kind", "AppSpec")
        spec.setdefault("app", {})["version"] = "0.1.0"
        spec["app"].pop("parent_version", None)
        manifest = self._compile(caller, spec, now)
        app_id = manifest["metadata"]["app_id"]
        if self.registry.get(app_pk(app_id), HEAD_SK):
            raise Refused(409, f"An app with id {app_id} already exists; iterate on it or choose another id.", app_id=app_id)
        self._existing_groups_must_exist(manifest)

        version = version_item(manifest, created_by_sub=caller.sub, now=now, spec=spec, session_id=session.session_id, author={"name": caller.display, "email": caller.email})
        head = head_item(manifest, owner_sub=caller.sub, now=now, latest_version="0.1.0", latest_state="draft")
        created = event_item(app_id, "0.1.0", ts=now, actor_sub=caller.sub, from_state=None, to_state="draft", notes=f"created from draft {session_id}", actor=_actor(caller))
        try:
            self.registry.transact([Put(version, Condition("not_exists")), Put(head, Condition("not_exists")), Put(created, Condition("not_exists"))])
        except TransactionFailed as e:
            raise Refused(409, f"The app could not be created: {e}") from e
        self._mark_saved(session, app_id, "0.1.0")
        self._trail("lifecycle.created", caller, app_id, "0.1.0", f"new app {manifest['metadata']['name']}, saved as draft 0.1.0")
        return {"app_id": app_id, "version": "0.1.0", "state": "draft", "manifest_hash": version["manifest_hash"]}

    def create_version(self, caller: Caller, app_id: str, session_id: str) -> dict[str, Any]:
        head = self.registry.get(app_pk(app_id), HEAD_SK)
        if not head:
            raise Refused(404, "No such app.")
        if not can_iterate(caller.groups, caller_sub=caller.sub, owner_sub=str(head.get("owner_sub", ""))):
            raise Refused(403, "New versions are for the app's owner or an admin.")
        session = self._session_for(caller, session_id)
        now = self.now()
        latest = str(head["latest_version"])
        version = next_minor(latest)
        spec = json.loads(json.dumps(session.spec))
        spec.setdefault("apiVersion", "medapp.eu/v1")
        spec.setdefault("kind", "AppSpec")
        app = spec.setdefault("app", {})
        if app.get("app_id") not in (None, app_id):
            raise Refused(400, f"The draft is for {app.get('app_id')}, not {app_id}.")
        app["app_id"] = app_id
        app["version"] = version
        app["parent_version"] = latest
        manifest = self._compile(caller, spec, now)
        self._existing_groups_must_exist(manifest)

        item = version_item(manifest, created_by_sub=caller.sub, now=now, spec=spec, session_id=session.session_id, author={"name": caller.display, "email": caller.email})
        created = event_item(app_id, version, ts=now, actor_sub=caller.sub, from_state=None, to_state="draft", notes=f"created from draft {session_id}; iterates {latest}", actor=_actor(caller))
        try:
            self.registry.transact(
                [
                    Put(item, Condition("not_exists")),
                    Update(app_pk(app_id), HEAD_SK, {"latest_version": version, "latest_state": "draft", "updated_at": now, "name": manifest["metadata"]["name"], "description": manifest["metadata"].get("description")}, Condition("attr_equals", "latest_version", latest)),
                    Put(created, Condition("not_exists")),
                ]
            )
        except TransactionFailed as e:
            raise Refused(409, f"Someone else changed this app meanwhile: {e}") from e
        self._mark_saved(session, app_id, version)
        self._trail("lifecycle.created", caller, app_id, version, f"new version {version} (iterates on {latest}), saved as draft", parent_version=latest)
        return {"app_id": app_id, "version": version, "parent_version": latest, "state": "draft", "manifest_hash": item["manifest_hash"]}

    def replace_version(self, caller: Caller, app_id: str, version: str, session_id: str) -> dict[str, Any]:
        """
        Revise a draft version in place: the conversation it was saved from has changed, and the version takes the new
        content under the same number. Only while the version is `draft` — nobody has reviewed it, so nothing signed or
        seen is rewritten; from submission on a change is a new version (create_version). Owner or admin, and only
        through the conversation the version was saved from; every revision is an EVENT.
        """
        head = self.registry.get(app_pk(app_id), HEAD_SK)
        item = self.registry.get(app_pk(app_id), version_sk(version)) if head else None
        if not head or not item:
            raise Refused(404, "No such app version.")
        if str(item["state"]) != "draft":
            raise Refused(409, f"Only a draft version can be revised in place; this one is {item['state']}. Iterate on the app to make a new version.", state=item["state"])
        if not can_iterate(caller.groups, caller_sub=caller.sub, owner_sub=str(head.get("owner_sub", ""))):
            raise Refused(403, "Revising a version is for the app's owner or an admin.")
        session = self._session_for(caller, session_id, revising=(app_id, version))
        now = self.now()
        spec = json.loads(json.dumps(session.spec))
        spec.setdefault("apiVersion", "medapp.eu/v1")
        spec.setdefault("kind", "AppSpec")
        app = spec.setdefault("app", {})
        if app.get("app_id") not in (None, app_id):
            raise Refused(400, f"The draft is for {app.get('app_id')}, not {app_id}.")
        app["app_id"] = app_id
        app["version"] = version
        if item.get("parent_version"):
            app["parent_version"] = item["parent_version"]
        else:
            app.pop("parent_version", None)
        # The version keeps its identity — who created it and when; the revision is in updated_at and the event — so the
        # compile is deterministic: the same spec gives the same manifest and hash, whoever revises and whenever.
        manifest = self._compile(caller, spec, str(item.get("created_at") or now), created_by_sub=str(item.get("created_by_sub") or caller.sub))
        self._existing_groups_must_exist(manifest)

        sets = revision_sets(manifest, spec, now, session.session_id)
        ops: list[TxOp] = [
            Update(app_pk(app_id), version_sk(version), sets, Condition("attr_equals", "state", "draft")),
            Put(event_item(app_id, version, ts=now, actor_sub=caller.sub, from_state="draft", to_state="draft", notes=f"revised from draft {session_id}", actor=_actor(caller)), Condition("not_exists")),
        ]
        if head.get("latest_version") == version:
            ops.append(Update(app_pk(app_id), HEAD_SK, {"updated_at": now, "name": manifest["metadata"]["name"], "description": manifest["metadata"].get("description")}, Condition("attr_equals", "latest_version", version)))
        try:
            self.registry.transact(ops)
        except TransactionFailed as e:
            raise Refused(409, f"The version changed meanwhile: {e}") from e
        self._mark_saved(session, app_id, version)
        self._trail("lifecycle.revised", caller, app_id, version, f"draft {version} revised in place")
        return {"app_id": app_id, "version": version, "state": "draft", "manifest_hash": sets["manifest_hash"], "revised": True}

    # ── lifecycle ──────────────────────────────────────────────────────────

    def transition(self, caller: Caller, app_id: str, version: str, to: str, notes: str | None) -> dict[str, Any]:
        head = self.registry.get(app_pk(app_id), HEAD_SK)
        item = self.registry.get(app_pk(app_id), version_sk(version)) if head else None
        if not head or not item:
            raise Refused(404, "No such app version.")
        frm = str(item["state"])
        try:
            assert_transition(frm, to)
        except IllegalTransition as e:
            raise Refused(409, str(e)) from e

        owner = str(head.get("owner_sub", ""))
        author = str(item.get("created_by_sub", ""))
        self._authorize(caller, frm, to, owner, author)

        now = self.now()
        manifest = present_version(item)
        sets: dict[str, Any] = {"state": to, "updated_at": now, **state_gsi1(to, now, app_id, version)}
        signature: str | None = None
        signoff: dict[str, Any] | None = None
        if to == "approved":
            signature = self.signer.sign(str(item["manifest_hash"]))
            signoff = {"approver_sub": caller.sub, "approved_at": now, "signature": signature, "clinical_notes": notes}
            sets["signoff"] = signoff
        if to == "draft":
            # Back on the author's desk — recalled by them to make changes, or sent back by a reviewer. Whatever was
            # signed no longer stands: the content may now change, so the sign-off goes with the state.
            sets["signoff"] = None
        if to == "published":
            self._existing_groups_must_exist(manifest)
            for role in manifest["auth"]["roles"]:
                if role["cognito_group"] == app_role_group(app_id, role["id"]):
                    self.groups.ensure(role["cognito_group"], f"{manifest['metadata']['name']} · {role['display_name']}")

        ops: list[TxOp] = [
            Update(app_pk(app_id), version_sk(version), sets, Condition("attr_equals", "state", frm)),
            Put(event_item(app_id, version, ts=now, actor_sub=caller.sub, from_state=frm, to_state=to, notes=notes, signature=signature, actor=_actor(caller)), Condition("not_exists")),
        ]
        head_sets: dict[str, Any] = {"updated_at": now}
        if head.get("latest_version") == version:
            head_sets["latest_state"] = to
        if to == "published":
            head_sets["active_version"] = version
            previous = head.get("active_version")
            if previous and previous != version:
                ops.append(Update(app_pk(app_id), version_sk(str(previous)), {"state": "deprecated", "updated_at": now, **state_gsi1("deprecated", now, app_id, str(previous))}, Condition("attr_equals", "state", "published")))
                ops.append(Put(event_item(app_id, str(previous), ts=now, actor_sub=caller.sub, from_state="published", to_state="deprecated", notes=f"superseded by {version}", actor=_actor(caller)), Condition("not_exists")))
        if to == "deprecated" and head.get("active_version") == version:
            head_sets["active_version"] = None
        ops.append(Update(app_pk(app_id), HEAD_SK, head_sets, Condition("attr_equals", "latest_version", head.get("latest_version"))))
        try:
            self.registry.transact(ops)
        except TransactionFailed as e:
            raise Refused(409, f"The version changed meanwhile: {e}") from e
        self._stamp_state(item, to)  # the conversation freezes at submission and thaws if the version is sent back to draft
        self._trail(f"lifecycle.{to}", caller, app_id, version, f"{frm} → {to}" + (f": {notes}" if notes else ""), from_state=frm, to_state=to)
        out: dict[str, Any] = {"app_id": app_id, "version": version, "state": to}
        if signoff:
            out["signoff"] = signoff
        if to == "published":
            # The forms the app carries go to the record too, so its QuestionnaireResponses resolve for other systems.
            # Best effort, after the fact: the manifest is the source the app reads from; the record's copy is a courtesy.
            questionnaires = [q for q in ((manifest.get("artifacts") or {}).get("questionnaires") or []) if isinstance(q, dict)]
            if questionnaires:
                try:
                    out["definitions"] = self.definitions.publish(app_id, version, questionnaires)
                except Exception as err:  # noqa: BLE001 — a failed courtesy copy never undoes a publish
                    print(json.dumps({"definitions": {"app_id": app_id, "version": version, "outcome": "failed", "error": str(err)}}))
                    out["definitions"] = "failed"
        return out

    # ── collections ────────────────────────────────────────────────────────
    # How the hospital groups its published apps for the launcher. Organisation, not a clinical change: approvers and
    # admins edit them without any version moving, and nothing here is reviewed or signed.

    def _curator(self, caller: Caller) -> None:
        if not can_curate(caller.groups):
            raise Refused(403, "Collections are curated by approvers and admins.")

    def _known_apps(self, app_ids: list[str]) -> list[str]:
        unknown = [a for a in app_ids if not self.registry.get(app_pk(a), HEAD_SK)]
        if unknown:
            raise Refused(404, f"No such app: {', '.join(unknown)}.", unknown=unknown)
        return list(dict.fromkeys(app_ids))

    def create_collection(self, caller: Caller, name: str, description: str | None, app_ids: list[str]) -> dict[str, Any]:
        self._curator(caller)
        try:
            collection_id = collection_id_for(name)
        except ValueError as e:
            raise Refused(400, str(e)) from e
        if self.registry.get(collection_pk(collection_id), HEAD_SK):
            raise Refused(409, f"A collection named like that already exists ({collection_id}).", collection_id=collection_id)
        ids = self._known_apps(app_ids)
        item = collection_item(collection_id, name=name, description=description, app_ids=ids, now=self.now(), actor_sub=caller.sub, actor=_actor(caller))
        try:
            self.registry.transact([Put(item, Condition("not_exists"))])
        except TransactionFailed as e:
            raise Refused(409, f"The collection was created meanwhile: {e}") from e
        self.audit.emit(new_record("platform.collection.created", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, collection_id=collection_id, detail=f"{item['name']}: {len(ids)} app{'s' if len(ids) != 1 else ''}"))
        return present_collection(item)

    def update_collection(self, caller: Caller, collection_id: str, *, name: str | None = None, description: str | None = None, app_ids: list[str] | None = None) -> dict[str, Any]:
        self._curator(caller)
        item = self.registry.get(collection_pk(collection_id), HEAD_SK)
        if not item or item.get("GSI1PK", "").endswith("#deleted"):
            raise Refused(404, "No such collection.")
        now = self.now()
        sets: dict[str, Any] = {"updated_at": now, "updated_by_sub": caller.sub, "updated_by": _actor(caller)}
        changes: list[str] = []
        if name is not None and name.strip() and name.strip() != item["name"]:
            sets["name"] = name.strip()
            sets.update(collection_gsi1(name, collection_id))
            changes.append(f"renamed from “{item['name']}”")
        if description is not None and ((description or "").strip() or None) != item.get("description"):
            sets["description"] = (description or "").strip() or None
            changes.append("description changed")
        if app_ids is not None:
            ids = self._known_apps(app_ids)
            before = list(item.get("app_ids") or [])
            if ids != before:
                sets["app_ids"] = ids
                added = [a for a in ids if a not in before]
                removed = [a for a in before if a not in ids]
                if added:
                    changes.append("added " + ", ".join(added))
                if removed:
                    changes.append("removed " + ", ".join(removed))
                if not added and not removed:
                    changes.append("reordered")
        if not changes:
            return present_collection(item)
        try:
            self.registry.transact([Update(collection_pk(collection_id), HEAD_SK, sets, Condition("attr_equals", "updated_at", item["updated_at"]))])
        except TransactionFailed as e:
            raise Refused(409, f"The collection changed meanwhile: {e}") from e
        self.audit.emit(new_record("platform.collection.updated", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, collection_id=collection_id, detail=f"{sets.get('name', item['name'])}: " + "; ".join(changes)))
        return present_collection({**item, **sets})

    def delete_collection(self, caller: Caller, collection_id: str) -> dict[str, Any]:
        """Removed from the listing — the item stays, its index key says it is gone — and audited like the rest."""
        self._curator(caller)
        item = self.registry.get(collection_pk(collection_id), HEAD_SK)
        if not item or item.get("GSI1PK", "").endswith("#deleted"):
            raise Refused(404, "No such collection.")
        now = self.now()
        sets = {"updated_at": now, "updated_by_sub": caller.sub, "updated_by": _actor(caller), "deleted_at": now, **collection_gsi1(item["name"], collection_id, deleted=True)}
        try:
            self.registry.transact([Update(collection_pk(collection_id), HEAD_SK, sets, Condition("attr_equals", "updated_at", item["updated_at"]))])
        except TransactionFailed as e:
            raise Refused(409, f"The collection changed meanwhile: {e}") from e
        self.audit.emit(new_record("platform.collection.deleted", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, collection_id=collection_id, detail=f"{item['name']} removed ({len(item.get('app_ids') or [])} apps were in it)"))
        return {"collection_id": collection_id, "deleted": True}

    # ── record shapes ──────────────────────────────────────────────────────
    # The library a `record` section writes with. A shape is created and revised by authors (its owner, or an admin,
    # or a curator — the library is theirs to keep tidy), published and deprecated by approvers and admins. Every
    # version is compiled by the manifest service and frozen with its artifact; apps embed the artifact they were
    # compiled with, so a later version of the shape changes nothing already in the registry.

    def _compile_shape(self, document: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        if not isinstance(document, dict) or not document:
            raise Refused(400, "Send the shape as `document`: a RecordShape (apiVersion, kind, shape).")
        result = self.compiler.compile_shape(document)
        if not result.ok or result.artifact is None:
            raise Refused(422, "The shape does not compile.", issues=[{"path": i.path, "message": i.message} for i in result.issues])
        return document, result.artifact

    def _shape(self, shape_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        head = self.registry.get(shape_pk(shape_id), HEAD_SK)
        if not head:
            raise Refused(404, "No such shape.")
        latest = self.registry.get(shape_pk(shape_id), version_sk(str(head["latest_version"])))
        if not latest:
            raise Refused(500, "The shape's latest version is missing.")
        return head, latest

    def _present_shape(self, head: dict[str, Any], latest: dict[str, Any]) -> dict[str, Any]:
        active = head.get("active_version")
        published = latest if active and latest.get("version") == active else (self.registry.get(head["PK"], version_sk(str(active))) if active else None)
        return present_shape(head, latest=latest, published=published)

    def _may_edit_shape(self, caller: Caller, head: Mapping[str, Any]) -> None:
        if not (can_iterate(caller.groups, caller_sub=caller.sub, owner_sub=str(head.get("owner_sub", ""))) or can_curate(caller.groups)):
            raise Refused(403, "Revising a shape is for its owner, approvers or admins.")

    def _open_kind_is_admins(self, caller: Caller, artifact: Mapping[str, Any]) -> None:
        """A shape for a kind the platform has not admitted declares the platform's own stamps — an administrator's call, not an author's."""
        if artifact.get("open_kind") and not is_admin(caller.groups):
            raise Refused(403, f"A shape for {artifact.get('resource')} — a kind the platform has not admitted — is defined by administrators.", resource=artifact.get("resource"))

    def create_shape(self, caller: Caller, document: Any) -> dict[str, Any]:
        if not can_author(caller.groups):
            raise Refused(403, "Creating a shape is for authors and admins.")
        doc, artifact = self._compile_shape(document)
        self._open_kind_is_admins(caller, artifact)
        shape_id = str(artifact["id"])
        if self.registry.get(shape_pk(shape_id), HEAD_SK):
            raise Refused(409, f"A shape with the id {shape_id} already exists — revise it, or pick another id.", shape_id=shape_id)
        now = self.now()
        version = SHAPE_FIRST_VERSION
        head = shape_head_item(artifact, owner_sub=caller.sub, now=now, latest_version=version, actor=_actor(caller))
        item = shape_version_item(doc, artifact, version=version, created_by_sub=caller.sub, now=now, author=_actor(caller))
        try:
            self.registry.transact([Put(head, Condition("not_exists")), Put(item, Condition("not_exists")), Put(shape_event_item(shape_id, version, ts=now, actor_sub=caller.sub, from_state=None, to_state="draft", notes="created", actor=_actor(caller)))])
        except TransactionFailed as e:
            raise Refused(409, f"The shape was created meanwhile: {e}") from e
        self.audit.emit(new_record("platform.shape.created", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, shape_id=shape_id, manifest_version=version, detail=f"{artifact['name']} ({artifact['resource']}, {len(artifact.get('fields') or [])} fields)"))
        return self._present_shape(head, item)

    def revise_shape(self, caller: Caller, shape_id: str, document: Any) -> dict[str, Any]:
        """A draft is revised in place; a published or deprecated latest version gets a new draft version after it."""
        head, latest = self._shape(shape_id)
        self._may_edit_shape(caller, head)
        doc, artifact = self._compile_shape(document)
        self._open_kind_is_admins(caller, artifact)
        if str(artifact["id"]) != shape_id:
            raise Refused(409, f"The document's id ({artifact['id']}) is not this shape's ({shape_id}); the id is the shape's name across apps and does not change.")
        now = self.now()
        head_sets: dict[str, Any] = {"name": artifact["name"], "description": artifact.get("description"), "resource": artifact["resource"], "updated_at": now, "updated_by_sub": caller.sub, "updated_by": _actor(caller), **shape_gsi1(artifact["name"], shape_id)}
        if latest["state"] == "draft":
            if latest.get("artifact_json") == canonical_json(artifact):
                return self._present_shape(head, latest)
            version = str(latest["version"])
            sets = shape_revision_sets(doc, artifact, now)
            ops: list[TxOp] = [
                Update(head["PK"], latest["SK"], sets, Condition("attr_equals", "updated_at", latest["updated_at"])),
                Update(head["PK"], HEAD_SK, head_sets, Condition("attr_equals", "updated_at", head["updated_at"])),
                Put(shape_event_item(shape_id, version, ts=now, actor_sub=caller.sub, from_state="draft", to_state="draft", notes="revised", actor=_actor(caller))),
            ]
            shown = {**latest, **sets}
            what = "revised"
        else:
            version = next_minor(str(latest["version"]))
            item = shape_version_item(doc, artifact, version=version, created_by_sub=caller.sub, now=now, parent_version=str(latest["version"]), author=_actor(caller))
            head_sets.update({"latest_version": version, "latest_state": "draft"})
            ops = [
                Put(item, Condition("not_exists")),
                Update(head["PK"], HEAD_SK, head_sets, Condition("attr_equals", "updated_at", head["updated_at"])),
                Put(shape_event_item(shape_id, version, ts=now, actor_sub=caller.sub, from_state=None, to_state="draft", notes=f"from {latest['version']}", actor=_actor(caller))),
            ]
            shown = item
            what = f"new draft after {latest['version']}"
        try:
            self.registry.transact(ops)
        except TransactionFailed as e:
            raise Refused(409, f"The shape changed meanwhile: {e}") from e
        self.audit.emit(new_record("platform.shape.revised", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, shape_id=shape_id, manifest_version=version, detail=f"{artifact['name']}: {what}"))
        return self._present_shape({**head, **head_sets}, shown)

    def transition_shape(self, caller: Caller, shape_id: str, version: str, to: str, notes: str | None = None) -> dict[str, Any]:
        """Publish (the one published version supersedes the previous, which is deprecated in the same transaction) or deprecate."""
        if not can_curate(caller.groups):
            raise Refused(403, "Publishing and deprecating shapes is for approvers and admins.")
        head, latest = self._shape(shape_id)
        item = latest if str(latest["version"]) == version else self.registry.get(head["PK"], version_sk(version))
        if not item:
            raise Refused(404, "No such shape version.")
        try:
            assert_shape_transition(str(item["state"]), to)
        except IllegalTransition as e:
            raise Refused(409, str(e), state=item["state"]) from e
        now = self.now()
        sets = {"state": to, "updated_at": now}
        head_sets: dict[str, Any] = {"updated_at": now, "updated_by_sub": caller.sub, "updated_by": _actor(caller)}
        if str(head["latest_version"]) == version:
            head_sets["latest_state"] = to
        ops: list[TxOp] = [Update(head["PK"], item["SK"], sets, Condition("attr_equals", "updated_at", item["updated_at"])), Put(shape_event_item(shape_id, version, ts=now, actor_sub=caller.sub, from_state=str(item["state"]), to_state=to, notes=notes, actor=_actor(caller)))]
        detail = f"{head['name']} {version} {to}"
        if to == "published":
            previous = str(head["active_version"]) if head.get("active_version") else None
            if previous and previous != version:
                prev = self.registry.get(head["PK"], version_sk(previous))
                if prev and prev.get("state") == "published":
                    ops.append(Update(head["PK"], prev["SK"], {"state": "deprecated", "updated_at": now}, Condition("attr_equals", "updated_at", prev["updated_at"])))
                    ops.append(Put(shape_event_item(shape_id, previous, ts=now, actor_sub=caller.sub, from_state="published", to_state="deprecated", notes=f"superseded by {version}", actor=_actor(caller))))
                    detail += f" (supersedes {previous})"
            head_sets["active_version"] = version
        elif to == "deprecated" and str(head.get("active_version") or "") == version:
            head_sets["active_version"] = None
            detail += " — the library offers no published version of it now"
        ops.append(Update(head["PK"], HEAD_SK, head_sets, Condition("attr_equals", "updated_at", head["updated_at"])))
        try:
            self.registry.transact(ops)
        except TransactionFailed as e:
            raise Refused(409, f"The shape changed meanwhile: {e}") from e
        self.audit.emit(new_record(f"platform.shape.{to}", user_sub=caller.sub, user_name=caller.display, user_email=caller.email, shape_id=shape_id, manifest_version=version, detail=detail + (f": {notes}" if notes else "")))
        new_head = {**head, **head_sets}
        shown = {**item, **sets} if str(latest["version"]) == version else latest
        return self._present_shape(new_head, shown)

    @staticmethod
    def _authorize(caller: Caller, frm: str, to: str, owner: str, author: str) -> None:
        owns = can_iterate(caller.groups, caller_sub=caller.sub, owner_sub=owner)
        approves = can_approve(caller.groups, caller_sub=caller.sub, author_sub=author)
        if to == "in_review" and not owns:
            raise Refused(403, "Submitting for review is for the app's owner or an admin.")
        if to in ("approved", "published") and not approves:
            raise Refused(403, "Approving and publishing is for approvers and admins — and never the version's own author.")
        if to == "draft" and not (approves or owns):  # rejection by a reviewer, or reopening by the owner
            raise Refused(403, "Only a reviewer or the owner may send this version back to draft.")
        if to == "deprecated" and not (owns or approves or is_admin(caller.groups)):
            raise Refused(403, "Deprecating is for the owner, approvers or admins.")


# ── AWS adapters ────────────────────────────────────────────────────────────────


class Boto3RegistryClient:
    """Plain-dict items over the low-level DynamoDB client (TransactWriteItems needs it)."""

    def __init__(self, table_name: str, client: Any):
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self._table = table_name
        self._client = client
        self._ser = TypeSerializer()
        self._de = TypeDeserializer()

    def _to(self, value: Any) -> Any:
        return self._ser.serialize(json.loads(json.dumps(value, default=str), parse_float=__import__("decimal").Decimal))

    def get(self, pk: str, sk: str) -> dict[str, Any] | None:
        res = self._client.get_item(TableName=self._table, Key={"PK": {"S": pk}, "SK": {"S": sk}}, ConsistentRead=True)
        item = res.get("Item")
        return {k: self._de.deserialize(v) for k, v in item.items()} if item else None

    def index(self, gsi1pk: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"TableName": self._table, "IndexName": "GSI1", "KeyConditionExpression": "GSI1PK = :pk", "ExpressionAttributeValues": {":pk": {"S": gsi1pk}}}
        while True:
            page = self._client.query(**kwargs)
            out.extend({k: self._de.deserialize(v) for k, v in item.items()} for item in page.get("Items", []))
            last = page.get("LastEvaluatedKey")
            if not last:
                return out
            kwargs["ExclusiveStartKey"] = last

    def _condition(self, c: Condition | None, names: dict[str, str], values: dict[str, Any]) -> str | None:
        if c is None:
            return None
        if c.kind == "not_exists":
            return "attribute_not_exists(PK)"
        names["#cond"] = str(c.attr)
        values[":cond"] = self._to(c.value)
        return "#cond = :cond"

    def transact(self, ops: list[TxOp]) -> None:
        items = []
        for op in ops:
            names: dict[str, str] = {}
            values: dict[str, Any] = {}
            if isinstance(op, Put):
                entry: dict[str, Any] = {"TableName": self._table, "Item": {k: self._to(v) for k, v in op.item.items()}}
                cond = self._condition(op.condition, names, values)
                if cond:
                    entry["ConditionExpression"] = cond
                if names:
                    entry["ExpressionAttributeNames"] = names
                if values:
                    entry["ExpressionAttributeValues"] = values
                items.append({"Put": entry})
            else:
                sets = []
                for i, (k, v) in enumerate(op.sets.items()):
                    names[f"#a{i}"] = k
                    values[f":v{i}"] = self._to(v)
                    sets.append(f"#a{i} = :v{i}")
                entry = {"TableName": self._table, "Key": {"PK": {"S": op.pk}, "SK": {"S": op.sk}}, "UpdateExpression": "SET " + ", ".join(sets)}
                cond = self._condition(op.condition, names, values)
                if cond:
                    entry["ConditionExpression"] = cond
                entry["ExpressionAttributeNames"] = names
                entry["ExpressionAttributeValues"] = values
                items.append({"Update": entry})
        try:
            self._client.transact_write_items(TransactItems=items)
        except self._client.exceptions.TransactionCanceledException as e:
            raise TransactionFailed(str(e)) from e


class KmsSigner:
    def __init__(self, key_id: str, client: Any):
        self._key = key_id
        self._client = client

    def sign(self, message: str) -> str:
        res = self._client.sign(KeyId=self._key, Message=message.encode("utf-8"), MessageType="RAW", SigningAlgorithm="ECDSA_SHA_256")
        return "kms:ECDSA_SHA_256:" + base64.b64encode(res["Signature"]).decode("ascii")


class CognitoGroupProvisioner:
    def __init__(self, user_pool_id: str, client: Any):
        self._pool = user_pool_id
        self._client = client

    def exists(self, name: str) -> bool:
        try:
            self._client.get_group(GroupName=name, UserPoolId=self._pool)
            return True
        except self._client.exceptions.ResourceNotFoundException:
            return False

    def ensure(self, name: str, description: str) -> None:
        try:
            self._client.create_group(GroupName=name, UserPoolId=self._pool, Description=description[:2048])
        except self._client.exceptions.GroupExistsException:
            pass


class LambdaDefinitionsPublisher:
    """
    Hands the resources to the data source's seed Lambda (`task: definitions`), which holds the FHIR server's
    credentials and PUTs each definition by id. The function is found through the SSM parameter the data source's
    stack publishes — looked up at first use, so the authoring stack never depends on the servers' stacks — and the
    invocation is asynchronous: publishing does not wait for the record.
    """

    def __init__(self, parameter_name: str, ssm_client: Any, lambda_client: Any):
        self._parameter = parameter_name
        self._ssm = ssm_client
        self._lambda = lambda_client
        self._function: str | None = None

    def _writer(self) -> str | None:
        if self._function is None:
            try:
                self._function = str(self._ssm.get_parameter(Name=self._parameter)["Parameter"]["Value"])
            except Exception as err:  # noqa: BLE001 — no parameter means no server to write to
                if type(err).__name__ != "ParameterNotFound":
                    raise
                self._function = ""
        return self._function or None

    def publish(self, app_id: str, version: str, resources: list[dict[str, Any]]) -> str:
        function = self._writer()
        if not function:
            print(json.dumps({"definitions": {"app_id": app_id, "version": version, "outcome": "unavailable", "count": len(resources)}}))
            return "unavailable"
        payload = {"task": "definitions", "app_id": app_id, "version": version, "resources": resources}
        self._lambda.invoke(FunctionName=function, InvocationType="Event", Payload=json.dumps(payload).encode("utf-8"))
        print(json.dumps({"definitions": {"app_id": app_id, "version": version, "outcome": "queued", "count": len(resources), "writer": function}}))
        return "queued"


# ── Lambda wiring ──────────────────────────────────────────────────────────────

_writer: RegistryWriter | None = None


def _get_writer() -> RegistryWriter:
    global _writer
    if _writer is None:
        import boto3  # local import keeps unit tests free of the SDK

        from app_creator.dynamo_store import DynamoSessionStore
        from app_creator.lambda_manifest_service import LambdaManifestService

        _writer = RegistryWriter(
            registry=Boto3RegistryClient(os.environ["TABLE_NAME"], boto3.client("dynamodb")),
            sessions=DynamoSessionStore(boto3.resource("dynamodb").Table(os.environ["DRAFTS_TABLE"])),
            compiler=LambdaManifestService(os.environ["MANIFEST_FUNCTION_NAME"]),
            signer=KmsSigner(os.environ["SIGNOFF_KEY_ID"], boto3.client("kms")),
            groups=CognitoGroupProvisioner(os.environ["USER_POOL_ID"], boto3.client("cognito-idp")),
            hospital_id=os.environ["HOSPITAL_ID"],
            definitions=LambdaDefinitionsPublisher(os.environ["DEFINITIONS_WRITER_PARAMETER"], boto3.client("ssm"), boto3.client("lambda")) if os.environ.get("DEFINITIONS_WRITER_PARAMETER") else NoDefinitionsPublisher(),
            audit=AuditSink.from_env("registry", os.environ),
        )
    return _writer


def handle(event: dict[str, Any], writer: RegistryWriter) -> dict[str, Any]:
    caller = caller_from_event(event)
    if not caller.sub:
        return response(401, {"message": "No authenticated caller."})
    if not caller.is_staff:
        return response(403, {"message": "The registry write API is for authors, approvers and admins."})
    route = event.get("routeKey", "")
    params = event.get("pathParameters") or {}
    try:
        body = json_body(event)
    except (ValueError, json.JSONDecodeError):
        return response(400, {"message": "Body must be a JSON object."})
    try:
        if route == "POST /registry/apps":
            return response(201, writer.create_app(caller, str(body.get("session_id", ""))))
        if route == "POST /registry/apps/{app_id}/versions":
            return response(201, writer.create_version(caller, params.get("app_id", ""), str(body.get("session_id", ""))))
        if route == "PUT /registry/apps/{app_id}/versions/{version}":
            return response(200, writer.replace_version(caller, params.get("app_id", ""), params.get("version", ""), str(body.get("session_id", ""))))
        if route == "POST /registry/apps/{app_id}/versions/{version}/transitions":
            to = str(body.get("to", ""))
            notes = str(body["notes"]) if body.get("notes") else None
            return response(200, writer.transition(caller, params.get("app_id", ""), params.get("version", ""), to, notes))
        if route == "POST /registry/collections":
            return response(201, writer.create_collection(caller, str(body.get("name", "")), _opt_str(body.get("description")), _ids(body.get("app_ids"))))
        if route == "PUT /registry/collections/{collection_id}":
            return response(
                200,
                writer.update_collection(
                    caller,
                    params.get("collection_id", ""),
                    name=_opt_str(body.get("name")),
                    description=str(body["description"]) if "description" in body and body["description"] is not None else ("" if "description" in body else None),
                    app_ids=_ids(body["app_ids"]) if "app_ids" in body else None,
                ),
            )
        if route == "DELETE /registry/collections/{collection_id}":
            return response(200, writer.delete_collection(caller, params.get("collection_id", "")))
        if route == "POST /registry/shapes":
            return response(201, writer.create_shape(caller, body.get("document")))
        if route == "PUT /registry/shapes/{shape_id}":
            return response(200, writer.revise_shape(caller, params.get("shape_id", ""), body.get("document")))
        if route == "POST /registry/shapes/{shape_id}/versions/{version}/transitions":
            notes = str(body["notes"]) if body.get("notes") else None
            return response(200, writer.transition_shape(caller, params.get("shape_id", ""), params.get("version", ""), str(body.get("to", "")), notes))
    except Refused as r:
        return response(r.status, {"message": str(r), **r.extra})
    return response(404, {"message": f"Unknown route {route}"})


def _opt_str(value: Any) -> str | None:
    return str(value) if value is not None and str(value).strip() else None


def _ids(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise Refused(400, "app_ids must be a list of app ids.")
    return value


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_writer())


__all__ = ["RegistryWriter", "Put", "Update", "Condition", "TransactionFailed", "Refused", "handle", "canonical_json"]
