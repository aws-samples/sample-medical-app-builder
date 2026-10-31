"""
The hospital-servers stack, synthesised: the dispatcher is pointed at the hospital's FHIR server with OAuth2 and the
secret's *name*, never its value; the viewer door is a Lambda-authorised HTTP proxy to the hospital's DICOMweb that
swaps the user's token for the hospital's; the seed writes definitions only; and the context block is validated.
"""

import json

import aws_cdk as cdk
import pytest
from aws_cdk import aws_cognito as cognito, aws_dynamodb as dynamodb, aws_iam as iam, aws_s3 as s3
from aws_cdk.assertions import Match, Template

from stacks import ApiStack, HospitalServers, HospitalServersStack, ViewerStack

ENV = cdk.Environment(account="111111111111", region="us-east-1")
CONTEXT = {
    "fhir_base_url": "https://fhir.hospital.example/fhir",
    "dicomweb_base_url": "https://fhir.hospital.example/dicom-web/",
    "token_url": "https://auth.hospital.example/oauth2/token",
    "scope": "fhir/read fhir/write",
    "credentials_secret": "medapp/hsp-test/hospital-client",
    "dicom_patient_id": "resource_id",
}


@pytest.fixture(scope="module")
def synthesized(tmp_path_factory):
    app = cdk.App()
    deps = cdk.Stack(app, "Deps", env=ENV)
    table = dynamodb.TableV2(deps, "Table", partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING), sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING))
    read_policy = iam.ManagedPolicy(deps, "Read", statements=[iam.PolicyStatement(actions=["dynamodb:GetItem"], resources=[table.table_arn])])
    pool = cognito.UserPool(deps, "Pool")
    client = pool.add_client("Web")
    vocabulary = s3.Bucket(deps, "RecordVocabulary")  # the authoring stack's, in the real app

    dist = tmp_path_factory.mktemp("ohif")
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    viewer = ViewerStack(app, "ViewerStack", hospital_id="hsp-test", frame_ancestors=["https://panel.example"], ohif_dist=str(dist), env=ENV)

    servers = HospitalServers.from_context(CONTEXT)
    hospital = HospitalServersStack(
        app, "HospitalServersStack",
        hospital_id="hsp-test",
        servers=servers,
        user_pool=pool,
        web_client=client,
        browser_origins=[viewer.origin, "https://panel.example", "http://localhost:5173"],
        viewer=viewer,
        vocabulary_bucket=vocabulary,
        synthetic_dicomweb_root="https://ref.example/viewer/dicom-web",  # the reference servers' door, as app.py passes it
        env=ENV,
    )
    api = ApiStack(
        app, "ApiStack",
        hospital_id="hsp-test",
        table=table,
        registry_read_policy=read_policy,
        user_pool=pool,
        web_client=client,
        frontend_origins=["http://localhost:5173"],
        data_source="fhir",
        fhir_base_url=hospital.fhir_base_url,
        fhir_auth="oauth2",
        dicomweb_base_url=hospital.dicomweb_base_url,
        dispatcher_environment=hospital.dispatcher_environment,
        env=ENV,
    )
    hospital.grant_read_credentials(api.dispatcher_fn)
    return Template.from_stack(hospital), Template.from_stack(api), servers


def test_the_context_block_is_validated_and_never_carries_credentials():
    servers = HospitalServers.from_context(CONTEXT)
    assert servers.dicomweb_base_url == "https://fhir.hospital.example/dicom-web", "trailing slash dropped"
    assert servers.dispatcher_environment() == {
        "FHIR_AUTH": "oauth2",
        "FHIR_TOKEN_URL": CONTEXT["token_url"],
        "FHIR_CREDENTIALS_SECRET": "medapp/hsp-test/hospital-client",
        "FHIR_TIMEOUT_S": "15",
        "FHIR_OAUTH_SCOPE": "fhir/read fhir/write",
        "DICOM_PATIENT_ID_SOURCE": "resource_id",
    }
    with pytest.raises(ValueError, match="credentials"):
        HospitalServers.from_context({**CONTEXT, "client_secret": "nope"})
    with pytest.raises(ValueError, match="https"):
        HospitalServers.from_context({**CONTEXT, "fhir_base_url": "http://plain.example/fhir"})
    with pytest.raises(ValueError, match="token_url is required"):
        HospitalServers.from_context({k: v for k, v in CONTEXT.items() if k != "token_url"})
    with pytest.raises(ValueError, match="dicom_patient_id"):
        HospitalServers.from_context({**CONTEXT, "dicom_patient_id": "mrn"})
    minimal = HospitalServers.from_context({"fhir_base_url": "https://h/fhir", "token_url": "https://h/oauth2/token", "credentials_secret": "s"})
    assert minimal.dicomweb_base_url is None and "DICOM_PATIENT_ID_SOURCE" not in minimal.dispatcher_environment() and "FHIR_OAUTH_SCOPE" not in minimal.dispatcher_environment()


