"""
API — HTTP API Gateway in front of the platform's Lambdas, authenticated with the hospital's Cognito
user pool (JWT authorizer on the web client).

  GET  /registry/apps, /registry/apps/{app_id}/versions/{version}, /registry/collections,
       /registry/shapes, /registry/shapes/{shape_id}                                        registry read API
  POST /primitives/{kind}                                             primitive dispatcher
  GET  /patients?name=…                                               patient lookup for the launch context (dispatcher)
  POST /manifest/compile | /manifest/readiness | /manifest/validate  manifest service (AuthoringStack)
  POST/GET /drafts, GET/PATCH/DELETE /drafts/{id}, POST /drafts/{id}/turns, GET /groups   drafting sessions (AuthoringStack)
  POST /registry/apps, …/versions, PUT …/versions/{version}, POST …/versions/{version}/transitions,
  POST /registry/collections, PUT/DELETE /registry/collections/{collection_id},
  POST /registry/shapes, PUT /registry/shapes/{shape_id}, POST …/shapes/{shape_id}/versions/{version}/transitions
                                                                                                      registry write API (AuthoringStack)
  GET /users, GET /users/groups, POST /users, PATCH /users/{username}, POST /users/{username}/invitation   user administration (admins; Cognito)
  GET /audit?from&to&user&app&patient&kind&outcome&limit&cursor                                    the audit trail (admins; AuditStack)

The dispatcher's data source is configuration: `data_source="bundle"` serves the synthetic FHIR
bundle packaged with the Lambda (exported from med_app's seed) until the hospital FHIR server is
reachable; `data_source="fhir"` with `fhir_base_url` switches to it — `fhir_auth` says how requests
authenticate (`sigv4` for the reference server's IAM-authorised API, `oauth2` for a hospital gateway with
client credentials — the HospitalServersStack supplies the rest of the environment —, `bearer` for a static
gateway token, `none`). `dicomweb_base_url` points the imaging primitive at a PACS (QIDO-RS) instead of the
record's ImagingStudy resources. Enforcement is identical.

Photo documentation keeps its bytes in the stack's media bucket (`MEDIA_BUCKET`): the FHIR record holds the
Media resource with a `medapp-media://` URL, the dispatcher writes the object and hands the panel a presigned
GET that lives fifteen minutes. The bucket is private, encrypted, SSL-only and retained on stack deletion —
the images are part of the patient record.
"""

from __future__ import annotations
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_apigatewayv2 as apigw,
    aws_apigatewayv2_authorizers as authorizers,
    aws_apigatewayv2_integrations as integrations,
    aws_cognito as cognito,
    aws_dynamodb as dynamodb,
    aws_iam as iam,
    aws_lambda as lam,
    aws_s3 as s3,
    aws_ssm as ssm
)
from constructs import Construct

import shutil

INFRA_ROOT = Path(__file__).resolve().parents[1]


