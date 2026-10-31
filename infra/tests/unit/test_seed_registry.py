"""
The registry seed's collections step: a seed set's collections (med_app/showcase/<hospital_id>.yaml) become COLLECTION
items with ids from their names, apps narrowed to the manifests seeded, existing ones kept unless --force. The YAML
itself must only name shipped apps — the panel's mock registry reads the same file (facets.test.ts asserts the same).
"""

from __future__ import annotations

import glob
import importlib.util
import sys
from pathlib import Path

import pytest
import yaml
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT))

_spec = importlib.util.spec_from_file_location("seed_registry", ROOT / "scripts" / "seed-registry.py")
seed_registry = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(seed_registry)

MED_APP = ROOT.parent / "med_app"


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict] = {}

    def put_item(self, Item, ConditionExpression=None):  # noqa: N803
        key = (Item["PK"], Item["SK"])
        if ConditionExpression and key in self.items:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "exists"}}, "PutItem")
        self.items[key] = Item


@pytest.mark.parametrize("set_file", sorted(glob.glob(str(MED_APP / "showcase" / "*.yaml"))), ids=lambda p: Path(p).stem)
def test_each_seed_sets_collections_name_only_its_own_apps(set_file):
    """One set per hospital (med_app/showcase/<id>.yaml → manifests/<id>/): its collections name its apps, and every app belongs somewhere."""
    doc = yaml.safe_load(Path(set_file).read_text(encoding="utf-8"))
    hospital_id = doc["hospital_id"]
    assert hospital_id == Path(set_file).stem
    manifests = [yaml.safe_load(Path(f).read_text(encoding="utf-8")) for f in glob.glob(str(MED_APP / "manifests" / hospital_id / "*.yaml"))]
    assert manifests and all(m["metadata"]["hospital_id"] == hospital_id and m["lifecycle"]["state"] == "published" for m in manifests)
    shipped = {m["metadata"]["app_id"] for m in manifests}
    names = [c["name"] for c in doc["collections"]]
    assert len(names) == len(set(names)) >= 2
    for c in doc["collections"]:
        assert c["apps"] and set(c["apps"]) <= shipped, f"{c['name']}: {set(c['apps']) - shipped} not among the manifests"
        assert len(c["apps"]) == len(set(c["apps"]))
    # Every shipped app belongs somewhere: a collection is how the launcher presents the set.
    assert shipped <= {a for c in doc["collections"] for a in c["apps"]}


def test_seed_collections_writes_items_from_the_names_narrows_to_known_apps_and_keeps_existing_ones(tmp_path, capsys):
    path = tmp_path / "collections.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "collections": [
                    {"name": "Ward — everyday chores", "description": "Daily.", "apps": ["app_a", "app_zzz", "app_b", "app_a"]},
                    {"name": "   ", "apps": ["app_a"]},
                ]
            },
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    table = FakeTable()
    seed_registry.seed_collections(table, path, {"app_a", "app_b"}, now="2026-10-12T10:00:00Z", actor_sub="seed", actor={"name": "Ada", "email": None}, force=False)
    out = capsys.readouterr().out
    assert "not among the manifests, dropped: app_zzz" in out and "rejected  collection without a name" in out
    (item,) = table.items.values()
    assert item["PK"] == "COLLECTION#col_ward_everyday_chores" and item["SK"] == "HEAD" and item["type"] == "COLLECTION"
    assert item["name"] == "Ward — everyday chores" and item["description"] == "Daily." and item["app_ids"] == ["app_a", "app_b"]
    assert item["GSI1PK"] == "COLLECTIONS" and item["GSI1SK"].startswith("NAME#ward — everyday chores#")
    assert item["updated_by"] == {"name": "Ada"} and item["created_by_sub"] == "seed"

    # Second run: kept, not overwritten — unless forced.
    path.write_text(yaml.safe_dump({"collections": [{"name": "Ward — everyday chores", "apps": ["app_b"]}]}, allow_unicode=True), encoding="utf-8")
    seed_registry.seed_collections(table, path, {"app_a", "app_b"}, now="2026-10-13T10:00:00Z", actor_sub="seed", actor={}, force=False)
    assert "exists    collection col_ward_everyday_chores" in capsys.readouterr().out
    assert table.items[("COLLECTION#col_ward_everyday_chores", "HEAD")]["app_ids"] == ["app_a", "app_b"]
    seed_registry.seed_collections(table, path, {"app_a", "app_b"}, now="2026-10-13T10:00:00Z", actor_sub="seed", actor={}, force=True)
    assert table.items[("COLLECTION#col_ward_everyday_chores", "HEAD")]["app_ids"] == ["app_b"]


