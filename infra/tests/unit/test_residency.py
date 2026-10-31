"""
Data residency at synth: with `data_residency: eu` the deployment region must be an EU member-state region and the
agent's model an `eu.` profile, an in-region model id or an EU application inference profile; `us.` and `global.` are
refused with a message that says where they would run and what to use instead. Without the flag nothing is enforced.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from stacks.residency import EU_REGIONS, ResidencyError, check_model, check_region, enforce, model_region_pattern, policy

ROOT = Path(__file__).resolve().parents[2]


def test_the_eu_policy_admits_eu_regions_and_eu_models_only():
    for region in EU_REGIONS:
        check_region(region, "eu")
    for region in ("us-east-1", "eu-west-2", "eu-central-2", None, ""):
        with pytest.raises(ResidencyError, match="outside the European Union"):
            check_region(region, "eu")  # London and Zurich carry the eu- name and are not in the EU

    check_model("eu.anthropic.claude-sonnet-5-5", "eu")
    check_model("anthropic.claude-sonnet-5-5-20260301-v1:0", "eu")  # plain id: invoked in the deployment's own (EU) region
    check_model("arn:aws:bedrock:eu-central-1:111111111111:application-inference-profile/abc123", "eu")
    with pytest.raises(ResidencyError, match="the us geography.*eu.anthropic.claude-sonnet-5"):
        check_model("us.anthropic.claude-sonnet-5", "eu")
    with pytest.raises(ResidencyError, match="any commercial region"):
        check_model("global.anthropic.claude-sonnet-5-5", "eu")
    with pytest.raises(ResidencyError, match="apac geography"):
        check_model("apac.anthropic.claude-sonnet-5-5", "eu")
    with pytest.raises(ResidencyError, match="inference profile in us-west-2"):
        check_model("arn:aws:bedrock:us-west-2:111111111111:application-inference-profile/abc123", "eu")


def test_without_a_policy_nothing_is_enforced_and_unknown_policies_are_refused():
    enforce("us-east-1", "global.anthropic.claude-sonnet-5-5", None)
    enforce("us-east-1", "us.anthropic.claude-sonnet-5", "")
    assert policy(None) is None and model_region_pattern(None) == "*" and model_region_pattern("eu") == "eu-*"
    assert model_region_pattern("EU") == "eu-*", "case does not matter"
    with pytest.raises(ResidencyError, match="not a known policy"):
        enforce("eu-central-1", "eu.anthropic.claude-sonnet-5-5", "mars")


def test_every_configured_hospital_declares_eu_residency_with_an_eu_model():
    files = sorted((ROOT / "hospitals").glob("*.json"))
    assert files, "infra/hospitals/ holds one file per deployment"
    for file in files:
        hospital = json.loads(file.read_text(encoding="utf-8"))
        assert hospital["data_residency"] == "eu" and hospital["model_id"].startswith("eu."), f"{file.name}: the deployments of this repository are EU-only"
        enforce(hospital.get("region") or "eu-central-1", hospital["model_id"], hospital["data_residency"])


def test_the_app_refuses_to_synthesize_a_us_profile_under_eu_residency(tmp_path):
    # app.py reads a hospital's file before any of its stacks is built, so the refusal is immediate and names the fix.
    hospital = {"hospital_id": "hsp-test", "model_id": "us.anthropic.claude-sonnet-5", "data_residency": "eu", "region": "eu-central-1", "reference_servers": False}
    (tmp_path / "hsp-test.json").write_text(json.dumps(hospital), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "app.py"],
        cwd=ROOT,
        env={**os.environ, "CDK_CONTEXT_JSON": json.dumps({"hospitals_dir": str(tmp_path)}), "CDK_DEFAULT_REGION": "eu-central-1", "CDK_DEFAULT_ACCOUNT": "111111111111"},
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode != 0
    assert re.search(r"data residency: model_id us\.anthropic\.claude-sonnet-5 would run inference in the us geography", proc.stderr), proc.stderr[-800:]
