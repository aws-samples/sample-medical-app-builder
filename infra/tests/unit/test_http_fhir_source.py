"""
The HTTP FHIR client and the seed, against a local FHIR server that speaks the REST subset a real one does:
paged searchsets with `next` links, conditional create (If-None-Exist → 200 with the existing resource),
versioned update (If-Match → 409 with an OperationOutcome), transactions, OperationOutcome on bad requests.
The server keeps its data in the in-memory source, so the seed's verification questions have the same answers
the reference server must give — apply → verify runs end to end here, HAPI only has to agree.
"""

import json
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))

import seed as seeding  # noqa: E402
from fhir_source import ConditionalCreateAmbiguous, HttpFhirSource, InMemoryFhirSource, UpstreamError, VersionConflict, http_source_from_env, operation_outcome_text  # noqa: E402
from medapp_shared.sigv4 import SigV4Signer  # noqa: E402


def outcome(status: int, text: str) -> bytes:
    return json.dumps({"resourceType": "OperationOutcome", "issue": [{"severity": "error", "code": "processing", "diagnostics": text}]}).encode()


class FakeFhirServer:
    """A FHIR endpoint over an InMemoryFhirSource; records every request it saw."""

    def __init__(self) -> None:
        self.store = InMemoryFhirSource([], id_factory=self._next_id)
        self.requests: list[dict] = []
        self._counter = 0
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):  # quiet
                pass

            def _reply(self, status: int, body: bytes, headers: dict | None = None):
                self.send_response(status)
                self.send_header("content-type", "application/fhir+json")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def _record(self, body: bytes | None):
                server.requests.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})

            def do_GET(self):
                self._record(None)
                parsed = urllib.parse.urlparse(self.path)
                parts = parsed.path.split("/")[2:]  # ['Type', 'id'] under /fhir
                params = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                if parts == ["metadata"]:
                    return self._reply(200, json.dumps({"resourceType": "CapabilityStatement", "fhirVersion": "4.0.1", "software": {"name": "fake"}}).encode())
                if "bad" in params:
                    return self._reply(400, outcome(400, "Unknown search parameter 'bad'"))
                if len(parts) == 2:
                    found = server.store.read(parts[0], parts[1])
                    return self._reply(200, json.dumps(found).encode()) if found else self._reply(404, outcome(404, f"{parts[0]}/{parts[1]} is not known"))
                offset = int(params.pop("_offset", "0"))
                count = int(params.get("_count", "0") or 0)
                page_params = {k: v for k, v in params.items() if k != "_count"}
                everything = server.store.search(parts[0], page_params)
                page = everything[offset : offset + count] if count else everything
                bundle = {"resourceType": "Bundle", "type": "searchset", "total": len(everything), "entry": [{"resource": r} for r in page], "link": []}
                if count and offset + count < len(everything):
                    query = urllib.parse.urlencode({**params, "_offset": str(offset + count)}, quote_via=urllib.parse.quote)
                    bundle["link"].append({"relation": "next", "url": f"http://{self.headers['host']}/fhir/{parts[0]}?{query}"})
                return self._reply(200, json.dumps(bundle).encode())

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                self._record(body)
                resource = json.loads(body)
                parts = urllib.parse.urlparse(self.path).path.split("/")[2:]
                if not parts or parts == [""]:  # transaction on the base
                    entries = []
                    for entry in resource.get("entry", []):
                        r, req = entry["resource"], entry["request"]
                        existed = server.store.read(r["resourceType"], r["id"]) is not None
                        stored = dict(r)
                        stored["meta"] = {"versionId": "1"}
                        server.store._add(stored)  # PUT as create keeps the id
                        entries.append({"response": {"status": "200 OK" if existed else "201 Created", "location": f"{req['url']}/_history/1"}})
                    return self._reply(200, json.dumps({"resourceType": "Bundle", "type": "transaction-response", "entry": entries}).encode())
                if_none_exist = self.headers.get("if-none-exist")
                condition = dict(urllib.parse.parse_qsl(if_none_exist)) if if_none_exist else None
                if condition:
                    existing = server.store.search(parts[0], condition)
                    if len(existing) > 1:
                        return self._reply(412, outcome(412, "multiple matches"))
                    if existing:
                        return self._reply(200, json.dumps(existing[0]).encode(), {"location": f"/fhir/{parts[0]}/{existing[0]['id']}"})
                created = server.store.create(resource)
                return self._reply(201, json.dumps(created).encode(), {"location": f"/fhir/{parts[0]}/{created['id']}/_history/1", "etag": 'W/"1"'})

            def do_PUT(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                self._record(body)
                resource = json.loads(body)
                if_match = self.headers.get("if-match")
                version = if_match.strip().removeprefix("W/").strip('"') if if_match else None
                try:
                    updated = server.store.update(resource, if_match=version)
                except VersionConflict as err:
                    return self._reply(409, outcome(409, str(err)))
                except LookupError:
                    # Update-as-create, as HAPI does: a PUT to an id nobody has yet creates the resource (201).
                    if version is not None:
                        return self._reply(404, outcome(404, f"{resource.get('resourceType')}/{resource.get('id')} is not known"))
                    created = dict(resource, meta={**(resource.get("meta") or {}), "versionId": "1"})
                    server.store._add(created)  # noqa: SLF001
                    return self._reply(201, json.dumps(created).encode(), {"etag": 'W/"1"'})
                return self._reply(200, json.dumps(updated).encode(), {"etag": f'W/"{updated["meta"]["versionId"]}"'})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def _next_id(self, resource_type: str) -> str:
        self._counter += 1
        return f"{self._counter}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.httpd.shutdown()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/fhir"


@pytest.fixture
def server():
    with FakeFhirServer() as s:
        yield s


def test_search_follows_next_links_and_sends_sort_and_count(server):
    for i in range(7):
        server.store._add({"resourceType": "Observation", "id": f"o{i}", "subject": {"reference": "Patient/p1"}, "effectiveDateTime": f"2026-01-0{i + 1}"})
    source = HttpFhirSource(server.base_url)
    found = source.search("Observation", {"patient": "p1", "_sort": "-date", "_count": "3"})
    assert [o["id"] for o in found] == ["o6", "o5", "o4", "o3", "o2", "o1", "o0"], "three pages, newest first, all followed"
    first = server.requests[0]
    assert "_sort=-date" in first["path"] and "_count=3" in first["path"]
    assert len([r for r in server.requests if r["method"] == "GET"]) == 3
    # HAPI would otherwise answer an identical search from a result set up to a minute old (its default
    # reuse_cached_search_results_millis) — an assessment just recorded would not be in "earlier assessments". Every
    # page of a search asks for a fresh answer; a read by id has no such cache and sends no such header.
    assert all(r["headers"].get("cache-control") == "no-cache" for r in server.requests if r["method"] == "GET"), "searches bypass the server's result cache"
    server.requests.clear()
    source.read("Observation", "o1")
    assert server.requests[-1]["method"] == "GET" and "cache-control" not in server.requests[-1]["headers"]


def test_read_returns_none_for_404_and_raises_upstream_error_with_the_operation_outcome_text(server):
    source = HttpFhirSource(server.base_url)
    assert source.read("Patient", "nobody") is None
    with pytest.raises(UpstreamError) as err:
        source.search("Observation", {"bad": "1"})
    assert err.value.status == 400 and "Unknown search parameter 'bad'" in str(err.value)
    assert err.value.method == "GET" and "/Observation?" in err.value.url


def test_conditional_create_is_idempotent_and_versioned_update_conflicts(server):
    source = HttpFhirSource(server.base_url)
    obs = {"resourceType": "Observation", "identifier": [{"system": "urn:medapp:submission", "value": "s-1"}], "code": {"coding": [{"code": "x"}]}, "subject": {"reference": "Patient/p1"}}
    first = source.create(obs, if_none_exist={"identifier": "urn:medapp:submission|s-1"})
    second = source.create(obs, if_none_exist={"identifier": "urn:medapp:submission|s-1"})
    assert first["id"] == second["id"] == "1"
    assert server.requests[0]["headers"]["if-none-exist"] == "identifier=urn%3Amedapp%3Asubmission%7Cs-1"
    assert server.requests[0]["headers"]["prefer"] == "return=representation"

    server.store._add({"resourceType": "Condition", "id": "c1", "subject": {"reference": "Patient/p1"}, "clinicalStatus": {"coding": [{"code": "active"}]}, "meta": {"versionId": "1"}})
    updated = source.update({"resourceType": "Condition", "id": "c1", "subject": {"reference": "Patient/p1"}, "clinicalStatus": {"coding": [{"code": "resolved"}]}}, if_match="1")
    assert updated["meta"]["versionId"] == "2"
    assert server.requests[-1]["headers"]["if-match"] == 'W/"1"'
    with pytest.raises(VersionConflict):
        source.update({"resourceType": "Condition", "id": "c1", "clinicalStatus": {"coding": [{"code": "inactive"}]}}, if_match="1")
    with pytest.raises(LookupError):
        source.update({"resourceType": "Condition", "id": "missing"}, if_match="1")
    with pytest.raises(ConditionalCreateAmbiguous):
        server.store._add({"resourceType": "Observation", "id": "dup", "identifier": [{"system": "urn:medapp:submission", "value": "s-1"}]})
        source.create(obs, if_none_exist={"identifier": "urn:medapp:submission|s-1"})


def test_unreachable_server_is_an_upstream_error_not_a_crash():
    source = HttpFhirSource("http://127.0.0.1:9/fhir", timeout_s=0.5)
    with pytest.raises(UpstreamError) as err:
        source.read("Patient", "p1")
    assert err.value.status is None and "unreachable" in str(err.value)


# ── TLS trust ────────────────────────────────────────────────────────────────────────────────


def test_tls_trust_is_never_empty(monkeypatch):
    import ssl

    from fhir_source import _sdk_ca_bundles, default_ssl_context

    assert default_ssl_context().cert_store_stats()["x509_ca"] > 0, "the platform store, or a bundle carried by the SDKs"
    assert any(p.endswith("cacert.pem") or p.endswith(".pem") for p in _sdk_ca_bundles()), "botocore (a dev dependency) carries a bundle"

    # A Python that reads no system store (python.org builds on macOS): the SDK's bundle is loaded instead.
    real = ssl.create_default_context

    def empty_store(cafile=None, **kw):
        return real(cafile=cafile, **kw) if cafile else ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

    monkeypatch.setattr(ssl, "create_default_context", empty_store)
    assert default_ssl_context().cert_store_stats()["x509_ca"] > 0

    # An explicit bundle wins and is the only trust.
    bundle = _sdk_ca_bundles()[0]
    monkeypatch.setenv("FHIR_CA_BUNDLE", bundle)
    monkeypatch.setattr(ssl, "create_default_context", real)
    explicit = default_ssl_context()
    assert explicit.cert_store_stats()["x509_ca"] > 0
    assert HttpFhirSource("https://x/fhir", ca_bundle=bundle).ssl_context.cert_store_stats()["x509_ca"] > 0


def test_a_certificate_that_cannot_be_verified_says_what_to_do(monkeypatch):
    import ssl
    import urllib.request

    failure = ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate")
    failure.verify_message = "unable to get local issuer certificate"

    def refuse(*_args, **_kwargs):
        raise urllib.error.URLError(failure)

    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    source = HttpFhirSource("https://abc.execute-api.eu-central-1.amazonaws.com/fhir")
    with pytest.raises(UpstreamError) as err:
        source.read("Patient", "p1")
    message = str(err.value)
    assert "abc.execute-api.eu-central-1.amazonaws.com" in message and "unable to get local issuer certificate" in message and "FHIR_CA_BUNDLE" in message


def test_seed_loads_the_bundle_as_a_transaction_and_every_verification_answers(server):
    source = HttpFhirSource(server.base_url)
    report = seeding.seed(source)
    assert report.total == 189 and report.created == 189 and report.updated == 0  # 158 + four seed Tasks + three falls screens + two wound photos + a goal and a care plan + eighteen physio measurements (both sides) + two consent decisions
    assert report.failed == [] and report.findings == [], report.findings
    sent = json.loads(server.requests[0]["body"])
    assert sent["type"] == "transaction" and all(e["request"]["method"] == "PUT" and e["request"]["url"] == f"{e['resource']['resourceType']}/{e['resource']['id']}" for e in sent["entry"])
    # Re-running is a reset, not a duplicate.
    again = seeding.seed(source, check=False)
    assert again.created == 0 and again.updated == 189
    assert source.read("Patient", "pat-kms-0001")["identifier"][0]["value"] == "KMS-0048213"


def test_seed_hash_changes_with_the_bundle():
    bundle = seeding.load_bundle()
    h1 = seeding.seed_hash(bundle)
    bundle["entry"][0]["resource"]["name"] = "changed"
    assert seeding.seed_hash(bundle) != h1 and len(h1) == 64


def test_verify_reports_what_a_server_cannot_answer(server):
    source = HttpFhirSource(server.base_url)
    findings = seeding.verify(source)  # nothing seeded
    assert any("Patient/pat-kms-0001" in f for f in findings)
    assert len(findings) == len(seeding.VERIFICATIONS) + 1


def test_operation_outcome_text_is_tolerant():
    assert operation_outcome_text(None) == ""
    assert operation_outcome_text(b"not json") == ""
    assert operation_outcome_text(json.dumps({"resourceType": "Bundle"}).encode()) == ""
    assert operation_outcome_text(json.dumps({"resourceType": "OperationOutcome", "issue": [{"details": {"text": "a"}}, {"diagnostics": "b"}]}).encode()) == "a; b"


# ── signing ─────────────────────────────────────────────────────────────────────────────────


def static_credentials():
    from botocore.credentials import Credentials

    return Credentials("AKIAEXAMPLE", "secret-key-for-tests", "session-token")


def test_sigv4_signer_adds_the_authorization_headers_for_execute_api():
    signer = SigV4Signer(service="execute-api", region="eu-central-1", credentials=static_credentials())
    url = "https://abc.execute-api.eu-central-1.amazonaws.com/fhir/Observation?patient=p1&combo-code=http%3A%2F%2Floinc.org%7C8480-6&_sort=-date"
    headers = signer("GET", url, {"accept": "application/fhir+json"}, None)
    auth = headers["Authorization"]
    assert auth.startswith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/") and "/eu-central-1/execute-api/aws4_request" in auth
    assert "SignedHeaders=" in auth and "host" in auth and "Signature=" in auth
    assert "X-Amz-Date" in headers and headers["X-Amz-Security-Token"] == "session-token"
    assert headers["accept"] == "application/fhir+json", "the headers given are kept"
    # A body is part of the signature; the same request with another body signs differently.
    h1 = signer("POST", url, {"content-type": "application/fhir+json"}, b'{"a":1}')
    h2 = signer("POST", url, {"content-type": "application/fhir+json"}, b'{"a":2}')
    assert h1["Authorization"] != h2["Authorization"]


def test_http_source_applies_the_signer_to_every_request(server):
    seen = []

    def signer(method, url, headers, body):
        seen.append((method, url, body))
        return {**headers, "authorization": f"Signed {method}"}

    source = HttpFhirSource(server.base_url, signer=signer)
    source.read("Patient", "p1")
    source.create({"resourceType": "Observation", "code": {"coding": [{"code": "x"}]}})
    assert [m for m, _, _ in seen] == ["GET", "POST"]
    assert server.requests[0]["headers"]["authorization"] == "Signed GET" and server.requests[1]["headers"]["authorization"] == "Signed POST"


def test_source_from_env_selects_the_authentication(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "eu-central-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.delenv("FHIR_AUTH", raising=False)
    monkeypatch.delenv("FHIR_BEARER_TOKEN", raising=False)
    assert http_source_from_env("https://x/fhir")._signer is None and http_source_from_env("https://x/fhir")._token is None
    monkeypatch.setenv("FHIR_BEARER_TOKEN", "t0k")
    assert http_source_from_env("https://x/fhir")._token == "t0k"
    monkeypatch.setenv("FHIR_AUTH", "sigv4")
    signed = http_source_from_env("https://x/fhir")
    assert isinstance(signed._signer, SigV4Signer) and signed._signer.service == "execute-api" and signed._token is None
    monkeypatch.setenv("FHIR_AUTH", "password")
    with pytest.raises(ValueError):
        http_source_from_env("https://x/fhir")
    monkeypatch.setenv("FHIR_AUTH", "bearer")
    monkeypatch.delenv("FHIR_BEARER_TOKEN")
    with pytest.raises(ValueError):
        http_source_from_env("https://x/fhir")


def test_an_apps_own_forms_are_written_at_publish_and_only_definitions_get_through(monkeypatch):
    """The registry write API hands the published app's Questionnaires to the seed Lambda (`task: definitions`); PUT by id, found by URL afterwards, nothing else written."""
    form = {"resourceType": "Questionnaire", "id": "app-falls-risk.falls-risk", "url": "https://hsp-test.medapp.eu/Questionnaire/app-falls-risk.falls-risk", "version": "1.0.0", "status": "active", "title": "Falls risk screen", "subjectType": ["Patient"], "item": [{"linkId": "fell", "text": "Fallen?", "type": "boolean"}]}
    smuggled = {"resourceType": "Patient", "id": "nope", "name": [{"family": "X"}]}
    with FakeFhirServer() as server:
        source = HttpFhirSource(server.base_url)
        report = seeding.write_definitions(source, [form, smuggled, "garbage"])
        assert report.total == 1 and report.created == 1 and report.failed == [] and report.findings == ["2 resource(s) were not definitions and were not written"]
        assert [r["path"] for r in server.requests if r["method"] == "PUT"] == ["/fhir/Questionnaire/app-falls-risk.falls-risk"]
        assert source.search("Questionnaire", {"url": form["url"]})[0]["title"] == "Falls risk screen"
        again = seeding.write_definitions(source, [dict(form, version="1.1.0", title="Falls risk screen (revised)")])
        assert again.updated == 1 and again.created == 0, "a new app version replaces the form in place: same id, same url"
        assert source.read("Questionnaire", form["id"])["title"] == "Falls risk screen (revised)"
        # The Lambda entry point for the same call, configured as the seed Lambdas are.
        monkeypatch.setenv("FHIR_BASE_URL", server.base_url)
        monkeypatch.setenv("FHIR_AUTH", "none")
        out = seeding.lambda_handler({"task": "definitions", "app_id": "app_falls_risk", "version": "1.1.0", "resources": [form]}, None)
        assert out["definitions"]["updated"] == 1 and out["definitions"]["failed"] == []


def test_definitions_seed_writes_questionnaires_only_and_checks_the_server_answers():
    """A hospital's server gets the apps' definitions, never the synthetic patients; the report says what the server lacks."""
    bundle = seeding.load_bundle()
    items = seeding.definitions(bundle)
    assert items and all(r["resourceType"] in seeding.DEFINITION_TYPES for r in items) and any(r["resourceType"] == "Questionnaire" for r in items)
    with FakeFhirServer() as server:
        source = HttpFhirSource(server.base_url)
        report = seeding.seed_definitions(source, bundle)
        assert report.created == len(items) and report.updated == 0 and report.failed == []
        puts = [r for r in server.requests if r["method"] == "PUT"]
        assert sorted(r["path"] for r in puts) == sorted(f"/fhir/{r['resourceType']}/{r['id']}" for r in items), "one PUT per definition, by id"
        assert not any(r["method"] == "POST" for r in server.requests), "no transaction: the record is not ours to write"
        assert all("Patient" not in r["path"] or r["method"] == "GET" for r in server.requests)
        assert report.findings == ["the server has no Patient resources: apps open on a patient and would find none"], report.findings
        # A second run finds them in place: updates, not creates; and a patient makes the finding go away.
        server.store._add({"resourceType": "Patient", "id": "p1", "meta": {"versionId": "1"}})  # noqa: SLF001
        again = seeding.seed_definitions(source, bundle)
        assert again.updated == len(items) and again.created == 0 and again.findings == []
        questionnaire = next(r for r in items if r["resourceType"] == "Questionnaire")
        assert source.search("Questionnaire", {"url": questionnaire["url"]})[0]["id"] == questionnaire["id"]
