"""
Several hospitals from one checkout, into one account and region: each is a stage of its own (app.py), its stacks named
`<hospital_id>-<Stack>`, every physical name and SSM path carrying its id — so two deployments never touch the same
CloudFormation stack or the same resource. And the hospital files themselves: what they must contain, what they must not.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Template
from cdk_nag import AwsSolutionsChecks

from stacks.hospitals import BRANDING_PREFIX, DEFAULT_PALETTE, PALETTE_KEYS, ConfigError, HospitalConfig, contrast, load_hospital, load_hospitals
from stacks.hosting_stack import CONFIG_KEY, HostingStack, runtime_config_values
from stacks.nag import apply_accepted_findings

from test_cdk_nag import FEATURE_FLAGS, load_app_module  # the same feature flags and app module as the cdk-nag test

INFRA = Path(__file__).resolve().parents[2]


def hospital(hospital_id: str, **extra) -> HospitalConfig:
    return HospitalConfig.from_mapping({"hospital_id": hospital_id, "hospital_name": hospital_id.upper(), "model_id": "eu.anthropic.claude-sonnet-4-6", "data_residency": "eu", **extra})


# ── two hospitals, one account, one region ─────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def two_hospitals(staged):
    app = cdk.App(context=FEATURE_FLAGS)
    load_app_module().build_app(app, [hospital("hsp-one"), hospital("hsp-two")])
    return app, app.synth()


def stacks_of(app: cdk.App, hospital_id: str) -> dict[str, cdk.Stack]:
    stage = app.node.find_child(hospital_id)
    return {c.node.id: c for c in stage.node.children if isinstance(c, cdk.Stack)}


def test_each_hospital_is_a_stage_whose_stack_names_carry_its_id(two_hospitals):
    app, assembly = two_hospitals
    one, two = stacks_of(app, "hsp-one"), stacks_of(app, "hsp-two")
    assert set(one) == set(two) == {"HostingStack", "IdentityStack", "RegistryStack", "AuditStack", "AuthoringStack", "ApiStack"}
    assert {s.stack_name for s in one.values()} == {f"hsp-one-{k}" for k in one}
    assert {s.stack_name for s in two.values()} == {f"hsp-two-{k}" for k in two}
    names = [s.stack_name for s in assembly.stacks_recursively]
    assert len(names) == len(set(names)) == 12, names


# The properties that are account- or region-wide physical names: two deployments must never write the same value.
PHYSICAL_NAMES = {
    "AWS::Lambda::Function": "FunctionName", "AWS::DynamoDB::Table": "TableName", "AWS::Cognito::UserPool": "UserPoolName",
    "AWS::SSM::Parameter": "Name", "AWS::ApiGatewayV2::Api": "Name", "AWS::S3::Bucket": "BucketName", "AWS::Logs::LogGroup": "LogGroupName",
    "AWS::KMS::Alias": "AliasName", "AWS::SecretsManager::Secret": "Name", "AWS::CloudTrail::Trail": "TrailName", "AWS::ECS::Cluster": "ClusterName",
    "AWS::ECS::Service": "ServiceName", "AWS::ElasticLoadBalancingV2::LoadBalancer": "Name", "AWS::IAM::Role": "RoleName",
    "AWS::IAM::ManagedPolicy": "ManagedPolicyName", "AWS::SNS::Topic": "TopicName", "AWS::Events::Rule": "Name",
}


def test_the_two_deployments_share_no_physical_name_and_no_ssm_path(two_hospitals):
    app, _ = two_hospitals
    named: dict[str, set[str]] = {}
    for hospital_id in ("hsp-one", "hsp-two"):
        names: set[str] = set()
        for stack in stacks_of(app, hospital_id).values():
            template = Template.from_stack(stack).to_json()
            for resource in template["Resources"].values():
                key = PHYSICAL_NAMES.get(resource["Type"])
                value = resource.get("Properties", {}).get(key) if key else None
                if isinstance(value, str):  # a literal name; tokens (CloudFormation-generated names) are unique by construction
                    names.add(value)
                    assert hospital_id in value, f"{resource['Type']} {key}={value!r} does not carry {hospital_id}"
        named[hospital_id] = names
    assert named["hsp-one"] and named["hsp-two"]
    assert named["hsp-one"].isdisjoint(named["hsp-two"])
    assert any(n.startswith("/medapp/hsp-one/") for n in named["hsp-one"]), "SSM parameters are under /medapp/<hospital_id>/"


def test_cross_stack_references_name_the_prefixed_stack(two_hospitals):
    """With `@aws-cdk/core:defaultCrossStackReferences: weak` (cdk.json) a stack reads another's output by stack name at deploy
    (`Fn::GetStackOutput`), so the name must be the hospital's: hsp-one's API never reads hsp-two's registry."""
    app, _ = two_hospitals
    api = Template.from_stack(stacks_of(app, "hsp-one")["ApiStack"]).to_json()
    referenced = {v["Fn::GetStackOutput"]["StackName"] for v in _walk(api) if isinstance(v, dict) and "Fn::GetStackOutput" in v}
    assert referenced and all(name.startswith("hsp-one-") for name in referenced), referenced
    assert "hsp-one-RegistryStack" in referenced and "hsp-one-AuthoringStack" in referenced


