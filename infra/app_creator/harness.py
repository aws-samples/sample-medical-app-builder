"""
Terminal harness: chat with the drafting agent against Bedrock, exactly as the panel will, and watch
the draft take shape. Sessions are saved as files so a conversation can be resumed.

    cd infra && python -m app_creator.harness
    python -m app_creator.harness --session <id>            # resume
    python -m app_creator.harness --model eu.anthropic.claude-sonnet-4-5-20250929-v1:0 --region eu-central-1

Needs AWS credentials with bedrock:InvokeModel*, ssm:GetParameter and cognito-idp:ListGroups (the real
groups a role can be bound to come from the deployed pool), and a med_app checkout with node_modules
(MEDAPP_APP_DIR, default ../med_app) for the compiler. `--demo-groups` substitutes a fake group list.

Commands inside the chat: /spec (the draft), /open (what is still missing), /compile (manifest summary),
/save <file.yaml> (write the spec), /manifest <file.yaml> (write the compiled manifest), /quit.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import yaml

from .agent import Drafter
from .catalog import Catalog
from .vocabulary import vocabulary_from_env
from .groups import CognitoGroups, GroupDirectory, GroupInfo, StaticGroups
from .manifest_service import CliManifestService, ManifestServiceUnavailable, summarize_manifest
from .shapes import StaticShapes, bundled_shapes
from .session import DraftSession, FileSessionStore

DEMO_GROUPS = [GroupInfo("kardiologie", "Cardiology department"), GroupInfo("diabetologie", "Diabetes clinic"), GroupInfo("radiologie", "Radiology"), GroupInfo("pflege-station-3", "Ward 3 nursing")]


def group_directory(hospital_id: str, user_pool: str | None, demo: bool) -> GroupDirectory:
    """The hospital's real groups unless demo groups are explicitly asked for: a role bound to a group that
    does not exist in the pool grants access to nobody, so the agent must only ever see real ones."""
    if demo:
        print("groups: DEMO list (kardiologie, diabetologie, radiologie, pflege-station-3) — not the account's pool", file=sys.stderr)
        return StaticGroups(DEMO_GROUPS)
    try:
        directory = CognitoGroups(user_pool) if user_pool else CognitoGroups.for_hospital(hospital_id)
        names = [g.name for g in directory.list_groups()]
        print(f"groups: {len(names)} bindable in the user pool" + (f" ({', '.join(names)})" if names else " (none yet — roles will create app groups at publish)"), file=sys.stderr)
        return directory
    except Exception as e:  # noqa: BLE001 — no pool deployed / no permission: say so and offer nothing rather than fakes
        print(f"groups: could not list the user pool ({e.__class__.__name__}: {e}); no existing groups will be offered. Use --demo-groups for a fake list.", file=sys.stderr)
        return StaticGroups([])


def discover_hospital_name(hospital_id: str) -> str:
    """The display name the IdentityStack published (SSM /medapp/<hospital>/name); the id when not deployed."""
    try:
        import boto3  # noqa: PLC0415

        return str(boto3.client("ssm").get_parameter(Name=f"/medapp/{hospital_id}/name")["Parameter"]["Value"])
    except Exception:  # noqa: BLE001
        return hospital_id


def default_model_id() -> str | None:
    """MEDAPP_MODEL_ID, else the deployment's `model_id` from infra/cdk.json — the same model the agent Lambda runs on."""
    if os.environ.get("MEDAPP_MODEL_ID"):
        return os.environ["MEDAPP_MODEL_ID"]
    cdk_json = Path(__file__).resolve().parents[1] / "cdk.json"
    try:
        value = json.loads(cdk_json.read_text(encoding="utf-8")).get("context", {}).get("model_id")
        return str(value) if value else None
    except (OSError, ValueError):
        return None


