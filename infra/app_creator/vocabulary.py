"""
The record's vocabulary, as the agent reads it: the codes actually present on the connected FHIR server, with their
display texts, how often they occur and for how many patients. Built by the data source's seed function
(`lambdas/dispatcher/vocabulary.py`) and stored as one JSON document; loaded here from S3 (the deployed agent), from a
file (the harness, the evaluation corpus) or not at all (unit tests, a deployment whose seed has not run yet — the
assistant then works from the catalog's hand-written hints alone).

Searching is deliberately simple and spelling-tolerant: display texts and the search term are folded to lower-case
ASCII (Hämoglobin → hamoglobin), and every word of the term must occur in the text. The record's displays are in the
hospital's language; the model is told to try the term as the record would spell it. An exact code is matched as such,
so a code the model knows from memory is verified against the record before it is used.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("app_creator.vocabulary")

DEFAULT_KEY = "record-vocabulary.json"
SUPPORTED_VERSIONS = (1,)


@dataclass(frozen=True)
class AlternateCoding:
    """Another coding the record puts on the same resources as a code (SNOMED CT beside ICD-10-GM on one Condition)."""

    system: str
    code: str
    display: str = ""
    count: int = 0


@dataclass(frozen=True)
class RecordCode:
    resource: str
    system: str
    code: str
    display: str
    displays: tuple[str, ...]
    count: int
    patients: int
    unit: str | None = None
    category: str | None = None
    components: tuple[str, ...] = ()
    component_of: tuple[str, ...] = ()
    also_coded_as: tuple[AlternateCoding, ...] = ()

    def presence(self) -> dict[str, Any]:
        """What a tool result says about a code's presence on the record (systems as URLs; the catalog maps them to aliases)."""
        return {
            "display": self.display,
            "count": self.count,
            "patients": self.patients,
            "resource": self.resource,
            "category": self.category,
            "unit": self.unit,
            "also_coded_as": [{"system": a.system, "code": a.code, "display": a.display} for a in self.also_coded_as],
        }


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize(text: str) -> str:
    """Lower-case ASCII words: 'Migräne, nicht näher bezeichnet' → 'migrane nicht naher bezeichnet'."""
    folded = unicodedata.normalize("NFKD", str(text or ""))
    stripped = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return _NON_ALNUM.sub(" ", stripped.casefold()).strip()


STEM_MIN = 5


def _word_matches(word: str, hay: str) -> bool:
    """
    A word of the term occurs in the display, or one of the display's words begins with it (or it with one of them) over
    at least five letters — so an inflected form or a compound's head finds the record's: "chronischer" → "Chronische
    Nierenkrankheit", "Nierenkrankheiten" → "Nierenkrankheit", "hypertensive" → "Hypertensive disorder".
    """
    if word in hay:
        return True
    if len(word) < STEM_MIN:
        return False
    return any(len(hw) >= STEM_MIN and (hw.startswith(word) or word.startswith(hw)) for hw in hay.split())


def _code_from(raw: dict[str, Any]) -> RecordCode | None:
    try:
        displays = tuple(str(d) for d in (raw.get("displays") or []) if d)
        display = str(raw.get("display") or (displays[0] if displays else ""))
        return RecordCode(
            resource=str(raw["resource"]),
            system=str(raw.get("system") or ""),
            code=str(raw["code"]),
            display=display,
            displays=displays or ((display,) if display else ()),
            count=int(raw.get("count") or 0),
            patients=int(raw.get("patients") or 0),
            unit=str(raw["unit"]) if raw.get("unit") else None,
            category=str(raw["category"]) if raw.get("category") else None,
            components=tuple(str(c) for c in raw.get("components") or []),
            component_of=tuple(str(c) for c in raw.get("component_of") or []),
            also_coded_as=tuple(
                AlternateCoding(system=str(a.get("system") or ""), code=str(a["code"]), display=str(a.get("display") or ""), count=int(a.get("count") or 0))
                for a in raw.get("also_coded_as") or []
                if isinstance(a, dict) and a.get("code")
            ),
        )
    except (KeyError, TypeError, ValueError):
        return None


