"""
A drafting session: the draft (spec, events, refusals) and the conversation so far. Persisted between
turns so the runtime can be a Lambda per message, a page reload lands on the same draft, and a form
edit in the panel and a chat turn change the same record. Stores: in memory (tests), files (the
terminal harness); DynamoDB comes with the API.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


_now = now_iso


TURN_STATES = ("queued", "running", "done", "failed")


# Longer than the agent worker may run (its Lambda timeout is five minutes) plus queueing: a turn older than this never
# finishes — the worker is gone — and is shown as failed instead of keeping the draft busy.
TURN_TIMEOUT_S = 10 * 60


@dataclass
class DraftSession:
    session_id: str
    hospital_id: str
    author_sub: str = ""
    spec: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    refusals: list[dict[str, Any]] = field(default_factory=list)
    # The model conversation in Strands' message format, so the next turn continues where this one stopped.
    messages: list[dict[str, Any]] = field(default_factory=list)
    # The turn in flight (or the last one): the API answers 202 and the worker fills this in —
    # {id, status, message, progress: [tool names so far], reply, tool_calls, started_at, finished_at, error}.
    turn: dict[str, Any] | None = None
    # Set once the draft has been saved to the registry: the app it became.
    saved_as: dict[str, Any] | None = None
    # Set when the draft iterates on an existing app ({app_id, version}): saving creates a new version of it.
    iterates: dict[str, Any] | None = None
    # The language the conversation is held in ("en" | "de"), decided from the author's messages (language.py).
    language: str | None = None
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    @classmethod
    def new(cls, hospital_id: str, author_sub: str = "") -> "DraftSession":
        return cls(session_id=uuid.uuid4().hex[:16], hospital_id=hospital_id, author_sub=author_sub)

    @property
    def title(self) -> str:
        return str((self.spec.get("app") or {}).get("name") or "Untitled draft")

    @property
    def turn_busy(self) -> bool:
        return bool(self.turn) and self.turn.get("status") in ("queued", "running") and not self.turn_stale  # type: ignore[union-attr]

    @property
    def turn_stale(self) -> bool:
        """A turn still queued or running long after the worker's own timeout: the worker died without a word (a hard
        Lambda timeout skips the error path). It must not keep the draft busy — and the panel polling — forever."""
        if not self.turn or self.turn.get("status") not in ("queued", "running"):
            return False
        started = str(self.turn.get("started_at") or "")
        try:
            at = datetime.fromisoformat(started.replace("Z", "+00:00"))
        except ValueError:
            return True  # no usable start time: nothing to wait for
        return (datetime.now(timezone.utc) - at).total_seconds() > TURN_TIMEOUT_S

    def presented_turn(self) -> dict[str, Any] | None:
        """The turn as the panel should see it: a stale one as failed, with a reason the author can act on."""
        if self.turn and self.turn_stale:
            return {**self.turn, "status": "failed", "error": "The assistant did not answer in time. Send the message again.", "finished_at": _now()}
        return self.turn

    def begin_turn(self, message: str) -> dict[str, Any]:
        self.turn = {"id": uuid.uuid4().hex[:12], "status": "queued", "message": message, "progress": [], "started_at": _now()}
        return self.turn

    def transcript(self) -> list[dict[str, str]]:
        """User and assistant text only — no tool blocks — for display."""
        out: list[dict[str, str]] = []
        for m in self.messages:
            text = "".join(b.get("text", "") for b in m.get("content", []) if isinstance(b, dict) and "text" in b).strip()
            if text:
                out.append({"role": str(m.get("role")), "text": text})
        return out

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DraftSession":
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def trim_tool_results(messages: list[dict[str, Any]], keep_last: int = 6, max_chars: int = 400) -> list[dict[str, Any]]:
    """
    Keep the conversation small: tool results older than the last `keep_last` are shortened to a note.
    The message structure (toolUse ↔ toolResult pairing) is untouched, so the model still sees a valid
    history; it just no longer carries every knob schema it was ever shown.
    """
    seen = 0
    out: list[dict[str, Any]] = []
    for m in reversed(messages):
        blocks = []
        for block in m.get("content", []):
            if isinstance(block, dict) and "toolResult" in block:
                seen += 1
                if seen > keep_last:
                    tr = dict(block["toolResult"])
                    text_blocks = [c.get("text", "") for c in tr.get("content", []) if isinstance(c, dict) and "text" in c]
                    joined = "".join(text_blocks)
                    if len(joined) > max_chars:
                        tr["content"] = [{"text": joined[:max_chars] + " …[earlier tool result trimmed]"}]
                    block = {**block, "toolResult": tr}
            blocks.append(block)
        out.append({**m, "content": blocks})
    out.reverse()
    return out


class SessionStore(Protocol):
    def load(self, session_id: str) -> DraftSession | None: ...
    def save(self, session: DraftSession) -> None: ...


class InMemorySessionStore:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}

    def load(self, session_id: str) -> DraftSession | None:
        data = self._items.get(session_id)
        return DraftSession.from_dict(json.loads(json.dumps(data))) if data else None

    def save(self, session: DraftSession) -> None:
        session.updated_at = _now()
        self._items[session.session_id] = json.loads(json.dumps(session.to_dict(), default=str))


class FileSessionStore:
    def __init__(self, directory: Path):
        self._dir = Path(directory)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, session_id: str) -> Path:
        return self._dir / f"{session_id}.json"

    def load(self, session_id: str) -> DraftSession | None:
        p = self._path(session_id)
        return DraftSession.from_dict(json.loads(p.read_text(encoding="utf-8"))) if p.exists() else None

    def save(self, session: DraftSession) -> None:
        session.updated_at = _now()
        self._path(session.session_id).write_text(json.dumps(session.to_dict(), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
