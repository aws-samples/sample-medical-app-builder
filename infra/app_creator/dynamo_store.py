"""
Drafting sessions in DynamoDB — the store behind the drafts API and the agent worker.

One item per session (PK `session_id`), the whole DraftSession as attributes, a TTL so abandoned
drafts (and the conversations in them) do not live forever, and a small GSI to list an author's
sessions. Sessions are working data; the registry is the record.
"""

from __future__ import annotations

import json
import time
from decimal import Decimal
from typing import Any, Protocol

from .session import DraftSession, now_iso

DEFAULT_TTL_DAYS = 30
AUTHOR_INDEX = "ByAuthor"


class TableLike(Protocol):
    def get_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def put_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def update_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def delete_item(self, **kwargs: Any) -> dict[str, Any]: ...
    def query(self, **kwargs: Any) -> dict[str, Any]: ...


def _plain(value: Any) -> Any:
    """boto3 returns Decimals; the session is plain JSON."""
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def _storable(value: Any) -> Any:
    """DynamoDB rejects floats and empty strings inside documents; round-trip through JSON with Decimals."""
    return json.loads(json.dumps(value, default=str), parse_float=Decimal)


class DynamoSessionStore:
    def __init__(self, table: TableLike, ttl_days: int = DEFAULT_TTL_DAYS, clock: Any = time.time):
        self._table = table
        self._ttl_days = ttl_days
        self._clock = clock

    def load(self, session_id: str) -> DraftSession | None:
        item = self._table.get_item(Key={"session_id": session_id}).get("Item")
        if not item:
            return None
        return DraftSession.from_dict(_plain(item))

    def save(self, session: DraftSession) -> None:
        session.updated_at = now_iso()
        item = _storable(session.to_dict())
        # Summary attributes projected into the author index, so listing drafts never reads specs or transcripts.
        item["title"] = session.title
        item["archetype"] = session.spec.get("archetype")
        item["turn_status"] = (session.turn or {}).get("status")
        item["expires_at"] = int(self._clock()) + self._ttl_days * 86400
        self._table.put_item(Item=item)

    def update_turn(self, session_id: str, turn: dict[str, Any]) -> None:
        """Progress from the worker without rewriting the whole session (the API may be reading it)."""
        self._table.update_item(
            Key={"session_id": session_id},
            UpdateExpression="SET turn = :turn, turn_status = :status, updated_at = :now",
            ExpressionAttributeValues={":turn": _storable(turn), ":status": turn.get("status"), ":now": now_iso()},
        )

    def delete(self, session_id: str) -> None:
        """Remove a conversation for good (the API checks it is the author's and unsaved)."""
        self._table.delete_item(Key={"session_id": session_id})

    def list_for_author(self, author_sub: str, limit: int = 50) -> list[dict[str, Any]]:
        """Newest first; summary attributes only."""
        res = self._table.query(
            IndexName=AUTHOR_INDEX,
            KeyConditionExpression="author_sub = :a",
            ExpressionAttributeValues={":a": author_sub},
            ScanIndexForward=False,
            Limit=limit,
            ProjectionExpression="session_id, title, archetype, updated_at, created_at, turn_status, saved_as",
        )
        return [
            {
                "session_id": item["session_id"],
                "title": item.get("title") or "Untitled draft",
                "archetype": item.get("archetype"),
                "updated_at": item.get("updated_at"),
                "created_at": item.get("created_at"),
                "turn_status": item.get("turn_status"),
                "saved_as": item.get("saved_as"),
            }
            for item in (_plain(i) for i in res.get("Items", []))
        ]
