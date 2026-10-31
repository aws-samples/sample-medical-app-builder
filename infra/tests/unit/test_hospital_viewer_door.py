"""
The viewer door to the hospital's DICOMweb: the pure-Python RS256 verification of Cognito tokens (kept for the
dispatcher-side checks), and the door Lambda itself — behind the API's JWT authorizer, it forwards each request to
the hospital's gateway with the hospital's token, gzips large JSON, base64-encodes frames, and never lets the user's
token through or the hospital's token out.
"""

import base64
import gzip
import importlib.util
import json
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from joserfc import jwt
from joserfc.jwk import RSAKey

ROOT = Path(__file__).resolve().parents[2]

from medapp_shared import jwt_rs256  # noqa: E402

# Several Lambdas have a `handler.py`; load this one under its own name so the registry/dispatcher tests keep theirs.
_spec = importlib.util.spec_from_file_location("viewer_door_handler", ROOT / "lambdas" / "viewer_door" / "handler.py")
door = importlib.util.module_from_spec(_spec)
sys.modules["viewer_door_handler"] = door
_spec.loader.exec_module(door)  # type: ignore[union-attr]

ISSUER = "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TestPool"
CLIENT = "web-client-id"


@pytest.fixture(scope="module")
def keys():
    signing = RSAKey.generate_key(2048, parameters={"kid": "key-1", "alg": "RS256", "use": "sig"})
    other = RSAKey.generate_key(2048, parameters={"kid": "key-2", "alg": "RS256", "use": "sig"})
    return signing, other


def jwks_for(*keys: RSAKey) -> dict:
    return {"keys": [k.as_dict(private=False) for k in keys]}


def id_token(key: RSAKey, **overrides) -> str:
    now = int(time.time())
    claims = {"sub": "user-1", "iss": ISSUER, "aud": CLIENT, "token_use": "id", "exp": now + 3600, "iat": now, "email": "doc@example.org", **overrides}
    return jwt.encode({"alg": "RS256", "kid": key.kid}, claims, key)


def test_rs256_verification_against_the_pool_jwks(keys):
    signing, other = keys
    jwks = jwt_rs256.JwksCache("https://pool/.well-known/jwks.json", fetch=lambda _url: jwks_for(signing, other))
    token = id_token(signing)
    claims = jwt_rs256.verify_cognito_token(token, jwks, issuer=ISSUER, client_id=CLIENT)
    assert claims["sub"] == "user-1" and claims["email"] == "doc@example.org"

    head, body, sig = token.split(".")
    tampered_body = jwt_rs256.b64url_decode(body).replace(b'"user-1"', b'"user-2"')
    import base64

    forged = ".".join([head, base64.urlsafe_b64encode(tampered_body).decode().rstrip("="), sig])
    with pytest.raises(jwt_rs256.InvalidToken, match="bad signature"):
        jwt_rs256.verify_cognito_token(forged, jwks, issuer=ISSUER, client_id=CLIENT)
    with pytest.raises(jwt_rs256.InvalidToken, match="bad signature"):
        jwt_rs256.verify_cognito_token(id_token(other).rsplit(".", 1)[0] + "." + sig, jwks, issuer=ISSUER, client_id=CLIENT)  # another key's header, this signature
    with pytest.raises(jwt_rs256.InvalidToken, match="expired"):
        jwt_rs256.verify_cognito_token(id_token(signing, exp=int(time.time()) - 120), jwks, issuer=ISSUER, client_id=CLIENT)
    with pytest.raises(jwt_rs256.InvalidToken, match="wrong audience"):
        jwt_rs256.verify_cognito_token(id_token(signing, aud="another-client"), jwks, issuer=ISSUER, client_id=CLIENT)
    with pytest.raises(jwt_rs256.InvalidToken, match="wrong issuer"):
        jwt_rs256.verify_cognito_token(id_token(signing, iss="https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_Other"), jwks, issuer=ISSUER, client_id=CLIENT)
    with pytest.raises(jwt_rs256.InvalidToken, match="not an id token"):
        jwt_rs256.verify_cognito_token(id_token(signing, token_use="access"), jwks, issuer=ISSUER, client_id=CLIENT)
    with pytest.raises(jwt_rs256.InvalidToken, match="not a JWT"):
        jwt_rs256.verify_cognito_token("abc", jwks, issuer=ISSUER, client_id=CLIENT)


