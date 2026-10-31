"""
The imaging viewer: OHIF on a private bucket behind CloudFront, frameable by the panel only, its app-config.js
pointing at the reference API's browser door with the token bridge; the OHIF staging filter; the browser door
itself (Cognito JWT, GET only, path rewritten to Orthanc's root) and the CORS the viewer needs.
"""

import json
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk import aws_cognito as cognito
from aws_cdk.assertions import Match, Template

from stacks import ReferenceServersStack, ViewerStack
from stacks.reference_servers_stack import orthanc_settings
from stacks.viewer_stack import OHIF_VERSION, _keep, ohif_app_config

ENV = cdk.Environment(account="111111111111", region="eu-central-1")


@pytest.fixture(scope="module")
def fake_dist(tmp_path_factory) -> str:
    """What stage_ohif() produces, without the 48 MB download: an index.html, a hashed bundle, a wasm, a stylesheet."""
    dist = tmp_path_factory.mktemp("ohif") / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><script src='/app-config.js'></script>", encoding="utf-8")
    (dist / "app.bundle.abc123.js").write_text("// bundle", encoding="utf-8")
    (dist / "147.css").write_text("body{}", encoding="utf-8")
    (dist / "17dd54813d5acc10bf8f.wasm").write_bytes(b"\0asm")
    return str(dist)


@pytest.fixture(scope="module")
def synthesized(fake_dist):
    app = cdk.App()
    deps = cdk.Stack(app, "Deps", env=ENV)
    pool = cognito.UserPool(deps, "Pool")
    client = pool.add_client("Web")
    viewer = ViewerStack(app, "ViewerStack", hospital_id="hsp-test", frame_ancestors=["https://panel.example", "http://localhost:5173"], ohif_dist=fake_dist, env=ENV)
    reference = ReferenceServersStack(
        app, "ReferenceServersStack",
        hospital_id="hsp-test",
        user_pool=pool,
        web_client=client,
        browser_origins=[viewer.origin, "https://panel.example", "http://localhost:5173"],
        viewer=viewer,
        env=ENV,
    )
    return Template.from_stack(viewer), Template.from_stack(reference)


def test_viewer_is_private_https_and_frameable_by_the_panel_only(synthesized):
    viewer, _ = synthesized
    viewer.has_resource_properties("AWS::S3::Bucket", {"PublicAccessBlockConfiguration": Match.object_like({"BlockPublicAcls": True, "RestrictPublicBuckets": True})})
    viewer.has_resource_properties(
        "AWS::CloudFront::Distribution",
        {"DistributionConfig": Match.object_like({"DefaultRootObject": "index.html", "CustomErrorResponses": Match.array_with([Match.object_like({"ErrorCode": 403, "ResponseCode": 200, "ResponsePagePath": "/index.html"})])})},
    )
    policies = viewer.find_resources("AWS::CloudFront::ResponseHeadersPolicy")
    assert len(policies) == 1
    security = next(iter(policies.values()))["Properties"]["ResponseHeadersPolicyConfig"]["SecurityHeadersConfig"]
    assert "FrameOptions" not in security, "X-Frame-Options would forbid the panel's iframe"
    assert security["ContentSecurityPolicy"]["ContentSecurityPolicy"] == "frame-ancestors 'self' https://panel.example http://localhost:5173"
    assert security["StrictTransportSecurity"]["AccessControlMaxAgeSec"] == 31536000


def test_viewer_deployments_split_immutable_bundles_from_revalidated_pages(synthesized):
    viewer, _ = synthesized
    deployments = viewer.find_resources("Custom::CDKBucketDeployment")
    assert len(deployments) == 2
    controls = {json.dumps(d["Properties"].get("SystemMetadata", {}).get("cache-control", "")) for d in deployments.values()}
    assert any("max-age=31536000" in c and "immutable" in c for c in controls) and any("no-cache" in c for c in controls)
    pages = next(d for d in deployments.values() if "no-cache" in json.dumps(d["Properties"].get("SystemMetadata", {})))
    assert "app-config.js" in pages["Properties"]["Exclude"], "the deploy-time config must survive the site sync"
    assert all(d["Properties"].get("Prune") is False for d in deployments.values())