def stage_shared_layer() -> str:
    """
    Lambda layers need `python/<package>`; stage a copy of medapp_shared there at synth time so the
    same module the CDK code imports is what the Lambdas run. Output is content-hashed by CDK.
    """
    target = INFRA_ROOT / ".build" / "shared_layer" / "python" / "medapp_shared"

    if target.exists():
        shutil.rmtree(target)

    shutil.copytree(INFRA_ROOT / "medapp_shared", target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    return str(target.parents[1])


class ApiStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, table: dynamodb.ITableV2,
        registry_read_policy: iam.IManagedPolicy, user_pool: cognito.IUserPool, web_client: cognito.IUserPoolClient,
        frontend_origins: list[str], data_source: str = "bundle", fhir_base_url: str | None = None, fhir_auth: str | None = None,
        dicomweb_base_url: str | None = None, dispatcher_environment: dict[str, str] | None = None, manifest_fn: lam.IFunction | None = None,
        drafts_fn: lam.IFunction | None = None, registry_write_fn: lam.IFunction | None = None,
        audit_table: dynamodb.ITableV2 | None = None, audit_write_policy: iam.IManagedPolicy | None = None, audit_read_policy: iam.IManagedPolicy | None = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "api")

        self.shared_layer = lam.LayerVersion(
            self,"SharedLayer",
            code=lam.Code.from_asset(stage_shared_layer()),
            compatible_runtimes=[lam.Runtime.PYTHON_3_14],
            compatible_architectures=[lam.Architecture.ARM_64],
            description="medapp_shared: registry keys, lifecycle rules, identity conventions",
        )

        self.registry_fn = lam.Function(
            self,"RegistryApiFn",
            function_name=f"medapp-{hospital_id}-registry-api",
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="handler.lambda_handler",
            code=lam.Code.from_asset(str(INFRA_ROOT / "lambdas" / "registry_api"), exclude=["__pycache__", "*.pyc"]),
            layers=[self.shared_layer],
            memory_size=256,
            timeout=Duration.seconds(10),
            environment={"TABLE_NAME": table.table_name, "HOSPITAL_ID": hospital_id},
            description="Registry read API: lists the apps a caller may open, serves manifests",
        )

        # Read-only on the registry (GetItem/Query + KMS decrypt), nothing else.
        self.registry_fn.role.add_managed_policy(registry_read_policy)  # type: ignore[union-attr]

        # ── Primitive dispatcher ─────────────────────────────────────────────────────────────
        if data_source == "fhir" and not fhir_base_url:
            raise ValueError("data_source='fhir' requires fhir_base_url")
        if fhir_auth not in (None, "sigv4", "oauth2", "bearer", "none"):
            raise ValueError("fhir_auth must be sigv4, oauth2, bearer or none")

        dispatcher_env = {"TABLE_NAME": table.table_name, "HOSPITAL_ID": hospital_id, "DATA_SOURCE": data_source}
        # Every primitive call is an audit record; with the audit stack present the record is also an item in its table.
        audit_env = {"AUDIT_TABLE_NAME": audit_table.table_name} if audit_table is not None else {}
        dispatcher_env.update(audit_env)

        if fhir_base_url:
            dispatcher_env["FHIR_BASE_URL"] = fhir_base_url
        if fhir_auth:
            dispatcher_env["FHIR_AUTH"] = fhir_auth
        if dicomweb_base_url:
            # Imaging from a PACS (QIDO-RS by MRN) instead of the record's ImagingStudy resources; authenticates like FHIR_AUTH.
            dispatcher_env["DICOMWEB_BASE_URL"] = dicomweb_base_url
        # The data source's own settings (a hospital's token endpoint, scope, credentials secret name, patient-id join).
        dispatcher_env.update(dispatcher_environment or {})

        # ── Media bucket: the bytes of photo documentation ──────────────────────────────────
        # Objects are `<hospital>/<patient id>/<submission>.<ext>`; the record's Media resource points at them and the
        # dispatcher is the only reader and writer (presigned GETs for the panel, no public access, no listing from
        # outside). Retained: these are patient records, not a cache. Lifecycle only tidies failed multipart uploads.
        self.media_bucket = s3.Bucket(
            self, "MediaBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            object_ownership=s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[s3.LifecycleRule(id="abort-incomplete-uploads", abort_incomplete_multipart_upload_after=Duration.days(1))],
            cors=[s3.CorsRule(allowed_methods=[s3.HttpMethods.GET], allowed_origins=["*"], allowed_headers=["*"], max_age=900)],  # the panel loads presigned GETs cross-origin; the signature is the access control
        )
        dispatcher_env["MEDIA_BUCKET"] = self.media_bucket.bucket_name

        self.dispatcher_fn = lam.Function(
            self,"DispatcherFn",
            function_name=f"medapp-{hospital_id}-dispatcher",
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="handler.lambda_handler",
            code=lam.Code.from_asset(str(INFRA_ROOT / "lambdas" / "dispatcher"), exclude=["__pycache__", "*.pyc"]),
            layers=[self.shared_layer],
            memory_size=512,
            timeout=Duration.seconds(15),
            environment=dispatcher_env,
            description="Primitive dispatcher: manifest + role + scope enforcement, then data access; one audit record per call",
        )

        # The dispatcher only ever reads the registry; data comes from the FHIR source, not DynamoDB.
        self.dispatcher_fn.role.add_managed_policy(registry_read_policy)  # type: ignore[union-attr]
        if audit_write_policy is not None:
            self.dispatcher_fn.role.add_managed_policy(audit_write_policy)  # type: ignore[union-attr]
        # Photos: put and get objects in the media bucket (presigning a GET needs the role to be allowed the GET).
        self.media_bucket.grant_put(self.dispatcher_fn)
        self.media_bucket.grant_read(self.dispatcher_fn)

        # ── User administration ──────────────────────────────────────────────────────────────
        # Accounts and group membership in the hospital's pool, for administrators (the function checks the
        # caller's medapp-admins membership; the authorizer only checks the token). It needs the user and group
        # calls on this one pool and nothing else — no pool settings, no clients, no deletion.
        self.user_admin_fn = lam.Function(
            self,"UserAdminFn",
            function_name=f"medapp-{hospital_id}-user-admin",
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="handler.lambda_handler",
            code=lam.Code.from_asset(str(INFRA_ROOT / "lambdas" / "user_admin"), exclude=["__pycache__", "*.pyc"]),
            layers=[self.shared_layer],
            memory_size=256,
            timeout=Duration.seconds(15),
            environment={"USER_POOL_ID": user_pool.user_pool_id, "HOSPITAL_ID": hospital_id, **audit_env},
            description="User administration: accounts, invitations and group membership in the hospital's user pool; admins only; audited",
        )
        if audit_write_policy is not None:
            self.user_admin_fn.role.add_managed_policy(audit_write_policy)  # type: ignore[union-attr]

        # ── Audit API ────────────────────────────────────────────────────────────────────────
        # The trail, for administrators: by day, person, app or patient. Read-only on the audit table.
        self.audit_fn: lam.Function | None = None
        if audit_table is not None and audit_read_policy is not None:
            self.audit_fn = lam.Function(
                self,"AuditApiFn",
                function_name=f"medapp-{hospital_id}-audit-api",
                runtime=lam.Runtime.PYTHON_3_14,
                architecture=lam.Architecture.ARM_64,
                handler="handler.lambda_handler",
                code=lam.Code.from_asset(str(INFRA_ROOT / "lambdas" / "audit_api"), exclude=["__pycache__", "*.pyc"]),
                layers=[self.shared_layer],
                memory_size=256,
                timeout=Duration.seconds(15),
                environment={"AUDIT_TABLE_NAME": audit_table.table_name, "HOSPITAL_ID": hospital_id},
                description="Audit trail read API: data accesses, writes, account changes and lifecycle steps, for administrators",
            )
            self.audit_fn.role.add_managed_policy(audit_read_policy)  # type: ignore[union-attr]
        self.user_admin_fn.add_to_role_policy(
            iam.PolicyStatement(
                sid="UserAdministration",
                actions=[
                    "cognito-idp:ListUsers",
                    "cognito-idp:ListGroups",
                    "cognito-idp:ListUsersInGroup",
                    "cognito-idp:AdminGetUser",
                    "cognito-idp:AdminListGroupsForUser",
                    "cognito-idp:AdminCreateUser",
                    "cognito-idp:AdminAddUserToGroup",
                    "cognito-idp:AdminRemoveUserFromGroup",
                    "cognito-idp:AdminEnableUser",
                    "cognito-idp:AdminDisableUser",
                ],
                resources=[user_pool.user_pool_arn],
            )
        )

        authorizer = authorizers.HttpJwtAuthorizer(
            "CognitoJwt",
            jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
            jwt_audience=[web_client.user_pool_client_id],
            identity_source=["$request.header.Authorization"],
        )

        self.http_api = apigw.HttpApi(
            self,"HttpApi",
            api_name=f"medapp-{hospital_id}-api",
            description=f"MedApp API · {hospital_id}",
            default_authorizer=authorizer,
            cors_preflight=apigw.CorsPreflightOptions(
                allow_origins=frontend_origins,
                allow_methods=[apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.PATCH, apigw.CorsHttpMethod.DELETE, apigw.CorsHttpMethod.OPTIONS],
                allow_headers=["authorization", "content-type", "x-medapp-app-id", "x-medapp-manifest-version"],
                max_age=Duration.hours(1),
            ),
        )

        registry_integration = integrations.HttpLambdaIntegration("RegistryIntegration", self.registry_fn)

        self.http_api.add_routes(path="/registry/apps", methods=[apigw.HttpMethod.GET], integration=registry_integration)
        self.http_api.add_routes(
            path="/registry/apps/{app_id}/versions/{version}", methods=[apigw.HttpMethod.GET], integration=registry_integration
        )
        self.http_api.add_routes(path="/registry/collections", methods=[apigw.HttpMethod.GET], integration=registry_integration)
        self.http_api.add_routes(path="/registry/shapes", methods=[apigw.HttpMethod.GET], integration=registry_integration)
        self.http_api.add_routes(path="/registry/shapes/{shape_id}", methods=[apigw.HttpMethod.GET], integration=registry_integration)
        dispatcher_integration = integrations.HttpLambdaIntegration("DispatcherIntegration", self.dispatcher_fn)
        self.http_api.add_routes(path="/primitives/{kind}", methods=[apigw.HttpMethod.POST], integration=dispatcher_integration)
        # The launch context: the panel looks a patient up by name in the same data source, audited (`platform.patient.search`).
        self.http_api.add_routes(path="/patients", methods=[apigw.HttpMethod.GET], integration=dispatcher_integration)

        if self.audit_fn is not None:
            self.http_api.add_routes(path="/audit", methods=[apigw.HttpMethod.GET], integration=integrations.HttpLambdaIntegration("AuditIntegration", self.audit_fn))

        user_admin_integration = integrations.HttpLambdaIntegration("UserAdminIntegration", self.user_admin_fn)
        self.http_api.add_routes(path="/users", methods=[apigw.HttpMethod.GET, apigw.HttpMethod.POST], integration=user_admin_integration)
        self.http_api.add_routes(path="/users/groups", methods=[apigw.HttpMethod.GET], integration=user_admin_integration)
        self.http_api.add_routes(path="/users/{username}", methods=[apigw.HttpMethod.PATCH], integration=user_admin_integration)
        self.http_api.add_routes(path="/users/{username}/invitation", methods=[apigw.HttpMethod.POST], integration=user_admin_integration)

        # ── Authoring routes (functions live in the AuthoringStack) ─────────────────────
        if manifest_fn is not None:
            manifest_integration = integrations.HttpLambdaIntegration("ManifestIntegration", manifest_fn)
            for path in ("/manifest/compile", "/manifest/readiness", "/manifest/validate", "/manifest/shape"):
                self.http_api.add_routes(path=path, methods=[apigw.HttpMethod.POST], integration=manifest_integration)
        if drafts_fn is not None:
            drafts_integration = integrations.HttpLambdaIntegration("DraftsIntegration", drafts_fn)
            self.http_api.add_routes(path="/drafts", methods=[apigw.HttpMethod.POST, apigw.HttpMethod.GET], integration=drafts_integration)
            self.http_api.add_routes(path="/groups", methods=[apigw.HttpMethod.GET], integration=drafts_integration)
            self.http_api.add_routes(path="/drafts/{id}", methods=[apigw.HttpMethod.GET, apigw.HttpMethod.PATCH, apigw.HttpMethod.DELETE], integration=drafts_integration)
            self.http_api.add_routes(path="/drafts/{id}/turns", methods=[apigw.HttpMethod.POST], integration=drafts_integration)
        if registry_write_fn is not None:
            write_integration = integrations.HttpLambdaIntegration("RegistryWriteIntegration", registry_write_fn)
            self.http_api.add_routes(path="/registry/apps", methods=[apigw.HttpMethod.POST], integration=write_integration)
            self.http_api.add_routes(path="/registry/apps/{app_id}/versions", methods=[apigw.HttpMethod.POST], integration=write_integration)
            self.http_api.add_routes(path="/registry/apps/{app_id}/versions/{version}", methods=[apigw.HttpMethod.PUT], integration=write_integration)  # revise a draft version in place
            self.http_api.add_routes(path="/registry/apps/{app_id}/versions/{version}/transitions", methods=[apigw.HttpMethod.POST], integration=write_integration)
            # Collections: how the hospital groups its apps for the launcher — approvers and admins, no version touched.
            self.http_api.add_routes(path="/registry/collections", methods=[apigw.HttpMethod.POST], integration=write_integration)
            self.http_api.add_routes(path="/registry/collections/{collection_id}", methods=[apigw.HttpMethod.PUT, apigw.HttpMethod.DELETE], integration=write_integration)
            # The record-shape library: authors create and revise, approvers and admins publish and deprecate.
            self.http_api.add_routes(path="/registry/shapes", methods=[apigw.HttpMethod.POST], integration=write_integration)
            self.http_api.add_routes(path="/registry/shapes/{shape_id}", methods=[apigw.HttpMethod.PUT], integration=write_integration)
            self.http_api.add_routes(path="/registry/shapes/{shape_id}/versions/{version}/transitions", methods=[apigw.HttpMethod.POST], integration=write_integration)

        base_url = (self.http_api.url or "").rstrip("/")
        self.base_url = base_url
        ssm.StringParameter(self, "ApiBaseUrlParam", parameter_name=f"/medapp/{hospital_id}/api/base-url", string_value=base_url)
        CfnOutput(self, "ViteApiBaseUrl", value=base_url, description="VITE_API_BASE_URL")
        CfnOutput(self, "MediaBucketName", value=self.media_bucket.bucket_name, description="Photo documentation bytes (MEDIA_BUCKET of the dispatcher)")
