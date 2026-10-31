"""
User administration API: accounts and group membership in the hospital's pool, for administrators — list with
groups joined, register (create + invitation), enable/disable, add to and remove from platform and app groups,
re-send the invitation; the two lock-out guards; one audit record per change. Runs over a fake Cognito client
with the boto3 shapes the Lambda reads.
"""

import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("user_admin_handler", ROOT / "lambdas" / "user_admin" / "handler.py")
handler = importlib.util.module_from_spec(spec)
sys.modules["user_admin_handler"] = handler
spec.loader.exec_module(handler)  # type: ignore[union-attr]

POOL = "eu-central-1_TEST"
ADMIN_SUB = "sub-admin"


class CognitoError(Exception):
    pass


class UserNotFoundException(CognitoError):
    pass


class UsernameExistsException(CognitoError):
    pass


class FakeCognito:
    """The pool as boto3 shows it: users with attributes, groups, membership; every call recorded."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.groups: dict[str, str] = {
            "medapp-admins": "Registry and identity administration",
            "medapp-approvers": "Clinical sign-off",
            "medapp-authors": "May create and iterate app manifests",
            "medapp-viewers": "Blanket access",
            "app-app_hypertension_register-hypertension_clinic": "",
            "app-app_htn_assessment-nurse": "",
            "cardiology-physicians": "Hospital SSO group",
        }
        self.users: dict[str, dict] = {}
        self.membership: dict[str, set[str]] = {}
        self.seed("u-admin", "admin@klinikum-musterstadt.example", "Ada", "Admin", ADMIN_SUB, ["medapp-admins", "medapp-authors"], status="CONFIRMED")
        self.seed("u-nurse", "nurse.k@klinikum-musterstadt.example", "Karin", "Nurse", "sub-nurse", ["app-app_htn_assessment-nurse"], status="CONFIRMED")
        self.seed("u-new", "new.doc@klinikum-musterstadt.example", None, None, "sub-new", [], status="FORCE_CHANGE_PASSWORD")

    def seed(self, username, email, given, family, sub, groups, status="CONFIRMED", enabled=True):
        attrs = [{"Name": "sub", "Value": sub}, {"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}]
        if given:
            attrs.append({"Name": "given_name", "Value": given})
        if family:
            attrs.append({"Name": "family_name", "Value": family})
        self.users[username] = {"Username": username, "Attributes": attrs, "Enabled": enabled, "UserStatus": status, "UserCreateDate": datetime(2026, 9, 1, tzinfo=timezone.utc), "UserLastModifiedDate": datetime(2026, 9, 2, tzinfo=timezone.utc)}
        self.membership[username] = set(groups)

    def _record(self, name, kwargs):
        self.calls.append((name, kwargs))
        assert kwargs["UserPoolId"] == POOL

    def _find(self, username):
        if username in self.users:
            return self.users[username]
        for u in self.users.values():
            if any(a["Name"] == "email" and a["Value"] == username for a in u["Attributes"]):
                return u
        raise UserNotFoundException(username)

    def list_groups(self, **kwargs):
        self._record("list_groups", kwargs)
        return {"Groups": [{"GroupName": n, "Description": d} for n, d in self.groups.items()]}

    def list_users_in_group(self, **kwargs):
        self._record("list_users_in_group", kwargs)
        return {"Users": [{"Username": u} for u, gs in self.membership.items() if kwargs["GroupName"] in gs]}

    def list_users(self, **kwargs):
        self._record("list_users", kwargs)
        users = list(self.users.values())
        if "Filter" in kwargs:
            prefix = kwargs["Filter"].split('"')[1]
            users = [u for u in users if any(a["Name"] == "email" and a["Value"].startswith(prefix) for a in u["Attributes"])]
        return {"Users": users[: kwargs["Limit"]], **({"PaginationToken": "more"} if len(users) > kwargs["Limit"] else {})}

    def admin_get_user(self, **kwargs):
        self._record("admin_get_user", kwargs)
        u = self._find(kwargs["Username"])
        return {"Username": u["Username"], "UserAttributes": u["Attributes"], "Enabled": u["Enabled"], "UserStatus": u["UserStatus"], "UserCreateDate": u["UserCreateDate"], "UserLastModifiedDate": u["UserLastModifiedDate"]}

    def admin_list_groups_for_user(self, **kwargs):
        self._record("admin_list_groups_for_user", kwargs)
        u = self._find(kwargs["Username"])
        return {"Groups": [{"GroupName": g} for g in sorted(self.membership[u["Username"]])]}

    def admin_create_user(self, **kwargs):
        self._record("admin_create_user", kwargs)
        if kwargs.get("MessageAction") == "RESEND":
            self._find(kwargs["Username"])
            return {"User": self._find(kwargs["Username"])}
        email = kwargs["Username"]
        if any(a["Name"] == "email" and a["Value"] == email for u in self.users.values() for a in u["Attributes"]):
            raise UsernameExistsException(email)
        username = f"u-{len(self.users) + 1}"  # email-as-username pools give the account an opaque username
        given = next((a["Value"] for a in kwargs["UserAttributes"] if a["Name"] == "given_name"), None)
        family = next((a["Value"] for a in kwargs["UserAttributes"] if a["Name"] == "family_name"), None)
        self.seed(username, email, given, family, f"sub-{username}", [], status="FORCE_CHANGE_PASSWORD")
        return {"User": self.users[username]}

    def admin_add_user_to_group(self, **kwargs):
        self._record("admin_add_user_to_group", kwargs)
        assert kwargs["GroupName"] in self.groups, "the Lambda checks groups before calling"
        self.membership[self._find(kwargs["Username"])["Username"]].add(kwargs["GroupName"])

    def admin_remove_user_from_group(self, **kwargs):
        self._record("admin_remove_user_from_group", kwargs)
        self.membership[self._find(kwargs["Username"])["Username"]].discard(kwargs["GroupName"])

    def admin_enable_user(self, **kwargs):
        self._record("admin_enable_user", kwargs)
        self._find(kwargs["Username"])["Enabled"] = True

    def admin_disable_user(self, **kwargs):
        self._record("admin_disable_user", kwargs)
        self._find(kwargs["Username"])["Enabled"] = False


@pytest.fixture
def world():
    cognito = FakeCognito()
    audit: list[dict] = []
    admin = handler.UserAdmin(POOL, cognito, emit_audit=audit.append, now=lambda: datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc))
    return cognito, audit, admin


def event(route, groups="[medapp-admins]", body=None, params=None, query=None, sub=ADMIN_SUB):
    return {
        "routeKey": route,
        "pathParameters": params or {},
        "queryStringParameters": query or {},
        "body": json.dumps(body) if body is not None else None,
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "email": "admin@klinikum-musterstadt.example", "given_name": "Ada", "family_name": "Admin", "cognito:groups": groups}}}},
    }


def call(admin, *args, **kwargs):
    res = handler.handle(event(*args, **kwargs), admin)
    return res["statusCode"], json.loads(res["body"])


def test_only_administrators_get_in(world):
    _, _, admin = world
    assert call(admin, "GET /users", groups="[medapp-authors medapp-approvers]")[0] == 403
    assert call(admin, "GET /users", groups="[medapp-viewers]")[0] == 403
    assert handler.handle({"routeKey": "GET /users", "requestContext": {}}, admin)["statusCode"] == 401
    assert call(admin, "GET /users")[0] == 200


def test_the_list_joins_every_users_groups_with_one_call_per_group_not_per_user(world):
    cognito, _, admin = world
    status, out = call(admin, "GET /users")
    assert status == 200 and not out["truncated"]
    by_email = {u["email"]: u for u in out["users"]}
    assert list(by_email) == ["admin@klinikum-musterstadt.example", "new.doc@klinikum-musterstadt.example", "nurse.k@klinikum-musterstadt.example"], "by email"
    assert by_email["admin@klinikum-musterstadt.example"] == {
        "username": "u-admin", "sub": ADMIN_SUB, "email": "admin@klinikum-musterstadt.example", "given_name": "Ada", "family_name": "Admin", "name": "Ada Admin",
        "enabled": True, "status": "CONFIRMED", "groups": ["medapp-admins", "medapp-authors"], "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
    }
    assert by_email["nurse.k@klinikum-musterstadt.example"]["groups"] == ["app-app_htn_assessment-nurse"]
    assert by_email["new.doc@klinikum-musterstadt.example"]["status"] == "FORCE_CHANGE_PASSWORD" and by_email["new.doc@klinikum-musterstadt.example"]["name"] is None
    names = [c for c, _ in cognito.calls]
    assert names.count("list_users") == 1 and names.count("list_users_in_group") == len(cognito.groups) and "admin_list_groups_for_user" not in names

    status, out = call(admin, "GET /users", query={"search": "nurse"})
    assert status == 200 and [u["email"] for u in out["users"]] == ["nurse.k@klinikum-musterstadt.example"], "a search is an email-prefix filter on the pool"
    call(admin, "GET /users", query={"search": 'nurse" or 1=1'})
    assert next(k for n, k in cognito.calls if n == "list_users" and "Filter" in k and "1=1" in k["Filter"])["Filter"] == 'email ^= "nurse or 1=1"', "quotes never reach the filter"


def test_groups_come_sorted_platform_first_then_app_roles_then_the_hospitals_own(world):
    _, _, admin = world
    status, out = call(admin, "GET /users/groups")
    assert status == 200
    assert [(g["name"], g["kind"]) for g in out["groups"]] == [
        ("medapp-admins", "platform"), ("medapp-approvers", "platform"), ("medapp-authors", "platform"), ("medapp-viewers", "platform"),
        ("app-app_htn_assessment-nurse", "app"), ("app-app_hypertension_register-hypertension_clinic", "app"),
        ("cardiology-physicians", "hospital"),
    ]
    assert out["groups"][0]["description"].startswith("Registry and identity administration")


def test_registering_a_user_creates_the_account_sends_the_invitation_and_adds_the_groups(world):
    cognito, audit, admin = world
    status, user = call(admin, "POST /users", body={"email": "Dr.Hoffmann@Klinikum-Musterstadt.example ", "given_name": "Lukas", "family_name": "Hoffmann", "groups": ["medapp-viewers", "app-app_htn_assessment-nurse", "medapp-viewers"]})
    assert status == 201, user
    assert user["email"] == "dr.hoffmann@klinikum-musterstadt.example" and user["name"] == "Lukas Hoffmann" and user["status"] == "FORCE_CHANGE_PASSWORD" and user["enabled"]
    assert user["groups"] == ["app-app_htn_assessment-nurse", "medapp-viewers"] and user["username"] == "u-4", "the pool's opaque username, not the email"
    created = next(k for n, k in cognito.calls if n == "admin_create_user")
    assert created["Username"] == "dr.hoffmann@klinikum-musterstadt.example" and created["DesiredDeliveryMediums"] == ["EMAIL"] and "MessageAction" not in created
    assert {a["Name"]: a["Value"] for a in created["UserAttributes"]} == {"email": "dr.hoffmann@klinikum-musterstadt.example", "email_verified": "true", "given_name": "Lukas", "family_name": "Hoffmann"}
    assert len(audit) == 1
    created_record = audit[0]
    assert created_record["audit_id"] and created_record["outcome"] == "ok"
    assert {k: v for k, v in created_record.items() if k != "audit_id"} == {
        "kind": "platform.user.create", "timestamp": "2026-10-08T12:00:00Z", "outcome": "ok",
        "user_sub": ADMIN_SUB, "user_name": "Ada Admin", "user_email": "admin@klinikum-musterstadt.example",
        "target_username": "u-4", "email": "dr.hoffmann@klinikum-musterstadt.example", "groups_added": ["medapp-viewers", "app-app_htn_assessment-nurse"],
        "detail": "account created; dr.hoffmann@klinikum-musterstadt.example; added medapp-viewers, app-app_htn_assessment-nurse",
    }, "the trail's common shape: who, what, on whom, in one line"


    assert call(admin, "POST /users", body={"email": "dr.hoffmann@klinikum-musterstadt.example"})[0] == 409
    assert call(admin, "POST /users", body={"email": "not-an-email"})[0] == 400
    status, out = call(admin, "POST /users", body={"email": "x@klinikum-musterstadt.example", "groups": ["medapp-root"]})
    assert status == 400 and "medapp-root" in out["message"] and "x@klinikum-musterstadt.example" not in json.dumps(list(cognito.users.values()), default=str), "checked before the account is created"


def test_membership_and_access_change_through_patch_with_one_audit_record_each(world):
    cognito, audit, admin = world
    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"add_groups": ["medapp-viewers", "app-app_htn_assessment-nurse"], "remove_groups": ["medapp-authors"]})
    assert status == 200 and user["groups"] == ["app-app_htn_assessment-nurse", "medapp-viewers"], "already-held and never-held groups are no-ops"
    assert [n for n, _ in cognito.calls if n.startswith("admin_add") or n.startswith("admin_remove")] == ["admin_add_user_to_group"]
    assert {k: v for k, v in audit[-1].items() if k != "audit_id"} == {
        "kind": "platform.user.groups", "timestamp": "2026-10-08T12:00:00Z", "outcome": "ok",
        "user_sub": ADMIN_SUB, "user_name": "Ada Admin", "user_email": "admin@klinikum-musterstadt.example",
        "target_username": "u-nurse", "groups_added": ["medapp-viewers"], "detail": "groups changed; added medapp-viewers",
    }

    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"enabled": False})
    assert status == 200 and user["enabled"] is False and audit[-1]["kind"] == "platform.user.disable"
    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"enabled": False})
    assert status == 200 and audit[-1]["kind"] == "platform.user.disable" and len([a for a in audit if a["kind"] == "platform.user.disable"]) == 1, "no change, no record"
    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"enabled": True, "remove_groups": ["medapp-viewers"]})
    assert status == 200 and user["enabled"] is True and user["groups"] == ["app-app_htn_assessment-nurse"]
    assert [a["kind"] for a in audit[-2:]] == ["platform.user.groups", "platform.user.enable"]

    assert call(admin, "PATCH /users/{username}", params={"username": "nobody"}, body={"enabled": False})[0] == 404
    assert call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"add_groups": ["x"], "remove_groups": ["x"]})[0] == 400
    assert call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"add_groups": ["no-such-group"]})[0] == 400
    assert call(admin, "PATCH /users/{username}", params={"username": "u-nurse"}, body={"enabled": "yes"})[0] == 400


def test_an_administrator_cannot_lock_themselves_out(world):
    cognito, audit, admin = world
    status, out = call(admin, "PATCH /users/{username}", params={"username": "u-admin"}, body={"enabled": False})
    assert status == 400 and "own account" in out["message"]
    status, out = call(admin, "PATCH /users/{username}", params={"username": "u-admin"}, body={"remove_groups": ["medapp-admins"]})
    assert status == 400 and "another administrator" in out["message"]
    assert cognito.users["u-admin"]["Enabled"] and "medapp-admins" in cognito.membership["u-admin"] and audit == []
    # Another administrator may: that is how an admin is retired.
    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-admin"}, body={"remove_groups": ["medapp-admins"]}, sub="sub-other-admin")
    assert status == 200 and user["groups"] == ["medapp-authors"]
    # Dropping one's own authors group is allowed — it is not the key to the door.
    status, user = call(admin, "PATCH /users/{username}", params={"username": "u-admin"}, body={"remove_groups": ["medapp-authors"]})
    assert status == 200 and user["groups"] == []


def test_the_invitation_can_be_resent_only_while_the_first_sign_in_is_pending(world):
    cognito, audit, admin = world
    status, user = call(admin, "POST /users/{username}/invitation", params={"username": "u-new"})
    assert status == 200 and user["email"] == "new.doc@klinikum-musterstadt.example"
    resend = next(k for n, k in cognito.calls if n == "admin_create_user")
    assert resend == {"UserPoolId": POOL, "Username": "u-new", "MessageAction": "RESEND", "DesiredDeliveryMediums": ["EMAIL"]}
    assert audit[-1]["kind"] == "platform.user.invite" and audit[-1]["email"] == "new.doc@klinikum-musterstadt.example"
    status, out = call(admin, "POST /users/{username}/invitation", params={"username": "u-nurse"})
    assert status == 409 and "password recovery" in out["message"]
    assert call(admin, "POST /users/{username}/invitation", params={"username": "ghost"})[0] == 404


def test_request_hygiene(world):
    _, _, admin = world
    bad = event("POST /users")
    bad["body"] = "{not json"
    assert handler.handle(bad, admin)["statusCode"] == 400
    assert call(admin, "DELETE /users/{username}", params={"username": "u-nurse"})[0] == 404, "no deletion route exists"