def _walk(node):
    yield node
    if isinstance(node, dict):
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


# ── the hospital files ─────────────────────────────────────────────────────────────────────────────────────────────

def write(directory: Path, hospital_id: str, body: dict | None = None, *, name: str | None = None) -> Path:
    path = directory / f"{name or hospital_id}.json"
    path.write_text(json.dumps({"hospital_id": hospital_id, "model_id": "eu.anthropic.claude-sonnet-4-6", **(body or {})}), encoding="utf-8")
    return path


def test_the_checked_in_hospitals_synthesise_together_under_the_rules(staged, tmp_path):
    """What the repository configures deploys: every hospital under infra/hospitals/, its optional stacks, cdk-nag on —
    Klinikum Musterstadt ships with the reference servers, its own branding and no hospital servers."""
    hospitals = load_hospitals()
    assert [h.hospital_id for h in hospitals] == ["hsp-musterstadt"]
    app = cdk.App(context=FEATURE_FLAGS, outdir=str(tmp_path / "out"))
    load_app_module().build_app(app, hospitals)
    assembly = app.synth()  # an error-level finding raises (cdk.json: annotationsInValidationReport)
    names = {s.stack_name for s in assembly.stacks_recursively}
    assert {"hsp-musterstadt-HostingStack", "hsp-musterstadt-ReferenceServersStack", "hsp-musterstadt-ViewerStack"} <= names
    for h in hospitals:  # the optional stacks follow each file
        assert (f"{h.hospital_id}-ReferenceServersStack" in names) == h.reference_servers
        assert (f"{h.hospital_id}-HospitalServersStack" in names) == bool(h.hospital_servers)
    hosting = next(s for s in assembly.stacks_recursively if s.stack_name == "hsp-musterstadt-HostingStack")
    prefixes = {r["Properties"].get("DestinationBucketKeyPrefix", "") for r in hosting.template["Resources"].values() if r["Type"] == "Custom::CDKBucketDeployment"}
    assert BRANDING_PREFIX in prefixes, "the hospital's logo files are deployed"
    reports = list((tmp_path / "out").glob("AwsSolutions-*-NagReport.csv"))
    assert len(reports) == len(names), "the rules ran on every stack"


def test_the_checked_in_hospital_files_load_and_name_themselves():
    hospitals = load_hospitals()
    assert [h.hospital_id for h in hospitals] == sorted(h.hospital_id for h in hospitals)
    musterstadt = next(h for h in hospitals if h.hospital_id == "hsp-musterstadt")
    assert musterstadt.data_residency == "eu" and musterstadt.model_id.startswith("eu.") and musterstadt.reference_servers is True
    assert musterstadt.hospital_servers is None, "the sample ships on the reference servers; a hospital's own servers are added per deployment (docs/hospital-servers.md)"
    # The shipped hospital carries an explicit branding — the worked example of how a deployment gets its own look.
    assert musterstadt.branding and musterstadt.palette["accent"] == "#1F4E9E" and musterstadt.logo_files() == ("logo.svg", "logo-on-dark.svg")
    assert musterstadt.branding_dir is not None and (musterstadt.branding_dir / "logo.svg").is_file()
    raw = json.loads((INFRA / "hospitals" / "hsp-musterstadt.json").read_text(encoding="utf-8"))
    assert not any(k in json.dumps(raw) for k in ("client_id", "client_secret")), "credentials never live in the repository"


def test_a_file_is_named_after_its_hospital_id(tmp_path):
    write(tmp_path, "hsp-a")
    assert load_hospital(tmp_path / "hsp-a.json").hospital_id == "hsp-a"
    with pytest.raises(ConfigError, match="named 'other' but its hospital_id is 'hsp-b'"):
        load_hospital(write(tmp_path, "hsp-b", name="other"))


