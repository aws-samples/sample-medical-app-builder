#!/usr/bin/env python3
"""
Store the hospital's OAuth2 client credentials in Secrets Manager — the one place they live.

    scripts/set-hospital-credentials.py                      # prompts for the client id and (hidden) the secret
    MEDAPP_HOSPITAL_CLIENT_ID=… MEDAPP_HOSPITAL_CLIENT_SECRET=… scripts/set-hospital-credentials.py --no-prompt
    scripts/set-hospital-credentials.py --check              # obtain a token with what is stored, print its lifetime, write nothing

The secret's name comes from the hospital's file (`hospital_servers.credentials_secret` in infra/hospitals/<id>.json;
HOSPITAL_ID selects it when several are configured), so the stack and this script agree
without the name being typed twice. The secret is created if it does not exist and a new version is written if it
does; the value is `{"client_id": …, "client_secret": …}`, what medapp_shared.oauth2 reads. The credentials are
never accepted on the command line (they would land in the shell history) and never printed.

Run it before `cdk deploy HospitalServersStack`: the stack references the secret by name and grants the dispatcher,
the viewer door and the seed function permission to read it. Rotate by running it again with the new secret.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

import boto3  # noqa: E402

from medapp_shared.oauth2 import ClientCredentials, Credentials, TokenError, credentials_from_secret  # noqa: E402
from _hospital import hospital_config  # noqa: E402


def hospital_context() -> dict:
    hospital = hospital_config()
    context = hospital.hospital_servers
    if not isinstance(context, dict) or not context.get("credentials_secret"):
        raise SystemExit(f"hospitals/{hospital.hospital_id}.json has no hospital_servers.credentials_secret — add the hospital_servers block first")
    return dict(context)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-prompt", action="store_true", help="take MEDAPP_HOSPITAL_CLIENT_ID / MEDAPP_HOSPITAL_CLIENT_SECRET from the environment")
    ap.add_argument("--check", action="store_true", help="request a token with the stored credentials and report; write nothing")
    ap.add_argument("--profile", default=None, help="AWS profile (default: the environment's)")
    args = ap.parse_args()

    context = hospital_context()
    name = str(context["credentials_secret"])
    session = boto3.session.Session(profile_name=args.profile)
    secrets = session.client("secretsmanager")

    if args.check:
        credentials = credentials_from_secret(name, secrets)
        provider = ClientCredentials(str(context["token_url"]), credentials, scope=context.get("scope"))
        try:
            body = provider.fetch()
        except TokenError as err:
            print(f"token request failed: {err}", file=sys.stderr)
            return 1
        print(f"ok: {name} holds client {credentials.client_id}; the token endpoint issued a {body.get('token_type', 'Bearer')} token valid for {body.get('expires_in', '?')} s")
        return 0

    if args.no_prompt:
        client_id, client_secret = os.environ.get("MEDAPP_HOSPITAL_CLIENT_ID", ""), os.environ.get("MEDAPP_HOSPITAL_CLIENT_SECRET", "")
        if not client_id or not client_secret:
            raise SystemExit("--no-prompt needs MEDAPP_HOSPITAL_CLIENT_ID and MEDAPP_HOSPITAL_CLIENT_SECRET in the environment")
    else:
        client_id = input("Client id: ").strip()
        client_secret = getpass.getpass("Client secret (not echoed): ").strip()
        if not client_id or not client_secret:
            raise SystemExit("both values are needed")

    # Prove the pair works before storing it: a typo would otherwise surface as 502s in the panel after the deploy.
    try:
        body = ClientCredentials(str(context["token_url"]), Credentials(client_id, client_secret), scope=context.get("scope")).fetch()
    except TokenError as err:
        print(f"the token endpoint refused these credentials, nothing stored: {err}", file=sys.stderr)
        return 1

    value = json.dumps({"client_id": client_id, "client_secret": client_secret})
    try:
        secrets.describe_secret(SecretId=name)
        secrets.put_secret_value(SecretId=name, SecretString=value)
        action = "updated"
    except secrets.exceptions.ResourceNotFoundException:
        secrets.create_secret(Name=name, SecretString=value, Description="MedApp: the hospital's OAuth2 client credentials (FHIR and DICOMweb)", Tags=[{"Key": "medapp:component", "Value": "hospital-servers"}])
        action = "created"
    print(f"{action} {name} (token endpoint accepted the credentials; lifetime {body.get('expires_in', '?')} s). Deploy with: cdk deploy HospitalServersStack ApiStack")
    return 0


if __name__ == "__main__":
    sys.exit(main())
