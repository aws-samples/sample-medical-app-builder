"""
Which groups exist in the hospital's user pool — so a role can be bound to a real group instead of
one the model made up. Platform groups (medapp-*) and per-app groups (app-*) are filtered out: the
former are not clinical roles, the latter belong to other apps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class GroupInfo:
    name: str
    description: str = ""


class GroupDirectory(Protocol):
    def list_groups(self) -> list[GroupInfo]: ...


def is_bindable(name: str) -> bool:
    return not (name.startswith("medapp-") or name.startswith("app-"))


class StaticGroups:
    """A fixed list — for tests, or an explicitly requested demo. Never the default where a real pool exists."""

    def __init__(self, groups: list[GroupInfo] | None = None):
        self._groups = groups or []

    def list_groups(self) -> list[GroupInfo]:
        return [g for g in self._groups if is_bindable(g.name)]


def known_group(groups: GroupDirectory, name: str) -> bool:
    return any(g.name == name for g in groups.list_groups())


def discover_user_pool_id(hospital_id: str, ssm_client: Any | None = None) -> str:
    """The deployed pool, from the SSM parameter IdentityStack publishes — the same lookup scripts/create-user.sh uses."""
    client = ssm_client
    if client is None:
        import boto3  # local import keeps unit tests free of the SDK

        client = boto3.client("ssm")
    return str(client.get_parameter(Name=f"/medapp/{hospital_id}/identity/user-pool-id")["Parameter"]["Value"])


class CognitoGroups:
    """Live list from the pool (needs cognito-idp:ListGroups — the identity provisioning policy grants it)."""

    def __init__(self, user_pool_id: str, client: Any | None = None):
        self._pool = user_pool_id
        self._client = client

    @classmethod
    def for_hospital(cls, hospital_id: str) -> "CognitoGroups":
        return cls(discover_user_pool_id(hospital_id))

    def list_groups(self) -> list[GroupInfo]:
        client = self._client
        if client is None:
            import boto3  # local import keeps unit tests free of the SDK

            client = boto3.client("cognito-idp")
        out: list[GroupInfo] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"UserPoolId": self._pool, "Limit": 60}
            if token:
                kwargs["NextToken"] = token
            page = client.list_groups(**kwargs)
            for g in page.get("Groups", []):
                if is_bindable(g["GroupName"]):
                    out.append(GroupInfo(name=g["GroupName"], description=g.get("Description", "")))
            token = page.get("NextToken")
            if not token:
                return out
