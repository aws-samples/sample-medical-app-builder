import json
from pathlib import Path

import pytest

from medapp_shared import registry_model as rm

MANIFEST = {
    "apiVersion": "medapp.eu/v1",
    "kind": "AppManifest",
    "metadata": {"app_id": "app_bp_trend", "version": "0.3.0", "parent_version": "0.2.1", "name": "Longitudinal blood pressure", "intent_class": "viewer", "hospital_id": "hsp-musterstadt"},
    "lifecycle": {"state": "draft", "provenance": {"prompt_hash": "sha256:abc"}},
    "auth": {
        "roles": [
            {"id": "viewer", "display_name": "Read-only viewer", "cognito_group": "app-app_bp_trend-viewer", "data_scope_ref": "scope_viewer", "ui_capabilities": ["view"]},
            {"id": "reviewer", "display_name": "Clinical reviewer", "cognito_group": "app-app_bp_trend-reviewer", "data_scope_ref": "scope_reviewer", "ui_capabilities": ["view", "add_annotation"]},
        ],
        "default_role": "viewer",
    },
    "data_scopes": {
        "scope_viewer": {"patient_scope": "individual", "phi_fields_visible": ["name", "dob", "mrn"], "fhir": [{"resource": "Patient", "operations": ["read"]}, {"resource": "Observation", "operations": ["search"]}]},
        "scope_reviewer": {"inherits": "scope_viewer", "phi_fields_visible": ["name", "dob", "gender", "mrn", "address", "phone"], "fhir": [{"resource": "Condition", "operations": ["search"]}]},
    },
    "primitives": [],
    "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell"}},
    "context_inputs": [],
}


def test_padded_versions_sort_like_semver():
    versions = ["0.3.0", "0.10.0", "1.0.0", "0.2.1", "0.9.12"]
    assert rm.newest_first(versions) == ["1.0.0", "0.10.0", "0.9.12", "0.3.0", "0.2.1"]
    assert rm.pad_version("0.10.0") > rm.pad_version("0.9.12")  # lexical == numeric
    assert rm.unpad_version(rm.pad_version("12.0.7")) == "12.0.7"
    with pytest.raises(ValueError):
        rm.pad_version("1.2")


def test_keys_keep_versions_and_events_in_separate_ranges():
    assert rm.version_sk("0.3.0") == "V#00000.00003.00000"
    assert rm.event_sk("0.3.0", "2026-09-12T14:02:11Z") == "EVT#00000.00003.00000#2026-09-12T14:02:11Z"
    assert rm.app_pk("app_x") == "APP#app_x"
    assert rm.head_gsi1("Longitudinal Blood Pressure", "app_bp_trend") == {"GSI1PK": "REGISTRY", "GSI1SK": "NAME#longitudinal blood pressure#app_bp_trend"}
    assert rm.state_gsi1("in_review", "2026-09-12T14:02:11Z", "app_bp_trend", "0.3.0")["GSI1SK"] == "2026-09-12T14:02:11Z#app_bp_trend#00000.00003.00000"


def test_lifecycle_transitions():
    for ok in [("draft", "in_review"), ("in_review", "approved"), ("in_review", "draft"), ("approved", "published"), ("published", "deprecated")]:
        rm.assert_transition(*ok)
    for bad in [("draft", "published"), ("published", "draft"), ("deprecated", "draft"), ("approved", "in_review")]:
        with pytest.raises(rm.IllegalTransition):
            rm.assert_transition(*bad)


def test_manifest_hash_is_over_canonical_bytes():
    a = rm.canonical_json({"b": 1, "a": [1, 2]})
    b = rm.canonical_json({"a": [1, 2], "b": 1})
    assert a == b == '{"a":[1,2],"b":1}'
    assert rm.manifest_hash(a) == rm.manifest_hash(b)
    assert rm.manifest_hash(a).startswith("sha256:")


def test_effective_scope_follows_inherits_like_the_renderer():
    reviewer = rm.effective_scope(MANIFEST, "reviewer")
    assert [f["resource"] for f in reviewer["fhir"]] == ["Patient", "Observation", "Condition"]
    assert reviewer["phi_fields_visible"] == ["name", "dob", "gender", "mrn", "address", "phone"]
    assert reviewer["lineage"] == ["scope_viewer", "scope_reviewer"]
    hashes = rm.data_scope_hashes(MANIFEST)
    assert set(hashes) == {"viewer", "reviewer"} and hashes["viewer"] != hashes["reviewer"]


def test_version_item_freezes_manifest_and_starts_in_draft():
    item = rm.version_item(MANIFEST, created_by_sub="sub-1", now="2026-09-12T13:58:40Z")
    assert item["PK"] == "APP#app_bp_trend" and item["SK"] == "V#00000.00003.00000"
    assert item["state"] == "draft" and item["GSI1PK"] == "STATE#draft"
    assert item["manifest_hash"] == rm.manifest_hash(item["manifest_json"])
    assert json.loads(item["manifest_json"])["metadata"]["version"] == "0.3.0"
    assert item["provenance"] == {"prompt_hash": "sha256:abc"}
    assert item["renderer"] is None and item["signoff"] is None


