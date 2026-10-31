"""
Dispatcher tests use the real example manifests (med_app/manifests) seeded into a fake registry
table, and the exported synthetic bundle as the FHIR source — the same data the frontend's mock
mode uses, so the expected numbers are the ones the frontend tests assert.
"""

import base64
import glob
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DISPATCHER_DIR = ROOT / "lambdas" / "dispatcher"
sys.path.append(str(DISPATCHER_DIR))  # `primitives` / `fhir_source` imports inside the handler

from medapp_shared import registry_model as rm  # noqa: E402

# Loaded under a distinct module name: the registry API also has a `handler.py`. Registering it in
# sys.modules before exec is required for dataclasses with `from __future__ import annotations`.
spec = importlib.util.spec_from_file_location("dispatcher_handler", DISPATCHER_DIR / "handler.py")
handler = importlib.util.module_from_spec(spec)
sys.modules["dispatcher_handler"] = handler
spec.loader.exec_module(handler)  # type: ignore[union-attr]
import primitives  # noqa: E402
from fhir_source import InMemoryFhirSource  # noqa: E402

NOW = datetime(2026, 9, 11, 12, 0, tzinfo=timezone.utc)
MANIFEST_DIR = ROOT.parent / "med_app" / "fixtures" / "manifests"  # the hand-authored reference manifests the tests exercise
BUNDLE = DISPATCHER_DIR / "data" / "synthetic-musterstadt.bundle.json"


class FakeTable:
    def __init__(self, items):
        self.items = {(i["PK"], i["SK"]): i for i in items}

    def get_item(self, **kwargs):
        item = self.items.get((kwargs["Key"]["PK"], kwargs["Key"]["SK"]))
        return {"Item": item} if item else {}


def load_manifests():
    out = {}
    for f in sorted(glob.glob(str(MANIFEST_DIR / "*.yaml"))):
        m = yaml.safe_load(Path(f).read_text(encoding="utf-8"))
        try:
            rm.data_scope_hashes(m)  # the intentionally broken example fails here
        except Exception:  # noqa: BLE001
            continue
        out[m["metadata"]["app_id"]] = m
    return out


MANIFESTS = load_manifests()


def version_items():
    items = []
    for m in MANIFESTS.values():
        items.append(rm.version_item(m, created_by_sub="seed", now="2026-09-11T00:00:00Z", state=m["lifecycle"]["state"], signoff=m["lifecycle"].get("signoff")))
    return items


@pytest.fixture(scope="module")
def source():
    return InMemoryFhirSource.from_file(BUNDLE)


@pytest.fixture
def audit():
    return []


@pytest.fixture
def dispatcher(source, audit):
    return handler.Dispatcher(FakeTable(version_items()), source, now=NOW, emit_audit=audit.append)


def event(kind, groups, body, sub="user-1"):
    return {
        "routeKey": "POST /primitives/{kind}",
        "pathParameters": {"kind": kind},
        "body": json.dumps(body),
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups}}}},
    }


def call(dispatcher, kind, groups, body, sub="user-1"):
    res = handler.handle(event(kind, groups, body, sub), dispatcher)
    return res["statusCode"], json.loads(res["body"])


def as_the_panel_sends(manifest, primitive_id, config, context):
    """The request config as the panel builds it: the declared config with `$context` resolved from the launch context (the
    manifest's defaults filled), `$ui`/`$bindings` taken from what the test provides under the same key, literals as
    declared. Tests pass the values they care about; the dispatcher now refuses a literal that differs from the manifest,
    so a test that wants to send a *different* literal says so with `raw=True`."""
    decl = next((p for p in manifest["primitives"] if p["id"] == primitive_id), None)
    if decl is None:
        return config
    ctx = dict(context or {})
    for spec in manifest.get("context_inputs") or []:
        if (ctx.get(spec["name"]) in (None, "")) and spec.get("default") is not None:
            ctx[spec["name"]] = spec["default"]

    def lookup(root, path):
        cur = root
        for m in re.finditer(r"\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]", path):
            key = m.group(1) if m.group(1) is not None else int(m.group(2))
            try:
                cur = cur[key]
            except (KeyError, IndexError, TypeError):
                return None
        return cur

    def resolve(node, sent):
        if isinstance(node, str) and (m := re.match(r"^\$(bindings|context|metadata|auth|ui)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$", node)):
            if m.group(1) in ("ui", "bindings"):
                return sent
            root = {"context": ctx, "metadata": manifest["metadata"], "auth": {}}[m.group(1)]
            return lookup(root, m.group(2))
        if isinstance(node, dict):
            sent = sent if isinstance(sent, dict) else {}
            out = {k: resolve(v, sent.get(k)) for k, v in node.items()}
            return {k: v for k, v in out.items() if v is not None}
        if isinstance(node, list) and any(isinstance(c, (str, dict, list)) and (not isinstance(c, str) or c.startswith("$")) for c in node):
            sent = sent if isinstance(sent, list) else []
            return [resolve(c, sent[i] if i < len(sent) else None) for i, c in enumerate(node)]
        return node

    return resolve(decl["config"], config or {})


def req(app_id, primitive_id, role, config, version=None, context=None, raw=False, manifest=None):
    ctx = context or {"patient_id": "pat-kms-0001"}
    manifest = manifest or MANIFESTS.get(app_id)
    shaped = manifest is not None and not raw and (not version or version == manifest["metadata"]["version"])
    return {
        "app_id": app_id,
        "manifest_version": version or MANIFESTS[app_id]["metadata"]["version"],
        "primitive_id": primitive_id,
        "role": role,
        "config": as_the_panel_sends(manifest, primitive_id, config, ctx) if shaped else config,
        "context": ctx,
    }


def declaring(manifest, primitive_id, **config):
    """A copy of the manifest whose primitive declares `config` on top of what it has — the way a behaviour of a primitive
    is now exercised: the manifest says so, the request does not."""
    import copy

    out = copy.deepcopy(manifest)
    decl = next(p for p in out["primitives"] if p["id"] == primitive_id)
    decl["config"] = {**decl["config"], **config}
    return out


def published(source, *manifests, **kwargs):
    """A dispatcher over the example set plus these manifests, published."""
    items = [*version_items(), *(rm.version_item(m, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published") for m in manifests)]
    return handler.Dispatcher(FakeTable(items), source, **kwargs)


def test_example_set_is_what_we_think():
    assert set(MANIFESTS) == {"app_patient_summary", "app_bp_trend", "app_dicom_review", "app_htn_cohort", "app_htn_assessment"}
    assert MANIFESTS["app_patient_summary"]["lifecycle"]["state"] == "published"
    assert MANIFESTS["app_bp_trend"]["lifecycle"]["state"] == "in_review"
    assert MANIFESTS["app_htn_assessment"]["lifecycle"]["state"] == "published"


def test_viewer_runs_the_published_patient_summary_and_gets_the_same_numbers_as_the_frontend(dispatcher, audit):
    status, body = call(dispatcher, "data.fhir.patient.read", "[medapp-viewers]", req("app_patient_summary", "p_patient", "clinician", {"patient": "pat-kms-0001"}))
    assert status == 200 and body["output"]["name"][0]["family"] == "Krüger"

    status, body = call(
        dispatcher,
        "data.fhir.observation.by_code",
        "[medapp-viewers]",
        req("app_patient_summary", "p_vitals", "clinician", {"patient": "pat-kms-0001", "codes": ["85354-9", "8867-4", "29463-7", "72166-2", "4548-4", "33914-3"], "since": "now-2y", "count": 40}),
    )
    assert status == 200 and len(body["output"]) == 37  # matches "37 entries" in the frontend
    assert body["output"][0]["effectiveDateTime"] >= body["output"][-1]["effectiveDateTime"]

    status, body = call(dispatcher, "data.fhir.query", "[medapp-viewers]", req("app_patient_summary", "p_conditions", "clinician", {"resource": "Condition", "params": {"patient": "pat-kms-0001", "clinical-status": "active"}}))
    assert status == 200 and sorted(c["code"]["text"] for c in body["output"]) == ["Hypertensive disorder", "Osteoarthritis of knee", "Type 2 diabetes mellitus"]

    assert [a["outcome"] for a in audit] == ["ok", "ok", "ok"]
    assert audit[0]["patient_context"] == "pat-kms-0001" and audit[0]["data_scope_hash"].startswith("sha256:")


def test_clinicians_cannot_run_unpublished_versions_but_staff_can(dispatcher, audit):
    body = req("app_bp_trend", "p_series", "viewer", {"patient": "pat-kms-0001", "codes": ["8480-6", "8462-4"], "since": "now-2y", "count": 500})
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", body)
    assert status == 403 and "not published" in out["message"]
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-approvers]", body)
    assert status == 200 and len(out["output"]) == 24
    assert [a["outcome"] for a in audit] == ["refused", "ok"]


def test_every_answer_names_the_record_it_wrote(dispatcher, audit):
    """Refusals and errors too: the browser keeps `audit_id` and the server's `outcome` on its own view of the call."""
    body = req("app_bp_trend", "p_series", "viewer", {"patient": "pat-kms-0001", "codes": ["8480-6", "8462-4"], "since": "now-2y", "count": 500})
    status, refused = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", body)
    status2, ok = call(dispatcher, "data.fhir.observation.by_code", "[medapp-approvers]", body)
    status3, missing = call(dispatcher, "data.fhir.observation.by_code", "[medapp-approvers]", req("app_nowhere", "p_series", "viewer", {}, version="1.0.0"))
    assert (status, status2, status3) == (403, 200, 404)
    assert refused["audit_id"] == audit[0]["audit_id"] and refused["outcome"] == "refused"
    assert ok["audit_id"] == audit[1]["audit_id"] and ok["outcome"] == "ok"
    assert missing["audit_id"] == audit[2]["audit_id"] and missing["outcome"] == "error"
    assert len({refused["audit_id"], ok["audit_id"], missing["audit_id"]}) == 3


def test_role_must_be_granted_and_primitive_must_be_in_the_role_data_plan(dispatcher, audit):
    body = req("app_bp_trend", "p_conditions", "reviewer", {"resource": "Condition", "params": {"patient": "pat-kms-0001"}})
    # an undeclared role is never runnable, even for an admin
    status, out = call(dispatcher, "data.fhir.query", "[medapp-admins]", {**body, "role": "nurse"})
    assert status == 403 and "do not grant the role" in out["message"]
    # as viewer, p_conditions is only_for_roles: [reviewer]
    status, out = call(dispatcher, "data.fhir.query", "[medapp-approvers]", {**body, "role": "viewer"})
    assert status == 403 and "data plan" in out["message"]
    # approvers/admins may preview the reviewer role; the audit record says how the role was obtained
    status, out = call(dispatcher, "data.fhir.query", "[medapp-approvers]", body)
    assert status == 200 and len(out["output"]) == 3 and audit[-1]["role_source"] == "staff_preview"
    # an explicit per-app reviewer group is a real grant
    status, out = call(dispatcher, "data.fhir.query", "[medapp-viewers app-app_bp_trend-reviewer]", body)
    assert status == 403  # still in_review → clinicians refused by state
    status, out = call(dispatcher, "data.fhir.query", "[medapp-admins app-app_bp_trend-reviewer]", body)
    assert status == 200 and audit[-1]["role_source"] == "group"


def test_authors_preview_only_their_own_apps(source, audit):
    m = MANIFESTS["app_bp_trend"]
    items = [
        rm.version_item(m, created_by_sub="author-1", now="2026-09-11T00:00:00Z", state="draft"),
        rm.head_item(m, owner_sub="author-1", now="2026-09-11T00:00:00Z", latest_version=m["metadata"]["version"], latest_state="draft"),
    ]
    d = handler.Dispatcher(FakeTable(items), source, now=NOW, emit_audit=audit.append)
    body = req("app_bp_trend", "p_series", "reviewer", {"patient": "pat-kms-0001", "codes": ["8480-6", "8462-4"], "since": "now-2y", "count": 500})
    status, _ = call(d, "data.fhir.observation.by_code", "[medapp-authors]", body, sub="author-1")
    assert status == 200 and audit[-1]["role_source"] == "staff_preview"
    status, out = call(d, "data.fhir.observation.by_code", "[medapp-authors]", body, sub="author-2")
    assert status == 403 and "do not grant the role" in out["message"]


def test_kind_and_id_must_match_the_manifest(dispatcher):
    status, _ = call(dispatcher, "data.fhir.query", "[medapp-viewers]", req("app_patient_summary", "p_patient", "clinician", {"resource": "Condition"}))
    assert status == 400  # p_patient is data.fhir.patient.read
    status, _ = call(dispatcher, "data.fhir.patient.read", "[medapp-viewers]", req("app_patient_summary", "p_nope", "clinician", {"patient": "x"}))
    assert status == 404
    status, _ = call(dispatcher, "data.fhir.patient.read", "[medapp-viewers]", req("app_patient_summary", "p_patient", "clinician", {"patient": "x"}, version="9.9.9"))
    assert status == 404
    status, _ = call(dispatcher, "data.llm.freeform", "[medapp-admins]", req("app_patient_summary", "p_patient", "clinician", {}))
    assert status in (400, 404)


def test_scope_is_enforced_even_if_a_manifest_declares_more_than_its_scope_allows(source, audit):
    tampered = json.loads(json.dumps(MANIFESTS["app_bp_trend"]))
    tampered["primitives"].append({"id": "p_reports", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "DiagnosticReport"}, "output_binding": "reports"})
    item = rm.version_item(tampered, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), source, now=NOW, emit_audit=audit.append)
    status, out = call(d, "data.fhir.query", "[medapp-viewers]", req("app_bp_trend", "p_reports", "viewer", {"resource": "DiagnosticReport", "params": {}}))
    assert status == 403 and out["requirement"] == "DiagnosticReport.search"
    assert audit[-1]["outcome"] == "refused" and audit[-1]["detail"] == "DiagnosticReport.search"


def test_cohort_primitives_chain_like_the_frontend(dispatcher):
    status, cohort = call(dispatcher, "data.cohort.by_condition", "[medapp-viewers]", req("app_htn_cohort", "p_cohort", "cohort_analyst", {"condition_codes": ["http://snomed.info/sct|38341003"], "clinical_status": "active"}, context={}))
    assert status == 200 and cohort["output"]["count"] == 2
    names = sorted(p["name"][0]["family"] for p in cohort["output"]["patients"])
    assert names == ["Krüger", "Yıldız"]

    status, summary = call(
        dispatcher,
        "data.cohort.latest_observation",
        "[medapp-viewers]",
        req("app_htn_cohort", "p_latest", "cohort_analyst", {"patients": cohort["output"]["patients"], "codes": ["85354-9"], "threshold": {"component_code": "8480-6", "value": 140}}, context={}),
    )
    assert status == 200
    assert summary["output"]["above_threshold_count"] == 1
    flagged = [r for r in summary["output"]["rows"] if r["above_threshold"]]
    assert flagged[0]["patient"]["name"][0]["family"] == "Yıldız" and flagged[0]["systolic"] == 152


def test_latest_observation_asks_one_newest_page_per_patient_in_parallel_and_keeps_the_cohort_order():
    """
    One search per patient (no comma lists: a hospital server ignored a long one), the newest page only
    (`_sort=-date`, `_count=LATEST_PAGE`, max_pages=1 — a `_count=1` is what makes HAPI slow), fetched in
    parallel, rows in the cohort's order.
    """
    import threading
    import time as _time

    class SlowSource:
        def __init__(self):
            self.calls: list[tuple[dict, int | None]] = []
            self.lock = threading.Lock()
            self.active = 0
            self.peak = 0

        def search(self, resource_type, params, max_pages=None):
            with self.lock:
                self.calls.append((dict(params), max_pages))
                self.active += 1
                self.peak = max(self.peak, self.active)
            _time.sleep(0.05)
            with self.lock:
                self.active -= 1
            pid = params["patient"]
            # Two readings per patient, oldest first — the primitive must pick the newest itself.
            return [
                {"resourceType": "Observation", "effectiveDateTime": "2024-01-01", "subject": {"reference": f"Patient/{pid}"}, "component": [{"code": {"coding": [{"code": "8480-6"}]}, "valueQuantity": {"value": 100}}]},
                {"resourceType": "Observation", "effectiveDateTime": "2025-06-01", "subject": {"reference": f"Patient/{pid}"}, "component": [{"code": {"coding": [{"code": "8480-6"}]}, "valueQuantity": {"value": 100 + int(pid[1:])}}]},
            ]

    source = SlowSource()
    patients = [{"resourceType": "Patient", "id": f"p{i}"} for i in range(12)]
    started = _time.monotonic()
    out = primitives.cohort_latest_observation({"patients": patients, "codes": ["http://loinc.org|85354-9"], "threshold": {"component_code": "8480-6", "value": 108}}, source, "p_latest", primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc)))
    elapsed = _time.monotonic() - started
    assert [r["patient"]["id"] for r in out["rows"]] == [f"p{i}" for i in range(12)], "the cohort's order, whatever the threads did"
    assert [r["systolic"] for r in out["rows"]] == [100 + i for i in range(12)] and all(r["date"] == "2025-06-01" for r in out["rows"]), "the newest reading per patient"
    assert out["above_threshold_count"] == 4
    # Every row carries the compared value (the threshold's component here), and the output the span of them — what a
    # range slider in the app filters by and is bounded by. The range itself is applied in the browser, never here.
    assert [r["compared"] for r in out["rows"]] == [100 + i for i in range(12)] and (out["compared_min"], out["compared_max"]) == (100, 111)
    without_threshold = primitives.cohort_latest_observation({"patients": patients[:3], "codes": ["http://loinc.org|85354-9"], "component_code": "8480-6"}, source, "p_latest", primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc)))
    assert [r["compared"] for r in without_threshold["rows"]] == [100, 101, 102] and all(r["above_threshold"] is False for r in without_threshold["rows"])
    assert len(source.calls) == 15 and all(mp == 1 for _, mp in source.calls), "one page per patient"
    assert all(p["_sort"] == "-date" and p["_count"] == str(primitives.LATEST_PAGE) and p["combo-code"] == "http://loinc.org|85354-9" for p, _ in source.calls)
    assert all("," not in p["patient"] for p, _ in source.calls), "no comma lists"
    assert source.peak > 1 and elapsed < 12 * 0.05, f"the searches ran in parallel (peak {source.peak}, {elapsed:.2f}s)"


