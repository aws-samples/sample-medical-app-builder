"""
Authoring — everything that turns a conversation into a registered app:

  - the drafts table (sessions: spec, conversation, turn state; TTL — working data, not the record)
  - the manifest service (Node.js): the TypeScript compiler from med_app/src/spec as a Lambda — the one
    place a manifest is produced in the deployed platform
  - the drafts API (sync) and the drafting agent worker (async, Strands on Bedrock)
  - the registry write API (create / iterate / lifecycle) with the KMS sign-off key and group provisioning

The API stack adds the HTTP routes in front of these functions. Two things are staged at synth time
from sibling source trees, like the shared layer already is: the manifest service bundle (esbuild in
med_app) and the Python dependency layer for the agent (pip, platform-targeted wheels — no Docker).

Parameters (both defined once in the hospital's file under infra/hospitals/, next to hospital_id):
  model_id       the Bedrock model id or inference profile the drafting agent runs on — required, no library
                 default; use an `eu.` profile for EU data residency
  hospital_name  the display name the agent uses, from the IdentityStack
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from aws_cdk import (
    ArnFormat,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_iam as iam,
    aws_kms as kms,
    aws_lambda as lam,
    aws_s3 as s3,
    aws_ssm as ssm,
)
from constructs import Construct

from .api_stack import INFRA_ROOT, stage_shared_layer
from .definitions import DEFINITIONS_WRITER_PARAMETER

# The object the seed writes and the agent reads (lambdas/dispatcher/vocabulary.py DEFAULT_KEY, app_creator/vocabulary.py DEFAULT_KEY).
RECORD_VOCABULARY_KEY = "record-vocabulary.json"

# The frontend checkout the manifest service and catalog files are staged from (MEDAPP_APP_DIR overrides, as for the agent).
MED_APP = Path(os.environ["MEDAPP_APP_DIR"]).resolve() if os.environ.get("MEDAPP_APP_DIR") else INFRA_ROOT.parent / "med_app"
BUILD = INFRA_ROOT / ".build"
PYTHON_RUNTIME = lam.Runtime.PYTHON_3_14
PYTHON_TAG = "3.14"  # keep in step with PYTHON_RUNTIME: the layer's wheels are built for it


class StagingError(RuntimeError):
    pass


def stage_manifest_service() -> str:
    """esbuild-bundle med_app/src/spec/lambda.ts → .build/manifest_service/index.js (needs med_app/node_modules)."""
    target = BUILD / "manifest_service"

    if not (MED_APP / "node_modules").exists():
        raise StagingError(f"{MED_APP}/node_modules is missing — run `npm install` in med_app; the manifest service is bundled from there at synth time")

    target.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(["node", "scripts/bundle-lambda.mjs", str(target)], cwd=str(MED_APP), capture_output=True, text=True, check=False)

    if proc.returncode != 0:
        raise StagingError(f"bundling the manifest service failed:\n{proc.stdout}\n{proc.stderr}")

    return str(target)


def stage_agent_layer() -> str:
    """
    pip-install the agent's dependencies for the Lambda platform (arm64, CPython {PYTHON_TAG}) into
    .build/agent_layer/python. Cached by the requirements hash; ~30 s the first time.
    """
    requirements = INFRA_ROOT / "app_creator" / "requirements.txt"
    target = BUILD / "agent_layer"
    stamp = target / ".stamp"
    digest = hashlib.sha256(requirements.read_bytes() + PYTHON_TAG.encode()).hexdigest()

    if stamp.exists() and stamp.read_text() == digest and (target / "python").exists():
        return str(target)

    if target.exists():
        shutil.rmtree(target)

    (target / "python").mkdir(parents=True)

    cmd = [
        sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
        "--only-binary=:all:", "--platform", "manylinux2014_aarch64", "--implementation", "cp",
        "--python-version", PYTHON_TAG, "--abi", f"cp{PYTHON_TAG.replace('.', '')}",
        "--target", str(target / "python"), "-r", str(requirements),
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)

    if proc.returncode != 0:
        raise StagingError(f"building the agent dependency layer failed:\n{proc.stdout}\n{proc.stderr}")

    # boto3/botocore ship with the runtime; dropping them keeps the layer well under the size limit.
    for name in ("boto3", "botocore", "s3transfer"):
        for path in (target / "python").glob(f"{name}*"):
            shutil.rmtree(path, ignore_errors=True)

    stamp.write_text(digest)

    return str(target)


def stage_authoring_code() -> str:
    """One asset for the three Python functions: app_creator, the handlers, and the catalog files it reads."""
    target = BUILD / "authoring_code"

    if target.exists():
        shutil.rmtree(target)

    shutil.copytree(INFRA_ROOT / "app_creator", target / "app_creator", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "eval", "harness.py", "testing.py", ".sessions"))
    (target / "data").mkdir(parents=True)

    for name in ("application-catalog.yaml", "app-spec.schema.json"):
        src = MED_APP / "docs" / name

        if not src.exists():
            raise StagingError(f"{src} is missing")

        shutil.copy2(src, target / "data" / name)
    shutil.copy2(INFRA_ROOT / "lambdas" / "drafts_api" / "handler.py", target / "drafts_handler.py")
    shutil.copy2(INFRA_ROOT / "lambdas" / "registry_write" / "handler.py", target / "registry_write_handler.py")
    (target / "agent_handler.py").write_text("from app_creator.lambda_agent import lambda_handler  # noqa: F401\n", encoding="utf-8")

    return str(target)


class AuthoringStack(Stack):
    def __init__(
        self, scope: Construct, construct_id: str, *, hospital_id: str,
        registry_table: dynamodb.ITableV2, registry_writer_policy: iam.IManagedPolicy,
        user_pool: cognito.IUserPool, group_provisioning_policy: iam.IManagedPolicy, hospital_name: str,
        model_id: str, model_region_pattern: str = "*",
        audit_table: dynamodb.ITableV2 | None = None, audit_write_policy: iam.IManagedPolicy | None = None,
        registry_read_policy: iam.IManagedPolicy | None = None, **kwargs,
    ) -> None:
        """
        `model_region_pattern` narrows the agent's Bedrock permissions to a geography (`eu-*` under `data_residency: eu`).
        `registry_read_policy` lets the agent and the drafts API read the record-shape library from the registry (the
        published artifacts a `record` section refers to); without it they work with no library.
        """
        super().__init__(scope, construct_id, **kwargs)
        if not model_id:
            raise ValueError("AuthoringStack needs model_id (the hospital's file under infra/hospitals/)")
        if not model_region_pattern:
            raise ValueError("AuthoringStack needs a model_region_pattern ('*' for no restriction)")

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "authoring")

        # ── Drafts: working data with a TTL, separate from the registry ────────────────────
        self.drafts_key = kms.Key(
            self, "DraftsKey",
            alias=f"alias/medapp/{hospital_id}/drafts",
            description=f"MedApp drafting sessions encryption key ({hospital_id})",
            enable_key_rotation=True,
            removal_policy=RemovalPolicy.RETAIN,
        )

        self.drafts_table = dynamodb.TableV2(
            self, "Drafts",
            table_name=f"medapp-{hospital_id}-drafts",
            partition_key=dynamodb.Attribute(name="session_id", type=dynamodb.AttributeType.STRING),
            billing=dynamodb.Billing.on_demand(),
            encryption=dynamodb.TableEncryptionV2.customer_managed_key(self.drafts_key),
            time_to_live_attribute="expires_at",
            # Drafts are transient by design (TTL); the registry holds the record — so no retain, no deletion protection.
            removal_policy=RemovalPolicy.DESTROY,
            global_secondary_indexes=[
                dynamodb.GlobalSecondaryIndexPropsV2(
                    index_name="ByAuthor",
                    partition_key=dynamodb.Attribute(name="author_sub", type=dynamodb.AttributeType.STRING),
                    sort_key=dynamodb.Attribute(name="updated_at", type=dynamodb.AttributeType.STRING),
                    projection_type=dynamodb.ProjectionType.INCLUDE,
                    non_key_attributes=["title", "archetype", "created_at", "turn_status", "saved_as"],
                )
            ],
        )

        # ── Sign-off: an asymmetric key that signs manifest hashes at approval ──────────────
        self.signoff_key = kms.Key(
            self, "SignoffKey",
            alias=f"alias/medapp/{hospital_id}/signoff",
            description=f"MedApp clinical sign-off signing key ({hospital_id}) — signs manifest hashes at approval",
            key_spec=kms.KeySpec.ECC_NIST_P256,
            key_usage=kms.KeyUsage.SIGN_VERIFY,
            removal_policy=RemovalPolicy.RETAIN,  # signatures must stay verifiable for the retention period
        )

        # ── The record's vocabulary ───────────────────────────────────────────────────────
        # One JSON document — the codes actually present on the connected FHIR server, with display texts and counts —
        # written by the data source's seed function (at deploy and nightly; see lambdas/dispatcher/vocabulary.py) and
        # read by the drafting agent, so `lookup_codes` can answer for the hospital's own coding. No patient data: codes,
        # how often they occur, for how many patients. Versioned so a bad refresh can be rolled back by hand.
        self.vocabulary_bucket = s3.Bucket(
            self, "RecordVocabulary",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            object_ownership=s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removal_policy=RemovalPolicy.DESTROY,  # regenerated by the next seed run; nothing to keep
            auto_delete_objects=True,
            lifecycle_rules=[s3.LifecycleRule(id="trim-old-versions", noncurrent_version_expiration=Duration.days(30), abort_incomplete_multipart_upload_after=Duration.days(1))],
        )
        self.vocabulary_key = RECORD_VOCABULARY_KEY

        # ── Layers ────────────────────────────────────────────────────────────────────────
        shared_layer = lam.LayerVersion(
            self, "SharedLayer",
            code=lam.Code.from_asset(stage_shared_layer()),
            compatible_runtimes=[PYTHON_RUNTIME],
            compatible_architectures=[lam.Architecture.ARM_64],
            description="medapp_shared: registry keys, lifecycle rules, identity conventions, HTTP auth helpers",
        )

        agent_layer = lam.LayerVersion(
            self, "AgentDepsLayer",
            code=lam.Code.from_asset(stage_agent_layer()),
            compatible_runtimes=[PYTHON_RUNTIME],
            compatible_architectures=[lam.Architecture.ARM_64],
            description="strands-agents, jsonschema, pyyaml for the drafting agent (app_creator/requirements.txt)",
        )

        code = lam.Code.from_asset(stage_authoring_code())

        # ── Manifest service (Node.js) ────────────────────────────────────────────────────
        self.manifest_fn = lam.Function(
            self, "ManifestServiceFn",
            function_name=f"medapp-{hospital_id}-manifest-service",
            runtime=lam.Runtime.NODEJS_22_X,
            architecture=lam.Architecture.ARM_64,
            handler="index.handler",
            code=lam.Code.from_asset(stage_manifest_service()),
            memory_size=512,
            timeout=Duration.seconds(15),
            environment={"HOSPITAL_ID": hospital_id},
            description="The spec → manifest compiler and readiness check (med_app/src/spec) as a service; staff via the API, platform Lambdas directly",
        )

        common_env = {
            "HOSPITAL_ID": hospital_id,
            "DRAFTS_TABLE": self.drafts_table.table_name,
            "USER_POOL_ID": user_pool.user_pool_id,
            "MANIFEST_FUNCTION_NAME": self.manifest_fn.function_name,
            "MEDAPP_CATALOG_DIR": "/var/task/data",
        }

        # ── Drafting agent worker (async) ────────────────────────────────────────────────
        # The agent speaks the hospital's name and runs on the configured model; nothing else needs either.
        agent_env = {
            **common_env,
            "HOSPITAL_NAME": hospital_name,
            "MODEL_ID": model_id,
            "RECORD_VOCABULARY_BUCKET": self.vocabulary_bucket.bucket_name,
            "RECORD_VOCABULARY_KEY": self.vocabulary_key,
        }

        self.agent_fn = lam.Function(
            self, "DraftingAgentFn",
            function_name=f"medapp-{hospital_id}-drafting-agent",
            runtime=PYTHON_RUNTIME,
            architecture=lam.Architecture.ARM_64,
            handler="agent_handler.lambda_handler",
            code=code,
            layers=[shared_layer, agent_layer],
            memory_size=1024,
            timeout=Duration.minutes(5),
            environment=agent_env,
            description="One drafting turn: Strands agent on Bedrock filling the AppSpec through tools; writes progress and the reply to the session",
        )

        # A crashed turn is marked failed by the worker itself; do not replay it as a second turn.
        lam.EventInvokeConfig(self, "AgentInvokeConfig", function=self.agent_fn, retry_attempts=0, max_event_age=Duration.minutes(5))

        self.drafts_table.grant_read_write_data(self.agent_fn)
        self.manifest_fn.grant_invoke(self.agent_fn)
        self.vocabulary_bucket.grant_read(self.agent_fn)  # read only: the seed writes it
        if registry_read_policy is not None:
            # The record-shape library: the published artifacts, read by key after the index (reads only — the guard
            # stack's deny policy is about writes, and the writer alone writes).
            for fn in (self.agent_fn,):
                fn.add_environment("REGISTRY_TABLE_NAME", registry_table.table_name)
                fn.role.add_managed_policy(registry_read_policy)  # type: ignore[union-attr]
        self.agent_fn.add_to_role_policy(
            iam.PolicyStatement(
                sid="Bedrock",
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                # A cross-region profile needs the model in each of its destination regions; the pattern keeps all of
                # them inside the geography the deployment's data residency allows (stacks/residency.py).
                resources=[
                    f"arn:aws:bedrock:{model_region_pattern}::foundation-model/*",
                    f"arn:aws:bedrock:{model_region_pattern}:{self.account}:inference-profile/*",
                    f"arn:aws:bedrock:{model_region_pattern}:{self.account}:application-inference-profile/*",
                ],
            )
        )

        self.agent_fn.add_to_role_policy(iam.PolicyStatement(sid="ListGroups", actions=["cognito-idp:ListGroups"], resources=[user_pool.user_pool_arn]))

        # ── Drafts API (sync) ─────────────────────────────────────────────────────────────
        self.drafts_fn = lam.Function(
            self, "DraftsApiFn",
            function_name=f"medapp-{hospital_id}-drafts-api",
            runtime=PYTHON_RUNTIME,
            architecture=lam.Architecture.ARM_64,
            handler="drafts_handler.lambda_handler",
            code=code,
            layers=[shared_layer, agent_layer],
            memory_size=512,
            timeout=Duration.seconds(15),
            environment={**common_env, "AGENT_FUNCTION_NAME": self.agent_fn.function_name},
            description="Drafting sessions: open, read, edit through validated operations, queue a turn for the agent",
        )

        self.drafts_table.grant_read_write_data(self.drafts_fn)
        self.agent_fn.grant_invoke(self.drafts_fn)
        if registry_read_policy is not None:
            self.drafts_fn.add_environment("REGISTRY_TABLE_NAME", registry_table.table_name)
            self.drafts_fn.role.add_managed_policy(registry_read_policy)  # type: ignore[union-attr]
        self.drafts_fn.add_to_role_policy(iam.PolicyStatement(sid="ListGroups", actions=["cognito-idp:ListGroups"], resources=[user_pool.user_pool_arn]))

        # ── Registry write API ────────────────────────────────────────────────────────────
        self.registry_write_fn = lam.Function(
            self, "RegistryWriteFn",
            function_name=f"medapp-{hospital_id}-registry-write",
            runtime=PYTHON_RUNTIME,
            architecture=lam.Architecture.ARM_64,
            handler="registry_write_handler.lambda_handler",
            code=code,
            layers=[shared_layer, agent_layer],
            memory_size=512,
            timeout=Duration.seconds(30),
            environment={
                **common_env,
                "TABLE_NAME": registry_table.table_name,
                "SIGNOFF_KEY_ID": self.signoff_key.key_id,
                "DEFINITIONS_WRITER_PARAMETER": DEFINITIONS_WRITER_PARAMETER.format(hospital_id=hospital_id),
                # Lifecycle steps are audit records too, beside the data accesses, when the audit stack is deployed.
                **({"AUDIT_TABLE_NAME": audit_table.table_name} if audit_table is not None else {}),
            },
            description="A draft becomes an app; lifecycle transitions with separation of duties, KMS sign-off at approval, group provisioning and the app's own forms into the record at publish",
        )
        # At publish, the app's own forms go to the record through the data source's seed Lambda, found by name in SSM.
        self.registry_write_fn.add_to_role_policy(
            iam.PolicyStatement(sid="DefinitionsWriterLookup", actions=["ssm:GetParameter"], resources=[Stack.of(self).format_arn(service="ssm", resource="parameter", resource_name=DEFINITIONS_WRITER_PARAMETER.format(hospital_id=hospital_id).lstrip("/"))])
        )
        self.registry_write_fn.add_to_role_policy(
            iam.PolicyStatement(sid="DefinitionsWriterInvoke", actions=["lambda:InvokeFunction"], resources=[Stack.of(self).format_arn(service="lambda", resource="function", resource_name=f"medapp-{hospital_id}-*-seed", arn_format=ArnFormat.COLON_RESOURCE_NAME)])
        )

        self.registry_write_fn.role.add_managed_policy(registry_writer_policy)  # type: ignore[union-attr]
        self.registry_write_fn.role.add_managed_policy(group_provisioning_policy)  # type: ignore[union-attr]
        if audit_write_policy is not None:
            self.registry_write_fn.role.add_managed_policy(audit_write_policy)  # type: ignore[union-attr]
        self.drafts_table.grant_read_write_data(self.registry_write_fn)  # marks the draft as saved
        self.manifest_fn.grant_invoke(self.registry_write_fn)
        self.signoff_key.grant(self.registry_write_fn, "kms:Sign", "kms:GetPublicKey")

        # ── Discovery ─────────────────────────────────────────────────────────────────────
        prefix = f"/medapp/{hospital_id}/authoring"
        ssm.StringParameter(self, "DraftsTableParam", parameter_name=f"{prefix}/drafts-table", string_value=self.drafts_table.table_name)
        ssm.StringParameter(self, "ManifestFnParam", parameter_name=f"{prefix}/manifest-function", string_value=self.manifest_fn.function_name)
        ssm.StringParameter(self, "SignoffKeyParam", parameter_name=f"{prefix}/signoff-key-arn", string_value=self.signoff_key.key_arn)
        ssm.StringParameter(self, "ModelIdParam", parameter_name=f"{prefix}/model-id", string_value=model_id)
        ssm.StringParameter(self, "VocabularyBucketParam", parameter_name=f"{prefix}/vocabulary-bucket", string_value=self.vocabulary_bucket.bucket_name)
        CfnOutput(self, "RecordVocabularyUri", value=f"s3://{self.vocabulary_bucket.bucket_name}/{self.vocabulary_key}", description="The record's vocabulary the drafting assistant searches (written by the data source's seed; scripts/record-vocabulary.py reads and refreshes it)")
        CfnOutput(self, "DraftsTable", value=self.drafts_table.table_name)
        CfnOutput(self, "SignoffKeyArn", value=self.signoff_key.key_arn)