class RecordVocabulary:
    def __init__(self, doc: Any):
        codes: list[RecordCode] = []
        valid = isinstance(doc, dict) and doc.get("version") in SUPPORTED_VERSIONS and isinstance(doc.get("codes"), list)
        if valid:
            codes = [c for c in (_code_from(raw) for raw in doc["codes"] if isinstance(raw, dict)) if c is not None]
        self._doc: dict[str, Any] = doc if valid else {}
        self._codes = codes
        self._by_key = {(c.system, c.code): c for c in codes}
        self._haystacks = [(c, [normalize(d) for d in c.displays] or [""]) for c in codes]

    # ── what it is ──────────────────────────────────────────────────────────────────────────

    @property
    def empty(self) -> bool:
        return not self._codes

    @property
    def codes(self) -> list[RecordCode]:
        return list(self._codes)

    @property
    def built_at(self) -> str:
        return str(self._doc.get("built_at") or "")

    @property
    def built_date(self) -> str:
        return self.built_at[:10]

    @property
    def source(self) -> str:
        return str(self._doc.get("source") or "")

    @property
    def complete(self) -> bool:
        return bool(self._doc.get("complete", True))

    @property
    def scanned(self) -> dict[str, int]:
        return {str(k): int(v) for k, v in (self._doc.get("scanned") or {}).items()}

    @property
    def notes(self) -> list[str]:
        return [str(n) for n in (self._doc.get("notes") or [])]

    def by_resource(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for c in self._codes:
            out[c.resource] = out.get(c.resource, 0) + 1
        return out

    def systems_by_resource(self) -> dict[str, set[str]]:
        out: dict[str, set[str]] = {}
        for c in self._codes:
            out.setdefault(c.resource, set()).add(c.system)
        return out

    # ── looking things up ───────────────────────────────────────────────────────────────────

    def lookup(self, system: str, code: str) -> RecordCode | None:
        """The record's entry for an exact (system URL, code), or None."""
        return self._by_key.get((system, code))

    def find(self, term: str, limit: int = 20) -> list[RecordCode]:
        """Codes whose display contains every word of the term (spelling folded), or whose code is the term — most common first."""
        wanted = str(term or "").strip()
        if not wanted:
            return []
        exact = [c for c in self._codes if c.code.casefold() == wanted.casefold()]
        words = normalize(wanted).split()
        matches: list[tuple[tuple[int, int, int, int], RecordCode]] = []
        if words:
            needle = " ".join(words)
            for code, hays in self._haystacks:
                if code in exact:
                    continue
                best: tuple[int, int, int, int] | None = None
                for rank, hay in enumerate(hays):
                    if all(_word_matches(w, hay) for w in words):
                        # An exact display first, then the primary display over alternates, the commonest, and a panel before its components.
                        key = (0 if hay == needle else 1, rank, -code.count, 1 if code.component_of and not code.components else 0)
                        best = key if best is None or key < best else best
                if best is not None:
                    matches.append((best, code))
        matches.sort(key=lambda m: (m[0], m[1].resource, m[1].system, m[1].code))
        return (sorted(exact, key=lambda c: -c.count) + [c for _, c in matches])[:limit]

    # ── where it comes from ─────────────────────────────────────────────────────────────────

    @classmethod
    def empty_vocabulary(cls) -> "RecordVocabulary":
        return cls(None)

    @classmethod
    def from_file(cls, path: str | Path) -> "RecordVocabulary":
        try:
            return cls(json.loads(Path(path).read_text(encoding="utf-8")))
        except (OSError, ValueError) as err:
            log.warning("record vocabulary not read from %s: %s", path, err)
            return cls(None)

    @classmethod
    def from_s3(cls, bucket: str, key: str = DEFAULT_KEY, client: Any = None) -> "RecordVocabulary":
        """The deployed document; empty (with a log line) when it is not there yet or cannot be read."""
        try:
            if client is None:
                import boto3  # local import keeps unit tests free of the SDK

                client = boto3.client("s3")
            body = client.get_object(Bucket=bucket, Key=key)["Body"].read()
            return cls(json.loads(body.decode("utf-8")))
        except Exception as err:  # noqa: BLE001 — the agent runs on its hints until the seed has written the document
            log.warning("record vocabulary not read from s3://%s/%s: %s", bucket, key, err)
            return cls(None)


def vocabulary_from_env() -> RecordVocabulary:
    """`MEDAPP_VOCABULARY_FILE` (a local document — the harness, the corpus), else `RECORD_VOCABULARY_BUCKET`/`_KEY` (the deployment), else empty."""
    path = os.environ.get("MEDAPP_VOCABULARY_FILE")
    if path:
        return RecordVocabulary.from_file(path)
    bucket = os.environ.get("RECORD_VOCABULARY_BUCKET")
    if bucket:
        return RecordVocabulary.from_s3(bucket, os.environ.get("RECORD_VOCABULARY_KEY") or DEFAULT_KEY)
    return RecordVocabulary.empty_vocabulary()


class VocabularyRefresher:
    """
    Keeps a long-lived catalog's vocabulary fresh: reloads after `max_age_s` (the nightly refresh lands by morning),
    and sooner (`retry_empty_s`) while the document is still missing — a new deployment's agent may start before the
    seed has written it. Called at the start of every turn; a reload is one small GET.
    """

    def __init__(self, catalog: Any, loader: Callable[[], RecordVocabulary], max_age_s: float = 3600.0, retry_empty_s: float = 300.0, clock: Callable[[], float] = time.monotonic):
        self._catalog, self._loader, self._max_age, self._retry_empty, self._clock = catalog, loader, max_age_s, retry_empty_s, clock
        self._loaded_at = clock()

    def __call__(self) -> bool:
        age = self._clock() - self._loaded_at
        if age >= self._max_age or (self._catalog.vocabulary.empty and age >= self._retry_empty):
            self._catalog.set_vocabulary(self._loader())
            self._loaded_at = self._clock()
            return True
        return False
