"""
OAuth 2.0 client-credentials grant — how a hospital gateway authenticates machine clients. The platform asks the
hospital's token endpoint for an access token with its client id and secret, and sends it as a bearer token with
every FHIR and DICOMweb request. Tokens typically live for an hour; `ClientCredentials` caches one per
process and renews it shortly before it expires, so a warm Lambda asks the token endpoint about once an hour.

The secret never sits in code, in cdk.json or in a Lambda environment variable: it is read from a Secrets Manager
secret (`{"client_id": "…", "client_secret": "…"}`, written by `scripts/set-hospital-credentials.py`) at first use,
or — on a developer machine — from environment variables. A refused token (the secret rotated) drops the cached
credentials so the next attempt re-reads the secret.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from .tls import default_ssl_context


class TokenError(RuntimeError):
    """The token endpoint did not hand out a token; the message never contains the secret."""


@dataclass(frozen=True)
class Credentials:
    client_id: str
    client_secret: str


def credentials_from_secret(secret_id: str, client: Any = None) -> Credentials:
    """A Secrets Manager secret (name or ARN) holding JSON with client_id and client_secret → Credentials."""
    if client is None:
        import boto3  # local import: the SDK is only needed where the secret lives

        client = boto3.client("secretsmanager")
    value = client.get_secret_value(SecretId=secret_id)
    try:
        data = json.loads(value.get("SecretString") or "{}")
    except ValueError as err:
        raise TokenError(f"secret {secret_id} is not JSON") from err
    client_id, client_secret = str(data.get("client_id") or ""), str(data.get("client_secret") or "")
    if not client_id or not client_secret:
        raise TokenError(f"secret {secret_id} must contain client_id and client_secret")
    return Credentials(client_id, client_secret)


class ClientCredentials:
    """
    A callable token provider: `provider()` is a valid access token, fetched or renewed as needed.
    `credentials` is the pair itself or a function that produces it (read once, kept until a token is refused).
    """

    def __init__(
        self,
        token_url: str,
        credentials: Credentials | Callable[[], Credentials],
        scope: str | None = None,
        timeout_s: float = 10.0,
        ca_bundle: str | None = None,
        renew_before_s: float = 120.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.token_url = token_url
        self.scope = scope
        self._credentials_source = credentials
        self._credentials: Credentials | None = credentials if isinstance(credentials, Credentials) else None
        self._timeout = timeout_s
        self._ca_bundle = ca_bundle
        self._renew_before = renew_before_s
        self._clock = clock
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()
        self.fetches = 0  # how often the endpoint was asked — what the tests and the smoke script look at

    def credentials(self) -> Credentials:
        if self._credentials is None:
            source = self._credentials_source
            self._credentials = source if isinstance(source, Credentials) else source()
        return self._credentials

    def token(self) -> str:
        with self._lock:
            if self._token is None or self._clock() >= self._expires_at - self._renew_before:
                self._refresh()
            return str(self._token)

    __call__ = token

    def invalidate(self, credentials: bool = False) -> None:
        """Forget the token (the server refused it); with `credentials`, re-read the secret too."""
        with self._lock:
            self._token = None
            self._expires_at = 0.0
            if credentials and not isinstance(self._credentials_source, Credentials):
                self._credentials = None

    def fetch(self) -> dict[str, Any]:
        """One token request; the response as the endpoint sent it (access_token, expires_in, token_type)."""
        creds = self.credentials()
        form = {"grant_type": "client_credentials"}
        if self.scope:
            form["scope"] = self.scope
        basic = base64.b64encode(f"{creds.client_id}:{creds.client_secret}".encode("utf-8")).decode("ascii")
        request = urllib.request.Request(
            self.token_url,
            data=urllib.parse.urlencode(form).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json", "authorization": f"Basic {basic}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout, context=default_ssl_context(self._ca_bundle)) as response:  # noqa: S310 — the URL is configuration
                body = json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            text = _error_text(err.read())
            if err.code in (400, 401) and not isinstance(self._credentials_source, Credentials):
                self._credentials = None  # a rotated secret: read it again next time
            raise TokenError(f"token endpoint answered {err.code}" + (f": {text}" if text else "")) from err
        except urllib.error.URLError as err:
            raise TokenError(f"token endpoint unreachable: {err.reason}") from err
        except TimeoutError as err:
            raise TokenError(f"token endpoint did not answer within {self._timeout:g}s") from err
        if not isinstance(body, dict) or not body.get("access_token"):
            raise TokenError("token endpoint answered without an access_token")
        return body

    def _refresh(self) -> None:
        body = self.fetch()
        self.fetches += 1
        self._token = str(body["access_token"])
        try:
            lifetime = float(body.get("expires_in") or 3600)
        except (TypeError, ValueError):
            lifetime = 3600.0
        self._expires_at = self._clock() + lifetime

    @classmethod
    def from_env(cls, prefix: str = "FHIR_", **kwargs: Any) -> "ClientCredentials":
        """
        {prefix}TOKEN_URL and {prefix}OAUTH_SCOPE; the credentials from Secrets Manager ({prefix}CREDENTIALS_SECRET, the
        deployment) or from {prefix}CLIENT_ID / {prefix}CLIENT_SECRET (a developer's shell). Never from a file in the repo.
        """
        token_url = os.environ.get(f"{prefix}TOKEN_URL")
        if not token_url:
            raise ValueError(f"OAuth2 needs {prefix}TOKEN_URL")
        scope = os.environ.get(f"{prefix}OAUTH_SCOPE") or None
        secret_id = os.environ.get(f"{prefix}CREDENTIALS_SECRET")
        if secret_id:
            credentials: Credentials | Callable[[], Credentials] = lambda: credentials_from_secret(secret_id)  # noqa: E731 — read on first use, in the Lambda, not at import
        else:
            client_id, client_secret = os.environ.get(f"{prefix}CLIENT_ID"), os.environ.get(f"{prefix}CLIENT_SECRET")
            if not client_id or not client_secret:
                raise ValueError(f"OAuth2 needs {prefix}CREDENTIALS_SECRET (Secrets Manager) or {prefix}CLIENT_ID and {prefix}CLIENT_SECRET")
            credentials = Credentials(client_id, client_secret)
        return cls(token_url, credentials, scope=scope, ca_bundle=os.environ.get("FHIR_CA_BUNDLE") or None, **kwargs)


_shared: dict[tuple[str, str | None, str | None], ClientCredentials] = {}


def shared_client_credentials(prefix: str = "FHIR_") -> ClientCredentials:
    """One provider per (token URL, scope, secret) for the process: the FHIR and DICOMweb clients share a token."""
    key = (os.environ.get(f"{prefix}TOKEN_URL") or "", os.environ.get(f"{prefix}OAUTH_SCOPE"), os.environ.get(f"{prefix}CREDENTIALS_SECRET") or os.environ.get(f"{prefix}CLIENT_ID"))
    if key not in _shared:
        _shared[key] = ClientCredentials.from_env(prefix)
    return _shared[key]


def _error_text(body: bytes | None) -> str:
    """The `error` / `error_description` of an OAuth2 error response, or the first bytes of whatever came back."""
    if not body:
        return ""
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body[:120].decode("utf-8", "replace")
    if isinstance(data, dict):
        return " ".join(str(data[k]) for k in ("error", "error_description", "message") if data.get(k))
    return ""


__all__ = ["ClientCredentials", "Credentials", "TokenError", "credentials_from_secret", "shared_client_credentials"]