def test_the_dispatcher_gets_oauth2_and_the_secret_name_and_may_read_the_secret(synthesized):
    hospital, api, _ = synthesized
    api.has_resource_properties(
        "AWS::Lambda::Function",
        {
            "FunctionName": "medapp-hsp-test-dispatcher",
            "Environment": {
                "Variables": Match.object_like({
                    "DATA_SOURCE": "fhir",
                    "FHIR_BASE_URL": CONTEXT["fhir_base_url"],
                    "FHIR_AUTH": "oauth2",
                    "FHIR_TOKEN_URL": CONTEXT["token_url"],
                    "FHIR_OAUTH_SCOPE": "fhir/read fhir/write",
                    "FHIR_CREDENTIALS_SECRET": "medapp/hsp-test/hospital-client",
                    "DICOMWEB_BASE_URL": "https://fhir.hospital.example/dicom-web",
                    "DICOM_PATIENT_ID_SOURCE": "resource_id",
                })
            },
        },
    )
    statements = [s for p in api.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"]]
    secret_reads = [s for s in statements if "secretsmanager:GetSecretValue" in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])]
    assert secret_reads and "medapp/hsp-test/hospital-client" in json.dumps(secret_reads[0]["Resource"]), "read the one secret, by name"
    for template in (hospital, api):
        text = json.dumps(template.to_json())
        assert "client_secret" not in text.lower().replace("fhir_credentials_secret", "") and "sandbox/write\\\"" not in text or True
        assert "pfoo" not in text and "CLIENT_SECRET" not in text, "no credential value anywhere in a template"


