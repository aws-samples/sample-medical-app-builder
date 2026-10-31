#!/usr/bin/env python3
"""
Smoke-test the deployed authoring loop through the real API, as the panel will use it.

    pip install pycognito                                   (SRP sign-in with the web client, like the browser)
    export MEDAPP_PASSWORD='…'
    scripts/smoke-authoring.py --email you@example.org                       # chat with the agent (needs Bedrock access)
    scripts/smoke-authoring.py --email you@example.org --from-spec ../med_app/specs/bp-trend.yaml   # no model: PATCH a complete spec
    scripts/smoke-authoring.py --email you@example.org --submit                 # also submit the saved app for review
    scripts/smoke-authoring.py --email author@… --approver-email approver@… # submit, approve + publish (MEDAPP_APPROVER_PASSWORD)

Discovers the pool, web client and API base URL from SSM; needs the caller to be in medapp-authors (or
admins). Prints what happens at each step and the CloudWatch log groups to look at if something fails.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import boto3
import requests  # comes with pycognito; unlike urllib it ships a CA bundle (certifi), so macOS Pythons verify TLS fine
import yaml

INFRA = Path(__file__).resolve().parents[1]


def ssm(name: str) -> str:
    return boto3.client("ssm").get_parameter(Name=name)["Parameter"]["Value"]


def sign_in(pool: str, client: str, email: str, password: str) -> str:
    from pycognito import Cognito  # noqa: PLC0415

    u = Cognito(pool, client, username=email)
    u.authenticate(password=password)
    return str(u.id_token)


class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token
        self.http = requests.Session()
        self.http.headers.update({"authorization": f"Bearer {token}", "content-type": "application/json"})

    def call(self, method: str, path: str, body: dict | None = None, expect: tuple[int, ...] = (200, 201, 202)) -> dict:
        res = self.http.request(method, f"{self.base}{path}", data=json.dumps(body) if body is not None else None, timeout=60)
        payload = res.json() if res.content else {}
        if res.status_code not in expect:
            raise SystemExit(f"{method} {path} → {res.status_code}: {json.dumps(payload, ensure_ascii=False)[:600]}")
        return payload


def wait_for_turn(api: Api, sid: str, timeout_s: float = 240) -> dict:
    started, last = time.time(), None
    while time.time() - started < timeout_s:
        view = api.call("GET", f"/drafts/{sid}")
        turn = view.get("turn") or {}
        progress = ", ".join(turn.get("progress", []))
        state = f"{turn.get('status')} [{progress}]"
        if state != last:
            print(f"   … {state}")
            last = state
        if turn.get("status") in ("done", "failed"):
            return view
        time.sleep(2)
    raise SystemExit("the turn did not finish in time — check the drafting-agent log group")


def ops_from_spec(spec: dict) -> list[dict]:
    """A complete AppSpec as the PATCH operations the panel's editor would send."""
    ops = [{"op": "choose_archetype", "args": {"archetype": spec["archetype"], "reason": "smoke test"}}, {"op": "set_app", "args": {k: v for k, v in spec["app"].items() if k not in ("version", "parent_version")}}, {"op": "set_knobs", "args": {"patch": spec["knobs"]}}]
    for role in spec["roles"]:
        ops.append({"op": "add_role", "args": {"role": role}})
    ops.append({"op": "set_default_role", "args": {"id": spec["default_role"]}})
    ops.append({"op": "set_governance", "args": {"patch": spec["governance"]}})
    return ops


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hospital", default=os.environ.get("MEDAPP_HOSPITAL_ID", "hsp-musterstadt"))
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", default=os.environ.get("MEDAPP_PASSWORD"))
    ap.add_argument("--from-spec", help="skip the agent: PATCH this AppSpec into the draft (e.g. ../med_app/specs/bp-trend.yaml)")
    ap.add_argument("--message", default="I'd like to see a patient's HbA1c over the last five years against the 7 % target. One role, the diabetes clinicians, who see name, date of birth, sex and MRN. Display only, not for diagnosis. Take your defaults for everything else.")
    ap.add_argument("--app-id", help="override the app id before saving (the default one may already exist in the registry)")
    ap.add_argument("--approver-email", help="a second user (medapp-approvers) to approve and publish; MEDAPP_APPROVER_PASSWORD")
    ap.add_argument("--no-save", action="store_true", help="stop after the draft; do not write to the registry")
    ap.add_argument("--submit", action="store_true", help="also submit the saved app for review (draft → in_review); implied by --approver-email")
    args = ap.parse_args()
    if not args.password:
        raise SystemExit("set MEDAPP_PASSWORD or pass --password")

    h = args.hospital
    pool, client, base = ssm(f"/medapp/{h}/identity/user-pool-id"), ssm(f"/medapp/{h}/identity/web-client-id"), ssm(f"/medapp/{h}/api/base-url")
    print(f"pool {pool} · client {client} · api {base}")
    api = Api(base, sign_in(pool, client, args.email, args.password))
    print(f"signed in as {args.email}")

    # 1. a draft
    if args.from_spec:
        created = api.call("POST", "/drafts", {})
        sid = created["session_id"]
        spec = yaml.safe_load(Path(args.from_spec).read_text(encoding="utf-8"))
        if args.app_id:
            spec["app"]["app_id"] = args.app_id
        print(f"draft {sid}: PATCHing {args.from_spec} ({len(ops_from_spec(spec))} operations)")
        patched = api.call("PATCH", f"/drafts/{sid}", {"ops": ops_from_spec(spec)}, expect=(200, 422))
        if "rejected" in patched:
            raise SystemExit(f"PATCH rejected: {patched['rejected']}")
        print(f"   open items: {patched['open'] or 'none — ready'}")
    else:
        created = api.call("POST", "/drafts", {"message": args.message})
        sid = created["session_id"]
        print(f"draft {sid}: first turn queued ({created['turn']['id']})")
        view = wait_for_turn(api, sid)
        turn = view["turn"]
        if turn["status"] == "failed":
            raise SystemExit(f"turn failed: {turn.get('error')} — see /aws/lambda/medapp-{h}-drafting-agent")
        print(f"\nagent> {turn['reply']}\n")
        print(f"   tools: {', '.join(turn.get('tool_calls', []))}")
        print(f"   open: {[o['path'] for o in view['open']] or 'none — ready'}")
        if view["open"]:
            follow_up = "Yes to all your suggestions. Use your defaults and finish the draft."
            print(f"\nyou> {follow_up}")
            api.call("POST", f"/drafts/{sid}/turns", {"message": follow_up})
            view = wait_for_turn(api, sid)
            print(f"\nagent> {view['turn'].get('reply') or view['turn'].get('error')}\n")
            print(f"   open: {[o['path'] for o in view['open']] or 'none — ready'}")
        if args.app_id:
            api.call("PATCH", f"/drafts/{sid}", {"ops": [{"op": "set_app", "args": {"app_id": args.app_id}}]})

    view = api.call("GET", f"/drafts/{sid}")
    print(f"\nspec:\n{yaml.safe_dump(view['spec'], allow_unicode=True, sort_keys=False)}")
    if view["open"]:
        print(f"still open: {view['open']} — not saving")
        return 0
    compiled = api.call("POST", "/manifest/compile", {"spec": view["spec"]}, expect=(200, 422))
    if not compiled.get("ok"):
        raise SystemExit(f"compile refused: {compiled.get('issues')}")
    m = compiled["manifest"]
    print(f"compiles: {m['metadata']['app_id']} · {len(m['primitives'])} primitives · roles {[r['id'] for r in m['auth']['roles']]}")
    if args.no_save:
        return 0

    # 2. into the registry, and through the lifecycle
    saved = api.call("POST", "/registry/apps", {"session_id": sid}, expect=(201, 409))
    if "app_id" not in saved:
        raise SystemExit(f"save refused: {saved.get('message')} (use --app-id to pick another id)")
    app_id, version = saved["app_id"], saved["version"]
    print(f"saved as {app_id}@{version} ({saved['state']})")
    listed = api.call("GET", "/registry/apps")
    print(f"registry lists it for you: {any(a['app_id'] == app_id for a in listed['apps'])}")
    if not (args.submit or args.approver_email):
        print("left in draft — as the panel will: submitting for review is the author's explicit step (--submit)")
        return 0
    t = api.call("POST", f"/registry/apps/{app_id}/versions/{version}/transitions", {"to": "in_review", "notes": "smoke test"})
    print(f"→ {t['state']}  (submitted for review; the author cannot approve their own version)")

    if args.approver_email:
        approver = Api(base, sign_in(pool, client, args.approver_email, os.environ.get("MEDAPP_APPROVER_PASSWORD", "")))
        t = approver.call("POST", f"/registry/apps/{app_id}/versions/{version}/transitions", {"to": "approved", "notes": "Display only; approved for the smoke test."})
        print(f"→ {t['state']} · signature {t['signoff']['signature'][:40]}…")
        t = approver.call("POST", f"/registry/apps/{app_id}/versions/{version}/transitions", {"to": "published"})
        print(f"→ {t['state']} · groups app-{app_id}-<role> now exist in the pool")
        print("next: add yourself to one of those groups (scripts/create-user.sh or the console) and open the app in the launcher")
    else:
        print("\nto approve and publish, run again with --approver-email <a different user in medapp-approvers>, or use the API:")
        print(f"  POST /registry/apps/{app_id}/versions/{version}/transitions  {{\"to\": \"approved\"}}  then  {{\"to\": \"published\"}}")
    print(f"\nlogs: /aws/lambda/medapp-{h}-drafting-agent · /aws/lambda/medapp-{h}-drafts-api · /aws/lambda/medapp-{h}-registry-write · /aws/lambda/medapp-{h}-manifest-service")
    return 0


if __name__ == "__main__":
    sys.exit(main())
