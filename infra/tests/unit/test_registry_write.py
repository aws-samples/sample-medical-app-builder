"""
The registry write API over fakes: a draft becomes an app (one transaction), iteration bumps the minor
version, the lifecycle enforces who-may rules and separation of duties, approval signs the manifest
hash, publishing provisions groups and keeps exactly one published version.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

from app_creator.manifest_service import CliManifestService, CompileResult, ManifestServiceUnavailable, ServiceIssue, ShapeCompileResult
from app_creator.session import DraftSession, InMemorySessionStore
from medapp_shared.identity_model import app_role_group
from medapp_shared.registry_model import HEAD_SK, app_pk, present_version, shape_pk, version_sk

ROOT = Path(__file__).resolve().parents[2]
spec_ = importlib.util.spec_from_file_location("registry_write_handler", ROOT / "lambdas" / "registry_write" / "handler.py")
rw = importlib.util.module_from_spec(spec_)
sys.modules["registry_write_handler"] = rw
spec_.loader.exec_module(rw)  # type: ignore[union-attr]

BP_SPEC = yaml.safe_load((ROOT.parent / "med_app" / "specs" / "bp-trend.yaml").read_text(encoding="utf-8"))
BP_MANIFEST = yaml.safe_load((ROOT.parent / "med_app" / "fixtures" / "manifests" / "bp-trend.yaml").read_text(encoding="utf-8"))
GOAL_SHAPE = yaml.safe_load((ROOT.parent / "med_app" / "shapes" / "measurable-goal.yaml").read_text(encoding="utf-8"))


class FakeRegistry:
    """Plain-dict items; transactions check every condition first, then apply all — or nothing."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict] = {}

    def get(self, pk: str, sk: str) -> dict | None:
        item = self.items.get((pk, sk))
        return json.loads(json.dumps(item)) if item else None

    PROJECTED = {"PK", "SK", "GSI1PK", "GSI1SK", "type", "name", "state", "updated_at", "latest_version", "active_version"}

    def index(self, gsi1pk: str) -> list[dict]:
        """As the real GSI1 answers: keys and the projected attributes, nothing else (no shape_id, no artifact)."""
        return [{k: v for k, v in i.items() if k in self.PROJECTED} for i in self.items.values() if i.get("GSI1PK") == gsi1pk]

    def _ok(self, key: tuple[str, str], cond: rw.Condition | None) -> bool:  # type: ignore[name-defined]
        if cond is None:
            return True
        current = self.items.get(key)
        if cond.kind == "not_exists":
            return current is None
        return current is not None and current.get(cond.attr) == cond.value

    def transact(self, ops: list) -> None:  # type: ignore[type-arg]
        for op in ops:
            key = (op.item["PK"], op.item["SK"]) if isinstance(op, rw.Put) else (op.pk, op.sk)
            if not self._ok(key, op.condition):
                raise rw.TransactionFailed(f"condition failed for {key}: {op.condition}")
        for op in ops:
            if isinstance(op, rw.Put):
                self.items[(op.item["PK"], op.item["SK"])] = json.loads(json.dumps(op.item))
            else:
                self.items.setdefault((op.pk, op.sk), {"PK": op.pk, "SK": op.sk}).update(json.loads(json.dumps(op.sets)))

    def events(self, app_id: str) -> list[dict]:
        return sorted((i for (pk, sk), i in self.items.items() if pk == app_pk(app_id) and sk.startswith("EVT#")), key=lambda i: i["SK"])


class FakeSigner:
    def __init__(self) -> None:
        self.signed: list[str] = []

    def sign(self, message: str) -> str:
        self.signed.append(message)
        return "kms:ECDSA_SHA_256:c2lnbmF0dXJl"


class FakeGroups:
    def __init__(self, existing: set[str] | None = None) -> None:
        self.existing = set(existing or set())
        self.created: list[tuple[str, str]] = []

    def exists(self, name: str) -> bool:
        return name in self.existing

    def ensure(self, name: str, description: str) -> None:
        self.created.append((name, description))
        self.existing.add(name)


class FakeCompiler:
    """Stands in for the manifest service when the CLI is not runnable: the bp-trend manifest with the
    spec's identity and role bindings applied — enough for the writer's own behaviour. Shapes compile to
    a stand-in artifact (id, name, resource, fields, a checksum over the document) and refuse a document
    without fields; the library handed to each app compile is recorded."""

    def __init__(self) -> None:
        self.libraries: list[list[dict]] = []

    def compile_shape(self, document: dict) -> ShapeCompileResult:
        shape = document.get("shape") if isinstance(document, dict) else None
        if not isinstance(shape, dict) or not shape.get("fields"):
            return ShapeCompileResult(ok=False, issues=[ServiceIssue("shape.fields", "is required")])
        import hashlib

        checksum = "fnv1a64:" + hashlib.sha256(json.dumps(document, sort_keys=True).encode()).hexdigest()[:16]
        rules = {"resource": shape["resource"], "fields": [{**f, "as": "string"} for f in shape["fields"]], "stamps": list(shape.get("stamps") or [])}
        open_kind = shape["resource"] not in ("Goal", "CarePlan", "Encounter", "DocumentReference", "Consent")  # as the compiler marks a kind the platform has not admitted
        return ShapeCompileResult(ok=True, artifact={"id": shape["id"], "name": shape["name"], **({"description": shape["description"]} if shape.get("description") else {}), "resource": shape["resource"], **({"open_kind": True} if open_kind else {}), "fields": shape["fields"], "status": shape.get("status"), "rules": rules, "checksum": checksum})

    def compile(self, spec: dict, hospital_id: str, created_by_sub: str | None = None, created_at: str | None = None, shapes: list[dict] | None = None) -> CompileResult:
        self.libraries.append(list(shapes or []))
        if not spec.get("roles"):
            return CompileResult(ok=False, issues=[ServiceIssue("roles", "is required")])
        m = json.loads(json.dumps(BP_MANIFEST))
        app = spec["app"]
        m["metadata"].update({"app_id": app["app_id"], "version": app.get("version", "0.1.0"), "name": app.get("name", m["metadata"]["name"]), "hospital_id": hospital_id, "created_at": created_at or "t"})
        if created_by_sub:
            m["metadata"]["created_by_sub"] = created_by_sub
        m["metadata"].pop("parent_version", None)
        if app.get("parent_version"):
            m["metadata"]["parent_version"] = app["parent_version"]
        by_id = {r["id"]: r for r in spec["roles"]}
        for role in m["auth"]["roles"]:
            g = (by_id.get(role["id"]) or {}).get("group") or {"kind": "app_group"}
            role["cognito_group"] = g["name"] if g.get("kind") == "existing" else app_role_group(app["app_id"], role["id"])
        m["lifecycle"] = {"state": "draft", "signoff": None}
        return CompileResult(ok=True, manifest=m)


