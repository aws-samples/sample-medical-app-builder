import pytest

from medapp_shared import identity_model as im


def test_app_role_group_round_trips_even_with_hyphenated_app_ids():
    for app_id in ("app_bp_trend", "01JC8N2M6QK9R7X3ZAV5T8WBHE", "app-with-hyphens"):
        g = im.app_role_group(app_id, "reviewer")
        assert im.parse_app_role_group(g) == im.AppRoleGroup(app_id=app_id, role_id="reviewer")


def test_role_ids_must_be_identifiers():
    with pytest.raises(ValueError):
        im.app_role_group("app_x", "Clinical-Reviewer")
    assert im.parse_app_role_group("app-app_x-Clinical") is None


def test_platform_and_unknown_groups_do_not_parse_as_app_roles():
    for g in ("medapp-authors", "medapp-approvers", "admins", "app-", "app-x-"):
        assert im.parse_app_role_group(g) is None
    assert im.is_platform_group("medapp-authors") and not im.is_platform_group("app-app_x-viewer")


def test_roles_for_app_filters_and_dedupes():
    groups = ["medapp-authors", "app-app_bp_trend-viewer", "app-app_other-reviewer", "app-app_bp_trend-reviewer", "app-app_bp_trend-viewer"]
    assert im.roles_for_app(groups, "app_bp_trend") == ["viewer", "reviewer"]
    assert im.roles_for_app(groups, "app_none") == []


def test_authoring_rules():
    author, approver, admin, nobody = ["medapp-authors"], ["medapp-approvers"], ["medapp-admins"], ["app-app_x-viewer"]
    assert im.can_author(author) and im.can_author(admin)
    assert not im.can_author(approver) and not im.can_author(nobody)
    # iterate: owner-or-admin
    assert im.can_iterate(author, caller_sub="a", owner_sub="a")
    assert not im.can_iterate(author, caller_sub="b", owner_sub="a")
    assert im.can_iterate(admin, caller_sub="b", owner_sub="a")
    # approve: approvers/admins, never your own draft
    assert im.can_approve(approver, caller_sub="r", author_sub="a")
    assert not im.can_approve(approver, caller_sub="a", author_sub="a")
    assert not im.can_approve(author, caller_sub="r", author_sub="a")
    assert im.can_approve(admin, caller_sub="x", author_sub="a") and not im.can_approve(admin, caller_sub="a", author_sub="a")
    assert im.can_manage_membership(admin) and not im.can_manage_membership(approver)


def test_blanket_access_grants_the_default_role_only():
    roles = ["viewer", "reviewer"]
    assert im.effective_roles(["medapp-viewers"], "app_bp_trend", roles, "viewer") == ["viewer"]
    assert im.effective_roles(["medapp-approvers"], "app_bp_trend", roles, "viewer") == ["viewer"]
    assert im.effective_roles(["medapp-admins", "app-app_bp_trend-reviewer"], "app_bp_trend", roles, "viewer") == ["reviewer", "viewer"]
    # authors get nothing by themselves; unknown roles in groups are ignored; nothing → refuse
    assert im.effective_roles(["medapp-authors"], "app_bp_trend", roles, "viewer") == []
    assert im.effective_roles(["app-app_bp_trend-editor"], "app_bp_trend", roles, "viewer") == []
    assert im.effective_roles(["app-app_other-viewer"], "app_bp_trend", roles, "viewer") == []
    assert im.has_blanket_access(["medapp-viewers"]) and not im.has_blanket_access(["medapp-authors"])
    assert set(im.BLANKET_ACCESS_GROUPS) <= set(im.PLATFORM_GROUPS)


def test_manifest_declared_groups_are_authoritative_so_roles_can_bind_to_existing_hospital_groups():
    roles = ["viewer", "reviewer"]
    bindings = {"viewer": "cardiology-physicians", "reviewer": "app-app_bp_trend-reviewer"}
    # a department group the hospital already has grants the role, without any app-specific group
    assert im.effective_roles(["cardiology-physicians"], "app_bp_trend", roles, "viewer", role_groups=bindings) == ["viewer"]
    assert im.runnable_roles(["cardiology-physicians"], "app_bp_trend", roles, "viewer", role_groups=bindings) == {"viewer": "group"}
    # the conventional name still works when that is what the manifest declares
    assert im.effective_roles(["app-app_bp_trend-reviewer"], "app_bp_trend", roles, "viewer", role_groups=bindings) == ["reviewer"]
    # but a conventional name the manifest did NOT declare grants nothing
    assert im.effective_roles(["app-app_bp_trend-viewer"], "app_bp_trend", roles, "viewer", role_groups=bindings) == []
    # without bindings, the naming convention is the fallback
    assert im.effective_roles(["app-app_bp_trend-viewer"], "app_bp_trend", roles, "viewer") == ["viewer"]


def test_staff_may_run_any_role_for_preview_and_it_is_labelled_as_such():
    roles = ["viewer", "reviewer"]
    # clinician with blanket access: default role only
    assert im.runnable_roles(["medapp-viewers"], "app_bp_trend", roles, "viewer") == {"viewer": "blanket"}
    # approver / admin: every declared role, default via blanket, the rest as staff preview
    assert im.runnable_roles(["medapp-approvers"], "app_bp_trend", roles, "viewer") == {"viewer": "blanket", "reviewer": "staff_preview"}
    assert im.runnable_roles(["medapp-admins", "app-app_bp_trend-reviewer"], "app_bp_trend", roles, "viewer") == {"viewer": "blanket", "reviewer": "group"}
    # author: only on apps they own
    assert im.runnable_roles(["medapp-authors"], "app_bp_trend", roles, "viewer", caller_sub="a", owner_sub="a") == {"viewer": "staff_preview", "reviewer": "staff_preview"}
    assert im.runnable_roles(["medapp-authors"], "app_bp_trend", roles, "viewer", caller_sub="a", owner_sub="someone-else") == {}
    # undeclared roles are never runnable
    assert "nurse" not in im.runnable_roles(["medapp-admins"], "app_bp_trend", roles, "viewer")


def test_single_web_client_per_hospital():
    assert im.WEB_CLIENT_NAME == "medapp-web"
    assert not hasattr(im, "app_client_name"), "apps are manifests, not software — no per-app clients"
