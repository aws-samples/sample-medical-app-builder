"""
Which hospital a script works on — shared by the operator scripts in this folder.

HOSPITAL_ID in the environment names it. Unset, the one file under infra/hospitals/ is the answer; with several
hospitals configured the scripts refuse to guess and list them. `hospital_config()` returns the file's settings
(the `hospital_servers` block, the hospital's name and language) for the scripts that need more than the id.
`parameter(name)` reads one of the deployment's SSM parameters (`/medapp/<hospital_id>/…`) and, when it is not there,
says in which account and region it looked — the usual cause being a different profile from the one `cdk deploy` used.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
if str(INFRA) not in sys.path:
    sys.path.insert(0, str(INFRA))

# The AWS CLI (v2) and the CDK read AWS_REGION, and it overrides AWS_DEFAULT_REGION; boto3 reads AWS_DEFAULT_REGION only and
# otherwise falls back to the profile's region — which silently sends a script to another region than the one `cdk deploy`
# used. Give AWS_REGION the same precedence here, so the CDK and the scripts agree.
if os.environ.get("AWS_REGION"):
    os.environ["AWS_DEFAULT_REGION"] = os.environ["AWS_REGION"]

from stacks.hospitals import HOSPITALS_DIR, ConfigError, HospitalConfig, load_hospitals  # noqa: E402


def hospital_id() -> str:
    """HOSPITAL_ID, or the only configured hospital's id."""
    return hospital_config().hospital_id


def hospital_config() -> HospitalConfig:
    """The selected hospital's settings (infra/hospitals/<id>.json)."""
    wanted = os.environ.get("HOSPITAL_ID", "").strip() or None
    try:
        hospitals = load_hospitals(HOSPITALS_DIR, select=wanted)
    except ConfigError as err:
        raise SystemExit(str(err)) from err
    if len(hospitals) != 1:
        raise SystemExit(f"several hospitals are configured ({', '.join(h.hospital_id for h in hospitals)}): set HOSPITAL_ID to the one this command is for")
    return hospitals[0]


def parameter(name: str, *, ssm=None, hospital: str | None = None) -> str:
    """The value of `/medapp/<hospital_id>/<name>` (or an absolute parameter name), with a useful error when it is missing."""
    import boto3  # noqa: PLC0415
    from botocore.exceptions import ClientError, NoRegionError  # noqa: PLC0415

    hid = hospital or hospital_id()
    full = name if name.startswith("/") else f"/medapp/{hid}/{name}"
    client = ssm or boto3.client("ssm")
    try:
        return str(client.get_parameter(Name=full)["Parameter"]["Value"])
    except NoRegionError as err:
        raise SystemExit("No AWS region is configured: export AWS_REGION=<the deployment's region>.") from err
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ParameterNotFound":
            raise
        session = boto3.session.Session()
        try:
            account = boto3.client("sts").get_caller_identity()["Account"]
        except Exception:  # noqa: BLE001 — the hint is best effort
            account = "?"
        raise SystemExit(
            f"{full} does not exist in account {account}, region {client.meta.region_name} (profile {session.profile_name}).\n"
            f"The stacks of {hid} write it at deploy time, so either this is not the account/region/profile `cdk deploy` ran with — "
            f"set AWS_PROFILE and AWS_REGION to the same values — or {hid}'s stacks are not deployed there yet "
            f"(`aws ssm get-parameters-by-path --path /medapp/{hid} --recursive --query 'Parameters[].Name'` lists what is)."
        ) from err


__all__ = ["hospital_id", "hospital_config", "parameter", "HospitalConfig", "INFRA"]