def compiler_available() -> CliManifestService | None:
    svc = CliManifestService()
    try:
        svc.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec"})
        return svc
    except ManifestServiceUnavailable:
        return None


AUTHOR = rw.Caller(sub="author-1", groups=("medapp-authors",))
OTHER_AUTHOR = rw.Caller(sub="author-2", groups=("medapp-authors",))
APPROVER = rw.Caller(sub="approver-1", groups=("medapp-approvers",))
AUTHOR_APPROVER = rw.Caller(sub="author-1", groups=("medapp-authors", "medapp-approvers"))
ADMIN = rw.Caller(sub="admin-1", groups=("medapp-admins",))
VIEWER = rw.Caller(sub="viewer-1", groups=("medapp-viewers",))


@pytest.fixture
def world():  # type: ignore[no-untyped-def]
    registry, sessions, signer, groups = FakeRegistry(), InMemorySessionStore(), FakeSigner(), FakeGroups({"kardiologie"})
    clock = iter(f"2026-09-14T10:{i:02d}:00Z" for i in range(60))
    writer = rw.RegistryWriter(registry=registry, sessions=sessions, compiler=FakeCompiler(), signer=signer, groups=groups, hospital_id="hsp-musterstadt", now=lambda: next(clock))
    return writer, registry, sessions, signer, groups


def draft(sessions: InMemorySessionStore, author: str = "author-1", spec: dict | None = None) -> DraftSession:
    s = DraftSession.new("hsp-musterstadt", author)
    s.spec = json.loads(json.dumps(spec or {k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}))
    sessions.save(s)
    return s


# ── create ────────────────────────────────────────────────────────────────────


def test_a_draft_becomes_an_app_in_one_transaction(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, _ = world
    s = draft(sessions)
    out = writer.create_app(AUTHOR, s.session_id)
    assert out == {"app_id": "app_bp_trend", "version": "0.1.0", "state": "draft", "manifest_hash": out["manifest_hash"]}
    head = registry.get(app_pk("app_bp_trend"), HEAD_SK)
    version = registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))
    assert head["owner_sub"] == "author-1" and head["latest_version"] == "0.1.0" and head["latest_state"] == "draft" and head["active_version"] is None
    assert version["state"] == "draft" and version["created_by_sub"] == "author-1"
    assert json.loads(version["spec_json"])["app"]["version"] == "0.1.0", "the spec is frozen beside the manifest"
    assert json.loads(version["manifest_json"])["metadata"]["created_by_sub"] == "author-1"
    assert [e["to_state"] for e in registry.events("app_bp_trend")] == ["draft"] and registry.events("app_bp_trend")[0]["from_state"] is None
    assert sessions.load(s.session_id).saved_as == {"app_id": "app_bp_trend", "version": "0.1.0", "at": "2026-09-14T10:01:00Z", "state": "draft"}
    assert version["session_id"] == s.session_id, "the version knows the conversation it came from"

    # Saved drafts are closed; the same app id cannot be created twice; approvers do not create apps.
    with pytest.raises(rw.Refused, match="already been saved"):
        writer.create_app(AUTHOR, s.session_id)
    s2 = draft(sessions)
    with pytest.raises(rw.Refused, match="already exists"):
        writer.create_app(AUTHOR, s2.session_id)
    with pytest.raises(rw.Refused, match="authors and admins"):
        writer.create_app(APPROVER, s2.session_id)
    with pytest.raises(rw.Refused, match="No such draft"):
        writer.create_app(OTHER_AUTHOR, s2.session_id)
    s2.begin_turn("more")
    sessions.save(s2)
    with pytest.raises(rw.Refused, match="still working"):
        writer.create_app(AUTHOR, s2.session_id)


