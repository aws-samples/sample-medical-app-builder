"""
Drafts API and DynamoDB session store, over a fake table: open a draft, queue a turn (the worker is a
recorded invocation), edit through PATCH with the same validation the agent's tools use, visibility,
and the async turn protocol (queued → running → done as the worker would write it).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from app_creator.catalog import Catalog
from app_creator.dynamo_store import DynamoSessionStore
from app_creator.groups import GroupInfo, StaticGroups
from app_creator.session import DraftSession, trim_tool_results

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("drafts_api_handler", ROOT / "lambdas" / "drafts_api" / "handler.py")
handler = importlib.util.module_from_spec(spec)
sys.modules["drafts_api_handler"] = handler
spec.loader.exec_module(handler)  # type: ignore[union-attr]


class FakeDraftsTable:
    """Enough of a boto3 Table for the store: items keyed by session_id, an author index, Decimal numbers."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    @staticmethod
    def _decimals(value):  # type: ignore[no-untyped-def]
        return json.loads(json.dumps(value, default=str), parse_float=Decimal, parse_int=Decimal)

    def get_item(self, **kwargs):  # type: ignore[no-untyped-def]
        item = self.items.get(kwargs["Key"]["session_id"])
        return {"Item": self._decimals(item)} if item else {}

    @staticmethod
    def _numeric(v):  # type: ignore[no-untyped-def]
        if isinstance(v, Decimal):
            return int(v) if v == v.to_integral_value() else float(v)
        return str(v)

    def put_item(self, **kwargs):  # type: ignore[no-untyped-def]
        item = kwargs["Item"]
        assert all(not isinstance(v, float) for v in item.values()), "floats must be Decimals"
        self.items[item["session_id"]] = json.loads(json.dumps(item, default=self._numeric))  # DynamoDB keeps numbers numeric
        return {}

    def update_item(self, **kwargs):  # type: ignore[no-untyped-def]
        item = self.items[kwargs["Key"]["session_id"]]
        values = kwargs["ExpressionAttributeValues"]
        assert kwargs["UpdateExpression"] == "SET turn = :turn, turn_status = :status, updated_at = :now"
        item["turn"] = json.loads(json.dumps(values[":turn"], default=self._numeric))
        item["turn_status"] = values[":status"]
        item["updated_at"] = values[":now"]
        return {}

    def delete_item(self, **kwargs):  # type: ignore[no-untyped-def]
        self.items.pop(kwargs["Key"]["session_id"], None)
        return {}

    def query(self, **kwargs):  # type: ignore[no-untyped-def]
        assert kwargs["IndexName"] == "ByAuthor"
        author = kwargs["ExpressionAttributeValues"][":a"]
        rows = [i for i in self.items.values() if i.get("author_sub") == author]
        rows.sort(key=lambda i: i.get("updated_at", ""), reverse=True)
        return {"Items": [self._decimals(r) for r in rows[: kwargs.get("Limit", 50)]]}


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load()


@pytest.fixture
def world(catalog: Catalog):  # type: ignore[no-untyped-def]
    table = FakeDraftsTable()
    store = DynamoSessionStore(table, ttl_days=30, clock=lambda: 1_700_000_000)
    invocations: list[tuple[str, str]] = []
    api = handler.DraftsApi(store, catalog, StaticGroups([GroupInfo("kardiologie")]), lambda sid, tid: invocations.append((sid, tid)), "hsp-musterstadt")
    return table, store, api, invocations


def event(route: str, body: dict | None = None, groups: str = "[medapp-authors]", sub: str = "author-1", **params: str) -> dict:
    return {
        "routeKey": route,
        "pathParameters": params or None,
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups, "email": f"{sub}@klinikum-musterstadt.example"}}}},
    }


def call(api, route: str, body: dict | None = None, **kw):  # type: ignore[no-untyped-def]
    res = handler.handle(event(route, body, **kw), api)
    return res["statusCode"], json.loads(res["body"])


# ── store ─────────────────────────────────────────────────────────────────────