def test_unknown_keys_and_bad_ids_are_refused(tmp_path):
    with pytest.raises(ConfigError, match="unknown key"):
        HospitalConfig.from_mapping({"hospital_id": "hsp-a", "model_id": "m", "hospital_nmae": "typo"})
    for bad in ("Hospital", "hsp_a", "a", "hsp-musterstadt-and-then-some", "1hsp", "hsp-"):
        with pytest.raises(ConfigError, match="hospital_id"):
            HospitalConfig.from_mapping({"hospital_id": bad, "model_id": "m"})
    with pytest.raises(ConfigError, match="model_id is required"):
        HospitalConfig.from_mapping({"hospital_id": "hsp-a"})


def test_values_are_coerced_the_way_the_old_context_was():
    h = HospitalConfig.from_mapping({"hospital_id": "hsp-a", "model_id": "m", "reference_servers": "true", "mfa_required": "no", "frontend_origins": "http://localhost:5173, https://dev.example", "app_registry_guard_allowed_principals": ["arn:a", "arn:b"]})
    assert h.reference_servers is True and h.mfa_required is False
    assert h.frontend_origins == ("http://localhost:5173", "https://dev.example")
    assert h.app_registry_guard_allowed_principals == ("arn:a", "arn:b")
    assert h.display_name == "hsp-a"


def test_load_hospitals_lists_selects_and_refuses_the_unknown(tmp_path):
    with pytest.raises(ConfigError, match="no hospital is configured"):
        load_hospitals(tmp_path)
    write(tmp_path, "hsp-b"); write(tmp_path, "hsp-a")
    assert [h.hospital_id for h in load_hospitals(tmp_path)] == ["hsp-a", "hsp-b"]
    assert [h.hospital_id for h in load_hospitals(tmp_path, select="hsp-b")] == ["hsp-b"]
    assert [h.hospital_id for h in load_hospitals(tmp_path, select="hsp-b, hsp-a")] == ["hsp-b", "hsp-a"]
    with pytest.raises(ConfigError, match="no hospital file for hsp-c .* configured: hsp-a, hsp-b"):
        load_hospitals(tmp_path, select="hsp-c")


# ── branding: a hospital's look is configuration ───────────────────────────────────────────────────────────────────

BLUE = {"palette": {"accent": "#1f5fa8", "ink": "#101820"}, "logo": {"src": "logo.svg", "alt": "Klinikum Blau", "height": 24, "srcOnDark": "logo-on-dark.svg"}}


def test_the_default_palette_here_is_the_panels_so_the_merge_at_synth_matches_the_merge_in_the_browser():
    source = (INFRA.parent / "med_app" / "src" / "branding.ts").read_text(encoding="utf-8")
    shipped = re.search(r"export const branding: Branding = \{\s*palette: \{(.*?)\},", source, re.S).group(1)
    pairs = dict(re.findall(r"(\w+):\s*'(#[0-9A-Fa-f]{6})'", shipped))
    assert pairs == DEFAULT_PALETTE, "stacks/hospitals.py DEFAULT_PALETTE must stay identical to med_app/src/branding.ts"
    assert tuple(pairs) == PALETTE_KEYS


def test_a_branding_override_is_merged_validated_and_carried_to_the_panel():
    h = hospital("hsp-a", branding=BLUE)
    assert h.palette == {**DEFAULT_PALETTE, "accent": "#1F5FA8", "ink": "#101820"}, "upper-case hex, defaults for the rest"
    assert h.frontend_branding() == {"palette": {"accent": "#1F5FA8", "ink": "#101820"}, "logo": {"src": f"/{BRANDING_PREFIX}/logo.svg", "alt": "Klinikum Blau", "height": 24, "srcOnDark": f"/{BRANDING_PREFIX}/logo-on-dark.svg"}}
    assert h.logo_files() == ("logo.svg", "logo-on-dark.svg")
    assert hospital("hsp-b").frontend_branding() is None and hospital("hsp-b").palette == DEFAULT_PALETTE
    values = runtime_config_values(hospital_id="hsp-a", hospital_name="A", region="eu-central-1", user_pool_id="p", client_id="c", api_base_url="https://api", ohif_viewer_url=None, branding=h.frontend_branding())
    carried = json.loads(values["VITE_BRANDING"])
    assert carried["palette"]["accent"] == "#1F5FA8" and carried["logo"]["src"] == "/branding/logo.svg"
    assert runtime_config_values(hospital_id="hsp-b", hospital_name="B", region="eu-central-1", user_pool_id="p", client_id="c", api_base_url="https://api", ohif_viewer_url=None)["VITE_BRANDING"] == ""


