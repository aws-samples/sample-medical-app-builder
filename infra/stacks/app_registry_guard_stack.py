"""
App registry guardrails — lock-down, detection and alerting for the registry's DynamoDB table (optional; deployed
when `app_registry_guard_admin_email` is set in the hospital's file).

What the stack adds, on top of the IAM least-privilege policies the registry already hands its consumers:

1. A **resource policy on the table** that denies item writes (PutItem, UpdateItem, DeleteItem, BatchWriteItem) to every
   principal except the registry write Lambda's role and the operator roles named in `allowed_principal_arns` — a Deny
   that holds even for administrators, so a credential with broad IAM rights still cannot alter an app version.
2. A **CloudTrail trail** (own bucket, log-file validation, access-logged) recording management events and the data
   events of this one table.
3. An **SNS topic with an email subscription** for the alerts.
4. **EventBridge rules** feeding one alert Lambda: a write to the table denied; a write that succeeded from a principal
   other than the writer; tampering with the guardrails themselves (the trail stopped, deleted or changed; the table's
   resource policy put or removed; the table updated). The Lambda turns each into a plain-text email — EventBridge's own
   input transformer would arrive JSON-encoded in the mail — and never touches the registry.

The deny policy is what makes the seed scripts (`scripts/seed-registry.py`, `scripts/reset-registry.py`) fail once this
stack is deployed, unless the role they run under is listed in `allowed_principal_arns`: that is the point of the
guardrail, and the scripts say so when it happens.
"""

from __future__ import annotations

import json
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_cloudtrail as cloudtrail,
    aws_dynamodb as dynamodb,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    aws_lambda as lam,
    aws_s3 as s3,
    aws_sns as sns,
    aws_sns_subscriptions as subscriptions,
    custom_resources as cr,
)
from constructs import Construct

INFRA_ROOT = Path(__file__).resolve().parents[1]
GUARD_ALERT_ASSET = INFRA_ROOT / "lambdas" / "registry_guard_alert"

WRITE_ACTIONS = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]
WRITE_EVENTS = ["PutItem", "UpdateItem", "DeleteItem", "BatchWriteItem"]


class AppRegistryGuardStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        hospital_id: str,
        table: dynamodb.ITableV2,
        writer_role: iam.IRole,
        admin_email: str,
        allowed_principal_arns: list[str] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "registry-guard")

        allowed = [writer_role.role_arn, *(allowed_principal_arns or [])]

        # ── The alert Lambda: reads the event, writes an email. No registry access of any kind. ──────────────────────
        guard_alert_fn = lam.Function(
            self, "AppRegistryGuardAlert",
            function_name=f"medapp-{hospital_id}-registry-guard-alert",
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="handler.lambda_handler",
            timeout=Duration.seconds(30),
            code=lam.Code.from_asset(str(GUARD_ALERT_ASSET), exclude=["__pycache__", "*.pyc"]),
            description="Registry guardrails: a denied, unauthorised or tampering event as a plain-text alert email",
        )

        # ── 1. The deny policy on the table ──────────────────────────────────────────────────────────────────────────
        # A table resource policy is set through the API (no CloudFormation property on the table from another stack),
        # so a custom resource puts it on create/update and removes it on delete. Only the registry write Lambda's role
        # (and the operator roles named at synth) may write items; the condition is on the role ARN, which is what
        # aws:PrincipalArn resolves to for an assumed-role session.
        deny_policy_document = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "DenyWritesExceptApprovedRoles",
                    "Effect": "Deny",
                    "Principal": "*",
                    "Action": WRITE_ACTIONS,
                    "Resource": table.table_arn,
                    "Condition": {"StringNotEquals": {"aws:PrincipalArn": allowed}},
                }
            ],
        }
        put_policy = cr.AwsSdkCall(
            service="DynamoDB",
            action="putResourcePolicy",
            parameters={"ResourceArn": table.table_arn, "Policy": Stack.of(self).to_json_string(deny_policy_document)},
            physical_resource_id=cr.PhysicalResourceId.of(f"{construct_id}-AppRegistryDenyPolicy"),
        )
        cr.AwsCustomResource(
            self, "AppRegistryDenyPolicy",
            install_latest_aws_sdk=False,
            on_create=put_policy,
            on_update=put_policy,
            on_delete=cr.AwsSdkCall(service="DynamoDB", action="deleteResourcePolicy", parameters={"ResourceArn": table.table_arn}),
            policy=cr.AwsCustomResourcePolicy.from_statements(
                [iam.PolicyStatement(effect=iam.Effect.ALLOW, actions=["dynamodb:PutResourcePolicy", "dynamodb:DeleteResourcePolicy"], resources=[table.table_arn])]
            ),
        )

        # ── 2. The trail: management events, and the data events of this table ──────────────────────────────────────
        access_logs_bucket = s3.Bucket(
            self, "AppRegistryTrailAccessLogs",
            encryption=s3.BucketEncryption.S3_MANAGED,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            object_ownership=s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
            removal_policy=RemovalPolicy.RETAIN,
        )
        trail_bucket = s3.Bucket(
            self, "AppRegistryTrailBucket",
            encryption=s3.BucketEncryption.S3_MANAGED,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            server_access_logs_bucket=access_logs_bucket,
            server_access_logs_prefix="trail-bucket-access/",
            removal_policy=RemovalPolicy.RETAIN,
        )
        trail = cloudtrail.Trail(
            self, "AppRegistryAuditTrail",
            trail_name=f"medapp-{hospital_id}-registry-guard",
            bucket=trail_bucket,
            is_multi_region_trail=False,
            include_global_service_events=True,
            enable_file_validation=True,
        )
        cfn_trail: cloudtrail.CfnTrail = trail.node.default_child  # type: ignore[assignment]
        cfn_trail.advanced_event_selectors = [
            cloudtrail.CfnTrail.AdvancedEventSelectorProperty(
                name="ManagementEventsAll",
                field_selectors=[cloudtrail.CfnTrail.AdvancedFieldSelectorProperty(field="eventCategory", equal_to=["Management"])],
            ),
            cloudtrail.CfnTrail.AdvancedEventSelectorProperty(
                name="AppRegistryTableDataEvents",
                field_selectors=[
                    cloudtrail.CfnTrail.AdvancedFieldSelectorProperty(field="eventCategory", equal_to=["Data"]),
                    cloudtrail.CfnTrail.AdvancedFieldSelectorProperty(field="resources.type", equal_to=["AWS::DynamoDB::Table"]),
                    cloudtrail.CfnTrail.AdvancedFieldSelectorProperty(field="resources.ARN", equal_to=[table.table_arn]),
                ],
            ),
        ]

        # ── 3. The alert channel ────────────────────────────────────────────────────────────────────────────────────
        alert_topic = sns.Topic(self, "AppRegistryAlerts", display_name="App Registry Security Alerts", enforce_ssl=True)
        alert_topic.add_subscription(subscriptions.EmailSubscription(admin_email))
        alert_topic.grant_publish(guard_alert_fn)
        guard_alert_fn.add_environment("ALERT_TOPIC_ARN", alert_topic.topic_arn)
        guard_alert_fn.add_environment("HOSPITAL_ID", hospital_id)

        # ── 4. The rules, each telling the Lambda what kind of event it carries ─────────────────────────────────────
        def alert(kind: str) -> targets.LambdaFunction:
            return targets.LambdaFunction(guard_alert_fn, event=events.RuleTargetInput.from_object({"guardrailAlertKind": kind, "detail": events.EventField.from_path("$.detail")}))

        table_writes = {"eventSource": ["dynamodb.amazonaws.com"], "eventName": WRITE_EVENTS, "requestParameters": {"tableName": [table.table_name]}}
        events.Rule(
            self, "Rule1BlockedWrites",
            description="A write to the app registry table was denied",
            event_pattern=events.EventPattern(source=["aws.dynamodb"], detail_type=["AWS API Call via CloudTrail"], detail={**table_writes, "errorCode": ["AccessDenied", "AccessDeniedException"]}),
            targets=[alert("blocked_write")],
        )
        events.Rule(
            self, "Rule2UnauthorizedWrites",
            description="A write to the app registry table succeeded from a principal other than the registry writer",
            event_pattern=events.EventPattern(
                source=["aws.dynamodb"],
                detail_type=["AWS API Call via CloudTrail"],
                detail={**table_writes, "errorCode": [{"exists": False}], "userIdentity": {"sessionContext": {"sessionIssuer": {"arn": [{"anything-but": allowed}]}}}},
            ),
            targets=[alert("unauthorized_write")],
        )
        # Tampering, scoped to this table and this trail — an UpdateTable elsewhere in the account is not our business.
        events.Rule(
            self, "Rule3TableTampering",
            description="The app registry table or its resource policy was changed",
            event_pattern=events.EventPattern(
                source=["aws.dynamodb"],
                detail_type=["AWS API Call via CloudTrail"],
                detail={"eventSource": ["dynamodb.amazonaws.com"], "eventName": ["PutResourcePolicy", "DeleteResourcePolicy", "UpdateTable", "DeleteTable", "DisableKinesisStreamingDestination"], "requestParameters": {"$or": [{"tableName": [table.table_name]}, {"resourceArn": [table.table_arn]}]}},
            ),
            targets=[alert("tampering")],
        )
        events.Rule(
            self, "Rule4TrailTampering",
            description="The guardrail trail was stopped, deleted or changed",
            event_pattern=events.EventPattern(
                source=["aws.cloudtrail"],
                detail_type=["AWS API Call via CloudTrail"],
                detail={"eventSource": ["cloudtrail.amazonaws.com"], "eventName": ["StopLogging", "DeleteTrail", "UpdateTrail", "PutEventSelectors"], "requestParameters": {"name": [trail.trail_arn, f"medapp-{hospital_id}-registry-guard"]}},
            ),
            targets=[alert("tampering")],
        )

        CfnOutput(self, "AlertTopicArn", value=alert_topic.topic_arn, description="SNS topic the guardrail alerts are published to")
        CfnOutput(self, "GuardAlertFunctionName", value=guard_alert_fn.function_name)
        CfnOutput(self, "TrailBucketName", value=trail_bucket.bucket_name, description="CloudTrail logs: management events and the registry table's data events")
        CfnOutput(self, "AllowedWriters", value=Stack.of(self).to_json_string(allowed), description="The only principals the table's resource policy lets write items")
