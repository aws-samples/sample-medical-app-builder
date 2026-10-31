"""
Registry data model — keys, item shapes and invariants shared by every Lambda that touches the
app registry table (registry API, pipeline writer, pre-token generation, dispatcher).

Pure Python, no AWS dependencies, so it is unit-testable and importable from anywhere.
The authoritative description is infra/docs/registry-table.md.
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

import hashlib
import json
import re


# ─────────────────────────────────────────────────────────────────────────────
# Lifecycle
# ─────────────────────────────────────────────────────────────────────────────

LIFECYCLE_STATES = ("draft", "in_review", "approved", "published", "deprecated")

# from → allowed targets. `in_review → draft` is a rejection; `approved → draft` reopens.
LIFECYCLE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("in_review", "deprecated"),
    "in_review": ("approved", "draft", "deprecated"),
    "approved": ("published", "draft", "deprecated"),
    "published": ("deprecated",),
    "deprecated": (),
}

# Attributes the lifecycle writer may ever modify on a VERSION item. Mirror this list in the
# IAM policy (dynamodb:Attributes) of the lifecycle Lambda — manifest_json is deliberately absent.
LIFECYCLE_MUTABLE_ATTRIBUTES = ("state", "updated_at", "signoff", "renderer", "GSI1PK", "GSI1SK")


class IllegalTransition(ValueError):
    pass


def assert_transition(from_state: str, to_state: str) -> None:
    if from_state not in LIFECYCLE_TRANSITIONS:
        raise IllegalTransition(f"unknown state {from_state!r}")

    if to_state not in LIFECYCLE_TRANSITIONS[from_state]:
        raise IllegalTransition(f"{from_state} → {to_state} is not an allowed transition")


# ─────────────────────────────────────────────────────────────────────────────
# Versions and keys
# ─────────────────────────────────────────────────────────────────────────────

_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
HEAD_SK = "HEAD"
REGISTRY_GSI1PK = "REGISTRY"

# What GSI1 carries besides its keys (RegistryStack projects exactly these — list views need them and never the manifest
# body). Anything else on an item is NOT in an index result: a reader that needs a collection's `app_ids`, a version's
# manifest or a head's full record must fetch the item by key after the index has named it. Test doubles honour this list.
GSI1_PROJECTED_ATTRIBUTES: tuple[str, ...] = ("type", "app_id", "name", "intent_class", "version", "state", "updated_at", "latest_version", "active_version", "roles", "manifest_hash", "created_by_sub")


def pad_version(version: str) -> str:
    """'0.3.0' → '00000.00003.00000' so lexical sort order equals version order."""
    m = _SEMVER.match(version)

    if not m:
        raise ValueError(f"not an exact semver: {version!r}")

    major, minor, patch = (int(g) for g in m.groups())

    if max(major, minor, patch) > 99_999:
        raise ValueError("version component exceeds 5 digits")

    return f"{major:05d}.{minor:05d}.{patch:05d}"


def unpad_version(vpad: str) -> str:
    return ".".join(str(int(part)) for part in vpad.split("."))


def next_minor(version: str) -> str:
    """The version a new iteration gets: 0.3.1 → 0.4.0. Authors do not pick version numbers."""
    m = _SEMVER.match(version)

    if not m:
        raise ValueError(f"not an exact semver: {version!r}")

    major, minor, _patch = (int(g) for g in m.groups())
    return f"{major}.{minor + 1}.0"


def app_pk(app_id: str) -> str:
    return f"APP#{app_id}"


def version_sk(version: str) -> str:
    return f"V#{pad_version(version)}"


def event_sk(version: str, ts: str) -> str:
    return f"EVT#{pad_version(version)}#{ts}"


def artifact_pk(artifact_type: str, name: str) -> str:
    return f"ARTIFACT#{artifact_type}#{name}"


def head_gsi1(name: str, app_id: str) -> dict[str, str]:
    return {"GSI1PK": REGISTRY_GSI1PK, "GSI1SK": f"NAME#{name.strip().lower()}#{app_id}"}


def state_gsi1(state: str, updated_at: str, app_id: str, version: str) -> dict[str, str]:
    if state not in LIFECYCLE_STATES:
        raise ValueError(f"unknown state {state!r}")

    return {"GSI1PK": f"STATE#{state}", "GSI1SK": f"{updated_at}#{app_id}#{pad_version(version)}"}


# ─────────────────────────────────────────────────────────────────────────────
# Hashing
# ─────────────────────────────────────────────────────────────────────────────


def canonical_json(value: Any) -> str:
    """Deterministic serialisation: sorted keys, no whitespace, UTF-8 preserved."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_prefixed(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def manifest_hash(manifest_json: str) -> str:
    """Hash over the exact stored bytes, so any reader can re-verify with one call."""
    return sha256_prefixed(manifest_json)


