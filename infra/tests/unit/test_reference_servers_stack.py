"""
The reference servers stack, synthesised: the shape the docstring promises — no NAT gateway, an internal
load balancer, a database nobody can reach from outside the VPC, an IAM-authorised API in front of HAPI, a seed
that re-runs when the bundle changes — and the way app.py wires the dispatcher to it.
"""

import json

import aws_cdk as cdk
import pytest
from aws_cdk import aws_cognito as cognito, aws_dynamodb as dynamodb, aws_iam as iam, aws_s3 as s3
from aws_cdk.assertions import Match, Template

from stacks import ApiStack, ReferenceServersStack
from stacks.reference_servers_stack import AWS_CLI_IMAGE, HAPI_IMAGE, ORTHANC_IMAGE, hapi_settings

ENV = cdk.Environment(account="111111111111", region="eu-central-1")


@pytest.fixture(scope="module")
def synthesized():
    app = cdk.App()
    deps = cdk.Stack(app, "Deps", env=ENV)
    vocabulary = s3.Bucket(deps, "RecordVocabulary")  # the authoring stack's; the reference seed writes it while the reference record is the data source
    reference = ReferenceServersStack(app, "ReferenceServersStack", hospital_id="hsp-test", vocabulary_bucket=vocabulary, env=ENV)

    table = dynamodb.TableV2(deps, "Table", partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING), sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING))
    read_policy = iam.ManagedPolicy(deps, "Read", statements=[iam.PolicyStatement(actions=["dynamodb:GetItem"], resources=[table.table_arn])])
    pool = cognito.UserPool(deps, "Pool")
    client = pool.add_client("Web")
    audit_table = dynamodb.TableV2(deps, "Audit", partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING), sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING))
    audit_write = iam.ManagedPolicy(deps, "AuditWrite", managed_policy_name="audit-write", statements=[iam.PolicyStatement(actions=["dynamodb:PutItem"], resources=[audit_table.table_arn])])
    audit_read = iam.ManagedPolicy(deps, "AuditRead", managed_policy_name="audit-read", statements=[iam.PolicyStatement(actions=["dynamodb:Query"], resources=[audit_table.table_arn])])

    api = ApiStack(
        app, "ApiStack",
        hospital_id="hsp-test",
        table=table,
        registry_read_policy=read_policy,
        user_pool=pool,
        web_client=client,
        frontend_origins=["http://localhost:5173"],
        data_source="fhir",
        fhir_base_url=reference.fhir_base_url,
        fhir_auth="sigv4",
        dicomweb_base_url=reference.dicomweb_base_url,
        audit_table=audit_table,
        audit_write_policy=audit_write,
        audit_read_policy=audit_read,
        env=ENV,
    )
    reference.grant_invoke(api.dispatcher_fn)
    return Template.from_stack(reference), Template.from_stack(api)


def test_network_has_no_nat_gateway_and_the_load_balancer_is_internal(synthesized):
    reference, _ = synthesized
    reference.resource_count_is("AWS::EC2::NatGateway", 0)
    reference.resource_count_is("AWS::EC2::VPCEndpoint", 0)
    reference.has_resource_properties("AWS::ElasticLoadBalancingV2::LoadBalancer", {"Scheme": "internal", "Type": "application"})
    # Only the VPC link's security group may talk to the load balancer, only the load balancer to the task, only the task to the database.
    reference.has_resource_properties("AWS::EC2::SecurityGroupIngress", {"FromPort": 80, "ToPort": 80, "IpProtocol": "tcp"})
    reference.has_resource_properties("AWS::EC2::SecurityGroupIngress", {"FromPort": 8080, "ToPort": 8080, "IpProtocol": "tcp"})
    reference.has_resource_properties("AWS::EC2::SecurityGroupIngress", {"FromPort": 5432, "ToPort": 5432, "IpProtocol": "tcp"})


def test_database_is_private_encrypted_and_disposable(synthesized):
    reference, _ = synthesized
    reference.has_resource_properties(
        "AWS::RDS::DBInstance",
        {"Engine": "postgres", "DBInstanceClass": "db.t4g.micro", "PubliclyAccessible": False, "StorageEncrypted": True, "MultiAZ": False, "DBName": "hapi", "DeletionProtection": False},
    )
    reference.has_resource("AWS::RDS::DBInstance", {"DeletionPolicy": "Delete"})
    # Credentials are generated, never literal.
    reference.has_resource_properties("AWS::SecretsManager::Secret", {"Name": "medapp/hsp-test/reference/hapi-db", "GenerateSecretString": Match.object_like({"SecretStringTemplate": '{"username":"hapi"}'})})


