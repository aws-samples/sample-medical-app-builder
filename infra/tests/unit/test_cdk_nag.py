"""
cdk-nag over the whole app, as app.py runs it: every stack of a full deployment (reference servers, hospital servers,
viewer and guardrails included) synthesised with the build steps stubbed, and not one AwsSolutions finding left — each
one the platform accepts is in the register (stacks/nag.py) with its reason. A second case makes sure the register
accepts by shape, not wholesale: a real wildcard in our own code is still an error.
"""

import csv
import importlib.util
import json
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk import aws_iam as iam
from cdk_nag import AwsSolutionsChecks

from stacks.hospitals import HospitalConfig
from stacks.nag import accept_platform_defaults

INFRA = Path(__file__).resolve().parents[2]

# The feature flags of the real synth (cdk.json), so what the rules see here is what `cdk synth` sees — with
# `@aws-cdk/core:enablePartitionLiterals` an ARN reads `arn:aws:…`, not `arn:<AWS::Partition>:…`, and a pattern in the
# register that matched one spelling only would pass this test and fail the deploy.
FEATURE_FLAGS = {k: v for k, v in json.loads((INFRA / "cdk.json").read_text(encoding="utf-8"))["context"].items() if k.startswith("@aws-cdk")}

# A full deployment: every optional stack on.
HOSPITAL = HospitalConfig.from_mapping({
    "hospital_id": "hsp-test",
    "hospital_name": "Test Hospital",
    "model_id": "eu.anthropic.claude-sonnet-4-6",
    "data_residency": "eu",
    "reference_servers": True,
    "hospital_servers": {
        "fhir_base_url": "https://fhir.example.invalid/fhir",
        "dicomweb_base_url": "https://fhir.example.invalid/dicom-web",
        "token_url": "https://auth.example.invalid/oauth2/token",
        "scope": "fhir/read fhir/write",
        "credentials_secret": "medapp/hsp-test/hospital-client",
        "dicom_patient_id": "resource_id",
    },
    "app_registry_guard_admin_email": "ops@example.invalid",
})

STACKS = {"HostingStack", "IdentityStack", "RegistryStack", "AuditStack", "AuthoringStack", "ApiStack", "ViewerStack", "ReferenceServersStack", "HospitalServersStack", "AppRegistryGuardStack"}


def load_app_module():
    """app.py as a module — it is a script, not a package member; `build_app(app, hospitals)` is what we want of it."""
    spec = importlib.util.spec_from_file_location("medapp_cdk_app", INFRA / "app.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def whole_app(staged):
    app = cdk.App(context=FEATURE_FLAGS)
    load_app_module().build_app(app, [HOSPITAL])
    # With `@aws-cdk/core:annotationsInValidationReport` (cdk.json) an error-level finding makes synth itself fail,
    # as it does for `cdk synth` — the exception carries every finding.
    return app, app.synth()


def test_every_stack_of_a_full_deployment_passes_the_aws_solutions_rules(whole_app):
    app, assembly = whole_app
    stage = app.node.find_child("hsp-test")
    names = {c.stack_name for c in stage.node.children if isinstance(c, cdk.Stack)}
    assert names == {f"hsp-test-{s}" for s in STACKS}
    # The synth above passed, so no error-level finding is left; warnings do not fail a synth, so they are read here —
    # from the stage's own assembly, where its stacks (and cdk-nag's reports) land.
    left = [f"{stack.stack_name}: {m.id} — {str(m.entry.data)[:160]}" for stack in assembly.stacks_recursively for m in stack.messages if "AwsSolutions-" in str(m.entry.data)]
    assert left == [], "\n".join(left)
    assert len(assembly.stacks_recursively) == len(STACKS)
    # No finding left is only worth something if the rules ran: with `reports=True` cdk-nag writes one CSV per stack it
    # visited into the app's outdir, and every line in them is a rule applied to a resource. (Aspects do not cross
    # stage boundaries — the aspect is added on the hospital's stage, app.py; an aspect on the app would visit nothing.)
    reports = {p.name: list(csv.DictReader(p.open(encoding="utf-8"))) for p in Path(app.outdir).glob("AwsSolutions-*-NagReport.csv")}
    assert set(reports) == {f"AwsSolutions-hsp-test-hsp-test-{s}-NagReport.csv" for s in STACKS}, sorted(reports)
    for name, rows in reports.items():
        assert rows and {r["Compliance"] for r in rows} <= {"Compliant", "Suppressed", "N/A"}, (name, {r["Compliance"] for r in rows})
        assert all(r["Exception Reason"] for r in rows if r["Compliance"] == "Suppressed"), f"{name}: every acceptance carries its reason"


def test_the_feature_flags_of_the_real_synth_are_on_in_this_test():
    assert FEATURE_FLAGS.get("@aws-cdk/core:enablePartitionLiterals") is True


def test_the_register_accepts_by_shape_so_a_real_wildcard_is_still_an_error():
    app = cdk.App(context=FEATURE_FLAGS)
    stack = cdk.Stack(app, "Probe", env=cdk.Environment(account="111111111111", region="eu-central-1"))
    iam.ManagedPolicy(stack, "Wide", statements=[iam.PolicyStatement(actions=["s3:*"], resources=["*"])])
    accept_platform_defaults(stack)
    cdk.Aspects.of(app).add(AwsSolutionsChecks(verbose=True))
    with pytest.raises(RuntimeError) as failed:
        app.synth()
    assert "AwsSolutions-IAM5[Action::s3:*]" in str(failed.value) and "AwsSolutions-IAM5[Resource::*]" in str(failed.value)