def test_dynamo_store_roundtrip_with_ttl_and_decimals(world) -> None:  # type: ignore[no-untyped-def]
    table, store, _, _ = world
    s = DraftSession.new("hsp-musterstadt", "author-1")
    s.spec = {"archetype": "APP-02", "app": {"name": "HbA1c"}, "knobs": {"thresholds": [{"value": 7.5, "label": "x"}], "readings_rows": 10}}
    s.messages = [{"role": "user", "content": [{"text": "hi"}]}]
    store.save(s)
    raw = table.items[s.session_id]
    assert raw["expires_at"] == 1_700_000_000 + 30 * 86400 and raw["title"] == "HbA1c"
    back = store.load(s.session_id)
    assert back is not None and back.spec["knobs"]["thresholds"][0]["value"] == 7.5 and back.spec["knobs"]["readings_rows"] == 10
    assert isinstance(back.spec["knobs"]["readings_rows"], int), "Decimals come back as plain numbers"
    assert back.messages == s.messages
    assert store.list_for_author("author-1")[0] == {
        "session_id": s.session_id,
        "title": "HbA1c",
        "archetype": "APP-02",
        "updated_at": back.updated_at,
        "created_at": back.created_at,
        "turn_status": None,
        "saved_as": None,
    }
    store.update_turn(s.session_id, {"id": "t1", "status": "running", "progress": ["choose_archetype"]})
    assert store.load(s.session_id).turn == {"id": "t1", "status": "running", "progress": ["choose_archetype"]}  # type: ignore[union-attr]


def test_trim_tool_results_keeps_structure_and_recent_results() -> None:
    big = "x" * 5000
    messages = []
    for i in range(10):
        messages.append({"role": "assistant", "content": [{"toolUse": {"toolUseId": f"t{i}", "name": "set_knobs", "input": {}}}]})
        messages.append({"role": "user", "content": [{"toolResult": {"toolUseId": f"t{i}", "status": "success", "content": [{"text": big}]}}]})
    trimmed = trim_tool_results(messages, keep_last=3, max_chars=100)
    assert len(trimmed) == 20 and [m["role"] for m in trimmed] == [m["role"] for m in messages]
    results = [m["content"][0]["toolResult"]["content"][0]["text"] for m in trimmed if "toolResult" in m["content"][0]]
    assert all(len(t) < 200 for t in results[:7]) and all(len(t) == 5000 for t in results[7:])
    assert trimmed[1]["content"][0]["toolResult"]["toolUseId"] == "t0", "pairing untouched"


# ── API ───────────────────────────────────────────────────────────────────────


def test_open_draft_with_first_message_queues_a_turn_and_the_worker_is_invoked(world) -> None:  # type: ignore[no-untyped-def]
    table, store, api, invocations = world
    status, body = call(api, "POST /drafts", {"message": "HbA1c over five years"})
    assert status == 201 and body["turn"]["status"] == "queued" and body["turn"]["message"] == "HbA1c over five years"
    sid = body["session_id"]
    assert invocations == [(sid, body["turn"]["id"])]

    status, view = call(api, "GET /drafts/{id}", id=sid)
    assert status == 200 and view["turn"]["status"] == "queued" and view["spec"] == {"apiVersion": "medapp.eu/v1", "kind": "AppSpec"}
    assert [o["path"] for o in view["open"]] == ["archetype", "app", "roles", "default_role", "governance"]

    # A second message while the agent works is refused; so is editing.
    status, body = call(api, "POST /drafts/{id}/turns", {"message": "and make it red"}, id=sid)
    assert status == 409
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "X"}}]}, id=sid)
    assert status == 409

    # The worker finishes (as lambda_agent would write it); the next message goes through.
    s = store.load(sid)
    s.turn.update(status="done", reply="Who uses it?", tool_calls=["choose_archetype"])  # type: ignore[union-attr]
    s.spec = {"archetype": "APP-02", "app": {"app_id": "app_hba1c", "name": "HbA1c"}}
    s.messages = [{"role": "user", "content": [{"text": "HbA1c over five years"}]}, {"role": "assistant", "content": [{"text": "Who uses it?"}]}]
    store.save(s)
    status, view = call(api, "GET /drafts/{id}", id=sid)
    assert view["turn"]["reply"] == "Who uses it?" and view["transcript"] == [{"role": "user", "text": "HbA1c over five years"}, {"role": "assistant", "text": "Who uses it?"}]
    status, body = call(api, "POST /drafts/{id}/turns", {"message": "Diabetes clinicians"}, id=sid)
    assert status == 202 and body["turn"]["status"] == "queued" and len(invocations) == 2

    status, body = call(api, "GET /drafts")
    assert status == 200 and body["drafts"][0]["session_id"] == sid and body["drafts"][0]["turn_status"] == "queued"