def test_hapi_runs_pinned_on_arm_with_the_settings_a_reference_server_needs(synthesized):
    reference, _ = synthesized
    reference.has_resource_properties(
        "AWS::ECS::TaskDefinition",
        {
            "Cpu": "1024",
            "Memory": "2048",
            "RuntimePlatform": {"CpuArchitecture": "ARM64", "OperatingSystemFamily": "LINUX"},
            "ContainerDefinitions": [
                Match.object_like(
                    {
                        "Image": HAPI_IMAGE,
                        "PortMappings": [Match.object_like({"ContainerPort": 8080})],
                        "Secrets": Match.array_with([Match.object_like({"Name": "SPRING_DATASOURCE_USERNAME"}), Match.object_like({"Name": "SPRING_DATASOURCE_PASSWORD"})]),
                    }
                )
            ],
        },
    )
    settings = hapi_settings("https://example.execute-api.eu-central-1.amazonaws.com/fhir")
    assert settings["hapi"]["fhir"]["reuse_cached_search_results_millis"] == 0, "a reading recorded a second ago must be in the next search"
    assert settings["hapi"]["fhir"]["allow_external_references"] is True, "canonical questionnaire references are external URLs"
    assert settings["hapi"]["fhir"]["server_address"].endswith("/fhir"), "links must point at the API, not the load balancer"
    assert settings["spring"]["ai"]["mcp"]["server"]["enabled"] is False
    # The health check is the actuator's, not /fhir/metadata (which loads the whole capability statement).
    reference.has_resource_properties("AWS::ElasticLoadBalancingV2::TargetGroup", {"HealthCheckPath": "/actuator/health", "Port": 8080})
    reference.has_resource_properties("AWS::ECS::Service", {"DesiredCount": 1, "DeploymentConfiguration": Match.object_like({"MinimumHealthyPercent": 0, "MaximumPercent": 100, "DeploymentCircuitBreaker": {"Enable": True, "Rollback": True}})})


def test_the_api_admits_only_iam_signed_requests_to_fhir_and_dicomweb(synthesized):
    reference, _ = synthesized
    routes = reference.find_resources("AWS::ApiGatewayV2::Route")
    keys = sorted(r["Properties"]["RouteKey"] for r in routes.values())
    assert keys == ["ANY /dicom-web", "ANY /dicom-web/{proxy+}", "ANY /fhir", "ANY /fhir/{proxy+}"]
    assert all(r["Properties"]["AuthorizationType"] == "AWS_IAM" for r in routes.values()), "every route is IAM-authorised"
    reference.has_resource_properties("AWS::ApiGatewayV2::Integration", {"IntegrationType": "HTTP_PROXY", "ConnectionType": "VPC_LINK", "IntegrationMethod": "ANY"})
    reference.resource_count_is("AWS::ApiGatewayV2::VpcLink", 1)
    # One load balancer, two targets: the path decides — /dicom-web* to Orthanc, the rest to HAPI.
    reference.resource_count_is("AWS::ElasticLoadBalancingV2::LoadBalancer", 1)
    reference.resource_count_is("AWS::ElasticLoadBalancingV2::TargetGroup", 2)
    reference.has_resource_properties("AWS::ElasticLoadBalancingV2::ListenerRule", {"Priority": 10, "Conditions": [{"Field": "path-pattern", "PathPatternConfig": {"Values": ["/dicom-web", "/dicom-web/*"]}}]})
    reference.has_resource_properties("AWS::ElasticLoadBalancingV2::TargetGroup", {"HealthCheckPath": "/system", "Port": 8042})


