"""
Audit trail read API — Lambda behind API Gateway (HTTP API, Cognito JWT authorizer), administrators only.

    GET /audit?from=<iso>&to=<iso>&user=<sub>&app=<app_id>&patient=<id>&kind=<group|prefix>&outcome=<ok|refused|error>&id=<audit_id>&limit=<n>&cursor=<c>
        → 200 { records: [Record], cursor: <c> | null, range: { from, to } }

Newest first. The time range defaults to the last seven days and is capped at 92 days per query. Each filter narrows;
the most selective one chooses the index the query runs on — a patient's trail, a person's, an app's — and the day
partitions are read, newest day first, when none is given. The rest is applied as the items come back, so a page may
be shorter than `limit` without being the last: the cursor says. `id` names one record — what the panel asks for when
an app's inspector row is opened in the trail (the browser knows the record's id and roughly when it was written).

Records are what the Lambdas wrote (medapp_shared/audit_model.py): a data access or write by the dispatcher with its
app, version, role and patient context; an account change by an administrator; a lifecycle step of an app.
`AuditReader` is pure Python over a boto3-shaped Table so it can be unit-tested with a fake.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from medapp_shared.audit_model import KIND_GROUPS, days_between, kind_matches, present
from medapp_shared.http_auth import caller_from_event, response

MAX_RANGE_DAYS = 92
DEFAULT_RANGE_DAYS = 7
MAX_LIMIT = 200
DEFAULT_LIMIT = 50
OUTCOMES = ("ok", "refused", "error")


class BadRequest(Exception):
    pass


def _iso(value: str, *, end: bool = False) -> str:
    """An ISO timestamp or date, normalised to UTC `…Z`; a bare date is the start (or the end) of that day."""
    text = value.strip()
    if not text:
        raise BadRequest("an empty time is not a time")
    try:
        if len(text) == 10:
            day = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            return (day + timedelta(days=1) - timedelta(milliseconds=1) if end else day).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as err:
        raise BadRequest(f"not a time: {value!r}") from err
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _encode_cursor(state: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":"), default=str).encode("utf-8")).decode("ascii")


def _decode_cursor(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(text.encode("ascii")).decode("utf-8"))
    except Exception as err:  # noqa: BLE001 — anything malformed is a bad cursor
        raise BadRequest("the cursor is not one this API issued") from err


class AuditReader:
    def __init__(self, table: Any, now: Any = None):
        self._table = table
        self._now = now or (lambda: datetime.now(timezone.utc))

    def query(self, params: dict[str, Any]) -> dict[str, Any]:
        now = self._now()
        to = _iso(str(params["to"]), end=True) if params.get("to") else now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        start = _iso(str(params["from"])) if params.get("from") else (datetime.fromisoformat(to.replace("Z", "+00:00")) - timedelta(days=DEFAULT_RANGE_DAYS)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if start > to:
            raise BadRequest("`from` is after `to`")
        if (datetime.fromisoformat(to.replace("Z", "+00:00")) - datetime.fromisoformat(start.replace("Z", "+00:00"))).days > MAX_RANGE_DAYS:
            raise BadRequest(f"a query covers at most {MAX_RANGE_DAYS} days; narrow the range")
        try:
            limit = max(1, min(int(params.get("limit") or DEFAULT_LIMIT), MAX_LIMIT))
        except ValueError as err:
            raise BadRequest("limit must be a number") from err
        outcome = str(params.get("outcome") or "") or None
        if outcome and outcome not in OUTCOMES:
            raise BadRequest(f"outcome must be one of {', '.join(OUTCOMES)}")
        kind = str(params.get("kind") or "") or None
        user, app, patient, record_id = (str(params.get(k) or "") or None for k in ("user", "app", "patient", "id"))
        cursor = _decode_cursor(params.get("cursor"))

        def keep(record: dict[str, Any]) -> bool:
            if record_id and record.get("audit_id") != record_id:
                return False
            if user and record.get("user_sub") != user:
                return False
            if app and record.get("app_id") != app:
                return False
            if patient and (record.get("patient_context") or record.get("patient_id")) != patient:
                return False
            if outcome and record.get("outcome", "ok") != outcome:
                return False
            return kind_matches(str(record.get("kind", "")), kind)

        records: list[dict[str, Any]] = []
        next_cursor: str | None = None
        # The most selective index: a patient's trail, else a person's, else an app's, else the days themselves.
        if patient or user or app:
            index, pk = ("GSI3", f"PATIENT#{patient}") if patient else ("GSI1", f"USER#{user}") if user else ("GSI2", f"APP#{app}")
            page = self._page(index, pk, f"{index}SK", start, to, limit, cursor.get("key") if cursor else None)
            records = [r for r in page["items"] if keep(r)]
            if page.get("last_key"):
                next_cursor = _encode_cursor({"key": page["last_key"]})
        else:
            days = list(days_between(start, to))
            day_cursor = cursor.get("day") if cursor else None
            last_key = cursor.get("key") if cursor else None
            if day_cursor and day_cursor in days:
                days = days[days.index(day_cursor) :]
            for i, day in enumerate(days):
                want = limit - len(records)
                if want <= 0:
                    next_cursor = _encode_cursor({"day": day, "key": None})
                    break
                page = self._page(None, f"DAY#{day}", "SK", start, to, want, last_key if day == day_cursor else None)
                records.extend(r for r in page["items"] if keep(r))
                if page.get("last_key"):
                    next_cursor = _encode_cursor({"day": day, "key": page["last_key"]})
                    break
                if i == len(days) - 1:
                    next_cursor = None
        return {"records": records, "cursor": next_cursor, "range": {"from": start, "to": to}}

    def _page(self, index: str | None, pk: str, sk_name: str, start: str, to: str, limit: int, exclusive_start: dict[str, Any] | None) -> dict[str, Any]:
        pk_name = f"{index}PK" if index else "PK"
        kwargs: dict[str, Any] = {
            "KeyConditionExpression": "#pk = :pk AND #sk BETWEEN :lo AND :hi",
            "ExpressionAttributeNames": {"#pk": pk_name, "#sk": sk_name},
            "ExpressionAttributeValues": {":pk": pk, ":lo": start, ":hi": f"{to}#\uffff"},
            "ScanIndexForward": False,
            "Limit": limit,
        }
        if index:
            kwargs["IndexName"] = index
        if exclusive_start:
            kwargs["ExclusiveStartKey"] = exclusive_start
        page = self._table.query(**kwargs)
        return {"items": [present(i) for i in page.get("Items", [])], "last_key": page.get("LastEvaluatedKey")}


# ── HTTP ──────────────────────────────────────────────────────────────────────────────────────


def handle(event: dict[str, Any], reader: AuditReader) -> dict[str, Any]:
    caller = caller_from_event(event)
    if not caller.sub:
        return response(401, {"message": "No authenticated caller."})
    if not caller.is_admin:
        return response(403, {"message": "The audit trail is for administrators (medapp-admins)."})
    if event.get("routeKey") != "GET /audit":
        return response(404, {"message": f"Unknown route {event.get('routeKey')}"})
    params = event.get("queryStringParameters") or {}
    try:
        return response(200, reader.query(params))
    except BadRequest as err:
        return response(400, {"message": str(err)})


_reader: AuditReader | None = None


def _get_reader() -> AuditReader:
    global _reader
    if _reader is None:
        import boto3

        _reader = AuditReader(boto3.resource("dynamodb").Table(os.environ["AUDIT_TABLE_NAME"]))
    return _reader


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_reader())
