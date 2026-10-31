import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lambdas" / "registry_api"))

import handler  # noqa: E402
from medapp_shared import registry_model as rm  # noqa: E402

from test_registry_model import MANIFEST  # noqa: E402  (the bp-trend-like manifest: roles viewer/reviewer, default viewer)


def published_manifest():
    m = json.loads(json.dumps(MANIFEST))
    m["metadata"] = {**m["metadata"], "app_id": "app_patient_summary", "name": "Patient summary", "version": "0.1.0"}
    m["auth"]["roles"] = [{"id": "clinician", "display_name": "Treating clinician", "cognito_group": "app-app_patient_summary-clinician", "data_scope_ref": "scope_viewer", "ui_capabilities": []}]
    m["auth"]["default_role"] = "clinician"
    return m


class FakeTable:
    """
    Just enough of boto3's Table for RegistryReader: GSI1 query by REGISTRY, the base-table query for a version's events,
    get_item by key. GSI1 answers with the keys and the projected attributes only, as the real index does — the first
    collection seeded into the real table came back without `collection_id` and `app_ids` and the API answered 500.
    """

    PROJECTED = {"PK", "SK", "GSI1PK", "GSI1SK", *rm.GSI1_PROJECTED_ATTRIBUTES}

    def __init__(self, items):
        self.items = {(i["PK"], i["SK"]): i for i in items}

    def query(self, **kwargs):
        values = kwargs["ExpressionAttributeValues"]
        if kwargs.get("IndexName") == "GSI1":
            return {"Items": [{k: v for k, v in i.items() if k in self.PROJECTED} for i in self.items.values() if i.get("GSI1PK") == values[":pk"]]}
        assert kwargs["KeyConditionExpression"] == "PK = :pk AND begins_with(SK, :prefix)"
        rows = [i for i in self.items.values() if i["PK"] == values[":pk"] and i["SK"].startswith(values[":prefix"])]
        rows.sort(key=lambda i: i["SK"], reverse=not kwargs.get("ScanIndexForward", True))
        return {"Items": rows}

    def get_item(self, **kwargs):
        item = self.items.get((kwargs["Key"]["PK"], kwargs["Key"]["SK"]))
        return {"Item": item} if item else {}


NOW = "2026-09-11T10:00:00Z"


@pytest.fixture
def reader():
    bp_draft = rm.version_item(MANIFEST, created_by_sub="author-1", now=NOW, state="in_review")  # app_bp_trend 0.3.0
    bp_head = rm.head_item(MANIFEST, owner_sub="author-1", now=NOW, latest_version="0.3.0", active_version=None, latest_state="in_review")
    pub = published_manifest()
    pub_version = rm.version_item(pub, created_by_sub="author-2", now=NOW, state="published", signoff={"approver_sub": "appr", "approved_at": NOW, "signature": "x", "clinical_notes": None}, author={"name": "Sabine Weber", "email": "sabine.weber@klinikum-musterstadt.example"})
    pub_head = rm.head_item(pub, owner_sub="author-2", now=NOW, latest_version="0.1.0", active_version="0.1.0", latest_state="published")
    events = [
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-10T09:00:00Z", actor_sub="author-1", from_state=None, to_state="draft", notes="created from draft s1", actor={"name": "Lukas Hoffmann", "email": "lukas@klinikum-musterstadt.example"}),
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-10T10:00:00Z", actor_sub="author-1", from_state="draft", to_state="in_review", actor={"name": "Lukas Hoffmann", "email": "lukas@klinikum-musterstadt.example"}),
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-10T11:00:00Z", actor_sub="appr", from_state="in_review", to_state="draft", notes="The threshold is too low for the ward.", actor={"name": "Ada Approver"}),
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-10T12:00:00Z", actor_sub="author-1", from_state="draft", to_state="draft", notes="revised from draft s1", actor={"email": "lukas@klinikum-musterstadt.example", "name": None}),
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-11T09:00:00Z", actor_sub="author-1", from_state="draft", to_state="in_review"),
        rm.event_item("app_patient_summary", "0.1.0", ts=NOW, actor_sub="appr", from_state="in_review", to_state="approved", notes="Checked with the ward.", signature="kms:ECDSA_SHA_256:abc", actor={"name": "Ada Approver"}),
    ]
    return handler.RegistryReader(FakeTable([bp_draft, bp_head, pub_version, pub_head, *events]))


