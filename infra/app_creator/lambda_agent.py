"""
The agent worker — invoked asynchronously by the drafts API for one turn.

    event: { "session_id": "...", "turn_id": "..." }

Loads the session, runs `Drafter.turn`, and writes the outcome into `session.turn`
(queued → running → done | failed), reporting each tool call as progress on the way so the panel can
show "looking up codes… adding a role…". Nothing else changes between the terminal harness and this
handler; the Drafter is the same object.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .agent import Drafter
from .catalog import Catalog
from .dynamo_store import DynamoSessionStore
from .groups import CognitoGroups, GroupDirectory, StaticGroups
from .lambda_manifest_service import LambdaManifestService
from .manifest_service import ManifestService
from .shapes import RegistryShapes, ShapeLibrary
from .session import DraftSession, SessionStore, now_iso
from .vocabulary import VocabularyRefresher, vocabulary_from_env

log = logging.getLogger("app_creator.worker")
log.setLevel(logging.INFO)


class TurnWorker:
    def __init__(self, drafter: Drafter, store: SessionStore, progress: Any = None, refresh: Any = None):
        self._drafter = drafter
        self._store = store
        self._progress = progress  # callable(session_id, turn) → None; DynamoSessionStore.update_turn in production
        self._refresh = refresh  # callable() → bool; reloads the record vocabulary when it is stale (VocabularyRefresher)

    def _report(self, session: DraftSession) -> None:
        if self._progress is not None and session.turn is not None:
            try:
                self._progress(session.session_id, session.turn)
            except Exception:  # noqa: BLE001
                log.exception("progress update failed")

    def run(self, session_id: str, turn_id: str) -> dict[str, Any]:
        session = self._store.load(session_id)
        if session is None:
            return {"status": "ignored", "reason": "no such session"}
        turn = session.turn or {}
        if turn.get("id") != turn_id:
            return {"status": "ignored", "reason": "turn superseded"}
        if turn.get("status") != "queued":
            return {"status": "ignored", "reason": f"turn is {turn.get('status')}"}

        turn["status"] = "running"
        turn["progress"] = []
        self._report(session)
        if self._refresh is not None:
            try:
                if self._refresh():
                    log.info("record vocabulary reloaded")
            except Exception:  # noqa: BLE001 — a stale vocabulary is no reason to fail the turn
                log.exception("record vocabulary refresh failed")

        def on_tool(name: str) -> None:
            turn["progress"].append(name)
            self._report(session)

        try:
            result = self._drafter.turn(session, str(turn.get("message", "")), on_tool=on_tool)
            turn.update(status="done", reply=result.reply, tool_calls=result.tool_calls, open=result.open, finished_at=now_iso())
            result.session.turn = turn
            self._store.save(result.session)
            return {"status": "done", "tool_calls": result.tool_calls}
        except Exception as e:  # noqa: BLE001 — the user sees a clean failure, the log sees the details
            log.exception("turn failed")
            turn.update(status="failed", error=f"{e.__class__.__name__}: {e}"[:300], finished_at=now_iso())
            session.turn = turn
            self._store.save(session)
            return {"status": "failed", "error": turn["error"]}


# ── Lambda wiring ──────────────────────────────────────────────────────────────

_worker: TurnWorker | None = None


def _groups_from_env() -> GroupDirectory:
    pool = os.environ.get("USER_POOL_ID")
    return CognitoGroups(pool) if pool else StaticGroups([])


def _service_from_env() -> ManifestService | None:
    fn = os.environ.get("MANIFEST_FUNCTION_NAME")
    return LambdaManifestService(fn) if fn else None


def _shapes_from_env() -> ShapeLibrary | None:
    """The record-shape library: the registry table (REGISTRY_TABLE_NAME, read through the registry read policy); none without it."""
    table = os.environ.get("REGISTRY_TABLE_NAME")
    return RegistryShapes(table) if table else None


def _get_worker() -> TurnWorker:
    global _worker
    if _worker is None:
        import boto3  # local import keeps unit tests free of the SDK
        from strands.models import BedrockModel

        table = boto3.resource("dynamodb").Table(os.environ["DRAFTS_TABLE"])
        store = DynamoSessionStore(table)
        # Always set by the AuthoringStack (cdk.json `model_id`); a missing value is a deployment error, not a
        # reason to run on whatever the library defaults to.
        model_kwargs: dict[str, Any] = {"model_id": os.environ["MODEL_ID"]}
        # The record's vocabulary (RECORD_VOCABULARY_BUCKET, written by the data source's seed) — empty until the seed
        # has run, reloaded hourly, retried every five minutes while empty.
        catalog = Catalog.load(vocabulary=vocabulary_from_env())
        drafter = Drafter(
            BedrockModel(**model_kwargs),
            catalog,
            _service_from_env(),
            hospital_id=os.environ["HOSPITAL_ID"],
            hospital_name=os.environ.get("HOSPITAL_NAME", os.environ["HOSPITAL_ID"]),
            groups=_groups_from_env(),
            shapes=_shapes_from_env(),
        )
        refresh = VocabularyRefresher(catalog, vocabulary_from_env) if os.environ.get("RECORD_VOCABULARY_BUCKET") else None
        _worker = TurnWorker(drafter, store, progress=store.update_turn, refresh=refresh)
    return _worker


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return _get_worker().run(str(event.get("session_id", "")), str(event.get("turn_id", "")))
