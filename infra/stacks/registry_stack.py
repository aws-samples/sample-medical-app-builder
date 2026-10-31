"""
App registry — DynamoDB table + KMS key for one hospital deployment.

Design: infra/docs/registry-table.md. Key points encoded here:
  - single table, generic PK/SK, one sparse GSI with an INCLUDE projection (manifest bodies never
    land in the index)
  - customer-managed KMS key per hospital, PITR, deletion protection, RETAIN on delete
  - DynamoDB Streams enabled so an integrity monitor can alarm if a manifest is ever modified
  - discovery via SSM parameters so the API, pipeline and dispatcher stacks never hard-code names
"""

from __future__ import annotations

from aws_cdk import (
    CfnOutput,
    RemovalPolicy,
    Stack,
    Tags,
    aws_dynamodb as dynamodb,
    aws_iam as iam,
    aws_kms as kms,
    aws_ssm as ssm
)
from constructs import Construct
from medapp_shared.registry_model import GSI1_PROJECTED_ATTRIBUTES, LIFECYCLE_MUTABLE_ATTRIBUTES

# Attributes projected into GSI1 (declared with the model, so readers and their test doubles see the same list). List
# views (launcher, review queue) need exactly these and never the manifest body; a collection's app_ids are fetched by key.


class RegistryStack(Stack):
    """
    App registry for one hospital.
    """

    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "registry")

        self.key = kms.Key(
            self,"RegistryKey",
            alias=f"alias/medapp/{hospital_id}/registry",
            description=f"MedApp app registry encryption key ({hospital_id})",
            enable_key_rotation=True,
            removal_policy=RemovalPolicy.RETAIN,
        )

        self.table = dynamodb.TableV2(
            self,"AppRegistry",
            table_name=f"medapp-{hospital_id}-registry",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            encryption=dynamodb.TableEncryptionV2.customer_managed_key(self.key),
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            deletion_protection=True,
            dynamo_stream=dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removal_policy=RemovalPolicy.RETAIN,
            global_secondary_indexes=[
                dynamodb.GlobalSecondaryIndexPropsV2(
                    index_name="GSI1",
                    partition_key=dynamodb.Attribute(name="GSI1PK", type=dynamodb.AttributeType.STRING),
                    sort_key=dynamodb.Attribute(name="GSI1SK", type=dynamodb.AttributeType.STRING),
                    projection_type=dynamodb.ProjectionType.INCLUDE,
                    non_key_attributes=list(GSI1_PROJECTED_ATTRIBUTES),
                )
            ],
        )

        # ── Least-privilege policies for the consumers (attach to their Lambda roles) ─────────
        # Read-only: registry API (GET), pre-token Lambda, dispatcher hot path.
        self.read_policy = iam.ManagedPolicy(
            self,"RegistryReadPolicy",
            managed_policy_name=f"medapp-{hospital_id}-registry-read",
            statements=[
                iam.PolicyStatement(
                    actions=["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"],
                    resources=[self.table.table_arn, f"{self.table.table_arn}/index/*"],
                ),
                iam.PolicyStatement(actions=["kms:Decrypt"], resources=[self.key.key_arn]),
            ],
        )

        # Pipeline writer: may create VERSION/EVENT items and maintain HEAD, never delete.
        self.writer_policy = iam.ManagedPolicy(
            self,"RegistryWriterPolicy",
            managed_policy_name=f"medapp-{hospital_id}-registry-writer",
            statements=[
                iam.PolicyStatement(
                    actions=["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"],
                    resources=[self.table.table_arn, f"{self.table.table_arn}/index/*"],
                ),
                iam.PolicyStatement(actions=["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"], resources=[self.key.key_arn]),
            ],
        )

        # Lifecycle writer: UpdateItem restricted to the mutable attribute set — a bug in this
        # Lambda physically cannot alter manifest_json. Keys must be listed for UpdateItem.
        self.lifecycle_policy = iam.ManagedPolicy(
            self,"RegistryLifecyclePolicy",
            managed_policy_name=f"medapp-{hospital_id}-registry-lifecycle",
            statements=[
                iam.PolicyStatement(
                    actions=["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
                    resources=[self.table.table_arn],
                    conditions={
                        "ForAllValues:StringEquals": {
                            "dynamodb:Attributes": ["PK", "SK", *LIFECYCLE_MUTABLE_ATTRIBUTES, "active_version", "latest_state"]
                        },
                        "StringEqualsIfExists": {"dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"]},
                    },
                ),
                iam.PolicyStatement(actions=["dynamodb:PutItem"], resources=[self.table.table_arn]),  # EVENT items
                iam.PolicyStatement(
                    actions=["dynamodb:GetItem", "dynamodb:Query"],
                    resources=[self.table.table_arn, f"{self.table.table_arn}/index/*"],
                ),
                iam.PolicyStatement(actions=["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"], resources=[self.key.key_arn]),
            ],
        )

        # ── Discovery for sibling stacks ─────────────────────────────────────────────────────
        prefix = f"/medapp/{hospital_id}/registry"
        ssm.StringParameter(self, "TableNameParam", parameter_name=f"{prefix}/table-name", string_value=self.table.table_name)
        ssm.StringParameter(self, "TableArnParam", parameter_name=f"{prefix}/table-arn", string_value=self.table.table_arn)
        ssm.StringParameter(self, "StreamArnParam", parameter_name=f"{prefix}/stream-arn", string_value=self.table.table_stream_arn or "")
        ssm.StringParameter(self, "KeyArnParam", parameter_name=f"{prefix}/kms-key-arn", string_value=self.key.key_arn)

        CfnOutput(self, "TableName", value=self.table.table_name)
        CfnOutput(self, "TableArn", value=self.table.table_arn)
        CfnOutput(self, "StreamArn", value=self.table.table_stream_arn or "")
        CfnOutput(self, "KeyArn", value=self.key.key_arn)