def test_app_config_points_ohif_at_the_browser_door_with_the_token_bridge(synthesized):
    _, reference = synthesized
    config_deployments = [d for d in reference.find_resources("Custom::CDKBucketDeployment").values() if "app-config.js" in json.dumps(d["Properties"].get("DistributionPaths", []))]
    assert len(config_deployments) == 1, "the reference stack writes the viewer's app-config.js (it knows the door)"

    text = ohif_app_config("https://abc.execute-api.eu-central-1.amazonaws.com/viewer/dicom-web/")
    for expected in (
        "qidoRoot: 'https://abc.execute-api.eu-central-1.amazonaws.com/viewer/dicom-web'",
        "wadoRoot: 'https://abc.execute-api.eu-central-1.amazonaws.com/viewer/dicom-web'",
        "window.location.hash",
        "sessionStorage.setItem('medapp.viewer.token'",
        "history.replaceState",
        "requestOptions: { auth: function () { return window.medappAuthorization(); } }",
        # OHIF 3.12 takes the header from its userAuthenticationService, not requestOptions: the transport carries it too.
        "XMLHttpRequest.prototype.send = function ()",
        "window.fetch = function (input, init)",
        "service.setServiceImplementation({ getAuthorizationHeader:",
        "globalThis.__filename = ''",  # the ONNX glue in the published build touches __filename when its chunk loads
        "'ohif.tours': { $set: [] }",
        "Crosshairs.prototype.setToolCenter = function (center, suppressEvents)",  # a NaN crosshair centre (two viewports with one orientation) must not move the cameras
        "if (!finite) { return; }",
        "imageRendering: 'wadors'",
        "showStudyList: false",
        "supportsReject: false",
        "dicomUploadEnabled: false",
    ):
        assert expected in text, expected
    assert "token=" not in text.split("window.config")[1], "the token is never part of a URL OHIF builds"
    assert "bulkDataURI: { enabled: true, relativeResolution: 'studies' }," in text, "the reference PACS writes door-relative links (PublicRoot): nothing to re-prefix"
    # A door in front of another server: the PACS's absolute BulkDataURIs are re-prefixed onto the door, or OHIF would fetch them without a token.
    proxied = ohif_app_config("https://door.example/viewer/dicom-web", friendly_name="Hospital PACS", upstream_root="https://hospital.example/dicom-web/")
    assert "bulkDataURI: { enabled: true, relativeResolution: 'studies', startsWith: 'https://hospital.example/dicom-web', prefixWith: 'https://door.example/viewer/dicom-web' }," in proxied
    assert "friendlyName: 'Hospital PACS'" in proxied
    assert proxied.count("sourceName:") == 1 and "var roots = ['https://door.example/viewer/dicom-web'];" in proxied


def test_the_synthetic_record_is_a_second_data_source_so_previews_never_reach_the_hospitals_pacs():
    # A preview renders on the synthetic record; its studies live on the reference PACS, not the hospital's. OHIF registers a
    # route per data source, so the panel opens them as /viewer/reference?StudyInstanceUIDs=… while clinicians use /viewer?….
    text = ohif_app_config("https://door.example/viewer/dicom-web", friendly_name="Hospital PACS", upstream_root="https://hospital.example/dicom-web", synthetic_root="https://ref.example/viewer/dicom-web/")
    assert text.count("sourceName:") == 2 and "defaultDataSourceName: 'medapp'" in text
    assert "sourceName: 'reference'" in text and "qidoRoot: 'https://ref.example/viewer/dicom-web'" in text and "friendlyName: 'Reference PACS (synthetic record — previews)'" in text
    assert "var roots = ['https://door.example/viewer/dicom-web', 'https://ref.example/viewer/dicom-web'];" in text, "the token bridge covers both doors"
    reference_part = text.split("sourceName: 'reference'")[1]
    assert "bulkDataURI: { enabled: true, relativeResolution: 'studies' }," in reference_part, "the reference PACS writes door-relative links: nothing to re-prefix"
    # The reference deployment alone: the one door is both the default and the `reference` source, so the same panel URL works.
    alone = ohif_app_config("https://ref.example/viewer/dicom-web", synthetic_root="https://ref.example/viewer/dicom-web")
    assert alone.count("sourceName:") == 2 and "var roots = ['https://ref.example/viewer/dicom-web'];" in alone
    import subprocess, tempfile

    for js in (text, alone):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(js)
        assert subprocess.run(["node", "--check", f.name], capture_output=True, text=True).returncode == 0, "valid JavaScript"