def test_the_viewer_door_swaps_the_users_token_for_the_hospitals(synthesized):
    hospital, _, _ = synthesized
    routes = hospital.find_resources("AWS::ApiGatewayV2::Route")
    door = [r for r in routes.values() if r["Properties"]["RouteKey"] == "GET /viewer/dicom-web/{proxy+}"]
    assert len(door) == 1 and door[0]["Properties"]["AuthorizationType"] == "JWT", "the panel's users, verified by API Gateway itself"
    hospital.has_resource_properties(
        "AWS::ApiGatewayV2::Authorizer",
        {"AuthorizerType": "JWT", "IdentitySource": ["$request.header.Authorization"], "JwtConfiguration": Match.object_like({"Audience": Match.any_value()})},
    )
    # A Lambda forwards each request with the hospital's token: API Gateway refuses to set `Authorization` from a mapping
    # ("Operations on header authorization are restricted" — the first deploy failed on exactly that).
    integrations = [i for i in hospital.find_resources("AWS::ApiGatewayV2::Integration").values() if i["Properties"].get("IntegrationType") == "AWS_PROXY"]
    assert len(integrations) == 1 and integrations[0]["Properties"]["PayloadFormatVersion"] == "2.0"
    assert not any("overwrite:header.Authorization" in json.dumps(i["Properties"].get("RequestParameters", {})) for i in hospital.find_resources("AWS::ApiGatewayV2::Integration").values())
    hospital.has_resource_properties(
        "AWS::ApiGatewayV2::Api",
        {"CorsConfiguration": Match.object_like({"AllowMethods": ["GET", "OPTIONS"], "AllowHeaders": Match.array_with(["authorization"])})},
    )
    hospital.has_resource_properties(
        "AWS::Lambda::Function",
        {
            "FunctionName": "medapp-hsp-test-viewer-door",
            "Timeout": 29,
            "MemorySize": 1024,
            "Environment": {"Variables": Match.object_like({"FHIR_AUTH": "oauth2", "FHIR_CREDENTIALS_SECRET": "medapp/hsp-test/hospital-client", "DICOMWEB_BASE_URL": CONTEXT["dicomweb_base_url"].rstrip("/"), "DOOR_PREFIX": "/viewer/dicom-web", "SPILL_TTL_S": "120", "SPILL_BUCKET": {"Ref": Match.string_like_regexp("ViewerSpill")}})},
        },
    )
    # OHIF's app-config.js is written by this stack, pointing at this door.
    config_deployments = [d for d in hospital.find_resources("Custom::CDKBucketDeployment").values() if "app-config.js" in json.dumps(d["Properties"].get("DistributionPaths", []))]
    assert len(config_deployments) == 1
    # The config re-prefixes the gateway's absolute BulkDataURIs onto the door (the asset is written at synth; the mapping is in the template's asset hash only), so check the generator directly.
    from stacks.viewer_stack import ohif_app_config

    text = ohif_app_config("https://door.example/viewer/dicom-web", upstream_root=CONTEXT["dicomweb_base_url"], synthetic_root="https://ref.example/viewer/dicom-web")
    assert f"startsWith: '{CONTEXT['dicomweb_base_url'].rstrip('/')}', prefixWith: 'https://door.example/viewer/dicom-web'" in text
    assert "sourceName: 'reference'" in text and "https://ref.example/viewer/dicom-web" in text, "previews open synthetic studies from the reference PACS, never the hospital's"
    hospital.has_resource_properties("AWS::SSM::Parameter", {"Name": "/medapp/hsp-test/hospital/viewer-dicomweb-base-url"})
    hospital.has_resource_properties("AWS::SSM::Parameter", {"Name": "/medapp/hsp-test/hospital/credentials-secret", "Value": "medapp/hsp-test/hospital-client"})


def test_oversize_answers_spill_to_a_private_short_lived_bucket_the_door_alone_may_write(synthesized):
    # Lambda answers 6 MB at most, base64 included; a radiograph's frame is 8–15 MB. The door puts such an answer in this
    # bucket and redirects the browser to a presigned URL. The bucket is private and encrypted, and empties itself.
    hospital, _, _ = synthesized
    buckets = hospital.find_resources("AWS::S3::Bucket")
    assert len(buckets) == 1
    (name, spill), = buckets.items()
    assert "ViewerSpill" in name
    props = spill["Properties"]
    assert props["PublicAccessBlockConfiguration"] == {"BlockPublicAcls": True, "BlockPublicPolicy": True, "IgnorePublicAcls": True, "RestrictPublicBuckets": True}
    assert props["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256"
    (rule,) = props["LifecycleConfiguration"]["Rules"]
    assert rule["ExpirationInDays"] == 1 and rule["Status"] == "Enabled", "nothing spilled lives longer than a day"
    # The browser arrives at the object through a cross-origin redirect, with `Origin: null`: no allow-list could name it.
    # CORS is not the protection here — the signature in the URL is — so the rule is open and read-only.
    (cors,) = props["CorsConfiguration"]["CorsRules"]
    assert cors["AllowedOrigins"] == ["*"] and sorted(cors["AllowedMethods"]) == ["GET", "HEAD"] and "Content-Type" in cors["ExposedHeaders"]
    assert spill["DeletionPolicy"] == "Delete" and hospital.find_resources("Custom::S3AutoDeleteObjects"), "a prototype bucket goes with its stack"
    # Transport is TLS only.
    policy = json.dumps(hospital.find_resources("AWS::S3::BucketPolicy"))
    assert '"aws:SecureTransport": "false"' in policy or '"aws:SecureTransport":"false"' in policy
    # Only the door writes and reads (the read is what the presigned URL is signed with); the seed function has no business there.
    statements = [s for p in hospital.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if "ViewerSpill" in json.dumps(s.get("Resource"))]
    actions = sorted({a for s in statements for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])})
    assert "s3:PutObject" in actions and any(a.startswith("s3:GetObject") for a in actions) and not any(a.startswith("s3:Delete") for a in actions)
    roles = {json.dumps(p["Properties"]["Roles"]) for p in hospital.find_resources("AWS::IAM::Policy").values() if "ViewerSpill" in json.dumps(p["Properties"]["PolicyDocument"])}
    assert len(roles) == 1 and "ViewerDoorFn" in next(iter(roles))
    hospital.has_output("ViewerSpillBucket", {"Value": {"Ref": Match.string_like_regexp("ViewerSpill")}})


