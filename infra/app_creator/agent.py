"""
One drafting turn, independent of where it runs. `Drafter.turn()` takes a session and the user's
message, runs the agent with tools bound to the session's draft, and returns the reply together with
the updated session. A Lambda handler, an AgentCore entry point and the terminal harness all call
exactly this.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from strands import Agent
from strands.models.model import Model
from strands.tools.executors import SequentialToolExecutor

from .catalog import Catalog
from .draft import Draft
from .groups import GroupDirectory, StaticGroups
from .manifest_service import ManifestService
from .shapes import ShapeLibrary
from .language import conversation_language, language_instruction
from .prompts import build_system_prompt, draft_state_block
from .session import DraftSession, trim_tool_results
from .tools import ToolObserver, make_tools


@dataclass
class TurnResult:
    reply: str
    session: DraftSession
    open: list[dict[str, str]] = field(default_factory=list)
    tool_calls: list[str] = field(default_factory=list)
    stop_reason: str = ""


def _text_of(message: dict[str, Any]) -> str:
    return "".join(block.get("text", "") for block in message.get("content", []) if isinstance(block, dict) and "text" in block).strip()


def _reply_text(new_messages: list[dict[str, Any]]) -> str:
    """Everything the assistant said this turn — models often explain (e.g. why something is refused)
    in the same message as a tool call, before the final answer; the user must see both."""
    parts = [_text_of(m) for m in new_messages if m.get("role") == "assistant"]
    return "\n\n".join(p for p in parts if p)


class Drafter:
    def __init__(
        self,
        model: Model | str,
        catalog: Catalog,
        service: ManifestService | None,
        hospital_id: str,
        hospital_name: str,
        groups: GroupDirectory | None = None,
        shapes: ShapeLibrary | None = None,
    ):
        self._model = model
        self._catalog = catalog
        self._service = service
        self._hospital_id = hospital_id
        self._hospital_name = hospital_name
        self._groups = groups or StaticGroups()
        self._shapes = shapes
        self._system_prompt = build_system_prompt(catalog, hospital_name, hospital_id)
        self._prompt_vocabulary = catalog.vocabulary

    @property
    def system_prompt(self) -> str:
        # The record's vocabulary section follows the document the catalog holds now (the worker reloads it hourly).
        if self._catalog.vocabulary is not self._prompt_vocabulary:
            self._system_prompt = build_system_prompt(self._catalog, self._hospital_name, self._hospital_id)
            self._prompt_vocabulary = self._catalog.vocabulary
        return self._system_prompt

    def prompt_for(self, session: DraftSession, user_text: str, draft: Draft | None = None) -> str:
        """
        The system prompt for one turn: the catalog-derived base, the author's language stated as an instruction and —
        when the draft already describes something, a spec seeded from an existing app above all — the draft's state.
        """
        session.language = conversation_language(user_text, session.language)
        parts = [self.system_prompt, language_instruction(session.language)]  # type: ignore[arg-type]
        if session.spec:
            draft = draft or Draft(self._catalog, spec=session.spec, events=session.events, refusals=session.refusals)
            parts.append(draft_state_block(session.spec, session.iterates, [i.as_dict() for i in draft.open_items()]))
        return "\n\n".join(parts)

    def turn(self, session: DraftSession, user_text: str, on_tool: ToolObserver | None = None) -> TurnResult:
        draft = Draft(self._catalog, spec=session.spec, events=session.events, refusals=session.refusals)
        tools = make_tools(draft, self._catalog, self._service, self._groups, self._hospital_id, on_tool=on_tool, shapes=self._shapes)
        agent = Agent(model=self._model, system_prompt=self.prompt_for(session, user_text, draft), tools=tools, messages=list(session.messages), callback_handler=None, tool_executor=SequentialToolExecutor())
        before = len(agent.messages)
        result = agent(user_text)

        new_messages = agent.messages[before:]
        calls = [block["toolUse"]["name"] for m in new_messages if m.get("role") == "assistant" for block in m.get("content", []) if isinstance(block, dict) and "toolUse" in block]

        session.messages = trim_tool_results([dict(m) for m in agent.messages])
        session.spec = draft.spec
        session.events = draft.events
        session.refusals = draft.refusals
        return TurnResult(reply=_reply_text(new_messages) or _text_of(result.message), session=session, open=[i.as_dict() for i in draft.open_items()], tool_calls=calls, stop_reason=str(result.stop_reason))
