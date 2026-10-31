#!/usr/bin/env python3
"""
Seed the app registry table with the hospital's seed set: its manifests (by default med_app/manifests/<hospital_id>/*.yaml,
compiled by `npm run showcase` from med_app/showcase/<hospital_id>.yaml), the collections of that set, and the record shapes.

    scripts/seed-registry.py                     # skips apps/versions that already exist
    scripts/seed-registry.py --force             # overwrite HEAD and VERSION items
    scripts/seed-registry.py --manifests ../somewhere/*.yaml --owner-sub <cognito sub>
    scripts/seed-registry.py --collections ../somewhere/set.yaml   # a file with a `collections:` list; or --no-collections
    scripts/seed-registry.py --shapes ../somewhere/shapes/                 # or --no-shapes

Environment: AWS_PROFILE / AWS_REGION as usual (the table's region!), HOSPITAL_ID for the SSM lookup
(the only configured hospital when unset), or TABLE_NAME to skip it. Requires boto3 and pyyaml.

Each manifest becomes one VERSION item whose state comes from its `lifecycle.state`, and a HEAD
item pointing at it (`active_version` set only when published). Manifests that fail basic
structural checks are reported and skipped — the frontend's zod schema remains the authority.

A published manifest also gets its Cognito role groups (`app-<app_id>-<role>`), as publishing through
the API would — otherwise nobody but blanket-access members (medapp-viewers, approvers, admins) could
open a seeded app, and `scripts/create-user.sh <email> app-<app_id>-<role>` would have no group to add
to. Roles bound to an existing hospital group are left alone. `--no-groups` skips this.

The set's collections (by default med_app/showcase/<hospital_id>.yaml — the panel's mock registry reads the same
file) are written as COLLECTION items with ids derived from their names, as the registry API does; an app id the
manifests do not contain is dropped with a note. Existing collections are kept unless `--force`.

The bundled record shapes (by default med_app/shapes/*.yaml — the panel's mock library) are compiled with the
compiler CLI (`node scripts/appspec.mjs shape`, so med_app needs its node_modules; set MEDAPP_APP_DIR to another
checkout) and written as published SHAPE items — HEAD, version 0.1.0 and its two events — so `shape: <id>` resolves
in the deployed composer from the first draft on. Existing shapes are kept unless `--force`.
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # make medapp_shared importable
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

import boto3  # noqa: E402
import yaml  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from medapp_shared.identity_model import app_role_group  # noqa: E402
from _hospital import hospital_id as selected_hospital, parameter  # noqa: E402
from medapp_shared.registry_model import (  # noqa: E402
    HEAD_SK,
    SHAPE_FIRST_VERSION,
    app_pk,
    collection_id_for,
    collection_item,
    head_item,
    shape_event_item,
    shape_head_item,
    shape_version_item,
    version_item,
)

REQUIRED = ("apiVersion", "kind", "metadata", "lifecycle", "auth", "data_scopes", "primitives", "layout")

# With the AppRegistryGuardStack deployed, the table's resource policy denies item writes to every principal but the
# registry write Lambda and the operator roles named in `app_registry_guard_allowed_principals` — administrators included.
GUARD_HINT = (
    "denied: the registry table's resource policy (AppRegistryGuardStack) lets only the registry write Lambda and the operator roles named in "
    "the `app_registry_guard_allowed_principals` context write items. Run this under one of those roles, or add the role you are using to that "
    "context and redeploy AppRegistryGuardStack. The denied call has been logged and alerted on."
)


def load_manifest(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    missing = [k for k in REQUIRED if k not in data]
    if missing:
        raise ValueError(f"missing top-level keys: {', '.join(missing)}")
    if data.get("kind") != "AppManifest":
        raise ValueError(f"kind is {data.get('kind')!r}, expected AppManifest")
    return data


class RoleGroups:
    """The conventional per-app role groups of a published manifest, created in the pool if missing (idempotent)."""

    def __init__(self, hospital_id: str, user_pool_id: str | None = None):
        self._client = boto3.client("cognito-idp")
        self._pool = user_pool_id or parameter("identity/user-pool-id", hospital=hospital_id)

    def ensure_for(self, manifest: dict) -> list[str]:
        app_id = manifest["metadata"]["app_id"]
        created: list[str] = []
        for role in manifest["auth"]["roles"]:
            name = role.get("cognito_group") or app_role_group(app_id, role["id"])
            if name != app_role_group(app_id, role["id"]):
                continue  # bound to an existing hospital group: the hospital owns it
            try:
                self._client.create_group(GroupName=name, UserPoolId=self._pool, Description=f"{manifest['metadata']['name']} · {role.get('display_name', role['id'])}"[:2048])
                created.append(name)
            except self._client.exceptions.GroupExistsException:
                pass
        return created


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifests", default=None, help="glob of YAML manifests (default: med_app/manifests/<hospital_id>/*.yaml)")
    ap.add_argument("--owner-sub", default="seed", help="owner_sub / created_by_sub recorded on the items")
    ap.add_argument("--owner-name", default=None, help="shown as the author of the seeded versions (\"By: …\" in the panel); nothing shown without it")
    ap.add_argument("--owner-email", default=None, help="the author's email, shown when there is no name")
    ap.add_argument("--force", action="store_true", help="overwrite existing HEAD/VERSION items")
    ap.add_argument("--table", default=os.environ.get("TABLE_NAME"), help="table name (default: SSM lookup)")
    ap.add_argument("--no-groups", action="store_true", help="do not create the Cognito role groups of published manifests")
    ap.add_argument("--user-pool-id", default=os.environ.get("USER_POOL_ID"), help="the pool for the role groups (default: SSM lookup)")
    ap.add_argument("--collections", default=None, help="YAML with a `collections:` list to seed (default: med_app/showcase/<hospital_id>.yaml)")
    ap.add_argument("--no-collections", action="store_true", help="do not seed the collections")
    ap.add_argument("--shapes", default=str(Path(__file__).resolve().parents[2] / "med_app" / "shapes"), help="directory of RecordShape YAML files to seed as published shapes")
    ap.add_argument("--no-shapes", action="store_true", help="do not seed the record shapes")
    args = ap.parse_args()

    hospital_id = selected_hospital()
    med_app = Path(os.environ.get("MEDAPP_APP_DIR") or Path(__file__).resolve().parents[2] / "med_app")
    if args.manifests is None:
        args.manifests = str(med_app / "manifests" / hospital_id / "*.yaml")
    if args.collections is None:
        args.collections = str(med_app / "showcase" / f"{hospital_id}.yaml")
    table_name = args.table or parameter("registry/table-name", hospital=hospital_id)
    table = boto3.resource("dynamodb").Table(table_name)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    groups = None if args.no_groups else RoleGroups(hospital_id, args.user_pool_id)

    files = sorted(glob.glob(args.manifests))
    if not files:
        print(f"no manifests match {args.manifests} — is there a seed set for {hospital_id} (med_app/showcase/{hospital_id}.yaml, then `npm run showcase`)?", file=sys.stderr)
        return 2

    seeded = skipped = rejected = 0
    for f in files:
        path = Path(f)
        try:
            manifest = load_manifest(path)
            state = manifest["lifecycle"].get("state", "draft")
            version = version_item(manifest, created_by_sub=args.owner_sub, now=now, state=state, signoff=manifest["lifecycle"].get("signoff"), author={"name": args.owner_name, "email": args.owner_email})
            head = head_item(
                manifest,
                owner_sub=args.owner_sub,
                now=now,
                latest_version=manifest["metadata"]["version"],
                active_version=manifest["metadata"]["version"] if state == "published" else None,
                latest_state=state,
            )
        except Exception as err:  # noqa: BLE001 — report and continue; invalid examples are expected
            print(f"rejected  {path.name}: {err}")
            rejected += 1
            continue

        try:
            put_kwargs = {"Item": version}
            if not args.force:
                put_kwargs["ConditionExpression"] = "attribute_not_exists(PK)"
            table.put_item(**put_kwargs)
            put_kwargs = {"Item": head}
            if not args.force:
                put_kwargs["ConditionExpression"] = "attribute_not_exists(PK)"
            table.put_item(**put_kwargs)
            print(f"seeded    {path.name}: {head['app_id']} v{version['version']} [{state}]")
            seeded += 1
            if state == "published" and groups is not None:
                for created in groups.ensure_for(manifest):
                    print(f"group     {created}")
        except ClientError as err:
            if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
                print(f"exists    {path.name}: {head['app_id']} v{version['version']} (use --force to overwrite)")
                skipped += 1
            elif err.response["Error"]["Code"] in ("AccessDeniedException", "AccessDenied"):
                print(GUARD_HINT, file=sys.stderr)
                return 3
            else:
                raise

    print(f"\n{seeded} seeded, {skipped} already present, {rejected} rejected → {table_name} (HEAD sk={HEAD_SK}, pk prefix {app_pk('')})")

    if not args.no_collections and Path(args.collections).is_file():
        known = {load_manifest(Path(f))["metadata"]["app_id"] for f in files if not _rejected(Path(f))}
        seed_collections(table, Path(args.collections), known, now=now, actor_sub=args.owner_sub, actor={"name": args.owner_name, "email": args.owner_email}, force=args.force)
    if not args.no_shapes and Path(args.shapes).is_dir():
        from app_creator.manifest_service import CliManifestService, ManifestServiceUnavailable

        service = CliManifestService()

        def compile_shape(document: dict) -> tuple[dict | None, list[str]]:
            try:
                r = service.compile_shape(document)
            except ManifestServiceUnavailable as err:
                return None, [f"compiler unavailable: {err} — set MEDAPP_APP_DIR to a med_app checkout with node_modules"]
            return (r.artifact, []) if r.ok else (None, [f"{i.path}: {i.message}" for i in r.issues])

        seed_shapes(table, Path(args.shapes), compile_shape, now=now, actor_sub=args.owner_sub, actor={"name": args.owner_name, "email": args.owner_email}, force=args.force)
    return 0


def _rejected(path: Path) -> bool:
    try:
        load_manifest(path)
        return False
    except Exception:  # noqa: BLE001
        return True


def seed_collections(table, path: Path, known_app_ids: set[str], *, now: str, actor_sub: str, actor: dict, force: bool) -> None:
    """COLLECTION items from the YAML: name → id, apps narrowed to the manifests seeded here (an unknown id is named and dropped)."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    for entry in doc.get("collections") or []:
        name = str(entry.get("name", "")).strip()
        if not name:
            print("rejected  collection without a name")
            continue
        apps = [str(a) for a in entry.get("apps") or []]
        unknown = [a for a in apps if a not in known_app_ids]
        if unknown:
            print(f"note      {name}: not among the manifests, dropped: {', '.join(unknown)}")
        item = collection_item(collection_id_for(name), name=name, description=entry.get("description"), app_ids=[a for a in apps if a in known_app_ids], now=now, actor_sub=actor_sub, actor=actor)
        try:
            put_kwargs = {"Item": item}
            if not force:
                put_kwargs["ConditionExpression"] = "attribute_not_exists(PK)"
            table.put_item(**put_kwargs)
            print(f"collection {item['collection_id']}: {name} ({len(item['app_ids'])} apps)")
        except ClientError as err:
            if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
                print(f"exists    collection {item['collection_id']} (use --force to overwrite)")
            elif err.response["Error"]["Code"] in ("AccessDeniedException", "AccessDenied"):
                print(GUARD_HINT, file=sys.stderr)
                return
            else:
                raise


