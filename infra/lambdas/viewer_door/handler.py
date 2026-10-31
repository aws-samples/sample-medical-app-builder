"""
The viewer door to the hospital's DICOMweb — the Lambda behind `GET /viewer/dicom-web/{proxy+}`.

OHIF in the browser holds the panel user's Cognito ID token and nothing else: the hospital's client secret must
never reach a browser. The HTTP API's JWT authorizer admits the panel's users (the pool as issuer, the web client
as audience) before this function runs; the function then forwards the request to the hospital's DICOMweb with the
hospital's OAuth2 access token — client credentials, cached per container, renewed before expiry — and returns what
the PACS answered. The user's token stops at the authorizer; the hospital's token never leaves this process.

Why a Lambda in the data path rather than a proxy integration with a header mapping: API Gateway refuses to write
the `Authorization` header from a mapping ("Operations on header authorization are restricted"), so something must
add it per request. The price is the Lambda response limit of 6 MB, base64 included. Their series metadata (2 MB)
and study metadata (4.3 MB) are JSON and are gzipped here when the browser accepts it (ten times smaller); frames
of 0.5–2 MB pass as they are. An answer that would still exceed the limit — a radiograph's single frame runs to
8–15 MB — is *spilled*: written to a private bucket under an unguessable key and answered with a 307 to a presigned
URL that lives two minutes (`SPILL_BUCKET`, `SPILL_TTL_S`). The browser follows the redirect on its own; the fetch
standard makes it drop the `Authorization` header when the redirect crosses origins (S3 would refuse a request
carrying both a signature and a bearer token), and makes it present `Origin: null`, which is why the bucket's CORS
rule allows every origin — the presigned URL is what protects the object, not CORS. Objects expire after a day
(the shortest lifecycle S3 offers). Without a bucket, or when the put fails, the old refusal remains: 413 and a
message, rather than failing inside API Gateway.

The hospital's side has a ceiling of its own: their DICOMweb sits behind an API Gateway whose payload quota is 10 MB,
so an uncompressed radiograph frame (12–18 MB) is refused *there* — `{"message":"Request Entity Too Large"}`, API
Gateway's canned body — and never reaches this door. For a frame or instance retrieval that comes back 413, the door
asks the PACS again for the same pixels in a lossless compressed transfer syntax (JPEG-LS, then JPEG 2000, then RLE;
Orthanc transcodes on request), keeps the first that gets through, remembers it for the rest of that series, and
spills the result if it is still too large for a Lambda response. OHIF decodes any of them. Only when none fits does
the door answer 413 itself, naming the gateway's limit and what it tried.

What this door checks is identity, not authorisation: any signed-in user of the panel may open any study by UID —
the same gap as the reference environment's door, closed by study-scoped grants (roadmap). This function is where
that check will go.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Protocol

from medapp_shared.oauth2 import TokenError, shared_client_credentials
from medapp_shared.tls import default_ssl_context

DOOR_PREFIX = os.environ.get("DOOR_PREFIX") or "/viewer/dicom-web"
# Lambda allows 6 MB for the whole response; keep a margin for headers and JSON framing.
MAX_BODY_BYTES = 5_500_000
# JSON smaller than this is not worth compressing (and a frame list is JSON too).
GZIP_FROM_BYTES = 16_384
JSON_TYPES = ("application/dicom+json", "application/json", "application/fhir+json", "text/")
UPSTREAM_TIMEOUT_S = float(os.environ.get("DOOR_TIMEOUT_S") or 25.0)
# Where answers too large for a Lambda response go (the stack sets both); no bucket means the 413 refusal.
SPILL_BUCKET = os.environ.get("SPILL_BUCKET") or ""
SPILL_TTL_S = int(os.environ.get("SPILL_TTL_S") or 120)
# The URL carries a signature with a lifetime; the browser must not keep the redirect, and should not keep the object past it.
SPILL_CACHE_CONTROL = "private, max-age=60"

_ssl = default_ssl_context()


class Spill(Protocol):
    """Stores one oversize answer and returns the URL the browser is sent to for it."""

    def __call__(self, body: bytes, content_type: str, content_encoding: str | None) -> str: ...


class S3Spill:
    """
    The spill as a private S3 bucket: a put under a random key, then a presigned GET good for `ttl_s` seconds. The
    object keeps the PACS's exact content type (the multipart boundary included — OHIF parses frames by it) and, for
    JSON the door gzipped, a Content-Encoding the browser undoes on its own. The signer is this function's role, so the
    URL is worth no more than the role's own `s3:GetObject` on this one bucket, for two minutes.
    """

    def __init__(self, bucket: str, ttl_s: int = SPILL_TTL_S, client: Any = None):
        self.bucket, self.ttl_s = bucket, ttl_s
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client("s3", config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
        self.client = client

    def __call__(self, body: bytes, content_type: str, content_encoding: str | None) -> str:
        key = f"spill/{uuid.uuid4().hex}"
        extra = {"ContentEncoding": content_encoding} if content_encoding else {}
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type or "application/octet-stream", CacheControl=SPILL_CACHE_CONTROL, **extra)
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=self.ttl_s)


_spill: Spill | None = None


def default_spill() -> Spill | None:
    """The spill the environment configures, created once per container; None when there is no bucket."""
    global _spill
    if _spill is None and SPILL_BUCKET:
        _spill = S3Spill(SPILL_BUCKET, SPILL_TTL_S)
    return _spill


def upstream_url(event: dict[str, Any], base_url: str, prefix: str = DOOR_PREFIX) -> str:
    """`GET /viewer/dicom-web/studies/1.2/series?limit=5` → `<base>/studies/1.2/series?limit=5`, path and query as the browser sent them."""
    raw_path = str(event.get("rawPath") or "")
    marker = raw_path.find(prefix)
    if marker >= 0:
        rest = raw_path[marker + len(prefix) :]
    else:
        rest = "/" + str((event.get("pathParameters") or {}).get("proxy") or "")
    rest = rest.lstrip("/")
    query = str(event.get("rawQueryString") or "")
    return f"{base_url.rstrip('/')}/{rest}" + (f"?{query}" if query else "")


def _header(event: dict[str, Any], name: str) -> str:
    headers = {str(k).lower(): v for k, v in (event.get("headers") or {}).items()}
    return str(headers.get(name.lower()) or "")


def _is_json(content_type: str) -> bool:
    return any(content_type.lower().startswith(t) for t in JSON_TYPES)


def _response(status: int, body: bytes, content_type: str, accept_encoding: str, extra_headers: dict[str, str] | None = None, spill: Spill | None = None) -> dict[str, Any]:
    """
    The PACS's answer as an HTTP API payload-2.0 response: JSON gzipped when accepted, binary base64-encoded, size
    checked. A successful answer too large for a Lambda response is spilled and answered with a redirect to it.
    """
    headers = {"content-type": content_type or "application/octet-stream", "cache-control": SPILL_CACHE_CONTROL, **(extra_headers or {})}
    raw_size = len(body)
    if _is_json(content_type) and len(body) >= GZIP_FROM_BYTES and "gzip" in accept_encoding.lower():
        body = gzip.compress(body, compresslevel=6)
        headers["content-encoding"] = "gzip"
        encoded, is_base64 = base64.b64encode(body).decode("ascii"), True
    elif _is_json(content_type):
        try:
            encoded, is_base64 = body.decode("utf-8"), False
        except UnicodeDecodeError:
            encoded, is_base64 = base64.b64encode(body).decode("ascii"), True
    else:
        encoded, is_base64 = base64.b64encode(body).decode("ascii"), True
    if len(encoded) > MAX_BODY_BYTES:
        if spill is not None and status == 200:
            try:
                location = spill(body, headers["content-type"], headers.get("content-encoding"))
            except Exception as err:  # noqa: BLE001 — the refusal below is the fallback for any spill failure
                print(json.dumps({"viewer_door": "spill failed", "detail": f"{type(err).__name__}: {err}"[:300], "bytes": raw_size}))
            else:
                # 307 keeps the method and the browser's Accept; it drops Authorization because the location is another origin.
                redirect = {"location": location, "cache-control": "no-store", "content-type": "application/json", "x-medapp-spilled-bytes": str(raw_size)}
                return {"statusCode": 307, "headers": redirect, "body": json.dumps({"message": f"{raw_size / 1e6:.1f} MB; follow Location.", "location": location}), "isBase64Encoded": False}
        message = {"message": f"The PACS answered with {raw_size / 1e6:.1f} MB, more than this door can carry (6 MB per response); open a smaller series or ask for rendered frames."}
        return {"statusCode": 413, "headers": {"content-type": "application/json"}, "body": json.dumps(message)}
    return {"statusCode": status, "headers": headers, "body": encoded, "isBase64Encoded": is_base64}


# The hospital's gateway is an API Gateway too, with its 10 MB payload quota: a radiograph's uncompressed frame (12–18 MB)
# is refused there — `{"message":"Request Entity Too Large"}`, their canned body — and never reaches this door, so the
# spill cannot help. What can: asking the PACS for the same pixels in a lossless compressed transfer syntax (Orthanc
# transcodes on the fly when the Accept header names one), which brings a radiograph to a third or less. Tried in this
# order; the first the PACS can produce and the gateway carries is kept — and remembered for the rest of that series.
LOSSLESS_TRANSFER_SYNTAXES: tuple[tuple[str, str], ...] = (
    ("1.2.840.10008.1.2.4.80", "JPEG-LS lossless"),
    ("1.2.840.10008.1.2.4.90", "JPEG 2000 lossless"),
    ("1.2.840.10008.1.2.5", "RLE lossless"),
)
UPSTREAM_PAYLOAD_LIMIT_MB = 10
# `.../instances/<uid>` (the whole instance) or `.../instances/<uid>/frames/1` (or `1,2,3`): the two retrievals that carry pixels.
_PIXEL_RETRIEVAL = re.compile(r"/instances/[^/]+(?:/frames/\d+(?:,\d+)*)?$")
# How much of the Lambda's 29 s a retry may still start with; below that, answer with what there is.
RETRY_MIN_REMAINING_S = 4.0
TOTAL_BUDGET_S = float(os.environ.get("DOOR_BUDGET_S") or 27.0)
# Series whose frames the gateway refused uncompressed → the transfer syntax that got through, per container.
_compressed_series: dict[str, str] = {}


def is_pixel_retrieval(path: str) -> bool:
    return _PIXEL_RETRIEVAL.search(path) is not None


def with_transfer_syntax(accept: str, uid: str) -> str:
    """`multipart/related; type=application/octet-stream; transfer-syntax=*` → the same naming `uid` (added when absent)."""
    parts = [p.strip() for p in accept.split(";") if p.strip() and not p.strip().lower().startswith("transfer-syntax=")]
    return "; ".join([*parts, f"transfer-syntax={uid}"])


def series_of(path: str) -> str:
    return path.split("/instances/")[0]


class _Refused(Exception):
    """The hospital refused the platform's token (401/403): our configuration or their rotation, never the user's fault."""

    def __init__(self, code: int):
        super().__init__(code)
        self.code = code


def _get(opener: Callable[..., Any], url: str, token: str, accept: str, timeout: float) -> tuple[int, str, bytes]:
    """One upstream GET; HTTP errors other than 401/403 come back as (status, type, body) like successes."""
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": accept, "Accept-Encoding": "identity"}, method="GET")
    try:
        with opener(request, timeout=timeout, context=_ssl) as res:
            return res.status, str(res.headers.get("Content-Type") or ""), res.read()
    except urllib.error.HTTPError as err:
        if err.code in (401, 403):
            raise _Refused(err.code) from err
        return err.code, str(err.headers.get("Content-Type") or "application/json"), err.read() or b""


def forward(
    event: dict[str, Any],
    base_url: str,
    hospital_token: Callable[[], str],
    opener: Callable[..., Any] = urllib.request.urlopen,
    spill: Spill | None = None,
) -> dict[str, Any]:
    """One GET to the hospital's DICOMweb on the browser's behalf. Returns the HTTP API response."""
    started = time.monotonic()
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    method = str(((event.get("requestContext") or {}).get("http") or {}).get("method") or "GET").upper()
    if method != "GET":
        return {"statusCode": 405, "headers": {"content-type": "application/json"}, "body": json.dumps({"message": "The viewer door is read-only."})}
    url = upstream_url(event, base_url)
    path = urllib.parse.urlsplit(url).path
    accept = _header(event, "accept") or "application/dicom+json"
    accept_encoding = _header(event, "accept-encoding")
    log: dict[str, Any] = {"viewer_door": "forward", "sub": claims.get("sub"), "path": path}

    def done(response: dict[str, Any], **fields: Any) -> dict[str, Any]:
        log.update(status=response["statusCode"], duration_ms=round((time.monotonic() - started) * 1000), **fields)
        print(json.dumps(log))
        return response

    def error(status: int, message: str, **fields: Any) -> dict[str, Any]:
        return done({"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps({"message": message})}, **fields)

    def remaining() -> float:
        return TOTAL_BUDGET_S - (time.monotonic() - started)

    try:
        token = hospital_token()
    except TokenError as err:
        return error(502, "The hospital's token endpoint did not hand out a token.", detail=f"no hospital token: {err}")

    pixels = is_pixel_retrieval(path)
    # A series the gateway already refused uncompressed: ask for the syntax that worked straight away.
    known = _compressed_series.get(series_of(path)) if pixels else None
    attempts: list[str] = []
    try:
        status, content_type, body = _get(opener, url, token, with_transfer_syntax(accept, known) if known else accept, min(UPSTREAM_TIMEOUT_S, max(remaining(), 1.0)))
        if known:
            attempts.append(known)
        if status == 413 and pixels:
            # Their gateway's "Request Entity Too Large": the frame is bigger than it carries. Same pixels, compressed losslessly.
            for uid, _name in LOSSLESS_TRANSFER_SYNTAXES:
                if uid == known or remaining() < RETRY_MIN_REMAINING_S:
                    continue
                attempts.append(uid)
                status, content_type, body = _get(opener, url, token, with_transfer_syntax(accept, uid), min(UPSTREAM_TIMEOUT_S, remaining()))
                if status == 200:
                    _compressed_series[series_of(path)] = uid
                    break
                # 413: still too large in that syntax; 406 (or anything else): the PACS cannot produce it — the next one, then.
            else:
                tried = ", ".join(name for uid, name in LOSSLESS_TRANSFER_SYNTAXES if uid in attempts)
                return error(
                    413,
                    f"The hospital's gateway carries at most {UPSTREAM_PAYLOAD_LIMIT_MB} MB per answer and refused this frame; the PACS could not compress it below that ({tried or 'no compression could be tried in time'}).",
                    upstream=413,
                    transfer_syntaxes_tried=attempts,
                )
    except _Refused as err:
        return error(502, f"The hospital's gateway refused the platform's credentials ({err.code}).", upstream=err.code)
    except (urllib.error.URLError, TimeoutError) as err:
        return error(504, "The hospital's DICOMweb did not answer in time.", detail=str(getattr(err, "reason", err))[:200])

    response = _response(status, body, content_type, accept_encoding, spill=spill)
    return done(
        response,
        upstream=status,
        bytes=len(body),
        gzip="content-encoding" in response.get("headers", {}),
        spilled=response["statusCode"] == 307,
        **({"transfer_syntax": attempts[-1]} if attempts else {}),
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return forward(event, os.environ["DICOMWEB_BASE_URL"], lambda: shared_client_credentials("FHIR_").token(), spill=default_spill())
