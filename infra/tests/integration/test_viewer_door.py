"""
The viewer's door into the PACS, as a browser uses it: the panel's Cognito ID token, plain HTTPS, no SigV4.
Skipped unless a test user is configured:

    export MEDAPP_TEST_USER=you@example.org MEDAPP_TEST_PASSWORD=…     # a user of the deployment's pool (scripts/create-user.sh)
    pytest tests/integration/test_viewer_door.py -v                     # AWS_PROFILE / AWS_REGION as usual; pip install pycognito

What it proves: the door answers QIDO-RS by MRN for a signed-in user and refuses an anonymous one (401); the
same token is not a key to the dispatcher's IAM door (403); a WADO-RS frame of the phantom comes back through
the API as multipart, with its size and round-trip time printed — the number to know before a real PACS.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "lambdas" / "dispatcher"))

USER, PASSWORD = os.environ.get("MEDAPP_TEST_USER"), os.environ.get("MEDAPP_TEST_PASSWORD")
pytestmark = pytest.mark.skipif(not (USER and PASSWORD), reason="MEDAPP_TEST_USER / MEDAPP_TEST_PASSWORD are not set: no Cognito user to open the viewer door with")

HOSPITAL_ID = os.environ.get("HOSPITAL_ID", "hsp-musterstadt")
MRN = "KMS-0048213"
CT_STUDY = "1.2.276.0.7230010.3.1.2.8323329.1001"


def ssm(name: str) -> str:
    import boto3

    return boto3.client("ssm").get_parameter(Name=f"/medapp/{HOSPITAL_ID}/{name}")["Parameter"]["Value"]


@pytest.fixture(scope="module")
def endpoints():
    return {"viewer": os.environ.get("MEDAPP_VIEWER_DICOMWEB_BASE_URL") or ssm("reference/viewer-dicomweb-base-url"), "iam": os.environ.get("MEDAPP_DICOMWEB_BASE_URL") or ssm("reference/dicomweb-base-url")}


@pytest.fixture(scope="module")
def id_token() -> str:
    from pycognito import Cognito

    user = Cognito(ssm("identity/user-pool-id"), ssm("identity/web-client-id"), username=USER)
    user.authenticate(password=PASSWORD)
    return str(user.id_token)


def get(url: str, token: str | None = None, accept: str = "application/dicom+json") -> tuple[int, bytes, dict[str, str], float]:
    from fhir_source import default_ssl_context

    headers = {"accept": accept}
    if token:
        headers["authorization"] = f"Bearer {token}"
    started = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60, context=default_ssl_context()) as res:  # noqa: S310
            body = res.read()
            return res.status, body, {k.lower(): v for k, v in res.headers.items()}, time.monotonic() - started
    except urllib.error.HTTPError as err:
        return err.code, err.read(), {k.lower(): v for k, v in err.headers.items()}, time.monotonic() - started


def test_a_signed_in_user_reads_the_pacs_through_the_viewer_door(endpoints, id_token):
    status, body, headers, _ = get(f"{endpoints['viewer']}/studies?PatientID={MRN}&includefield=StudyDescription", id_token)
    assert status == 200, body[:300]
    studies = json.loads(body)
    assert {s["0020000D"]["Value"][0] for s in studies} == {CT_STUDY, "1.2.276.0.7230010.3.1.2.8323329.1002"}
    assert "application/dicom+json" in headers.get("content-type", "")


def test_the_door_refuses_anonymous_and_the_iam_door_refuses_the_token(endpoints, id_token):
    status, _, _, _ = get(f"{endpoints['viewer']}/studies?PatientID={MRN}")
    assert status == 401
    status, _, _, _ = get(f"{endpoints['iam']}/studies?PatientID={MRN}", id_token)
    assert status == 403, "a Cognito token is not a SigV4 signature: the dispatcher's door stays closed to browsers"


def test_a_frame_of_the_phantom_comes_back_through_the_api(endpoints, id_token):
    status, body, _, _ = get(f"{endpoints['viewer']}/studies/{CT_STUDY}/series", id_token)
    assert status == 200
    series = json.loads(body)
    axial = next(s for s in series if s.get("0008103E", {}).get("Value", [""])[0].startswith("Thorax axial"))
    series_uid = axial["0020000E"]["Value"][0]
    status, body, _, _ = get(f"{endpoints['viewer']}/studies/{CT_STUDY}/series/{series_uid}/metadata", id_token)
    assert status == 200 and len(json.loads(body)) == 350, "full metadata of the 350-slice series in one response"
    instance_uid = json.loads(body)[0]["00080018"]["Value"][0]
    status, frame, headers, seconds = get(f"{endpoints['viewer']}/studies/{CT_STUDY}/series/{series_uid}/instances/{instance_uid}/frames/1", id_token, accept='multipart/related; type="application/octet-stream"')
    assert status == 200 and "multipart/related" in headers.get("content-type", "")
    assert len(frame) >= 256 * 256 * 2, "the 256×256 16-bit frame plus the multipart envelope"
    print(f"\nWADO-RS frame through the API: {len(frame)} bytes in {seconds * 1000:.0f} ms")
