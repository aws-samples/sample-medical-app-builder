"""
A scripted stand-in for the language model, so the whole drafting loop — tool dispatch, draft
mutation, readiness, session persistence — runs in tests without Bedrock. Each scripted turn is a
list of content blocks the "model" answers with; tool results the agent feeds back are recorded.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, AsyncIterable
from typing import Any

from strands.models.model import Model


def text(t: str) -> dict[str, Any]:
    return {"text": t}


def use(tool_name: str, /, **tool_input: Any) -> dict[str, Any]:
    return {"toolUse": {"name": tool_name, "input": tool_input}}


class ScriptedModel(Model):
    def __init__(self, turns: list[list[dict[str, Any]]]):
        self._turns = [list(t) for t in turns]
        self.calls: list[dict[str, Any]] = []  # what the agent sent each time: messages, tool names, system prompt
        self._n = 0

    def get_config(self) -> dict[str, Any]:  # type: ignore[override]
        return {"model_id": "scripted"}

    def update_config(self, **model_config: Any) -> None:  # type: ignore[override]
        return None

    async def structured_output(self, output_model: Any, prompt: Any, system_prompt: str | None = None, **kwargs: Any) -> AsyncGenerator[dict[str, Any], None]:  # type: ignore[override]
        raise NotImplementedError("scripted model has no structured output")
        yield {}  # pragma: no cover

    async def stream(self, messages: list[Any], tool_specs: list[Any] | None = None, system_prompt: str | None = None, **kwargs: Any) -> AsyncIterable[dict[str, Any]]:  # type: ignore[override]
        self.calls.append({"messages": json.loads(json.dumps(messages, default=str)), "tools": [t["name"] for t in tool_specs or []], "system_prompt": system_prompt})
        if not self._turns:
            blocks: list[dict[str, Any]] = [text("(script exhausted)")]
        else:
            blocks = self._turns.pop(0)
        self._n += 1
        yield {"messageStart": {"role": "assistant"}}
        used_tool = False
        for i, block in enumerate(blocks):
            if "toolUse" in block:
                used_tool = True
                tu = block["toolUse"]
                yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"tool-{self._n}-{i}", "name": tu["name"]}}, "contentBlockIndex": i}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tu.get("input", {}))}}, "contentBlockIndex": i}}
            else:
                yield {"contentBlockDelta": {"delta": {"text": block["text"]}, "contentBlockIndex": i}}
            yield {"contentBlockStop": {"contentBlockIndex": i}}
        yield {"messageStop": {"stopReason": "tool_use" if used_tool else "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}, "metrics": {"latencyMs": 0}}}

    def tool_results(self) -> list[dict[str, Any]]:
        """Every toolResult block the agent has fed back so far, in order."""
        out = []
        for call in self.calls:
            for m in call["messages"]:
                for block in m.get("content", []):
                    if isinstance(block, dict) and "toolResult" in block:
                        out.append(block["toolResult"])
        return out
