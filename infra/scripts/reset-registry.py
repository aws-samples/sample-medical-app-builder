#!/usr/bin/env python3
"""
A clean start: empty the app registry (every HEAD, VERSION and EVENT item), optionally the drafting sessions
and the per-app Cognito groups, and re-seed the reference apps.

    scripts/reset-registry.py                          # says what it would delete, deletes nothing
    scripts/reset-registry.py --yes                    # empty the registry table
    scripts/reset-registry.py --yes --drafts --seed    # + the drafting conversations, then seed-registry.py
    scripts/reset-registry.py --yes --app-groups       # + delete the app-<app_id>-<role> groups publishing created

Environment: AWS_PROFILE / AWS_REGION as usual, HOSPITAL_ID for the SSM lookups (the only configured hospital when unset).

What stays: the tables themselves (deletion protection, RETAIN), point-in-time recovery (a wipe is recoverable
for 35 days), the DynamoDB stream (a mass delete is visible to an integrity monitor, as it should be), and —
unless --app-groups — the per-app Cognito groups, which publishing tolerates (`GroupExistsException`) and
which keep their members. Platform groups (medapp-admins/authors/approvers/viewers) are never touched.
Synthetic data only: nothing in these tables is a clinical record.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # medapp_shared
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

import boto3  # noqa: E402

from medapp_shared.identity_model import is_platform_group, parse_app_role_group  # noqa: E402
from _hospital import hospital_id as selected_hospital, parameter as ssm_parameter  # noqa: E402


def scan_keys(table, key_names: list[str]) -> list[dict]:
    keys: list[dict] = []
    kwargs = {"ProjectionExpression": ", ".join(f"#k{i}" for i in range(len(key_names))), "ExpressionAttributeNames": {f"#k{i}": n for i, n in enumerate(key_names)}}
    while True:
        page = table.scan(**kwargs)
        keys.extend({n: item[n] for n in key_names} for item in page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return keys
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def delete_all(table, keys: list[dict]) -> None:
    with table.batch_writer() as batch:
        for key in keys:
            batch.delete_item(Key=key)


def item_kind(key: dict) -> str:
    """HEAD / VERSION / EVENT of an app, COLLECTION, or the SHAPE / SHAPE_VERSION / SHAPE_EVENT items of the record-shape library."""
    pk = str(key.get("PK", ""))
    prefix = str(key.get("SK", "")).split("#", 1)[0]
    kind = {"HEAD": "HEAD", "V": "VERSION", "EVT": "EVENT"}.get(prefix, prefix or "?")
    if pk.startswith("COLLECTION#"):
        return "COLLECTION"
    if pk.startswith("SHAPE#"):
        return {"HEAD": "SHAPE", "VERSION": "SHAPE_VERSION", "EVENT": "SHAPE_EVENT"}.get(kind, kind)
    return kind


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yes", action="store_true", help="actually delete (without it, only report)")
    ap.add_argument("--drafts", action="store_true", help="also empty the drafting sessions table")
    ap.add_argument("--app-groups", action="store_true", help="also delete the per-app Cognito groups (app-<app_id>-<role>)")
    ap.add_argument("--seed", action="store_true", help="run scripts/seed-registry.py afterwards")
    args = ap.parse_args()

    session = boto3.session.Session()
    ssm = session.client("ssm")
    hospital_id = selected_hospital()

    def parameter(name: str) -> str:
        return ssm_parameter(name, ssm=ssm, hospital=hospital_id)

    dynamodb = session.resource("dynamodb")
    registry = dynamodb.Table(parameter("registry/table-name"))
    registry_keys = scan_keys(registry, ["PK", "SK"])
    kinds = Counter(item_kind(k) for k in registry_keys)
    apps = sorted({str(k["PK"]).split("#", 1)[-1] for k in registry_keys if str(k["PK"]).startswith("APP#")})
    print(f"registry {registry.name}: {len(registry_keys)} items — " + ", ".join(f"{n} {kind}" for kind, n in sorted(kinds.items())))
    for app in apps:
        print(f"  {app}")
    shapes = sorted({str(k["PK"]).split("#", 1)[-1] for k in registry_keys if str(k["PK"]).startswith("SHAPE#")})
    if shapes:
        print("  shapes: " + ", ".join(shapes))

    drafts = drafts_keys = None
    if args.drafts:
        drafts = dynamodb.Table(parameter("authoring/drafts-table"))
        drafts_keys = scan_keys(drafts, ["session_id"])
        print(f"drafts {drafts.name}: {len(drafts_keys)} sessions")

    groups: list[str] = []
    cognito = pool = None
    if args.app_groups:
        cognito = session.client("cognito-idp")
        pool = parameter("identity/user-pool-id")
        paginator = cognito.get_paginator("list_groups")
        for page in paginator.paginate(UserPoolId=pool):
            for g in page["Groups"]:
                name = g["GroupName"]
                if parse_app_role_group(name) and not is_platform_group(name):
                    groups.append(name)
        print(f"per-app groups in {pool}: {len(groups)}")
        for g in groups:
            print(f"  {g}")

    if not args.yes:
        print("\nnothing deleted — add --yes to do it")
        return 0

    delete_all(registry, registry_keys)
    print(f"deleted {len(registry_keys)} registry items")
    if drafts is not None and drafts_keys is not None:
        delete_all(drafts, drafts_keys)
        print(f"deleted {len(drafts_keys)} drafting sessions")
    if cognito is not None and pool is not None:
        for g in groups:
            cognito.delete_group(GroupName=g, UserPoolId=pool)
        print(f"deleted {len(groups)} per-app groups")

    if args.seed:
        print("\nseeding the reference apps…")
        return subprocess.run([sys.executable, str(Path(__file__).with_name("seed-registry.py"))], check=False).returncode
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # noqa: BLE001 — a script: say what went wrong and exit non-zero
        print(f"error: {err}", file=sys.stderr)
        if "AccessDenied" in str(err):
            print(
                "If AppRegistryGuardStack is deployed, the registry table's resource policy denies item writes to every principal but the registry write "
                "Lambda and the roles named in the `app_registry_guard_allowed_principals` context — administrators included. Run this under one of those roles.",
                file=sys.stderr,
            )
        sys.exit(1)