def test_orthanc_publishes_the_generated_seed_and_needs_no_persistence(synthesized):
    reference, _ = synthesized
    task = next(r for r in reference.find_resources("AWS::ECS::TaskDefinition").values() if any(c["Name"] == "orthanc" for c in r["Properties"]["ContainerDefinitions"]))
    containers = {c["Name"]: c for c in task["Properties"]["ContainerDefinitions"]}
    assert set(containers) == {"seed-sync", "orthanc"}
    assert containers["seed-sync"]["Essential"] is False and containers["seed-sync"]["Image"] == AWS_CLI_IMAGE
    assert containers["seed-sync"]["Command"][:2] == ["s3", "sync"] and containers["seed-sync"]["Command"][3] == "/seed"
    assert containers["orthanc"]["DependsOn"] == [{"Condition": "SUCCESS", "ContainerName": "seed-sync"}], "Orthanc starts once the seed is on disk"
    assert containers["orthanc"]["Image"] == ORTHANC_IMAGE
    env = {e["Name"]: e["Value"] for e in containers["orthanc"]["Environment"]}
    # ORTHANC_JSON carries the API URL (PublicRoot), so CloudFormation renders it as Fn::Join: flatten the literal parts.
    raw = env["ORTHANC_JSON"]
    text = raw if isinstance(raw, str) else "".join(part if isinstance(part, str) else "https://api.example" for part in raw["Fn::Join"][1])
    settings = json.loads(text)
    assert settings["DicomWeb"]["PublicRoot"].endswith("/viewer/dicom-web/"), "links Orthanc writes point at the browser door"
    assert settings["AuthenticationEnabled"] is False and settings["DicomServerEnabled"] is False, "no auth of its own (the API is the door), no DICOM network port"
    assert settings["Indexer"] == {"Enable": True, "Folders": ["/seed"], "Interval": 10} and settings["DicomWeb"]["Root"] == "/dicom-web/"
    assert env["DICOM_WEB_PLUGIN_ENABLED"] == "true" and env["INDEXER_PLUGIN_ENABLED"] == "true"
    assert len(env["MEDAPP_SEED_DIGEST"]) == 64, "the seed hash is in the task definition: a new seed is a new revision, so ECS replaces the task and the init container copies the new files"
    mounts = {c["Name"]: c["MountPoints"][0] for c in containers.values()}
    assert mounts["seed-sync"]["ReadOnly"] is False and mounts["orthanc"]["ReadOnly"] is True and mounts["orthanc"]["ContainerPath"] == "/seed"
    reference.resource_count_is("AWS::EFS::FileSystem", 0)
    # The seed lives in a private bucket the task may read; the deployment copies the generated studies there.
    reference.has_resource_properties("AWS::S3::Bucket", {"PublicAccessBlockConfiguration": Match.object_like({"BlockPublicAcls": True, "RestrictPublicBuckets": True})})
    reference.has_resource_properties("Custom::CDKBucketDeployment", {"DestinationBucketKeyPrefix": "dicom", "Prune": True})
    statements = [s for p in reference.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"]]
    assert any("s3:GetObject*" in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]]) for s in statements), "the task role reads the seed bucket"


def test_the_seed_runs_after_the_service_and_again_when_the_bundle_changes(synthesized):
    reference, _ = synthesized
    seeds = reference.find_resources("Custom::MedAppReferenceSeed")
    assert len(seeds) == 1
    seed = next(iter(seeds.values()))
    assert len(seed["Properties"]["seed_hash"]) == 64, "the bundle's sha256 is a property: a changed seed is a changed resource"
    assert any("HapiService" in dep for dep in seed.get("DependsOn", [])), "the seed waits for the service to be stable"
    assert len(seed["Properties"]["dicom_seed_hash"]) == 64, "and the generated studies' hash: a changed imaging seed re-verifies the PACS"
    assert seed["Properties"]["dicom_seed_marker"] == f"dicom-seed-2 {seed['Properties']['dicom_seed_hash'][:12]}", "what every served instance must say in SoftwareVersions"
    assert any("OrthancService" in dep for dep in seed.get("DependsOn", [])), "the seed waits for the PACS too"
    reference.has_resource_properties(
        "AWS::Lambda::Function",
        {"Handler": "seed.lambda_handler", "Environment": {"Variables": Match.object_like({"FHIR_AUTH": "sigv4", "HOSPITAL_ID": "hsp-test", "DICOMWEB_BASE_URL": Match.any_value(), "DICOM_VERIFY_WAIT_S": "150"})}},
    )
    reference.has_resource_properties("AWS::SSM::Parameter", {"Name": "/medapp/hsp-test/reference/fhir-base-url"})
    reference.has_resource_properties("AWS::SSM::Parameter", {"Name": "/medapp/hsp-test/reference/dicomweb-base-url"})


