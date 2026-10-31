"""
Identity conventions shared by the identity stack, the registry API / lifecycle Lambda (which
creates per-app role groups at publish time) and — mirrored in TypeScript — the frontend's role
resolver (med_app/src/manifest/roles.ts).

One Cognito user pool per hospital, one app client per *software surface* (today: the web
frontend). Apps are manifests, not software, so they never get their own app client. What an app
does get is role groups:

    app-{app_id}-{role_id}          created when a version is first published; membership grants
                                    the right to use that app in that role
    medapp-authors / -approvers / -admins
                                    platform groups: who may create manifests, who may sign them off,
                                    who manages membership

Authorisation is request-level: a token is a hospital SSO session; the dispatcher reads the app and
version from the request, the role from the token's groups, and enforces the stored scope. No
per-app token claims are needed.

Role ids are `[a-z][a-z0-9_]*` (manifest schema), so they never contain a hyphen; that is what makes
`app-{app_id}-{role_id}` parseable even when app_id itself contains hyphens.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Mapping

import re

WEB_CLIENT_NAME = "medapp-web"

GROUP_ADMINS = "medapp-admins"
GROUP_APPROVERS = "medapp-approvers"
GROUP_AUTHORS = "medapp-authors"
GROUP_VIEWERS = "medapp-viewers"

# Platform-level groups (not per app). Lower precedence wins when Cognito picks a preferred role.
PLATFORM_GROUPS: dict[str, tuple[str, int]] = {
    GROUP_ADMINS: ("Registry and identity administration; manages group membership; opens every app in its default role", 10),
    GROUP_APPROVERS: ("Clinical sign-off: may move versions to approved / published; opens every app in its default role", 20),
    GROUP_AUTHORS: ("May create and iterate app manifests through the panel", 30),
    GROUP_VIEWERS: ("Blanket access: opens every app in its default role", 40),
}

# Groups whose members may open every app, running as the manifest's `default_role`.
# Per-app role groups still add more capable roles on top (most capable wins).
BLANKET_ACCESS_GROUPS = (GROUP_VIEWERS, GROUP_APPROVERS, GROUP_ADMINS)

_ROLE_ID = re.compile(r"^[a-z][a-z0-9_]*$")
_GROUP_MAX_LEN = 128  # Cognito limit


# ── Per-app role groups ──────────────────────────────────────────────────────────────────────


def app_role_group(app_id: str, role_id: str) -> str:
    if not _ROLE_ID.match(role_id):
        raise ValueError(f"role id {role_id!r} is not a lowercase identifier")

    name = f"app-{app_id}-{role_id}"

    if len(name) > _GROUP_MAX_LEN:
        raise ValueError(f"group name exceeds {_GROUP_MAX_LEN} characters: {name!r}")

    return name


@dataclass(frozen=True)
class AppRoleGroup:
    app_id: str
    role_id: str


def parse_app_role_group(group: str) -> AppRoleGroup | None:
    """`app-app_bp_trend-reviewer` → (app_bp_trend, reviewer); platform and unknown groups → None."""
    if not group.startswith("app-"):
        return None

    body = group[len("app-") :]
    app_id, sep, role_id = body.rpartition("-")

    if not sep or not app_id or not _ROLE_ID.match(role_id):
        return None

    return AppRoleGroup(app_id=app_id, role_id=role_id)


def roles_for_app(groups: Iterable[str], app_id: str) -> list[str]:
    """Role ids the token's groups grant for one app, in group order."""
    out: list[str] = []

    for g in groups:
        parsed = parse_app_role_group(g)

        if parsed and parsed.app_id == app_id and parsed.role_id not in out:
            out.append(parsed.role_id)

    return out


def is_platform_group(group: str) -> bool:
    return group in PLATFORM_GROUPS


def has_blanket_access(groups: Iterable[str]) -> bool:
    s = set(groups)
    return any(g in s for g in BLANKET_ACCESS_GROUPS)


