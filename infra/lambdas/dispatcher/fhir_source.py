"""
Where clinical data comes from. Primitives only ever talk to a `FhirSource`; swapping the hospital's
FHIR server in later is a configuration change, not a code change.

  InMemoryFhirSource  — a FHIR Bundle bundled with the Lambda (data/synthetic-musterstadt.bundle.json,
                        exported from med_app's TypeScript seed). Used until the hospital FHIR
                        server is reachable, and for unit tests.
  HttpFhirSource      — FHIR R4 REST over HTTPS: the reference HAPI server behind an IAM-authorised HTTP API
                        (SigV4), or the hospital gateway (bearer token). Minimal: read, search, create, update.

Both implement the same search parameter subset the primitives rely on:
  patient / subject, code and combo-code (comma list; Observation matches component codes too),
  clinical-status, status, date (ge<iso> prefix), questionnaire, url, identifier (system|value),
  _sort (date | -date), _count

Writes: `create(resource, if_none_exist=…)` is a FHIR conditional create — when a resource already
matches the given search, it is returned instead of a duplicate being made. Write primitives use the
client-generated submission identifier for that, so a retried submit is one record, not two.
`update(resource, if_match=…)` is a versioned update: with `if_match` set to the version the client
saw, a record changed in the meantime is not overwritten (VersionConflict → 409).
In-memory writes live in the process (a warm Lambda container) and vanish on cold start: fine for
demos on bundled data, and the reason the hospital's FHIR server is the system of record.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Protocol

from medapp_shared.oauth2 import TokenError
from medapp_shared.tls import default_ssl_context, sdk_ca_bundles

Resource = dict[str, Any]


class FhirSource(Protocol):
    def read(self, resource_type: str, resource_id: str) -> Resource | None: ...
    def search(self, resource_type: str, params: dict[str, str], max_pages: int | None = None) -> list[Resource]: ...
    def create(self, resource: Resource, if_none_exist: dict[str, str] | None = None) -> Resource: ...
    def update(self, resource: Resource, if_match: str | None = None) -> Resource: ...


class ConditionalCreateAmbiguous(RuntimeError):
    """More than one existing resource matched an If-None-Exist search (FHIR: 412 Precondition Failed)."""


class VersionConflict(RuntimeError):
    """An update named a version (If-Match) that is no longer current: someone else changed the record first."""


class UpstreamError(RuntimeError):
    """The FHIR server answered with an error the primitives cannot interpret (or did not answer at all)."""

    def __init__(self, status: int | None, message: str, method: str = "", url: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.method = method
        self.url = url


# ── helpers shared by sources and primitives ─────────────────────────────────────────────


def patient_id_of(ref: str) -> str:
    return ref[len("Patient/") :] if ref.startswith("Patient/") else ref


ATC = "http://www.whocc.no/atc"
ICD10GM = "http://fhir.de/CodeSystem/bfarm/icd-10-gm"


def is_class_code(system: str | None, code: str) -> bool:
    """Two code systems carry their hierarchy in the code itself, and a filter may name a level above the leaf: an ATC
    class (fewer than the seven characters of a substance — `C09A` ACE inhibitors covers `C09AA05` ramipril) or an
    ICD-10-GM category (the three characters before the dot — `I10` covers `I10.00`, `I10.90`). Mirror of
    `isClassCode` in med_app/src/primitives/data/fhirHelpers.ts. A real server matches tokens exactly, so `fhir_query`
    takes such codes out of the request and filters here."""
    if system == ATC:
        return len(code) < 7
    if system == ICD10GM:
        return "." not in code and len(code) == 3
    return False


def code_matches(coding: dict[str, Any], wanted_system: str | None, wanted_code: str) -> bool:
    """One coding against one wanted `system|code` (or bare code): equal, or under it in a hierarchy the system carries."""
    code = coding.get("code")
    if not code:
        return False
    if wanted_system and coding.get("system") != wanted_system:
        return False
    if code == wanted_code:
        return True
    if not wanted_system or not is_class_code(wanted_system, wanted_code):
        return False
    return str(code).startswith(wanted_code) if wanted_system == ATC else str(code).startswith(f"{wanted_code}.")


def concept_matches(concept: dict[str, Any] | None, wanted: Iterable[str]) -> bool:
    """`system|code` or a bare code matches a CodeableConcept — a class or category matches every code under it."""
    codings = (concept or {}).get("coding") or []
    for w in wanted:
        system, code = (w.split("|", 1) if "|" in w else (None, w))
        for c in codings:
            if code_matches(c, system or None, code):
                return True
    return False


def subject_is(resource: Resource, patient_id: str) -> bool:
    """The patient a resource is about: `subject` on most types, `patient` on AllergyIntolerance and Immunization, `for` on Task."""
    ref = (resource.get("subject") or resource.get("patient") or resource.get("for") or {}).get("reference")
    return ref == f"Patient/{patient_id}"


def resource_date(r: Resource) -> str:
    """The clinically meaningful timestamp per resource type, for sorting and `date` filters."""
    return (
        r.get("createdDateTime")  # Media: when the photo was taken, before when it was stored (issued) — as fhirHelpers.ts
        or r.get("effectiveDateTime")
        or (r.get("effectivePeriod") or {}).get("start")
        or r.get("issued")
        or r.get("onsetDateTime")
        or r.get("recordedDate")  # AllergyIntolerance
        or r.get("performedDateTime")  # Procedure
        or (r.get("performedPeriod") or {}).get("start")
        or r.get("occurrenceDateTime")  # Immunization
        or (r.get("period") or {}).get("start")  # Encounter
        or r.get("date")  # DocumentReference
        or r.get("authoredOn")
        or r.get("authored")
        or r.get("statusDate")  # Goal
        or r.get("created")  # CarePlan
        or r.get("dateTime")  # Consent
        or r.get("started")
        or (r.get("meta") or {}).get("lastUpdated")  # a kind with no date of its own: when it was written
        or ""
    )


def token_in_concepts(concepts: Any, token: str) -> bool:
    """FHIR token search over a CodeableConcept or a list of them (`category`, `type`): `code` or `system|code`."""
    system, code = (token.split("|", 1) if "|" in token else (None, token))
    items = concepts if isinstance(concepts, list) else ([concepts] if concepts else [])
    for concept in items:
        for coding in (concept or {}).get("coding") or []:
            if coding.get("code") == code and (system is None or coding.get("system") == system):
                return True
    return False


def identifier_matches(resource: Resource, token: str) -> bool:
    """FHIR token search on `identifier`: `system|value`, `|value` (no system) or bare `value`."""
    system, value = (token.split("|", 1) if "|" in token else (None, token))
    ids = resource.get("identifier")
    ids = ids if isinstance(ids, list) else ([ids] if ids else [])
    for ident in ids:
        if ident.get("value") != value:
            continue
        if system is None or (system == "" and not ident.get("system")) or ident.get("system") == system:
            return True
    return False


def newest_first(items: list[Resource]) -> list[Resource]:
    return sorted(items, key=resource_date, reverse=True)


def component_quantity(obs: Resource, code: str) -> dict[str, Any] | None:
    for c in obs.get("component") or []:
        if concept_matches(c.get("code"), [code]):
            return c.get("valueQuantity")
    return None


# ── in-memory bundle ─────────────────────────────────────────────────────────────────────


class InMemoryFhirSource:
    def __init__(self, resources: Iterable[Resource], id_factory: Callable[[str], str] | None = None):
        self._by_key: dict[tuple[str, str], Resource] = {}
        self._by_type: dict[str, list[Resource]] = {}
        self._history: dict[tuple[str, str], list[Resource]] = {}
        self._new_id = id_factory or (lambda resource_type: uuid.uuid4().hex[:16])
        for r in resources:
            self._add(r)

    def _add(self, r: Resource) -> None:
        rt, rid = r.get("resourceType"), r.get("id")
        if not rt or not rid:
            return
        self._by_key[(rt, rid)] = r
        self._by_type.setdefault(rt, []).append(r)

    @classmethod
    def from_bundle(cls, bundle: dict[str, Any], id_factory: Callable[[str], str] | None = None) -> "InMemoryFhirSource":
        return cls((e["resource"] for e in bundle.get("entry", []) if e.get("resource")), id_factory=id_factory)

    @classmethod
    def from_file(cls, path: str | Path, id_factory: Callable[[str], str] | None = None) -> "InMemoryFhirSource":
        with open(path, encoding="utf-8") as f:
            return cls.from_bundle(json.load(f), id_factory=id_factory)

    def read(self, resource_type: str, resource_id: str) -> Resource | None:
        return self._by_key.get((resource_type, resource_id))

    def search(self, resource_type: str, params: dict[str, str], max_pages: int | None = None) -> list[Resource]:
        # `max_pages` is a paging limit for HTTP sources; the in-memory source has everything at hand and ignores it.
        items = list(self._by_type.get(resource_type, []))
        patient = params.get("patient") or params.get("subject")
        if patient:
            pid = patient_id_of(patient)
            items = [r for r in items if subject_is(r, pid)]
        # `code` and `combo-code` both match Observation.code and component codes here (the in-memory
        # matcher always looks inside panels); on a real server only combo-code does, so primitives use it.
        code_param = params.get("combo-code") or params.get("code")
        if code_param:
            codes = [c.strip() for c in code_param.split(",") if c.strip()]
            items = [r for r in items if self._code_matches(r, codes)]
        if params.get("clinical-status"):
            want = params["clinical-status"]
            items = [r for r in items if any(c.get("code") == want for c in (r.get("clinicalStatus") or {}).get("coding") or [])]
        if params.get("status"):
            wanted = {w.strip() for w in params["status"].split(",") if w.strip()}  # a token list is an OR, as on a server
            items = [r for r in items if r.get("status") in wanted]
        if params.get("questionnaire"):
            items = [r for r in items if r.get("questionnaire") == params["questionnaire"]]
        if params.get("url"):
            items = [r for r in items if r.get("url") == params["url"]]
        if params.get("identifier"):
            items = [r for r in items if identifier_matches(r, params["identifier"])]
        if params.get("name"):
            needle = params["name"].casefold()
            items = [r for r in items if any(needle in part.casefold() for name in r.get("name") or [] for part in [name.get("text") or "", name.get("family") or "", *(name.get("given") or [])] if part)]
        if params.get("category"):
            items = [r for r in items if token_in_concepts(r.get("category"), params["category"])]
        if params.get("type"):
            items = [r for r in items if token_in_concepts(r.get("type"), params["type"])]
        if params.get("date", "").startswith("ge"):
            since = params["date"][2:]
            items = [r for r in items if resource_date(r) >= since]
        items = newest_first(items)
        if params.get("_sort") == "date":
            items.reverse()
        elif params.get("_sort") == "family":  # the patient picker's first page: by family name, as the server would sort
            items.sort(key=lambda r: ((r.get("name") or [{}])[0].get("family") or "").casefold())
        count = int(params.get("_count", "0") or 0)
        return items[:count] if count > 0 else items

    def create(self, resource: Resource, if_none_exist: dict[str, str] | None = None) -> Resource:
        resource_type = str(resource.get("resourceType") or "")
        if not resource_type:
            raise ValueError("resource has no resourceType")
        if if_none_exist:
            existing = self.search(resource_type, if_none_exist)
            if len(existing) > 1:
                raise ConditionalCreateAmbiguous(f"{len(existing)} {resource_type} resources match {if_none_exist}")
            if existing:
                return existing[0]
        stored = dict(resource)
        stored["id"] = self._new_id(resource_type)
        meta = dict(stored.get("meta") or {})
        meta["versionId"] = "1"
        meta.setdefault("lastUpdated", stored.get("authored") or "")
        stored["meta"] = meta
        self._add(stored)
        return stored

    def update(self, resource: Resource, if_match: str | None = None) -> Resource:
        resource_type, resource_id = str(resource.get("resourceType") or ""), str(resource.get("id") or "")
        current = self._by_key.get((resource_type, resource_id))
        if current is None:
            raise LookupError(f"{resource_type}/{resource_id} was not found")
        current_version = str((current.get("meta") or {}).get("versionId") or "1")
        if if_match is not None and str(if_match) != current_version:
            raise VersionConflict(f"{resource_type}/{resource_id} is at version {current_version}, not {if_match}")
        self._history.setdefault((resource_type, resource_id), []).append(current)
        stored = dict(resource)
        meta = dict(stored.get("meta") or {})
        meta["versionId"] = str(int(current_version) + 1)
        stored["meta"] = meta
        self._by_key[(resource_type, resource_id)] = stored
        self._by_type[resource_type] = [stored if r is current else r for r in self._by_type.get(resource_type, [])]
        return stored

    def history(self, resource_type: str, resource_id: str) -> list[Resource]:
        """Earlier versions, oldest first (what a real server serves under `_history`)."""
        return list(self._history.get((resource_type, resource_id), []))

    @staticmethod
    def _code_matches(r: Resource, codes: list[str]) -> bool:
        if r.get("resourceType") == "MedicationRequest":
            return concept_matches(r.get("medicationCodeableConcept"), codes)
        if concept_matches(r.get("code"), codes):
            return True
        return any(concept_matches(c.get("code"), codes) for c in r.get("component") or [])


# ── hospital FHIR server (later) ─────────────────────────────────────────────────────────


RequestSigner = Callable[[str, str, dict[str, str], bytes | None], dict[str, str]]


# TLS trust lives with the other outbound clients (the OAuth2 token request shares it); the name stays importable here.
_sdk_ca_bundles = sdk_ca_bundles


def operation_outcome_text(body: bytes | None) -> str:
    """The human-readable part of an OperationOutcome an error response carries, or nothing."""
    if not body:
        return ""
    try:
        outcome = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(outcome, dict) or outcome.get("resourceType") != "OperationOutcome":
        return ""
    texts = []
    for issue in outcome.get("issue") or []:
        text = issue.get("diagnostics") or (issue.get("details") or {}).get("text")
        if text:
            texts.append(str(text))
    return "; ".join(texts)[:500]


class HttpFhirSource:
    """
    FHIR R4 REST client (read, search, create, update) with no dependencies beyond the standard library.
    Follows `next` links up to `max_pages`. Authentication is pluggable: a bearer token, or a request
    signer (SigV4 for the IAM-authorised HTTP API in front of the reference server). Errors the
    primitives can act on are typed (`VersionConflict`, `ConditionalCreateAmbiguous`, `LookupError`);
    everything else the server refuses surfaces as `UpstreamError` with the OperationOutcome text.
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout_s: float = 8.0,
        max_pages: int = 10,
        signer: RequestSigner | None = None,
        ca_bundle: str | None = None,
        token_provider: Callable[[], str] | None = None,
    ):
        self._base = base_url.rstrip("/")
        self._token = token
        self._token_provider = token_provider  # a fresh bearer token per request (OAuth2 client credentials), instead of a static one
        self._timeout = timeout_s
        self._max_pages = max_pages
        self._signer = signer
        self._ca_bundle = ca_bundle
        self._ssl: ssl.SSLContext | None = None
        self._root_paging_slash = False  # learned: this gateway needs `/fhir/?_getpages=…`, not `/fhir?_getpages=…`

    @property
    def base_url(self) -> str:
        return self._base

    @property
    def ssl_context(self) -> ssl.SSLContext:
        if self._ssl is None:
            self._ssl = default_ssl_context(self._ca_bundle)
        return self._ssl

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        token = self._token_provider() if self._token_provider is not None else self._token
        return {"accept": "application/fhir+json", **({"authorization": f"Bearer {token}"} if token else {}), **(extra or {})}

    def _send(self, method: str, url: str, headers: dict[str, str] | None = None, body: bytes | None = None) -> tuple[int, bytes, dict[str, str]]:
        """
        One HTTP exchange → (status, body, response headers). HTTP errors are raised as urllib HTTPError — except a
        401 on a token the provider handed out, which is retried once with a fresh token (the server may have
        revoked it, or its clock runs ahead of the expiry we computed).
        """
        try:
            return self._exchange(method, url, headers, body)
        except urllib.error.HTTPError as err:
            if err.code == 401 and self._token_provider is not None and hasattr(self._token_provider, "invalidate"):
                self._token_provider.invalidate()
                return self._exchange(method, url, headers, body)
            raise

    def _exchange(self, method: str, url: str, headers: dict[str, str] | None, body: bytes | None) -> tuple[int, bytes, dict[str, str]]:
        try:
            final = self._headers(headers)
        except TokenError as err:
            raise UpstreamError(None, f"no token for the FHIR server: {err}", method, url) from err
        if self._signer is not None:
            final = self._signer(method, url, final, body)
        req = urllib.request.Request(url, data=body, method=method, headers=final)
        try:
            with urllib.request.urlopen(req, timeout=self._timeout, context=self.ssl_context) as res:  # noqa: S310 — URL is configuration, not user input
                return res.status, res.read(), {k.lower(): v for k, v in res.headers.items()}
        except urllib.error.HTTPError:
            raise
        except urllib.error.URLError as err:
            if isinstance(err.reason, ssl.SSLCertVerificationError):
                why = getattr(err.reason, "verify_message", None) or str(err.reason)
                raise UpstreamError(None, f"TLS certificate of {urllib.parse.urlsplit(url).hostname} could not be verified ({why}); set FHIR_CA_BUNDLE to a PEM file with the issuing CA", method, url) from err
            raise UpstreamError(None, f"FHIR server unreachable: {err.reason}", method, url) from err
        except TimeoutError as err:
            raise UpstreamError(None, f"FHIR server did not answer within {self._timeout:g}s", method, url) from err

    def _upstream(self, err: urllib.error.HTTPError, method: str, url: str) -> UpstreamError:
        text = operation_outcome_text(err.read())
        return UpstreamError(err.code, f"FHIR server answered {err.code}" + (f": {text}" if text else ""), method, url)

    # HAPI keeps the result set of a search and answers an identical search from it for `reuse_cached_search_results_millis`
    # (60 s by default — a hospital's HAPI typically runs the default; the reference server sets 0). An app that records an assessment
    # and lists the earlier ones would then show the new record a minute late. HAPI honours the standard header: searched
    # pages are asked for fresh. Reads by id are not cached that way and are left alone.
    SEARCH_HEADERS = {"cache-control": "no-cache"}

    def _get(self, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
        _, raw, _ = self._send("GET", url, headers)
        return json.loads(raw)

    def create(self, resource: Resource, if_none_exist: dict[str, str] | None = None) -> Resource:
        resource_type = str(resource.get("resourceType") or "")
        if not resource_type:
            raise ValueError("resource has no resourceType")
        headers = {"content-type": "application/fhir+json", "prefer": "return=representation"}
        if if_none_exist:
            headers["if-none-exist"] = urllib.parse.urlencode(if_none_exist, quote_via=urllib.parse.quote)  # FHIR conditional create
        body = json.dumps(resource).encode("utf-8")
        url = f"{self._base}/{resource_type}"
        try:
            _, raw, res_headers = self._send("POST", url, headers, body)
        except urllib.error.HTTPError as err:
            if err.code == 412:
                raise ConditionalCreateAmbiguous(f"{resource_type}: {if_none_exist}") from err
            raise self._upstream(err, "POST", url) from err
        location = res_headers.get("location") or res_headers.get("content-location") or ""
        if raw:
            created = json.loads(raw)
            if created.get("resourceType") == resource_type:
                return created
        # Servers answering 200/201 without a body (or with an OperationOutcome) point at the resource.
        match = re.search(rf"{re.escape(resource_type)}/([A-Za-z0-9\-.]{{1,64}})", location)
        if match:
            fetched = self.read(resource_type, match.group(1))
            if fetched:
                return fetched
        raise UpstreamError(None, f"{resource_type} create returned no resource", "POST", url)

    def update(self, resource: Resource, if_match: str | None = None) -> Resource:
        resource_type, resource_id = str(resource.get("resourceType") or ""), str(resource.get("id") or "")
        if not resource_type or not resource_id:
            raise ValueError("update needs resourceType and id")
        headers = {"content-type": "application/fhir+json", "prefer": "return=representation"}
        if if_match is not None:
            headers["if-match"] = f'W/"{if_match}"'  # FHIR version-aware update
        body = json.dumps(resource).encode("utf-8")
        url = f"{self._base}/{resource_type}/{urllib.parse.quote(resource_id)}"
        try:
            _, raw, _ = self._send("PUT", url, headers, body)
        except urllib.error.HTTPError as err:
            if err.code in (409, 412):
                raise VersionConflict(f"{resource_type}/{resource_id}: version {if_match} is not current") from err
            if err.code == 404:
                raise LookupError(f"{resource_type}/{resource_id} was not found") from err
            raise self._upstream(err, "PUT", url) from err
        if raw:
            updated = json.loads(raw)
            if updated.get("resourceType") == resource_type:
                return updated
        fetched = self.read(resource_type, resource_id)
        if fetched:
            return fetched
        raise UpstreamError(None, f"{resource_type} update returned no resource", "PUT", url)

    def read(self, resource_type: str, resource_id: str) -> Resource | None:
        url = f"{self._base}/{resource_type}/{urllib.parse.quote(resource_id)}"
        try:
            return self._get(url)
        except urllib.error.HTTPError as err:
            if err.code in (404, 410):
                return None
            raise self._upstream(err, "GET", url) from err

    def get(self, path: str) -> Resource:
        """GET a path under the base (`Condition/x/_history`, `Provenance?_count=3`, `metadata`) or an absolute URL, as JSON."""
        url = path if path.startswith(("http://", "https://")) else f"{self._base}/{path.lstrip('/')}"
        try:
            return self._get(url)
        except urllib.error.HTTPError as err:
            raise self._upstream(err, "GET", url) from err

    def search(self, resource_type: str, params: dict[str, str], max_pages: int | None = None) -> list[Resource]:
        """
        Follows `next` links up to `max_pages` (the source's default otherwise). `max_pages=1` with `_sort` set is how
        a primitive asks for "the newest few" without paying for paging: HAPI answers a `_count` that covers the
        result in one round trip (~0.3 s on a hospital's HAPI) but spends ~1.5 s creating a cached search for a
        `_count=1`, and returns ten results regardless.
        """
        out: list[Resource] = []
        for page in self.iter_search(resource_type, params, max_pages):
            out.extend(page)
        return out

    def iter_search(self, resource_type: str, params: dict[str, str], max_pages: int | None = None) -> Iterator[list[Resource]]:
        """The same search, one page at a time — for a scan that must watch the clock (the record vocabulary)."""
        # Percent-encoding throughout (no `+` for spaces): what is signed is exactly what the gateway canonicalises.
        url = f"{self._base}/{resource_type}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"
        for _ in range(max_pages if max_pages is not None else self._max_pages):
            try:
                bundle = self._get(url, self.SEARCH_HEADERS)
            except urllib.error.HTTPError as err:
                # HAPI pages from the server root (`/fhir?_getpages=…`). A gateway that routes `/fhir/{proxy+}` but not
                # `/fhir` itself answers 404 there; `/fhir/?_getpages=…` reaches the server. Learn it once per source.
                if err.code == 404 and self._is_root_paging(url) and not self._root_paging_slash:
                    self._root_paging_slash = True
                    url = self.rebase(url)
                    try:
                        bundle = self._get(url, self.SEARCH_HEADERS)
                    except urllib.error.HTTPError as again:
                        raise self._upstream(again, "GET", url) from again
                else:
                    raise self._upstream(err, "GET", url) from err
            yield [e["resource"] for e in bundle.get("entry", []) if e.get("resource")]
            nxt = next((l["url"] for l in bundle.get("link", []) if l.get("relation") == "next"), None)
            if not nxt:
                return
            url = self.rebase(nxt)

    def _is_root_paging(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        return parts.path.rstrip("/") == urllib.parse.urlsplit(self._base).path.rstrip("/") and "_getpages" in parts.query

    def rebase(self, link: str) -> str:
        """
        A `next` (or any) link the server wrote, made to go through the door we came in by. A server behind a gateway
        often does not know its public address: a HAPI behind a gateway writes `http://<api host>/fhir?_getpages=…` — plain
        HTTP, which the gateway does not serve — and a HAPI with no server_address writes `http://localhost:8080/…`.
        The path from our base's last segment on is kept; scheme and host become ours; the server root gets a
        trailing slash once the gateway has shown it needs one.
        """
        base, target = urllib.parse.urlsplit(self._base), urllib.parse.urlsplit(link)
        base_path = base.path.rstrip("/")
        path = target.path
        if (target.scheme, target.netloc) != (base.scheme, base.netloc) and base_path:
            marker = path.find(base_path)
            path = path[marker:] if marker >= 0 else f"{base_path}/{path.lstrip('/')}"
        if self._root_paging_slash and path.rstrip("/") == base_path:
            path = f"{base_path}/"
        return urllib.parse.urlunsplit((base.scheme, base.netloc, path, target.query, ""))

    def transaction(self, bundle: Resource) -> Resource:
        """POST a transaction/batch Bundle to the server root; returns the response Bundle."""
        body = json.dumps(bundle).encode("utf-8")
        try:
            _, raw, _ = self._send("POST", self._base, {"content-type": "application/fhir+json"}, body)
        except urllib.error.HTTPError as err:
            raise self._upstream(err, "POST", self._base) from err
        return json.loads(raw) if raw else {}

    def capability_statement(self) -> Resource:
        url = f"{self._base}/metadata"
        try:
            return self._get(url)
        except urllib.error.HTTPError as err:
            raise self._upstream(err, "GET", url) from err


def http_source_from_env(base_url: str) -> HttpFhirSource:
    """
    FHIR_AUTH selects how requests authenticate:
      sigv4   — signed with the Lambda's IAM role (FHIR_SIGV4_SERVICE, default execute-api): the reference server
      oauth2  — a bearer token from the hospital's token endpoint, client-credentials grant (FHIR_TOKEN_URL,
                FHIR_OAUTH_SCOPE, FHIR_CREDENTIALS_SECRET or FHIR_CLIENT_ID/FHIR_CLIENT_SECRET): the hospital's gateway
      bearer  — FHIR_BEARER_TOKEN as `Authorization: Bearer …`: a gateway with static tokens
      none    — no credentials (a server on a private network that authenticates by other means)
    Unset, it is `bearer` when FHIR_BEARER_TOKEN is present and `none` otherwise — the behaviour before FHIR_AUTH existed.
    """
    auth = (os.environ.get("FHIR_AUTH") or ("bearer" if os.environ.get("FHIR_BEARER_TOKEN") else "none")).lower()
    timeout = float(os.environ.get("FHIR_TIMEOUT_S") or 8.0)
    ca_bundle = os.environ.get("FHIR_CA_BUNDLE") or None  # TLS trust beyond the platform's: a private CA, a corporate proxy
    if auth == "sigv4":
        from medapp_shared.sigv4 import SigV4Signer

        return HttpFhirSource(base_url, timeout_s=timeout, signer=SigV4Signer(service=os.environ.get("FHIR_SIGV4_SERVICE") or "execute-api"), ca_bundle=ca_bundle)
    if auth == "oauth2":
        from medapp_shared.oauth2 import shared_client_credentials

        return HttpFhirSource(base_url, timeout_s=timeout, token_provider=shared_client_credentials("FHIR_"), ca_bundle=ca_bundle)
    if auth == "bearer":
        token = os.environ.get("FHIR_BEARER_TOKEN")
        if not token:
            raise ValueError("FHIR_AUTH=bearer needs FHIR_BEARER_TOKEN")
        return HttpFhirSource(base_url, token=token, timeout_s=timeout, ca_bundle=ca_bundle)
    if auth == "none":
        return HttpFhirSource(base_url, timeout_s=timeout, ca_bundle=ca_bundle)
    raise ValueError(f"FHIR_AUTH must be sigv4, oauth2, bearer or none, not {auth!r}")


def source_from_env() -> FhirSource:
    """DATA_SOURCE=bundle (default) → the bundled synthetic data · DATA_SOURCE=fhir → FHIR_BASE_URL (+ FHIR_AUTH)."""
    if os.environ.get("DATA_SOURCE", "bundle") == "fhir":
        return http_source_from_env(os.environ["FHIR_BASE_URL"])
    path = os.environ.get("BUNDLE_PATH") or str(Path(__file__).resolve().parent / "data" / "synthetic-musterstadt.bundle.json")
    return InMemoryFhirSource.from_file(path)