def test_the_dispatcher_is_pointed_at_the_reference_server_and_allowed_to_call_it(synthesized):
    _, api = synthesized
    api.has_resource_properties(
        "AWS::Lambda::Function",
        {"Handler": "handler.lambda_handler", "Description": Match.string_like_regexp("Primitive dispatcher.*"), "Environment": {"Variables": Match.object_like({"DATA_SOURCE": "fhir", "FHIR_AUTH": "sigv4", "FHIR_BASE_URL": Match.any_value()})}},
    )
    policies = api.find_resources("AWS::IAM::Policy")
    statements = [s for p in policies.values() for s in p["Properties"]["PolicyDocument"]["Statement"]]
    invoke = [s for s in statements if s.get("Action") == "execute-api:Invoke"]
    assert invoke, "the dispatcher's role may invoke the reference API"
    assert json.dumps(invoke[0]["Resource"]).count("/fhir") >= 1 and json.dumps(invoke[0]["Resource"]).count("/dicom-web") >= 1
    api.has_resource_properties(
        "AWS::Lambda::Function",
        {"Handler": "handler.lambda_handler", "Description": Match.string_like_regexp("Primitive dispatcher.*"), "Environment": {"Variables": Match.object_like({"DICOMWEB_BASE_URL": Match.any_value()})}},
    )


def test_user_administration_runs_behind_the_authorizer_with_the_pools_user_and_group_calls_only(synthesized):
    """Accounts and membership from the panel: five routes on one function whose policy names the user and group calls on this pool — no deletion, no pool or client settings."""
    _, api = synthesized
    api.has_resource_properties(
        "AWS::Lambda::Function",
        {"Handler": "handler.lambda_handler", "Description": Match.string_like_regexp("User administration.*"), "Environment": {"Variables": Match.object_like({"USER_POOL_ID": Match.any_value(), "HOSPITAL_ID": "hsp-test"})}},
    )
    routes = api.find_resources("AWS::ApiGatewayV2::Route")
    keys = {r["Properties"]["RouteKey"] for r in routes.values()}
    assert {"GET /users", "POST /users", "GET /users/groups", "PATCH /users/{username}", "POST /users/{username}/invitation"} <= keys
    assert "DELETE /users/{username}" not in keys
    assert all(r["Properties"].get("AuthorizationType") == "JWT" for r in routes.values() if r["Properties"]["RouteKey"].startswith(("GET /users", "POST /users", "PATCH /users"))), "every users route sits behind the Cognito authorizer"
    statements = [s for p in api.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"]]
    cognito = next(s for s in statements if s.get("Sid") == "UserAdministration")
    assert sorted(cognito["Action"]) == sorted([
        "cognito-idp:ListUsers", "cognito-idp:ListGroups", "cognito-idp:ListUsersInGroup", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup", "cognito-idp:AdminEnableUser", "cognito-idp:AdminDisableUser",
    ])
    assert "AdminDeleteUser" not in json.dumps(cognito) and "Arn" in json.dumps(cognito["Resource"]), "on the pool, nothing wider"


def test_fhir_auth_is_validated():
    app = cdk.App()
    deps = cdk.Stack(app, "Deps", env=ENV)
    table = dynamodb.TableV2(deps, "Table", partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING))
    read_policy = iam.ManagedPolicy(deps, "Read", statements=[iam.PolicyStatement(actions=["dynamodb:GetItem"], resources=[table.table_arn])])
    pool = cognito.UserPool(deps, "Pool")
    client = pool.add_client("Web")
    with pytest.raises(ValueError, match="fhir_auth"):
        ApiStack(app, "ApiStack", hospital_id="hsp-test", table=table, registry_read_policy=read_policy, user_pool=pool, web_client=client, frontend_origins=[], data_source="fhir", fhir_base_url="https://x/fhir", fhir_auth="password", env=ENV)