def effective_scope(manifest: Mapping[str, Any], role_id: str) -> dict[str, Any]:
    """
    Resolve a role's data scope following `inherits`, base → leaf. Mirrors
    med_app/src/manifest/roles.ts::resolveEffectiveScope; the two must stay identical because the
    dispatcher compares hashes computed here with the renderer's expectations.
    """
    roles = {r["id"]: r for r in manifest["auth"]["roles"]}

    if role_id not in roles:
        raise KeyError(f"role {role_id!r} not declared")

    scopes = manifest["data_scopes"]
    chain: list[str] = []
    cursor: str | None = roles[role_id]["data_scope_ref"]
    seen: set[str] = set()

    while cursor:
        if cursor in seen:
            raise ValueError(f"cyclic scope inheritance at {cursor!r}")

        seen.add(cursor)
        chain.insert(0, cursor)
        cursor = scopes[cursor].get("inherits")

    fhir: list[Any] = []
    dicom: list[Any] = []
    patient_scope = "individual"
    phi: list[str] = []

    for scope_id in chain:
        scope = scopes[scope_id]
        fhir.extend(scope.get("fhir", []))
        dicom.extend(scope.get("dicom", []))

        if scope.get("patient_scope"):
            patient_scope = scope["patient_scope"]

        if "phi_fields_visible" in scope:
            phi = list(scope["phi_fields_visible"])

    return {"role": role_id, "fhir": fhir, "dicom": dicom, "patient_scope": patient_scope, "phi_fields_visible": phi, "lineage": chain}


def data_scope_hashes(manifest: Mapping[str, Any]) -> dict[str, str]:
    """
    Per-role digest of the effective scope, stored on the VERSION item. Not a token claim:
    authorisation is request-level. It is recorded on every audit record (which scope applied) and
    lets a reviewer see at a glance whether a role's scope changed between two versions.
    """
    return {r["id"]: sha256_prefixed(canonical_json(effective_scope(manifest, r["id"]))) for r in manifest["auth"]["roles"]}


# ─────────────────────────────────────────────────────────────────────────────
# Item factories
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RoleSummary:
    id: str
    display_name: str
    cognito_group: str

    @staticmethod
    def from_manifest(manifest: Mapping[str, Any]) -> list["RoleSummary"]:
        return [RoleSummary(r["id"], r["display_name"], r["cognito_group"]) for r in manifest["auth"]["roles"]]


def head_item(manifest: Mapping[str, Any], *, owner_sub: str, now: str, latest_version: str, active_version: str | None = None, latest_state: str = "draft") -> dict[str, Any]:
    meta = manifest["metadata"]

    return {
        "PK": app_pk(meta["app_id"]),
        "SK": HEAD_SK,
        "type": "HEAD",
        "app_id": meta["app_id"],
        "hospital_id": meta["hospital_id"],
        "name": meta["name"],
        "description": meta.get("description"),
        "intent_class": meta["intent_class"],
        "owner_sub": owner_sub,
        "created_at": now,
        "updated_at": now,
        "latest_version": latest_version,
        "active_version": active_version,
        "latest_state": latest_state,
        "roles": [vars(r) for r in RoleSummary.from_manifest(manifest)],
        **head_gsi1(meta["name"], meta["app_id"]),
    }


