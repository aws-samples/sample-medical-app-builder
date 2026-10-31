"""
The audit trail: records become items findable by day, person, app and patient; the sink writes the log line and the
item and never fails the request it describes; the read API answers an administrator's questions newest first with a
cursor, on whichever index the filters select; the stack keeps the trail append-only and indefinite.
"""

import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Template

from medapp_shared import audit_model as am
from stacks import AuditStack

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("audit_api_handler", ROOT / "lambdas" / "audit_api" / "handler.py")
handler = importlib.util.module_from_spec(spec)
sys.modules["audit_api_handler"] = handler
spec.loader.exec_module(handler)  # type: ignore[union-attr]


# ── the model ─────────────────────────────────────────────────────────────────────────────────


def test_a_record_becomes_an_item_keyed_by_day_person_app_and_patient():
    record = {"audit_id": "a1", "timestamp": "2026-10-09T08:15:00.000000Z", "kind": "data.fhir.patient.read", "user_sub": "sub-1", "user_name": "Ada", "app_id": "app_x", "manifest_version": "1.0.0", "patient_context": "pat-1", "outcome": "ok", "detail": None}
    item = am.audit_item(record, source="dispatcher")
    assert item["PK"] == "DAY#2026-10-09" and item["SK"] == "2026-10-09T08:15:00.000000Z#a1"
    assert item["GSI1PK"] == "USER#sub-1" and item["GSI2PK"] == "APP#app_x" and item["GSI3PK"] == "PATIENT#pat-1" and item["GSI1SK"] == item["GSI2SK"] == item["GSI3SK"] == item["SK"]
    assert item["source"] == "dispatcher" and "detail" not in item, "None is not stored"
    assert am.present(item) == {k: v for k, v in record.items() if v is not None} | {"source": "dispatcher"}
    sparse = am.audit_item({"audit_id": "a2", "timestamp": "2026-10-09T08:16:00Z", "kind": "platform.user.create", "user_sub": "sub-1"}, source="user_admin")
    assert "GSI2PK" not in sparse and "GSI3PK" not in sparse, "no app, no patient: not in those indexes"
    with pytest.raises(ValueError):
        am.audit_item({"audit_id": "a3", "timestamp": "t", "kind": "x"}, source="s")
    assert list(am.days_between("2026-10-07T23:00:00Z", "2026-10-09T01:00:00Z")) == ["2026-10-09", "2026-10-08", "2026-10-07"]
    assert am.kind_matches("data.cohort.by_condition", "reads") and am.kind_matches("write.fhir.observation.create", "writes") and not am.kind_matches("data.x", "writes")
    assert am.kind_matches("lifecycle.published", "lifecycle.pub") and am.kind_matches("anything", None)


def test_the_sink_writes_the_log_line_and_the_item_and_never_fails_the_request():
    lines: list[str] = []

    class Table:
        def __init__(self, fail=False):
            self.items, self.fail = [], fail

        def put_item(self, Item):  # noqa: N803
            if self.fail:
                raise RuntimeError("throttled")
            self.items.append(Item)

    table = Table()
    sink = am.AuditSink("dispatcher", table, log=lines.append)
    record = am.new_record("data.fhir.patient.read", user_sub="s", user_name="Ada", app_id="app_x", duration_ms=12.5, detail=None)
    sink.emit(record)
    assert json.loads(lines[0])["audit"]["kind"] == "data.fhir.patient.read"
    assert table.items[0]["PK"].startswith("DAY#") and str(type(table.items[0]["duration_ms"]).__name__) == "Decimal", "floats travel as decimals"
    broken = am.AuditSink("dispatcher", Table(fail=True), log=lines.append)
    broken.emit(record)  # no exception
    assert "audit_store_failed" in lines[-1] and json.loads(lines[-1])["audit_store_failed"]["audit_id"] == record["audit_id"]
    assert am.AuditSink.from_env("x", {}).__dict__["_table"] is None, "no table configured: the log line alone"


# ── the read API ──────────────────────────────────────────────────────────────────────────────


