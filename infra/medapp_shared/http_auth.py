"""
Who is calling — from the JWT claims the HTTP API authorizer attaches to every event. Shared by the
Lambdas behind the API so they parse groups identically (the authorizer renders array claims as
"[a b]", a JSON list, or a comma/space separated string depending on the path they took).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .identity_model import GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS, can_author, is_admin

STAFF_GROUPS = frozenset({GROUP_ADMINS, GROUP_APPROVERS, GROUP_AUTHORS})


@dataclass(frozen=True)
class Caller:
    sub: str
    groups: tuple[str, ...]
    email: str | None = None
    display: str | None = None

    @property
    def is_staff(self) -> bool:
        return bool(STAFF_GROUPS & set(self.groups))

    @property
    def is_admin(self) -> bool:
        return is_admin(self.groups)

    @property
    def may_author(self) -> bool:
        return can_author(self.groups)


def parse_groups(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(g) for g in raw]
    text = str(raw).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [g.strip().strip('"') for g in re.split(r"[\s,]+", text) if g.strip()]


def caller_from_event(event: dict[str, Any]) -> Caller:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {}) or {}
    display = claims.get("name") or " ".join(p for p in (claims.get("given_name"), claims.get("family_name")) if p) or claims.get("email")
    return Caller(
        sub=str(claims.get("sub", "")),
        groups=tuple(parse_groups(claims.get("cognito:groups"))),
        email=str(claims["email"]) if claims.get("email") else None,
        display=str(display) if display else None,
    )


def json_body(event: dict[str, Any]) -> dict[str, Any]:
    """The request body as a dict; raises ValueError when it is not a JSON object."""
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode("utf-8")
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object.")
    return body


def response(status: int, body: Any) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store"}, "body": json.dumps(body, default=str, ensure_ascii=False)}