def test_cohort_with_imaging_narrows_the_cohort_to_the_members_with_matching_studies(source):
    """
    The doctor's ask — "all patients with a certain ICD code that have had a CT" — is the condition cohort narrowed by
    imaging: one studies lookup per member (the FHIR record's ImagingStudy here, no PACS configured), kept to the
    modalities, the window and the minimum count; a row per member who stays, with the count and the latest study,
    and `patients` as the narrowed cohort so a latest-observation step can follow on exactly these members.
    """
    ctx = primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc))
    cohort = primitives.cohort_by_condition({"condition_codes": ["http://snomed.info/sct|38341003"], "clinical_status": "active"}, source, "p_cohort", ctx)
    assert sorted(p["name"][0]["family"] for p in cohort["patients"]) == ["Krüger", "Yıldız"]

    ct = primitives.cohort_with_imaging({"patients": cohort["patients"], "modalities": ["CT"]}, source, "p_imaging", ctx)
    assert ct["count"] == 2 and ct["studies_total"] == 2 and [r["patient"]["id"] for r in ct["rows"]] == [p["id"] for p in cohort["patients"]], "both have a CT, in the cohort's order"
    kruger = next(r for r in ct["rows"] if r["patient"]["name"][0]["family"] == "Krüger")
    assert kruger["study_count"] == 1 and kruger["modalities"] == ["CT"]
    assert kruger["latest_study"] == {"uid": "1.2.276.0.7230010.3.1.2.8323329.1001", "started": "2025-11-03T09:12:00+01:00", "modalities": ["CT"], "description": "CT Thorax mit Kontrastmittel", "series": 3, "instances": 412}, "named and openable, no pixels"
    assert ct["patients"] == [r["patient"] for r in ct["rows"]], "the narrowed cohort, for the next step"

    mr = primitives.cohort_with_imaging({"patients": cohort["patients"], "modalities": ["MR"]}, source, "p_imaging", ctx)
    assert mr == {"rows": [], "patients": [], "count": 0, "studies_total": 0}, "nobody with hypertension had an MR"

    recent = primitives.cohort_with_imaging({"patients": cohort["patients"], "modalities": ["CT"], "since": "now-6m"}, source, "p_imaging", ctx)
    assert [r["patient"]["name"][0]["family"] for r in recent["rows"]] == ["Yıldız"], "only the CT of April 2026 lies within six months of September 2026"

    everyone = source.search("Patient", {})
    two_plus = primitives.cohort_with_imaging({"patients": everyone, "min_studies": 2}, source, "p_imaging", ctx)
    assert sorted(r["patient"]["name"][0]["family"] for r in two_plus["rows"]) == ["Krüger", "Yıldız"] and all(r["study_count"] == 2 for r in two_plus["rows"]), "any modality, at least two studies"
    assert next(r for r in two_plus["rows"] if r["patient"]["name"][0]["family"] == "Yıldız")["modalities"] == ["CT", "US"]

    with pytest.raises(primitives.PrimitiveConfigError):
        primitives.cohort_with_imaging({"patients": cohort["patients"], "min_studies": 0}, source, "p_imaging", ctx)
    with pytest.raises(primitives.PrimitiveConfigError):
        primitives.cohort_with_imaging({"patients": ["pat-kms-0001"]}, source, "p_imaging", ctx)


def test_who_is_due_an_assessment_comes_from_the_cohort_and_their_latest_answers(source, writable):
    """
    "Who on the ward is due a falls screen" without a Task for it: the cohort against each member's latest
    QuestionnaireResponse to the questionnaire, every N days — never assessed first, then the longest overdue, then
    due, then upcoming within a window; those assessed recently enough are not on the list. Without a cohort the
    population is everyone assessed before. Mirrors mockExecutor.ts `data.cohort.assessment_due`.
    """
    url = "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"
    ctx = primitives.ExecutionContext(now=datetime(2026, 9, 17, tzinfo=timezone.utc))  # Anneliese answered ~2026-06-08 (anchor − 3 months − 2 days)
    cohort = primitives.cohort_by_condition({"condition_codes": ["http://snomed.info/sct|38341003"], "clinical_status": "active"}, source, "p_cohort", ctx)
    due = primitives.cohort_assessment_due({"questionnaire": url, "every_days": 90, "patients": cohort["patients"]}, source, "p_due", ctx)
    assert [(r["patient"]["name"][0]["family"], r["status"]) for r in due["rows"]] == [("Yıldız", "never"), ("Krüger", "overdue")]
    kruger = due["rows"][1]
    assert kruger["last_authored"].startswith("2026-06-08") and kruger["due_on"] == "2026-09-06" and kruger["overdue_days"] == 11
    assert due == {"rows": due["rows"], "count": 2, "never_count": 1, "overdue_count": 1}
    # A yearly interval: Anneliese is not due until June 2027 — off the list unless the window reaches her.
    yearly = primitives.cohort_assessment_due({"questionnaire": url, "every_days": 365, "patients": cohort["patients"]}, source, "p_due", ctx)
    assert [r["status"] for r in yearly["rows"]] == ["never"]
    soon = primitives.cohort_assessment_due({"questionnaire": url, "every_days": 110, "patients": cohort["patients"], "upcoming_days": 14}, source, "p_due", ctx)
    assert [(r["patient"]["name"][0]["family"], r["status"], r.get("due_on")) for r in soon["rows"]] == [("Yıldız", "never", None), ("Krüger", "upcoming", "2026-09-26")]  # due in nine days, inside the window
    assert primitives.cohort_assessment_due({"questionnaire": url, "every_days": 110, "patients": cohort["patients"]}, source, "p_due", ctx)["rows"][1:] == [], "without the window she is not on the list yet"
    # Without a cohort: everyone who answered before — Jonas never did, so only Anneliese is on the list.
    repeat = primitives.cohort_assessment_due({"questionnaire": url, "every_days": 90}, source, "p_due", ctx)
    assert [(r["patient"]["name"][0]["family"], r["status"]) for r in repeat["rows"]] == [("Krüger", "overdue")] and repeat["never_count"] == 0
    # A new answer today clears the row; an entered-in-error one does not count.
    writable.create({"resourceType": "QuestionnaireResponse", "questionnaire": url, "status": "completed", "subject": {"reference": "Patient/pat-kms-0001"}, "authored": "2026-09-17T08:00:00Z"})
    writable.create({"resourceType": "QuestionnaireResponse", "questionnaire": url, "status": "entered-in-error", "subject": {"reference": "Patient/pat-kms-0003"}, "authored": "2026-09-17T08:00:00Z"})
    cohort_w = primitives.cohort_by_condition({"condition_codes": ["http://snomed.info/sct|38341003"], "clinical_status": "active"}, writable, "p_cohort", ctx)
    after = primitives.cohort_assessment_due({"questionnaire": url, "every_days": 90, "patients": cohort_w["patients"]}, writable, "p_due", ctx)
    assert [(r["patient"]["name"][0]["family"], r["status"]) for r in after["rows"]] == [("Yıldız", "never")]


def test_a_form_s_numeric_answers_read_back_as_derived_observations(source):
    """
    Forms round two made answers structured; this reads them back: the patient's responses to one Questionnaire, their
    numeric answers to the named questions as Observations coded `url | linkId`, dated when answered, derivedFrom the
    response — so the trend chart draws a timed up-and-go across screens like a blood pressure. Nothing is written.
    The unit comes from the Questionnaire when the app carries it (artifacts); without it the answers stand alone.
    """
    url = "https://hsp-musterstadt.medapp.eu/Questionnaire/app-falls-risk.falls-risk"
    ctx = primitives.ExecutionContext(now=NOW)
    out = primitives.questionnaire_response_answers({"patient": "pat-kms-0001", "questionnaire": url, "link_ids": ["timed_up_and_go", "falls_count"]}, source, "p_tug", ctx)
    tugs = [o for o in out if o["code"]["coding"][0]["code"] == "timed_up_and_go"]
    assert [o["valueQuantity"]["value"] for o in tugs] == [16.5, 14, 11.5], "newest first, across three screens"
    assert tugs[0]["code"]["coding"][0]["system"] == url and tugs[0]["code"]["text"] == "Timed up-and-go (s, 0–300)"
    assert tugs[0]["subject"] == {"reference": "Patient/pat-kms-0001"} and tugs[0]["derivedFrom"] == [{"reference": "QuestionnaireResponse/qr-kms-0004"}]
    assert tugs[0]["id"] == "qr-qr-kms-0004-timed_up_and_go" and tugs[0]["effectiveDateTime"].startswith("2026-08")
    assert "unit" not in tugs[0]["valueQuantity"], "the record does not hold this Questionnaire: no unit to borrow"
    falls = [o for o in out if o["code"]["coding"][0]["code"] == "falls_count"]
    assert [o["valueQuantity"]["value"] for o in falls] == [1], "the count is asked only after a fall: one screen had one"
    # With the app's own form in hand (artifacts), the unit extension on the item reaches the derived observation.
    manifest = yaml.safe_load((ROOT.parent / "med_app" / "manifests" / "hsp-musterstadt" / "falls-risk-assessment.yaml").read_text(encoding="utf-8"))
    with_form = primitives.ExecutionContext(now=NOW, artifacts=manifest["artifacts"])
    out = primitives.questionnaire_response_answers({"patient": "pat-kms-0001", "questionnaire": url, "link_ids": ["timed_up_and_go"]}, source, "p_tug", with_form)
    assert out[0]["valueQuantity"] == {"value": 16.5, "unit": "s"}
    # Another patient has no screens; a question with no numeric answers yields nothing.
    assert primitives.questionnaire_response_answers({"patient": "pat-kms-0002", "questionnaire": url, "link_ids": ["timed_up_and_go"]}, source, "p_tug", ctx) == []
    assert primitives.questionnaire_response_answers({"patient": "pat-kms-0001", "questionnaire": url, "link_ids": ["walking_aid"]}, source, "p_tug", ctx) == []


def test_cohort_with_imaging_needs_the_imaging_grants_and_a_cohort_scope():
    """The manifest grants ImagingStudy search and DICOM qido together, so the same app runs on either kind of deployment."""
    both = {"patient_scope": "cohort", "fhir": [{"resource": "ImagingStudy", "operations": ["search"]}], "dicom": [{"operations": ["qido"]}]}
    primitives.assert_scope_allows("data.cohort.with_imaging", "p_imaging", {}, both)
    for broken, requirement in [
        ({**both, "fhir": []}, "ImagingStudy.search"),
        ({**both, "dicom": []}, "dicom.qido"),
        ({**both, "patient_scope": "individual"}, "patient_scope: cohort"),
    ]:
        with pytest.raises(primitives.ScopeViolation) as e:
            primitives.assert_scope_allows("data.cohort.with_imaging", "p_imaging", {}, broken)
        assert e.value.requirement == requirement


def test_dicom_studies_for_staff_on_the_draft_app(dispatcher):
    body = req("app_dicom_review", "p_studies", "radiologist", {"patient": "pat-kms-0003", "modalities": ["CT", "MR", "DX", "US"]}, context={"patient_id": "pat-kms-0003"})
    status, _ = call(dispatcher, "data.dicom.studies.for_patient", "[medapp-viewers]", body)
    assert status == 403  # draft
    status, out = call(dispatcher, "data.dicom.studies.for_patient", "[medapp-admins]", body)
    assert status == 200 and [s["description"] for s in out["output"]] == ["CT Abdomen nativ", "Sonographie Nieren beidseits"]


def test_request_hygiene(dispatcher):
    assert handler.handle({"routeKey": "POST /primitives/{kind}", "requestContext": {}}, dispatcher)["statusCode"] == 401
    bad = event("data.fhir.patient.read", "[medapp-viewers]", {})
    bad["body"] = "{not json"
    assert handler.handle(bad, dispatcher)["statusCode"] == 400
    status, out = call(dispatcher, "data.fhir.patient.read", "[medapp-viewers]", {"app_id": "app_patient_summary"})
    assert status == 400 and "required" in out["message"]


def test_patient_lookup_for_the_launch_context_is_audited_and_minimal(dispatcher, audit):
    """GET /patients?name=…: the picker's search through the same data source — a few fields per hit, one audit record."""

    def lookup(name, groups="[medapp-viewers]", sub="user-1"):
        ev = {"routeKey": "GET /patients", "queryStringParameters": {"name": name}, "requestContext": {"authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": groups}}}}}
        res = handler.handle(ev, dispatcher)
        return res["statusCode"], json.loads(res["body"])

    status, out = lookup("krüg")
    assert status == 200 and [p["name"] for p in out["patients"]] == ["Anneliese Krüger"]
    hit = out["patients"][0]
    assert hit == {"id": "pat-kms-0001", "name": "Anneliese Krüger", "birthDate": hit["birthDate"], "gender": "female", "identifiers": hit["identifiers"]}
    assert any(i["value"] == "KMS-0048213" for i in hit["identifiers"]) and "address" not in hit and "telecom" not in hit, "what a picker shows, nothing more"
    assert audit[-1]["kind"] == "platform.patient.search" and audit[-1]["query"] == "krüg" and audit[-1]["outcome"] == "ok" and audit[-1]["result_summary"] == "1 patients" and audit[-1]["user_sub"] == "user-1"
    status, out = lookup("a")
    assert status == 400 and "two characters" in out["message"] and audit[-1]["outcome"] == "refused"
    # No name at all: the first page of the record by family name, so the picker has something before anyone types — audited with an empty query.
    status, out = lookup("")
    assert status == 200 and [p["name"] for p in out["patients"]] == ["Jonas Bergmann", "Anneliese Krüger", "Fatma Yıldız"], "by family name"
    assert audit[-1]["kind"] == "platform.patient.search" and audit[-1]["query"] == "" and audit[-1]["result_summary"] == "3 patients"
    status, out = lookup("nobody-by-this-name")
    assert status == 200 and out["patients"] == []
    assert handler.handle({"routeKey": "GET /patients", "queryStringParameters": {"name": "krüg"}, "requestContext": {}}, dispatcher)["statusCode"] == 401


def test_observation_searches_find_panels_by_component_code(dispatcher, source):
    """The catalog promises observation.by_code matches component codes; on a real server only combo-code does."""
    seen = {}

    class Spy:
        def read(self, t, i):
            return source.read(t, i)

        def search(self, t, params):
            seen.setdefault(t, []).append(dict(params))
            return source.search(t, params)

        def create(self, r, if_none_exist=None):
            return source.create(r, if_none_exist)

    spy_dispatcher = handler.Dispatcher(FakeTable(version_items()), Spy(), now=NOW, emit_audit=lambda r: None)
    # The reference manifest asks for the component codes; the panel observations must still come back.
    status, out = call(spy_dispatcher, "data.fhir.observation.by_code", "[medapp-approvers]", req("app_bp_trend", "p_series", "viewer", {"patient": "pat-kms-0001", "codes": ["http://loinc.org|8480-6", "http://loinc.org|8462-4"], "since": "now-2y", "count": 500}))
    assert status == 200 and len(out["output"]) == 24 and all(o["code"]["coding"][0]["code"] == "85354-9" for o in out["output"])
    assert seen["Observation"][0]["combo-code"] == "http://loinc.org|8480-6,http://loinc.org|8462-4" and "code" not in seen["Observation"][0]
    # And asking for the panel itself, as the drafting agent does, gives the same readings.
    status, out = call(spy_dispatcher, "data.fhir.observation.by_code", "[medapp-approvers]", req("app_bp_trend", "p_series", "viewer", {"patient": "pat-kms-0001", "codes": ["http://loinc.org|85354-9"], "since": "now-2y", "count": 500}))
    assert status == 200 and len(out["output"]) == 24
    # The in-memory source treats a plain `code` param the same way (data.fhir.query keeps the author's parameter).
    assert len(source.search("Observation", {"patient": "pat-kms-0001", "code": "8480-6"})) == len(source.search("Observation", {"patient": "pat-kms-0001", "combo-code": "8480-6"}))


def test_an_atc_class_or_an_icd_category_matches_every_code_under_it(dispatcher, source):
    """The disease templates name the therapy as ATC classes (C09A ACE inhibitors) and the condition as an ICD-10-GM
    category (I10) beside its SNOMED code. A real server matches tokens exactly, so fhir_query keeps such codes out
    of the request and filters here; the in-memory source and the frontend's mock match the same way."""
    from fhir_source import concept_matches, is_class_code  # noqa: PLC0415

    atc, icd = "http://www.whocc.no/atc", "http://fhir.de/CodeSystem/bfarm/icd-10-gm"
    assert is_class_code(atc, "C09A") and is_class_code(atc, "C03") and not is_class_code(atc, "C09AA05")
    assert is_class_code(icd, "I10") and not is_class_code(icd, "I10.90") and not is_class_code("http://loinc.org", "854")
    ramipril = {"coding": [{"system": atc, "code": "C09AA05"}]}
    assert concept_matches(ramipril, [f"{atc}|C09A"]) and concept_matches(ramipril, [f"{atc}|C09AA05"]) and not concept_matches(ramipril, [f"{atc}|C08CA"])
    assert not concept_matches(ramipril, ["C09A"]), "a bare class without its system is not a hierarchy — only an exact code matches"
    hypertension = {"coding": [{"system": icd, "code": "I10.90"}]}
    assert concept_matches(hypertension, [f"{icd}|I10"]) and not concept_matches(hypertension, [f"{icd}|I1"]) and not concept_matches(hypertension, [f"{icd}|I100"])
    assert not concept_matches({"coding": [{"system": icd, "code": "I100"}]}, [f"{icd}|I10"]), "a category covers I10.x, not a code that merely starts with the letters"

    seen = {}

    class Spy:
        def read(self, t, i):
            return source.read(t, i)

        def search(self, t, params, max_pages=None):
            seen.setdefault(t, []).append(dict(params))
            return source.search(t, params)

        def create(self, r, if_none_exist=None):
            return source.create(r, if_none_exist)

    # Anneliese takes ramipril (C09AA05) and amlodipine (C08CA01): an app whose medication list is declared by ATC class finds
    # both, and the server never saw a class token. The class is the manifest's, as every filter now is.
    summary = MANIFESTS["app_patient_summary"]
    by_class = declaring(summary, "p_medications", params={"patient": "$context.patient_id", "status": "active", "code": f"{atc}|C09A,{atc}|C08CA"}, count=100)
    by_class["metadata"]["version"] = "0.1.1"
    exact = declaring(summary, "p_medications", params={"patient": "$context.patient_id", "status": "active", "code": f"{atc}|C09AA05"}, count=100)
    exact["metadata"]["version"] = "0.1.2"
    d = published(Spy(), by_class, exact, now=NOW, emit_audit=lambda r: None)
    status, out = call(d, "data.fhir.query", "[medapp-viewers]", req("app_patient_summary", "p_medications", "clinician", {}, version="0.1.1", manifest=by_class))
    assert status == 200, out
    assert sorted(m["medicationCodeableConcept"]["coding"][0]["code"] for m in out["output"]) == ["C08CA01", "C09AA05"]
    assert "code" not in seen["MedicationRequest"][-1] and seen["MedicationRequest"][-1]["patient"] == "pat-kms-0001" and seen["MedicationRequest"][-1]["status"] == "active"
    # Exact codes still go to the server as they are.
    status, out = call(d, "data.fhir.query", "[medapp-viewers]", req("app_patient_summary", "p_medications", "clinician", {}, version="0.1.2", manifest=exact))
    assert status == 200 and [m["medicationCodeableConcept"]["coding"][0]["code"] for m in out["output"]] == ["C09AA05"]
    assert seen["MedicationRequest"][-1]["code"] == f"{atc}|C09AA05"


