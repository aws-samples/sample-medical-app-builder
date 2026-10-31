"""
SigV4 request signing for IAM-authorised HTTP endpoints — the reference FHIR server behind an HTTP API
(`execute-api`), and later a managed FHIR service that authenticates the same way (`healthlake`).

A `RequestSigner` is a callable `(method, url, headers, body) -> headers`: it returns the headers to send,
which are the given ones plus `Authorization`, `X-Amz-Date` (and `X-Amz-Security-Token` for temporary
credentials). The FHIR client applies it to every request; nothing else about the client changes with the
authentication scheme. botocore is imported lazily so this module can be imported where the SDK is absent.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Mapping

RequestSigner = Callable[[str, str, Mapping[str, str], bytes | None], dict[str, str]]


class SigV4Signer:
    """Signs with the ambient AWS credentials (the Lambda's role, a profile, environment variables)."""

    def __init__(self, service: str = "execute-api", region: str | None = None, credentials: Any = None) -> None:
        import botocore.session  # local import: the SDK is only needed when signing is configured

        session = botocore.session.get_session()
        self._service = service
        self._region = region or os.environ.get("AWS_REGION") or session.get_config_variable("region")
        if not self._region:
            raise ValueError("SigV4 signing needs a region (AWS_REGION or the SDK configuration)")
        self._credentials = credentials or session.get_credentials()
        if self._credentials is None:
            raise ValueError("SigV4 signing needs AWS credentials, and none were found")

    @property
    def service(self) -> str:
        return self._service

    @property
    def region(self) -> str:
        return self._region

    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> dict[str, str]:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        request = AWSRequest(method=method.upper(), url=url, data=body, headers=dict(headers))
        SigV4Auth(self._credentials, self._service, self._region).add_auth(request)
        return {k: v for k, v in request.headers.items()}


__all__ = ["RequestSigner", "SigV4Signer"]