def event(route, groups, sub="user-1", **path):
    return {
        "routeKey": route,
        "pathParameters": path,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups}}}},
    }


def test_groups_claim_parsing_handles_the_http_api_string_encoding():
    assert handler.parse_groups("[medapp-viewers medapp-admins]") == ["medapp-viewers", "medapp-admins"]
    assert handler.parse_groups(["a", "b"]) == ["a", "b"]
    assert handler.parse_groups("a, b") == ["a", "b"]
    assert handler.parse_groups(None) == [] and handler.parse_groups("[]") == []


def test_clinician_with_blanket_access_sees_only_published_apps(reader):
    res = handler.handle(event("GET /registry/apps", "[medapp-viewers]"), reader)
    body = json.loads(res["body"])
    assert res["statusCode"] == 200
    assert [a["app_id"] for a in body["apps"]] == ["app_patient_summary"]
    app = body["apps"][0]
    assert app["state"] == "published" and app["roles"] == ["clinician"]
    # lifecycle overlay: the frozen manifest said draft, the item says published + signoff
    assert app["manifest"]["lifecycle"]["state"] == "published"
    assert app["manifest"]["lifecycle"]["signoff"]["approver_sub"] == "appr"
    # Attribution is for everyone — a name, not an identifier; the subs stay with staff.
    assert app["author"] == {"name": "Sabine Weber", "email": "sabine.weber@klinikum-musterstadt.example"}
    assert app["owner_sub"] is None and app["created_by_sub"] is None and app["history"] is None


def test_clinician_with_a_per_app_role_but_no_published_version_sees_nothing(reader):
    res = handler.handle(event("GET /registry/apps", "[app-app_bp_trend-reviewer]"), reader)
    assert json.loads(res["body"])["apps"] == []


def test_approver_sees_latest_versions_including_in_review(reader):
    res = handler.handle(event("GET /registry/apps", "[medapp-approvers]"), reader)
    apps = {a["app_id"]: a for a in json.loads(res["body"])["apps"]}
    assert set(apps) == {"app_bp_trend", "app_patient_summary"}
    assert apps["app_bp_trend"]["state"] == "in_review" and apps["app_bp_trend"]["roles"] == ["viewer"]


def test_staff_get_each_versions_history_newest_first_with_who_and_why(reader):
    """The send-back an author must read, the sign-off notes an approver left — never the signature bytes; clinicians get none of it."""
    res = handler.handle(event("GET /registry/apps", "[medapp-approvers]"), reader)
    apps = {a["app_id"]: a for a in json.loads(res["body"])["apps"]}
    history = apps["app_bp_trend"]["history"]
    assert [(e["from_state"], e["to_state"]) for e in history] == [("draft", "in_review"), ("draft", "draft"), ("in_review", "draft"), ("draft", "in_review"), (None, "draft")]
    sent_back = history[2]
    assert sent_back == {"ts": "2026-09-10T11:00:00Z", "actor_sub": "appr", "actor": {"name": "Ada Approver"}, "from_state": "in_review", "to_state": "draft", "notes": "The threshold is too low for the ward.", "signed": False}
    assert history[1]["actor"] == {"email": "lukas@klinikum-musterstadt.example"}, "an empty name is not stored"
    assert history[0]["actor"] is None and history[0]["notes"] is None, "an event written before names were kept"
    approved = apps["app_patient_summary"]["history"][0]
    assert approved["signed"] is True and "signature" not in approved and approved["notes"] == "Checked with the ward."
    one = json.loads(handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-authors]", sub="author-1", app_id="app_bp_trend", version="0.3.0"), reader)["body"])
    assert len(one["history"]) == 5


def test_staff_see_the_published_version_and_its_successor_as_two_rows():
    pub = published_manifest()
    v1 = rm.version_item(pub, created_by_sub="author-2", now=NOW, state="published", signoff={"approver_sub": "appr", "approved_at": NOW, "signature": "x", "clinical_notes": None})
    v2_manifest = json.loads(json.dumps(pub))
    v2_manifest["metadata"]["version"] = "0.2.0"
    v2 = rm.version_item(v2_manifest, created_by_sub="author-2", now=NOW, state="draft")
    head = rm.head_item(v2_manifest, owner_sub="author-2", now=NOW, latest_version="0.2.0", active_version="0.1.0", latest_state="draft")
    reader = handler.RegistryReader(FakeTable([v1, v2, head]))

    staff = json.loads(handler.handle(event("GET /registry/apps", "[medapp-approvers]"), reader)["body"])["apps"]
    assert [(a["version"], a["state"]) for a in staff] == [("0.1.0", "published"), ("0.2.0", "draft")]

    clinician = json.loads(handler.handle(event("GET /registry/apps", "[medapp-viewers]"), reader)["body"])["apps"]
    assert [(a["version"], a["state"]) for a in clinician] == [("0.1.0", "published")], "clinicians never see the successor"