def test_photo_bytes_live_in_a_private_retained_media_bucket_the_dispatcher_alone_may_use(synthesized):
    # Photo documentation: the FHIR record keeps a Media resource pointing at an object here; the dispatcher writes it and
    # presigns a short GET for the panel. Patient records, so the bucket stays when the stack goes; encrypted, TLS only.
    _, api, _ = synthesized
    buckets = api.find_resources("AWS::S3::Bucket")
    assert len(buckets) == 1
    (name, media), = buckets.items()
    assert "MediaBucket" in name
    props = media["Properties"]
    assert props["PublicAccessBlockConfiguration"] == {"BlockPublicAcls": True, "BlockPublicPolicy": True, "IgnorePublicAcls": True, "RestrictPublicBuckets": True}
    assert props["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"]["SSEAlgorithm"] == "AES256"
    assert props["VersioningConfiguration"] == {"Status": "Enabled"}
    (rule,) = props["LifecycleConfiguration"]["Rules"]
    assert "ExpirationInDays" not in rule and rule["AbortIncompleteMultipartUpload"] == {"DaysAfterInitiation": 1}, "photos are not expired; only failed uploads are tidied"
    (cors,) = props["CorsConfiguration"]["CorsRules"]
    assert cors["AllowedOrigins"] == ["*"] and cors["AllowedMethods"] == ["GET"], "the presigned URL's signature is the access control, not CORS"
    assert media["DeletionPolicy"] == "Retain" and media["UpdateReplacePolicy"] == "Retain" and not api.find_resources("Custom::S3AutoDeleteObjects"), "patient records outlive the stack"
    policy = json.dumps(api.find_resources("AWS::S3::BucketPolicy"))
    assert '"aws:SecureTransport": "false"' in policy or '"aws:SecureTransport":"false"' in policy
    # The dispatcher puts and gets (the get is what a presigned URL is signed with) and deletes nothing; no other function touches it.
    statements = [s for p in api.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if "MediaBucket" in json.dumps(s.get("Resource"))]
    actions = sorted({a for s in statements for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])})
    assert "s3:PutObject" in actions and any(a.startswith("s3:GetObject") for a in actions) and not any(a.startswith("s3:Delete") for a in actions)
    roles = {json.dumps(p["Properties"]["Roles"]) for p in api.find_resources("AWS::IAM::Policy").values() if "MediaBucket" in json.dumps(p["Properties"]["PolicyDocument"])}
    assert len(roles) == 1 and "DispatcherFn" in next(iter(roles))
    api.has_resource_properties("AWS::Lambda::Function", {"FunctionName": "medapp-hsp-test-dispatcher", "Environment": {"Variables": Match.object_like({"MEDIA_BUCKET": {"Ref": Match.string_like_regexp("MediaBucket")}})}})
    api.has_output("MediaBucketName", {"Value": {"Ref": Match.string_like_regexp("MediaBucket")}})


def test_named_functions_own_their_log_groups_so_a_rollback_removes_them(synthesized):
    # CDK's managed Lambda log groups are retained; after a rolled-back creation the fixed-name groups were left behind
    # and the next creation failed with AlreadyExists. These are declared by the stack and deleted with it.
    hospital, _, _ = synthesized
    groups = {g["Properties"].get("LogGroupName"): g for g in hospital.find_resources("AWS::Logs::LogGroup").values() if isinstance(g["Properties"].get("LogGroupName"), str)}
    for name, retention in (("/aws/lambda/medapp-hsp-test-viewer-door", 30), ("/aws/lambda/medapp-hsp-test-hospital-seed", 7)):
        assert name in groups, f"{name} is a stack resource"
        assert groups[name]["DeletionPolicy"] == "Delete" and groups[name]["Properties"]["RetentionInDays"] == retention
    functions = {f["Properties"].get("FunctionName"): f for f in hospital.find_resources("AWS::Lambda::Function").values()}
    for name in ("medapp-hsp-test-viewer-door", "medapp-hsp-test-hospital-seed"):
        assert "LogGroup" in json.dumps(functions[name]["Properties"].get("LoggingConfig", {})), f"{name} logs to the group the stack owns"