def test_the_rest_of_the_record_is_searchable_the_way_the_frontend_searches_it(source):
    """AllergyIntolerance, Procedure, Immunization, DocumentReference joined the query allow-list; the in-memory
    source finds them by `patient` (whatever the field is called) and honours category, type and date."""
    from primitives import QUERY_RESOURCES

    assert {"AllergyIntolerance", "Procedure", "Immunization", "DocumentReference", "Encounter", "DiagnosticReport"} <= set(QUERY_RESOURCES)
    anneliese = {"patient": "pat-kms-0001"}
    assert [a["id"] for a in source.search("AllergyIntolerance", anneliese)] == ["alg-kms-0002", "alg-kms-0001"]  # newest recorded first
    assert len(source.search("AllergyIntolerance", {**anneliese, "clinical-status": "active"})) == 2
    assert source.search("AllergyIntolerance", {"patient": "pat-kms-0002"}) == []  # nothing recorded — not "no known allergies"
    assert len(source.search("Encounter", anneliese)) == 4
    assert len(source.search("Encounter", {**anneliese, "date": "ge2026-01-01"})) == 3
    assert [r["id"] for r in source.search("DiagnosticReport", {**anneliese, "category": "RAD"})] == ["rep-kms-0001"]
    assert len(source.search("DiagnosticReport", {**anneliese, "category": "http://terminology.hl7.org/CodeSystem/v2-0074|LAB"})) == 1
    assert [d["id"] for d in source.search("DocumentReference", {**anneliese, "type": "18842-5"})] == ["doc-kms-0001"]
    assert len(source.search("Procedure", anneliese)) == 2 and len(source.search("Immunization", {"patient": "pat-kms-0003"})) == 2
    assert len(source.search("Observation", {**anneliese, "category": "laboratory"})) == 4


def test_relative_dates():
    now = datetime(2026, 9, 11, 0, 0, tzinfo=timezone.utc)
    assert primitives.resolve_date_expression("now-2y", now) == "2024-09-11T00:00:00Z"
    assert primitives.resolve_date_expression("now-90d", now) == "2026-06-13T00:00:00Z"
    assert primitives.resolve_date_expression("now-6m", now) == "2026-03-11T00:00:00Z"
    assert primitives.resolve_date_expression("2025-01-01", now) == "2025-01-01"
    assert primitives.resolve_date_expression(None, now) is None


# ── write path: structured assessment ────────────────────────────────────────────────────

HTN_Q = "https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup"
NURSE = "[app-app_htn_assessment-nurse]"


def complete_response(**overrides):
    r = {
        "resourceType": "QuestionnaireResponse",
        "identifier": {"system": "urn:medapp:submission", "value": "sub-0001"},
        "questionnaire": HTN_Q,
        "status": "completed",
        "subject": {"reference": "Patient/pat-kms-0001"},
        "item": [
            {"linkId": "home_bp", "answer": [{"valueCoding": {"code": "daily", "display": "Daily"}}]},
            {"linkId": "adherence", "answer": [{"valueCoding": {"code": "full", "display": "All doses taken"}}]},
            {"linkId": "symptoms", "answer": [{"valueCoding": {"code": "dizziness"}}, {"valueCoding": {"code": "headache"}}]},
            {"linkId": "side_effects", "answer": [{"valueCoding": {"code": "no", "display": "No"}}]},
            {"linkId": "notes", "answer": [{"valueString": "Dose review next visit."}]},
        ],
    }
    r.update(overrides)
    return r


def submit_req(response, role="nurse"):
    return req("app_htn_assessment", "p_submit", role, {"questionnaire": HTN_Q, "subject": "pat-kms-0001", "response": response})


def list_req():
    return req("app_htn_assessment", "p_submissions", "nurse", {"resource": "QuestionnaireResponse", "params": {"patient": "pat-kms-0001", "questionnaire": HTN_Q}})


@pytest.fixture
def writable():
    """A fresh source per test: writes are stateful, and ids are predictable."""
    counter = {"n": 0}

    def next_id(resource_type):
        counter["n"] += 1
        return f"{resource_type.lower()}-created-{counter['n']:04d}"

    with open(BUNDLE, encoding="utf-8") as f:
        return InMemoryFhirSource.from_bundle(json.load(f), id_factory=next_id)


@pytest.fixture
def writer(writable, audit):
    return handler.Dispatcher(FakeTable(version_items()), writable, now=NOW, emit_audit=audit.append)


def test_questionnaire_read_by_canonical_url_and_by_id(writer, writable):
    status, out = call(writer, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_questionnaire", "nurse", {}))
    assert status == 200 and out["output"]["id"] == "q-htn-followup" and [i["linkId"] for i in out["output"]["item"]][:2] == ["home_bp", "adherence"]
    # A manifest may name the form by its id instead of its canonical URL; one that names a form the record lacks reads nothing.
    by_id = declaring(MANIFESTS["app_htn_assessment"], "p_questionnaire", questionnaire="q-htn-followup")
    by_id["metadata"]["version"] = "0.1.1"
    elsewhere = declaring(MANIFESTS["app_htn_assessment"], "p_questionnaire", questionnaire="https://elsewhere/Questionnaire/none")
    elsewhere["metadata"]["version"] = "0.1.2"
    d = published(writable, by_id, elsewhere, now=NOW, emit_audit=lambda r: None)
    status, out = call(d, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_questionnaire", "nurse", {}, version="0.1.1", manifest=by_id))
    assert status == 200 and out["output"]["url"] == HTN_Q
    status, out = call(d, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_questionnaire", "nurse", {}, version="0.1.2", manifest=elsewhere))
    assert status == 404
    # The request cannot point the primitive at another form: the manifest's wins, and the attempt is refused and recorded.
    status, out = call(writer, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_questionnaire", "nurse", {"questionnaire": "https://elsewhere/Questionnaire/none"}, raw=True))
    assert status == 400 and "differs from what app_htn_assessment@" in out["message"] and "questionnaire" in out["message"]


FALLS_Q = "https://hsp-musterstadt.medapp.eu/Questionnaire/app-htn-assessment.falls-risk"
FALLS_FORM = {
    "resourceType": "Questionnaire",
    "id": "app-htn-assessment.falls-risk",
    "url": FALLS_Q,
    "version": "0.2.0",
    "title": "Falls risk",
    "status": "active",
    "subjectType": ["Patient"],
    "item": [
        {"linkId": "fell", "text": "Fallen in the last 12 months?", "type": "boolean", "required": True},
        {"linkId": "falls", "text": "How many times?", "type": "integer"},
        {"linkId": "aids", "text": "Walking aid", "type": "choice", "answerOption": [{"valueCoding": {"code": "none", "display": "None"}}, {"valueCoding": {"code": "stick", "display": "Stick"}}]},
    ],
}


def test_a_form_the_app_carries_is_read_from_the_manifest_and_responses_are_validated_against_it(writable, audit):
    """
    An app-authored form travels in the manifest (`artifacts.questionnaires`), reviewed and signed with the app; the
    dispatcher reads it from there — the record need not hold it — and validates submissions against it. The record's
    own questionnaires resolve as before.
    """
    manifest = json.loads(json.dumps(MANIFESTS["app_htn_assessment"]))
    manifest["metadata"]["version"] = "0.2.0"
    manifest["artifacts"] = {"questionnaires": [FALLS_FORM]}
    for p in manifest["primitives"]:
        if p["kind"] in ("data.fhir.questionnaire.read", "write.fhir.questionnaire_response.submit"):
            p["config"]["questionnaire"] = FALLS_Q
    # … next to a primitive that still reads one of the record's own forms.
    manifest["primitives"].append({"id": "p_record_form", "kind": "data.fhir.questionnaire.read", "catalog_version": "1.0.0", "config": {"questionnaire": HTN_Q}, "output_binding": "record_form"})
    item = rm.version_item(manifest, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), writable, now=NOW, emit_audit=audit.append)

    status, out = call(d, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_questionnaire", "nurse", {}, version="0.2.0", manifest=manifest))
    assert status == 200 and out["output"]["id"] == "app-htn-assessment.falls-risk" and [i["linkId"] for i in out["output"]["item"]] == ["fell", "falls", "aids"]
    assert not writable.search("Questionnaire", {"url": FALLS_Q}), "the record never held it"
    status, out = call(d, "data.fhir.questionnaire.read", NURSE, req("app_htn_assessment", "p_record_form", "nurse", {}, version="0.2.0", manifest=manifest))
    assert status == 200 and out["output"]["id"] == "q-htn-followup", "the record's forms still resolve"

    response = {"resourceType": "QuestionnaireResponse", "identifier": {"system": "urn:medapp:submission", "value": "sub-falls-1"}, "questionnaire": FALLS_Q, "status": "completed", "subject": {"reference": "Patient/pat-kms-0001"}, "item": [{"linkId": "fell", "answer": [{"valueBoolean": True}]}, {"linkId": "falls", "answer": [{"valueInteger": 2}]}, {"linkId": "aids", "answer": [{"valueCoding": {"code": "stick", "display": "Stick"}}]}]}
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", {"response": response}, version="0.2.0", manifest=manifest))
    assert status == 200, out
    assert out["output"]["questionnaire"] == FALLS_Q and out["output"]["status"] == "completed"
    wrong = json.loads(json.dumps(response))
    wrong["identifier"]["value"] = "sub-falls-2"
    wrong["item"][2]["answer"] = [{"valueCoding": {"code": "wheelchair"}}]
    del wrong["item"][0]
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", {"response": wrong}, version="0.2.0", manifest=manifest))
    assert status == 422 and any("Fallen in the last 12 months?" in p for p in out["problems"]) and any("wheelchair" in p for p in out["problems"]), out  # problems name the question as asked


def test_an_answer_flagged_as_a_measurement_is_also_written_as_an_observation(writable, audit):
    """
    The manifest's `extract` names the answers that are measurements in their own right: on a fresh submission the
    dispatcher writes one Observation per flagged numeric answer — the lab's code, the item's unit, category survey,
    derived from the response, its own Provenance, idempotent on the submission — and refuses the whole write when the
    role may write responses but not Observations. An unanswered flagged item yields nothing.
    """
    tug = "https://hsp-musterstadt.medapp.eu/CodeSystem/physio|tug"
    manifest = json.loads(json.dumps(MANIFESTS["app_htn_assessment"]))
    manifest["metadata"]["version"] = "0.3.0"
    form = json.loads(json.dumps(FALLS_FORM))
    form["item"][1] = {"linkId": "falls", "text": "Timed up-and-go (s)", "type": "decimal", "code": [{"system": "https://hsp-musterstadt.medapp.eu/CodeSystem/physio", "code": "tug", "display": "Timed up-and-go"}]}
    manifest["artifacts"] = {"questionnaires": [form]}
    for p in manifest["primitives"]:
        if p["kind"] in ("data.fhir.questionnaire.read", "write.fhir.questionnaire_response.submit"):
            p["config"]["questionnaire"] = FALLS_Q
        if p["kind"] == "write.fhir.questionnaire_response.submit":
            p["config"]["extract"] = [{"link_id": "falls", "code": tug, "display": "Timed up-and-go", "unit": "s"}]
    item = rm.version_item(manifest, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), writable, now=NOW, emit_audit=audit.append)
    response = {"resourceType": "QuestionnaireResponse", "identifier": {"system": "urn:medapp:submission", "value": "sub-tug-1"}, "questionnaire": FALLS_Q, "status": "completed", "subject": {"reference": "Patient/pat-kms-0001"}, "item": [{"linkId": "fell", "answer": [{"valueBoolean": True}]}, {"linkId": "falls", "answer": [{"valueDecimal": 14.5}]}, {"linkId": "aids", "answer": [{"valueCoding": {"code": "stick", "display": "Stick"}}]}]}
    cfg = {"questionnaire": FALLS_Q, "subject": "pat-kms-0001", "extract": [{"link_id": "falls", "code": tug, "display": "Timed up-and-go", "unit": "s"}], "response": response}

    # The nurse's scope grants QuestionnaireResponse.create, not Observation.create: with an extraction the write is refused by type.
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", cfg, version="0.3.0"))
    assert status == 403 and "Observation.create" in json.dumps(out), out
    manifest["data_scopes"]["scope_nurse"]["fhir"].append({"resource": "Observation", "operations": ["create"], "codes": [tug], "filter": "subject={context.patient_id}"})
    item = rm.version_item(manifest, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", cfg, version="0.3.0"))
    assert status == 200, out
    qr = out["output"]
    observations = writable.search("Observation", {"patient": "pat-kms-0001", "code": tug})
    assert len(observations) == 1
    obs = observations[0]
    assert obs["code"]["coding"] == [{"system": "https://hsp-musterstadt.medapp.eu/CodeSystem/physio", "code": "tug", "display": "Timed up-and-go"}] and obs["code"]["text"] == "Timed up-and-go"
    assert obs["valueQuantity"] == {"value": 14.5, "unit": "s"} and obs["category"][0]["coding"][0]["code"] == "survey" and obs["status"] == "final"
    assert obs["derivedFrom"] == [{"reference": f"QuestionnaireResponse/{qr['id']}"}] and obs["effectiveDateTime"] == qr["authored"] and obs["subject"] == {"reference": "Patient/pat-kms-0001"}
    assert obs["identifier"] == [{"system": "urn:medapp:submission", "value": "sub-tug-1-falls"}]
    assert obs["performer"] == [qr["author"]], "the person who submitted the form is the measurement's performer"
    provenances = writable.search("Provenance", {})
    assert {p["target"][0]["reference"] for p in provenances} >= {f"QuestionnaireResponse/{qr['id']}", f"Observation/{obs['id']}"}, "the response and the measurement each leave a Provenance"
    # A retried submission is the earlier record — and no second Observation.
    status, again = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", cfg, version="0.3.0"))
    assert status == 200 and again["output"]["id"] == qr["id"] and len(writable.search("Observation", {"patient": "pat-kms-0001", "code": tug})) == 1
    # A screen without the TUG answered writes the response alone.
    without = json.loads(json.dumps(response))
    without["identifier"]["value"] = "sub-tug-2"
    without["item"] = [i for i in without["item"] if i["linkId"] != "falls"]
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, req("app_htn_assessment", "p_submit", "nurse", {**cfg, "response": without}, version="0.3.0"))
    assert status == 200 and len(writable.search("Observation", {"patient": "pat-kms-0001", "code": tug})) == 1


def test_submit_stamps_provenance_from_the_token_and_the_list_shows_it(writer, audit):
    claims_from_client = complete_response(
        authored="1999-01-01T00:00:00Z",
        author={"reference": "Practitioner/somebody-else"},
        source={"reference": "Practitioner/123"},
        meta={"security": [{"code": "R"}], "versionId": "7"},
        id="client-chosen-id",
        text={"status": "generated", "div": "<div>injected</div>"},
    )
    ev = event("write.fhir.questionnaire_response.submit", NURSE, submit_req(claims_from_client), sub="nurse-sub-42")
    ev["requestContext"]["authorizer"]["jwt"]["claims"]["email"] = "nurse@klinikum-musterstadt.example"
    res = handler.handle(ev, writer)
    status, out = res["statusCode"], json.loads(res["body"])
    assert status == 200
    stored = out["output"]
    assert stored["id"] == "questionnaireresponse-created-0001"
    assert stored["status"] == "completed" and stored["subject"] == {"reference": "Patient/pat-kms-0001"}
    assert stored["questionnaire"] == HTN_Q
    assert stored["authored"] == "2026-09-11T12:00:00Z"  # server clock, not the client's 1999
    assert stored["author"] == {"identifier": {"system": "urn:medapp:cognito-sub", "value": "nurse-sub-42"}, "display": "nurse@klinikum-musterstadt.example"}
    assert "source" not in stored and "text" not in stored
    assert stored["meta"]["source"] == "urn:medapp:app_htn_assessment@0.1.0" and stored["meta"]["versionId"] == "1" and "security" not in stored["meta"]
    assert stored["item"] == claims_from_client["item"]

    a = audit[-1]
    assert a["outcome"] == "ok" and a["kind"] == "write.fhir.questionnaire_response.submit"
    assert a["resource_ref"] == "QuestionnaireResponse/questionnaireresponse-created-0001" and a["detail"] == a["resource_ref"]
    assert a["payload_hash"] == handler._payload_hash({"response": claims_from_client}) and len(a["payload_hash"]) == 64

    status, out = call(writer, "data.fhir.query", NURSE, list_req())
    assert status == 200 and [r["id"] for r in out["output"]] == ["questionnaireresponse-created-0001", "qr-kms-0001"]  # newest first


def test_submit_is_idempotent_on_the_submission_identifier(writer, writable):
    status, first = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(complete_response()))
    status2, retry = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(complete_response()))
    assert status == status2 == 200 and retry["output"]["id"] == first["output"]["id"]
    status, other = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(complete_response(identifier={"system": "urn:medapp:submission", "value": "sub-0002"})))
    # ids are handed out per created resource: the first submission's Provenance took 0002.
    assert status == 200 and other["output"]["id"] == "questionnaireresponse-created-0003"
    assert len(writable.search("Provenance", {})) == 2  # one per real submission, none for the replay
    _, listed = call(writer, "data.fhir.query", NURSE, list_req())
    assert len(listed["output"]) == 3