def test_incomplete_or_badly_bound_drafts_are_refused_before_anything_is_written(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, groups = world
    incomplete = draft(sessions, spec={"archetype": "APP-02", "app": {"app_id": "app_x", "name": "X"}})
    with pytest.raises(rw.Refused, match="does not compile") as e:
        writer.create_app(AUTHOR, incomplete.session_id)
    assert e.value.status == 422 and e.value.extra["issues"][0]["path"] == "roles"
    ghost = draft(sessions, spec={**{k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}, "roles": [{**BP_SPEC["roles"][0], "group": {"kind": "existing", "name": "onkologie"}}, BP_SPEC["roles"][1]]})
    with pytest.raises(rw.Refused, match="do not exist in the user pool: onkologie") as e:
        writer.create_app(AUTHOR, ghost.session_id)
    assert e.value.status == 409 and registry.items == {} and groups.created == []


# ── iterate ───────────────────────────────────────────────────────────────────


def test_a_new_version_bumps_the_minor_and_advances_head(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, _ = world
    writer.create_app(AUTHOR, draft(sessions).session_id)
    with pytest.raises(rw.Refused, match="owner or an admin"):
        writer.create_version(OTHER_AUTHOR, "app_bp_trend", draft(sessions, "author-2").session_id)
    out = writer.create_version(AUTHOR, "app_bp_trend", draft(sessions).session_id)
    assert out["version"] == "0.2.0" and out["parent_version"] == "0.1.0"
    head = registry.get(app_pk("app_bp_trend"), HEAD_SK)
    assert head["latest_version"] == "0.2.0" and head["latest_state"] == "draft"
    assert json.loads(registry.get(app_pk("app_bp_trend"), version_sk("0.2.0"))["manifest_json"])["metadata"]["parent_version"] == "0.1.0"
    admin_iteration = writer.create_version(ADMIN, "app_bp_trend", draft(sessions, "admin-1").session_id)
    assert admin_iteration["version"] == "0.3.0"
    with pytest.raises(rw.Refused, match="No such draft"):
        writer.create_version(ADMIN, "app_bp_trend", draft(sessions, "author-1").session_id)  # not even an admin saves someone else's conversation
    wrong = draft(sessions, spec={**{k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}, "app": {**BP_SPEC["app"], "app_id": "app_other"}})
    with pytest.raises(rw.Refused, match="is for app_other, not app_bp_trend"):
        writer.create_version(AUTHOR, "app_bp_trend", wrong.session_id)
    with pytest.raises(rw.Refused, match="No such app"):
        writer.create_version(AUTHOR, "app_nope", draft(sessions).session_id)


def test_a_draft_version_is_revised_in_place_until_it_is_submitted(world) -> None:  # type: ignore[no-untyped-def]
    # First demo round: changing a saved-but-unsubmitted app produced version after version. While a version is a draft
    # nobody has reviewed it, so its author revises it under the same number; from submission on, a change is a new version.
    writer, registry, sessions, _, _ = world
    s = draft(sessions)
    writer.create_app(AUTHOR, s.session_id)
    before = registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))

    s = sessions.load(s.session_id)
    s.spec["app"]["name"] = "Blood pressure, revised"
    sessions.save(s)
    out = writer.replace_version(AUTHOR, "app_bp_trend", "0.1.0", s.session_id)
    assert out == {"app_id": "app_bp_trend", "version": "0.1.0", "state": "draft", "manifest_hash": out["manifest_hash"], "revised": True}
    after = registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))
    assert after["manifest_hash"] != before["manifest_hash"] and json.loads(after["manifest_json"])["metadata"]["name"] == "Blood pressure, revised"
    assert json.loads(after["spec_json"])["app"]["version"] == "0.1.0" and after["created_at"] == before["created_at"] and after["updated_at"] > before["updated_at"]
    assert after["state"] == "draft" and after["session_id"] == s.session_id
    head = registry.get(app_pk("app_bp_trend"), HEAD_SK)
    assert head["latest_version"] == "0.1.0" and head["name"] == "Blood pressure, revised", "no new version, the head follows the revision"
    assert [(e["from_state"], e["to_state"]) for e in registry.events("app_bp_trend")] == [(None, "draft"), ("draft", "draft")], "the revision is on the record"
    assert "revised from draft" in registry.events("app_bp_trend")[1]["notes"]
    assert sessions.load(s.session_id).saved_as["state"] == "draft" and sessions.load(s.session_id).saved_as["at"] > "2026-09-14T10:01:00Z"

    # Only through the conversation the version was saved from, only by its owner (or an admin), never someone else's draft.
    with pytest.raises(rw.Refused, match="not the conversation that version was saved from"):
        writer.replace_version(AUTHOR, "app_bp_trend", "0.1.0", draft(sessions).session_id)
    with pytest.raises(rw.Refused, match="owner or an admin"):
        writer.replace_version(OTHER_AUTHOR, "app_bp_trend", "0.1.0", s.session_id)
    with pytest.raises(rw.Refused, match="No such draft"):
        writer.replace_version(ADMIN, "app_bp_trend", "0.1.0", s.session_id)  # the admin may own the app, not the author's conversation
    with pytest.raises(rw.Refused, match="No such app version"):
        writer.replace_version(AUTHOR, "app_bp_trend", "0.9.0", s.session_id)

    # Submitted: the conversation is stamped frozen and the version can no longer be revised — iterate instead.
    writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "in_review", None)
    assert sessions.load(s.session_id).saved_as["state"] == "in_review"
    with pytest.raises(rw.Refused, match="Only a draft version can be revised in place; this one is in_review"):
        writer.replace_version(AUTHOR, "app_bp_trend", "0.1.0", s.session_id)
    # Sent back to draft by a reviewer: editable again, through the same conversation.
    writer.transition(APPROVER, "app_bp_trend", "0.1.0", "draft", "please narrow the roles")
    assert sessions.load(s.session_id).saved_as["state"] == "draft"
    assert writer.replace_version(AUTHOR, "app_bp_trend", "0.1.0", s.session_id)["revised"] is True
    assert registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))["manifest_hash"] == out["manifest_hash"], "same content, same hash"


# ── lifecycle ─────────────────────────────────────────────────────────────────


def test_lifecycle_rules_signoff_and_publication(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, signer, groups = world
    writer.create_app(AUTHOR, draft(sessions).session_id)
    key = (app_pk("app_bp_trend"), version_sk("0.1.0"))

    with pytest.raises(rw.Refused, match="owner or an admin"):
        writer.transition(APPROVER, "app_bp_trend", "0.1.0", "in_review", None)
    with pytest.raises(rw.Refused, match="is not an allowed transition"):
        writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "published", None)
    assert writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "in_review", "ready for review")["state"] == "in_review"
    assert registry.get(*key)["state"] == "in_review" and registry.get(app_pk("app_bp_trend"), HEAD_SK)["latest_state"] == "in_review"

    # Separation of duties: the author cannot approve — not even as an approver.
    with pytest.raises(rw.Refused, match="never the version's own author"):
        writer.transition(AUTHOR_APPROVER, "app_bp_trend", "0.1.0", "approved", None)
    out = writer.transition(APPROVER, "app_bp_trend", "0.1.0", "approved", "Display only; fine.")
    assert out["signoff"]["approver_sub"] == "approver-1" and out["signoff"]["signature"].startswith("kms:ECDSA_SHA_256:")
    assert signer.signed == [registry.get(*key)["manifest_hash"]], "what is signed is the stored manifest hash"
    assert registry.get(*key)["signoff"]["clinical_notes"] == "Display only; fine."
    assert registry.events("app_bp_trend")[-1]["signature"] == out["signoff"]["signature"]

    out = writer.transition(APPROVER, "app_bp_trend", "0.1.0", "published", None)
    head = registry.get(app_pk("app_bp_trend"), HEAD_SK)
    assert out["state"] == "published" and head["active_version"] == "0.1.0" and head["latest_state"] == "published"
    assert sorted(n for n, _ in groups.created) == ["app-app_bp_trend-reviewer", "app-app_bp_trend-viewer"]
    assert groups.created[0][1].startswith("Longitudinal blood pressure ·")

    # A second version goes through and supersedes the first: exactly one published version.
    writer.create_version(AUTHOR, "app_bp_trend", draft(sessions).session_id)
    writer.transition(AUTHOR, "app_bp_trend", "0.2.0", "in_review", None)
    writer.transition(APPROVER, "app_bp_trend", "0.2.0", "approved", None)
    groups.created.clear()
    writer.transition(ADMIN, "app_bp_trend", "0.2.0", "published", None)
    head = registry.get(app_pk("app_bp_trend"), HEAD_SK)
    assert head["active_version"] == "0.2.0"
    assert registry.get(*key)["state"] == "deprecated" and registry.get(app_pk("app_bp_trend"), version_sk("0.2.0"))["state"] == "published"
    assert [e for e in registry.events("app_bp_trend") if e["version"] == "0.1.0"][-1]["notes"] == "superseded by 0.2.0"
    assert groups.created == [("app-app_bp_trend-viewer", "Longitudinal blood pressure · Read-only viewer"), ("app-app_bp_trend-reviewer", "Longitudinal blood pressure · Clinical reviewer")], "idempotent: creating again is harmless"

    # Deprecating the published version clears the active pointer; nothing follows deprecated.
    writer.transition(APPROVER, "app_bp_trend", "0.2.0", "deprecated", "retired")
    assert registry.get(app_pk("app_bp_trend"), HEAD_SK)["active_version"] is None
    with pytest.raises(rw.Refused, match="not an allowed transition"):
        writer.transition(ADMIN, "app_bp_trend", "0.2.0", "draft", None)