@pytest.mark.parametrize("name, expected", [("Chronic disease clinics", "col_chronic_disease_clinics"), ("Case review and imaging", "col_case_review_and_imaging"), ("Hypertonie-Sprechstunde", "col_hypertonie_sprechstunde")])
def test_collection_ids_match_the_panels(name, expected):
    """collectionIdFor (localClient.ts) and collection_id_for (registry_model.py) agree on the showcase names."""
    from medapp_shared.registry_model import collection_id_for  # noqa: PLC0415

    assert collection_id_for(name) == expected


def test_seed_shapes_writes_published_shape_items_from_the_bundled_documents_and_keeps_existing_ones(capsys):
    """The bundled shapes become HEAD + version 0.1.0 (published) + two events each; a document the compiler refuses is reported; a second run keeps what is there unless forced."""
    from medapp_shared.registry_model import shape_pk, version_sk

    def compile_shape(document: dict):
        shape = document["shape"]
        if not shape.get("fields"):
            return None, ["shape.fields: is required"]
        return {"id": shape["id"], "name": shape["name"], "resource": shape["resource"], "fields": shape["fields"], "rules": {"resource": shape["resource"], "fields": [], "stamps": []}, "checksum": "fnv1a64:0000"}, []

    table = FakeTable()
    seed_registry.seed_shapes(table, MED_APP / "shapes", compile_shape, now="2026-10-15T10:00:00Z", actor_sub="seed", actor={"name": "Ada", "email": None}, force=False)
    out = capsys.readouterr().out
    assert "shape     measurable_goal: Measurable goal (Goal, 6 fields) v0.1.0 [published]" in out and "shape     progress_note:" in out and "shape     consent_per_purpose: Consent decision (Consent, 6 fields)" in out
    head = table.items[(shape_pk("measurable_goal"), "HEAD")]
    assert head["type"] == "SHAPE" and head["active_version"] == "0.1.0" and head["latest_state"] == "published" and head["GSI1PK"] == "SHAPES" and head["updated_by"] == {"name": "Ada"}
    version = table.items[(shape_pk("measurable_goal"), version_sk("0.1.0"))]
    assert version["state"] == "published" and version["checksum"] == "fnv1a64:0000" and '"kind":"RecordShape"' in version["document_json"]
    events = sorted((i for (pk, sk), i in table.items.items() if pk == shape_pk("measurable_goal") and sk.startswith("EVT#")), key=lambda i: i["SK"])
    assert [(e["from_state"], e["to_state"]) for e in events] == [(None, "draft"), ("draft", "published")]
    assert len(table.items) == 16  # four bundled shapes × (HEAD, version, two events)

    seed_registry.seed_shapes(table, MED_APP / "shapes", compile_shape, now="2026-10-16T10:00:00Z", actor_sub="seed", actor={}, force=False)
    assert "exists    shape measurable_goal" in capsys.readouterr().out and table.items[(shape_pk("measurable_goal"), "HEAD")]["updated_at"] == "2026-10-15T10:00:00Z"
    seed_registry.seed_shapes(table, MED_APP / "shapes", compile_shape, now="2026-10-16T10:00:00Z", actor_sub="seed", actor={}, force=True)
    assert table.items[(shape_pk("measurable_goal"), "HEAD")]["updated_at"] == "2026-10-16T10:00:00Z"

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "empty.yaml").write_text(yaml.safe_dump({"apiVersion": "medapp.eu/v1", "kind": "RecordShape", "shape": {"id": "empty", "name": "Empty", "resource": "Goal", "fields": []}}), encoding="utf-8")
        seed_registry.seed_shapes(FakeTable(), Path(tmp), compile_shape, now="t", actor_sub="seed", actor={}, force=False)
        assert "rejected  empty.yaml: shape.fields: is required" in capsys.readouterr().out


def test_the_script_defines_every_step_before_its_entry_point():
    """Running the file as a script executes `main()` where the `__main__` guard sits: a function defined below it is a NameError
    there and fine under import (how these tests load it) — which is exactly how seed_shapes slipped through once."""
    source = (ROOT / "scripts" / "seed-registry.py").read_text(encoding="utf-8").rstrip()
    assert source.endswith('if __name__ == "__main__":\n    raise SystemExit(main())'), "the entry point must be the last statement of the script"