class FakeAuditTable:
    """Query on the base table (PK/SK) and on GSI1-3, BETWEEN on the sort key, newest first, Limit, ExclusiveStartKey."""

    def __init__(self, items):
        self.items = list(items)
        self.queries: list[dict] = []

    def query(self, **kwargs):
        self.queries.append(kwargs)
        names, values = kwargs["ExpressionAttributeNames"], kwargs["ExpressionAttributeValues"]
        pk_name, sk_name = names["#pk"], names["#sk"]
        rows = [i for i in self.items if i.get(pk_name) == values[":pk"] and values[":lo"] <= i.get(sk_name, "") <= values[":hi"]]
        rows.sort(key=lambda i: i[sk_name], reverse=not kwargs.get("ScanIndexForward", True))
        start = kwargs.get("ExclusiveStartKey")
        if start:
            rows = [i for i in rows if i[sk_name] < start[sk_name]]
        limit = kwargs.get("Limit") or len(rows)
        page = rows[:limit]
        out = {"Items": page}
        if len(rows) > limit:
            out["LastEvaluatedKey"] = {pk_name: page[-1][pk_name], sk_name: page[-1][sk_name]}
        return out


def rec(n: int, day: str, kind: str, user: str, app: str | None = None, patient: str | None = None, outcome: str = "ok") -> dict:
    return am.audit_item(
        {"audit_id": f"id-{n:03d}", "timestamp": f"{day}T0{n % 10}:{n % 60:02d}:00.000000Z", "kind": kind, "user_sub": user, "user_name": user.title(), "app_id": app, "patient_context": patient, "outcome": outcome, "detail": f"record {n}"},
        source="dispatcher",
    )


@pytest.fixture
def world():
    items = [
        rec(1, "2026-10-09", "data.fhir.patient.read", "ada", "app_bp", "pat-1"),
        rec(2, "2026-10-09", "write.fhir.observation.create", "ada", "app_bp", "pat-1"),
        rec(3, "2026-10-09", "data.cohort.by_condition", "bob", "app_register", None, outcome="refused"),
        rec(4, "2026-10-08", "data.fhir.patient.read", "bob", "app_bp", "pat-2"),
        rec(5, "2026-10-08", "platform.user.create", "ada", None, None),
        rec(6, "2026-10-01", "lifecycle.published", "carol", "app_bp", None),
        rec(7, "2026-09-01", "data.fhir.patient.read", "ada", "app_bp", "pat-1"),
    ]
    table = FakeAuditTable(items)
    reader = handler.AuditReader(table, now=lambda: datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc))
    return table, reader