def test_invalid_submission_is_refused_with_problems_and_nothing_is_stored(writer, audit):
    incomplete = complete_response(item=[{"linkId": "notes", "answer": [{"valueString": "only notes"}]}, {"linkId": "mood", "answer": [{"valueString": "x"}]}])
    status, out = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(incomplete))
    assert status == 422
    assert out["problems"] == ['unknown item "mood"', '"How often does the patient measure blood pressure at home?" is required', '"Medication adherence over the last four weeks" is required', '"Side effects of current medication reported" is required']
    assert audit[-1]["outcome"] == "refused" and audit[-1]["detail"].startswith("invalid payload: ") and "payload_hash" in audit[-1]

    wrong_patient = complete_response(subject={"reference": "Patient/pat-kms-0002"})
    status, out = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(wrong_patient))
    assert status == 422 and out["problems"] == ["response subject Patient/pat-kms-0002 is not the patient in context"]

    bad_option = complete_response(item=[*complete_response()["item"][1:], {"linkId": "home_bp", "answer": [{"valueCoding": {"code": "hourly"}}]}])
    status, out = call(writer, "write.fhir.questionnaire_response.submit", NURSE, submit_req(bad_option))
    assert status == 422 and out["problems"] == ['"How often does the patient measure blood pressure at home?": hourly is not one of the offered options']

    _, listed = call(writer, "data.fhir.query", NURSE, list_req())
    assert [r["id"] for r in listed["output"]] == ["qr-kms-0001"]


def test_writes_need_the_create_operation_in_scope_and_a_granted_role(writable, audit):
    tampered = json.loads(json.dumps(MANIFESTS["app_htn_assessment"]))
    for entry in tampered["data_scopes"]["scope_nurse"]["fhir"]:
        if entry["resource"] == "QuestionnaireResponse":
            entry["operations"] = ["search"]
    item = rm.version_item(tampered, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d, "write.fhir.questionnaire_response.submit", NURSE, submit_req(complete_response()))
    assert status == 403 and out["requirement"] == "QuestionnaireResponse.create" and audit[-1]["outcome"] == "refused"

    d2 = handler.Dispatcher(FakeTable(version_items()), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d2, "write.fhir.questionnaire_response.submit", "[app-app_bp_trend-viewer]", submit_req(complete_response()))
    assert status == 403 and "do not grant the role" in out["message"]
    # blanket viewers resolve to the default role (nurse) and may write — the manifest's default role decides that
    status, _ = call(d2, "write.fhir.questionnaire_response.submit", "[medapp-viewers]", submit_req(complete_response()))
    assert status == 200 and audit[-1]["role_source"] == "blanket"


def test_validator_matches_the_frontend_rules():
    from questionnaire import validate_questionnaire_response  # noqa: PLC0415

    with open(BUNDLE, encoding="utf-8") as f:
        q = next(e["resource"] for e in json.load(f)["entry"] if e["resource"]["resourceType"] == "Questionnaire")
    assert validate_questionnaire_response(q, complete_response()) == []
    bad = complete_response(
        item=[
            {"linkId": "home_bp", "answer": [{"valueCoding": {"code": "hourly"}}]},
            {"linkId": "adherence", "answer": [{"valueString": "ok"}, {"valueString": "fine"}]},
            {"linkId": "mood", "answer": [{"valueString": "x"}]},
            {"linkId": "notes", "answer": [{"valueInteger": 3}]},
        ]
    )
    problems = validate_questionnaire_response(q, bad)
    # identical strings to med_app/src/tests/writePath.test.ts
    assert set(problems) == {
        '"How often does the patient measure blood pressure at home?": hourly is not one of the offered options',
        '"Medication adherence over the last four weeks" allows one answer, got 2',
        '"Side effects of current medication reported" is required',
        'unknown item "mood"',
        '"Notes for the next visit" expects valueString not valueInteger',
    }
    assert validate_questionnaire_response(q, complete_response(questionnaire="https://elsewhere/Questionnaire/other"))[0].startswith("response answers https://elsewhere")
    assert validate_questionnaire_response(q, {"resourceType": "Observation"}) == ["response is not a QuestionnaireResponse"]


def test_validator_round_two_matches_the_frontend_rules():
    """Conditions, ranges and coded options — identical strings to med_app/src/tests/writePath.test.ts."""
    from questionnaire import condition_met, item_enabled, validate_questionnaire_response  # noqa: PLC0415

    falls = yaml.safe_load((ROOT.parent / "med_app" / "manifests" / "hsp-musterstadt" / "falls-risk-assessment.yaml").read_text(encoding="utf-8"))
    q = falls["artifacts"]["questionnaires"][0]

    def response(items):
        return {"resourceType": "QuestionnaireResponse", "questionnaire": q["url"], "status": "completed", "item": items}

    base = [{"linkId": "mobility", "item": [{"linkId": "walking_aid", "answer": [{"valueCoding": {"code": "stick"}}]}, {"linkId": "timed_up_and_go", "answer": [{"valueDecimal": 12.5}]}]}]
    no_fall = response([{"linkId": "history", "item": [{"linkId": "fell_last_year", "answer": [{"valueCoding": {"code": "no"}}]}]}, *base])
    assert validate_questionnaire_response(q, no_fall) == []
    sneaked = response([{"linkId": "history", "item": [{"linkId": "fell_last_year", "answer": [{"valueCoding": {"code": "no"}}]}]}, {"linkId": "fall_details", "item": [{"linkId": "falls_count", "answer": [{"valueInteger": 2}]}]}, *base])
    assert validate_questionnaire_response(q, sneaked) == ['"How many falls? (0–20)" is not asked (its condition is not met) and cannot carry answers']
    fell = response([{"linkId": "history", "item": [{"linkId": "fell_last_year", "answer": [{"valueCoding": {"code": "yes"}}]}]}, {"linkId": "fall_details", "item": [{"linkId": "falls_count", "answer": [{"valueInteger": 25}]}]}, {"linkId": "mobility", "item": [{"linkId": "walking_aid", "answer": [{"valueCoding": {"code": "stick"}}]}, {"linkId": "timed_up_and_go", "answer": [{"valueDecimal": -1}]}]}])
    assert validate_questionnaire_response(q, fell) == ['"How many falls? (0–20)": 25 is above the maximum 20', '"Timed up-and-go (s, 0–300)": -1 is below the minimum 0']
    fine = response([{"linkId": "history", "item": [{"linkId": "fell_last_year", "answer": [{"valueCoding": {"code": "yes"}}]}]}, {"linkId": "fall_details", "item": [{"linkId": "falls_count", "answer": [{"valueInteger": 3}]}, {"linkId": "injury", "answer": [{"valueCoding": {"code": "minor"}}]}]}, *base])
    assert validate_questionnaire_response(q, fine) == []

    coded = {
        "resourceType": "Questionnaire",
        "status": "active",
        "item": [
            {"linkId": "smokes", "type": "choice", "answerOption": [{"valueCoding": {"system": "http://snomed.info/sct", "code": "77176002", "display": "Smoker"}}, {"valueCoding": {"system": "http://snomed.info/sct", "code": "266919005", "display": "Never"}}]},
            {"linkId": "per_day", "type": "integer", "required": True, "enableWhen": [{"question": "smokes", "operator": "=", "answerCoding": {"system": "http://snomed.info/sct", "code": "77176002"}}]},
            {"linkId": "heavy", "type": "group", "enableWhen": [{"question": "per_day", "operator": ">=", "answerInteger": 20}], "item": [{"linkId": "quit_plan", "type": "text", "required": True}]},
            {"linkId": "both", "type": "boolean", "enableWhen": [{"question": "smokes", "operator": "exists", "answerBoolean": True}, {"question": "per_day", "operator": "<", "answerInteger": 5}], "enableBehavior": "all"},
        ],
    }

    def smoker(per_day, extra=()):
        return {"resourceType": "QuestionnaireResponse", "status": "completed", "item": [{"linkId": "smokes", "answer": [{"valueCoding": {"system": "http://snomed.info/sct", "code": "77176002"}}]}, {"linkId": "per_day", "answer": [{"valueInteger": per_day}]}, *extra]}

    assert validate_questionnaire_response(coded, smoker(10)) == []
    assert validate_questionnaire_response(coded, smoker(25)) == ['"quit_plan" is required']  # an item without text is named by its linkId
    assert validate_questionnaire_response(coded, smoker(3, [{"linkId": "both", "answer": [{"valueBoolean": True}]}])) == []
    assert validate_questionnaire_response(coded, smoker(10, [{"linkId": "both", "answer": [{"valueBoolean": True}]}])) == ['"both" is not asked (its condition is not met) and cannot carry answers']
    never = {"resourceType": "QuestionnaireResponse", "status": "completed", "item": [{"linkId": "smokes", "answer": [{"valueCoding": {"system": "http://snomed.info/sct", "code": "266919005"}}]}]}
    assert validate_questionnaire_response(coded, never) == []
    wrong_system = {**never, "item": [{"linkId": "smokes", "answer": [{"valueCoding": {"system": "http://loinc.org", "code": "266919005"}}]}]}
    assert validate_questionnaire_response(coded, wrong_system) == ['"smokes": http://loinc.org|266919005 is not one of the offered options']
    # The pieces: no answer makes every comparison false except `exists: false`; a boolean never orders; dates order as text.
    assert condition_met({"question": "x", "operator": "!=", "answerBoolean": True}, []) is False
    assert condition_met({"question": "x", "operator": "exists", "answerBoolean": False}, []) is True
    assert condition_met({"question": "x", "operator": ">", "answerBoolean": False}, [{"valueBoolean": True}]) is False
    assert condition_met({"question": "x", "operator": ">=", "answerDate": "2026-01-01"}, [{"valueDate": "2026-03-01"}]) is True
    items = {"a": {"linkId": "a", "type": "boolean"}, "b": {"linkId": "b", "type": "text", "enableWhen": [{"question": "a", "operator": "=", "answerBoolean": True}]}}
    assert item_enabled("b", items, {"a": None, "b": None}, {"a": [{"valueBoolean": True}]}) and not item_enabled("b", items, {"a": None, "b": None}, {})


def test_in_memory_conditional_create_and_identifier_search(writable):
    r = writable.create({"resourceType": "Basic", "identifier": [{"system": "s", "value": "v"}]}, if_none_exist={"identifier": "s|v"})
    again = writable.create({"resourceType": "Basic", "identifier": [{"system": "s", "value": "v"}]}, if_none_exist={"identifier": "s|v"})
    assert r["id"] == again["id"] == "basic-created-0001"
    assert writable.search("Basic", {"identifier": "v"}) == [r] and writable.search("Basic", {"identifier": "other|v"}) == []
    writable.create({"resourceType": "Basic", "identifier": [{"system": "s", "value": "v"}]})  # unconditional duplicate
    with pytest.raises(handler.ConditionalCreateAmbiguous):
        writable.create({"resourceType": "Basic"}, if_none_exist={"identifier": "s|v"})


# ── write path: a measurement, a status ──────────────────────────────────────────────────

WARD = "[app-app_ward_entry-ward]"
BP = "http://loinc.org|85354-9"
SYS, DIA = "http://loinc.org|8480-6", "http://loinc.org|8462-4"


def ward_manifest():
    """What the compiler emits for a composed page with a blood-pressure entry form, a resolvable problem list
    and a stoppable medication list — declared by hand here so the dispatcher tests do not depend on the goldens."""
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_ward_entry", "version": "0.1.0", "name": "Ward entry", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-11T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "ward", "display_name": "Ward", "cognito_group": "app-app_ward_entry-ward", "data_scope_ref": "scope_ward", "ui_capabilities": ["view"]}], "default_role": "ward"},
        "data_scopes": {
            "scope_ward": {
                "patient_scope": "individual",
                "phi_fields_visible": ["name", "dob", "mrn"],
                "fhir": [
                    {"resource": "Patient", "operations": ["read"]},
                    {"resource": "Observation", "operations": ["search", "create"], "codes": [BP], "filter": "subject={context.patient_id}"},
                    {"resource": "Condition", "operations": ["search", "update"], "filter": "subject={context.patient_id}"},
                    {"resource": "MedicationRequest", "operations": ["search", "update"], "filter": "subject={context.patient_id}"},
                    {"resource": "Provenance", "operations": ["create"]},
                ],
            }
        },
        "primitives": [
            {"id": "p_patient", "kind": "data.fhir.patient.read", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id"}, "output_binding": "patient"},
            {"id": "p_bp_entry", "kind": "write.fhir.observation.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [BP], "components": [SYS, DIA], "unit": "mmHg", "category": "vital-signs", "ranges": {SYS: {"min": 50, "max": 300}, DIA: {"min": 30, "max": 200}}, "rules": [{"component": SYS, "above": DIA, "message": "Systolic must be above diastolic"}], "max_backdate_days": 7, "observation": "$ui.bp_entry"}, "output_binding": "bp_recorded"},
            {"id": "p_resolve", "kind": "write.fhir.condition.update_status", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "allowed": ["resolved", "inactive"], "change": "$ui.resolve"}, "output_binding": "resolved"},
            {"id": "p_stop", "kind": "write.fhir.medication_request.update_status", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "allowed": ["stopped", "completed", "on-hold"], "change": "$ui.stop"}, "output_binding": "stopped"},
        ],
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Ward"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": True, "source": ["smart_launch"]}],
        "actions": [
            {"id": "record_bp", "label": "Record", "primitive": "p_bp_entry", "on_success": "reload"},
            {"id": "resolve", "label": "Resolve", "primitive": "p_resolve", "on_success": "reload"},
            {"id": "stop", "label": "Stop", "primitive": "p_stop", "on_success": "reload"},
        ],
        "audit": {"clinical_context": "ward", "intended_users": ["nurse"], "intended_purpose": "test", "mdr_classification": "none", "data_categories": ["phi"]},
    }


@pytest.fixture
def ward(writable, audit):
    item = rm.version_item(ward_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)


def ward_req(primitive_id, config, raw=False):
    ctx = {"patient_id": "pat-kms-0001"}
    return {"app_id": "app_ward_entry", "manifest_version": "0.1.0", "primitive_id": primitive_id, "role": "ward", "config": config if raw else as_the_panel_sends(ward_manifest(), primitive_id, config, ctx), "context": ctx}


def bp_entry(sys=138, dia=86, **overrides):
    obs = {
        "resourceType": "Observation",
        "identifier": [{"system": "urn:medapp:submission", "value": "bp-0001"}],
        "code": {"coding": [{"system": "http://loinc.org", "code": "85354-9", "display": "Blood pressure panel"}]},
        "effectiveDateTime": "2026-09-11T11:30:00Z",
        "component": [
            {"code": {"coding": [{"system": "http://loinc.org", "code": "8480-6"}]}, "valueQuantity": {"value": sys, "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
            {"code": {"coding": [{"system": "http://loinc.org", "code": "8462-4"}]}, "valueQuantity": {"value": dia, "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
        ],
        # claims the dispatcher must not trust
        "status": "amended",
        "performer": [{"reference": "Practitioner/somebody"}],
        "issued": "1999-01-01T00:00:00Z",
        "meta": {"versionId": "9"},
    }
    obs.update(overrides)
    return obs


def entry_config(obs):
    # What the form contributes: the observation. Codes, ranges, the relation systolic-above-diastolic and the backdating
    # limit are the manifest's (as the compiler emits them for the blood pressure panel) and the panel copies them along.
    return {"observation": obs}


def test_recording_a_measurement_stores_an_observation_the_record_can_see_and_a_provenance(ward, writable, audit):
    ev = event("write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry())), sub="nurse-7")
    ev["requestContext"]["authorizer"]["jwt"]["claims"]["email"] = "nurse@klinikum-musterstadt.example"
    res = handler.handle(ev, ward)
    status, out = res["statusCode"], json.loads(res["body"])
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "observation-created-0001"
    assert stored["status"] == "final" and stored["subject"] == {"reference": "Patient/pat-kms-0001"}
    assert stored["issued"] == "2026-09-11T12:00:00Z" and stored["effectiveDateTime"] == "2026-09-11T11:30:00Z"
    assert stored["performer"] == [{"identifier": {"system": "urn:medapp:cognito-sub", "value": "nurse-7"}, "display": "nurse@klinikum-musterstadt.example"}]
    assert stored["category"][0]["coding"][0]["code"] == "vital-signs"
    assert stored["meta"]["source"] == "urn:medapp:app_ward_entry@0.1.0" and stored["meta"]["versionId"] == "1"
    assert audit[-1]["resource_ref"] == "Observation/observation-created-0001" and audit[-1]["provenance"] == "recorded"
    # The rest of the record sees it: the trend primitive finds the new reading first.
    readings = writable.search("Observation", {"patient": "pat-kms-0001", "combo-code": "8480-6"})
    assert readings[0]["id"] == "observation-created-0001" and len(readings) == 25
    # And a Provenance names who wrote it, through which app.
    provenances = writable.search("Provenance", {})
    assert len(provenances) == 1
    p = provenances[0]
    assert p["target"] == [{"reference": "Observation/observation-created-0001"}] and p["activity"]["coding"][0]["code"] == "CREATE"
    assert p["agent"][0]["who"]["identifier"]["value"] == "nurse-7" and p["policy"] == ["urn:medapp:app_ward_entry@0.1.0"]
    # Retrying the same submission is one record, one provenance.
    status, retry = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry())))
    assert status == 200 and retry["output"]["id"] == "observation-created-0001" and len(writable.search("Provenance", {})) == 1


def test_a_measurement_outside_the_form_s_rules_is_refused_with_the_reasons(ward, writable, audit):
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry(sys=900))))
    assert status == 422 and out["problems"] == ["component http://loinc.org|8480-6: 900 mmHg is outside the accepted range 50–300"]
    wrong_code = bp_entry(code={"coding": [{"system": "http://loinc.org", "code": "8867-4"}]})
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(wrong_code)))
    assert status == 422 and out["problems"] == ["code http://loinc.org|8867-4 is not one this form may record (http://loinc.org|85354-9)"]
    future = bp_entry(effectiveDateTime="2026-09-12T09:00:00Z")
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(future)))
    assert status == 422 and out["problems"] == ["effective date must not be in the future"]
    stale = bp_entry(effectiveDateTime="2026-08-01T09:00:00Z")
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(stale)))
    assert status == 422 and out["problems"] == ["effective date must not be more than 7 days ago"]
    missing = bp_entry()
    missing["component"] = missing["component"][:1]
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(missing)))
    assert status == 422 and out["problems"] == ["component http://loinc.org|8462-4 is missing"]
    # The two fields swapped (an issue seen in use): each within its own range, the panel impossible — refused
    # server-side as well, so no app can land a diastolic above the systolic in the record.
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry(sys=90, dia=120))))
    assert status == 422 and out["problems"] == ["Systolic must be above diastolic (90 vs 120 mmHg)"]
    status, out = call(ward, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry(sys=100, dia=100))))
    assert status == 422 and out["problems"] == ["Systolic must be above diastolic (100 vs 100 mmHg)"]
    assert audit[-1]["outcome"] == "refused" and writable.search("Provenance", {}) == []
    assert len(writable.search("Observation", {"patient": "pat-kms-0001", "combo-code": "8480-6"})) == 24


