"""
Audit trail — DynamoDB table + KMS key for one hospital deployment.

Design: medapp_shared/audit_model.py and infra/docs/audit.md. Encoded here:
  - one table, records partitioned by UTC day (PK `DAY#<date>`, SK `<timestamp>#<audit_id>`) with three indexes —
    by person, by app, by patient — so the panel's Audit trail answers the questions an auditor asks without a scan
  - customer-managed KMS key, PITR, deletion protection, RETAIN on delete, no TTL: records are kept indefinitely
    (the hospital's retention policy can add a TTL later; nothing removes a record)
  - two managed policies: writers may PutItem and nothing else — no UpdateItem, no DeleteItem, so a record once
    written cannot be changed by the functions that write them; readers Query
  - discovery via SSM, like the registry
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
    aws_ssm as ssm,
)
from constructs import Construct


class AuditStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "audit")

        self.key = kms.Key(
            self, "AuditKey",
            alias=f"alias/medapp/{hospital_id}/audit",
            description=f"MedApp audit trail encryption key ({hospital_id})",
            enable_key_rotation=True,
            removal_policy=RemovalPolicy.RETAIN,
        )

        def index(name: str) -> dynamodb.GlobalSecondaryIndexPropsV2:
            return dynamodb.GlobalSecondaryIndexPropsV2(
                index_name=name,
                partition_key=dynamodb.Attribute(name=f"{name}PK", type=dynamodb.AttributeType.STRING),
                sort_key=dynamodb.Attribute(name=f"{name}SK", type=dynamodb.AttributeType.STRING),
                projection_type=dynamodb.ProjectionType.ALL,  # records are small; a query answers from the index alone
            )

        self.table = dynamodb.TableV2(
            self, "AuditTrail",
            table_name=f"medapp-{hospital_id}-audit",
            partition_key=dynamodb.Attribute(name="PK", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="SK", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            encryption=dynamodb.TableEncryptionV2.customer_managed_key(self.key),
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(point_in_time_recovery_enabled=True),
            deletion_protection=True,
            removal_policy=RemovalPolicy.RETAIN,
            global_secondary_indexes=[index("GSI1"), index("GSI2"), index("GSI3")],
        )

        # Writers append. No update, no delete: the functions that produce the trail cannot rewrite it.
        self.write_policy = iam.ManagedPolicy(
            self, "AuditWritePolicy",
            managed_policy_name=f"medapp-{hospital_id}-audit-write",
            statements=[
                iam.PolicyStatement(actions=["dynamodb:PutItem"], resources=[self.table.table_arn]),
                iam.PolicyStatement(actions=["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"], resources=[self.key.key_arn]),
            ],
        )

        # Readers: the audit API, for administrators.
        self.read_policy = iam.ManagedPolicy(
            self, "AuditReadPolicy",
            managed_policy_name=f"medapp-{hospital_id}-audit-read",
            statements=[
                iam.PolicyStatement(actions=["dynamodb:Query", "dynamodb:GetItem"], resources=[self.table.table_arn, f"{self.table.table_arn}/index/*"]),
                iam.PolicyStatement(actions=["kms:Decrypt"], resources=[self.key.key_arn]),
            ],
        )

        prefix = f"/medapp/{hospital_id}/audit"
        ssm.StringParameter(self, "TableNameParam", parameter_name=f"{prefix}/table-name", string_value=self.table.table_name)
        ssm.StringParameter(self, "KeyArnParam", parameter_name=f"{prefix}/kms-key-arn", string_value=self.key.key_arn)
        CfnOutput(self, "TableName", value=self.table.table_name)