def test_staff_also_get_the_versions_out_of_service_superseded_and_retired():
    """The Deprecated tab: a version a newer publication superseded is neither active nor latest; it reaches staff through the state index."""
    pub = published_manifest()
    v1 = rm.version_item(pub, created_by_sub="author-2", now="2026-09-01T10:00:00Z", state="deprecated")  # superseded by 0.2.0
    v2_manifest = json.loads(json.dumps(pub))
    v2_manifest["metadata"]["version"] = "0.2.0"
    v2 = rm.version_item(v2_manifest, created_by_sub="author-2", now=NOW, state="published", signoff={"approver_sub": "appr", "approved_at": NOW, "signature": "x", "clinical_notes": None})
    head = rm.head_item(v2_manifest, owner_sub="author-2", now=NOW, latest_version="0.2.0", active_version="0.2.0", latest_state="published")
    retired_manifest = json.loads(json.dumps(pub))
    retired_manifest["metadata"] = {**retired_manifest["metadata"], "app_id": "app_ward_board", "name": "Ward board", "version": "1.2.0"}
    retired_manifest["auth"]["roles"][0]["cognito_group"] = "app-app_ward_board-clinician"
    retired = rm.version_item(retired_manifest, created_by_sub="author-2", now=NOW, state="deprecated")
    retired_head = rm.head_item(retired_manifest, owner_sub="author-2", now=NOW, latest_version="1.2.0", active_version=None, latest_state="deprecated")
    reader = handler.RegistryReader(FakeTable([v1, v2, head, retired, retired_head]))

    staff = json.loads(handler.handle(event("GET /registry/apps", "[medapp-approvers]"), reader)["body"])["apps"]
    assert sorted((a["app_id"], a["version"], a["state"]) for a in staff) == [("app_patient_summary", "0.1.0", "deprecated"), ("app_patient_summary", "0.2.0", "published"), ("app_ward_board", "1.2.0", "deprecated")]
    assert len(staff) == 3, "the retired version is the app's latest and is listed once"

    clinician = json.loads(handler.handle(event("GET /registry/apps", "[medapp-viewers]"), reader)["body"])["apps"]
    assert [(a["version"], a["state"]) for a in clinician] == [("0.2.0", "published")], "clinicians never see what is out of service"


def test_collections_name_only_the_apps_a_clinician_may_open_and_staff_get_them_whole():
    """A clinician's collection is their view of it: no name, no count tells them about apps they have no access to."""
    pub = published_manifest()
    v1 = rm.version_item(pub, created_by_sub="author-2", now=NOW, state="published", signoff={"approver_sub": "appr", "approved_at": NOW, "signature": "x", "clinical_notes": None})
    head = rm.head_item(pub, owner_sub="author-2", now=NOW, latest_version="0.1.0", active_version="0.1.0", latest_state="published")
    bp_head = rm.head_item(MANIFEST, owner_sub="author-1", now=NOW, latest_version="0.3.0", active_version=None, latest_state="in_review")
    bp_draft = rm.version_item(MANIFEST, created_by_sub="author-1", now=NOW, state="in_review")
    clinic = rm.collection_item("col_hypertonie", name="Hypertonie-Sprechstunde", description="Alles für die Sprechstunde.", app_ids=["app_patient_summary", "app_bp_trend"], now=NOW, actor_sub="appr", actor={"name": "Ada Approver"})
    drafts_only = rm.collection_item("col_in_progress", name="In Arbeit", description=None, app_ids=["app_bp_trend"], now=NOW, actor_sub="appr")
    gone = {**rm.collection_item("col_old", name="Alt", description=None, app_ids=["app_patient_summary"], now=NOW, actor_sub="appr"), **rm.collection_gsi1("Alt", "col_old", deleted=True)}
    reader = handler.RegistryReader(FakeTable([v1, head, bp_head, bp_draft, clinic, drafts_only, gone]))

    staff = json.loads(handler.handle(event("GET /registry/collections", "[medapp-approvers]"), reader)["body"])["collections"]
    assert [(c["collection_id"], c["app_ids"]) for c in staff] == [("col_hypertonie", ["app_patient_summary", "app_bp_trend"]), ("col_in_progress", ["app_bp_trend"])], "whole, by name; the removed one is gone"
    assert staff[0]["updated_by"] == {"name": "Ada Approver"} and staff[0]["description"] == "Alles für die Sprechstunde." and staff[1]["updated_by"] is None

    clinician = json.loads(handler.handle(event("GET /registry/collections", "[medapp-viewers]"), reader)["body"])["collections"]
    assert [(c["collection_id"], c["app_ids"]) for c in clinician] == [("col_hypertonie", ["app_patient_summary"])], "the version in review is not theirs to see; the collection of drafts alone is not shown at all"
    assert json.loads(handler.handle(event("GET /registry/collections", "[]"), reader)["body"])["collections"] == []