def test_rejection_reopening_and_stale_writes(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, _ = world
    writer.create_app(AUTHOR, draft(sessions).session_id)
    writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "in_review", None)
    with pytest.raises(rw.Refused, match="reviewer or the owner"):
        writer.transition(OTHER_AUTHOR, "app_bp_trend", "0.1.0", "draft", None)
    assert writer.transition(APPROVER, "app_bp_trend", "0.1.0", "draft", "please narrow the PHI")["state"] == "draft"  # rejection
    assert registry.events("app_bp_trend")[-1]["notes"] == "please narrow the PHI"
    assert "actor" not in registry.events("app_bp_trend")[-1], "a token without a name or email: the sub alone"
    named = rw.Caller(sub="approver-1", groups=("medapp-approvers",), email="ada@klinikum-musterstadt.example", display="Ada Approver")
    writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "in_review", None)
    writer.transition(named, "app_bp_trend", "0.1.0", "draft", "still too wide")
    assert registry.events("app_bp_trend")[-1]["actor"] == {"name": "Ada Approver", "email": "ada@klinikum-musterstadt.example"}, "the history reads as people"
    with pytest.raises(rw.Refused, match="No such app version"):
        writer.transition(AUTHOR, "app_bp_trend", "9.9.9", "in_review", None)

    # Publishing requires every existing-group binding to exist at that moment.
    bound = draft(sessions, spec={**{k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}, "app": {**BP_SPEC["app"], "app_id": "app_bound"}, "roles": [{**BP_SPEC["roles"][0], "group": {"kind": "existing", "name": "kardiologie"}}, BP_SPEC["roles"][1]]})
    writer.create_app(AUTHOR, bound.session_id)
    writer.transition(AUTHOR, "app_bound", "0.1.0", "in_review", None)
    writer.transition(APPROVER, "app_bound", "0.1.0", "approved", None)
    writer.groups.existing.discard("kardiologie")
    with pytest.raises(rw.Refused, match="do not exist in the user pool: kardiologie"):
        writer.transition(APPROVER, "app_bound", "0.1.0", "published", None)
    assert registry.get(app_pk("app_bound"), version_sk("0.1.0"))["state"] == "approved", "nothing changed"

    # Recalled by its author to make changes: an approved version goes back to draft and its sign-off goes with the state —
    # the content may change now, so nothing signed may remain attached (present_version would otherwise show it as signed).
    assert registry.get(app_pk("app_bound"), version_sk("0.1.0"))["signoff"]["approver_sub"] == "approver-1"
    assert writer.transition(AUTHOR, "app_bound", "0.1.0", "draft", "recalled by the author to make changes")["state"] == "draft"
    recalled = registry.get(app_pk("app_bound"), version_sk("0.1.0"))
    assert recalled["signoff"] is None and present_version(recalled)["lifecycle"] == {"state": "draft", "signoff": None}
    assert registry.events("app_bound")[-1]["notes"] == "recalled by the author to make changes"

    # A concurrent change makes the transaction fail closed.
    registry.items[(app_pk("app_bp_trend"), version_sk("0.1.0"))]["state"] = "in_review"
    original_get = registry.get
    registry.get = lambda pk, sk: {**original_get(pk, sk), "state": "draft"} if sk == version_sk("0.1.0") else original_get(pk, sk)  # type: ignore[method-assign]
    with pytest.raises(rw.Refused, match="changed meanwhile"):
        writer.transition(AUTHOR, "app_bp_trend", "0.1.0", "in_review", None)


def test_http_handler_routing_and_authorization(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, _ = world
    s = draft(sessions)

    def event(route: str, body: dict, groups: str = "[medapp-authors]", sub: str = "author-1", **params: str) -> dict:
        return {"routeKey": route, "pathParameters": params or None, "body": json.dumps(body), "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups}}}}}

    res = rw.handle(event("POST /registry/apps", {"session_id": s.session_id}), writer)
    assert res["statusCode"] == 201 and json.loads(res["body"])["app_id"] == "app_bp_trend"
    assert registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))["author"] is None, "a token without name or email: no attribution rather than a sub"
    res = rw.handle(event("POST /registry/apps/{app_id}/versions/{version}/transitions", {"to": "in_review"}, app_id="app_bp_trend", version="0.1.0"), writer)
    assert res["statusCode"] == 200 and json.loads(res["body"])["state"] == "in_review"
    res = rw.handle(event("POST /registry/apps/{app_id}/versions/{version}/transitions", {"to": "approved"}, groups="[medapp-approvers]", sub="approver-1", app_id="app_bp_trend", version="0.1.0"), writer)
    assert res["statusCode"] == 200 and "signoff" in json.loads(res["body"])
    assert rw.handle(event("PUT /registry/apps/{app_id}/versions/{version}", {"session_id": s.session_id}, app_id="app_bp_trend", version="0.1.0"), writer)["statusCode"] == 409, "approved: no revision in place"
    assert rw.handle(event("POST /registry/apps", {"session_id": "x"}, groups="[medapp-viewers]"), writer)["statusCode"] == 403
    assert rw.handle(event("POST /registry/apps/{app_id}/versions", {"session_id": "nope"}, app_id="app_bp_trend"), writer)["statusCode"] == 404
    assert rw.handle(event("POST /registry/nope", {}), writer)["statusCode"] == 404
    bad = event("POST /registry/apps", {})
    bad["body"] = "{not json"
    assert rw.handle(bad, writer)["statusCode"] == 400
    assert rw.handle({"routeKey": "POST /registry/apps", "requestContext": {}}, writer)["statusCode"] == 401


def test_a_version_remembers_who_made_it_as_a_person(world) -> None:  # type: ignore[no-untyped-def]
    """The claims a Cognito token carries — name or given/family name, email — become the version's author; the sub stays for the rules."""
    writer, registry, sessions, _, _ = world
    spec = {k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}
    spec["app"] = {**spec["app"], "app_id": "app_bp_trend_named"}
    s = draft(sessions, author="author-9", spec=spec)
    lukas = rw.Caller(sub="author-9", groups=("medapp-authors",), email="lukas.hoffmann@klinikum-musterstadt.example", display="Lukas Hoffmann")
    out = writer.create_app(lukas, s.session_id)
    item = registry.get(app_pk(out["app_id"]), version_sk(out["version"]))
    assert item["created_by_sub"] == "author-9" and item["author"] == {"name": "Lukas Hoffmann", "email": "lukas.hoffmann@klinikum-musterstadt.example"}
    # The next version by someone else is theirs; the app's owner stays.
    admin = rw.Caller(sub="admin-1", groups=("medapp-admins",), email="admin@klinikum-musterstadt.example", display=None)
    s2 = draft(sessions, author="admin-1", spec=spec)
    out2 = writer.create_version(admin, out["app_id"], s2.session_id)
    assert registry.get(app_pk(out["app_id"]), version_sk(out2["version"]))["author"] == {"email": "admin@klinikum-musterstadt.example"}, "no name on the token: the email"
    assert registry.get(app_pk(out["app_id"]), HEAD_SK)["owner_sub"] == "author-9"