@pytest.mark.parametrize("bad, message", [
    ({"palette": {"accnt": "#1F5FA8"}}, "unknown colour"),
    ({"palette": {"accent": "blue"}}, "#RRGGBB"),
    ({"palette": {"accent": "#FFFFFF"}}, r"accent .* on surface .* contrast 1\.00:1, below 4\.5:1"),
    ({"palette": {"ink": "#F4F6F8", "page": "#15202B"}}, "text on cards"),
    ({"palette": {"muted": "#101010"}}, "dark to light"),
    ({"logo": {"src": "logo.svg"}}, "logo.alt is required"),
    ({"logo": {"src": "../logo.svg", "alt": "x"}}, "not a path"),
    ({"logo": {"src": "logo.svg", "alt": "x", "height": 400}}, "between 12 and 64"),
    ({"logo": {"src": "logo.svg", "alt": "x", "width": 100}}, "unknown key"),
    ({"font": "Comic Sans"}, "unknown key"),
    ({}, "branding is empty"),
])
def test_a_branding_that_would_not_render_or_would_not_read_fails_the_synth(bad, message):
    with pytest.raises(ConfigError, match=message):
        hospital("hsp-a", branding=bad)


def test_contrast_is_wcag():
    assert round(contrast("#FFFFFF", "#000000"), 1) == 21.0
    assert 6.0 < contrast(DEFAULT_PALETTE["accent"], DEFAULT_PALETTE["surface"]) < 7.0  # the shipped accent on white


def test_the_logo_files_must_sit_in_the_hospitals_folder_and_the_folder_travels_with_the_config(tmp_path):
    write(tmp_path, "hsp-a", {"branding": BLUE})
    with pytest.raises(ConfigError, match=r"names logo.svg, logo-on-dark.svg but the file is not in .*hsp-a/"):
        load_hospital(tmp_path / "hsp-a.json")
    folder = tmp_path / "hsp-a"
    folder.mkdir()
    (folder / "logo.svg").write_text("<svg/>", encoding="utf-8")
    with pytest.raises(ConfigError, match="names logo-on-dark.svg but"):
        load_hospital(tmp_path / "hsp-a.json")
    (folder / "logo-on-dark.svg").write_text("<svg/>", encoding="utf-8")
    h = load_hospital(tmp_path / "hsp-a.json")
    assert h.branding_dir == folder
    assert load_hospital(write(tmp_path, "hsp-b", {"branding": {"palette": {"accent": "#1F5FA8"}}})).branding_dir is None, "a palette alone needs no folder"


def test_the_hosting_stack_serves_the_hospitals_folder_under_branding_and_keeps_the_site_sync_off_it(staged, tmp_path):
    folder = tmp_path / "hsp-a"
    folder.mkdir()
    (folder / "logo.svg").write_text("<svg/>", encoding="utf-8")
    app = cdk.App(context=FEATURE_FLAGS)
    env = cdk.Environment(account="111111111111", region="eu-central-1")
    a = HostingStack(app, "WithLogo", hospital_id="hsp-a", branding_dir=folder, env=env)
    b = HostingStack(app, "Without", hospital_id="hsp-b", env=env)
    with_logo, without = Template.from_stack(a).to_json(), Template.from_stack(b).to_json()
    deployments = {r["Properties"].get("DestinationBucketKeyPrefix", ""): r["Properties"] for r in with_logo["Resources"].values() if r["Type"] == "Custom::CDKBucketDeployment"}
    assert BRANDING_PREFIX in deployments and deployments[BRANDING_PREFIX]["Prune"] is True and deployments[BRANDING_PREFIX]["DistributionPaths"] == [f"/{BRANDING_PREFIX}/*"]
    pages = deployments[""]
    assert f"{BRANDING_PREFIX}/*" in pages["Exclude"] and CONFIG_KEY in pages["Exclude"], "the site sync neither copies over nor prunes the hospital's files"
    pages_without = [r["Properties"] for r in without["Resources"].values() if r["Type"] == "Custom::CDKBucketDeployment" and not r["Properties"].get("DestinationBucketKeyPrefix")][0]
    assert f"{BRANDING_PREFIX}/*" not in pages_without["Exclude"], "without a folder of its own the build's /branding/ files (if any) deploy as before"
    assert not any(r["Properties"].get("DestinationBucketKeyPrefix") == BRANDING_PREFIX for r in without["Resources"].values() if r["Type"] == "Custom::CDKBucketDeployment")
    # The extra deployment brings nothing the register does not already accept by shape: the AWS Solutions rules pass.
    apply_accepted_findings(app)
    cdk.Aspects.of(app).add(AwsSolutionsChecks(verbose=True))
    app.synth()