def direct_roles(groups: Iterable[str], app_id: str, manifest_role_ids: Iterable[str], role_groups: Mapping[str, str] | None = None) -> list[str]:
    """
    Roles granted by group membership alone, in manifest order.

    The manifest is the authority: each role names its `cognito_group`, and that string is matched
    exactly — the frontend does the same. By convention the pipeline names it `app-{app_id}-{role}`
    and creates it at publish time, but a manifest may bind a role to a group that already exists in
    the hospital (a department, an IdP-mapped group), so nobody has to be added app by app.
    When `role_groups` is not supplied, the naming convention is the fallback.
    """
    s = set(groups)
    declared = list(manifest_role_ids)
    if role_groups:
        return [r for r in declared if role_groups.get(r) in s]
    by_convention = set(roles_for_app(groups, app_id))
    return [r for r in declared if r in by_convention]


def effective_roles(
    groups: Iterable[str],
    app_id: str,
    manifest_role_ids: Iterable[str],
    default_role: str,
    role_groups: Mapping[str, str] | None = None,
) -> list[str]:
    """
    The roles a token grants for one app — what a clinician may run: the roles whose declared
    Cognito group the caller is in, plus the manifest's default role for blanket-access groups.
    Only roles the manifest actually declares are returned. Empty means: refuse.
    """
    groups = list(groups)
    declared = list(manifest_role_ids)
    out = direct_roles(groups, app_id, declared, role_groups)
    if has_blanket_access(groups) and default_role in declared and default_role not in out:
        out.append(default_role)
    return out


def can_preview_any_role(groups: Iterable[str], *, caller_sub: str | None = None, owner_sub: str | None = None) -> bool:
    """
    Reviewing an app means seeing it as each of its roles. Approvers and admins may do so on every
    app; authors on the apps they own. Nobody else — blanket viewers get the default role only.
    """
    s = set(groups)
    if GROUP_APPROVERS in s or GROUP_ADMINS in s:
        return True
    return GROUP_AUTHORS in s and bool(caller_sub) and caller_sub == owner_sub


def runnable_roles(
    groups: Iterable[str],
    app_id: str,
    manifest_role_ids: Iterable[str],
    default_role: str,
    *,
    caller_sub: str | None = None,
    owner_sub: str | None = None,
    role_groups: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """
    Every role the caller may *run* for one app, mapped to how it was obtained:
      'group'          the role's declared Cognito group (by convention app-{app_id}-{role})
      'blanket'        blanket-access group → the manifest's default role
      'staff_preview'  staff privilege (approver/admin, or the owning author) — audited as such
    The dispatcher refuses any role not in this map and records the source on the audit record.
    """
    groups = list(groups)
    declared = [r for r in manifest_role_ids]
    direct = set(direct_roles(groups, app_id, declared, role_groups))
    out: dict[str, str] = {}
    for r in declared:
        if r in direct:
            out[r] = "group"
        elif r == default_role and has_blanket_access(groups):
            out[r] = "blanket"
    if can_preview_any_role(groups, caller_sub=caller_sub, owner_sub=owner_sub):
        for r in declared:
            out.setdefault(r, "staff_preview")
    return out


# ── Authoring authorisation (registry write API) ────────────────────────────────────────────


def is_admin(groups: Iterable[str]) -> bool:
    return GROUP_ADMINS in set(groups)


def can_author(groups: Iterable[str]) -> bool:
    """May create a new app or a new draft version."""
    s = set(groups)
    return GROUP_AUTHORS in s or GROUP_ADMINS in s


def can_iterate(groups: Iterable[str], *, caller_sub: str, owner_sub: str) -> bool:
    """New versions of an existing app: its owner (if still an author) or an admin."""
    return is_admin(groups) or (can_author(groups) and caller_sub == owner_sub)


def can_curate(groups: Iterable[str]) -> bool:
    """Collections — how the hospital groups its published apps for the launcher: approvers and admins, the governance people."""
    s = set(groups)
    return GROUP_APPROVERS in s or GROUP_ADMINS in s


def can_approve(groups: Iterable[str], *, caller_sub: str, author_sub: str) -> bool:
    """Approve / publish: approvers and admins, never the version's own author (separation of duties)."""
    s = set(groups)

    if caller_sub == author_sub:
        return False

    return GROUP_APPROVERS in s or GROUP_ADMINS in s


def can_manage_membership(groups: Iterable[str]) -> bool:
    return is_admin(groups)
