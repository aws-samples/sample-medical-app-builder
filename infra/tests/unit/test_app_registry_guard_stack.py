"""
The app registry guardrails stack: a table resource policy that lets only the writer role (and the named operator
roles) write items, a trail on the table, alerts for denied writes, foreign writes and tampering — and an alert Lambda
that can publish and nothing else. Synthesised against a real RegistryStack and a stand-in writer role.
"""

from __future__ import annotations

import json

import aws_cdk as cdk
import pytest
from aws_cdk import aws_iam as iam
from aws_cdk.assertions import Match, Template

from stacks import AppRegistryGuardStack, RegistryStack

ENV = cdk.Environment(account="111111111111", region="eu-central-1")
OPERATOR = "arn:aws:iam::111111111111:role/medapp-operators"


@pytest.fixture(scope="module")
def synthesized():
    app = cdk.App()
    registry = RegistryStack(app, "RegistryStack", hospital_id="hsp-test", env=ENV)
    deps = cdk.Stack(app, "Deps", env=ENV)
    writer = iam.Role(deps, "Writer", assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"))
    guard = AppRegistryGuardStack(app, "AppRegistryGuardStack", hospital_id="hsp-test", table=registry.table, writer_role=writer, admin_email="sysadmin@example.org", allowed_principal_arns=[OPERATOR], env=ENV)
    return Template.from_stack(guard)


def _statements(template: Template, substring: str) -> list[dict]:
    return [s for p in template.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if substring in json.dumps(s)]


def test_the_table_gets_a_deny_policy_that_spares_only_the_writer_and_the_named_operators(synthesized):
    resources = synthesized.find_resources("Custom::AWS")
    assert len(resources) == 1
    (policy_cr,) = resources.values()
    # The SDK call is a JSON string with tokens joined in (Fn::Join), so the words are asserted on the raw text.
    text = json.dumps(policy_cr["Properties"]["Create"])
    assert "putResourcePolicy" in text and "deleteResourcePolicy" in json.dumps(policy_cr["Properties"]["Delete"])
    assert "DenyWritesExceptApprovedRoles" in text and "dynamodb:PutItem" in text and "dynamodb:DeleteItem" in text and "dynamodb:BatchWriteItem" in text
    assert "aws:PrincipalArn" in text and OPERATOR in text, "the operator role is spared alongside the writer"
    # The provider may put and delete that policy on this table and nothing else.
    statements = _statements(synthesized, "PutResourcePolicy")
    assert statements and sorted(statements[0]["Action"]) == ["dynamodb:DeleteResourcePolicy", "dynamodb:PutResourcePolicy"]
    assert all("medapp-hsp-test-registry" in json.dumps(s["Resource"]) or "Fn::ImportValue" in json.dumps(s["Resource"]) for s in statements)


def test_the_trail_logs_management_events_and_this_tables_data_events_into_a_private_validated_bucket(synthesized):
    trails = synthesized.find_resources("AWS::CloudTrail::Trail")
    assert len(trails) == 1
    (trail,) = trails.values()
    props = trail["Properties"]
    assert props["TrailName"] == "medapp-hsp-test-registry-guard" and props["EnableLogFileValidation"] is True and props["IsMultiRegionTrail"] is False
    selectors = props["AdvancedEventSelectors"]
    assert [s["Name"] for s in selectors] == ["ManagementEventsAll", "AppRegistryTableDataEvents"]
    data = json.dumps(selectors[1])
    assert "AWS::DynamoDB::Table" in data and "resources.ARN" in data
    buckets = synthesized.find_resources("AWS::S3::Bucket")
    assert len(buckets) == 2
    for b in buckets.values():
        assert b["Properties"]["PublicAccessBlockConfiguration"]["BlockPublicAcls"] is True
        assert b["DeletionPolicy"] == "Retain"
    policy = json.dumps(synthesized.find_resources("AWS::S3::BucketPolicy"))
    assert '"aws:SecureTransport": "false"' in policy or '"aws:SecureTransport":"false"' in policy


def test_alerts_reach_an_email_subscription_through_a_lambda_that_may_publish_and_nothing_else(synthesized):
    synthesized.has_resource_properties("AWS::SNS::Subscription", {"Protocol": "email", "Endpoint": "sysadmin@example.org"})
    synthesized.has_resource_properties("AWS::Lambda::Function", {"FunctionName": "medapp-hsp-test-registry-guard-alert", "Runtime": "python3.14", "Environment": {"Variables": Match.object_like({"ALERT_TOPIC_ARN": Match.any_value(), "HOSPITAL_ID": "hsp-test"})}})
    statements = [s for p in synthesized.find_resources("AWS::IAM::Policy").values() for s in p["Properties"]["PolicyDocument"]["Statement"] if "GuardAlert" in json.dumps(p["Properties"]["Roles"])]
    actions = sorted({a for s in statements for a in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])})
    assert actions == ["sns:Publish"], "no dynamodb, no s3 — the alert Lambda never touches the registry"


def test_four_rules_name_this_table_and_this_trail_and_feed_the_alert_lambda(synthesized):
    rules = synthesized.find_resources("AWS::Events::Rule")
    assert len(rules) == 4
    by_name = {name: r["Properties"] for name, r in rules.items()}
    blocked = next(p for n, p in by_name.items() if "Rule1" in n)
    assert blocked["EventPattern"]["detail"]["errorCode"] == ["AccessDenied", "AccessDeniedException"]
    assert "tableName" in json.dumps(blocked["EventPattern"]["detail"]["requestParameters"])
    foreign = next(p for n, p in by_name.items() if "Rule2" in n)
    assert foreign["EventPattern"]["detail"]["errorCode"] == [{"exists": False}]
    anything_but = foreign["EventPattern"]["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["arn"][0]["anything-but"]
    assert OPERATOR in json.dumps(anything_but) and len(anything_but) == 2, "writer and operator both exempt"
    table_tamper = next(p for n, p in by_name.items() if "Rule3" in n)
    assert "$or" in table_tamper["EventPattern"]["detail"]["requestParameters"] and "UpdateTable" in table_tamper["EventPattern"]["detail"]["eventName"]
    trail_tamper = next(p for n, p in by_name.items() if "Rule4" in n)
    assert trail_tamper["EventPattern"]["source"] == ["aws.cloudtrail"] and "StopLogging" in trail_tamper["EventPattern"]["detail"]["eventName"]
    assert "medapp-hsp-test-registry-guard" in json.dumps(trail_tamper["EventPattern"]["detail"]["requestParameters"]["name"])
    for p in by_name.values():
        (target,) = p["Targets"]
        assert "guardrailAlertKind" in target["InputTransformer"]["InputTemplate"]
    synthesized.has_output("AllowedWriters", {})
    synthesized.has_output("AlertTopicArn", {})