def test_a_turn_the_worker_never_finished_is_shown_as_failed_and_stops_blocking_the_draft(world) -> None:  # type: ignore[no-untyped-def]
    """
    A hard Lambda timeout skips the worker's error path, so the turn stayed `running` for good: the panel polled every
    two seconds forever (and the preview re-ran its data plan on each poll), and no new message could be sent. Past the
    worker's own timeout the turn is presented as failed and the draft is free again.
    """
    from datetime import datetime, timedelta, timezone

    table, store, api, invocations = world
    status, body = call(api, "POST /drafts", {"message": "HbA1c over five years"})
    sid = body["session_id"]
    s = store.load(sid)
    assert s.turn_busy and not s.turn_stale
    # Fresh: busy, polled, no second message.
    assert call(api, "POST /drafts/{id}/turns", {"message": "again"}, id=sid)[0] == 409
    # Eleven minutes later with no word from the worker.
    s.turn["started_at"] = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat().replace("+00:00", "Z")
    store.save(s)
    s = store.load(sid)
    assert s.turn_stale and not s.turn_busy
    status, view = call(api, "GET /drafts/{id}", id=sid)
    assert view["turn"]["status"] == "failed" and "did not answer in time" in view["turn"]["error"] and view["turn"]["message"] == "HbA1c over five years"
    assert store.load(sid).turn["status"] == "queued", "presented as failed; the stored turn is left as the worker left it"
    status, body = call(api, "POST /drafts/{id}/turns", {"message": "HbA1c over five years, please"}, id=sid)
    assert status == 202 and body["turn"]["status"] == "queued" and len(invocations) == 2, "the author can send again"
    # A turn without a usable start time is not waited for either.
    s = store.load(sid)
    s.turn["started_at"] = "garbage"
    store.save(s)
    assert store.load(sid).turn_stale