def test_the_reference_seed_writes_the_records_vocabulary_while_it_is_the_data_source(synthesized):
    reference, _ = synthesized
    functions = {f["Properties"].get("FunctionName"): f for f in reference.find_resources("AWS::Lambda::Function").values()}
    env = functions["medapp-hsp-test-reference-seed"]["Properties"]["Environment"]["Variables"]
    assert env["RECORD_VOCABULARY_KEY"] == "record-vocabulary.json" and "RecordVocabulary" in json.dumps(env["RECORD_VOCABULARY_BUCKET"])
    statements = [s for p in reference.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if "RecordVocabulary" in json.dumps(s.get("Resource"))]
    actions = sorted({a for s in statements for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])})
    assert "s3:PutObject" in actions and not any(a.startswith(("s3:Delete", "s3:GetObject")) for a in actions)
    rules = [r for r in reference.find_resources("AWS::Events::Rule").values() if "vocabulary" in r["Properties"].get("Description", "")]
    assert len(rules) == 1 and rules[0]["Properties"]["ScheduleExpression"] == "cron(20 3 * * ? *)"
    assert json.loads(rules[0]["Properties"]["Targets"][0]["Input"]) == {"task": "vocabulary", "budget_s": 240}
    reference.has_resource_properties("Custom::MedAppReferenceSeed", {"record_vocabulary": Match.object_like({"Fn::Join": Match.any_value()})})


def test_the_reference_seed_is_the_definitions_writer_only_while_the_reference_record_is_the_data_source(synthesized):
    reference, _ = synthesized
    params = {p["Properties"]["Name"]: p["Properties"] for p in reference.find_resources("AWS::SSM::Parameter").values()}
    seed_logical_id = next(name for name, f in reference.find_resources("AWS::Lambda::Function").items() if f["Properties"].get("FunctionName") == "medapp-hsp-test-reference-seed")
    assert params["/medapp/hsp-test/data-source/definitions-writer"]["Value"] == {"Ref": seed_logical_id}
    # Beside a hospital's server the reference record is for previews and tests only: it names no writer, so the parameter is the hospital's alone.
    app = cdk.App()
    deps = cdk.Stack(app, "Deps", env=ENV)
    vocabulary = s3.Bucket(deps, "RecordVocabulary")
    aside = ReferenceServersStack(app, "ReferenceAside", hospital_id="hsp-test", vocabulary_bucket=vocabulary, definitions_writer=False, env=ENV)
    names = [p["Properties"]["Name"] for p in Template.from_stack(aside).find_resources("AWS::SSM::Parameter").values()]
    assert "/medapp/hsp-test/data-source/definitions-writer" not in names


def test_the_audit_trail_is_written_by_the_dispatcher_and_user_administration_and_read_by_its_own_api(synthesized):
    _, api = synthesized
    functions = {f["Properties"].get("FunctionName"): f for f in api.find_resources("AWS::Lambda::Function").values()}
    for name in ("medapp-hsp-test-dispatcher", "medapp-hsp-test-user-admin", "medapp-hsp-test-audit-api"):
        assert "AUDIT_TABLE_NAME" in functions[name]["Properties"]["Environment"]["Variables"], name
    roles = api.find_resources("AWS::IAM::Role")

    def managed(fn_name: str) -> str:
        role_ref = functions[fn_name]["Properties"]["Role"]["Fn::GetAtt"][0]
        return json.dumps(roles[role_ref]["Properties"].get("ManagedPolicyArns", []))

    # Cross-stack policies arrive as imports of the audit stack's exports, named after the constructs.
    assert "AuditWrite" in managed("medapp-hsp-test-dispatcher") and "AuditWrite" in managed("medapp-hsp-test-user-admin")
    assert "AuditRead" in managed("medapp-hsp-test-audit-api") and "AuditWrite" not in managed("medapp-hsp-test-audit-api"), "the reader cannot write the trail it shows"
    keys = {r["Properties"]["RouteKey"]: r["Properties"] for r in api.find_resources("AWS::ApiGatewayV2::Route").values()}
    assert keys["GET /audit"]["AuthorizationType"] == "JWT"
    assert keys["GET /registry/collections"]["AuthorizationType"] == "JWT", "the collections are read through the registry read API"
    assert keys["GET /registry/shapes"]["AuthorizationType"] == "JWT" and keys["GET /registry/shapes/{shape_id}"]["AuthorizationType"] == "JWT", "the shape library too"