def test_resolving_a_problem_is_a_versioned_update_with_provenance(ward, writable):
    cfg = {"subject": "pat-kms-0001", "allowed": ["resolved", "inactive"], "change": {"id": "cond-kms-0003", "versionId": "1", "status": "resolved", "note": "Arthroskopie 02/2024, beschwerdefrei."}}
    status, out = call(ward, "write.fhir.condition.update_status", WARD, ward_req("p_resolve", cfg))
    assert status == 200, out
    updated = out["output"]
    assert updated["clinicalStatus"]["coding"][0]["code"] == "resolved" and updated["abatementDateTime"] == "2026-09-11T12:00:00Z"
    assert updated["meta"]["versionId"] == "2" and updated["meta"]["source"] == "urn:medapp:app_ward_entry@0.1.0"
    assert updated["note"][-1]["text"] == "Arthroskopie 02/2024, beschwerdefrei." and updated["note"][-1]["time"] == "2026-09-11T12:00:00Z"
    assert writable.read("Condition", "cond-kms-0003")["clinicalStatus"]["coding"][0]["code"] == "resolved"
    assert [c["id"] for c in writable.search("Condition", {"patient": "pat-kms-0001", "clinical-status": "active"})] == ["cond-kms-0002", "cond-kms-0001"]
    p = writable.search("Provenance", {})[0]
    assert p["activity"]["coding"][0]["code"] == "UPDATE" and p["entity"] == [{"role": "revision", "what": {"reference": "Condition/cond-kms-0003/_history/1"}}]
    # Someone working from the old version cannot overwrite the change.
    stale = dict(cfg, change={"id": "cond-kms-0003", "versionId": "1", "status": "inactive"})
    status, out = call(ward, "write.fhir.condition.update_status", WARD, ward_req("p_resolve", stale))
    assert status == 409 and "changed by someone else" in out["message"]
    assert writable.read("Condition", "cond-kms-0003")["clinicalStatus"]["coding"][0]["code"] == "resolved"


def test_status_changes_are_confined_to_the_allowed_set_and_the_patient_in_context(ward, writable):
    def change(**kw):
        return ward_req("p_resolve", {"subject": "pat-kms-0001", "allowed": ["resolved", "inactive"], "change": kw})

    status, out = call(ward, "write.fhir.condition.update_status", WARD, change(id="cond-kms-0001", status="entered-in-error"))
    assert status == 422 and out["problems"] == ["status 'entered-in-error' is not one of resolved, inactive"]
    status, out = call(ward, "write.fhir.condition.update_status", WARD, change(id="cond-kms-0004", status="resolved"))  # Jonas's migraine
    assert status == 422 and out["problems"] == ["Condition/cond-kms-0004 belongs to another patient"]
    status, out = call(ward, "write.fhir.condition.update_status", WARD, change(id="cond-nope", status="resolved"))
    assert status == 422 and out["problems"] == ["Condition/cond-nope was not found"]
    status, out = call(ward, "write.fhir.condition.update_status", WARD, change(status="resolved"))
    assert status == 422 and out["problems"] == ["target id is required"]
    assert writable.search("Provenance", {}) == []


def test_stopping_a_medication_keeps_the_prescription_and_records_the_reason(ward, writable):
    cfg = {"subject": "pat-kms-0001", "allowed": ["stopped", "completed", "on-hold"], "change": {"id": "medrx-kms-0003", "status": "stopped", "reason": "Knöchelödeme"}}
    status, out = call(ward, "write.fhir.medication_request.update_status", WARD, ward_req("p_stop", cfg))
    assert status == 200, out
    assert out["output"]["status"] == "stopped" and out["output"]["statusReason"] == {"text": "Knöchelödeme"}
    assert out["output"]["medicationCodeableConcept"]["coding"][0]["code"] == "C08CA01"  # the prescription itself is untouched
    assert [m["id"] for m in writable.search("MedicationRequest", {"patient": "pat-kms-0001", "status": "active"})] == ["medrx-kms-0002", "medrx-kms-0001"]
    status, out = call(ward, "write.fhir.medication_request.update_status", WARD, ward_req("p_stop", dict(cfg, change={"id": "medrx-kms-0003", "status": "stopped"})))
    assert status == 422 and out["problems"] == ["MedicationRequest/medrx-kms-0003 is already stopped"]