def call(reader, params=None, groups="[medapp-admins]"):
    ev = {"routeKey": "GET /audit", "queryStringParameters": params or {}, "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "admin", "cognito:groups": groups}}}}}
    res = handler.handle(ev, reader)
    return res["statusCode"], json.loads(res["body"])


def test_administrators_only(world):
    _, reader = world
    assert call(reader, groups="[medapp-approvers medapp-authors]")[0] == 403
    assert handler.handle({"routeKey": "GET /audit", "requestContext": {}}, reader)["statusCode"] == 401
    assert call(reader)[0] == 200


def test_the_default_is_the_last_seven_days_newest_first_across_day_partitions(world):
    table, reader = world
    status, out = call(reader)
    assert status == 200 and [r["audit_id"] for r in out["records"]] == ["id-003", "id-002", "id-001", "id-005", "id-004"], "the 1 Oct and 1 Sep records are outside the window"
    assert out["cursor"] is None and out["range"]["from"] == "2026-10-02T12:00:00.000Z" and out["range"]["to"] == "2026-10-09T12:00:00.000Z"
    assert all("IndexName" not in q for q in table.queries), "no filter: the day partitions themselves"
    assert out["records"][0]["source"] == "dispatcher" and out["records"][0]["user_name"] == "Bob" and "PK" not in out["records"][0]


def test_filters_pick_the_index_and_narrow_the_rest_in_memory(world):
    table, reader = world
    status, out = call(reader, {"patient": "pat-1", "from": "2026-08-01"})
    assert [r["audit_id"] for r in out["records"]] == ["id-002", "id-001", "id-007"] and table.queries[-1]["IndexName"] == "GSI3"
    status, out = call(reader, {"user": "ada", "kind": "writes", "from": "2026-08-01"})
    assert [r["audit_id"] for r in out["records"]] == ["id-002"] and table.queries[-1]["IndexName"] == "GSI1"
    status, out = call(reader, {"app": "app_bp", "outcome": "ok", "from": "2026-09-30", "to": "2026-10-08"})
    assert [r["audit_id"] for r in out["records"]] == ["id-004", "id-006"] and table.queries[-1]["IndexName"] == "GSI2", "`to` as a date means the end of that day"
    status, out = call(reader, {"outcome": "refused"})
    assert [r["audit_id"] for r in out["records"]] == ["id-003"]
    status, out = call(reader, {"kind": "lifecycle", "from": "2026-09-01"})
    assert [r["audit_id"] for r in out["records"]] == ["id-006"]
    status, out = call(reader, {"kind": "platform"})
    assert [r["audit_id"] for r in out["records"]] == ["id-005"]
    status, out = call(reader, {"id": "id-004", "from": "2026-10-07", "to": "2026-10-09"})
    assert [r["audit_id"] for r in out["records"]] == ["id-004"], "one record by id, within the days the browser knows it was written"
    status, out = call(reader, {"id": "id-004", "patient": "pat-2", "from": "2026-10-07"})
    assert [r["audit_id"] for r in out["records"]] == ["id-004"] and table.queries[-1]["IndexName"] == "GSI3"


def test_pages_follow_the_cursor_across_days_and_on_an_index(world):
    _, reader = world
    status, page1 = call(reader, {"limit": "2"})
    assert [r["audit_id"] for r in page1["records"]] == ["id-003", "id-002"] and page1["cursor"]
    status, page2 = call(reader, {"limit": "2", "cursor": page1["cursor"]})
    assert [r["audit_id"] for r in page2["records"]] == ["id-001", "id-005"] and page2["cursor"]
    status, page3 = call(reader, {"limit": "2", "cursor": page2["cursor"]})
    assert [r["audit_id"] for r in page3["records"]] == ["id-004"] and page3["cursor"] is None
    status, page1 = call(reader, {"user": "ada", "from": "2026-08-01", "limit": "2"})
    assert [r["audit_id"] for r in page1["records"]] == ["id-002", "id-001"] and page1["cursor"]
    status, page2 = call(reader, {"user": "ada", "from": "2026-08-01", "limit": "2", "cursor": page1["cursor"]})
    assert [r["audit_id"] for r in page2["records"]] == ["id-005", "id-007"] and page2["cursor"] is None


def test_bad_requests_are_named(world):
    _, reader = world
    assert call(reader, {"from": "yesterday"})[0] == 400
    assert call(reader, {"from": "2026-10-09", "to": "2026-10-01"})[0] == 400
    assert call(reader, {"from": "2025-01-01", "to": "2026-10-01"})[0] == 400, "92 days at most"
    assert call(reader, {"outcome": "maybe"})[0] == 400
    assert call(reader, {"cursor": "not-a-cursor"})[0] == 400
    assert call(reader, {"limit": "x"})[0] == 400
    assert handler.handle({"routeKey": "POST /audit", "requestContext": {"authorizer": {"jwt": {"claims": {"sub": "a", "cognito:groups": "[medapp-admins]"}}}}}, reader)["statusCode"] == 404


# ── the stack ─────────────────────────────────────────────────────────────────────────────────


def test_the_trail_is_append_only_encrypted_recoverable_and_kept_indefinitely():
    app = cdk.App()
    stack = AuditStack(app, "AuditStack", hospital_id="hsp-test", env=cdk.Environment(account="123456789012", region="eu-central-1"))
    template = Template.from_stack(stack)
    table = next(iter(template.find_resources("AWS::DynamoDB::GlobalTable").values()))
    props = table["Properties"]
    assert props["TableName"] == "medapp-hsp-test-audit" and "TimeToLiveSpecification" not in props, "no TTL: records are kept"
    assert props["Replicas"][0]["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"] is True and props["Replicas"][0]["DeletionProtectionEnabled"] is True
    assert sorted(i["IndexName"] for i in props["GlobalSecondaryIndexes"]) == ["GSI1", "GSI2", "GSI3"]
    assert table["DeletionPolicy"] == "Retain"
    policies = {p["Properties"]["ManagedPolicyName"]: p["Properties"]["PolicyDocument"]["Statement"] for p in template.find_resources("AWS::IAM::ManagedPolicy").values()}
    writer_actions = [a for st in policies["medapp-hsp-test-audit-write"] for a in ([st["Action"]] if isinstance(st["Action"], str) else st["Action"])]
    assert "dynamodb:PutItem" in writer_actions and not any(a in writer_actions for a in ("dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem")), "writers append, nothing else"
    reader_actions = [a for st in policies["medapp-hsp-test-audit-read"] for a in ([st["Action"]] if isinstance(st["Action"], str) else st["Action"])]
    assert "dynamodb:Query" in reader_actions and "dynamodb:PutItem" not in reader_actions
