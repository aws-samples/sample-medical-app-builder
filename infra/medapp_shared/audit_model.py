"""
The audit trail as a table: every data access and every write the dispatcher performs, every account change an
administrator makes, every lifecycle step of an app — one record each, kept indefinitely (the hospital's retention
policy can add a TTL later; nothing here removes a record). The records were always produced (each Lambda prints
them to its log); this is the store the panel's Audit trail reads and the one an auditor can query by day, person,
app or patient.

Layout (`stacks/audit_stack.py`):
    PK   DAY#<yyyy-mm-dd>        SK   <timestamp>#<audit_id>     the day's records, newest last → read backwards
    GSI1 USER#<sub>              GSI1SK <timestamp>#<audit_id>  by person
    GSI2 APP#<app_id>            GSI2SK                          by app (records with an app)
    GSI3 PATIENT#<patient_id>    GSI3SK                          by patient (records with a patient in context)
Writers may only PutItem (an append-only policy); readers Query. Writing is fail-open: a store that is down costs the
indexed copy, not the clinician's request — the log line remains, and the failure is itself logged.

Record fields every source fills: audit_id, timestamp (ISO, UTC), kind (`data.*`, `write.*`, `platform.*`,
`lifecycle.*`), user_sub, user_name, user_email, outcome (ok | refused | error), detail. The dispatcher adds app_id,
manifest_version, primitive_id, role, role_source, patient_context, duration_ms, result_summary, hashes; user
administration adds the account changed and the groups; lifecycle records the app, version and the step.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping

KEY_ATTRIBUTES = ("PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK", "GSI3PK", "GSI3SK")

KIND_GROUPS: dict[str, tuple[str, ...]] = {
    "reads": ("data.",),
    "writes": ("write.",),
    "platform": ("platform.",),
    "lifecycle": ("lifecycle.",),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_record(kind: str, *, user_sub: str, user_name: str | None = None, user_email: str | None = None, outcome: str = "ok", **fields: Any) -> dict[str, Any]:
    """A record with the fields every source fills, in the shape the table and the panel expect."""
    record: dict[str, Any] = {"audit_id": str(uuid.uuid4()), "timestamp": now_iso(), "kind": kind, "user_sub": user_sub, "outcome": outcome}
    if user_name:
        record["user_name"] = user_name
    if user_email:
        record["user_email"] = user_email
    record.update({k: v for k, v in fields.items() if v is not None})
    return record


def day_of(timestamp: str) -> str:
    return timestamp[:10]


def sort_key(record: Mapping[str, Any]) -> str:
    return f"{record['timestamp']}#{record['audit_id']}"


def audit_item(record: Mapping[str, Any], *, source: str) -> dict[str, Any]:
    """The table item for a record: the record itself plus the keys that make it findable by day, person, app and patient."""
    for required in ("audit_id", "timestamp", "kind", "user_sub"):
        if not record.get(required):
            raise ValueError(f"an audit record needs {required}")
    sk = sort_key(record)
    item: dict[str, Any] = {k: v for k, v in record.items() if v is not None and k not in KEY_ATTRIBUTES}
    item["source"] = source
    item["PK"] = f"DAY#{day_of(str(record['timestamp']))}"
    item["SK"] = sk
    item["GSI1PK"] = f"USER#{record['user_sub']}"
    item["GSI1SK"] = sk
    if record.get("app_id"):
        item["GSI2PK"] = f"APP#{record['app_id']}"
        item["GSI2SK"] = sk
    patient = record.get("patient_context") or record.get("patient_id")
    if patient:
        item["GSI3PK"] = f"PATIENT#{patient}"
        item["GSI3SK"] = sk
    return item


def present(item: Mapping[str, Any]) -> dict[str, Any]:
    """An item back to a record: the keys stripped, everything else as stored."""
    return {k: v for k, v in item.items() if k not in KEY_ATTRIBUTES}


def kind_matches(kind: str, group: str | None) -> bool:
    if not group:
        return True
    return any(kind.startswith(prefix) for prefix in KIND_GROUPS.get(group, (group,)))


class AuditSink:
    """
    Where a Lambda sends its records: the log line it always wrote, and — when a table is configured — the item.
    Fail-open on the table: the request a record describes has happened; losing the indexed copy is logged, never
    turned into an error the clinician sees.
    """

    def __init__(self, source: str, table: Any | None = None, log: Callable[[str], None] = print):
        self._source = source
        self._table = table
        self._log = log

    def emit(self, record: Mapping[str, Any]) -> None:
        self._log(json.dumps({"audit": record}, default=str))
        if self._table is None:
            return
        try:
            self._table.put_item(Item=_dynamo_safe(audit_item(record, source=self._source)))
        except Exception as err:  # noqa: BLE001 — the trail must not break the request it describes
            # Fail-open by design (docs/audit.md): the log line above is the complete record; a deployment that wants
            # "no access without its audit record" re-raises here and lets the dispatcher refuse.
            self._log(json.dumps({"audit_store_failed": {"audit_id": record.get("audit_id"), "error": f"{type(err).__name__}: {err}"[:300]}}))

    @classmethod
    def from_env(cls, source: str, environ: Mapping[str, str], boto3_module: Any | None = None) -> "AuditSink":
        name = environ.get("AUDIT_TABLE_NAME")
        if not name:
            return cls(source)
        if boto3_module is None:
            import boto3  # local import keeps unit tests free of the SDK

            boto3_module = boto3
        return cls(source, boto3_module.resource("dynamodb").Table(name))


def _dynamo_safe(value: Any) -> Any:
    """Floats are not DynamoDB numbers; durations and the like travel as Decimal-compatible values."""
    from decimal import Decimal

    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _dynamo_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_dynamo_safe(v) for v in value]
    return value


def days_between(start: str, end: str) -> Iterable[str]:
    """The UTC days from `start` to `end` (ISO timestamps or dates), newest first — the partitions a time-range query reads."""
    from datetime import date, timedelta

    first = date.fromisoformat(start[:10])
    last = date.fromisoformat(end[:10])
    day = last
    while day >= first:
        yield day.isoformat()
        day -= timedelta(days=1)
