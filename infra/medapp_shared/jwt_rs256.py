"""
Verification of the Cognito tokens the panel holds (RS256 JWTs) without a cryptography dependency.

The viewer door's Lambda authorizer runs on a plain Python runtime: no `cryptography`, no `PyJWT[crypto]`. RSA
PKCS#1 v1.5 signature verification is modular exponentiation plus a fixed byte layout, so it is written out here
against the pool's published JWKS (`https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json`):
decode the signature, raise it to the public exponent modulo the modulus, and compare the result with the
encoded SHA-256 of the signing input — constant-time. Claims are checked as API Gateway's own JWT authorizer
would: issuer, audience (the panel's client), `token_use`, expiry.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.request
from typing import Any, Callable

from .tls import default_ssl_context

# DigestInfo prefix for SHA-256 (RFC 8017 §9.2, note 1): the DER wrapper that precedes the hash inside the padding.
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class InvalidToken(ValueError):
    """The token is not one this pool issued to this client, or it is no longer valid; the message says which."""


def b64url_decode(text: str) -> bytes:
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _int(text: str) -> int:
    return int.from_bytes(b64url_decode(text), "big")


def rs256_verify(signing_input: bytes, signature: bytes, jwk: dict[str, Any]) -> bool:
    """PKCS#1 v1.5 verification of a SHA-256 signature against a JWK of kty RSA."""
    if jwk.get("kty") != "RSA" or not jwk.get("n") or not jwk.get("e"):
        return False
    n, e = _int(jwk["n"]), _int(jwk["e"])
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = _SHA256_DIGEST_INFO + hashlib.sha256(signing_input).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


class JwksCache:
    """The pool's signing keys, fetched once and again when a token names a key we have not seen (rotation)."""

    def __init__(self, url: str, fetch: Callable[[str], dict[str, Any]] | None = None) -> None:
        self.url = url
        self._fetch = fetch or self._fetch_http
        self._keys: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _fetch_http(url: str) -> dict[str, Any]:
        with urllib.request.urlopen(url, timeout=5, context=default_ssl_context()) as response:  # noqa: S310 — the pool's own URL
            return json.loads(response.read())

    def key(self, kid: str) -> dict[str, Any] | None:
        if kid not in self._keys:
            for jwk in self._fetch(self.url).get("keys", []):
                if jwk.get("kid"):
                    self._keys[jwk["kid"]] = jwk
        return self._keys.get(kid)


def verify_cognito_token(
    token: str,
    jwks: JwksCache,
    issuer: str,
    client_id: str,
    token_use: str = "id",
    now: float | None = None,
    leeway_s: float = 60,
) -> dict[str, Any]:
    """The verified claims of a Cognito JWT, or InvalidToken. `token_use` is `id` for the panel's ID token."""
    parts = token.split(".")
    if len(parts) != 3:
        raise InvalidToken("not a JWT")
    try:
        header = json.loads(b64url_decode(parts[0]))
        claims = json.loads(b64url_decode(parts[1]))
        signature = b64url_decode(parts[2])
    except (ValueError, UnicodeDecodeError) as err:
        raise InvalidToken("malformed JWT") from err
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise InvalidToken("unsupported algorithm")
    jwk = jwks.key(str(header["kid"]))
    if jwk is None:
        raise InvalidToken("unknown signing key")
    if not rs256_verify(f"{parts[0]}.{parts[1]}".encode("ascii"), signature, jwk):
        raise InvalidToken("bad signature")
    moment = time.time() if now is None else now
    if claims.get("iss") != issuer:
        raise InvalidToken("wrong issuer")
    if claims.get("token_use") != token_use:
        raise InvalidToken(f"not an {token_use} token")
    audience = claims.get("aud") if token_use == "id" else claims.get("client_id")
    audiences = audience if isinstance(audience, list) else [audience]
    if client_id not in audiences:
        raise InvalidToken("wrong audience")
    try:
        exp = float(claims.get("exp"))
    except (TypeError, ValueError) as err:
        raise InvalidToken("no expiry") from err
    if moment > exp + leeway_s:
        raise InvalidToken("expired")
    return claims


__all__ = ["InvalidToken", "JwksCache", "b64url_decode", "rs256_verify", "verify_cognito_token"]