def version_item(
    manifest: Mapping[str, Any],
    *,
    created_by_sub: str,
    now: str,
    provenance: Mapping[str, Any] | None = None,
    state: str = "draft",
    signoff: Mapping[str, Any] | None = None,
    spec: Mapping[str, Any] | None = None,
    session_id: str | None = None,
    author: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """
    A VERSION item. The pipeline always creates versions in `draft`; `state`/`signoff` exist for
    seeding and migration, where a version arrives with history. The manifest is stored as canonical
    JSON; while the version is a `draft` its author may revise it in place (RegistryWriter.replace_version,
    each revision an EVENT), and from submission (`in_review`) on it is never touched again — its
    `lifecycle` section is a snapshot; the item's `state`/`signoff` attributes are the truth and readers
    overlay them (present_version). `spec` is the AppSpec the manifest was compiled from (absent for
    hand-authored manifests): it is what "iterate on this app" reopens, and what an approver diffs between
    versions. `session_id` names the drafting conversation that produced the version — the writer stamps
    that conversation with the version's state so the panel knows when it is frozen. `author` is how the person
    who compiled the version is shown — {name, email} from their token at the time — beside `created_by_sub`,
    which is what the rules compare; a name is for people, a sub for decisions.
    """
    if state not in LIFECYCLE_STATES:
        raise ValueError(f"unknown state {state!r}")

    meta = manifest["metadata"]
    body = canonical_json(manifest)

    return {
        "PK": app_pk(meta["app_id"]),
        "SK": version_sk(meta["version"]),
        "type": "VERSION",
        "app_id": meta["app_id"],
        "version": meta["version"],
        "parent_version": meta.get("parent_version"),
        "state": state,
        "manifest_json": body,
        "manifest_hash": manifest_hash(body),
        "spec_json": canonical_json(spec) if spec is not None else None,
        "data_scope_hashes": data_scope_hashes(manifest),
        "signoff": dict(signoff) if signoff else None,
        "provenance": dict(provenance or manifest.get("lifecycle", {}).get("provenance") or {}),
        "renderer": None,
        "created_at": now,
        "created_by_sub": created_by_sub,
        "author": author_label(author),
        "updated_at": now,
        "session_id": session_id,
        **state_gsi1(state, now, meta["app_id"], meta["version"]),
    }


def author_label(author: Mapping[str, Any] | None) -> dict[str, str] | None:
    """{name, email} with the empty parts dropped; None when nothing is known — the panel then shows no author."""
    if not author:
        return None
    out = {k: str(v).strip() for k in ("name", "email") for v in [author.get(k)] if v and str(v).strip()}
    return out or None


def revision_sets(manifest: Mapping[str, Any], spec: Mapping[str, Any] | None, now: str, session_id: str | None) -> dict[str, Any]:
    """The attributes a draft revision replaces on its VERSION item: the manifest and its hash, the spec, the scope hashes."""
    body = canonical_json(manifest)
    return {
        "manifest_json": body,
        "manifest_hash": manifest_hash(body),
        "spec_json": canonical_json(spec) if spec is not None else None,
        "data_scope_hashes": data_scope_hashes(manifest),
        "updated_at": now,
        "session_id": session_id,
    }


def present_version(item: Mapping[str, Any]) -> dict[str, Any]:
    """
    The manifest as consumers should see it: the frozen manifest_json with the item's lifecycle
    state and sign-off overlaid. The stored bytes (and their hash) are never modified.
    """
    manifest = json.loads(item["manifest_json"])
    lifecycle = dict(manifest.get("lifecycle") or {})
    lifecycle["state"] = item["state"]
    lifecycle["signoff"] = item.get("signoff")
    manifest["lifecycle"] = lifecycle

    return manifest


def event_item(
    app_id: str,
    version: str,
    *,
    ts: str,
    actor_sub: str,
    from_state: str | None,
    to_state: str,
    notes: str | None = None,
    signature: str | None = None,
    actor: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """
    An append-only lifecycle event. `from_state=None` records the creation of a version; `draft → draft` a revision of one.
    `actor` is the person as a name and email (from the token), so the history reads as people after they have left.
    """
    if from_state == "draft" and to_state == "draft":
        pass  # a revision: the draft's content changed, its state did not
    elif from_state is not None:
        assert_transition(from_state, to_state)
    elif to_state != "draft":
        raise IllegalTransition("a version is created in draft")

    item = {
        "PK": app_pk(app_id),
        "SK": event_sk(version, ts),
        "type": "EVENT",
        "version": version,
        "ts": ts,
        "actor_sub": actor_sub,
        "from_state": from_state,
        "to_state": to_state,
        "notes": notes,
        "signature": signature,
    }
    who = {k: v for k, v in (actor or {}).items() if k in ("name", "email") and v}
    if who:
        item["actor"] = who
    return item


def present_event(item: Mapping[str, Any]) -> dict[str, Any]:
    """A lifecycle event as the panel shows it: who, when, which step, the notes — never the signature bytes."""
    return {
        "ts": item["ts"],
        "actor_sub": item.get("actor_sub"),
        "actor": item.get("actor") or None,
        "from_state": item.get("from_state"),
        "to_state": item["to_state"],
        "notes": item.get("notes") or None,
        "signed": bool(item.get("signature")),
    }


def newest_first(versions: Iterable[str]) -> list[str]:
    """Order plain semver strings the way the sort key does."""
    return sorted(versions, key=pad_version, reverse=True)


# ─────────────────────────────────────────────────────────────────────────────
# Collections — how the hospital groups its apps for the launcher
# ─────────────────────────────────────────────────────────────────────────────
# A collection is organisation, not a clinical change: it names published apps (overlapping — an app may sit in
# several) and is edited by approvers and admins without touching any version. One item per collection, listed through
# GSI1; a removed collection leaves the listing (its index key changes) but its item stays, like everything else here.

COLLECTIONS_GSI1PK = "COLLECTIONS"
_SLUG = re.compile(r"[^a-z0-9]+")


def collection_pk(collection_id: str) -> str:
    return f"COLLECTION#{collection_id}"


def collection_id_for(name: str) -> str:
    """`col_<slug>` from the name — stable once created (renaming keeps the id)."""
    slug = _SLUG.sub("_", name.strip().lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")).strip("_")
    if not slug:
        raise ValueError("a collection needs a name")
    return f"col_{slug[:48]}"


def collection_gsi1(name: str, collection_id: str, *, deleted: bool = False) -> dict[str, str]:
    return {"GSI1PK": f"{COLLECTIONS_GSI1PK}#deleted" if deleted else COLLECTIONS_GSI1PK, "GSI1SK": f"NAME#{name.strip().lower()}#{collection_id}"}


def collection_item(collection_id: str, *, name: str, description: str | None, app_ids: Iterable[str], now: str, actor_sub: str, actor: Mapping[str, Any] | None = None) -> dict[str, Any]:
    ids = list(dict.fromkeys(str(a) for a in app_ids))  # ordered, de-duplicated
    item: dict[str, Any] = {
        "PK": collection_pk(collection_id),
        "SK": HEAD_SK,
        "type": "COLLECTION",
        "collection_id": collection_id,
        "name": name.strip(),
        "description": (description or "").strip() or None,
        "app_ids": ids,
        "created_at": now,
        "updated_at": now,
        "created_by_sub": actor_sub,
        "updated_by_sub": actor_sub,
        **collection_gsi1(name, collection_id),
    }
    who = {k: v for k, v in (actor or {}).items() if k in ("name", "email") and v}
    if who:
        item["updated_by"] = who
    return item


def present_collection(item: Mapping[str, Any], *, app_ids: Iterable[str] | None = None) -> dict[str, Any]:
    """A collection as the panel reads it; `app_ids` narrows the apps to those the caller may see."""
    return {
        "collection_id": item["collection_id"],
        "name": item["name"],
        "description": item.get("description") or None,
        "app_ids": list(app_ids) if app_ids is not None else list(item.get("app_ids") or []),
        "updated_at": item.get("updated_at"),
        "updated_by": item.get("updated_by") or None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Record shapes — the library of what a `record` section may write
# ─────────────────────────────────────────────────────────────────────────────
# A shape is a RecordShape document (resource, fields, status) compiled to an artifact (the runtime rules plus a
# checksum) that the composer embeds when an app says `shape: <id>`. It lives like an app — HEAD plus versions, each
# version frozen with its history — under a lighter lifecycle: draft → published → deprecated, no review step of its
# own, because the review that matters is the one of the app that writes with it (the approver sees the fields in that
# manifest). Only one version is published at a time; apps keep the artifact they were compiled with, so superseding a
# shape never changes an app already in the registry.

SHAPE_STATES = ("draft", "published", "deprecated")
SHAPE_TRANSITIONS: dict[str, tuple[str, ...]] = {"draft": ("published", "deprecated"), "published": ("deprecated",), "deprecated": ()}
SHAPES_GSI1PK = "SHAPES"
SHAPE_FIRST_VERSION = "0.1.0"


def assert_shape_transition(from_state: str, to_state: str) -> None:
    if from_state not in SHAPE_TRANSITIONS:
        raise IllegalTransition(f"unknown shape state {from_state!r}")
    if to_state not in SHAPE_TRANSITIONS[from_state]:
        raise IllegalTransition(f"{from_state} → {to_state} is not an allowed transition for a shape")


def shape_pk(shape_id: str) -> str:
    return f"SHAPE#{shape_id}"


def shape_gsi1(name: str, shape_id: str) -> dict[str, str]:
    return {"GSI1PK": SHAPES_GSI1PK, "GSI1SK": f"NAME#{name.strip().lower()}#{shape_id}"}


def shape_head_item(artifact: Mapping[str, Any], *, owner_sub: str, now: str, latest_version: str, active_version: str | None = None, latest_state: str = "draft", actor: Mapping[str, Any] | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {
        "PK": shape_pk(artifact["id"]),
        "SK": HEAD_SK,
        "type": "SHAPE",
        "shape_id": artifact["id"],
        "name": artifact["name"],
        "description": artifact.get("description"),
        "resource": artifact["resource"],
        "owner_sub": owner_sub,
        "created_at": now,
        "updated_at": now,
        "updated_by_sub": owner_sub,
        "latest_version": latest_version,
        "active_version": active_version,
        "latest_state": latest_state,
        **shape_gsi1(artifact["name"], artifact["id"]),
    }
    who = author_label(actor)
    if who:
        item["updated_by"] = who
    return item


def shape_version_item(document: Mapping[str, Any], artifact: Mapping[str, Any], *, version: str, created_by_sub: str, now: str, state: str = "draft", parent_version: str | None = None, author: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """
    A SHAPE_VERSION item: the document as written (what an editor reopens) and the artifact the compiler made of it
    (what the composer embeds), both as canonical JSON. A draft is revised in place (shape_revision_sets); from
    publication on it is never touched again.
    """
    if state not in SHAPE_STATES:
        raise ValueError(f"unknown shape state {state!r}")
    doc = canonical_json(document)
    return {
        "PK": shape_pk(artifact["id"]),
        "SK": version_sk(version),
        "type": "SHAPE_VERSION",
        "shape_id": artifact["id"],
        "version": version,
        "parent_version": parent_version,
        "state": state,
        "name": artifact["name"],
        "resource": artifact["resource"],
        "document_json": doc,
        "document_hash": sha256_prefixed(doc),
        "artifact_json": canonical_json(artifact),
        "checksum": artifact.get("checksum"),
        "created_at": now,
        "created_by_sub": created_by_sub,
        "author": author_label(author),
        "updated_at": now,
    }


def shape_revision_sets(document: Mapping[str, Any], artifact: Mapping[str, Any], now: str) -> dict[str, Any]:
    """What a draft revision replaces on its SHAPE_VERSION item."""
    doc = canonical_json(document)
    return {"name": artifact["name"], "resource": artifact["resource"], "document_json": doc, "document_hash": sha256_prefixed(doc), "artifact_json": canonical_json(artifact), "checksum": artifact.get("checksum"), "updated_at": now}


def shape_event_item(shape_id: str, version: str, *, ts: str, actor_sub: str, from_state: str | None, to_state: str, notes: str | None = None, actor: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """An append-only history entry for a shape version: creation (from None), revision (draft → draft), publication, deprecation."""
    if from_state is None:
        if to_state != "draft":
            raise IllegalTransition("a shape version is created in draft")
    elif not (from_state == "draft" and to_state == "draft"):
        assert_shape_transition(from_state, to_state)
    item: dict[str, Any] = {
        "PK": shape_pk(shape_id),
        "SK": event_sk(version, ts),
        "type": "EVENT",
        "version": version,
        "ts": ts,
        "actor_sub": actor_sub,
        "from_state": from_state,
        "to_state": to_state,
        "notes": notes,
        "signature": None,
    }
    who = author_label(actor)
    if who:
        item["actor"] = who
    return item


def present_shape_version(item: Mapping[str, Any]) -> dict[str, Any]:
    """A shape version as the panel edits and the composer embeds it: the document, the artifact, who and when."""
    return {
        "version": item["version"],
        "state": item["state"],
        "parent_version": item.get("parent_version"),
        "document": json.loads(item["document_json"]),
        "artifact": json.loads(item["artifact_json"]),
        "checksum": item.get("checksum"),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "created_by_sub": item.get("created_by_sub"),
        "author": item.get("author") or None,
    }


def present_shape(head: Mapping[str, Any], *, latest: Mapping[str, Any] | None = None, published: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """
    A shape as the library lists it: the head's summary, the latest version whole (what an editor opens) and the
    published artifact (what a compile resolves `shape: <id>` to) when there is one.
    """
    return {
        "shape_id": head["shape_id"],
        "name": head["name"],
        "description": head.get("description") or None,
        "resource": head["resource"],
        "owner_sub": head.get("owner_sub"),
        "latest_version": head.get("latest_version"),
        "latest_state": head.get("latest_state"),
        "active_version": head.get("active_version"),
        "updated_at": head.get("updated_at"),
        "updated_by": head.get("updated_by") or None,
        "latest": present_shape_version(latest) if latest else None,
        "published": {"version": published["version"], "checksum": published.get("checksum"), "artifact": json.loads(published["artifact_json"])} if published else None,
    }
