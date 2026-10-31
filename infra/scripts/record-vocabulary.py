#!/usr/bin/env python3
"""
The record vocabulary — the codes a FHIR server actually holds — built, uploaded, inspected or searched by hand.

    scripts/record-vocabulary.py --hospital --out vocab.json           # read the hospital's record → a local document
    scripts/record-vocabulary.py --hospital --upload                    # … and store it where the deployed agent reads it
    scripts/record-vocabulary.py --out vocab.json                       # the reference servers (SigV4) instead
    scripts/record-vocabulary.py --bundle --out app_creator/eval/record-vocabulary.synthetic.json   # the synthetic bundle, no AWS
    scripts/record-vocabulary.py --find Hämoglobin                      # search the deployed document (or --file vocab.json)
    scripts/record-vocabulary.py --show                                 # when it was built, how much it holds, per type

The deployed document is written by the data source's seed at deploy and every night (03:20 UTC); this script is for
looking at it, for refreshing it right after the record changed, and for feeding the harness and the evaluation corpus
(`MEDAPP_VOCABULARY_FILE=vocab.json python -m app_creator.harness`). --hospital uses the stored client credentials like
fhir-get.py (SSM /medapp/<HOSPITAL_ID>/hospital/*, Secrets Manager); MEDAPP_HOSPITAL_CLIENT_ID / _SECRET override.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INFRA))  # medapp_shared, app_creator
sys.path.insert(0, str(INFRA / "lambdas" / "dispatcher"))  # fhir_source, vocabulary, seed
sys.path.insert(0, str(Path(__file__).resolve().parent))  # _hospital: which hospital (HOSPITAL_ID, or the only one configured)

from app_creator.vocabulary import RecordVocabulary  # noqa: E402
from fhir_source import HttpFhirSource, InMemoryFhirSource  # noqa: E402
from vocabulary import DEFAULT_KEY, build_vocabulary, store_vocabulary, summarize  # noqa: E402
from _hospital import hospital_id as selected_hospital, parameter  # noqa: E402


def source_for(args: argparse.Namespace, session):  # type: ignore[no-untyped-def]
    """The FHIR source the document is read from: the bundle, the hospital's server, or the reference server."""
    if args.bundle:
        from seed import load_bundle

        return InMemoryFhirSource([e["resource"] for e in load_bundle()["entry"]])
    from medapp_shared.oauth2 import ClientCredentials, Credentials, credentials_from_secret
    from medapp_shared.sigv4 import SigV4Signer

    hospital_id = selected_hospital()
    ssm = session.client("ssm")
    prefix = f"/medapp/{hospital_id}/{'hospital' if args.hospital else 'reference'}"
    if args.hospital:
        token_url = parameter(f"{prefix}/token-url", ssm=ssm, hospital=hospital_id)
        try:
            scope = parameter(f"{prefix}/oauth-scope", ssm=ssm, hospital=hospital_id)
        except ssm.exceptions.ParameterNotFound:
            scope = None
        if os.environ.get("MEDAPP_HOSPITAL_CLIENT_ID") and os.environ.get("MEDAPP_HOSPITAL_CLIENT_SECRET"):
            credentials = Credentials(os.environ["MEDAPP_HOSPITAL_CLIENT_ID"], os.environ["MEDAPP_HOSPITAL_CLIENT_SECRET"])
        else:
            credentials = credentials_from_secret(parameter(f"{prefix}/credentials-secret", ssm=ssm, hospital=hospital_id), session.client("secretsmanager"))
        auth = {"token_provider": ClientCredentials(token_url, credentials, scope=scope)}
    else:
        auth = {"signer": SigV4Signer(service="execute-api", region=session.region_name, credentials=session.get_credentials())}
    base_url = args.base_url or parameter(f"{prefix}/fhir-base-url", ssm=ssm, hospital=hospital_id)
    return HttpFhirSource(base_url, timeout_s=120.0, **auth)  # type: ignore[arg-type]


def deployed_bucket(session) -> str:  # type: ignore[no-untyped-def]
    hospital_id = selected_hospital()
    return str(parameter(f"/medapp/{hospital_id}/authoring/vocabulary-bucket", hospital=hospital_id))


def load_document(args: argparse.Namespace, session) -> dict:  # type: ignore[no-untyped-def]
    if args.file:
        return json.loads(Path(args.file).read_text(encoding="utf-8"))
    body = session.client("s3").get_object(Bucket=deployed_bucket(session), Key=DEFAULT_KEY)["Body"].read()
    return json.loads(body.decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    where = ap.add_mutually_exclusive_group()
    where.add_argument("--hospital", action="store_true", help="read the hospital's server (OAuth2 client credentials from Secrets Manager)")
    where.add_argument("--bundle", action="store_true", help="read the synthetic bundle shipped with the dispatcher — no AWS needed")
    ap.add_argument("--base-url", default=os.environ.get("MEDAPP_FHIR_BASE_URL"), help="FHIR base URL (default: SSM lookup)")
    ap.add_argument("--budget", type=float, default=600.0, help="seconds the scan may take (default 600; the deployed seed uses 150, the nightly refresh 240)")
    ap.add_argument("--out", help="write the document here")
    ap.add_argument("--upload", action="store_true", help="store the document in the deployment's bucket (SSM …/authoring/vocabulary-bucket) — the agent picks it up within the hour")
    ap.add_argument("--file", help="an existing document for --find/--show instead of the deployed one")
    ap.add_argument("--find", metavar="TERM", help="search a document by display text (any spelling) or code and exit")
    ap.add_argument("--show", action="store_true", help="print a document's summary and exit")
    args = ap.parse_args()

    session = None
    if not args.bundle or args.upload or ((args.find or args.show) and not args.file):
        import boto3

        session = boto3.session.Session()

    if args.find or args.show:
        doc = load_document(args, session)
        vocabulary = RecordVocabulary(doc)
        print(f"built {vocabulary.built_at} from {vocabulary.source or 'the bundle'} · {summarize(doc)}")
        if args.show:
            for resource, n in sorted(vocabulary.by_resource().items(), key=lambda kv: -kv[1]):
                systems = ", ".join(sorted(vocabulary.systems_by_resource().get(resource, set())))
                print(f"  {resource:20} {n:5} codes   {systems}")
        if args.find:
            hits = vocabulary.find(args.find, limit=40)
            print(f"{len(hits)} match{'es' if len(hits) != 1 else ''} for {args.find!r}")
            for h in hits:
                extra = f" · {h.unit}" if h.unit else ""
                extra += f" · {h.category}" if h.category else ""
                extra += f" · components {', '.join(h.components)}" if h.components else ""
                extra += f" · component of {', '.join(h.component_of)}" if h.component_of else ""
                print(f"  {h.resource:18} {h.system:42} {h.code:12} n={h.count:<6} patients={h.patients:<4} {h.display}{extra}")
        return 0

    source = source_for(args, session)
    doc = build_vocabulary(source, budget_s=args.budget)
    print(summarize(doc), file=sys.stderr)
    for note in doc.get("notes") or []:
        print(f"  note: {note}", file=sys.stderr)
    if args.out:
        Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"written to {args.out}", file=sys.stderr)
    if args.upload:
        uri = store_vocabulary(doc, deployed_bucket(session), client=session.client("s3"))
        print(f"stored at {uri}", file=sys.stderr)
    if not args.out and not args.upload:
        print(json.dumps(doc, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