def test_writes_without_a_provenance_grant_still_land_and_are_audited(writable, audit):
    stripped = ward_manifest()
    stripped["data_scopes"]["scope_ward"]["fhir"] = [e for e in stripped["data_scopes"]["scope_ward"]["fhir"] if e["resource"] != "Provenance"]
    item = rm.version_item(stripped, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([item]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d, "write.fhir.observation.create", WARD, ward_req("p_bp_entry", entry_config(bp_entry())))
    assert status == 200 and writable.search("Provenance", {}) == [] and audit[-1]["outcome"] == "ok"
    assert audit[-1]["provenance"] == "not_granted", "the audit record is then the only trail, and says so"
    # …and a role whose scope has no `update` cannot change a status at all.
    status, out = call(d, "write.fhir.condition.update_status", "[app-app_ward_entry-ward]", ward_req("p_resolve", {"subject": "pat-kms-0001", "allowed": ["resolved"], "change": {"id": "cond-kms-0001", "status": "resolved"}}))
    assert status == 200  # Condition.update is still in this manifest's scope
    for e in stripped["data_scopes"]["scope_ward"]["fhir"]:
        if e["resource"] == "Condition":
            e["operations"] = ["search"]
    d2 = handler.Dispatcher(FakeTable([rm.version_item(stripped, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d2, "write.fhir.condition.update_status", WARD, ward_req("p_resolve", {"subject": "pat-kms-0001", "allowed": ["resolved"], "change": {"id": "cond-kms-0002", "status": "resolved"}}))
    assert status == 403 and out["requirement"] == "Condition.update"


# ── write path: the coded entries — a problem, an allergy, a procedure ─────────────────────────

DOC = "[app-app_ward_documentation-ward_physician]"
ICD = "http://fhir.de/CodeSystem/bfarm/icd-10-gm"
ATC = "http://www.whocc.no/atc"
OPS = "http://fhir.de/CodeSystem/bfarm/ops"


def documentation_manifest():
    """What the compiler emits for specs/composed-ward-documentation.yaml, declared by hand here like ward_manifest()."""
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_ward_documentation", "version": "0.1.0", "name": "Ward documentation", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-11T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "ward_physician", "display_name": "Ward physician", "cognito_group": "app-app_ward_documentation-ward_physician", "data_scope_ref": "scope_ward_physician", "ui_capabilities": ["view"]}], "default_role": "ward_physician"},
        "data_scopes": {
            "scope_ward_physician": {
                "patient_scope": "individual",
                "phi_fields_visible": ["name", "dob", "mrn"],
                "fhir": [
                    {"resource": "Patient", "operations": ["read"]},
                    {"resource": "Condition", "operations": ["search", "create"], "filter": "subject={context.patient_id}"},
                    {"resource": "AllergyIntolerance", "operations": ["search", "create"], "filter": "subject={context.patient_id}"},
                    {"resource": "Procedure", "operations": ["search"], "filter": "subject={context.patient_id}"},  # no create: the procedure form is refused below
                    {"resource": "Provenance", "operations": ["create"]},
                ],
            }
        },
        "primitives": [
            {"id": "p_patient", "kind": "data.fhir.patient.read", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id"}, "output_binding": "patient"},
            {"id": "p_add_problem", "kind": "write.fhir.condition.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [f"{ICD}|I10.90", f"{ICD}|E87.6"], "verification": ["confirmed", "provisional"], "category": "problem-list-item", "severity": True, "condition": "$ui.add_problem_entry"}, "output_binding": "add_problem_recorded"},
            {"id": "p_add_allergy", "kind": "write.fhir.allergy_intolerance.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [f"{ATC}|C09AA05"], "types": ["allergy", "intolerance"], "categories": ["medication"], "verification": ["confirmed", "unconfirmed"], "criticality": True, "reaction": True, "allergy": "$ui.add_allergy_entry"}, "output_binding": "add_allergy_recorded"},
            {"id": "p_add_procedure", "kind": "write.fhir.procedure.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [f"{OPS}|1-632.0"], "statuses": ["completed"], "max_backdate_days": 14, "body_site": True, "outcome": False, "procedure": "$ui.add_procedure_entry"}, "output_binding": "add_procedure_recorded"},
        ],
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Ward documentation"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": True, "source": ["smart_launch"]}],
        "actions": [
            {"id": "record_add_problem", "label": "Add", "primitive": "p_add_problem", "on_success": "reload"},
            {"id": "record_add_allergy", "label": "Record", "primitive": "p_add_allergy", "on_success": "reload"},
            {"id": "record_add_procedure", "label": "Record", "primitive": "p_add_procedure", "on_success": "reload"},
        ],
        "audit": {"clinical_context": "ward", "intended_users": ["physician"], "intended_purpose": "test", "mdr_classification": "none", "data_categories": ["phi"]},
    }


@pytest.fixture
def documentation(writable, audit):
    item = rm.version_item(documentation_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)


def doc_req(primitive_id, config, raw=False):
    ctx = {"patient_id": "pat-kms-0001"}
    return {"app_id": "app_ward_documentation", "manifest_version": "0.1.0", "primitive_id": primitive_id, "role": "ward_physician", "config": config if raw else as_the_panel_sends(documentation_manifest(), primitive_id, config, ctx), "context": ctx}


def problem_cfg(**overrides):
    condition = {
        "resourceType": "Condition",
        "identifier": [{"system": "urn:medapp:submission", "value": "prob-0001"}],
        "code": {"coding": [{"system": ICD, "code": "E87.6", "display": "Hypokalaemia"}], "text": "Hypokalaemia"},
        "subject": {"reference": "Patient/pat-kms-0001"},
        "verificationStatus": {"coding": [{"code": "provisional"}]},
        "severity": {"coding": [{"system": "http://snomed.info/sct", "code": "6736007", "display": "Moderate"}]},
        "onsetDateTime": "2026-09-01",
        "note": [{"text": "Kalium 3.1 mmol/L.", "authorString": "forged", "time": "1999-01-01T00:00:00Z"}],
        # claims the dispatcher must not trust
        "clinicalStatus": {"coding": [{"code": "active"}]},
        "recorder": {"reference": "Practitioner/somebody"},
        "recordedDate": "1999-01-01",
        "meta": {"versionId": "9"},
    }
    condition.update(overrides)
    return {"subject": "pat-kms-0001", "codes": [f"{ICD}|I10.90", f"{ICD}|E87.6"], "verification": ["confirmed", "provisional"], "category": "problem-list-item", "severity": True, "condition": condition}


def test_adding_a_problem_stores_an_active_condition_the_list_shows_and_a_provenance(documentation, writable, audit):
    ev = event("write.fhir.condition.create", DOC, doc_req("p_add_problem", problem_cfg()), sub="doc-3")
    ev["requestContext"]["authorizer"]["jwt"]["claims"]["email"] = "arzt@klinikum-musterstadt.example"
    res = handler.handle(ev, documentation)
    status, out = res["statusCode"], json.loads(res["body"])
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "condition-created-0001"
    assert stored["clinicalStatus"]["coding"][0]["code"] == "active" and stored["verificationStatus"]["coding"][0]["code"] == "provisional"
    assert stored["category"][0]["coding"][0]["code"] == "problem-list-item" and stored["severity"]["coding"][0]["code"] == "6736007"
    assert stored["subject"] == {"reference": "Patient/pat-kms-0001"} and stored["onsetDateTime"] == "2026-09-01"
    assert stored["recordedDate"] == "2026-09-11T12:00:00Z" and stored["recorder"] == {"identifier": {"system": "urn:medapp:cognito-sub", "value": "doc-3"}, "display": "arzt@klinikum-musterstadt.example"}
    assert stored["note"] == [{"authorString": "arzt@klinikum-musterstadt.example", "time": "2026-09-11T12:00:00Z", "text": "Kalium 3.1 mmol/L."}]  # attributed by the platform, not the client
    assert stored["meta"]["source"] == "urn:medapp:app_ward_documentation@0.1.0" and stored["meta"]["versionId"] == "1"
    assert audit[-1]["resource_ref"] == "Condition/condition-created-0001" and audit[-1]["provenance"] == "recorded"
    # The problem list sees it first; the Provenance names who and through which app.
    active = writable.search("Condition", {"patient": "pat-kms-0001", "clinical-status": "active"})
    assert active[0]["id"] == "condition-created-0001"
    p = writable.search("Provenance", {})
    assert len(p) == 1 and p[0]["target"] == [{"reference": "Condition/condition-created-0001"}] and p[0]["agent"][0]["who"]["identifier"]["value"] == "doc-3"
    # A retry is the same record, one provenance.
    status, retry = call(documentation, "write.fhir.condition.create", DOC, doc_req("p_add_problem", problem_cfg()))
    assert status == 200 and retry["output"]["id"] == "condition-created-0001" and len(writable.search("Provenance", {})) == 1
    # Not one of the form's codes → refused, nothing stored.
    status, out = call(documentation, "write.fhir.condition.create", DOC, doc_req("p_add_problem", problem_cfg(code={"coding": [{"system": ICD, "code": "J45.9"}]}, identifier=[{"system": "urn:medapp:submission", "value": "prob-0002"}])))
    assert status == 422 and out["problems"] == [f"code {ICD}|J45.9 is not one this form may record ({ICD}|I10.90, {ICD}|E87.6)"]
    assert len(writable.search("Condition", {"patient": "pat-kms-0001", "clinical-status": "active"})) == len(active)


def test_recording_an_allergy_stores_it_active_with_its_reaction_and_a_procedure_needs_the_create_grant(documentation, writable, audit):
    allergy = {
        "resourceType": "AllergyIntolerance",
        "identifier": [{"system": "urn:medapp:submission", "value": "alg-0001"}],
        "code": {"coding": [{"system": ATC, "code": "C09AA05", "display": "Ramipril"}]},
        "patient": {"reference": "Patient/pat-kms-0001"},
        "type": "allergy",
        "category": ["medication"],
        "criticality": "high",
        "reaction": [{"manifestation": [{"text": "Angio-oedema"}], "severity": "severe"}],
        "clinicalStatus": {"coding": [{"code": "active"}]},
    }
    cfg = {"subject": "pat-kms-0001", "codes": [f"{ATC}|C09AA05"], "types": ["allergy", "intolerance"], "categories": ["medication"], "verification": ["confirmed", "unconfirmed"], "criticality": True, "reaction": True, "allergy": allergy}
    status, out = call(documentation, "write.fhir.allergy_intolerance.create", DOC, doc_req("p_add_allergy", cfg))
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "allergyintolerance-created-0001"
    assert stored["clinicalStatus"]["coding"][0]["code"] == "active" and stored["verificationStatus"]["coding"][0]["code"] == "confirmed"  # none sent: the first offered
    assert stored["patient"] == {"reference": "Patient/pat-kms-0001"} and stored["criticality"] == "high" and stored["reaction"][0]["severity"] == "severe"
    assert stored["recordedDate"] == "2026-09-11T12:00:00Z" and stored["recorder"]["identifier"]["value"] == "user-1"
    assert [a["id"] for a in writable.search("AllergyIntolerance", {"patient": "pat-kms-0001", "clinical-status": "active"})][0] == "allergyintolerance-created-0001"
    # A category the form does not offer is refused.
    status, out = call(documentation, "write.fhir.allergy_intolerance.create", DOC, doc_req("p_add_allergy", dict(cfg, allergy=dict(allergy, category=["food"], identifier=[{"system": "urn:medapp:submission", "value": "alg-0002"}]))))
    assert status == 422 and out["problems"] == ["category 'food' is not one of medication"]
    # The procedure form: this role's scope grants no Procedure.create — the dispatcher refuses before validating anything.
    procedure = {"resourceType": "Procedure", "code": {"coding": [{"system": OPS, "code": "1-632.0"}]}, "subject": {"reference": "Patient/pat-kms-0001"}, "status": "completed", "performedDateTime": "2026-09-10T09:00:00Z"}
    status, out = call(documentation, "write.fhir.procedure.create", DOC, doc_req("p_add_procedure", {"subject": "pat-kms-0001", "codes": [f"{OPS}|1-632.0"], "statuses": ["completed"], "max_backdate_days": 14, "body_site": True, "outcome": False, "procedure": procedure}))
    assert status == 403 and out["requirement"] == "Procedure.create"
    assert audit[-1]["outcome"] == "refused"


def test_recording_a_procedure_stamps_the_performer_and_keeps_the_window(writable, audit):
    granted = documentation_manifest()
    for e in granted["data_scopes"]["scope_ward_physician"]["fhir"]:
        if e["resource"] == "Procedure":
            e["operations"] = ["search", "create"]
    d = handler.Dispatcher(FakeTable([rm.version_item(granted, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")]), writable, now=NOW, emit_audit=audit.append)
    procedure = {"resourceType": "Procedure", "identifier": [{"system": "urn:medapp:submission", "value": "proc-0001"}], "code": {"coding": [{"system": OPS, "code": "1-632.0", "display": "Gastroscopy"}]}, "subject": {"reference": "Patient/pat-kms-0001"}, "status": "completed", "performedDateTime": "2026-09-10T09:00:00Z", "bodySite": [{"text": "Stomach"}], "performer": [{"actor": {"reference": "Practitioner/forged"}}]}
    cfg = {"subject": "pat-kms-0001", "codes": [f"{OPS}|1-632.0"], "statuses": ["completed"], "max_backdate_days": 14, "body_site": True, "outcome": False, "procedure": procedure}
    status, out = call(d, "write.fhir.procedure.create", DOC, doc_req("p_add_procedure", cfg))
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "procedure-created-0001" and stored["status"] == "completed" and stored["bodySite"] == [{"text": "Stomach"}]
    assert stored["performer"] == [{"actor": {"identifier": {"system": "urn:medapp:cognito-sub", "value": "user-1"}}}]  # the signed-in person, never the client's claim
    assert stored["recorder"]["identifier"]["value"] == "user-1" and stored["meta"]["source"] == "urn:medapp:app_ward_documentation@0.1.0"
    assert writable.search("Procedure", {"patient": "pat-kms-0001"})[0]["id"] == "procedure-created-0001"
    stale = dict(procedure, performedDateTime="2026-08-01T09:00:00Z", identifier=[{"system": "urn:medapp:submission", "value": "proc-0002"}])
    status, out = call(d, "write.fhir.procedure.create", DOC, doc_req("p_add_procedure", dict(cfg, procedure=stale)))
    assert status == 422 and out["problems"] == ["performed date must not be more than 14 days ago"]


# ── tasks: the worklist across patients, a new task, a task moved on ───────────────────────────

TASK = "urn:medapp:task"
WARD_TEAM = "[app-app_ward_worklist-ward_team]"


def worklist_manifest(with_patient_page: bool = False):
    """What the compiler emits for specs/ward-worklist.yaml (and, with the flag, the patient page's task primitives),
    declared by hand like ward_manifest()."""
    fhir = [
        {"resource": "Patient", "operations": ["read"]},
        {"resource": "Task", "operations": ["search", "update", "create"], "filter": "patient={context.patient_id}"},
        {"resource": "Provenance", "operations": ["create"]},
    ]
    primitives = [
        {"id": "p_worklist", "kind": "data.task.worklist", "catalog_version": "1.0.0", "config": {"codes": [f"{TASK}|falls_screen", f"{TASK}|discharge_letter", f"{TASK}|follow_up_call", f"{TASK}|physio_referral"], "statuses": ["requested", "in-progress"]}, "output_binding": "worklist"},
        {"id": "p_task_status", "kind": "write.fhir.task.update_status", "catalog_version": "1.0.0", "config": {"allowed": ["in-progress", "completed", "cancelled"], "change": "$ui.worklist_status"}, "output_binding": "task_updated"},
        {"id": "p_new_task", "kind": "write.fhir.task.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "codes": [f"{TASK}|falls_screen", f"{TASK}|physio_referral"], "priorities": ["routine", "urgent"], "due": True, "task": "$ui.new_task_entry"}, "output_binding": "new_task_created"},
    ]
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_ward_worklist", "version": "0.1.0", "name": "Ward worklist", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-11T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "ward_team", "display_name": "Ward team", "cognito_group": "app-app_ward_worklist-ward_team", "data_scope_ref": "scope_ward_team", "ui_capabilities": ["view"]}], "default_role": "ward_team"},
        "data_scopes": {"scope_ward_team": {"patient_scope": "cohort", "phi_fields_visible": ["name", "dob", "mrn"], "fhir": fhir}},
        "primitives": primitives,
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Worklist"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": False, "source": ["smart_launch"]}],
        "actions": [
            {"id": "update_task", "label": "Update", "primitive": "p_task_status", "on_success": "reload"},
            {"id": "record_new_task", "label": "Create", "primitive": "p_new_task", "on_success": "reload"},
        ],
        "audit": {"clinical_context": "ward", "intended_users": ["nurse"], "intended_purpose": "test", "mdr_classification": "none", "data_categories": ["phi"]},
    }


@pytest.fixture
def worklist(writable, audit):
    item = rm.version_item(worklist_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)


def wl_req(primitive_id, config, context=None, raw=False, manifest=None):
    ctx = context or {}
    manifest = manifest or worklist_manifest()
    return {"app_id": "app_ward_worklist", "manifest_version": manifest["metadata"]["version"], "primitive_id": primitive_id, "role": "ward_team", "config": config if raw else as_the_panel_sends(manifest, primitive_id, config, ctx), "context": ctx}


def worklist_variant(version, primitive_id, **config):
    m = declaring(worklist_manifest(), primitive_id, **config)
    m["metadata"]["version"] = version
    return m


def test_the_worklist_lists_open_tasks_across_patients_overdue_first_with_their_patient(worklist, writable):
    status, out = call(worklist, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {}))
    assert status == 200, out
    rows = out["output"]["rows"]
    # The seed's open tasks (the completed screen is not among them) by due date — none overdue on 2026-09-11.
    assert [r["task"]["id"] for r in rows] == ["task-kms-0001", "task-kms-0002", "task-kms-0003"]
    assert [r["overdue"] for r in rows] == [False, False, False] and out["output"]["overdue_count"] == 0
    assert out["output"]["count"] == 3
    assert rows[0]["patient"]["id"] == "pat-kms-0001" and rows[2]["patient"]["id"] == "pat-kms-0003"
    # Three weeks on, two of them are overdue and come first; the day is the server's, not the client's.
    later = handler.Dispatcher(FakeTable([*version_items(), rm.version_item(worklist_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")]), writable, now=datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc), emit_audit=lambda r: None)
    status, out = call(later, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {"statuses": ["requested", "in-progress"]}))
    assert status == 200 and [(r["task"]["id"], r["overdue"]) for r in out["output"]["rows"]] == [("task-kms-0001", True), ("task-kms-0002", True), ("task-kms-0003", False)]
    assert out["output"]["overdue_count"] == 2
    # A worklist declared for one kind; one declared for every status (the completed screen appears too). What the list
    # shows is the manifest's: a request that widens or narrows the declared codes or statuses is refused, not obeyed.
    one_kind = worklist_variant("0.1.1", "p_worklist", codes=[f"{TASK}|follow_up_call"])
    every_status = worklist_variant("0.1.2", "p_worklist", statuses=["requested", "in-progress", "completed"])
    d = published(writable, worklist_manifest(), one_kind, every_status, now=NOW, emit_audit=lambda r: None)
    status, out = call(d, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {}, manifest=one_kind))
    assert status == 200 and [r["task"]["id"] for r in out["output"]["rows"]] == ["task-kms-0003"]
    status, out = call(d, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {}, manifest=every_status))
    assert status == 200 and len(out["output"]["rows"]) == 4
    status, out = call(d, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {"statuses": ["requested", "in-progress", "completed", "cancelled"]}, raw=True))
    assert status == 400 and "statuses" in out["message"] and "executes the published configuration only" in out["message"]


def test_moving_a_task_on_from_the_worklist_needs_no_patient_in_context_and_records_who_took_it(worklist, writable):
    cfg = {"change": {"id": "task-kms-0001", "versionId": "1", "status": "in-progress", "note": "Übernehme ich."}}
    status, out = call(worklist, "write.fhir.task.update_status", WARD_TEAM, wl_req("p_task_status", cfg))
    assert status == 200, out
    updated = out["output"]
    assert updated["status"] == "in-progress" and updated["owner"]["identifier"] == {"system": "urn:medapp:cognito-sub", "value": "user-1"}
    assert updated["executionPeriod"]["start"] == "2026-09-11T12:00:00Z" and updated["lastModified"] == "2026-09-11T12:00:00Z"
    assert updated["note"][-1]["text"] == "Übernehme ich." and updated["meta"]["versionId"] == "2"
    status, out = call(worklist, "write.fhir.task.update_status", WARD_TEAM, wl_req("p_task_status", {"change": {"id": "task-kms-0001", "versionId": "2", "status": "completed"}}))
    assert status == 200 and out["output"]["status"] == "completed" and out["output"]["executionPeriod"]["end"] == "2026-09-11T12:00:00Z"
    assert out["output"]["owner"]["identifier"]["value"] == "user-1"  # the first taker stays the owner
    p = writable.search("Provenance", {})
    assert len(p) == 2 and p[-1]["activity"]["coding"][0]["code"] == "UPDATE"
    # Not in the set the app allows (an app that cannot cancel), already there.
    no_cancel = worklist_variant("0.1.1", "p_task_status", allowed=["in-progress", "completed"])
    d = published(writable, worklist_manifest(), no_cancel, now=NOW, emit_audit=lambda r: None)
    status, out = call(d, "write.fhir.task.update_status", WARD_TEAM, wl_req("p_task_status", {"change": {"id": "task-kms-0002", "status": "cancelled"}}, manifest=no_cancel))
    assert status == 422 and out["problems"] == ["status 'cancelled' is not one of in-progress, completed"]
    status, out = call(d, "write.fhir.task.update_status", WARD_TEAM, wl_req("p_task_status", {"change": {"id": "task-kms-0002", "status": "in-progress"}}, manifest=no_cancel))
    assert status == 422 and out["problems"] == ["Task/task-kms-0002 is already in-progress"]
    # A client of that app cannot grant itself the cancellation by sending a wider `allowed`: the published one is the rule.
    status, out = call(d, "write.fhir.task.update_status", WARD_TEAM, {**wl_req("p_task_status", {}, manifest=no_cancel), "config": {"allowed": ["in-progress", "completed", "cancelled"], "change": {"id": "task-kms-0002", "status": "cancelled"}}})
    assert status == 400 and "allowed" in out["message"]
    assert writable.read("Task", "task-kms-0002")["status"] == "in-progress"


def test_a_new_task_is_requested_for_the_patient_in_context_and_shows_on_the_worklist(worklist, writable, audit):
    task = {
        "resourceType": "Task",
        "identifier": [{"system": "urn:medapp:submission", "value": "task-0001"}],
        "code": {"coding": [{"system": TASK, "code": "physio_referral", "display": "Physiotherapy referral"}], "text": "Physiotherapy referral"},
        "for": {"reference": "Patient/pat-kms-0002"},
        "status": "requested",
        "priority": "urgent",
        "description": "Nach Sturz mobilisieren.",
        "restriction": {"period": {"end": "2026-09-14", "start": "1999-01-01"}},
        # claims the dispatcher must not trust
        "owner": {"reference": "Practitioner/forged"},
        "authoredOn": "1999-01-01T00:00:00Z",
    }
    cfg = {"task": task}
    status, out = call(worklist, "write.fhir.task.create", WARD_TEAM, wl_req("p_new_task", cfg, context={"patient_id": "pat-kms-0002"}))
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "task-created-0001" and stored["status"] == "requested" and stored["intent"] == "order" and stored["priority"] == "urgent"
    assert stored["for"] == {"reference": "Patient/pat-kms-0002"} and stored["authoredOn"] == "2026-09-11T12:00:00Z" and "owner" not in stored
    assert stored["requester"]["identifier"]["value"] == "user-1" and stored["restriction"] == {"period": {"end": "2026-09-14"}}  # the due day only
    assert audit[-1]["resource_ref"] == "Task/task-created-0001" and audit[-1]["provenance"] == "recorded"
    status, out = call(worklist, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {}))
    assert status == 200 and [r["task"]["id"] for r in out["output"]["rows"]] == ["task-kms-0001", "task-created-0001", "task-kms-0002", "task-kms-0003"]  # overdue first, then by due date
    # Due yesterday → refused; a kind the form does not offer → refused.
    late = dict(task, restriction={"period": {"end": "2026-09-10"}}, identifier=[{"system": "urn:medapp:submission", "value": "task-0002"}])
    status, out = call(worklist, "write.fhir.task.create", WARD_TEAM, wl_req("p_new_task", dict(cfg, task=late), context={"patient_id": "pat-kms-0002"}))
    assert status == 422 and out["problems"] == ["due date must not be in the past"]
    other = dict(task, code={"coding": [{"system": TASK, "code": "lab_order"}]}, identifier=[{"system": "urn:medapp:submission", "value": "task-0003"}])
    status, out = call(worklist, "write.fhir.task.create", WARD_TEAM, wl_req("p_new_task", dict(cfg, task=other), context={"patient_id": "pat-kms-0002"}))
    assert status == 422 and out["problems"] == [f"code {TASK}|lab_order is not one this form may record ({TASK}|falls_screen, {TASK}|physio_referral)"]


def test_a_worklist_is_a_cohort_read_an_individual_scope_cannot_make(writable, audit):
    narrow = worklist_manifest()
    narrow["data_scopes"]["scope_ward_team"]["patient_scope"] = "individual"
    d = handler.Dispatcher(FakeTable([rm.version_item(narrow, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d, "data.task.worklist", WARD_TEAM, wl_req("p_worklist", {"statuses": ["requested"]}))
    assert status == 403 and out["requirement"] == "patient_scope: cohort"


def test_write_validators_agree_with_the_frontend_on_the_shared_cases():
    """med_app/src/primitives/data/writeCases.json is asserted here and in writes.test.ts: same input, same words."""
    from writes import validate_observation_entry, validate_status_change  # noqa: PLC0415

    cases = json.loads((ROOT.parent / "med_app" / "src" / "primitives" / "data" / "writeCases.json").read_text(encoding="utf-8"))
    now = datetime.fromisoformat(cases["now"].replace("Z", "+00:00"))
    for case in cases["observation_cases"]:
        rules = cases[case["rules"]]
        assert validate_observation_entry(rules, case["payload"], cases["patient"], now) == case["expected"], case["name"]
    for case in cases["status_cases"]:
        got = validate_status_change(case["rules"], case["change"], case["current"], case["resourceType"], case["statusField"], cases["patient"])
        assert got == case["expected"], case["name"]
    # The coded entries: a problem, an allergy, a procedure — the same shape of case.
    from writes import validate_allergy_entry, validate_condition_entry, validate_media_entry, validate_procedure_entry, validate_task_entry  # noqa: PLC0415

    for key, validator in (("condition_cases", validate_condition_entry), ("allergy_cases", validate_allergy_entry), ("procedure_cases", validate_procedure_entry), ("task_cases", validate_task_entry), ("media_cases", validate_media_entry)):
        for case in cases[key]:
            assert validator(cases[case["rules"]], case["payload"], cases["patient"], now) == case["expected"], f"{key}: {case['name']}"
    # Declared-shape records: the same cases through record_shape.py.
    from record_shape import validate_record_entry  # noqa: PLC0415

    for case in cases["record_cases"]:
        assert validate_record_entry(cases[case["rules"]], case["payload"], cases["patient"], now) == case["expected"], f"record_cases: {case['name']}"


# ── Photo documentation: Media create, the media store, the gallery read ─────────────────────────────────────────────

PHOTO = "urn:medapp:photo"
WOUND_NURSE = "[app-app_wound_photos-wound_nurse]"
PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="  # the smallest PNG: 70 bytes


def photos_manifest():
    """What the compiler emits for specs/composed-wound-photos.yaml, declared by hand like the others."""
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_wound_photos", "version": "0.1.0", "name": "Wound documentation", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-11T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "wound_nurse", "display_name": "Wound care nurse", "cognito_group": "app-app_wound_photos-wound_nurse", "data_scope_ref": "scope_wound_nurse", "ui_capabilities": ["view"]}], "default_role": "wound_nurse"},
        "data_scopes": {
            "scope_wound_nurse": {
                "patient_scope": "individual",
                "phi_fields_visible": ["name", "dob", "mrn"],
                "fhir": [
                    {"resource": "Patient", "operations": ["read"]},
                    {"resource": "Media", "operations": ["search", "create"], "filter": "subject={context.patient_id}"},
                    {"resource": "Provenance", "operations": ["create"]},
                ],
            }
        },
        "primitives": [
            {"id": "p_patient", "kind": "data.fhir.patient.read", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id"}, "output_binding": "patient"},
            {"id": "p_photos", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "Media", "params": {"patient": "$context.patient_id", "type": "photo", "code": f"{PHOTO}|wound,{PHOTO}|pressure_ulcer"}}, "output_binding": "photos"},
            {"id": "p_new_photo", "kind": "write.fhir.media.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "kinds": [f"{PHOTO}|wound", f"{PHOTO}|pressure_ulcer", f"{PHOTO}|skin_finding"], "body_site": True, "max_bytes": 1_500_000, "max_backdate_days": 7, "media": "$ui.new_photo_entry"}, "output_binding": "new_photo_recorded"},
        ],
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Wound documentation"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": True, "source": ["smart_launch"]}],
        "actions": [{"id": "record_new_photo", "label": "Save photo", "primitive": "p_new_photo", "on_success": "reload"}],
        "audit": {"clinical_context": "ward", "intended_users": ["nurse"], "intended_purpose": "test", "mdr_classification": "none", "data_categories": ["phi", "photos"]},
    }


@pytest.fixture
def media_store():
    from media_store import MemoryMediaStore  # noqa: PLC0415

    return MemoryMediaStore()


@pytest.fixture
def photos(writable, audit, media_store):
    item = rm.version_item(photos_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append, media=media_store, hospital_id="hsp-test")


def photo_req(primitive_id, config, patient="pat-kms-0001", raw=False, manifest=None):
    ctx = {"patient_id": patient}
    manifest = manifest or photos_manifest()
    return {"app_id": "app_wound_photos", "manifest_version": manifest["metadata"]["version"], "primitive_id": primitive_id, "role": "wound_nurse", "config": config if raw else as_the_panel_sends(manifest, primitive_id, config, ctx), "context": ctx}


def photos_variant(version, primitive_id, **config):
    m = declaring(photos_manifest(), primitive_id, **config)
    m["metadata"]["version"] = version
    return m


def photo_cfg(**overrides):
    media = {
        "resourceType": "Media",
        "identifier": [{"system": "urn:medapp:submission", "value": "photo-0001"}],
        "type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/media-type", "code": "photo"}]},
        "reasonCode": [{"coding": [{"system": PHOTO, "code": "pressure_ulcer", "display": "Pressure ulcer"}], "text": "Pressure ulcer"}],
        "subject": {"reference": "Patient/pat-kms-0001"},
        "bodySite": {"text": "Sacrum"},
        "createdDateTime": "2026-09-10T08:30:00Z",
        "note": [{"text": "Category 2, 3 × 2 cm.", "authorString": "forged", "time": "1999-01-01T00:00:00Z"}],
        "content": {"contentType": "image/png", "data": PNG_1X1, "title": "Pressure ulcer · Sacrum", "url": "https://evil.example/not-this", "size": 999_999},
        # claims the dispatcher must not trust
        "operator": {"reference": "Practitioner/forged"},
        "issued": "1999-01-01T00:00:00Z",
        "meta": {"versionId": "9"},
    }
    media.update(overrides)
    return {"media": media}  # the form's contribution; kinds, body site, size and backdating limits are the manifest's


def test_the_gallery_reads_the_seed_photos_newest_first_narrowed_by_what_they_document(photos, writable, media_store):
    status, out = call(photos, "data.fhir.query", WOUND_NURSE, photo_req("p_photos", {}))
    assert status == 200, out
    assert [m["id"] for m in out["output"]] == ["media-kms-0002", "media-kms-0001"]  # day 14 before day 0
    assert all(m["content"]["data"] and "url" not in m["content"] for m in out["output"])  # the seed carries its bytes inline; nothing to present
    # A gallery declared for another kind: none on record. One declared without a kind filter: both. Another patient: none.
    skin = photos_variant("0.1.1", "p_photos", params={"patient": "$context.patient_id", "type": "photo", "code": f"{PHOTO}|skin_finding"})
    every = photos_variant("0.1.2", "p_photos", params={"patient": "$context.patient_id", "type": "photo"})
    d = published(writable, photos_manifest(), skin, every, now=NOW, emit_audit=lambda r: None, media=media_store, hospital_id="hsp-test")
    status, out = call(d, "data.fhir.query", WOUND_NURSE, photo_req("p_photos", {}, manifest=skin))
    assert status == 200 and out["output"] == []
    status, out = call(d, "data.fhir.query", WOUND_NURSE, photo_req("p_photos", {}, manifest=every))
    assert status == 200 and len(out["output"]) == 2
    status, out = call(photos, "data.fhir.query", WOUND_NURSE, photo_req("p_photos", {}, patient="pat-kms-0002"))
    assert status == 200 and out["output"] == []
    # The patient the gallery reads is the one in context; a request naming another one is refused, and the attempt recorded.
    tampered = photo_req("p_photos", {}, patient="pat-kms-0001")
    tampered["config"]["params"]["patient"] = "pat-kms-0002"
    status, out = call(photos, "data.fhir.query", WOUND_NURSE, tampered)
    assert status == 400 and "params.patient" in out["message"]


def test_recording_a_photo_keeps_the_bytes_in_the_store_and_a_media_with_a_storage_url_in_the_record(photos, writable, audit, media_store):
    status, out = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg()))
    assert status == 200, out
    shown = out["output"]
    assert shown["id"] == "media-created-0001" and shown["status"] == "completed" and shown["type"]["coding"][0]["code"] == "photo"
    assert shown["reasonCode"][0]["coding"][0]["code"] == "pressure_ulcer" and shown["bodySite"] == {"text": "Sacrum"}
    assert shown["subject"] == {"reference": "Patient/pat-kms-0001"} and shown["createdDateTime"] == "2026-09-10T08:30:00Z" and shown["issued"] == "2026-09-11T12:00:00Z"
    assert shown["operator"]["identifier"]["value"] == "user-1" and shown["meta"]["source"].startswith("urn:medapp:app_wound_photos@")
    assert shown["note"] == [{"text": "Category 2, 3 × 2 cm.", "authorString": "user-1", "time": "2026-09-11T12:00:00Z"}]  # attributed by the dispatcher, not the client
    # What the panel gets: a URL it can load (the memory store presents a data URL), the true size and hash, no inline bytes.
    assert shown["content"]["url"] == f"data:image/png;base64,{PNG_1X1}" and "data" not in shown["content"]
    sha1 = base64.b64encode(hashlib.sha1(base64.b64decode(PNG_1X1)).digest()).decode("ascii")  # FHIR Attachment.hash
    assert shown["content"]["size"] == 70 and shown["content"]["hash"] == sha1 and shown["content"]["title"] == "Pressure ulcer · Sacrum"
    # What the record keeps: the storage URL — the client's URL and size claims are gone — and the bytes are in the store under hospital/patient/submission.
    kept = writable.read("Media", "media-created-0001")
    assert kept["content"]["url"] == "medapp-media://hsp-test/pat-kms-0001/photo-0001.png" and "data" not in kept["content"]
    assert list(media_store.objects) == ["hsp-test/pat-kms-0001/photo-0001.png"] and media_store.objects["hsp-test/pat-kms-0001/photo-0001.png"][1] == "image/png"
    p = writable.search("Provenance", {})
    assert len(p) == 1 and p[0]["target"] == [{"reference": "Media/media-created-0001"}]
    assert audit[-1]["resource_ref"] == "Media/media-created-0001" and audit[-1]["provenance"] == "recorded"
    # The gallery shows it first, presented the same way; a retry with the same submission is the same Media.
    status, out = call(photos, "data.fhir.query", WOUND_NURSE, photo_req("p_photos", {"resource": "Media", "params": {"patient": "pat-kms-0001", "type": "photo"}}))
    assert status == 200 and [m["id"] for m in out["output"]] == ["media-created-0001", "media-kms-0002", "media-kms-0001"]
    assert out["output"][0]["content"]["url"].startswith("data:image/png;base64,")
    status, again = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg()))
    assert status == 200 and again["output"]["id"] == "media-created-0001" and len(writable.search("Media", {"patient": "pat-kms-0001"})) == 3


