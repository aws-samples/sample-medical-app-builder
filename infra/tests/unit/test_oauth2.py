"""
The hospital gateway's authentication: OAuth 2.0 client credentials. A fake token endpoint hands out short-lived
tokens and a fake FHIR server accepts only the current one — the client caches, renews before expiry, retries once
on a 401, keeps the secret out of its errors, reads the credentials from Secrets Manager, and the DICOMweb client
shares the token and can join studies on the Patient's resource id (what such a PACS holds as PatientID).
"""

import base64
import json
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "lambdas" / "dispatcher"))

from medapp_shared import oauth2  # noqa: E402

import dicomweb  # noqa: E402
import fhir_source  # noqa: E402


class FakeGateway:
    """
    /oauth2/token: client-credentials with HTTP basic auth → a token `t<n>` that expires in `lifetime_s`.
    /fhir/Patient/p1: 200 with a bearer token the endpoint handed out and has not revoked, else 401.
    /dicom-web/studies?PatientID=…: one study for `pat-kms-0001`, 204 otherwise.
    """

    def __init__(self, client_id="cid", client_secret="s3cret", lifetime_s=3600, scope=None):
        self.requests: list[dict] = []
        self.issued: list[str] = []
        self.revoked: set[str] = set()
        self.lifetime_s = lifetime_s
        self.expected_scope = scope
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _json(self, status, payload):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get("content-length") or 0)
                form = urllib.parse.parse_qs(self.rfile.read(length).decode())
                gateway.requests.append({"path": self.path, "form": form, "authorization": self.headers.get("authorization")})
                expected = "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
                if self.path != "/oauth2/token" or self.headers.get("authorization") != expected:
                    return self._json(401, {"error": "invalid_client"})
                if form.get("grant_type") != ["client_credentials"] or (gateway.expected_scope and form.get("scope") != [gateway.expected_scope]):
                    return self._json(400, {"error": "invalid_grant", "error_description": "scope or grant type"})
                token = f"t{len(gateway.issued) + 1}"
                gateway.issued.append(token)
                return self._json(200, {"access_token": token, "expires_in": gateway.lifetime_s, "token_type": "Bearer"})

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                auth = self.headers.get("authorization") or ""
                gateway.requests.append({"path": parsed.path, "query": parsed.query, "authorization": auth})
                token = auth[7:] if auth.startswith("Bearer ") else None
                if token not in gateway.issued or token in gateway.revoked:
                    return self._json(401, {"message": "Unauthorized"})
                if parsed.path == "/fhir/Patient/p1":
                    return self._json(200, {"resourceType": "Patient", "id": "p1", "identifier": [{"system": "urn:study-name", "value": "AWS_COHORT"}]})
                if parsed.path == "/dicom-web/studies":
                    params = urllib.parse.parse_qs(parsed.query)
                    if params.get("PatientID") == ["p1"]:
                        return self._json(200, [{"0020000D": {"vr": "UI", "Value": ["1.2.3.4"]}, "00080061": {"vr": "CS", "Value": ["CT"]}, "00080020": {"vr": "DA", "Value": ["20260102"]}}])
                    self.send_response(204)
                    self.end_headers()
                    return None
                return self._json(404, {"message": "no such path"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.httpd.shutdown()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def token_requests(self):
        return [r for r in self.requests if r["path"] == "/oauth2/token"]


@pytest.fixture
def gateway():
    with FakeGateway(scope="fhir/read fhir/write") as g:
        yield g


def test_the_token_is_fetched_once_cached_and_renewed_before_it_expires(gateway):
    now = [1_000.0]
    provider = oauth2.ClientCredentials(f"{gateway.base}/oauth2/token", oauth2.Credentials("cid", "s3cret"), scope="fhir/read fhir/write", clock=lambda: now[0], renew_before_s=120)
    assert provider() == "t1" and provider() == "t1" and provider.fetches == 1, "one request, then the cache"
    request = gateway.token_requests()[0]
    assert request["form"] == {"grant_type": ["client_credentials"], "scope": ["fhir/read fhir/write"]}
    assert request["authorization"].startswith("Basic ") and base64.b64decode(request["authorization"][6:]) == b"cid:s3cret", "HTTP basic with the client id and secret, as the sandbox documents"
    now[0] = 1_000.0 + 3600 - 119  # within two minutes of expiry: renewed ahead of time
    assert provider() == "t2" and provider.fetches == 2
    provider.invalidate()
    assert provider() == "t3", "invalidate forgets the token"


def test_a_refused_token_is_retried_once_with_a_fresh_one(gateway):
    provider = oauth2.ClientCredentials(f"{gateway.base}/oauth2/token", oauth2.Credentials("cid", "s3cret"), scope="fhir/read fhir/write")
    source = fhir_source.HttpFhirSource(f"{gateway.base}/fhir", token_provider=provider)
    assert source.read("Patient", "p1")["id"] == "p1"
    gateway.revoked.add("t1")  # the gateway no longer accepts the token the client still holds
    assert source.read("Patient", "p1")["id"] == "p1"
    reads = [r for r in gateway.requests if r["path"] == "/fhir/Patient/p1"]
    assert [r["authorization"] for r in reads] == ["Bearer t1", "Bearer t1", "Bearer t2"], "one 401, one fresh token, one retry — not a loop"
    gateway.revoked.update({"t2", "t3"})
    with pytest.raises(fhir_source.UpstreamError) as refused:
        source.read("Patient", "p1")
    assert refused.value.status == 401, "a second 401 is the server's answer, reported as such"


def test_token_errors_name_the_endpoint_not_the_secret(gateway):
    wrong = oauth2.ClientCredentials(f"{gateway.base}/oauth2/token", oauth2.Credentials("cid", "wrong-secret"))
    with pytest.raises(oauth2.TokenError) as err:
        wrong()
    assert "401" in str(err.value) and "invalid_client" in str(err.value) and "wrong-secret" not in str(err.value)
    source = fhir_source.HttpFhirSource(f"{gateway.base}/fhir", token_provider=wrong)
    with pytest.raises(fhir_source.UpstreamError) as upstream:
        source.read("Patient", "p1")
    assert "no token for the FHIR server" in str(upstream.value) and "wrong-secret" not in str(upstream.value), "the dispatcher turns it into a 502 with a cause, without the secret"
    unreachable = oauth2.ClientCredentials("http://127.0.0.1:9/oauth2/token", oauth2.Credentials("cid", "s3cret"), timeout_s=2)
    with pytest.raises(oauth2.TokenError) as down:
        unreachable()
    assert "unreachable" in str(down.value)


@mock_aws
def test_credentials_come_from_secrets_manager_and_are_reread_after_a_refusal(gateway, monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-central-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    client = boto3.client("secretsmanager", region_name="eu-central-1")
    client.create_secret(Name="medapp/hsp-test/hospital-client", SecretString=json.dumps({"client_id": "cid", "client_secret": "old-secret"}))
    monkeypatch.setenv("FHIR_TOKEN_URL", f"{gateway.base}/oauth2/token")
    monkeypatch.setenv("FHIR_OAUTH_SCOPE", "fhir/read fhir/write")
    monkeypatch.setenv("FHIR_CREDENTIALS_SECRET", "medapp/hsp-test/hospital-client")
    monkeypatch.delenv("FHIR_CLIENT_ID", raising=False)
    provider = oauth2.ClientCredentials.from_env("FHIR_")
    with pytest.raises(oauth2.TokenError):
        provider()  # the stored secret is stale
    client.put_secret_value(SecretId="medapp/hsp-test/hospital-client", SecretString=json.dumps({"client_id": "cid", "client_secret": "s3cret"}))
    assert provider() == "t1", "the refusal dropped the cached credentials; the rotated secret is read on the next attempt"
    assert provider.credentials() == oauth2.Credentials("cid", "s3cret")

    # The dispatcher's factories: FHIR_AUTH=oauth2 gives the FHIR and DICOMweb clients one shared provider.
    oauth2._shared.clear()  # noqa: SLF001 — process-wide cache
    monkeypatch.setenv("FHIR_AUTH", "oauth2")
    monkeypatch.setenv("DICOMWEB_BASE_URL", f"{gateway.base}/dicom-web")
    monkeypatch.setenv("DICOM_PATIENT_ID_SOURCE", "resource_id")
    monkeypatch.delenv("DICOMWEB_AUTH", raising=False)
    source = fhir_source.http_source_from_env(f"{gateway.base}/fhir")
    dicom = dicomweb.dicomweb_source_from_env()
    assert source._token_provider is dicom._http._token_provider, "one token for both clients"  # noqa: SLF001
    patient = source.read("Patient", "p1")
    studies = dicom.imaging_studies(patient, with_series=False)
    assert [s["identifier"][0]["value"] for s in studies] == ["urn:oid:1.2.3.4"]
    qido = next(r for r in gateway.requests if r["path"] == "/dicom-web/studies")
    assert "PatientID=p1" in qido["query"], "joined on the Patient's resource id, not on the AWS_COHORT identifier"
    assert qido["authorization"].startswith("Bearer t")


def test_env_without_credentials_is_refused_clearly(monkeypatch):
    monkeypatch.setenv("FHIR_TOKEN_URL", "https://example.test/oauth2/token")
    for name in ("FHIR_CREDENTIALS_SECRET", "FHIR_CLIENT_ID", "FHIR_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="FHIR_CREDENTIALS_SECRET"):
        oauth2.ClientCredentials.from_env("FHIR_")
    monkeypatch.delenv("FHIR_TOKEN_URL")
    with pytest.raises(ValueError, match="FHIR_TOKEN_URL"):
        oauth2.ClientCredentials.from_env("FHIR_")
    monkeypatch.setenv("FHIR_TOKEN_URL", "https://example.test/oauth2/token")
    monkeypatch.setenv("FHIR_CLIENT_ID", "cid")
    monkeypatch.setenv("FHIR_CLIENT_SECRET", "s3cret")
    provider = oauth2.ClientCredentials.from_env("FHIR_")
    assert provider.credentials() == oauth2.Credentials("cid", "s3cret") and provider.scope is None


def test_patient_dicom_id_sources():
    patient = {"resourceType": "Patient", "id": "9f39b44f", "identifier": [{"system": "urn:study-name", "value": "AWS_COHORT"}]}
    assert dicomweb.patient_dicom_id(patient, dicomweb.DEFAULT_PATIENT_ID_SYSTEM) == "AWS_COHORT", "the identifier join falls back to the first identifier — wrong for this PACS"
    assert dicomweb.patient_dicom_id(patient, dicomweb.DEFAULT_PATIENT_ID_SYSTEM, source="resource_id") == "9f39b44f"
    assert dicomweb.patient_dicom_id({"resourceType": "Patient"}, "x", source="resource_id") is None
    with pytest.raises(ValueError):
        dicomweb.DicomWebSource("http://x/dicom-web", patient_id_source="mrn")


def test_tls_helper_still_importable_from_the_fhir_client():
    assert fhir_source.default_ssl_context().verify_mode is not None


def test_next_links_are_rebased_onto_the_configured_base():
    source = fhir_source.HttpFhirSource("https://api.example.test/fhir")
    # HAPI behind a gateway that does not know its public address: plain http, same host, a gateway in front of HAPI
    assert source.rebase("http://api.example.test/fhir?_getpages=abc&_getpagesoffset=3") == "https://api.example.test/fhir?_getpages=abc&_getpagesoffset=3"
    # a HAPI without server_address: localhost
    assert source.rebase("http://localhost:8080/fhir/Observation?_count=100&_getpages=x") == "https://api.example.test/fhir/Observation?_count=100&_getpages=x"
    # a link that is already ours is left alone; a relative-looking path gets the base path
    assert source.rebase("https://api.example.test/fhir?_getpages=abc") == "https://api.example.test/fhir?_getpages=abc"
    assert source.rebase("http://other/Patient?_getpages=p") == "https://api.example.test/fhir/Patient?_getpages=p"
    # a base without a path (a server at the root)
    assert fhir_source.HttpFhirSource("https://root.example.test").rebase("http://localhost:8080/Patient?_getpages=p") == "https://root.example.test/Patient?_getpages=p"
    # a gateway without the root route (/fhir/{proxy+} only) → once learned, the root gets a trailing slash
    assert source._is_root_paging("https://api.example.test/fhir?_getpages=abc") and not source._is_root_paging("https://api.example.test/fhir/Patient?_getpages=abc")  # noqa: SLF001
    source._root_paging_slash = True  # noqa: SLF001
    assert source.rebase("http://api.example.test/fhir?_getpages=abc") == "https://api.example.test/fhir/?_getpages=abc"
    assert source.rebase("http://api.example.test/fhir/Patient?_getpages=abc") == "https://api.example.test/fhir/Patient?_getpages=abc"