def test_patch_applies_the_same_validated_operations_as_the_agent(world) -> None:  # type: ignore[no-untyped-def]
    _, store, api, _ = world
    _, body = call(api, "POST /drafts", {})
    sid = body["session_id"]
    ops = [
        {"op": "choose_archetype", "args": {"archetype": "APP-02", "reason": "trend"}},
        {"op": "set_app", "args": {"app_id": "app_hba1c", "name": "HbA1c over time"}},
        {"op": "set_knobs", "args": {"patch": {"codes": [{"system": "loinc", "code": "4548-4"}], "series": [{"label": "HbA1c", "code": "4548-4"}], "unit": "%"}}},
        {"op": "add_role", "args": {"role": {"id": "clinician", "display_name": "Clinician", "phi_fields_visible": ["name", "dob", "mrn"], "group": {"kind": "existing", "name": "kardiologie"}}}},
        {"op": "set_governance", "args": {"patch": {"clinical_context": "diabetes_clinic", "intended_users": ["diabetologist"], "intended_purpose": "Display only."}}},
    ]
    status, body = call(api, "PATCH /drafts/{id}", {"ops": ops}, id=sid)
    assert status == 200 and body["open"] == [] and body["spec"]["default_role"] == "clinician"
    assert store.load(sid).events[-1]["tool"] == "panel_edit"  # type: ignore[union-attr]

    # One bad op rejects the whole batch and changes nothing.
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_knobs", "args": {"patch": {"unit": "mmol/mol"}}}, {"op": "set_knobs", "args": {"patch": {"window": "yesterday"}}}]}, id=sid)
    assert status == 422 and body["rejected"][0]["path"] == "knobs.window"
    assert store.load(sid).spec["knobs"]["unit"] == "%"  # type: ignore[union-attr]

    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "update_role", "args": {"id": "clinician", "patch": {"group": {"kind": "existing", "name": "diabetologie"}}}}]}, id=sid)
    assert status == 422 and "not an existing group" in body["rejected"][0]["message"]
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "paint", "args": {}}]}, id=sid)
    assert status == 400

    # A structured assessment may only render a Questionnaire the record has (same rule as the agent's tool).
    _, body = call(api, "POST /drafts", {})
    sid2 = body["session_id"]
    call(api, "PATCH /drafts/{id}", {"ops": [{"op": "choose_archetype", "args": {"archetype": "APP-11", "reason": "form"}}]}, id=sid2)
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_knobs", "args": {"patch": {"questionnaire": "https://example.org/Questionnaire/made-up"}}}]}, id=sid2)
    assert status == 422 and body["rejected"][0]["path"] == "knobs.questionnaire"
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_knobs", "args": {"patch": {"questionnaire": "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"}}}]}, id=sid2)
    assert status == 200
    status, body = call(api, "PATCH /drafts/{id}", {"ops": []}, id=sid)
    assert status == 400

    # A record section may only refer to a shape the library has published (same rule as the agent's tool). This API has
    # no library connected: every reference is refused with the way out.
    _, body = call(api, "POST /drafts", {})
    sid3 = body["session_id"]
    call(api, "PATCH /drafts/{id}", {"ops": [{"op": "choose_archetype", "args": {"archetype": "APP-12", "reason": "a therapy page"}}]}, id=sid3)
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_knobs", "args": {"patch": {"sections": [{"id": "goals", "kind": "list", "resource": "Goal"}, {"id": "new_goal", "kind": "record", "shape": "measurable_goal"}]}}}]}, id=sid3)
    assert status == 422 and body["rejected"] == [{"path": "knobs.sections.1.shape", "message": '"measurable_goal" is not a published record shape. The library has no published shape yet.'}]


def test_visibility_and_authorization(world) -> None:  # type: ignore[no-untyped-def]
    _, _, api, _ = world
    _, body = call(api, "POST /drafts", {})
    sid = body["session_id"]
    assert call(api, "GET /drafts/{id}", id=sid, sub="author-2")[0] == 404, "another author sees no oracle"
    assert call(api, "GET /drafts/{id}", id=sid, sub="admin-1", groups="[medapp-admins]")[0] == 404, "a conversation is private to its author — admins too"
    assert call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "X"}}]}, id=sid, sub="admin-1", groups="[medapp-admins]")[0] == 404
    assert call(api, "GET /drafts", sub="admin-1", groups="[medapp-admins]")[1]["drafts"] == []
    assert call(api, "GET /drafts", groups="[medapp-viewers]")[0] == 403
    assert call(api, "GET /drafts", groups="[medapp-approvers]")[0] == 403, "approvers review, they do not draft"
    assert handler.handle({"routeKey": "GET /drafts", "requestContext": {}}, api)["statusCode"] == 401
    assert call(api, "GET /drafts/{id}", id="nope")[0] == 404
    assert call(api, "POST /drafts/{id}/turns", {"message": ""}, id=sid)[0] == 400
    assert call(api, "POST /drafts/{id}/turns", {"message": "x" * 5000}, id=sid)[0] == 400
    bad = event("POST /drafts")
    bad["body"] = "{not json"
    assert handler.handle(bad, api)["statusCode"] == 400


