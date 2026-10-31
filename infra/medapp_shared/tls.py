"""
TLS trust for the platform's outbound HTTPS clients (the FHIR client, the DICOMweb client, the OAuth2 token request).

An explicit bundle (`ca_bundle`, or FHIR_CA_BUNDLE) wins — a hospital gateway with a private CA, a corporate proxy.
Otherwise the platform's store, which is what Lambda has. A Python that reads no system store — python.org and pyenv
builds on macOS are the usual case — would verify nothing and fail every HTTPS call; it gets the bundle the AWS SDK
is already using in the same process, so "boto3 can reach AWS here" means these clients can too.
"""

from __future__ import annotations

import os
import ssl


def sdk_ca_bundles() -> list[str]:
    """CA bundles other libraries in this process carry: certifi's, and the one the AWS SDK verifies AWS endpoints with."""
    found: list[str] = []
    try:
        import certifi

        found.append(certifi.where())
    except ImportError:
        pass
    try:
        from botocore.httpsession import where as botocore_bundle

        found.append(botocore_bundle())
    except ImportError:
        pass
    return [p for p in found if p and os.path.exists(p)]


def default_ssl_context(ca_bundle: str | None = None) -> ssl.SSLContext:
    path = ca_bundle or os.environ.get("FHIR_CA_BUNDLE") or None
    context = ssl.create_default_context(cafile=path)
    if path is None and context.cert_store_stats().get("x509_ca", 0) == 0:
        for bundle in sdk_ca_bundles():
            context.load_verify_locations(cafile=bundle)
            break
    return context


__all__ = ["default_ssl_context", "sdk_ca_bundles"]
