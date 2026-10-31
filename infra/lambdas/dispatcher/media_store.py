"""
Where the bytes of a photo live. The FHIR record keeps the Media resource — who, when, what it documents, the body
site, a hash and a size — and points at the image with `content.url`; the image itself is an object in the
platform's media bucket (`MEDIA_BUCKET`), encrypted at rest, never public. When a Media resource is read back the
dispatcher swaps that storage URL for a short-lived presigned GET so the panel can show the picture; the record never
holds the bytes, and nobody reads the bucket without a role that may search the patient's Media.

Without a bucket (unit tests, a local run) the store is in memory and presents an image as a data URL, which the
panel renders the same way.
"""

from __future__ import annotations

import base64
import os
from typing import Any, Protocol

STORAGE_SCHEME = "medapp-media://"
PRESIGN_SECONDS = 900


class MediaStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> str:
        """Store the bytes under `key`; return the storage URL the Media resource keeps."""

    def present(self, url: str) -> str | None:
        """A URL the panel can load for a storage URL this store owns (presigned GET, or a data URL); None when not ours."""


def is_storage_url(url: Any) -> bool:
    return isinstance(url, str) and url.startswith(STORAGE_SCHEME)


class MemoryMediaStore:
    """Bytes in a dict; presented as data URLs. Tests and local runs."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self.objects[key] = (data, content_type)
        return f"{STORAGE_SCHEME}{key}"

    def present(self, url: str) -> str | None:
        if not is_storage_url(url):
            return None
        entry = self.objects.get(url[len(STORAGE_SCHEME) :])
        if entry is None:
            return None
        data, content_type = entry
        return f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"


class S3MediaStore:
    """The deployment's media bucket: objects under `<key>`, presigned GETs for the panel."""

    def __init__(self, bucket: str, client: Any = None) -> None:
        import boto3  # local import keeps unit tests free of the SDK

        self.bucket = bucket
        if client is None:
            import logging

            from botocore.config import Config

            # Pinned the way the viewer door pins its spill bucket: SigV4 in its S3 form (UNSIGNED-PAYLOAD in the query
            # signature) and the virtual-hosted regional endpoint — nothing left to the runtime's default resolution.
            client = boto3.client("s3", config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
            # MEDAPP_LOG_SIGNING=1 on the function writes botocore's CanonicalRequest and StringToSign for every signature
            # to the log — the pair to compare with the one S3 prints in a SignatureDoesNotMatch body.
            if os.environ.get("MEDAPP_LOG_SIGNING"):
                logging.getLogger("botocore.auth").setLevel(logging.DEBUG)
                logging.getLogger().setLevel(logging.DEBUG)
        self.client = client

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, CacheControl="private, max-age=0, no-store")
        return f"{STORAGE_SCHEME}{key}"

    def present(self, url: str) -> str | None:
        if not is_storage_url(url):
            return None
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": url[len(STORAGE_SCHEME) :]}, ExpiresIn=PRESIGN_SECONDS)


def media_store_from_env(environ: dict[str, str] | None = None) -> MediaStore:
    env = environ if environ is not None else os.environ
    bucket = env.get("MEDIA_BUCKET")
    return S3MediaStore(bucket) if bucket else MemoryMediaStore()


def present_media(store: MediaStore | None, resource: dict[str, Any]) -> dict[str, Any]:
    """A Media resource as the panel may load it: its storage URL swapped for one the browser can fetch. Resources
    with inline data (the synthetic seed) or foreign URLs pass through unchanged."""
    content = resource.get("content")
    if not isinstance(content, dict) or not is_storage_url(content.get("url")):
        return resource
    presented = store.present(str(content["url"])) if store is not None else None
    if presented is None:
        return resource
    return {**resource, "content": {**content, "url": presented}}


__all__ = ["MediaStore", "MemoryMediaStore", "S3MediaStore", "media_store_from_env", "present_media", "is_storage_url", "STORAGE_SCHEME"]