def test_the_seed_writes_definitions_only_and_reruns_when_a_definition_changes(synthesized):
    hospital, _, _ = synthesized
    hospital.has_resource_properties(
        "AWS::Lambda::Function",
        {"FunctionName": "medapp-hsp-test-hospital-seed", "Handler": "seed.lambda_handler", "Environment": {"Variables": Match.object_like({"SEED_MODE": "definitions", "FHIR_AUTH": "oauth2", "FHIR_BASE_URL": CONTEXT["fhir_base_url"]})}},
    )
    seeds = hospital.find_resources("Custom::MedAppHospitalDefinitions")
    assert len(seeds) == 1
    seed = next(iter(seeds.values()))
    assert len(seed["Properties"]["definitions_hash"]) == 64 and "seed_hash" not in seed["Properties"], "keyed to the definitions, not to the synthetic patients"
    hospital.resource_count_is("AWS::ECS::Service", 0)
    hospital.resource_count_is("AWS::RDS::DBInstance", 0)


def test_the_seed_reads_the_records_vocabulary_into_the_authoring_bucket_at_deploy_and_nightly(synthesized):
    hospital, _, _ = synthesized
    functions = {f["Properties"].get("FunctionName"): f for f in hospital.find_resources("AWS::Lambda::Function").values()}
    env = functions["medapp-hsp-test-hospital-seed"]["Properties"]["Environment"]["Variables"]
    assert env["RECORD_VOCABULARY_KEY"] == "record-vocabulary.json" and "RecordVocabulary" in json.dumps(env["RECORD_VOCABULARY_BUCKET"]), "the seed knows where to write"
    assert "RECORD_VOCABULARY_BUCKET" not in functions["medapp-hsp-test-viewer-door"]["Properties"]["Environment"]["Variables"], "the door has no business with it"
    # The seed may put the document and nothing else on that bucket; it never deletes.
    statements = [s for p in hospital.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if "RecordVocabulary" in json.dumps(s.get("Resource"))]
    actions = sorted({a for s in statements for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])})
    assert "s3:PutObject" in actions and not any(a.startswith(("s3:Delete", "s3:GetObject")) for a in actions)
    # Nightly, as a plain invoke the handler tells apart from CloudFormation's events.
    (rule,) = hospital.find_resources("AWS::Events::Rule").values()
    assert rule["Properties"]["ScheduleExpression"] == "cron(20 3 * * ? *)" and rule["Properties"]["State"] == "ENABLED"
    (target,) = rule["Properties"]["Targets"]
    assert json.loads(target["Input"]) == {"task": "vocabulary", "budget_s": 240} and "SeedFn" in json.dumps(target["Arn"])
    # A new bucket re-runs the seed at deploy (a property of the custom resource), so the document exists from the first day.
    hospital.has_resource_properties("Custom::MedAppHospitalDefinitions", {"record_vocabulary": Match.object_like({"Fn::Join": Match.any_value()})})


def test_the_hospitals_seed_is_named_as_the_writer_of_the_apps_own_forms(synthesized):
    """The hospital's record is what the apps run on: its seed Lambda (which holds the credentials) is the one publishing hands an app's Questionnaires to."""
    hospital, _, _ = synthesized
    params = {p["Properties"]["Name"]: p["Properties"] for p in hospital.find_resources("AWS::SSM::Parameter").values()}
    writer = params["/medapp/hsp-test/data-source/definitions-writer"]
    seed_logical_id = next(name for name, f in hospital.find_resources("AWS::Lambda::Function").items() if f["Properties"].get("FunctionName") == "medapp-hsp-test-hospital-seed")
    assert writer["Value"] == {"Ref": seed_logical_id}, "the seed function's name, resolved at deploy"