def test_a_draft_can_start_from_a_stored_spec_and_the_groups_route_lists_bindable_groups(world) -> None:  # type: ignore[no-untyped-def]
    _, store, api, _ = world
    from pathlib import Path as _P

    import yaml

    spec = yaml.safe_load((_P(__file__).resolve().parents[2].parent / "med_app" / "specs" / "bp-trend.yaml").read_text(encoding="utf-8"))
    status, body = call(api, "POST /drafts", {"spec": spec, "iterates": {"app_id": "app_bp_trend", "version": "0.3.0"}})
    assert status == 201
    view = call(api, "GET /drafts/{id}", id=body["session_id"])[1]
    assert view["open"] == [] and view["spec"]["archetype"] == "APP-02" and view["iterates"] == {"app_id": "app_bp_trend", "version": "0.3.0"}
    assert store.load(body["session_id"]).events[0]["tool"] == "seed_spec"  # type: ignore[union-attr]

    bad = {**spec, "knobs": {**spec["knobs"], "window": "yesterday"}}
    status, body = call(api, "POST /drafts", {"spec": bad})
    assert status == 422 and body["rejected"][0]["path"] == "knobs.window"
    assert call(api, "POST /drafts", {"spec": "nope"})[0] == 400

    status, body = call(api, "GET /groups")
    assert status == 200 and body["groups"] == [{"name": "kardiologie", "description": ""}]


def test_a_conversation_can_be_deleted_by_its_author_until_it_is_saved(world) -> None:  # type: ignore[no-untyped-def]
    table, store, api, _ = world
    _, body = call(api, "POST /drafts", {})
    sid = body["session_id"]
    call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "Throwaway"}}]}, id=sid)

    assert handler.handle(event("DELETE /drafts/{id}", sub="author-2", id=sid), api)["statusCode"] == 404, "not theirs: no oracle"
    assert handler.handle(event("DELETE /drafts/{id}", sub="admin-1", groups="[medapp-admins]", id=sid), api)["statusCode"] == 404

    # While the agent works, deletion waits.
    s = store.load(sid)
    s.begin_turn("more")  # type: ignore[union-attr]
    store.save(s)  # type: ignore[arg-type]
    assert handler.handle(event("DELETE /drafts/{id}", id=sid), api)["statusCode"] == 409
    s.turn["status"] = "done"  # type: ignore[index]
    store.save(s)  # type: ignore[arg-type]

    res = handler.handle(event("DELETE /drafts/{id}", id=sid), api)
    assert res["statusCode"] == 204 and sid not in table.items
    assert call(api, "GET /drafts/{id}", id=sid)[0] == 404
    assert call(api, "GET /drafts")[1]["drafts"] == []

    # Saved to the registry: the conversation stays as the version's record.
    _, body = call(api, "POST /drafts", {})
    saved = store.load(body["session_id"])
    saved.saved_as = {"app_id": "app_x", "version": "0.1.0"}  # type: ignore[union-attr]
    store.save(saved)  # type: ignore[arg-type]
    assert handler.handle(event("DELETE /drafts/{id}", id=body["session_id"]), api)["statusCode"] == 409


