"""
`declared_config.py` on its own: how a primitive's declared configuration is rebuilt on the server from the published
manifest, what is taken from the request, and how the request's copy is compared. The dispatcher tests exercise it end
to end (test_dispatcher.py, "The published configuration, not the browser's"); these are the resolution rules.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[2] / "lambdas" / "dispatcher"))

from declared_config import CONTEXT_TYPES, ConfigMismatch, resolve_declared, validate_context  # noqa: E402

BP = "http://loinc.org|85354-9"
MANIFEST = {
    "metadata": {"app_id": "app_x", "version": "0.1.0"},
    "context_inputs": [
        {"name": "patient_id", "type": "fhir.reference", "required": True},
        {"name": "window_start", "type": "iso8601", "required": False, "default": "now-2y"},
    ],
}
DECLARED = {
    "patient": "$context.patient_id",
    "codes": [BP, "http://loinc.org|8867-4"],
    "since": "$context.window_start",
    "count": 500,
    "ranges": {BP: {"min": 50, "max": 300}},
    "rules": [{"component": BP, "above": "x", "message": "m"}],
    "observation": "$ui.bp_entry",
    "patients": "$bindings.cohort.patients",
    "source": "$metadata.app_id",
    "components": ["$context.patient_id", {"literal": 1}],
}


def resolve(client, context=None):
    launch = validate_context(MANIFEST, context or {"patient_id": "pat-1"})
    return resolve_declared(DECLARED, client=client, context=launch, metadata=MANIFEST["metadata"], role="viewer", scope={})


def test_the_panel_s_own_resolution_matches_exactly():
    sent = {"patient": "pat-1", "codes": [BP, "http://loinc.org|8867-4"], "since": "now-2y", "count": 500, "ranges": {BP: {"min": 50, "max": 300}}, "rules": [{"component": BP, "above": "x", "message": "m"}], "observation": {"resourceType": "Observation"}, "patients": [{"id": "pat-1"}], "source": "app_x", "components": ["pat-1", {"literal": 1}]}
    r = resolve(sent)
    assert r.mismatches == [] and r.dropped == []
    assert r.config == sent, "literals from the manifest, references resolved, $ui/$bindings from the request"


def test_literals_are_the_manifest_s_and_a_request_that_differs_is_named_by_path():
    r = resolve({"codes": [BP], "count": 5000, "ranges": {BP: {"min": 50, "max": 1000}}, "rules": [], "patient": "pat-2", "since": "1990-01-01", "source": "other"})
    assert r.mismatches == ["patient", "codes", "since", "count", f"ranges.{BP}.max", "rules", "source"]
    # … and what would run is still the declaration, never the request.
    assert r.config["codes"] == [BP, "http://loinc.org|8867-4"] and r.config["count"] == 500 and r.config["patient"] == "pat-1" and r.config["ranges"][BP]["max"] == 300


def test_a_request_that_omits_declared_keys_runs_with_the_manifest_s_values():
    r = resolve({"observation": {"resourceType": "Observation"}})
    assert r.mismatches == [] and r.config["codes"] == DECLARED["codes"] and r.config["ranges"] == DECLARED["ranges"] and r.config["since"] == "now-2y"


def test_ui_and_bindings_are_the_request_s_and_undeclared_keys_are_dropped():
    r = resolve({"observation": {"a": 1}, "patients": ["p"], "extra": 1, "_include": "x"})
    assert r.config["observation"] == {"a": 1} and r.config["patients"] == ["p"]
    assert r.dropped == ["_include", "extra"] and "extra" not in r.config and r.mismatches == []
    # Absent `$ui` input: the key is simply not there (the primitive decides whether it needs it).
    assert "observation" not in resolve({}).config


def test_lists_with_references_resolve_element_wise_and_literal_lists_compare_canonically():
    r = resolve({"components": ["pat-9", {"literal": 1}]})
    assert r.mismatches == ["components[0]"] and r.config["components"] == ["pat-1", {"literal": 1}]
    assert resolve({"codes": ["http://loinc.org|8867-4", BP]}).mismatches == ["codes"], "order is part of a code list"
    assert resolve({"ranges": {BP: {"max": 300, "min": 50}}}).mismatches == [], "key order is not"


def test_the_context_is_validated_against_the_declared_inputs():
    assert validate_context(MANIFEST, {"patient_id": "pat-1"}) == {"patient_id": "pat-1", "window_start": "now-2y"}
    assert validate_context(MANIFEST, {"patient_id": "pat-1", "window_start": "2024-01-01T00:00:00Z", "stray": "x"}) == {"patient_id": "pat-1", "window_start": "2024-01-01T00:00:00Z"}
    for context, problem in (
        ({}, "context.patient_id is required by this app"),
        ({"patient_id": ""}, "context.patient_id is required by this app"),
        ({"patient_id": "Patient/pat-1"}, "context.patient_id is not a valid fhir.reference"),
        ({"patient_id": "pat-1; drop table"}, "context.patient_id is not a valid fhir.reference"),
        ({"patient_id": 7}, "context.patient_id must be a string"),
        ({"patient_id": "pat-1", "window_start": "yesterday"}, "context.window_start is not a valid iso8601"),
    ):
        with pytest.raises(ConfigMismatch) as err:
            validate_context(MANIFEST, context)
        assert err.value.problems == [problem], context
    assert validate_context({"context_inputs": []}, {"anything": "goes"}) == {}, "an app without inputs ignores the context"


def test_the_window_type_admits_dates_date_times_and_relative_windows_only():
    ok = ["2026-09-10", "2026-09-10T08:30", "2026-09-10T08:30:00Z", "2026-09-10T08:30:00.250+02:00", "now", "now-90d", "now-6m", "now-2y"]
    bad = ["", "now-2", "now+2y", "2026-9-1", "yesterday", "2026-09-10T08", "now-99999d"]
    assert all(CONTEXT_TYPES["iso8601"].match(v) for v in ok) and not any(CONTEXT_TYPES["iso8601"].match(v) for v in bad)
