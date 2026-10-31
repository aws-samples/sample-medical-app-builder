#!/usr/bin/env python3
"""
Seed (or reset) the reference FHIR server with the synthetic record, and check that it answers the
questions the primitives ask.

    scripts/seed-reference.py                       # load the bundle, then verify FHIR and the PACS
    scripts/seed-reference.py --verify-only         # only the checks (nothing written)
    scripts/seed-reference.py --bundle other.json   # a different seed (same shape: a Bundle of resources with ids)

The endpoints are the reference stack's, from SSM (/medapp/<HOSPITAL_ID>/reference/fhir-base-url and
…/dicomweb-base-url) unless --base-url / --dicomweb-url are given. The PACS is not seeded from here — its
studies are generated at synth and copied into the task at start (docs/reference-servers.md) — only checked:
every study the record declares must come back from QIDO-RS by the patient's MRN. Requests are signed with your AWS credentials (AWS_PROFILE / AWS_REGION as usual):
the API in front of the server only admits IAM identities allowed to invoke it — the dispatcher's role, and you.

Re-running is a reset: every seeded resource is PUT back to its seeded content (a new version on the server
when a demo changed it, a no-op otherwise). Resources a demo created — recorded readings, Provenance — stay.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA))  # medapp_shared
sys.path.insert(0, str(INFRA / "lambdas" / "dispatcher"))  # fhir_source, seed
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

import boto3  # noqa: E402

import seed as seeding  # noqa: E402
from dicomweb import DicomWebSource  # noqa: E402
from fhir_source import HttpFhirSource  # noqa: E402
from medapp_shared.sigv4 import SigV4Signer  # noqa: E402
from _hospital import hospital_id as selected_hospital, parameter  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.environ.get("MEDAPP_FHIR_BASE_URL"), help="FHIR base URL (default: SSM lookup)")
    ap.add_argument("--bundle", default=None, help="path of the seed bundle (default: the dispatcher's synthetic bundle)")
    ap.add_argument("--dicomweb-url", default=os.environ.get("MEDAPP_DICOMWEB_BASE_URL"), help="DICOMweb base URL of the PACS to check (default: SSM lookup; none = skip)")
    ap.add_argument("--verify-only", action="store_true", help="run the checks without writing")
    args = ap.parse_args()

    session = boto3.session.Session()
    hospital_id = selected_hospital()
    ssm = session.client("ssm")
    base_url = args.base_url or parameter("reference/fhir-base-url", ssm=ssm, hospital=hospital_id)
    signer = SigV4Signer(service="execute-api", region=session.region_name, credentials=session.get_credentials())
    source = HttpFhirSource(base_url, timeout_s=60.0, signer=signer)

    # The PACS, when the deployment has one (the reference stack publishes its URL; a hospital gateway is --dicomweb-url).
    dicomweb_url = args.dicomweb_url
    if dicomweb_url is None and not args.base_url:
        try:
            dicomweb_url = ssm.get_parameter(Name=f"/medapp/{hospital_id}/reference/dicomweb-base-url")["Parameter"]["Value"]
        except ssm.exceptions.ParameterNotFound:
            dicomweb_url = None
    dicom = DicomWebSource(dicomweb_url, timeout_s=60.0, signer=signer) if dicomweb_url else None

    print(f"FHIR server: {base_url}")
    capability = source.capability_statement()
    print(f"  {capability.get('software', {}).get('name', '?')} {capability.get('software', {}).get('version', '')} · FHIR {capability.get('fhirVersion', '?')}")
    if dicom is not None:
        print(f"PACS (DICOMweb): {dicomweb_url}")

    bundle = seeding.load_bundle(args.bundle)
    if args.verify_only:
        findings = seeding.verify(source) + (seeding.verify_dicom(dicom, bundle) if dicom is not None else [])
    else:
        report = seeding.seed(source, bundle, dicom=dicom)
        print(f"  seeded {report.total} resources: {report.created} created, {report.updated} updated or unchanged")
        for failure in report.failed:
            print(f"  FAILED {failure}")
        findings = report.findings
        if report.failed:
            return 1

    if findings:
        print("  the servers do not answer these as the primitives expect:")
        for finding in findings:
            print(f"    - {finding}")
        return 2
    checks = len(seeding.VERIFICATIONS) + 1 + (len(seeding.expected_dicom_studies(bundle)) if dicom is not None else 0)
    print(f"  all {checks} checks passed" + (" (FHIR and PACS)" if dicom is not None else " (FHIR; no PACS configured)"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # noqa: BLE001 — a script: say what went wrong and exit non-zero
        print(f"error: {err}", file=sys.stderr)
        if hasattr(err, "status") and getattr(err, "status") == 403:
            print("       (403 from the API: your credentials are not allowed to invoke it — check AWS_PROFILE/AWS_REGION)", file=sys.stderr)
        sys.exit(1)