def test_the_browser_door_is_cognito_jwt_get_only_and_rewritten_to_orthanc(synthesized):
    _, reference = synthesized
    routes = reference.find_resources("AWS::ApiGatewayV2::Route")
    viewer_routes = [r for r in routes.values() if r["Properties"]["RouteKey"].startswith("GET /viewer/dicom-web")]
    assert [r["Properties"]["RouteKey"] for r in viewer_routes] == ["GET /viewer/dicom-web/{proxy+}"]
    assert viewer_routes[0]["Properties"]["AuthorizationType"] == "JWT"
    others = [r for r in routes.values() if not r["Properties"]["RouteKey"].startswith("GET /viewer/")]
    assert all(r["Properties"]["AuthorizationType"] == "AWS_IAM" for r in others), "the dispatcher's doors stay IAM"
    reference.has_resource_properties("AWS::ApiGatewayV2::Authorizer", {"AuthorizerType": "JWT", "IdentitySource": ["$request.header.Authorization"], "JwtConfiguration": Match.object_like({"Audience": Match.any_value()})})
    integrations = reference.find_resources("AWS::ApiGatewayV2::Integration")
    rewritten = [i for i in integrations.values() if i["Properties"].get("RequestParameters", {}).get("overwrite:path")]
    assert len(rewritten) == 1 and rewritten[0]["Properties"]["RequestParameters"]["overwrite:path"] == "/dicom-web/${request.path.proxy}"
    api = next(iter(reference.find_resources("AWS::ApiGatewayV2::Api").values()))
    cors = api["Properties"]["CorsConfiguration"]
    assert "https://panel.example" in json.dumps(cors["AllowOrigins"]) and cors["AllowMethods"] == ["GET", "OPTIONS"] and "authorization" in cors["AllowHeaders"]
    reference.has_resource_properties("AWS::SSM::Parameter", {"Name": "/medapp/hsp-test/reference/viewer-dicomweb-base-url"})


def test_orthanc_publishes_the_browser_door_as_its_public_root():
    settings = orthanc_settings(public_root="https://abc.execute-api.eu-central-1.amazonaws.com/viewer/dicom-web")
    assert settings["DicomWeb"]["PublicRoot"] == "https://abc.execute-api.eu-central-1.amazonaws.com/viewer/dicom-web/"
    assert "PublicRoot" not in orthanc_settings()["DicomWeb"]


def test_ohif_staging_keeps_the_viewer_and_drops_what_it_does_not_need():
    assert _keep("package/dist/index.html") and _keep("package/dist/app.bundle.156bc1996ff3567faecd.js") and _keep("package/dist/assets/favicon.ico")
    assert _keep("package/dist/17dd54813d5acc10bf8f.wasm") and _keep("package/dist/init-service-worker.js")
    for dropped in ("package/dist/ort/ort.all.js", "package/dist/dicom-microscopy-viewer/x.js", "package/dist/app.bundle.js.map", "package/dist/app-config.js", "package/dist/google.js", "package/dist/_headers", "package/LICENSE", "package/package.json"):
        assert not _keep(dropped), dropped
    assert OHIF_VERSION.count(".") == 2
    assert Path(__file__).exists()
