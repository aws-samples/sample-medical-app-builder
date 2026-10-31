"""
User administration API — Lambda behind API Gateway (HTTP API, Cognito JWT authorizer), admins only.

    GET   /users?search=<email prefix>        → 200 { users: [User], truncated }
    GET   /users/groups                       → 200 { groups: [ {name, description, kind: platform|app|hospital} ] }
    POST  /users                              → 201 User      { email, given_name?, family_name?, groups? }  creates + invites
    PATCH /users/{username}                   → 200 User      { enabled?, add_groups?, remove_groups? }
    POST  /users/{username}/invitation        → 200 User      re-sends the invitation while the first sign-in is pending

A User is { username, sub, email, given_name, family_name, name, enabled, status, groups, created_at, updated_at }.

The pool is the hospital's single Cognito user pool (infra/docs/identity.md): email is the username, accounts are
admin-created (self sign-up is off) and the invitation email carries the temporary password, so "registering" a
user here is exactly what scripts/create-user.sh does from a terminal — now from the panel, by an administrator,
with the groups chosen in the same step. Access is a matter of groups: the four platform groups (medapp-*), the
per-app role groups `app-{app_id}-{role}` created at publish time, and whatever groups the hospital already has.
Disabling an account (`AdminDisableUser`) ends its access at the next token refresh and keeps its history; nothing
here deletes a user.

Two guards keep an administrator from locking everyone out: a caller may not disable their own account nor leave
`medapp-admins` themselves. Every change is an audit record in this function's log (`kind: platform.user.*`), with
the acting administrator and the account changed — Cognito's own CloudTrail entries are the second copy.

`UserAdmin` is pure Python over a boto3-shaped client so it can be unit-tested with a fake.
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable

from medapp_shared.audit_model import AuditSink, new_record
from medapp_shared.http_auth import Caller, caller_from_event, json_body, response
from medapp_shared.identity_model import GROUP_ADMINS, PLATFORM_GROUPS, parse_app_role_group

PAGE = 60  # Cognito's maximum per ListUsers page; one page is what the panel shows, with a search box for the rest
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserAdminError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _attr(user: dict[str, Any], name: str) -> str | None:
    for a in user.get("Attributes") or user.get("UserAttributes") or []:
        if a.get("Name") == name:
            return str(a.get("Value"))
    return None


def _when(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def present_user(raw: dict[str, Any], groups: list[str]) -> dict[str, Any]:
    """The shape the panel renders: attributes flattened, the status Cognito reports, the groups sorted."""
    given, family = _attr(raw, "given_name"), _attr(raw, "family_name")
    return {
        "username": raw.get("Username"),
        "sub": _attr(raw, "sub"),
        "email": _attr(raw, "email"),
        "given_name": given,
        "family_name": family,
        "name": " ".join(p for p in (given, family) if p) or None,
        "enabled": bool(raw.get("Enabled", True)),
        # UNCONFIRMED | CONFIRMED | FORCE_CHANGE_PASSWORD (invited, first sign-in pending) | RESET_REQUIRED | …
        "status": raw.get("UserStatus"),
        "groups": sorted(groups),
        "created_at": _when(raw.get("UserCreateDate")),
        "updated_at": _when(raw.get("UserLastModifiedDate")),
    }


def group_kind(name: str) -> str:
    if name in PLATFORM_GROUPS:
        return "platform"
    if parse_app_role_group(name) is not None:
        return "app"
    return "hospital"


class UserAdmin:
    """Reads and changes accounts in the pool; `client` is boto3's cognito-idp or a fake with the same methods."""

    def __init__(self, user_pool_id: str, client: Any, emit_audit: Callable[[dict[str, Any]], None] | None = None, now: Callable[[], datetime] | None = None):
        self._pool = user_pool_id
        self._client = client
        self._emit = emit_audit or AuditSink.from_env("user_admin", os.environ).emit
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ── reads ─────────────────────────────────────────────────────────────────────────────────

    def list_groups(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"UserPoolId": self._pool, "Limit": 60}
            if token:
                kwargs["NextToken"] = token
            page = self._client.list_groups(**kwargs)
            for g in page.get("Groups", []):
                name = str(g["GroupName"])
                out.append({"name": name, "description": g.get("Description") or PLATFORM_GROUPS.get(name, ("", 0))[0], "kind": group_kind(name)})
            token = page.get("NextToken")
            if not token:
                break
        order = {"platform": 0, "app": 1, "hospital": 2}
        return sorted(out, key=lambda g: (order[g["kind"]], PLATFORM_GROUPS.get(g["name"], ("", 99))[1], g["name"]))

    def _members(self, group: str) -> list[str]:
        """Usernames in a group, every page."""
        names: list[str] = []
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"UserPoolId": self._pool, "GroupName": group, "Limit": 60}
            if token:
                kwargs["NextToken"] = token
            page = self._client.list_users_in_group(**kwargs)
            names.extend(str(u["Username"]) for u in page.get("Users", []))
            token = page.get("NextToken")
            if not token:
                return names

    def _membership(self) -> dict[str, list[str]]:
        """username → groups, from one ListUsersInGroup per group (the groups are few; the users may be many)."""
        groups = [g["name"] for g in self.list_groups()]
        by_user: dict[str, list[str]] = {}
        if not groups:
            return by_user
        with ThreadPoolExecutor(max_workers=min(8, len(groups))) as pool:
            for group, members in zip(groups, pool.map(self._members, groups)):
                for username in members:
                    by_user.setdefault(username, []).append(group)
        return by_user

    def list_users(self, search: str = "") -> dict[str, Any]:
        """One page of the pool (by email prefix when `search` is given), each user with their groups."""
        kwargs: dict[str, Any] = {"UserPoolId": self._pool, "Limit": PAGE}
        needle = search.strip().replace('"', "").replace("\\", "")
        if needle:
            kwargs["Filter"] = f'email ^= "{needle}"'
        page = self._client.list_users(**kwargs)
        membership = self._membership()
        users = [present_user(u, membership.get(str(u.get("Username")), [])) for u in page.get("Users", [])]
        users.sort(key=lambda u: ((u["email"] or "").lower(), u["username"] or ""))
        return {"users": users, "truncated": bool(page.get("PaginationToken"))}

    def get_user(self, username: str) -> dict[str, Any]:
        try:
            raw = self._client.admin_get_user(UserPoolId=self._pool, Username=username)
        except Exception as e:  # noqa: BLE001 — boto3 raises client-specific classes; the name is what we have
            if type(e).__name__ == "UserNotFoundException":
                raise UserAdminError(404, f"No account {username!r} in this hospital's user pool.") from e
            raise
        groups = self._client.admin_list_groups_for_user(UserPoolId=self._pool, Username=username).get("Groups", [])
        return present_user(raw, [str(g["GroupName"]) for g in groups])

    # ── changes ───────────────────────────────────────────────────────────────────────────────

    def create_user(self, caller: Caller, body: dict[str, Any]) -> dict[str, Any]:
        email = str(body.get("email") or "").strip().lower()
        if not EMAIL.match(email):
            raise UserAdminError(400, "A valid email address is required; it is the account's username.")
        attributes = [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}]
        for key in ("given_name", "family_name"):
            value = str(body.get(key) or "").strip()
            if value:
                attributes.append({"Name": key, "Value": value})
        groups = self._group_list(body.get("groups"), "groups")
        self._require_known(groups)
        try:
            created = self._client.admin_create_user(UserPoolId=self._pool, Username=email, UserAttributes=attributes, DesiredDeliveryMediums=["EMAIL"])
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ == "UsernameExistsException":
                raise UserAdminError(409, f"An account for {email} already exists.") from e
            raise
        username = str(created["User"]["Username"])
        for group in groups:
            self._client.admin_add_user_to_group(UserPoolId=self._pool, Username=username, GroupName=group)
        self._audit("platform.user.create", caller, username, email=email, groups_added=groups)
        return self.get_user(username)

    def patch_user(self, caller: Caller, username: str, body: dict[str, Any]) -> dict[str, Any]:
        before = self.get_user(username)
        is_self = bool(before.get("sub")) and before.get("sub") == caller.sub
        add = [g for g in self._group_list(body.get("add_groups"), "add_groups") if g not in before["groups"]]
        remove = [g for g in self._group_list(body.get("remove_groups"), "remove_groups") if g in before["groups"]]
        if set(add) & set(remove):
            raise UserAdminError(400, "A group cannot be both added and removed.")
        self._require_known(add)
        enabled = body.get("enabled")
        if enabled is not None and not isinstance(enabled, bool):
            raise UserAdminError(400, "enabled must be true or false.")
        if is_self and enabled is False:
            raise UserAdminError(400, "You cannot disable your own account.")
        if is_self and GROUP_ADMINS in remove:
            raise UserAdminError(400, "You cannot remove yourself from medapp-admins; ask another administrator.")

        for group in add:
            self._client.admin_add_user_to_group(UserPoolId=self._pool, Username=username, GroupName=group)
        for group in remove:
            self._client.admin_remove_user_from_group(UserPoolId=self._pool, Username=username, GroupName=group)
        if add or remove:
            self._audit("platform.user.groups", caller, username, groups_added=add, groups_removed=remove)
        if enabled is not None and enabled != before["enabled"]:
            if enabled:
                self._client.admin_enable_user(UserPoolId=self._pool, Username=username)
            else:
                self._client.admin_disable_user(UserPoolId=self._pool, Username=username)
            self._audit("platform.user.enable" if enabled else "platform.user.disable", caller, username)
        return self.get_user(username)

    def resend_invitation(self, caller: Caller, username: str) -> dict[str, Any]:
        user = self.get_user(username)
        if user["status"] != "FORCE_CHANGE_PASSWORD":
            raise UserAdminError(409, "This account has already completed its first sign-in; use the password recovery on the sign-in screen instead.")
        self._client.admin_create_user(UserPoolId=self._pool, Username=username, MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"])
        self._audit("platform.user.invite", caller, username, email=user.get("email"))
        return user

    # ── helpers ───────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _group_list(value: Any, field: str) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list) or not all(isinstance(g, str) and g for g in value):
            raise UserAdminError(400, f"{field} must be a list of group names.")
        return list(dict.fromkeys(value))  # de-duplicated, order kept

    def _require_known(self, groups: list[str]) -> None:
        if not groups:
            return
        known = {g["name"] for g in self.list_groups()}
        unknown = [g for g in groups if g not in known]
        if unknown:
            raise UserAdminError(400, f"Not a group in this hospital's user pool: {', '.join(unknown)}.")

    def _audit(self, kind: str, caller: Caller, username: str, **detail: Any) -> None:
        """One record per change, in the trail's common shape: who (the administrator), what (the kind), on whom (the account), and the groups moved."""
        record = new_record(kind, user_sub=caller.sub, user_name=caller.display, user_email=caller.email, target_username=username, **{k: v for k, v in detail.items() if v})
        record["timestamp"] = self._now().isoformat().replace("+00:00", "Z")
        record["detail"] = _describe(kind, detail)
        self._emit(record)


def _describe(kind: str, detail: dict[str, Any]) -> str:
    """The change in one line, for the trail's Detail column."""
    parts: list[str] = []
    if detail.get("email"):
        parts.append(str(detail["email"]))
    if detail.get("groups_added"):
        parts.append("added " + ", ".join(detail["groups_added"]))
    if detail.get("groups_removed"):
        parts.append("removed " + ", ".join(detail["groups_removed"]))
    verb = {"platform.user.create": "account created", "platform.user.disable": "access disabled", "platform.user.enable": "access enabled", "platform.user.groups": "groups changed", "platform.user.invite": "invitation re-sent"}.get(kind, kind)
    return "; ".join([verb, *parts])


# ── HTTP ──────────────────────────────────────────────────────────────────────────────────────


def handle(event: dict[str, Any], admin: UserAdmin) -> dict[str, Any]:
    caller = caller_from_event(event)
    if not caller.sub:
        return response(401, {"message": "No authenticated caller."})
    if not caller.is_admin:
        return response(403, {"message": "Managing accounts is for administrators (medapp-admins)."})

    route = event.get("routeKey", "")
    params = event.get("pathParameters") or {}
    query = event.get("queryStringParameters") or {}
    try:
        body = json_body(event) if route.startswith(("POST", "PATCH")) else {}
    except (ValueError, json.JSONDecodeError):
        return response(400, {"message": "Body must be a JSON object."})

    try:
        if route == "GET /users":
            return response(200, admin.list_users(str(query.get("search") or "")))
        if route == "GET /users/groups":
            return response(200, {"groups": admin.list_groups()})
        if route == "POST /users":
            return response(201, admin.create_user(caller, body))
        if route == "PATCH /users/{username}":
            return response(200, admin.patch_user(caller, str(params.get("username", "")), body))
        if route == "POST /users/{username}/invitation":
            return response(200, admin.resend_invitation(caller, str(params.get("username", ""))))
    except UserAdminError as e:
        return response(e.status, {"message": e.message})
    return response(404, {"message": f"Unknown route {route}"})


_admin: UserAdmin | None = None


def _get_admin() -> UserAdmin:
    global _admin
    if _admin is None:
        import boto3

        _admin = UserAdmin(os.environ["USER_POOL_ID"], boto3.client("cognito-idp"))
    return _admin


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_admin())