def test_unknown_key_ids_trigger_one_more_jwks_fetch_for_rotation(keys):
    signing, other = keys
    served = [jwks_for(signing)]
    fetches = []

    def fetch(url):
        fetches.append(url)
        return served[-1]

    jwks = jwt_rs256.JwksCache("https://pool/.well-known/jwks.json", fetch=fetch)
    jwt_rs256.verify_cognito_token(id_token(signing), jwks, issuer=ISSUER, client_id=CLIENT)
    jwt_rs256.verify_cognito_token(id_token(signing), jwks, issuer=ISSUER, client_id=CLIENT)
    assert len(fetches) == 1, "the keys are cached"
    with pytest.raises(jwt_rs256.InvalidToken, match="unknown signing key"):
        jwt_rs256.verify_cognito_token(id_token(other), jwks, issuer=ISSUER, client_id=CLIENT)
    served.append(jwks_for(signing, other))  # the pool rotated: the new key appears in the JWKS
    jwt_rs256.verify_cognito_token(id_token(other), jwks, issuer=ISSUER, client_id=CLIENT)
    assert len(fetches) == 3



class FakePacs:
    """A DICOMweb that records what it was asked and answers JSON, a frame, 404 or 401 depending on the path."""

    def __init__(self):
        self.requests: list[dict] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                server.requests.append({"path": parsed.path, "query": parsed.query, "headers": {k.lower(): v for k, v in self.headers.items()}})
                accept = self.headers.get("Accept") or ""
                syntax = next((p.strip().split("=", 1)[1] for p in accept.split(";") if p.strip().lower().startswith("transfer-syntax=")), "*")
                gateway_refusal = b'{"message":"Request Entity Too Large"}'  # API Gateway's canned 413, as the hospital's gateway sends it

                def compressed_frame(uid: str, size: int):
                    body = f"--c\r\nContent-Type: application/octet-stream; transfer-syntax={uid}\r\n\r\n".encode() + b"\x01" * size + b"\r\n--c--"
                    self.send_response(200)
                    self.send_header("Content-Type", 'multipart/related; type="application/octet-stream"; boundary=c')
                    return body

                if "/series/dx-jls/" in parsed.path:
                    # A radiograph the gateway refuses uncompressed; the PACS can transcode it to JPEG-LS (a third of the size).
                    if syntax == "1.2.840.10008.1.2.4.80":
                        body = compressed_frame(syntax, 1_000_000)
                    else:
                        body = gateway_refusal
                        self.send_response(413)
                        self.send_header("Content-Type", "application/json")
                elif "/series/dx-j2k/" in parsed.path:
                    # This PACS has no JPEG-LS (406) but JPEG 2000, and even compressed the frame needs the spill.
                    if syntax == "1.2.840.10008.1.2.4.90":
                        body = compressed_frame(syntax, 7_000_000)
                    elif syntax == "1.2.840.10008.1.2.4.80":
                        body = b"Not Acceptable"
                        self.send_response(406)
                        self.send_header("Content-Type", "text/plain")
                    else:
                        body = gateway_refusal
                        self.send_response(413)
                        self.send_header("Content-Type", "application/json")
                elif "/series/dx-noise/" in parsed.path:
                    # Nothing helps: too large in every syntax.
                    body = gateway_refusal
                    self.send_response(413)
                    self.send_header("Content-Type", "application/json")
                elif parsed.path.endswith("/frames/1"):
                    body = b"\xff\xd8" + bytes(range(256)) * 8
                    self.send_response(200)
                    self.send_header("Content-Type", 'multipart/related; type="application/octet-stream"; boundary=abc')
                elif parsed.path.endswith("/metadata"):
                    body = json.dumps([{"00080018": {"vr": "UI", "Value": [f"1.2.{i}"]}, "7FE00010": {"vr": "OB", "BulkDataURI": "https://hospital.example/dicom-web/x"}} for i in range(600)]).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/dicom+json")
                elif parsed.path.endswith("/missing"):
                    body = b'{"error":"no such study"}'
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                elif parsed.path.endswith("/refused"):
                    body = b"Unauthorized"
                    self.send_response(401)
                    self.send_header("Content-Type", "text/plain")
                elif parsed.path.endswith("/huge"):
                    body = b"\x00" * 6_000_000
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                elif parsed.path.endswith("/frames/9"):
                    # A radiograph's frame: 2500 × 2000 × 16 bit = 10 MB, with the multipart envelope WADO-RS wraps it in.
                    body = b"--rad\r\nContent-Type: application/octet-stream\r\n\r\n" + bytes(range(256)) * (10_000_000 // 256) + b"\r\n--rad--"
                    self.send_response(200)
                    self.send_header("Content-Type", 'multipart/related; type="application/octet-stream"; boundary=rad')
                elif parsed.path.endswith("/wide-metadata"):
                    # Metadata so large that even gzipped it would not fit a Lambda response (random text compresses badly).
                    import random

                    rnd = random.Random(7)
                    body = json.dumps([{"00080018": {"vr": "UI", "Value": [f"1.2.{i}"]}, "00081030": {"vr": "LO", "Value": [base64.b64encode(rnd.randbytes(300)).decode()]}} for i in range(16_000)]).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/dicom+json")
                else:
                    body = json.dumps([{"0020000D": {"vr": "UI", "Value": ["1.2.3"]}}]).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/dicom+json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/dicom-web"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture(scope="module")
def pacs():
    server = FakePacs()
    yield server
    server.close()


def event(path: str, query: str = "", accept: str = "application/dicom+json", accept_encoding: str = "gzip, deflate, br", method: str = "GET") -> dict:
    """An HTTP API payload-2.0 event as the JWT authorizer hands it on: the user's claims in the context, their token in the headers."""
    return {
        "version": "2.0",
        "rawPath": f"/viewer/dicom-web/{path}",
        "rawQueryString": query,
        "pathParameters": {"proxy": path},
        "headers": {"authorization": "Bearer users-cognito-id-token", "accept": accept, "accept-encoding": accept_encoding, "origin": "https://viewer.example"},
        "requestContext": {"http": {"method": method, "path": f"/viewer/dicom-web/{path}"}, "authorizer": {"jwt": {"claims": {"sub": "user-1", "email": "doc@example.org"}}}},
    }


def plain_opener(request, timeout, context=None):  # the fake PACS is plain HTTP; the door speaks TLS to the hospital
    return urllib.request.urlopen(request, timeout=timeout)


def test_the_door_forwards_with_the_hospitals_token_and_never_the_users(pacs):
    response = door.forward(event("studies", "PatientID=abc&limit=5"), pacs.base_url, lambda: "hospital-access-token", opener=plain_opener)
    assert response["statusCode"] == 200 and response["isBase64Encoded"] is False
    assert json.loads(response["body"])[0]["0020000D"]["Value"] == ["1.2.3"]
    assert response["headers"]["content-type"] == "application/dicom+json" and "content-encoding" not in response["headers"], "small JSON goes as it is"
    sent = pacs.requests[-1]
    assert sent["path"] == "/dicom-web/studies" and sent["query"] == "PatientID=abc&limit=5", "path and query as the browser sent them"
    assert sent["headers"]["authorization"] == "Bearer hospital-access-token" and "users-cognito-id-token" not in json.dumps(sent)
    assert sent["headers"]["accept"] == "application/dicom+json" and sent["headers"]["accept-encoding"] == "identity"


def test_large_json_is_gzipped_when_the_browser_accepts_it_and_frames_go_base64(pacs):
    metadata = door.forward(event("studies/1.2/series/1.3/metadata"), pacs.base_url, lambda: "t", opener=plain_opener)
    assert metadata["statusCode"] == 200 and metadata["headers"]["content-encoding"] == "gzip" and metadata["isBase64Encoded"] is True
    decoded = json.loads(gzip.decompress(base64.b64decode(metadata["body"])))
    assert len(decoded) == 600 and decoded[0]["7FE00010"]["BulkDataURI"].startswith("https://hospital.example/"), "the body itself is untouched: OHIF re-prefixes the BulkDataURIs (app-config)"
    assert len(metadata["body"]) < len(json.dumps(decoded)) / 5, "ten times smaller is the point"
    identity = door.forward(event("studies/1.2/series/1.3/metadata", accept_encoding="identity"), pacs.base_url, lambda: "t", opener=plain_opener)
    assert identity["isBase64Encoded"] is False and "content-encoding" not in identity["headers"]
    frame = door.forward(event("studies/1.2/series/1.3/instances/1.4/frames/1", accept='multipart/related; type="application/octet-stream"'), pacs.base_url, lambda: "t", opener=plain_opener)
    assert frame["statusCode"] == 200 and frame["isBase64Encoded"] is True and frame["headers"]["content-type"].startswith("multipart/related")
    assert base64.b64decode(frame["body"])[:2] == b"\xff\xd8" and pacs.requests[-1]["headers"]["accept"].startswith("multipart/related")


def test_upstream_misses_pass_through_refusals_become_502_and_oversize_413(pacs):
    missing = door.forward(event("studies/1.2/missing"), pacs.base_url, lambda: "t", opener=plain_opener)
    assert missing["statusCode"] == 404 and json.loads(missing["body"]) == {"error": "no such study"}
    refused = door.forward(event("studies/1.2/refused"), pacs.base_url, lambda: "t", opener=plain_opener)
    assert refused["statusCode"] == 502 and "refused the platform's credentials (401)" in json.loads(refused["body"])["message"], "the hospital refusing OUR token is a platform problem, not the user's"
    huge = door.forward(event("studies/1.2/huge"), pacs.base_url, lambda: "t", opener=plain_opener)
    assert huge["statusCode"] == 413 and "6 MB" in json.loads(huge["body"])["message"], "without a spill bucket the refusal stands"

    def broken():
        from medapp_shared.oauth2 import TokenError

        raise TokenError("token endpoint answered 401: invalid_client")

    no_token = door.forward(event("studies"), pacs.base_url, broken, opener=plain_opener)
    assert no_token["statusCode"] == 502 and "token endpoint" in json.loads(no_token["body"])["message"]
    assert door.forward(event("studies", method="POST"), pacs.base_url, lambda: "t", opener=plain_opener)["statusCode"] == 405, "read-only door"
    assert door.upstream_url({"rawPath": "/viewer/dicom-web/studies/1/series", "rawQueryString": ""}, "https://h/dicom-web/") == "https://h/dicom-web/studies/1/series"
    assert door.upstream_url({"pathParameters": {"proxy": "studies"}, "rawQueryString": "limit=1"}, "https://h/dicom-web") == "https://h/dicom-web/studies?limit=1", "falls back to the path parameter"


class FakeS3:
    """Enough of boto3's S3 client for S3Spill: remembers puts, signs URLs by hand."""

    def __init__(self):
        self.objects: dict[str, dict] = {}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        assert operation == "get_object" and Params["Key"] in self.objects
        return f"https://{Params['Bucket']}.s3.eu-central-1.amazonaws.com/{Params['Key']}?X-Amz-Expires={ExpiresIn}&X-Amz-Signature=sig"


def test_answers_too_large_for_a_lambda_response_are_spilled_to_s3_and_the_browser_redirected(pacs):
    s3 = FakeS3()
    spill = door.S3Spill("medapp-spill", ttl_s=120, client=s3)

    # A radiograph's frame, 10 MB in its multipart envelope: too big to come back through Lambda, so it goes to the bucket as it is.
    frame = door.forward(event("studies/1.2/series/1.3/instances/1.4/frames/9", accept='multipart/related; type="application/octet-stream"'), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert frame["statusCode"] == 307 and frame["isBase64Encoded"] is False
    location = frame["headers"]["location"]
    assert location.startswith("https://medapp-spill.s3.eu-central-1.amazonaws.com/spill/") and "X-Amz-Expires=120" in location, "a presigned URL on the spill bucket, two minutes"
    assert frame["headers"]["cache-control"] == "no-store", "the redirect must not outlive the signature"
    assert json.loads(frame["body"])["location"] == location
    (stored,) = s3.objects.values()
    assert stored["Bucket"] == "medapp-spill" and len(stored["Key"].split("/")[-1]) == 32, "an unguessable key"
    assert stored["ContentType"] == 'multipart/related; type="application/octet-stream"; boundary=rad', "the PACS's content type, boundary included — OHIF splits the frame by it"
    assert stored["Body"].startswith(b"--rad\r\n") and stored["Body"].endswith(b"\r\n--rad--") and "ContentEncoding" not in stored, "the body exactly as the PACS sent it"
    assert int(frame["headers"]["x-medapp-spilled-bytes"]) == len(stored["Body"]) > 9_900_000
    assert stored["CacheControl"] == "private, max-age=60"
    assert pacs.requests[-1]["headers"]["authorization"] == "Bearer t", "the hospital's token still went upstream; the browser's goes nowhere"

    # JSON that stays too large even gzipped goes compressed, with the encoding on the object for the browser to undo.
    metadata = door.forward(event("studies/1.2/wide-metadata"), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert metadata["statusCode"] == 307 and len(s3.objects) == 2
    key = "spill/" + metadata["headers"]["location"].split("/spill/")[1].split("?")[0]
    stored = s3.objects[key]
    assert stored["ContentType"] == "application/dicom+json" and stored["ContentEncoding"] == "gzip"
    assert len(json.loads(gzip.decompress(stored["Body"]))) == 16_000

    # What fits still comes back inline — the spill is for the exceptions, not the rule.
    small = door.forward(event("studies/1.2/series/1.3/instances/1.4/frames/1", accept='multipart/related; type="application/octet-stream"'), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert small["statusCode"] == 200 and small["isBase64Encoded"] is True and len(s3.objects) == 2

    # Only successes are spilled, and a failing bucket falls back to the refusal rather than a 500.
    missing = door.forward(event("studies/1.2/missing"), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert missing["statusCode"] == 404 and len(s3.objects) == 2

    def failing(body, content_type, content_encoding):
        raise RuntimeError("AccessDenied")

    refused = door.forward(event("studies/1.2/huge"), pacs.base_url, lambda: "t", opener=plain_opener, spill=failing)
    assert refused["statusCode"] == 413 and "6 MB" in json.loads(refused["body"])["message"]


def test_frames_the_hospitals_gateway_refuses_are_fetched_again_in_a_lossless_compressed_syntax(pacs, monkeypatch):
    # The real case: `…/frames/1` of a radiograph came back `413 {"message":"Request Entity Too Large"}` — API Gateway's canned
    # body from the HOSPITAL's gateway (10 MB quota), passed through by the door. The frame never reached us; the spill cannot help.
    monkeypatch.setattr(door, "_compressed_series", {})
    accept = "multipart/related; type=application/octet-stream; transfer-syntax=*"  # OHIF's, quotation omitted (app-config)
    s3 = FakeS3()
    spill = door.S3Spill("medapp-spill", client=s3)

    before = len(pacs.requests)
    frame = door.forward(event("studies/1/series/dx-jls/instances/2/frames/1", accept=accept), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert frame["statusCode"] == 200 and frame["isBase64Encoded"] is True
    sent = [r["headers"]["accept"] for r in pacs.requests[before:]]
    assert sent == [accept, "multipart/related; type=application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.80"], "as the browser asked first; then the same pixels in JPEG-LS"
    assert b"transfer-syntax=1.2.840.10008.1.2.4.80" in base64.b64decode(frame["body"]), "the part's content type names the syntax — cornerstone picks its decoder by it"

    # The next frame of that series skips the refusal: the door remembers what got through.
    before = len(pacs.requests)
    again = door.forward(event("studies/1/series/dx-jls/instances/3/frames/1", accept=accept), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert again["statusCode"] == 200 and [r["headers"]["accept"] for r in pacs.requests[before:]] == ["multipart/related; type=application/octet-stream; transfer-syntax=1.2.840.10008.1.2.4.80"]

    # A PACS without JPEG-LS answers 406: the door moves on to JPEG 2000; 7 MB compressed is still over Lambda's limit → spilled.
    before = len(pacs.requests)
    j2k = door.forward(event("studies/1/series/dx-j2k/instances/2/frames/1", accept=accept), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert j2k["statusCode"] == 307 and len(s3.objects) == 1
    assert [r["headers"]["accept"].split("transfer-syntax=")[1] for r in pacs.requests[before:]] == ["*", "1.2.840.10008.1.2.4.80", "1.2.840.10008.1.2.4.90"]
    assert next(iter(s3.objects.values()))["ContentType"].startswith("multipart/related")

    # When no syntax fits, the door says so — the gateway's limit, and what it tried — instead of relaying the canned body.
    before = len(pacs.requests)
    noise = door.forward(event("studies/1/series/dx-noise/instances/2/frames/1", accept=accept), pacs.base_url, lambda: "t", opener=plain_opener, spill=spill)
    assert noise["statusCode"] == 413
    message = json.loads(noise["body"])["message"]
    assert "10 MB" in message and "JPEG-LS lossless, JPEG 2000 lossless, RLE lossless" in message and "Request Entity Too Large" not in message
    assert len(pacs.requests) - before == 4, "the browser's syntax and the three lossless ones"
    assert "dx-noise" not in json.dumps(door._compressed_series), "nothing to remember"

    # Only pixel retrievals are retried: a 413 on metadata is passed through as it is (there is no smaller way to ask for it).
    assert door.is_pixel_retrieval("/dicom-web/studies/1/series/2/instances/3/frames/1,2") and door.is_pixel_retrieval("/dicom-web/studies/1/series/2/instances/3")
    assert not door.is_pixel_retrieval("/dicom-web/studies/1/series/2/instances/3/metadata") and not door.is_pixel_retrieval("/dicom-web/studies/1/series/2/instances")
    assert door.with_transfer_syntax('multipart/related; type="application/octet-stream"', "1.2.840.10008.1.2.5") == 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.5'


def test_the_spill_is_configured_by_the_environment(monkeypatch):
    monkeypatch.setattr(door, "SPILL_BUCKET", "")
    monkeypatch.setattr(door, "_spill", None)
    assert door.default_spill() is None, "no bucket, no spill: the 413 refusal"
    monkeypatch.setattr(door, "SPILL_BUCKET", "medapp-spill")
    monkeypatch.setattr(door, "S3Spill", lambda bucket, ttl_s: ("spill", bucket, ttl_s))
    assert door.default_spill() == ("spill", "medapp-spill", door.SPILL_TTL_S)
    assert door.default_spill() is door.default_spill(), "created once per container"