def test_iterating_on_a_saved_app_continues_its_conversation_in_a_new_draft(world) -> None:  # type: ignore[no-untyped-def]
    # First demo round: "iterate" opened a blank chat seeded with the spec alone. The conversation that produced the version
    # is the author's own saved draft; the new draft picks it up — messages, spec, refusals — and the saved one stays as it is.
    _, store, api, _ = world
    _, body = call(api, "POST /drafts", {})
    sid = body["session_id"]
    call(api, "PATCH /drafts/{id}", {"ops": [{"op": "choose_archetype", "args": {"archetype": "APP-02", "reason": "a trend"}}, {"op": "set_app", "args": {"name": "HbA1c trend", "app_id": "app_hba1c"}}]}, id=sid)
    original = store.load(sid)
    original.messages = [  # type: ignore[union-attr]
        {"role": "user", "content": [{"text": "HbA1c over five years"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "set_knobs", "input": {"patch": {"window": "now-5y"}}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "{}"}], "status": "success"}}]},
        {"role": "assistant", "content": [{"text": "Five years it is. Who will use it?"}]},
    ]
    original.language = "en"  # type: ignore[union-attr]
    original.refusals = [{"refusal": "computation", "detail": "a risk score"}]  # type: ignore[union-attr]
    original.saved_as = {"app_id": "app_hba1c", "version": "0.1.0", "at": "2026-10-08T09:00:00Z"}  # type: ignore[union-attr]
    store.save(original)  # type: ignore[arg-type]

    status, body = call(api, "POST /drafts", {"from_session": sid})
    assert status == 201 and body["session_id"] != sid
    view = call(api, "GET /drafts/{id}", id=body["session_id"])[1]
    assert view["transcript"] == [{"role": "user", "text": "HbA1c over five years"}, {"role": "assistant", "text": "Five years it is. Who will use it?"}], "the conversation continues"
    assert view["spec"]["archetype"] == "APP-02" and view["spec"]["app"]["name"] == "HbA1c trend"
    assert view["iterates"] == {"app_id": "app_hba1c", "version": "0.1.0"}, "what the source was saved as, unless told otherwise"
    assert view["saved_as"] is None and view["refusals"] == [{"refusal": "computation", "detail": "a risk score"}]
    continued = store.load(body["session_id"])
    assert continued.messages == original.messages and continued.language == "en"  # type: ignore[union-attr]
    assert continued.events[-1]["tool"] == "continue_from" and continued.events[-1]["args"]["session_id"] == sid  # type: ignore[union-attr]
    # The source is untouched: still saved, still the version's record.
    assert store.load(sid).saved_as == original.saved_as and store.load(sid).messages == original.messages  # type: ignore[union-attr]

    # An explicit `iterates` wins over the source's saved_as (iterating on a later version of the same app).
    status, body = call(api, "POST /drafts", {"from_session": sid, "iterates": {"app_id": "app_hba1c", "version": "0.2.0"}})
    assert status == 201 and call(api, "GET /drafts/{id}", id=body["session_id"])[1]["iterates"] == {"app_id": "app_hba1c", "version": "0.2.0"}

    # Only the author's own conversation can be continued — the same rule as reading it; no oracle for others.
    assert handler.handle(event("POST /drafts", {"from_session": sid}, sub="admin-1", groups="[medapp-admins]"), api)["statusCode"] == 404
    assert call(api, "POST /drafts", {"from_session": "nope"})[0] == 404
    # Not while the agent is still working on it.
    busy = store.load(sid)
    busy.begin_turn("more")  # type: ignore[union-attr]
    store.save(busy)  # type: ignore[arg-type]
    assert call(api, "POST /drafts", {"from_session": sid})[0] == 409


def test_a_saved_conversation_stays_editable_while_its_version_is_a_draft_and_freezes_at_submission(world) -> None:  # type: ignore[no-untyped-def]
    _, store, api, _ = world
    _, body = call(api, "POST /drafts", {})
    sid = body["session_id"]
    s = store.load(sid)
    s.saved_as = {"app_id": "app_x", "version": "0.1.0", "at": "t", "state": "draft"}  # type: ignore[union-attr]
    store.save(s)  # type: ignore[arg-type]
    assert call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "Still mine to change"}}]}, id=sid)[0] == 200
    assert call(api, "POST /drafts/{id}/turns", {"message": "make the chart taller"}, id=sid)[0] == 202
    s = store.load(sid)
    s.turn["status"] = "done"  # type: ignore[index]
    s.saved_as = {**s.saved_as, "state": "in_review"}  # type: ignore[union-attr]
    store.save(s)  # type: ignore[arg-type]
    status, body = call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "Too late"}}]}, id=sid)
    assert status == 409 and "submitted for review" in body["message"]
    assert call(api, "POST /drafts/{id}/turns", {"message": "more"}, id=sid)[0] == 409
    # A conversation saved before the state stamp existed is frozen — the safe reading.
    s = store.load(sid)
    s.saved_as = {"app_id": "app_x", "version": "0.1.0"}  # type: ignore[union-attr]
    store.save(s)  # type: ignore[arg-type]
    assert handler.frozen(store.load(sid)) and call(api, "PATCH /drafts/{id}", {"ops": [{"op": "set_app", "args": {"name": "x"}}]}, id=sid)[0] == 409