def test_the_shape_library_is_read_by_staff_with_the_latest_version_whole_and_the_published_artifact():
    """The index names the shapes; each head, its latest and its published version are read by key — the artifact is never in the index."""
    doc = {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "measurable_goal", "name": "Measurable goal", "resource": "Goal", "status": "active", "fields": [{"id": "goal", "label": "Goal", "type": "text", "path": "description", "required": True}]}}
    art = lambda name, checksum, fields=1: {"id": "measurable_goal", "name": name, "resource": "Goal", "fields": doc["shape"]["fields"] * fields, "rules": {"resource": "Goal", "fields": [], "stamps": []}, "checksum": checksum}  # noqa: E731
    v1 = {**rm.shape_version_item(doc, art("Measurable goal", "fnv1a64:aaaa"), version="0.1.0", created_by_sub="author-1", now=NOW, state="published", author={"name": "Lukas Hoffmann"}), "updated_at": "2026-09-12T10:00:00Z"}
    v2 = rm.shape_version_item({**doc, "shape": {**doc["shape"], "name": "Measurable therapy goal"}}, art("Measurable therapy goal", "fnv1a64:bbbb", 2), version="0.2.0", created_by_sub="author-1", now="2026-09-13T10:00:00Z", parent_version="0.1.0")
    head = {**rm.shape_head_item(art("Measurable therapy goal", "fnv1a64:bbbb"), owner_sub="author-1", now=NOW, latest_version="0.2.0", active_version="0.1.0", latest_state="draft"), "updated_at": "2026-09-13T10:00:00Z"}
    note_doc = {"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "ward_note", "name": "Ward note", "resource": "DocumentReference", "fields": [{"id": "text", "label": "Note", "type": "long_text", "path": "content[0].attachment", "required": True}]}}
    note_art = {"id": "ward_note", "name": "Ward note", "resource": "DocumentReference", "fields": note_doc["shape"]["fields"], "rules": {"resource": "DocumentReference", "fields": [], "stamps": []}, "checksum": "fnv1a64:cccc"}
    note_v1 = rm.shape_version_item(note_doc, note_art, version="0.1.0", created_by_sub="author-2", now=NOW)
    note_head = rm.shape_head_item(note_art, owner_sub="author-2", now=NOW, latest_version="0.1.0")
    events = [
        rm.shape_event_item("measurable_goal", "0.1.0", ts="2026-09-11T09:00:00Z", actor_sub="author-1", from_state=None, to_state="draft", notes="created", actor={"name": "Lukas Hoffmann"}),
        rm.shape_event_item("measurable_goal", "0.1.0", ts="2026-09-12T10:00:00Z", actor_sub="appr", from_state="draft", to_state="published", notes="Reviewed with the physio lead.", actor={"name": "Ada Approver"}),
        rm.shape_event_item("measurable_goal", "0.2.0", ts="2026-09-13T10:00:00Z", actor_sub="author-1", from_state=None, to_state="draft", notes="from 0.1.0"),
    ]
    reader = handler.RegistryReader(FakeTable([v1, v2, head, note_v1, note_head, *events]))

    assert handler.handle(event("GET /registry/shapes", "[medapp-viewers]"), reader)["statusCode"] == 403, "clinicians never need the library"
    assert handler.handle(event("GET /registry/shapes/{shape_id}", "[medapp-viewers]", shape_id="measurable_goal"), reader)["statusCode"] == 404

    shapes = json.loads(handler.handle(event("GET /registry/shapes", "[medapp-authors]"), reader)["body"])["shapes"]
    assert [s["shape_id"] for s in shapes] == ["measurable_goal", "ward_note"], "by name"
    goal = shapes[0]
    assert goal["name"] == "Measurable therapy goal" and goal["resource"] == "Goal" and goal["latest_version"] == "0.2.0" and goal["latest_state"] == "draft" and goal["active_version"] == "0.1.0"
    assert goal["latest"]["version"] == "0.2.0" and goal["latest"]["document"]["shape"]["name"] == "Measurable therapy goal" and len(goal["latest"]["artifact"]["fields"]) == 2 and goal["latest"]["parent_version"] == "0.1.0"
    assert goal["published"] == {"version": "0.1.0", "checksum": "fnv1a64:aaaa", "artifact": art("Measurable goal", "fnv1a64:aaaa")}, "what a compile resolves `shape: measurable_goal` to"
    assert shapes[1]["published"] is None and shapes[1]["latest"]["author"] is None and shapes[1]["latest"]["state"] == "draft"

    one = json.loads(handler.handle(event("GET /registry/shapes/{shape_id}", "[medapp-approvers]", shape_id="measurable_goal"), reader)["body"])
    assert [(v["version"], v["state"]) for v in one["versions"]] == [("0.2.0", "draft"), ("0.1.0", "published")], "newest first, each whole"
    assert one["versions"][1]["author"] == {"name": "Lukas Hoffmann"}
    assert [(h["version"], h["ts"], h["to_state"], h["notes"]) for h in one["history"]] == [("0.2.0", "2026-09-13T10:00:00Z", "draft", "from 0.1.0"), ("0.1.0", "2026-09-12T10:00:00Z", "published", "Reviewed with the physio lead."), ("0.1.0", "2026-09-11T09:00:00Z", "draft", "created")]
    assert one["history"][1]["actor"] == {"name": "Ada Approver"} and one["history"][1]["signed"] is False
    assert handler.handle(event("GET /registry/shapes/{shape_id}", "[medapp-approvers]", shape_id="nowhere"), reader)["statusCode"] == 404


def test_author_sees_own_drafts_only(reader):
    mine = handler.handle(event("GET /registry/apps", "[medapp-authors]", sub="author-1"), reader)
    assert [a["app_id"] for a in json.loads(mine["body"])["apps"]] == ["app_bp_trend"]
    other = handler.handle(event("GET /registry/apps", "[medapp-authors]", sub="somebody-else"), reader)
    assert json.loads(other["body"])["apps"] == []


def test_no_role_no_apps_and_no_oracle_on_hidden_versions(reader):
    res = handler.handle(event("GET /registry/apps", "[]"), reader)
    assert json.loads(res["body"])["apps"] == []
    hidden = handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-viewers]", app_id="app_bp_trend", version="0.3.0"), reader)
    assert hidden["statusCode"] == 404
    missing = handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-admins]", app_id="app_nope", version="active"), reader)
    assert missing["statusCode"] == 404


def test_version_aliases(reader):
    active = handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-viewers]", app_id="app_patient_summary", version="active"), reader)
    assert active["statusCode"] == 200 and json.loads(active["body"])["version"] == "0.1.0"
    # `latest` is downgraded to `active` for clinicians; the draft app has no active version → 404
    latest_for_viewer = handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-viewers]", app_id="app_bp_trend", version="latest"), reader)
    assert latest_for_viewer["statusCode"] == 404
    latest_for_admin = handler.handle(event("GET /registry/apps/{app_id}/versions/{version}", "[medapp-admins]", app_id="app_bp_trend", version="latest"), reader)
    assert latest_for_admin["statusCode"] == 200 and json.loads(latest_for_admin["body"])["state"] == "in_review"


def test_unauthenticated_and_unknown_routes():
    r = handler.RegistryReader(FakeTable([]))
    assert handler.handle({"routeKey": "GET /registry/apps", "requestContext": {}}, r)["statusCode"] == 401
    assert handler.handle(event("GET /nothing", "[medapp-admins]"), r)["statusCode"] == 404
