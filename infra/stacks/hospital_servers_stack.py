"""
The hospital's servers — the FHIR server and DICOMweb gateway a hospital provides, reached with OAuth 2.0 client
credentials. The first one connected was a HAPI FHIR server behind an API gateway with an OAuth 2.0 token endpoint, one
client id and secret for the platform. This stack holds everything the platform needs to use them:

  * the credentials — a Secrets Manager secret written by `scripts/set-hospital-credentials.py`, never by code or
    cdk.json; the dispatcher, the viewer door and the seed function may read it, nothing else;
  * the dispatcher's configuration (`dispatcher_environment`): base URLs, token URL and scope, how imaging joins
    patients (`DICOM_PATIENT_ID_SOURCE`: some PACS gateways key studies by the FHIR Patient's id, not an MRN);
  * the viewer door: `GET /viewer/dicom-web/{proxy+}` on an HTTP API of its own — the API's JWT authorizer admits
    the panel's users (Cognito ID token), and a Lambda forwards each request to the hospital's DICOMweb with the
    hospital's access token (API Gateway will not write the `Authorization` header from a mapping, so a function
    must add it). The browser never sees the hospital's credentials; OHIF's app-config.js points at this door.
    Answers larger than a Lambda response (a radiograph's frame) are spilled to a private bucket and the browser
    is redirected to a presigned URL — objects expire after a day, the URL after two minutes;
  * the seed, definitions only: the questionnaires the assessment apps need are PUT by id; patients and their
    records are never written. It also verifies the server answers (capability statement, a patient exists, QIDO),
    and — given the authoring stack's bucket — reads the record's vocabulary (its distinct codes with display texts
    and counts, `lambdas/dispatcher/vocabulary.py`) for the drafting assistant, at deploy and every night.

Everything is configuration in the hospital's file (`hospital_servers` in infra/hospitals/<id>.json), with the secret's *name* there and its value in
Secrets Manager. The reference servers (HAPI + Orthanc with the synthetic record) remain deployable for tests; when
`hospital_servers` is set, the dispatcher and the viewer use the hospital's servers.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from aws_cdk import (
    CfnOutput,
    CustomResource,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_apigatewayv2 as apigw,
    aws_apigatewayv2_authorizers as authorizers,
    aws_apigatewayv2_integrations as integrations,
    aws_cognito as cognito,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    aws_lambda as lam,
    aws_logs as logs,
    aws_s3 as s3,
    aws_secretsmanager as secretsmanager,
    aws_ssm as ssm,
    custom_resources as cr,
)
from constructs import Construct

from .definitions import DEFINITIONS_WRITER_PARAMETER

from .api_stack import stage_shared_layer
from .viewer_stack import ViewerRuntimeConfig, ViewerStack

INFRA_ROOT = Path(__file__).resolve().parents[1]
DISPATCHER_DIR = INFRA_ROOT / "lambdas" / "dispatcher"
VIEWER_DOOR_DIR = INFRA_ROOT / "lambdas" / "viewer_door"
SEED_BUNDLE = DISPATCHER_DIR / "data" / "synthetic-musterstadt.bundle.json"
PATIENT_ID_SOURCES = ("identifier", "resource_id")


@dataclass(frozen=True)
class HospitalServers:
    """The `hospital_servers` block of a hospital's file (infra/hospitals/<id>.json), validated. Nothing in it is secret."""

    fhir_base_url: str
    token_url: str
    credentials_secret: str
    dicomweb_base_url: str | None = None
    scope: str | None = None
    dicom_patient_id: str = "identifier"
    dicom_patient_id_system: str | None = None
    timeout_s: float = 15.0

    @classmethod
    def from_context(cls, raw: object) -> "HospitalServers":
        if not isinstance(raw, dict):
            raise ValueError("hospital_servers must be an object")
        for key in ("fhir_base_url", "token_url", "credentials_secret"):
            if not raw.get(key):
                raise ValueError(f"hospital_servers.{key} is required")
        for key in ("fhir_base_url", "token_url", "dicomweb_base_url"):
            value = raw.get(key)
            if value and urlsplit(str(value)).scheme != "https":
                raise ValueError(f"hospital_servers.{key} must be an https URL")
        join = str(raw.get("dicom_patient_id") or "identifier")
        if join not in PATIENT_ID_SOURCES:
            raise ValueError(f"hospital_servers.dicom_patient_id must be one of {PATIENT_ID_SOURCES}")
        secret = str(raw["credentials_secret"])
        if any(k in raw for k in ("client_secret", "client_id")):
            raise ValueError("hospital_servers must not contain credentials: put them in the Secrets Manager secret (scripts/set-hospital-credentials.py)")
        return cls(
            fhir_base_url=str(raw["fhir_base_url"]).rstrip("/"),
            token_url=str(raw["token_url"]),
            credentials_secret=secret,
            dicomweb_base_url=str(raw["dicomweb_base_url"]).rstrip("/") if raw.get("dicomweb_base_url") else None,
            scope=str(raw["scope"]) if raw.get("scope") else None,
            dicom_patient_id=join,
            dicom_patient_id_system=str(raw["dicom_patient_id_system"]) if raw.get("dicom_patient_id_system") else None,
            timeout_s=float(raw.get("timeout_s") or 15.0),
        )

    def dispatcher_environment(self) -> dict[str, str]:
        """What the FHIR and DICOMweb clients read (fhir_source.http_source_from_env, dicomweb.dicomweb_source_from_env)."""
        env = {
            "FHIR_AUTH": "oauth2",
            "FHIR_TOKEN_URL": self.token_url,
            "FHIR_CREDENTIALS_SECRET": self.credentials_secret,
            "FHIR_TIMEOUT_S": f"{self.timeout_s:g}",
        }
        if self.scope:
            env["FHIR_OAUTH_SCOPE"] = self.scope
        if self.dicomweb_base_url:
            env["DICOM_PATIENT_ID_SOURCE"] = self.dicom_patient_id
            if self.dicom_patient_id_system:
                env["DICOM_PATIENT_ID_SYSTEM"] = self.dicom_patient_id_system
        return env


class HospitalServersStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        hospital_id: str,
        servers: HospitalServers,
        user_pool: cognito.IUserPool,
        web_client: cognito.IUserPoolClient,
        browser_origins: list[str],
        viewer: ViewerStack | None = None,
        vocabulary_bucket: s3.IBucket | None = None,
        vocabulary_key: str = "record-vocabulary.json",
        synthetic_dicomweb_root: str | None = None,
        definitions_writer: bool = True,
        **kwargs,
    ) -> None:
        """`synthetic_dicomweb_root`: the reference servers' viewer door, when they are deployed too — the viewer gets a second
        data source, `reference`, so previews and mock-data panels open the synthetic studies without touching the hospital's PACS.
        `definitions_writer`: this server is the record the apps run on, so the seed Lambda is named (SSM
        `/medapp/<hospital_id>/data-source/definitions-writer`) as the function that writes an app's own forms to it at publish."""
        super().__init__(scope, construct_id, **kwargs)
        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "hospital-servers")

        self.servers = servers
        self.fhir_base_url = servers.fhir_base_url
        self.dicomweb_base_url = servers.dicomweb_base_url
        self.dispatcher_environment = servers.dispatcher_environment()

        # The credentials live in Secrets Manager under the name the hospital's file gives; this stack only references them.
        self.secret = secretsmanager.Secret.from_secret_name_v2(self, "Credentials", servers.credentials_secret)

        shared_layer = lam.LayerVersion(
            self, "SharedLayer",
            code=lam.Code.from_asset(stage_shared_layer()),
            compatible_runtimes=[lam.Runtime.PYTHON_3_14],
            compatible_architectures=[lam.Architecture.ARM_64],
            description="medapp_shared for the hospital-servers functions (OAuth2, JWT verification, TLS trust)",
        )
        oauth_env = {k: v for k, v in self.dispatcher_environment.items() if k.startswith("FHIR_")}

        # Log groups of the named functions are declared here with a DESTROY policy. CDK's managed log groups are
        # retained, so a stack creation that rolls back (this one did, twice) leaves `/aws/lambda/<fixed name>` behind
        # and the next creation fails with AlreadyExists; a group this stack owns goes away with the rollback.
        def log_group(construct_id: str, function_name: str, retention: logs.RetentionDays) -> logs.LogGroup:
            return logs.LogGroup(self, construct_id, log_group_name=f"/aws/lambda/{function_name}", retention=retention, removal_policy=RemovalPolicy.DESTROY)

        # ── The viewer door ───────────────────────────────────────────────────────────────────────
        self.viewer_dicomweb_url: str | None = None
        self.spill_bucket: s3.Bucket | None = None
        if servers.dicomweb_base_url:
            # Where the door puts an answer too large for a Lambda response (6 MB, base64 included — a radiograph's
            # single frame is 8–15 MB) before redirecting the browser to a presigned URL for it. Private, encrypted,
            # emptied by lifecycle after a day (the shortest S3 offers; the URLs themselves live two minutes). The CORS
            # rule allows every origin on purpose: a browser that follows a cross-origin redirect presents `Origin:
            # null` (the fetch standard's redirect-tainted origin), which no allow-list can name — and CORS is not what
            # protects these objects, the signature in the URL is.
            self.spill_bucket = s3.Bucket(
                self, "ViewerSpill",
                block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
                encryption=s3.BucketEncryption.S3_MANAGED,
                enforce_ssl=True,
                object_ownership=s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
                removal_policy=RemovalPolicy.DESTROY,
                auto_delete_objects=True,
                lifecycle_rules=[s3.LifecycleRule(id="expire-spilled-answers", expiration=Duration.days(1), abort_incomplete_multipart_upload_after=Duration.days(1))],
                cors=[
                    s3.CorsRule(
                        allowed_methods=[s3.HttpMethods.GET, s3.HttpMethods.HEAD],
                        allowed_origins=["*"],
                        allowed_headers=["*"],
                        exposed_headers=["Content-Type", "Content-Length", "Content-Encoding"],
                        max_age=300,
                    )
                ],
            )
            door_name = f"medapp-{hospital_id}-viewer-door"
            door_fn = lam.Function(
                self, "ViewerDoorFn",
                function_name=door_name,
                runtime=lam.Runtime.PYTHON_3_14,
                architecture=lam.Architecture.ARM_64,
                handler="handler.lambda_handler",
                code=lam.Code.from_asset(str(VIEWER_DOOR_DIR), exclude=["__pycache__", "*.pyc"]),
                layers=[shared_layer],
                memory_size=1024,  # a 15 MB frame in memory, base64 or on its way to the spill bucket; CPU scales with it
                timeout=Duration.seconds(29),  # the API's own limit is 30 s
                environment={
                    "DICOMWEB_BASE_URL": servers.dicomweb_base_url,
                    "DOOR_PREFIX": "/viewer/dicom-web",
                    "SPILL_BUCKET": self.spill_bucket.bucket_name,
                    "SPILL_TTL_S": "120",
                    **oauth_env,
                },
                log_group=log_group("ViewerDoorLogs", door_name, logs.RetentionDays.ONE_MONTH),
                description="Viewer door: forwards the panel's DICOMweb requests to the hospital's gateway with the hospital's token (the user's token stops at the JWT authorizer); oversize answers via the spill bucket",
            )
            self.secret.grant_read(door_fn)
            self.spill_bucket.grant_put(door_fn)  # the put, and the read the presigned URL is signed with
            self.spill_bucket.grant_read(door_fn)

            self.door_api = apigw.HttpApi(
                self, "ViewerDoorApi",
                api_name=f"medapp-{hospital_id}-hospital-viewer-door",
                description="The panel's viewer reaching the hospital's DICOMweb with the user's identity and the platform's credentials",
                cors_preflight=apigw.CorsPreflightOptions(
                    allow_origins=sorted(set(browser_origins)),
                    allow_methods=[apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.OPTIONS],
                    allow_headers=["authorization", "content-type", "accept", "x-requested-with"],
                    max_age=Duration.hours(1),
                ),
            )
            # The panel's users, verified by API Gateway itself (issuer the pool, audience the web client) — no Lambda for that.
            authorizer = authorizers.HttpJwtAuthorizer(
                "PanelUser",
                jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
                jwt_audience=[web_client.user_pool_client_id],
            )
            # Not an HTTP proxy integration with a header mapping: API Gateway refuses to set `Authorization` from a mapping
            # ("Operations on header authorization are restricted"). The function adds the hospital's token per request.
            upstream = integrations.HttpLambdaIntegration("HospitalDicomWeb", door_fn, payload_format_version=apigw.PayloadFormatVersion.VERSION_2_0)
            self.door_api.add_routes(path="/viewer/dicom-web/{proxy+}", methods=[apigw.HttpMethod.GET], integration=upstream, authorizer=authorizer)
            self.viewer_dicomweb_url = f"{self.door_api.url}viewer/dicom-web"
            if viewer is not None:
                # The hospital's gateway writes absolute BulkDataURIs on itself into metadata; OHIF re-prefixes them onto the door.
                ViewerRuntimeConfig(
                    self, "ViewerConfig",
                    viewer=viewer,
                    dicomweb_root=self.viewer_dicomweb_url,
                    friendly_name=f"{hospital_id} PACS (hospital gateway)",
                    upstream_root=servers.dicomweb_base_url,
                    synthetic_root=synthetic_dicomweb_root,
                )

        # ── Definitions into the hospital's server, and a check that it answers ───────────────────
        seed_name = f"medapp-{hospital_id}-hospital-seed"
        seed_fn = lam.Function(
            self, "SeedFn",
            function_name=seed_name,
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="seed.lambda_handler",
            code=lam.Code.from_asset(str(DISPATCHER_DIR), exclude=["__pycache__", "*.pyc"]),  # the dispatcher's own clients and bundle
            layers=[shared_layer],
            memory_size=512,
            timeout=Duration.minutes(5),
            log_group=log_group("SeedLogs", seed_name, logs.RetentionDays.ONE_WEEK),
            environment={
                "HOSPITAL_ID": hospital_id,
                "SEED_MODE": "definitions",
                "FHIR_BASE_URL": servers.fhir_base_url,
                **({"DICOMWEB_BASE_URL": servers.dicomweb_base_url} if servers.dicomweb_base_url else {}),
                **({"RECORD_VOCABULARY_BUCKET": vocabulary_bucket.bucket_name, "RECORD_VOCABULARY_KEY": vocabulary_key} if vocabulary_bucket is not None else {}),
                **self.dispatcher_environment,
            },
            description="Writes the apps' definitions (questionnaires) into the hospital's FHIR server, verifies it answers, and reads the record's vocabulary for the drafting assistant; never patient data",
        )
        self.secret.grant_read(seed_fn)
        if vocabulary_bucket is not None:
            vocabulary_bucket.grant_put(seed_fn)
            # Nightly: the record changes, the vocabulary follows (a direct invoke, not CloudFormation — the handler tells them apart).
            events.Rule(
                self, "NightlyVocabulary",
                description=f"Refresh the record vocabulary of {hospital_id} from the hospital's FHIR server",
                schedule=events.Schedule.cron(minute="20", hour="3"),
                targets=[targets.LambdaFunction(seed_fn, event=events.RuleTargetInput.from_object({"task": "vocabulary", "budget_s": 240}))],
            )
        provider_logs = logs.LogGroup(self, "SeedProviderLogs", retention=logs.RetentionDays.ONE_WEEK, removal_policy=RemovalPolicy.DESTROY)
        provider = cr.Provider(self, "SeedProvider", on_event_handler=seed_fn, log_group=provider_logs)
        self.seed = CustomResource(
            self, "Seed",
            service_token=provider.service_token,
            resource_type="Custom::MedAppHospitalDefinitions",
            properties={
                "definitions_hash": _definitions_hash(),
                "fhir_base_url": servers.fhir_base_url,
                "dicomweb_base_url": servers.dicomweb_base_url or "",
                **({"record_vocabulary": f"s3://{vocabulary_bucket.bucket_name}/{vocabulary_key}"} if vocabulary_bucket is not None else {}),  # a new bucket re-runs the seed, which writes it
            },
        )

        if definitions_writer:
            ssm.StringParameter(self, "DefinitionsWriterParam", parameter_name=DEFINITIONS_WRITER_PARAMETER.format(hospital_id=hospital_id), string_value=seed_fn.function_name)

        # ── Discovery ────────────────────────────────────────────────────────────────────────────
        prefix = f"/medapp/{hospital_id}/hospital"
        ssm.StringParameter(self, "FhirBaseUrlParam", parameter_name=f"{prefix}/fhir-base-url", string_value=servers.fhir_base_url)
        ssm.StringParameter(self, "TokenUrlParam", parameter_name=f"{prefix}/token-url", string_value=servers.token_url)
        ssm.StringParameter(self, "CredentialsSecretParam", parameter_name=f"{prefix}/credentials-secret", string_value=servers.credentials_secret)
        if servers.scope:
            ssm.StringParameter(self, "ScopeParam", parameter_name=f"{prefix}/oauth-scope", string_value=servers.scope)
        if servers.dicomweb_base_url:
            ssm.StringParameter(self, "DicomWebBaseUrlParam", parameter_name=f"{prefix}/dicomweb-base-url", string_value=servers.dicomweb_base_url)
        if self.viewer_dicomweb_url:
            ssm.StringParameter(self, "ViewerDicomWebUrlParam", parameter_name=f"{prefix}/viewer-dicomweb-base-url", string_value=self.viewer_dicomweb_url)

        CfnOutput(self, "FhirBaseUrl", value=servers.fhir_base_url)
        CfnOutput(self, "CredentialsSecret", value=servers.credentials_secret, description="Secrets Manager secret with the hospital's client id and secret (set with scripts/set-hospital-credentials.py)")
        if servers.dicomweb_base_url:
            CfnOutput(self, "DicomWebBaseUrl", value=servers.dicomweb_base_url)
        if self.viewer_dicomweb_url:
            CfnOutput(self, "ViewerDicomWebUrl", value=self.viewer_dicomweb_url, description="What OHIF reads the hospital's PACS through (Cognito ID token in, hospital token out)")
        if self.spill_bucket is not None:
            CfnOutput(self, "ViewerSpillBucket", value=self.spill_bucket.bucket_name, description="Where the door puts answers too large for a Lambda response before redirecting the browser (objects expire after a day)")
        CfnOutput(self, "SeedSummary", value=self.seed.get_att_string("findings"), description="Findings of the definitions seed and connectivity check")

    def grant_read_credentials(self, grantee: iam.IGrantable) -> iam.Grant:
        """The dispatcher reads the hospital's client credentials to obtain tokens."""
        return self.secret.grant_read(grantee)


def _definitions_hash() -> str:
    """The seed re-runs when a definition in the bundle changes, not when a patient does."""
    import hashlib

    with open(SEED_BUNDLE, encoding="utf-8") as f:
        bundle = json.load(f)
    items = [e["resource"] for e in bundle.get("entry", []) if (e.get("resource") or {}).get("resourceType") in ("Questionnaire", "ValueSet", "CodeSystem")]
    return hashlib.sha256(json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


__all__ = ["HospitalServers", "HospitalServersStack"]