def test_a_photo_is_refused_when_it_is_not_an_image_too_large_too_old_or_of_another_kind(photos, writable, media_store):
    cfg = photo_cfg(content={"contentType": "text/plain", "data": "bm90IGEgcGljdHVyZQ=="})
    status, out = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", cfg))
    assert status == 422 and out["problems"] == ["content type 'text/plain' is not one of image/jpeg, image/png, image/webp"]
    thumbnails_only = photos_variant("0.1.1", "p_new_photo", max_bytes=50)
    d = published(writable, photos_manifest(), thumbnails_only, now=NOW, emit_audit=lambda r: None, media=media_store, hospital_id="hsp-test")
    status, out = call(d, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg(), manifest=thumbnails_only))
    assert status == 422 and out["problems"] == ["the image is 0 KB; the form accepts up to 0 KB"]
    # … and that app's client cannot raise the limit from its side.
    raised = photo_req("p_new_photo", photo_cfg(), manifest=thumbnails_only)
    raised["config"]["max_bytes"] = 1_500_000
    status, out = call(d, "write.fhir.media.create", WOUND_NURSE, raised)
    assert status == 400 and "max_bytes" in out["message"]
    status, out = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg(createdDateTime="2026-08-20T08:30:00Z")))
    assert status == 422 and out["problems"] == ["taken date must not be more than 7 days ago"]
    status, out = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg(reasonCode=[{"coding": [{"system": PHOTO, "code": "rash"}]}])))
    assert status == 422 and out["problems"] == [f"code {PHOTO}|rash is not one this form may record ({PHOTO}|wound, {PHOTO}|pressure_ulcer, {PHOTO}|skin_finding)"]
    status, out = call(photos, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg(subject={"reference": "Patient/pat-kms-0002"})))
    assert status == 422 and out["problems"] == ["photo subject Patient/pat-kms-0002 is not the patient in context"]
    assert media_store.objects == {} and writable.search("Provenance", {}) == []  # nothing stored, nothing attested


def test_without_a_media_store_a_photo_cannot_be_saved_and_the_record_is_untouched(writable, audit):
    item = rm.version_item(photos_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append, media=None, hospital_id="hsp-test")
    status, out = call(d, "write.fhir.media.create", WOUND_NURSE, photo_req("p_new_photo", photo_cfg()))
    assert status == 404 and out["message"] == "This deployment has no media store; photos cannot be saved here."
    assert writable.search("Media", {"patient": "pat-kms-0001"}) and len(writable.search("Media", {"patient": "pat-kms-0001"})) == 2
    assert audit[-1]["outcome"] == "error"


def test_the_media_store_comes_from_the_environment_and_presents_only_its_own_urls():
    from media_store import MemoryMediaStore, S3MediaStore, media_store_from_env, present_media  # noqa: PLC0415

    assert isinstance(media_store_from_env({}), MemoryMediaStore)
    memory = MemoryMediaStore()
    url = memory.put("hsp/pat/tok.png", b"\x89PNG", "image/png")
    assert url == "medapp-media://hsp/pat/tok.png" and memory.present(url) == "data:image/png;base64,iVBORw=="
    assert memory.present("medapp-media://hsp/pat/other.png") is None and memory.present("https://elsewhere.example/x.png") is None
    # A resource with inline data or a foreign URL passes through; a storage URL nobody can present stays as it is.
    inline = {"resourceType": "Media", "content": {"contentType": "image/png", "data": PNG_1X1}}
    assert present_media(memory, inline) is inline
    orphan = {"resourceType": "Media", "content": {"url": "medapp-media://hsp/pat/gone.png"}}
    assert present_media(memory, orphan) == orphan and present_media(None, orphan) == orphan

    class FakeS3:
        def __init__(self):
            self.calls = []

        def put_object(self, **kw):
            self.calls.append(("put", kw))

        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            self.calls.append(("sign", op, Params, ExpiresIn))
            return f"https://bucket.s3.eu-central-1.amazonaws.com/{Params['Key']}?X-Amz-Signature=abc"

    pytest.importorskip("boto3")
    s3 = S3MediaStore("medapp-media", client=FakeS3())
    assert s3.put("hsp/pat/tok.jpg", b"\xff\xd8", "image/jpeg") == "medapp-media://hsp/pat/tok.jpg"
    assert s3.client.calls[0] == ("put", {"Bucket": "medapp-media", "Key": "hsp/pat/tok.jpg", "Body": b"\xff\xd8", "ContentType": "image/jpeg", "CacheControl": "private, max-age=0, no-store"})
    presented = present_media(s3, {"resourceType": "Media", "content": {"contentType": "image/jpeg", "url": "medapp-media://hsp/pat/tok.jpg", "size": 2}})
    assert presented["content"]["url"].startswith("https://bucket.s3.eu-central-1.amazonaws.com/hsp/pat/tok.jpg?") and presented["content"]["size"] == 2
    assert s3.client.calls[1] == ("sign", "get_object", {"Bucket": "medapp-media", "Key": "hsp/pat/tok.jpg"}, 900)


# ── Declared-shape records: write.fhir.record.create ──────────────────────────────────────────────────────────────────

PHYSIO = "https://hsp-musterstadt.medapp.eu/CodeSystem/physio"
THERAPIST = "[app-app_therapy_plan-physiotherapist]"


def therapy_plan_manifest():
    """What the compiler emits for specs/composed-therapy-plan.yaml's goal form, declared by hand like the others."""
    fields = [
        {"id": "goal", "label": "Goal", "type": "text", "path": "description", "as": "concept_text", "required": True, "max_length": 200},
        {"id": "measure", "label": "Measured by", "type": "code", "path": "target[0].measure", "as": "codeable_concept", "required": True, "codes": [{"system": PHYSIO, "code": "tug", "display": "Timed up-and-go"}, {"system": PHYSIO, "code": "walking_distance", "display": "Walking distance"}]},
        {"id": "target", "label": "Target value", "type": "number", "path": "target[0].detailQuantity", "as": "quantity", "unit": "s", "range": {"min": 0, "max": 600}},
        {"id": "due", "label": "Due", "type": "date", "path": "target[0].dueDate", "as": "date", "future_days": 365},
        {"id": "note", "label": "Remark", "type": "long_text", "path": "note[0].text", "as": "string", "max_length": 2000},
    ]
    stamps = [{"path": "lifecycleStatus", "value": "active"}, {"path": "subject", "value": "$patient"}, {"path": "expressedBy", "value": "$author"}, {"path": "statusDate", "value": "$today"}]
    return {
        "apiVersion": "medapp.eu/v1",
        "kind": "AppManifest",
        "metadata": {"app_id": "app_therapy_plan", "version": "0.1.0", "name": "Therapy plan", "intent_class": "workflow", "hospital_id": "hsp-test", "created_at": "2026-09-11T00:00:00Z"},
        "lifecycle": {"state": "published", "signoff": None, "provenance": {"generated_by_pipeline_version": "0.1.0"}},
        "auth": {"roles": [{"id": "physiotherapist", "display_name": "Physiotherapist", "cognito_group": "app-app_therapy_plan-physiotherapist", "data_scope_ref": "scope_physiotherapist", "ui_capabilities": ["view"]}], "default_role": "physiotherapist"},
        "data_scopes": {
            "scope_physiotherapist": {
                "patient_scope": "individual",
                "phi_fields_visible": ["name", "dob"],
                "fhir": [
                    {"resource": "Patient", "operations": ["read"]},
                    {"resource": "Goal", "operations": ["search", "create"], "filter": "subject={context.patient_id}"},
                    {"resource": "Provenance", "operations": ["create"]},
                ],
            }
        },
        "primitives": [
            {"id": "p_patient", "kind": "data.fhir.patient.read", "catalog_version": "1.0.0", "config": {"patient": "$context.patient_id"}, "output_binding": "patient"},
            {"id": "p_goals", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "Goal", "params": {"patient": "$context.patient_id"}}, "output_binding": "goals"},
            {"id": "p_new_goal", "kind": "write.fhir.record.create", "catalog_version": "1.0.0", "config": {"subject": "$context.patient_id", "resource": "Goal", "fields": fields, "stamps": stamps, "record": "$ui.new_goal_entry"}, "output_binding": "new_goal_recorded"},
        ],
        "layout": {"design_system_version": "1.0.0", "root": {"component": "PageShell", "props": {"title": "Therapy plan"}}},
        "context_inputs": [{"name": "patient_id", "type": "fhir.reference", "required": True, "source": ["smart_launch"]}],
        "actions": [{"id": "record_new_goal", "label": "Save goal", "primitive": "p_new_goal", "on_success": "reload"}],
        "audit": {"clinical_context": "physiotherapy", "intended_users": ["physiotherapist"], "intended_purpose": "test", "mdr_classification": "none", "data_categories": ["phi", "care_plans"]},
    }


@pytest.fixture
def therapy(writable, audit):
    item = rm.version_item(therapy_plan_manifest(), created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    return handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)


def goal_req(primitive_id, config, patient="pat-kms-0001", raw=False, manifest=None):
    ctx = {"patient_id": patient}
    manifest = manifest or therapy_plan_manifest()
    return {"app_id": "app_therapy_plan", "manifest_version": manifest["metadata"]["version"], "primitive_id": primitive_id, "role": "physiotherapist", "config": config if raw else as_the_panel_sends(manifest, primitive_id, config, ctx), "context": ctx}


def goal_cfg(**overrides):
    m = therapy_plan_manifest()
    write = next(p for p in m["primitives"] if p["id"] == "p_new_goal")["config"]
    record = {
        "resourceType": "Goal",
        "identifier": [{"system": "urn:medapp:submission", "value": "goal-0001"}],
        "description": {"text": "Climb a flight of stairs without the rail"},
        "target": [{"measure": {"coding": [{"system": PHYSIO, "code": "walking_distance", "display": "Walking distance"}], "text": "Walking distance"}, "detailQuantity": {"value": 150, "unit": "s"}, "dueDate": "2026-12-01"}],
        "note": [{"text": "Twice a week."}],
        # claims the dispatcher overwrites: the stamps are the platform's
        "lifecycleStatus": "completed",
        "expressedBy": {"reference": "Practitioner/forged"},
        "statusDate": "1999-01-01",
        "meta": {"versionId": "9"},
    }
    record.update(overrides)
    return {**write, "subject": "pat-kms-0001", "record": record}


def test_the_seed_carries_a_goal_and_a_care_plan_the_list_reads(therapy):
    status, out = call(therapy, "data.fhir.query", THERAPIST, goal_req("p_goals", {"resource": "Goal", "params": {"patient": "pat-kms-0001"}}))
    assert status == 200 and [g["id"] for g in out["output"]] == ["goal-kms-0001"]
    assert out["output"][0]["target"][0]["detailQuantity"] == {"value": 12, "unit": "s"}


def test_a_declared_shape_record_is_validated_stamped_and_created_with_a_provenance(therapy, writable, audit):
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg()))
    assert status == 200, out
    stored = out["output"]
    assert stored["id"] == "goal-created-0001" and stored["resourceType"] == "Goal"
    # The fields as sent …
    assert stored["description"] == {"text": "Climb a flight of stairs without the rail"} and stored["target"][0]["detailQuantity"] == {"value": 150, "unit": "s"} and stored["target"][0]["dueDate"] == "2026-12-01"
    assert stored["note"] == [{"text": "Twice a week."}]
    # … the stamps as the platform sets them, whatever the client claimed …
    assert stored["lifecycleStatus"] == "active" and stored["subject"] == {"reference": "Patient/pat-kms-0001"} and stored["statusDate"] == "2026-09-11"
    assert stored["expressedBy"]["identifier"] == {"system": "urn:medapp:cognito-sub", "value": "user-1"}
    assert stored["meta"]["source"].startswith("urn:medapp:app_therapy_plan@") and stored["meta"]["versionId"] == "1"
    # … and the Provenance and audit record of every write.
    p = writable.search("Provenance", {})
    assert len(p) == 1 and p[0]["target"] == [{"reference": "Goal/goal-created-0001"}]
    assert audit[-1]["resource_ref"] == "Goal/goal-created-0001" and audit[-1]["provenance"] == "recorded"
    # The list shows it; a retry with the same submission is the same Goal.
    status, out = call(therapy, "data.fhir.query", THERAPIST, goal_req("p_goals", {"resource": "Goal", "params": {"patient": "pat-kms-0001"}}))
    assert status == 200 and sorted(g["id"] for g in out["output"]) == ["goal-created-0001", "goal-kms-0001"]
    status, again = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg()))
    assert status == 200 and again["output"]["id"] == "goal-created-0001" and len(writable.search("Goal", {"patient": "pat-kms-0001"})) == 2


def test_a_record_written_with_a_library_shape_carries_the_shape_and_its_version_as_a_tag(therapy, writable):
    """The manifest's config names the shape it embedded (id, checksum, version, the tag coding); the stored record says so on itself — searchable with _tag — while an inline shape leaves no tag."""
    tag = {"system": "https://hsp-musterstadt.medapp.eu/CodeSystem/record-shape", "code": "measurable_goal", "version": "0.2.0", "display": "Measurable goal"}
    from_library = declaring(therapy_plan_manifest(), "p_new_goal", shape={"id": "measurable_goal", "checksum": "fnv1a64:e723201707d15f3a", "version": "0.2.0", "tag": tag})
    from_library["metadata"]["version"] = "0.1.1"
    d = published(writable, therapy_plan_manifest(), from_library, now=NOW, emit_audit=lambda r: None)
    status, out = call(d, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg(), manifest=from_library))
    assert status == 200, out
    assert out["output"]["meta"]["tag"] == [tag] and out["output"]["meta"]["source"].startswith("urn:medapp:app_therapy_plan@")
    # A client cannot tag a record with a shape its app did not embed: the key is not declared, so it is dropped — the record is written untagged.
    claimed = goal_req("p_new_goal", goal_cfg(identifier=[{"system": "urn:medapp:submission", "value": "goal-0003"}]))
    claimed["config"]["shape"] = {"id": "measurable_goal", "checksum": "fnv1a64:0000", "version": "9.9.9", "tag": tag}
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, claimed)
    assert status == 200 and "tag" not in out["output"]["meta"]
    inline = goal_cfg()
    inline["record"]["identifier"] = [{"system": "urn:medapp:submission", "value": "goal-0002"}]
    status, plain = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", inline))
    assert status == 200 and "tag" not in plain["output"]["meta"]