def make_model(model_id: str | None, region: str | None):  # type: ignore[no-untyped-def]
    from strands.models import BedrockModel

    kwargs = {}
    if model_id:
        kwargs["model_id"] = model_id
    if region:
        kwargs["region_name"] = region
    model = BedrockModel(**kwargs)
    print(f"model: {model.get_config().get('model_id')}  region: {region or os.environ.get('AWS_REGION', 'default')}", file=sys.stderr)
    return model


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="app_creator.harness", description="Chat with the drafting agent.")
    ap.add_argument("--hospital", default=os.environ.get("MEDAPP_HOSPITAL_ID", "hsp-musterstadt"))
    ap.add_argument("--hospital-name", default=os.environ.get("MEDAPP_HOSPITAL_NAME"), help="display name (default: SSM /medapp/<hospital>/name, else the id)")
    ap.add_argument("--model", default=default_model_id(), help="Bedrock model id or inference profile (default: MEDAPP_MODEL_ID, else cdk.json's model_id)")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION"))
    ap.add_argument("--session", help="resume a saved session id")
    ap.add_argument("--sessions-dir", default=os.environ.get("MEDAPP_SESSIONS_DIR", ".sessions"))
    ap.add_argument("--user-pool", default=os.environ.get("MEDAPP_USER_POOL_ID"), help="Cognito user pool id (default: discovered from SSM /medapp/<hospital>/identity/user-pool-id)")
    ap.add_argument("--demo-groups", action="store_true", help="offer a fake group list instead of the pool's real groups (never for real drafts)")
    ap.add_argument("--author", default="harness-user")
    args = ap.parse_args(argv)

    # The record's vocabulary: MEDAPP_VOCABULARY_FILE (scripts/record-vocabulary.py --out) or RECORD_VOCABULARY_BUCKET; hints alone otherwise.
    catalog = Catalog.load(vocabulary=vocabulary_from_env())
    service = CliManifestService()
    try:
        service.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec"})
    except ManifestServiceUnavailable as e:
        print(f"compiler unavailable: {e}\nSet MEDAPP_APP_DIR to a med_app checkout with node_modules.", file=sys.stderr)
        return 2

    groups = group_directory(args.hospital, args.user_pool, args.demo_groups)
    hospital_name = args.hospital_name or discover_hospital_name(args.hospital)
    # The library a `record` section may refer to: locally, the shapes bundled with the panel (med_app/shapes), compiled.
    shapes = StaticShapes(bundled_shapes(service))
    drafter = Drafter(make_model(args.model, args.region), catalog, service, hospital_id=args.hospital, hospital_name=hospital_name, groups=groups, shapes=shapes)

    store = FileSessionStore(Path(args.sessions_dir))
    session = (store.load(args.session) if args.session else None) or DraftSession.new(args.hospital, author_sub=args.author)
    print(f"session: {session.session_id}  (resume with --session {session.session_id})", file=sys.stderr)
    print("Describe the app you want. Commands: /spec /open /compile /save <file> /manifest <file> /quit\n", file=sys.stderr)

    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        if line in ("/quit", "/exit"):
            break
        if line == "/spec":
            print(yaml.safe_dump({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", **session.spec}, allow_unicode=True, sort_keys=False))
            continue
        if line == "/open":
            r = service.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", **session.spec}, shapes=shapes.published())
            print("ready" if r.ready else "\n".join(f"  {i.path}: {i.message}" for i in r.missing))
            continue
        if line == "/compile" or line.startswith("/manifest "):
            r = service.compile({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", **session.spec}, args.hospital, shapes=shapes.published())
            if not r.ok or r.manifest is None:
                print("\n".join(f"  {i.path}: {i.message}" for i in r.issues))
                continue
            if line == "/compile":
                print(json.dumps(summarize_manifest(r.manifest), indent=2, ensure_ascii=False))
            else:
                out = Path(line.split(" ", 1)[1].strip())
                out.write_text(yaml.safe_dump(r.manifest, allow_unicode=True, sort_keys=False), encoding="utf-8")
                print(f"wrote {out}")
            continue
        if line.startswith("/save "):
            out = Path(line.split(" ", 1)[1].strip())
            out.write_text(yaml.safe_dump({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", **session.spec}, allow_unicode=True, sort_keys=False), encoding="utf-8")
            print(f"wrote {out}")
            continue

        result = drafter.turn(session, line)
        store.save(result.session)
        print(f"\nagent> {result.reply}\n")
        if result.tool_calls:
            print(f"   [tools: {', '.join(result.tool_calls)}]", file=sys.stderr)
        if result.open:
            print(f"   [open: {', '.join(i['path'] for i in result.open)}]", file=sys.stderr)
        else:
            print("   [draft complete — /compile to see the app]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
