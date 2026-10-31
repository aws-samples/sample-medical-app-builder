#!/usr/bin/env python3
"""
Read from the reference FHIR server as yourself — requests signed the way the dispatcher signs them.

    scripts/fhir-get.py Patient/pat-kms-0001
    scripts/fhir-get.py 'Provenance?_sort=-recorded&_count=3'          # who wrote what, most recent first
    scripts/fhir-get.py Condition/cond-kms-0003/_history              # every version of a record
    scripts/fhir-get.py 'Observation?patient=pat-kms-0001&combo-code=http://loinc.org|8480-6&_sort=-date&_count=2'
    scripts/fhir-get.py metadata --summary                              # what the server says it is
    scripts/fhir-get.py --dicomweb 'studies?PatientID=KMS-0048213' --summary   # the PACS, QIDO-RS by MRN
    scripts/fhir-get.py --dicomweb 'studies/1.2.276.0.7230010.3.1.2.8323329.1001/series' --summary

Prints the JSON (pipe into jq); --summary prints one line per entry of a Bundle (or per DICOM JSON result) instead. The base URL comes
from SSM (/medapp/<HOSPITAL_ID>/reference/fhir-base-url) unless --base-url or MEDAPP_FHIR_BASE_URL is set;
credentials and region as for any AWS call (AWS_PROFILE / AWS_REGION — the same chain boto3 uses, so what works
for the AWS CLI works here). GET only.

    scripts/fhir-get.py --hospital 'Patient?_summary=count'              # the hospital's server instead: OAuth2 client credentials
    scripts/fhir-get.py --hospital --dicomweb 'studies?limit=5' --summary

--hospital reads the token URL, scope and the credentials secret's name from SSM (/medapp/<HOSPITAL_ID>/hospital/*),
the secret itself from Secrets Manager, and sends a bearer token exactly as the dispatcher does. Set
MEDAPP_HOSPITAL_CLIENT_ID / MEDAPP_HOSPITAL_CLIENT_SECRET to use credentials from your shell instead of the secret.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA))  # medapp_shared
sys.path.insert(0, str(INFRA / "lambdas" / "dispatcher"))  # fhir_source
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

import boto3  # noqa: E402

from dicomweb import INCLUDE_FIELDS, TAG_DESCRIPTION, TAG_MODALITIES, TAG_N_INSTANCES, TAG_N_SERIES, TAG_PATIENT_ID, TAG_PATIENT_NAME, TAG_STUDY_DATE, TAG_STUDY_UID, DicomWebSource, value, values  # noqa: E402
from fhir_source import HttpFhirSource, UpstreamError, resource_date  # noqa: E402
from medapp_shared.oauth2 import ClientCredentials, Credentials, credentials_from_secret  # noqa: E402
from medapp_shared.sigv4 import SigV4Signer  # noqa: E402
from _hospital import hospital_id as selected_hospital, parameter  # noqa: E402


def one_line(resource: dict) -> str:
    rt, rid = resource.get("resourceType", "?"), resource.get("id", "?")
    meta = resource.get("meta") or {}
    when = resource.get("recorded") or resource_date(resource) or meta.get("lastUpdated") or ""
    detail = ""
    if rt == "Provenance":
        targets = ", ".join(t.get("reference", "?") for t in resource.get("target", []))
        who = next((a.get("who", {}).get("identifier", {}).get("value") or a.get("who", {}).get("display") for a in resource.get("agent", [])), "?")
        activity = ((resource.get("activity") or {}).get("coding") or [{}])[0].get("code", "")
        detail = f"{activity} {targets} by {who}"
    elif rt == "Observation":
        parts = [f"{c.get('valueQuantity', {}).get('value')}" for c in resource.get("component", [])] or [str((resource.get("valueQuantity") or {}).get("value"))]
        detail = f"{(resource.get('code') or {}).get('text') or ((resource.get('code') or {}).get('coding') or [{}])[0].get('display', '')} {'/'.join(parts)}"
    elif rt == "Condition":
        detail = f"{((resource.get('code') or {}).get('text') or '')} · {(((resource.get('clinicalStatus') or {}).get('coding') or [{}])[0]).get('code', '')}"
    elif rt == "MedicationRequest":
        detail = f"{((resource.get('medicationCodeableConcept') or {}).get('text') or '')} · {resource.get('status', '')}"
    return f"{rt}/{rid} v{meta.get('versionId', '?')} {when} {detail}".rstrip()


def dicom_line(result: dict) -> str:
    """One QIDO-RS result (study, series or instance level) on one line."""
    uid = value(result, TAG_STUDY_UID) or value(result, "0020000E") or value(result, "00080018") or "?"
    parts = [str(uid)]
    if value(result, TAG_STUDY_DATE):
        parts.append(str(value(result, TAG_STUDY_DATE)))
    if values(result, TAG_MODALITIES) or value(result, "00080060"):
        parts.append("/".join(str(m) for m in (values(result, TAG_MODALITIES) or [value(result, "00080060")])))
    if value(result, TAG_PATIENT_ID):
        parts.append(f"{value(result, TAG_PATIENT_NAME) or ''} [{value(result, TAG_PATIENT_ID)}]".strip())
    if value(result, TAG_DESCRIPTION) or value(result, "0008103E"):
        parts.append(str(value(result, TAG_DESCRIPTION) or value(result, "0008103E")))
    if value(result, TAG_N_SERIES) is not None or value(result, TAG_N_INSTANCES) is not None:
        parts.append(f"{value(result, TAG_N_SERIES) or '?'} series · {value(result, TAG_N_INSTANCES) or '?'} instances")
    return " · ".join(parts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="path under the FHIR base, e.g. Patient/pat-kms-0001 or 'Provenance?_count=3'")
    ap.add_argument("--base-url", default=os.environ.get("MEDAPP_FHIR_BASE_URL"), help="FHIR base URL (default: SSM lookup)")
    ap.add_argument("--summary", action="store_true", help="one line per Bundle entry instead of the JSON")
    ap.add_argument("--dicomweb", action="store_true", help="query the PACS (DICOMweb base URL from SSM …/dicomweb-base-url or MEDAPP_DICOMWEB_BASE_URL) instead of the FHIR server")
    ap.add_argument("--hospital", action="store_true", help="the hospital's servers (SSM /medapp/<HOSPITAL_ID>/hospital/*, OAuth2 client credentials) instead of the reference servers")
    args = ap.parse_args()

    session = boto3.session.Session()
    hospital_id = selected_hospital()
    ssm = session.client("ssm")
    prefix = f"/medapp/{hospital_id}/{'hospital' if args.hospital else 'reference'}"
    auth: dict = {}
    if args.hospital:
        token_url = parameter(f"{prefix}/token-url", ssm=ssm, hospital=hospital_id)
        try:
            scope = parameter(f"{prefix}/oauth-scope", ssm=ssm, hospital=hospital_id)
        except ssm.exceptions.ParameterNotFound:
            scope = None
        if os.environ.get("MEDAPP_HOSPITAL_CLIENT_ID") and os.environ.get("MEDAPP_HOSPITAL_CLIENT_SECRET"):
            credentials: Credentials | object = Credentials(os.environ["MEDAPP_HOSPITAL_CLIENT_ID"], os.environ["MEDAPP_HOSPITAL_CLIENT_SECRET"])
        else:
            secret_name = parameter(f"{prefix}/credentials-secret", ssm=ssm, hospital=hospital_id)
            credentials = credentials_from_secret(secret_name, session.client("secretsmanager"))
        auth = {"token_provider": ClientCredentials(token_url, credentials, scope=scope)}  # type: ignore[arg-type]
    else:
        auth = {"signer": SigV4Signer(service="execute-api", region=session.region_name, credentials=session.get_credentials())}
    if args.dicomweb:
        base_url = os.environ.get("MEDAPP_DICOMWEB_BASE_URL") or parameter(f"{prefix}/dicomweb-base-url", ssm=ssm, hospital=hospital_id)
        path, _, query = args.path.partition("?")
        params = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        # Study searches ask for the same extra attributes the dispatcher asks for (description, modalities, counts).
        include = INCLUDE_FIELDS if path.rstrip("/") == "studies" else ()
        results = DicomWebSource(base_url, timeout_s=60.0, **auth)._qido(path, params, include=include)  # noqa: SLF001 — the client's QIDO call, any level
        if args.summary:
            print(f"{len(results)} results")
            for r in results:
                print("  " + dicom_line(r))
        else:
            print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0
    base_url = args.base_url or parameter(f"{prefix}/fhir-base-url", ssm=ssm, hospital=hospital_id)
    source = HttpFhirSource(base_url, timeout_s=60.0, **auth)

    result = source.get(args.path)
    if args.summary and result.get("resourceType") == "Bundle":
        entries = result.get("entry") or []
        print(f"{result.get('type')} · {result.get('total', len(entries))} total, {len(entries)} shown")
        for e in entries:
            print("  " + one_line(e.get("resource") or {}))
    elif args.summary and result.get("resourceType") == "CapabilityStatement":
        software = result.get("software") or {}
        print(f"{software.get('name', '?')} {software.get('version', '')} · FHIR {result.get('fhirVersion', '?')} · {len((result.get('rest') or [{}])[0].get('resource', []))} resource types")
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except UpstreamError as err:
        print(f"error: {err}", file=sys.stderr)
        if err.status == 403:
            print("       403 from the API: these credentials may not invoke it (AWS_PROFILE / AWS_REGION?), or the signature was not accepted", file=sys.stderr)
        sys.exit(1)
    except Exception as err:  # noqa: BLE001 — a script: say what went wrong and exit non-zero
        print(f"error: {err}", file=sys.stderr)
        sys.exit(1)