def seed_shapes(table, directory: Path, compile_shape, *, now: str, actor_sub: str, actor: dict, force: bool) -> None:
    """
    Published SHAPE items from the YAML documents: each compiled by the manifest service (`compile_shape(document)` →
    (artifact, problems)), written as HEAD + version 0.1.0 in `published` with its creation and publication events — what
    the panel's mock library shows, and what `shape: <id>` resolves to in the deployed composer.
    """
    for path in sorted(directory.glob("*.yaml")):
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        artifact, problems = compile_shape(document)
        if artifact is None:
            print(f"rejected  {path.name}: " + "; ".join(problems))
            continue
        version = SHAPE_FIRST_VERSION
        head = shape_head_item(artifact, owner_sub=actor_sub, now=now, latest_version=version, active_version=version, latest_state="published", actor=actor)
        item = shape_version_item(document, artifact, version=version, created_by_sub=actor_sub, now=now, state="published", author=actor)
        events = [
            shape_event_item(artifact["id"], version, ts=now, actor_sub=actor_sub, from_state=None, to_state="draft", notes="created", actor=actor),
            shape_event_item(artifact["id"], version, ts=_a_second_after(now), actor_sub=actor_sub, from_state="draft", to_state="published", notes="Shipped with the platform.", actor=actor),
        ]
        try:
            for entry in (head, item, *events):  # HEAD first: its condition decides whether the rest is written at all
                put_kwargs = {"Item": entry}
                if not force and entry["SK"] == HEAD_SK:
                    put_kwargs["ConditionExpression"] = "attribute_not_exists(PK)"
                table.put_item(**put_kwargs)
            print(f"shape     {artifact['id']}: {artifact['name']} ({artifact['resource']}, {len(artifact.get('fields') or [])} fields) v{version} [published]")
        except ClientError as err:
            if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
                print(f"exists    shape {artifact['id']} (use --force to overwrite)")
            elif err.response["Error"]["Code"] in ("AccessDeniedException", "AccessDenied"):
                print(GUARD_HINT, file=sys.stderr)
                return
            else:
                raise


def _a_second_after(ts: str) -> str:
    """The publication event sorts after the creation event: event keys are `EVT#<version>#<ts>`."""
    from datetime import timedelta

    try:
        moment = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return ts
    return (moment + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    raise SystemExit(main())