def test_publishing_hands_the_apps_own_forms_to_the_record_without_making_the_publish_depend_on_it(world) -> None:  # type: ignore[no-untyped-def]
    writer, registry, sessions, _, _ = world
    form = {"resourceType": "Questionnaire", "id": "app-bp-trend.intake", "url": "https://hsp-musterstadt.medapp.eu/Questionnaire/app-bp-trend.intake", "version": "0.1.0", "status": "active", "title": "Intake", "subjectType": ["Patient"], "item": [{"linkId": "ok", "text": "Ok?", "type": "boolean"}]}

    class Publisher:
        def __init__(self, outcome: str = "queued", fail: bool = False):
            self.calls: list[tuple[str, str, list[dict]]] = []
            self.outcome, self.fail = outcome, fail

        def publish(self, app_id: str, version: str, resources: list[dict]) -> str:
            self.calls.append((app_id, version, resources))
            if self.fail:
                raise RuntimeError("lambda down")
            return self.outcome

    def publish_with(publisher, app_id: str) -> dict:  # type: ignore[no-untyped-def]
        writer.definitions = publisher
        spec = {k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}
        spec["app"] = {**spec["app"], "app_id": app_id}
        out = writer.create_app(AUTHOR, draft(sessions, spec=spec).session_id)
        # The compiler stub does not know forms; put the artifact on the stored version as the real compiler would.
        key = (app_pk(app_id), version_sk(out["version"]))
        item = registry.items[key]
        manifest = json.loads(item["manifest_json"])
        manifest["artifacts"] = {"questionnaires": [dict(form, id=f"{app_id}.intake".replace("_", "-"))]}
        registry.items[key] = {**item, "manifest_json": json.dumps(manifest, sort_keys=True, separators=(",", ":"))}
        writer.transition(AUTHOR, app_id, out["version"], "in_review", None)
        writer.transition(APPROVER, app_id, out["version"], "approved", None)
        return writer.transition(APPROVER, app_id, out["version"], "published", None)

    queued = Publisher()
    out = publish_with(queued, "app_bp_one")
    assert out["state"] == "published" and out["definitions"] == "queued"
    assert len(queued.calls) == 1 and queued.calls[0][0] == "app_bp_one" and queued.calls[0][2][0]["resourceType"] == "Questionnaire"

    down = Publisher(fail=True)
    out = publish_with(down, "app_bp_two")
    assert out["state"] == "published" and out["definitions"] == "failed", "the record's copy is a courtesy; the publish stands"
    assert registry.get(app_pk("app_bp_two"), HEAD_SK)["active_version"] == out["version"]

    # An app without forms of its own asks nothing of the record; a deployment without a server is told so.
    none = Publisher()
    writer.definitions = none
    spec = {k: v for k, v in BP_SPEC.items() if k not in ("apiVersion", "kind")}
    spec["app"] = {**spec["app"], "app_id": "app_bp_three"}
    made = writer.create_app(AUTHOR, draft(sessions, spec=spec).session_id)
    writer.transition(AUTHOR, "app_bp_three", made["version"], "in_review", None)
    writer.transition(APPROVER, "app_bp_three", made["version"], "approved", None)
    out = writer.transition(APPROVER, "app_bp_three", made["version"], "published", None)
    assert "definitions" not in out and none.calls == []
    assert rw.NoDefinitionsPublisher().publish("x", "1", [form]) == "unavailable"


def test_the_lambda_publisher_finds_the_writer_in_ssm_and_invokes_it_asynchronously() -> None:
    class Ssm:
        def __init__(self, value: str | None):
            self.value, self.calls = value, 0

        def get_parameter(self, Name: str):  # noqa: N803 — boto3's argument name
            self.calls += 1
            if self.value is None:
                raise type("ParameterNotFound", (Exception,), {})()
            return {"Parameter": {"Value": self.value}}

    class Lam:
        def __init__(self):
            self.calls: list[dict] = []

        def invoke(self, **kwargs):  # type: ignore[no-untyped-def]
            self.calls.append(kwargs)
            return {"StatusCode": 202}

    ssm, lam = Ssm("medapp-hsp-test-hospital-seed"), Lam()
    publisher = rw.LambdaDefinitionsPublisher("/medapp/hsp-test/data-source/definitions-writer", ssm, lam)
    assert publisher.publish("app_x", "1.0.0", [{"resourceType": "Questionnaire", "id": "q"}]) == "queued"
    assert publisher.publish("app_y", "1.0.0", []) == "queued" and ssm.calls == 1, "the name is looked up once"
    call = lam.calls[0]
    assert call["FunctionName"] == "medapp-hsp-test-hospital-seed" and call["InvocationType"] == "Event"
    assert json.loads(call["Payload"]) == {"task": "definitions", "app_id": "app_x", "version": "1.0.0", "resources": [{"resourceType": "Questionnaire", "id": "q"}]}
    # No parameter: no server to write to (the bundled record) — nothing is invoked, and nobody is asked again.
    absent = rw.LambdaDefinitionsPublisher("/medapp/hsp-test/data-source/definitions-writer", Ssm(None), Lam())
    assert absent.publish("app_x", "1.0.0", [{"resourceType": "Questionnaire", "id": "q"}]) == "unavailable"
    assert absent.publish("app_x", "1.0.0", []) == "unavailable"


def test_every_lifecycle_step_is_an_audit_record_beside_the_registrys_own_events(world) -> None:  # type: ignore[no-untyped-def]
    writer, _, sessions, _, _ = world
    trail: list[dict] = []

    class Sink:
        def emit(self, record: dict) -> None:
            trail.append(record)

    writer.audit = Sink()
    author = rw.Caller(sub="author-1", groups=("medapp-authors",), email="ada@klinikum-musterstadt.example", display="Ada Author")
    out = writer.create_app(author, draft(sessions).session_id)
    writer.transition(author, "app_bp_trend", out["version"], "in_review", "ready for review")
    writer.transition(APPROVER, "app_bp_trend", out["version"], "approved", None)
    writer.transition(APPROVER, "app_bp_trend", out["version"], "published", None)
    assert [r["kind"] for r in trail] == ["lifecycle.created", "lifecycle.in_review", "lifecycle.approved", "lifecycle.published"]
    created, submitted = trail[0], trail[1]
    assert created["user_sub"] == "author-1" and created["user_name"] == "Ada Author" and created["user_email"] == "ada@klinikum-musterstadt.example"
    assert created["app_id"] == "app_bp_trend" and created["manifest_version"] == "0.1.0" and created["outcome"] == "ok" and "saved as draft" in created["detail"]
    assert submitted["detail"] == "draft → in_review: ready for review" and submitted["from_state"] == "draft" and submitted["to_state"] == "in_review"
    assert all(r["audit_id"] and r["timestamp"].endswith("Z") for r in trail)