def test_a_version_carries_its_author_as_a_name_for_people_beside_the_sub_for_rules():
    item = rm.version_item(MANIFEST, created_by_sub="sub-1", now="2026-09-12T13:58:40Z", author={"name": "Lukas Hoffmann", "email": "lukas.hoffmann@klinikum-musterstadt.example"})
    assert item["created_by_sub"] == "sub-1" and item["author"] == {"name": "Lukas Hoffmann", "email": "lukas.hoffmann@klinikum-musterstadt.example"}
    assert rm.version_item(MANIFEST, created_by_sub="sub-1", now="t", author={"name": None, "email": " a@b.de "})["author"] == {"email": "a@b.de"}, "empty parts dropped, the rest trimmed"
    assert rm.version_item(MANIFEST, created_by_sub="sub-1", now="t")["author"] is None, "nothing known, nothing shown"
    assert rm.author_label({"name": "", "email": None}) is None


def test_head_item_denormalises_roles_for_the_launcher():
    head = rm.head_item(MANIFEST, owner_sub="sub-1", now="2026-09-12T13:58:40Z", latest_version="0.3.0")
    assert head["SK"] == "HEAD" and head["GSI1PK"] == "REGISTRY"
    assert [r["id"] for r in head["roles"]] == ["viewer", "reviewer"]
    assert head["active_version"] is None and head["latest_state"] == "draft"


def test_a_revision_event_is_draft_to_draft_and_nothing_else_may_stand_still():
    revised = rm.event_item("app_x", "0.1.0", ts="t", actor_sub="a", from_state="draft", to_state="draft", notes="revised from draft s1")
    assert revised["from_state"] == "draft" and revised["to_state"] == "draft"
    with pytest.raises(rm.IllegalTransition):
        rm.event_item("app_x", "0.1.0", ts="t", actor_sub="a", from_state="in_review", to_state="in_review")
    assert rm.version_item(MANIFEST, created_by_sub="a", now="t", session_id="s1")["session_id"] == "s1"
    assert rm.version_item(MANIFEST, created_by_sub="a", now="t")["session_id"] is None
    sets = rm.revision_sets(MANIFEST, {"app": {"app_id": MANIFEST["metadata"]["app_id"]}}, "t2", "s1")
    assert set(sets) == {"manifest_json", "manifest_hash", "spec_json", "data_scope_hashes", "updated_at", "session_id"} and sets["updated_at"] == "t2"


def test_event_item_refuses_illegal_transitions():
    with pytest.raises(rm.IllegalTransition):
        rm.event_item("app_bp_trend", "0.3.0", ts="2026-09-12T14:02:11Z", actor_sub="s", from_state="draft", to_state="published")


def test_mutable_attribute_list_never_includes_the_manifest():
    assert "manifest_json" not in rm.LIFECYCLE_MUTABLE_ATTRIBUTES
    assert "manifest_hash" not in rm.LIFECYCLE_MUTABLE_ATTRIBUTES


def test_design_doc_mentions_every_lifecycle_state():
    doc = (Path(__file__).resolve().parents[2] / "docs" / "registry-table.md").read_text(encoding="utf-8")
    for state in rm.LIFECYCLE_STATES:
        assert state in doc


def test_collection_items_carry_a_stable_slug_id_and_a_name_index():
    assert rm.collection_id_for("Hypertonie-Sprechstunde") == "col_hypertonie_sprechstunde"
    assert rm.collection_id_for("  Station 3 — Pflege  ") == "col_station_3_pflege"
    assert rm.collection_id_for("Geriatrie Übersicht") == "col_geriatrie_uebersicht"
    with pytest.raises(ValueError):
        rm.collection_id_for(" — ")
    item = rm.collection_item("col_x", name=" X ", description="  ", app_ids=["a", "b", "a"], now="t", actor_sub="s", actor={"name": "Ada", "email": None})
    assert item["name"] == "X" and item["description"] is None and item["app_ids"] == ["a", "b"] and item["updated_by"] == {"name": "Ada"}
    assert item["GSI1PK"] == "COLLECTIONS" and item["GSI1SK"] == "NAME#x#col_x" and item["PK"] == "COLLECTION#col_x" and item["SK"] == "HEAD"
    assert rm.present_collection(item, app_ids=["b"]) == {"collection_id": "col_x", "name": "X", "description": None, "app_ids": ["b"], "updated_at": "t", "updated_by": {"name": "Ada"}}
    assert rm.collection_gsi1("X", "col_x", deleted=True)["GSI1PK"] == "COLLECTIONS#deleted"