def test_a_consent_decision_is_a_record_the_engine_admits(therapy, writable, audit):
    """Consent, the fifth kind: the shape's fields land on scope, category, provision.type, provision.purpose; the platform stamps status, patient and the moment — and never an author (Consent.performer is who consents); the list reads it back by its dateTime."""
    scope_sys = "http://terminology.hl7.org/CodeSystem/consentscope"
    reason = "http://terminology.hl7.org/CodeSystem/v3-ActReason"
    cfg = {
        "subject": "pat-kms-0001",
        "resource": "Consent",
        "fields": [
            {"id": "scope", "label": "Kind of consent", "type": "choice", "path": "scope", "as": "codeable_concept", "required": True, "options": [{"code": "treatment", "display": "Treatment"}, {"code": "research", "display": "Research"}], "system": scope_sys},
            {"id": "category", "label": "Document type", "type": "code", "path": "category[0]", "as": "codeable_concept", "required": True, "codes": [{"system": "http://loinc.org", "code": "59284-0", "display": "Patient Consent"}]},
            {"id": "decision", "label": "Decision", "type": "choice", "path": "provision.type", "as": "code", "required": True, "options": [{"code": "permit", "display": "Permitted"}, {"code": "deny", "display": "Denied"}]},
            {"id": "purpose", "label": "Purpose", "type": "code", "path": "provision.purpose[0]", "as": "coding", "required": True, "codes": [{"system": reason, "code": "HRESCH", "display": "Healthcare research"}]},
        ],
        "stamps": [{"path": "status", "value": "active"}, {"path": "patient", "value": "$patient"}, {"path": "dateTime", "value": "$now"}],
        "record": {
            "resourceType": "Consent",
            "identifier": [{"system": "urn:medapp:submission", "value": "consent-0001"}],
            "scope": {"coding": [{"system": scope_sys, "code": "research", "display": "Research"}], "text": "Research"},
            "category": [{"coding": [{"system": "http://loinc.org", "code": "59284-0", "display": "Patient Consent"}], "text": "Patient Consent"}],
            "provision": {"type": "deny", "purpose": [{"system": reason, "code": "HRESCH", "display": "Healthcare research"}]},
            "status": "draft",  # overwritten by the stamp
        },
    }
    m = therapy_plan_manifest()
    m["primitives"].append({"id": "p_new_consent", "kind": "write.fhir.record.create", "catalog_version": "1.0.0", "config": {k: v for k, v in cfg.items() if k != "record"} | {"subject": "$context.patient_id", "record": "$ui.new_consent_entry"}, "output_binding": "new_consent_recorded"})
    m["primitives"].append({"id": "p_consents", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "Consent", "params": {"patient": "$context.patient_id"}}, "output_binding": "consents"})
    # The therapy-plan app's physiotherapist scope grants Goal and DocumentReference creates — not Consent: a consent form in
    # an app whose scope was not widened is refused by type first …
    narrow = rm.version_item(m, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    status, out = call(handler.Dispatcher(FakeTable([*version_items(), narrow]), writable, now=NOW, emit_audit=audit.append), "write.fhir.record.create", THERAPIST, goal_req("p_new_consent", cfg, manifest=m))
    assert status == 403 and "Consent.create" in json.dumps(out)
    # … so the test widens the scope (as a compiled app with a consent form would carry it) and writes.
    m["data_scopes"]["scope_physiotherapist"]["fhir"].append({"resource": "Consent", "operations": ["create", "read", "search"], "filter": {"patient": "$context.patient_id"}})
    item = rm.version_item(m, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    consent_app = handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(consent_app, "write.fhir.record.create", THERAPIST, goal_req("p_new_consent", cfg, manifest=m))
    assert status == 200, out
    stored = out["output"]
    assert stored["resourceType"] == "Consent" and stored["status"] == "active" and stored["patient"] == {"reference": "Patient/pat-kms-0001"} and stored["dateTime"] == "2026-09-11T12:00:00Z"
    assert stored["provision"] == {"type": "deny", "purpose": [{"system": reason, "code": "HRESCH", "display": "Healthcare research"}]} and stored["scope"]["coding"][0]["code"] == "research"
    assert "performer" not in stored, "nobody is stamped as the one consenting; the Provenance names who recorded it"
    assert writable.search("Provenance", {})[-1]["target"] == [{"reference": f"Consent/{stored['id']}"}]
    status, listed = call(consent_app, "data.fhir.query", THERAPIST, goal_req("p_consents", {}, manifest=m))
    assert status == 200 and sorted(c["id"] for c in listed["output"]) == sorted(["consent-kms-0001", "consent-kms-0002", stored["id"]]), "the seed's two decisions and the new one, read back"
    assert listed["output"][0]["id"] == stored["id"], "newest first — by dateTime"


def test_a_kind_the_platform_has_not_admitted_is_written_with_the_shapes_own_stamps(therapy, writable, audit):
    """An administrator-defined kind (a Flag): the manifest carries the shape's declared stamps and the dispatcher applies them exactly like the platform's — status, patient, author, since when — refuses what the fields do not declare, and the generic query reads it back by meta.lastUpdated."""
    alerts = "https://hsp-musterstadt.medapp.eu/CodeSystem/alerts"
    cfg = {
        "subject": "pat-kms-0001",
        "resource": "Flag",
        "fields": [{"id": "alert", "label": "Alert", "type": "choice", "path": "code", "as": "codeable_concept", "required": True, "options": [{"code": "falls_risk", "display": "Falls risk"}, {"code": "isolation_precautions", "display": "Isolation precautions"}], "system": alerts}, {"id": "until", "label": "Review by", "type": "date", "path": "period.end", "as": "datetime", "future_days": 365}],
        "stamps": [{"path": "status", "value": "active"}, {"path": "subject", "value": "$patient"}, {"path": "author", "value": "$author"}, {"path": "period.start", "value": "$today"}],
        "shape": {"id": "patient_alert", "checksum": "fnv1a64:0000", "version": "0.1.0", "open_kind": True, "tag": {"system": "https://hsp-musterstadt.medapp.eu/CodeSystem/record-shape", "code": "patient_alert", "version": "0.1.0", "display": "Patient alert"}},
        "record": {"resourceType": "Flag", "identifier": [{"system": "urn:medapp:submission", "value": "flag-0001"}], "code": {"coding": [{"system": alerts, "code": "falls_risk", "display": "Falls risk"}], "text": "Falls risk"}, "period": {"end": "2027-03-01"}, "status": "inactive"},
    }
    m = therapy_plan_manifest()
    m["data_scopes"]["scope_physiotherapist"]["fhir"].append({"resource": "Flag", "operations": ["create", "read", "search"], "filter": {"patient": "$context.patient_id"}})
    m["primitives"].append({"id": "p_new_alert", "kind": "write.fhir.record.create", "catalog_version": "1.0.0", "config": {k: v for k, v in cfg.items() if k != "record"} | {"subject": "$context.patient_id", "record": "$ui.new_alert_entry"}, "output_binding": "new_alert_recorded"})
    m["primitives"].append({"id": "p_alerts", "kind": "data.fhir.query", "catalog_version": "1.0.0", "config": {"resource": "Flag", "params": {"patient": "$context.patient_id"}}, "output_binding": "alerts"})
    item = rm.version_item(m, created_by_sub="seed", now="2026-09-11T00:00:00Z", state="published")
    d = handler.Dispatcher(FakeTable([*version_items(), item]), writable, now=NOW, emit_audit=audit.append)
    status, out = call(d, "write.fhir.record.create", THERAPIST, goal_req("p_new_alert", cfg))
    assert status == 200, out
    stored = out["output"]
    assert stored["resourceType"] == "Flag" and stored["status"] == "active" and stored["subject"] == {"reference": "Patient/pat-kms-0001"} and stored["period"] == {"start": "2026-09-11", "end": "2027-03-01"}
    assert stored["author"]["identifier"] == {"system": "urn:medapp:cognito-sub", "value": "user-1"} and stored["code"]["coding"][0]["code"] == "falls_risk"
    assert stored["meta"]["tag"][0]["code"] == "patient_alert"
    # Outside the declared fields: refused by name, whatever kind it is.
    stray = goal_req("p_new_alert", {**cfg, "record": {**cfg["record"], "identifier": [{"system": "urn:medapp:submission", "value": "flag-0002"}], "encounter": {"reference": "Encounter/x"}}})
    status, out = call(d, "write.fhir.record.create", THERAPIST, stray)
    assert status == 422 and out["problems"] == ["element encounter.reference is not part of this form"]
    status, listed = call(d, "data.fhir.query", THERAPIST, goal_req("p_alerts", {"resource": "Flag", "params": {"patient": "pat-kms-0001"}}))
    assert status == 200 and [f["id"] for f in listed["output"]] == [stored["id"]]


def test_the_kinds_of_record_come_from_the_panels_rule_not_a_list_here():
    """The dispatcher reads data/record-kinds.json, written by the panel's `npm run export:kinds` from the rule in
    med_app/src/fhir/kinds.ts: every patient-scoped R4 type the platform neither admits nor refuses is open to
    administrators' shapes and therefore queryable. No kind is named in Python; the frontend test fails when the file lags."""
    from primitives import ADMITTED_KINDS, OPEN_KINDS, QUERY_RESOURCES, RECORD_KINDS

    assert ADMITTED_KINDS == ("Goal", "CarePlan", "Encounter", "DocumentReference", "Consent")
    assert {"Flag", "FamilyMemberHistory", "ClinicalImpression", "Immunization", "DocumentManifest", "MolecularSequence"} <= set(OPEN_KINDS)
    assert set(OPEN_KINDS) <= set(QUERY_RESOURCES) and set(ADMITTED_KINDS) <= set(QUERY_RESOURCES)
    assert not set(OPEN_KINDS) & set(RECORD_KINDS["closed"]) and not set(OPEN_KINDS) & set(ADMITTED_KINDS)
    assert RECORD_KINDS["closed"]["MedicationRequest"].startswith("prescribing is an order")
    assert "Appointment" not in QUERY_RESOURCES and "Patient" not in QUERY_RESOURCES
    assert len(QUERY_RESOURCES) == len(set(QUERY_RESOURCES))

def test_a_record_outside_its_declared_shape_is_refused_with_the_reasons(therapy, writable):
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg(description=None)))
    assert status == 422 and out["problems"] == ['"Goal" is required']
    bad = goal_cfg()
    bad["record"]["target"][0]["detailQuantity"] = {"value": 900, "unit": "s"}
    bad["record"]["target"][0]["dueDate"] = "2030-01-01"
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", bad))
    assert status == 422 and out["problems"] == ['"Target value": 900 s is outside the accepted range 0–600', '"Due" must not be more than 365 days ahead']
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg(outcomeCode=[{"text": "achieved"}], addresses=[{"reference": "Condition/x"}])))
    assert status == 422 and sorted(out["problems"]) == ["element addresses[0].reference is not part of this form", "element outcomeCode[0].text is not part of this form"]
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", goal_cfg(subject={"reference": "Patient/pat-kms-0002"})))
    assert status == 422 and out["problems"] == ["subject Patient/pat-kms-0002 is not the patient in context"]
    assert writable.search("Provenance", {}) == [] and len(writable.search("Goal", {"patient": "pat-kms-0001"})) == 1


def test_a_record_needs_the_scope_of_its_own_resource_type(therapy, writable, audit):
    # The scope grants Goal.create; a primitive declared for another type is refused by scope, not written.
    care_plans = declaring(therapy_plan_manifest(), "p_new_goal", resource="CarePlan")
    care_plans["metadata"]["version"] = "0.1.1"
    d = published(writable, therapy_plan_manifest(), care_plans, now=NOW, emit_audit=audit.append)
    cfg = goal_cfg()
    cfg["record"]["resourceType"] = "CarePlan"
    status, out = call(d, "write.fhir.record.create", THERAPIST, goal_req("p_new_goal", cfg, manifest=care_plans))
    assert status == 403 and out["requirement"] == "CarePlan.create"
    # A client of the Goal app that names another type in its config is refused before the scope is even asked.
    tampered = goal_req("p_new_goal", cfg)
    tampered["config"]["resource"] = "CarePlan"
    status, out = call(therapy, "write.fhir.record.create", THERAPIST, tampered)
    assert status == 400 and "resource" in out["message"] and audit[-1]["outcome"] == "refused" and audit[-1]["config_mismatch"] == ["resource"]
    assert writable.search("Provenance", {}) == []


# ── The published configuration, not the browser's ────────────────────────────────────────────────────────────────────
#
# The panel resolves a primitive's declared config and sends the result; the dispatcher resolves the same declaration
# itself (declared_config.py) and executes *its* result. These tests send what a tampered or broken client would.


def test_an_honest_request_runs_as_declared_and_leaves_a_clean_record(dispatcher, audit):
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", req("app_patient_summary", "p_vitals", "clinician", {}))
    assert status == 200 and len(out["output"]) == 37
    assert "config_mismatch" not in audit[-1] and "config_dropped" not in audit[-1] and audit[-1]["patient_context"] == "pat-kms-0001"
    # The default window is filled server-side as the panel fills it: a request without it runs the same.
    body = req("app_patient_summary", "p_vitals", "clinician", {})
    del body["config"]["since"]
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", body)
    assert status == 200 and len(out["output"]) == 37


def test_a_request_that_widens_the_declared_codes_or_the_window_is_refused_and_recorded(dispatcher, source, audit):
    seen_before = len(getattr(source, "calls", []))
    body = req("app_patient_summary", "p_vitals", "clinician", {})
    body["config"]["codes"] = [*body["config"]["codes"], "http://loinc.org|2160-0"]  # creatinine, which the summary does not show
    body["config"]["count"] = 5000
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", body)
    assert status == 400 and "codes, count" in out["message"] and "executes the published configuration only" in out["message"]
    assert audit[-1]["outcome"] == "refused" and audit[-1]["config_mismatch"] == ["codes", "count"] and audit[-1]["audit_id"] == out["audit_id"]
    assert len(getattr(source, "calls", [])) == seen_before, "nothing was read"
    # A window the manifest did not grant: `since` is `$context.window_start`, whose default the app declares.
    body = req("app_patient_summary", "p_vitals", "clinician", {})
    body["config"]["since"] = "1990-01-01"
    status, out = call(dispatcher, "data.fhir.observation.by_code", "[medapp-viewers]", body)
    assert status == 400 and audit[-1]["config_mismatch"] == ["since"]


def test_the_patient_a_primitive_reads_or_writes_is_the_one_in_context(dispatcher, ward, writable, audit):
    body = req("app_patient_summary", "p_conditions", "clinician", {})
    body["config"]["params"]["patient"] = "pat-kms-0002"
    status, out = call(dispatcher, "data.fhir.query", "[medapp-viewers]", body)
    assert status == 400 and audit[-1]["config_mismatch"] == ["params.patient"] and audit[-1]["patient_context"] == "pat-kms-0001"
    body = ward_req("p_bp_entry", entry_config(bp_entry(subject={"reference": "Patient/pat-kms-0002"})))
    body["config"]["subject"] = "pat-kms-0002"
    status, out = call(ward, "write.fhir.observation.create", WARD, body)
    assert status == 400 and audit[-1]["config_mismatch"] == ["subject"]
    assert writable.search("Provenance", {}) == [] and not [o for o in writable.search("Observation", {"patient": "pat-kms-0002", "combo-code": "8480-6"}) if o["id"].startswith("observation-created")]


def test_a_write_s_rules_cannot_be_loosened_or_left_out_by_the_client(ward, writable, audit):
    # Loosened: refused before validation, on record.
    body = ward_req("p_bp_entry", entry_config(bp_entry(sys=900)))
    body["config"]["ranges"][SYS]["max"] = 1000
    status, out = call(ward, "write.fhir.observation.create", WARD, body)
    assert status == 400 and audit[-1]["config_mismatch"] == [f"ranges.{SYS}.max"]
    body = ward_req("p_bp_entry", entry_config(bp_entry(effectiveDateTime="2026-08-01T09:00:00Z")))
    body["config"]["max_backdate_days"] = 365
    status, out = call(ward, "write.fhir.observation.create", WARD, body)
    assert status == 400 and audit[-1]["config_mismatch"] == ["max_backdate_days"]
    # Left out: the manifest's apply all the same.
    for key in ("ranges", "rules", "codes", "max_backdate_days", "components"):
        body = ward_req("p_bp_entry", entry_config(bp_entry(sys=90, dia=120)))
        del body["config"][key]
        status, out = call(ward, "write.fhir.observation.create", WARD, body)
        assert status == 422 and out["problems"] == ["Systolic must be above diastolic (90 vs 120 mmHg)"], key
    assert writable.search("Provenance", {}) == []


def test_a_launch_context_the_app_did_not_declare_is_refused(dispatcher, audit):
    for context, problem in (
        ({"patient_id": ""}, "context.patient_id is required by this app"),
        ({"patient_id": "Patient/pat-kms-0001"}, "context.patient_id is not a valid fhir.reference"),
        ({"patient_id": "pat-kms-0001", "window_start": "yesterday"}, "context.window_start is not a valid iso8601"),
        ({"patient_id": ["pat-kms-0001"]}, "context.patient_id must be a string"),
    ):
        body = req("app_patient_summary", "p_patient", "clinician", {}, context=context)
        status, out = call(dispatcher, "data.fhir.patient.read", "[medapp-viewers]", body)
        assert status == 400 and out["message"] == f"The launch context does not fit this app: {problem}", context
        assert audit[-1]["outcome"] == "refused"


def test_keys_the_manifest_does_not_declare_are_dropped_and_noted(dispatcher, audit):
    body = req("app_patient_summary", "p_conditions", "clinician", {})
    body["config"]["params"]["_include"] = "Condition:subject"
    body["config"]["count"] = 1
    status, out = call(dispatcher, "data.fhir.query", "[medapp-viewers]", body)
    assert status == 200 and len(out["output"]) == 3, "the declared query ran; `count` never reached it"
    assert audit[-1]["config_dropped"] == ["count"]