def test_with_the_real_compiler_when_available(world) -> None:  # type: ignore[no-untyped-def]
    svc = compiler_available()
    if svc is None:
        pytest.skip("compiler CLI not available")
    writer, registry, sessions, _, _ = world
    writer.compiler = svc
    out = writer.create_app(AUTHOR, draft(sessions).session_id)
    manifest = json.loads(registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))["manifest_json"])
    assert out["version"] == "0.1.0" and manifest["metadata"]["version"] == "0.1.0" and "parent_version" not in manifest["metadata"]
    assert manifest["primitives"][1]["id"] == "p_series" and manifest["lifecycle"]["provenance"]["generated_by_pipeline_version"] == "0.1.0"
    out = writer.create_version(AUTHOR, "app_bp_trend", draft(sessions).session_id)
    manifest = json.loads(registry.get(app_pk("app_bp_trend"), version_sk("0.2.0"))["manifest_json"])
    assert manifest["metadata"]["parent_version"] == "0.1.0" and out["parent_version"] == "0.1.0"


def test_collections_are_curated_by_approvers_and_admins_without_touching_any_version(world) -> None:  # type: ignore[no-untyped-def]
    """How the hospital groups its apps for the launcher: organisation, not a clinical change — no version moves, every change audited."""
    writer, registry, sessions, _, _ = world
    trail: list[dict] = []

    class Sink:
        def emit(self, record: dict) -> None:
            trail.append(record)

    writer.audit = Sink()
    writer.create_app(AUTHOR, draft(sessions).session_id)
    curator = rw.Caller(sub="approver-1", groups=("medapp-approvers",), email="ada@klinikum-musterstadt.example", display="Ada Approver")

    with pytest.raises(rw.Refused, match="curated by approvers and admins"):
        writer.create_collection(AUTHOR, "Hypertonie-Sprechstunde", None, ["app_bp_trend"])
    with pytest.raises(rw.Refused, match="No such app: app_nowhere"):
        writer.create_collection(curator, "Hypertonie-Sprechstunde", None, ["app_bp_trend", "app_nowhere"])
    with pytest.raises(rw.Refused, match="needs a name"):
        writer.create_collection(curator, "   ", None, [])

    made = writer.create_collection(curator, "Hypertonie-Sprechstunde", "Alles für die Sprechstunde.", ["app_bp_trend", "app_bp_trend"])
    assert made == {"collection_id": "col_hypertonie_sprechstunde", "name": "Hypertonie-Sprechstunde", "description": "Alles für die Sprechstunde.", "app_ids": ["app_bp_trend"], "updated_at": made["updated_at"], "updated_by": {"name": "Ada Approver", "email": "ada@klinikum-musterstadt.example"}}
    item = registry.get("COLLECTION#col_hypertonie_sprechstunde", HEAD_SK)
    assert item["GSI1PK"] == "COLLECTIONS" and item["GSI1SK"] == "NAME#hypertonie-sprechstunde#col_hypertonie_sprechstunde" and item["created_by_sub"] == "approver-1"
    with pytest.raises(rw.Refused, match="already exists"):
        writer.create_collection(ADMIN, "Hypertonie Sprechstunde", None, [])  # the same slug

    same = writer.update_collection(curator, "col_hypertonie_sprechstunde", app_ids=["app_bp_trend"])
    assert same["app_ids"] == ["app_bp_trend"] and len(trail) == 2, "nothing changed: nothing written, nothing audited (the app and the collection creations are the two so far)"
    changed = writer.update_collection(ADMIN, "col_hypertonie_sprechstunde", name="Hypertonie-Ambulanz", description="", app_ids=[])
    assert changed["name"] == "Hypertonie-Ambulanz" and changed["description"] is None and changed["app_ids"] == [] and changed["collection_id"] == "col_hypertonie_sprechstunde", "renaming keeps the id"
    assert registry.get("COLLECTION#col_hypertonie_sprechstunde", HEAD_SK)["GSI1SK"] == "NAME#hypertonie-ambulanz#col_hypertonie_sprechstunde"
    with pytest.raises(rw.Refused, match="No such collection"):
        writer.update_collection(ADMIN, "col_nowhere", name="x")

    gone = writer.delete_collection(curator, "col_hypertonie_sprechstunde")
    assert gone == {"collection_id": "col_hypertonie_sprechstunde", "deleted": True}
    assert registry.get("COLLECTION#col_hypertonie_sprechstunde", HEAD_SK)["GSI1PK"] == "COLLECTIONS#deleted", "out of the listing; the item stays"
    with pytest.raises(rw.Refused, match="No such collection"):
        writer.delete_collection(curator, "col_hypertonie_sprechstunde")

    assert [r["kind"] for r in trail] == ["lifecycle.created", "platform.collection.created", "platform.collection.updated", "platform.collection.deleted"]
    assert trail[1]["detail"] == "Hypertonie-Sprechstunde: 1 app" and trail[1]["collection_id"] == "col_hypertonie_sprechstunde" and trail[1]["user_name"] == "Ada Approver"
    assert trail[2]["detail"] == "Hypertonie-Ambulanz: renamed from “Hypertonie-Sprechstunde”; description changed; removed app_bp_trend"
    assert trail[3]["detail"] == "Hypertonie-Ambulanz removed (0 apps were in it)"
    assert registry.get(app_pk("app_bp_trend"), version_sk("0.1.0"))["state"] == "draft", "no version moved"

    # The routes, as the API hands them over.
    def event(route: str, body: dict | None, groups: str, **params: str) -> dict:
        return {"routeKey": route, "pathParameters": params or None, "body": json.dumps(body) if body is not None else None, "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "approver-1", "cognito:groups": groups}}}}}

    res = rw.handle(event("POST /registry/collections", {"name": "Station 3", "app_ids": ["app_bp_trend"]}, "[medapp-approvers]"), writer)
    assert res["statusCode"] == 201 and json.loads(res["body"])["collection_id"] == "col_station_3"
    res = rw.handle(event("POST /registry/collections", {"name": "Station 4", "app_ids": "app_bp_trend"}, "[medapp-approvers]"), writer)
    assert res["statusCode"] == 400 and "list of app ids" in json.loads(res["body"])["message"]
    res = rw.handle(event("PUT /registry/collections/{collection_id}", {"description": "Die Pflege der Station 3."}, "[medapp-admins]", collection_id="col_station_3"), writer)
    assert res["statusCode"] == 200 and json.loads(res["body"])["description"] == "Die Pflege der Station 3." and json.loads(res["body"])["app_ids"] == ["app_bp_trend"]
    res = rw.handle(event("DELETE /registry/collections/{collection_id}", None, "[medapp-authors]", collection_id="col_station_3"), writer)
    assert res["statusCode"] == 403
    res = rw.handle(event("DELETE /registry/collections/{collection_id}", None, "[medapp-approvers]", collection_id="col_station_3"), writer)
    assert res["statusCode"] == 200 and json.loads(res["body"])["deleted"] is True


def test_record_shapes_are_versioned_like_apps_under_a_lighter_lifecycle(world) -> None:  # type: ignore[no-untyped-def]
    """
    The library a `record` section writes with: authors create and revise drafts (in place while a draft; a new draft
    version after a publication), approvers and admins publish — one published version at a time, the previous one
    deprecated in the same transaction — and deprecate. Every step is history on the shape and an audit record; an app
    compile is handed exactly the published artifacts.
    """
    writer, registry, sessions, _, _ = world
    trail: list[dict] = []

    class Sink:
        def emit(self, record: dict) -> None:
            trail.append(record)

    writer.audit = Sink()
    curator = rw.Caller(sub="approver-1", groups=("medapp-approvers",), email="ada@klinikum-musterstadt.example", display="Ada Approver")

    with pytest.raises(rw.Refused, match="authors and admins"):
        writer.create_shape(APPROVER, GOAL_SHAPE)
    with pytest.raises(rw.Refused, match="Send the shape as `document`"):
        writer.create_shape(AUTHOR, None)
    with pytest.raises(rw.Refused, match="does not compile") as refused:
        writer.create_shape(AUTHOR, {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "empty", "name": "Empty", "resource": "Goal", "fields": []}})
    assert refused.value.extra["issues"] == [{"path": "shape.fields", "message": "is required"}]
    assert not registry.items, "nothing is written for a shape that does not compile"

    made = writer.create_shape(AUTHOR, GOAL_SHAPE)
    assert made["shape_id"] == "measurable_goal" and made["resource"] == "Goal" and made["latest_version"] == "0.1.0" and made["latest_state"] == "draft" and made["active_version"] is None and made["published"] is None
    assert made["latest"]["version"] == "0.1.0" and made["latest"]["state"] == "draft" and made["latest"]["document"] == GOAL_SHAPE and made["latest"]["artifact"]["rules"]["resource"] == "Goal" and made["latest"]["checksum"].startswith("fnv1a64:")
    head = registry.get(shape_pk("measurable_goal"), HEAD_SK)
    assert head["owner_sub"] == "author-1" and head["GSI1PK"] == "SHAPES" and head["GSI1SK"] == "NAME#measurable goal#measurable_goal"
    assert registry.get(shape_pk("measurable_goal"), version_sk("0.1.0"))["type"] == "SHAPE_VERSION"
    with pytest.raises(rw.Refused, match="already exists"):
        writer.create_shape(AUTHOR, GOAL_SHAPE)

    # Not yet published: an app compile sees an empty library.
    writer.create_app(AUTHOR, draft(sessions).session_id)
    assert writer.compiler.libraries[-1] == []

    # Revising a draft: in place, same version; another author may not, the owner and curators may; the id is fixed.
    renamed = {**GOAL_SHAPE, "shape": {**GOAL_SHAPE["shape"], "name": "Measurable therapy goal"}}
    with pytest.raises(rw.Refused, match="owner, approvers or admins"):
        writer.revise_shape(OTHER_AUTHOR, "measurable_goal", renamed)
    with pytest.raises(rw.Refused, match="does not change"):
        writer.revise_shape(AUTHOR, "measurable_goal", {**renamed, "shape": {**renamed["shape"], "id": "other_goal"}})
    with pytest.raises(rw.Refused, match="No such shape"):
        writer.revise_shape(AUTHOR, "nowhere", renamed)
    same = writer.revise_shape(AUTHOR, "measurable_goal", GOAL_SHAPE)
    assert same["latest"]["version"] == "0.1.0" and len(trail) == 2, "the same document: nothing written, nothing audited (the shape and the app creations are the two so far)"
    revised = writer.revise_shape(AUTHOR, "measurable_goal", renamed)
    assert revised["name"] == "Measurable therapy goal" and revised["latest_version"] == "0.1.0" and revised["latest"]["document"]["shape"]["name"] == "Measurable therapy goal"
    assert registry.get(shape_pk("measurable_goal"), HEAD_SK)["GSI1SK"] == "NAME#measurable therapy goal#measurable_goal", "the library lists it under its new name"

    # Publishing: curators only; the one published version; the compile now sees it.
    with pytest.raises(rw.Refused, match="approvers and admins"):
        writer.transition_shape(AUTHOR, "measurable_goal", "0.1.0", "published")
    with pytest.raises(rw.Refused, match="No such shape version"):
        writer.transition_shape(curator, "measurable_goal", "0.9.0", "published")
    published = writer.transition_shape(curator, "measurable_goal", "0.1.0", "published", notes="Reviewed with the physio lead.")
    assert published["active_version"] == "0.1.0" and published["latest_state"] == "published" and published["published"]["version"] == "0.1.0" and published["published"]["checksum"] == revised["latest"]["checksum"]
    assert published["published"]["artifact"]["name"] == "Measurable therapy goal"
    with pytest.raises(rw.Refused, match="not an allowed transition"):
        writer.transition_shape(curator, "measurable_goal", "0.1.0", "published")
    writer.create_version(AUTHOR, "app_bp_trend", draft(sessions).session_id)
    assert [(a["id"], a["version"]) for a in writer.compiler.libraries[-1]] == [("measurable_goal", "0.1.0")], "the compile is handed the published artifact, with its version"

    # Revising after publication: a new draft version after it, the published one untouched; publishing it supersedes.
    wider = {**renamed, "shape": {**renamed["shape"], "fields": renamed["shape"]["fields"] + [{"id": "barrier", "label": "Barrier", "type": "text", "path": "note[1].text"}]}}
    second = writer.revise_shape(ADMIN, "measurable_goal", wider)
    assert second["latest_version"] == "0.2.0" and second["latest_state"] == "draft" and second["active_version"] == "0.1.0" and second["latest"]["parent_version"] == "0.1.0"
    assert second["published"]["version"] == "0.1.0" and len(second["published"]["artifact"]["fields"]) == 6 and len(second["latest"]["artifact"]["fields"]) == 7
    assert registry.get(shape_pk("measurable_goal"), version_sk("0.1.0"))["state"] == "published", "untouched"
    superseding = writer.transition_shape(ADMIN, "measurable_goal", "0.2.0", "published")
    assert superseding["active_version"] == "0.2.0" and superseding["published"]["version"] == "0.2.0"
    assert registry.get(shape_pk("measurable_goal"), version_sk("0.1.0"))["state"] == "deprecated", "one published version at a time"
    assert [a["checksum"] for a in writer.published_shapes()] == [second["latest"]["checksum"]]

    # Deprecating the published version leaves the library without one; the app compile sees nothing again.
    retired = writer.transition_shape(curator, "measurable_goal", "0.2.0", "deprecated", notes="The lab changed its tests.")
    assert retired["active_version"] is None and retired["latest_state"] == "deprecated" and retired["published"] is None
    assert writer.published_shapes() == []
    third = writer.revise_shape(AUTHOR, "measurable_goal", wider)
    assert third["latest_version"] == "0.3.0" and third["latest_state"] == "draft", "a deprecated shape is revived by a new draft"

    events = sorted((i for (pk, sk), i in registry.items.items() if pk == shape_pk("measurable_goal") and sk.startswith("EVT#")), key=lambda i: i["SK"])
    assert [(e["version"], e["from_state"], e["to_state"]) for e in events] == [
        ("0.1.0", None, "draft"),
        ("0.1.0", "draft", "draft"),
        ("0.1.0", "draft", "published"),
        ("0.1.0", "published", "deprecated"),
        ("0.2.0", None, "draft"),
        ("0.2.0", "draft", "published"),
        ("0.2.0", "published", "deprecated"),
        ("0.3.0", None, "draft"),
    ]
    assert events[2]["notes"] == "Reviewed with the physio lead." and events[3]["notes"] == "superseded by 0.2.0" and events[2]["actor"] == {"name": "Ada Approver", "email": "ada@klinikum-musterstadt.example"}
    kinds = [r["kind"] for r in trail if r["kind"].startswith("platform.shape")]
    assert kinds == ["platform.shape.created", "platform.shape.revised", "platform.shape.published", "platform.shape.revised", "platform.shape.published", "platform.shape.deprecated", "platform.shape.revised"]
    assert trail[0]["detail"] == "Measurable goal (Goal, 6 fields)" and trail[0]["shape_id"] == "measurable_goal" and trail[0]["manifest_version"] == "0.1.0"
    assert [r["detail"] for r in trail if r["kind"] == "platform.shape.published"] == ["Measurable therapy goal 0.1.0 published: Reviewed with the physio lead.", "Measurable therapy goal 0.2.0 published (supersedes 0.1.0)"]

    # A kind the platform has not admitted (an open kind, with its stamps declared) is an administrator's to define and revise;
    # an author may still write with it once published, and a curator publishes it like any other.
    flag = {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "patient_alert", "name": "Patient alert", "resource": "Flag", "stamps": [{"path": "status", "value": "active"}, {"path": "subject", "value": "$patient"}], "fields": [{"id": "alert", "label": "Alert", "type": "choice", "path": "code", "required": True, "system": "https://hsp-musterstadt.medapp.eu/CodeSystem/alerts", "options": [{"code": "falls_risk", "display": "Falls risk"}, {"code": "isolation", "display": "Isolation"}]}]}}
    with pytest.raises(rw.Refused, match="a kind the platform has not admitted — is defined by administrators"):
        writer.create_shape(AUTHOR, flag)
    alert = writer.create_shape(ADMIN, flag)
    assert alert["latest"]["artifact"]["open_kind"] is True and alert["resource"] == "Flag"
    with pytest.raises(rw.Refused, match="defined by administrators"):
        writer.revise_shape(curator, "patient_alert", {**flag, "shape": {**flag["shape"], "name": "Chart alert"}})  # an approver may curate, not define the platform's stamps
    assert writer.revise_shape(ADMIN, "patient_alert", {**flag, "shape": {**flag["shape"], "name": "Chart alert"}})["name"] == "Chart alert"
    assert writer.transition_shape(curator, "patient_alert", "0.1.0", "published")["active_version"] == "0.1.0"
    assert any(a["id"] == "patient_alert" and a.get("open_kind") for a in writer.published_shapes())

    # The routes, as the API hands them over.
    def event(route: str, body: dict | None, groups: str, sub: str = "author-1", **params: str) -> dict:
        return {"routeKey": route, "pathParameters": params or None, "body": json.dumps(body) if body is not None else None, "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups}}}}}

    note = {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "ward_note", "name": "Ward note", "resource": "DocumentReference", "status": "current", "fields": [{"id": "text", "label": "Note", "type": "long_text", "path": "content[0].attachment", "required": True}]}}
    res = rw.handle(event("POST /registry/shapes", {"document": note}, "[medapp-authors]"), writer)
    assert res["statusCode"] == 201 and json.loads(res["body"])["shape_id"] == "ward_note"
    res = rw.handle(event("POST /registry/shapes", {"document": {**note, "shape": {**note["shape"], "fields": []}}}, "[medapp-authors]"), writer)
    assert res["statusCode"] == 422 and json.loads(res["body"])["issues"]
    res = rw.handle(event("PUT /registry/shapes/{shape_id}", {"document": {**note, "shape": {**note["shape"], "name": "Nursing note"}}}, "[medapp-authors]", shape_id="ward_note"), writer)
    assert res["statusCode"] == 200 and json.loads(res["body"])["name"] == "Nursing note"
    res = rw.handle(event("POST /registry/shapes/{shape_id}/versions/{version}/transitions", {"to": "published"}, "[medapp-authors]", shape_id="ward_note", version="0.1.0"), writer)
    assert res["statusCode"] == 403
    res = rw.handle(event("POST /registry/shapes/{shape_id}/versions/{version}/transitions", {"to": "published", "notes": "ok"}, "[medapp-approvers]", sub="approver-1", shape_id="ward_note", version="0.1.0"), writer)
    assert res["statusCode"] == 200 and json.loads(res["body"])["active_version"] == "0.1.0"
    res = rw.handle(event("POST /registry/shapes/{shape_id}/versions/{version}/transitions", {"to": "draft"}, "[medapp-approvers]", sub="approver-1", shape_id="ward_note", version="0.1.0"), writer)
    assert res["statusCode"] == 409
    assert rw.handle(event("POST /registry/shapes", {"document": note}, "[medapp-viewers]"), writer)["statusCode"] == 403
