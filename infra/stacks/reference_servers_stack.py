"""
Reference servers — a FHIR R4 server and a DICOMweb PACS that stand in for the hospital's systems until those
are reachable, seeded with the synthetic record. Part of the deployment while `reference_servers` is true in
the hospital's file under infra/hospitals/ (see app.py).

Why: the dispatcher's HTTP path (search parameters, paging, conditional create, versioned update) and the
imaging primitives had only ever run against the in-memory bundle. Standards-plain servers exercise them the
way the hospital's FHIR facade and PACS gateway will; switching to those later is configuration
(FHIR_BASE_URL / FHIR_AUTH, DICOMWEB_BASE_URL / DICOMWEB_AUTH).

Shape — cost first (no NAT gateway, no interface endpoints, small tasks, one small database):

  VPC (2 AZs)   public subnets  → the Fargate tasks: pull their images through the internet gateway; their
                                  security groups admit only the load balancer
                isolated subnets → RDS Postgres, the internal ALB, the API's VPC link
  HAPI FHIR JPA (hapiproject/hapi, ARM64, 1 vCPU / 2 GB) → Postgres 16 on db.t4g.micro (credentials generated
                                  in Secrets Manager, never in code or CloudFormation)
  Orthanc (orthancteam/orthanc, ARM64, ½ vCPU / 1 GB) with the DICOMweb and Indexer plugins. Its studies are
                                  generated at synth from the bundle's ImagingStudy resources (seeding/dicom_seed.py),
                                  deployed to an S3 bucket, and copied into the task by an init container at every
                                  start; the Indexer plugin publishes that folder. The seed is the truth: a restart
                                  rebuilds the PACS, nothing to back up. (Read-only imaging: no STOW in this slice.)
  Internal ALB (HTTP :80, VPC only): /dicom-web* → Orthanc, everything else → HAPI
      ← HTTP API (HTTPS, IAM authorisation) through a VPC link → https://<api>/fhir · https://<api>/dicom-web
  Seed: a custom resource loads the bundle as a FHIR transaction once the services are stable (create, and again
        when a seed's hash changes), verifies the searches the primitives rely on, and checks the PACS answers
        QIDO-RS by MRN with every study the record declares.

Who may call the servers: IAM identities with execute-api:Invoke on the API — the dispatcher's role, the seed
function, and staff running the scripts. The dispatcher stays outside the VPC and signs (SigV4). Nothing here is
reachable from the internet without such an identity; the servers have no authentication of their own, which
is why they are never exposed directly.
"""

from __future__ import annotations

import json
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    CustomResource,
    Duration,
    RemovalPolicy,
    Size,
    Stack,
    Tags,
    aws_apigatewayv2 as apigw,
    aws_apigatewayv2_authorizers as authorizers,
    aws_apigatewayv2_integrations as integrations,
    aws_cognito as cognito,
    aws_ec2 as ec2,
    aws_ecs as ecs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    aws_lambda as lam,
    aws_logs as logs,
    aws_rds as rds,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
    aws_ssm as ssm,
    custom_resources as cr,
)
from constructs import Construct

from .definitions import DEFINITIONS_WRITER_PARAMETER

from .viewer_stack import ViewerRuntimeConfig, ViewerStack

INFRA_ROOT = Path(__file__).resolve().parents[1]
DISPATCHER_DIR = INFRA_ROOT / "lambdas" / "dispatcher"
SEED_BUNDLE = DISPATCHER_DIR / "data" / "synthetic-musterstadt.bundle.json"

# Pinned release tags, all published for amd64 and arm64.
HAPI_IMAGE = "hapiproject/hapi:v8.12.0-1"
HAPI_PORT = 8080
ORTHANC_IMAGE = "orthancteam/orthanc:26.9.0"
ORTHANC_PORT = 8042
AWS_CLI_IMAGE = "amazon/aws-cli:2.36.47"  # the init container that copies the DICOM seed from S3
DICOM_SEED_MOUNT = "/seed"


def orthanc_settings(public_root: str | None = None) -> dict:
    """
    Orthanc's configuration, passed whole as ORTHANC_JSON (the image merges it over its defaults). No DICOM
    network port, no authentication of its own (the IAM-authorised API is the only way in), the seed folder
    published by the Indexer plugin, DICOMweb at /dicom-web/. `public_root` is the DICOMweb URL as browsers see
    it — the viewer door of the API — so the BulkDataURIs and retrieve links Orthanc writes into metadata resolve.
    """
    dicomweb = {"Enable": True, "Root": "/dicom-web/", "EnableWado": True, "WadoRoot": "/wado", "Ssl": False, "StudiesMetadata": "Full", "SeriesMetadata": "Full", "EnableMetadataCache": True}
    if public_root:
        dicomweb["PublicRoot"] = public_root.rstrip("/") + "/"
    return {
        "Name": "MedApp reference PACS (synthetic record)",
        "RemoteAccessAllowed": True,
        "AuthenticationEnabled": False,
        "DicomServerEnabled": False,
        "HttpPort": ORTHANC_PORT,
        "HttpCompressionEnabled": True,
        "StorageDirectory": "/var/lib/orthanc/db",
        "IndexDirectory": "/var/lib/orthanc/db",
        # Files stay where the init container put them; the plugin indexes them a few seconds after start.
        "Indexer": {"Enable": True, "Folders": [DICOM_SEED_MOUNT], "Interval": 10},
        "DicomWeb": dicomweb,
        # A study is "stable" once no instance arrived for this many seconds; QIDO counts are exact after that.
        "StableAge": 5,
        "ConcurrentJobs": 2,
    }


def hapi_settings(server_address: str) -> dict:
    """
    The starter's application.yaml overrides, passed as SPRING_APPLICATION_JSON so property names are exact
    (relaxed binding of underscore names through environment variables is not something to rely on).
    """
    return {
        "hapi": {
            "fhir": {
                "fhir_version": "R4",
                # Links (`next`, Bundle.entry.fullUrl) must point at the API, not the internal load balancer.
                "server_address": server_address,
                # Canonical references (QuestionnaireResponse.questionnaire) and identifiers by URL are not local resources.
                "allow_external_references": True,
                # A reading recorded a second ago must show in the next search — no result cache for a demo server.
                "reuse_cached_search_results_millis": 0,
                # The primitives ask for up to 500 in one page (the dispatcher follows `next` links beyond that).
                "default_page_size": 100,
                "max_page_size": 500,
                # Not used here; each costs memory or exposes an endpoint the dispatcher never calls.
                "openapi_enabled": False,
                "narrative_enabled": False,
                "ig_runtime_upload_enabled": False,
                "mdm_enabled": False,
                "cr": {"enabled": False},
                "cdshooks": {"enabled": False},
                "bulk_export_enabled": False,
                "bulk_import_enabled": False,
                "tester": {"home": {"name": "MedApp reference", "server_address": server_address, "fhir_version": "R4"}},
            }
        },
        # The starter ships an MCP endpoint for AI agents; this server is a data store, nothing else.
        "spring": {"ai": {"mcp": {"server": {"enabled": False}}}},
    }


class ReferenceServersStack(Stack):
    """
    A HAPI FHIR server and an Orthanc PACS behind one IAM-authorised HTTP API, seeded with the synthetic record.

    Exposes `fhir_base_url` and `dicomweb_base_url` for the dispatcher and `grant_invoke()` for whoever must reach them.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        hospital_id: str,
        user_pool: cognito.IUserPool | None = None,
        web_client: cognito.IUserPoolClient | None = None,
        browser_origins: list[str] | None = None,
        viewer: ViewerStack | None = None,
        vocabulary_bucket: s3.IBucket | None = None,
        vocabulary_key: str = "record-vocabulary.json",
        definitions_writer: bool = True,
        **kwargs,
    ) -> None:
        """
        `user_pool` + `web_client` open the browser door (`GET /viewer/dicom-web/…`, Cognito JWT) for the imaging
        viewer; `browser_origins` are the origins CORS admits there (the viewer, the panel, localhost); `viewer`
        receives its app-config.js pointing at that door. `definitions_writer`: this record is the one the apps run
        on, so the seed Lambda is named (SSM `/medapp/<hospital_id>/data-source/definitions-writer`) as the function
        that writes an app's own forms to it at publish — false when a hospital's server is the data source.
        """
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "reference-servers")

        # ── Network: two AZs, no NAT ─────────────────────────────────────────────────────────────
        self.vpc = ec2.Vpc(
            self, "Vpc",
            vpc_name=f"medapp-{hospital_id}-reference",
            # Two AZs: the first synth with credentials looks them up once and caches them in cdk.context.json (commit it).
            max_azs=2,
            nat_gateways=0,
            ip_addresses=ec2.IpAddresses.cidr("10.42.0.0/16"),
            subnet_configuration=[
                ec2.SubnetConfiguration(name="public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="isolated", subnet_type=ec2.SubnetType.PRIVATE_ISOLATED, cidr_mask=24),
            ],
            restrict_default_security_group=True,
        )
        public = ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC)
        isolated = ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_ISOLATED)

        alb_sg = ec2.SecurityGroup(self, "AlbSg", vpc=self.vpc, description="Reference servers: internal load balancer", allow_all_outbound=True)
        task_sg = ec2.SecurityGroup(self, "TaskSg", vpc=self.vpc, description="Reference servers: HAPI task (egress for the image pull; ingress from the ALB only)", allow_all_outbound=True)
        orthanc_sg = ec2.SecurityGroup(self, "OrthancSg", vpc=self.vpc, description="Reference servers: Orthanc task (egress for the image pull and the S3 seed; ingress from the ALB only)", allow_all_outbound=True)
        db_sg = ec2.SecurityGroup(self, "DbSg", vpc=self.vpc, description="Reference servers: Postgres (ingress from the HAPI task only)", allow_all_outbound=False)
        link_sg = ec2.SecurityGroup(self, "VpcLinkSg", vpc=self.vpc, description="Reference servers: API Gateway VPC link", allow_all_outbound=True)

        alb_sg.add_ingress_rule(link_sg, ec2.Port.tcp(80), "HTTP API through the VPC link")
        task_sg.add_ingress_rule(alb_sg, ec2.Port.tcp(HAPI_PORT), "load balancer to HAPI")
        orthanc_sg.add_ingress_rule(alb_sg, ec2.Port.tcp(ORTHANC_PORT), "load balancer to Orthanc")
        db_sg.add_ingress_rule(task_sg, ec2.Port.tcp(5432), "HAPI to Postgres")

        # ── Database ─────────────────────────────────────────────────────────────────────────────
        self.database = rds.DatabaseInstance(
            self, "HapiDb",
            engine=rds.DatabaseInstanceEngine.postgres(version=rds.PostgresEngineVersion.VER_16),
            instance_type=ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
            vpc=self.vpc,
            vpc_subnets=isolated,
            security_groups=[db_sg],
            credentials=rds.Credentials.from_generated_secret("hapi", secret_name=f"medapp/{hospital_id}/reference/hapi-db"),
            database_name="hapi",
            allocated_storage=20,
            max_allocated_storage=50,
            storage_type=rds.StorageType.GP3,
            storage_encrypted=True,
            multi_az=False,
            publicly_accessible=False,
            backup_retention=Duration.days(1),
            delete_automated_backups=True,
            deletion_protection=False,
            removal_policy=RemovalPolicy.DESTROY,  # synthetic data; the seed recreates it
            auto_minor_version_upgrade=True,
            cloudwatch_logs_exports=["postgresql"],
            cloudwatch_logs_retention=logs.RetentionDays.ONE_WEEK,
        )

        # ── The API in front (created before the task so HAPI knows its public address) ─────────
        vpc_link = apigw.VpcLink(self, "VpcLink", vpc=self.vpc, subnets=isolated, security_groups=[link_sg], vpc_link_name=f"medapp-{hospital_id}-reference")
        cors = None
        if browser_origins:
            # The viewer (a browser on another origin) reads DICOMweb through this API: preflights are answered here,
            # and API Gateway's CORS headers replace whatever the servers behind would send.
            cors = apigw.CorsPreflightOptions(
                allow_origins=sorted(set(browser_origins)),
                allow_methods=[apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.OPTIONS],
                allow_headers=["authorization", "content-type", "accept", "x-requested-with"],
                max_age=Duration.hours(1),
            )
        self.http_api = apigw.HttpApi(
            self, "HttpApi",
            api_name=f"medapp-{hospital_id}-reference",
            description=f"MedApp reference servers (FHIR, DICOMweb) · {hospital_id} · IAM-authorised; Cognito JWT for the viewer door",
            cors_preflight=cors,
        )
        api_url = self.http_api.url or ""  # https://<id>.execute-api.<region>.amazonaws.com/
        self.fhir_base_url = f"{api_url}fhir"
        self.dicomweb_base_url = f"{api_url}dicom-web"
        # The browser door: the same PACS, a different authorizer, the path rewritten to what Orthanc serves.
        self.viewer_dicomweb_url = f"{api_url}viewer/dicom-web"

        # ── HAPI on Fargate ──────────────────────────────────────────────────────────────────────
        self.cluster = ecs.Cluster(self, "Cluster", vpc=self.vpc, cluster_name=f"medapp-{hospital_id}-reference")

        hapi_logs = logs.LogGroup(self, "HapiLogs", log_group_name=f"/medapp/{hospital_id}/reference/hapi", retention=logs.RetentionDays.ONE_WEEK, removal_policy=RemovalPolicy.DESTROY)

        task = ecs.FargateTaskDefinition(
            self, "HapiTask",
            cpu=1024,
            memory_limit_mib=2048,
            runtime_platform=ecs.RuntimePlatform(cpu_architecture=ecs.CpuArchitecture.ARM64, operating_system_family=ecs.OperatingSystemFamily.LINUX),
        )
        task.add_container(
            "hapi",
            image=ecs.ContainerImage.from_registry(HAPI_IMAGE),
            port_mappings=[ecs.PortMapping(container_port=HAPI_PORT)],
            logging=ecs.LogDrivers.aws_logs(stream_prefix="hapi", log_group=hapi_logs),
            environment={
                "SPRING_DATASOURCE_URL": f"jdbc:postgresql://{self.database.db_instance_endpoint_address}:{self.database.db_instance_endpoint_port}/hapi",
                "SPRING_DATASOURCE_DRIVERCLASSNAME": "org.postgresql.Driver",
                "HIBERNATE_DIALECT": "ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect",
                "SPRING_APPLICATION_JSON": json.dumps(hapi_settings(self.fhir_base_url)),
                # The JVM sizes its heap from the container limit; the default quarter is too small for HAPI.
                "JAVA_TOOL_OPTIONS": "-XX:MaxRAMPercentage=75",
            },
            secrets={
                "SPRING_DATASOURCE_USERNAME": ecs.Secret.from_secrets_manager(self.database.secret, "username"),  # type: ignore[arg-type]
                "SPRING_DATASOURCE_PASSWORD": ecs.Secret.from_secrets_manager(self.database.secret, "password"),  # type: ignore[arg-type]
            },
        )

        self.service = ecs.FargateService(
            self, "HapiService",
            cluster=self.cluster,
            service_name=f"medapp-{hospital_id}-hapi",
            task_definition=task,
            desired_count=1,
            # One instance at a time: a second HAPI migrating the same schema during a rolling deploy is not wanted.
            min_healthy_percent=0,
            max_healthy_percent=100,
            circuit_breaker=ecs.DeploymentCircuitBreaker(enable=True, rollback=True),
            assign_public_ip=True,  # public subnet, no NAT: the image pull needs a route out; ingress is the ALB only
            vpc_subnets=public,
            security_groups=[task_sg],
            health_check_grace_period=Duration.minutes(5),  # a JVM plus schema creation on a small database
            enable_execute_command=False,
        )

        alb = elbv2.ApplicationLoadBalancer(self, "Alb", vpc=self.vpc, internet_facing=False, vpc_subnets=isolated, security_group=alb_sg, load_balancer_name=f"medapp-{hospital_id}-reference")
        listener = alb.add_listener("Http", port=80, open=False)
        listener.add_targets(
            "Hapi",
            port=HAPI_PORT,
            protocol=elbv2.ApplicationProtocol.HTTP,
            targets=[self.service],
            deregistration_delay=Duration.seconds(15),
            health_check=elbv2.HealthCheck(path="/actuator/health", healthy_http_codes="200", interval=Duration.seconds(30), timeout=Duration.seconds(10), healthy_threshold_count=2, unhealthy_threshold_count=5),
        )

        # ── Orthanc on Fargate: the DICOM seed from S3, published by the Indexer plugin ───────────
        self.seed_bucket = s3.Bucket(
            self, "SeedBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,  # generated data; the next synth regenerates it
        )
        dicom_seed_dir, dicom_seed_digest, dicom_seed_marker = _stage_dicom_seed()
        dicom_deployment = s3deploy.BucketDeployment(
            self, "DicomSeed",
            sources=[s3deploy.Source.asset(dicom_seed_dir)],
            destination_bucket=self.seed_bucket,
            destination_key_prefix="dicom",
            prune=True,
            memory_limit=1024,
            ephemeral_storage_size=Size.mebibytes(1024),
        )

        orthanc_logs = logs.LogGroup(self, "OrthancLogs", log_group_name=f"/medapp/{hospital_id}/reference/orthanc", retention=logs.RetentionDays.ONE_WEEK, removal_policy=RemovalPolicy.DESTROY)
        orthanc_task = ecs.FargateTaskDefinition(
            self, "OrthancTask",
            cpu=512,
            memory_limit_mib=1024,
            runtime_platform=ecs.RuntimePlatform(cpu_architecture=ecs.CpuArchitecture.ARM64, operating_system_family=ecs.OperatingSystemFamily.LINUX),
            volumes=[ecs.Volume(name="seed")],  # task-scoped ephemeral storage, filled at every start
        )
        self.seed_bucket.grant_read(orthanc_task.task_role)
        sync = orthanc_task.add_container(
            "seed-sync",
            image=ecs.ContainerImage.from_registry(AWS_CLI_IMAGE),
            essential=False,  # runs to completion before Orthanc starts
            command=["s3", "sync", f"s3://{self.seed_bucket.bucket_name}/dicom", DICOM_SEED_MOUNT, "--no-progress", "--only-show-errors"],
            environment={"AWS_REGION": self.region},
            logging=ecs.LogDrivers.aws_logs(stream_prefix="seed-sync", log_group=orthanc_logs),
        )
        sync.add_mount_points(ecs.MountPoint(container_path=DICOM_SEED_MOUNT, source_volume="seed", read_only=False))
        orthanc = orthanc_task.add_container(
            "orthanc",
            image=ecs.ContainerImage.from_registry(ORTHANC_IMAGE),
            port_mappings=[ecs.PortMapping(container_port=ORTHANC_PORT)],
            logging=ecs.LogDrivers.aws_logs(stream_prefix="orthanc", log_group=orthanc_logs),
            environment={
                "ORTHANC_JSON": json.dumps(orthanc_settings(public_root=self.viewer_dicomweb_url)),
                "DICOM_WEB_PLUGIN_ENABLED": "true",
                "INDEXER_PLUGIN_ENABLED": "true",
                "VERBOSE_ENABLED": "false",
                # Not read by Orthanc: a new seed must mean a new task definition, so ECS replaces the task and the
                # init container copies the new files. Without this the bucket changes and the running task keeps
                # serving the seed it started with.
                "MEDAPP_SEED_DIGEST": dicom_seed_digest,
            },
        )
        orthanc.add_mount_points(ecs.MountPoint(container_path=DICOM_SEED_MOUNT, source_volume="seed", read_only=True))
        orthanc.add_container_dependencies(ecs.ContainerDependency(container=sync, condition=ecs.ContainerDependencyCondition.SUCCESS))

        self.orthanc_service = ecs.FargateService(
            self, "OrthancService",
            cluster=self.cluster,
            service_name=f"medapp-{hospital_id}-orthanc",
            task_definition=orthanc_task,
            desired_count=1,
            min_healthy_percent=0,
            max_healthy_percent=100,
            circuit_breaker=ecs.DeploymentCircuitBreaker(enable=True, rollback=True),
            assign_public_ip=True,
            vpc_subnets=public,
            security_groups=[orthanc_sg],
            health_check_grace_period=Duration.minutes(3),  # the S3 copy, then Orthanc's start and first index pass
            enable_execute_command=False,
        )
        self.orthanc_service.node.add_dependency(dicom_deployment)  # the init container must find the files
        listener.add_targets(
            "Orthanc",
            port=ORTHANC_PORT,
            protocol=elbv2.ApplicationProtocol.HTTP,
            targets=[self.orthanc_service],
            priority=10,
            conditions=[elbv2.ListenerCondition.path_patterns(["/dicom-web", "/dicom-web/*"])],
            deregistration_delay=Duration.seconds(15),
            health_check=elbv2.HealthCheck(path="/system", healthy_http_codes="200", interval=Duration.seconds(30), timeout=Duration.seconds(10), healthy_threshold_count=2, unhealthy_threshold_count=5),
        )

        # /fhir goes to HAPI, /dicom-web to Orthanc (the load balancer decides by path); only IAM-signed requests get through the API.
        routes = []
        for name, path in (("Hapi", "/fhir"), ("DicomWeb", "/dicom-web")):
            routes += self.http_api.add_routes(
                path=f"{path}/{{proxy+}}",
                methods=[apigw.HttpMethod.ANY],
                integration=integrations.HttpAlbIntegration(f"{name}Integration", listener, vpc_link=vpc_link),
                authorizer=authorizers.HttpIamAuthorizer(),
            )
            routes += self.http_api.add_routes(
                path=path,
                methods=[apigw.HttpMethod.ANY],
                integration=integrations.HttpAlbIntegration(f"{name}RootIntegration", listener, vpc_link=vpc_link),
                authorizer=authorizers.HttpIamAuthorizer(),
            )

        # ── The viewer door: Cognito-authenticated browsers read the PACS, GET only ─────────────
        self.viewer_route = None
        if user_pool is not None and web_client is not None:
            viewer_jwt = authorizers.HttpJwtAuthorizer(
                "ViewerJwt",
                jwt_issuer=f"https://cognito-idp.{self.region}.amazonaws.com/{user_pool.user_pool_id}",
                jwt_audience=[web_client.user_pool_client_id],
            )
            self.viewer_route = self.http_api.add_routes(
                path="/viewer/dicom-web/{proxy+}",
                methods=[apigw.HttpMethod.GET],
                integration=integrations.HttpAlbIntegration(
                    "ViewerDicomWebIntegration",
                    listener,
                    vpc_link=vpc_link,
                    parameter_mapping=apigw.ParameterMapping().overwrite_path(apigw.MappingValue.custom("/dicom-web/${request.path.proxy}")),
                ),
                authorizer=viewer_jwt,
            )
        if viewer is not None:
            # The reference record is the data source: the same door is also the `reference` source, so a preview's
            # `/viewer/reference?…` URL opens here exactly as a clinician's `/viewer?…` does.
            ViewerRuntimeConfig(self, "ViewerConfig", viewer=viewer, dicomweb_root=self.viewer_dicomweb_url, synthetic_root=self.viewer_dicomweb_url)

        # ── Seed: the synthetic record, once the server is up ────────────────────────────────────
        seed_fn = lam.Function(
            self, "SeedFn",
            function_name=f"medapp-{hospital_id}-reference-seed",
            runtime=lam.Runtime.PYTHON_3_14,
            architecture=lam.Architecture.ARM_64,
            handler="seed.lambda_handler",
            # The dispatcher's own package: the same FHIR client, the same bundle — one copy of each.
            code=lam.Code.from_asset(str(DISPATCHER_DIR), exclude=["__pycache__", "*.pyc"]),
            layers=[lam.LayerVersion(self, "SeedSharedLayer", code=lam.Code.from_asset(_stage_shared_layer()), compatible_runtimes=[lam.Runtime.PYTHON_3_14], compatible_architectures=[lam.Architecture.ARM_64], description="medapp_shared for the seed function (SigV4)")],
            memory_size=512,
            timeout=Duration.minutes(5),
            environment={
                "HOSPITAL_ID": hospital_id,
                "FHIR_BASE_URL": self.fhir_base_url,
                "FHIR_AUTH": "sigv4",
                "FHIR_TIMEOUT_S": "120",
                "DICOMWEB_BASE_URL": self.dicomweb_base_url,
                "DICOM_VERIFY_WAIT_S": "150",  # the Indexer publishes the seed a few seconds after Orthanc starts
                # While the reference record is the deployment's data source: its vocabulary for the drafting assistant.
                **({"RECORD_VOCABULARY_BUCKET": vocabulary_bucket.bucket_name, "RECORD_VOCABULARY_KEY": vocabulary_key} if vocabulary_bucket is not None else {}),
            },
            description="Loads the synthetic record into the reference FHIR server, verifies the searches the primitives rely on, checks the PACS answers by MRN, and reads the record's vocabulary",
        )
        seed_grant = self.grant_invoke(seed_fn)
        if vocabulary_bucket is not None:
            vocabulary_bucket.grant_put(seed_fn)
            events.Rule(
                self, "NightlyVocabulary",
                description=f"Refresh the record vocabulary of {hospital_id} from the reference FHIR server",
                schedule=events.Schedule.cron(minute="20", hour="3"),
                targets=[targets.LambdaFunction(seed_fn, event=events.RuleTargetInput.from_object({"task": "vocabulary", "budget_s": 240}))],
            )

        provider_logs = logs.LogGroup(self, "SeedProviderLogs", retention=logs.RetentionDays.ONE_WEEK, removal_policy=RemovalPolicy.DESTROY)
        provider = cr.Provider(self, "SeedProvider", on_event_handler=seed_fn, log_group=provider_logs)
        seed = CustomResource(
            self, "Seed",
            service_token=provider.service_token,
            resource_type="Custom::MedAppReferenceSeed",
            properties={
                "seed_hash": _file_hash(SEED_BUNDLE),
                "dicom_seed_hash": dicom_seed_digest,
                "dicom_seed_marker": dicom_seed_marker,  # what the PACS must be serving (SoftwareVersions of every instance)
                "fhir_base_url": self.fhir_base_url,
                "dicomweb_base_url": self.dicomweb_base_url,
                # Only while this record is the data source — an absent key leaves a hospital deployment's reference seed untouched.
                **({"record_vocabulary": f"s3://{vocabulary_bucket.bucket_name}/{vocabulary_key}"} if vocabulary_bucket is not None else {}),
            },
        )
        # Order: the services are stable (CloudFormation completes them only when healthy), the routes exist, and the
        # seed function's permission to call the API is in place — only then does the seed run.
        seed.node.add_dependency(self.service)
        seed.node.add_dependency(self.orthanc_service)
        for route in routes:
            seed.node.add_dependency(route)
        seed_grant.apply_before(seed)

        if definitions_writer:
            ssm.StringParameter(self, "DefinitionsWriterParam", parameter_name=DEFINITIONS_WRITER_PARAMETER.format(hospital_id=hospital_id), string_value=seed_fn.function_name)

        # ── Discovery ────────────────────────────────────────────────────────────────────────────
        prefix = f"/medapp/{hospital_id}/reference"
        ssm.StringParameter(self, "FhirBaseUrlParam", parameter_name=f"{prefix}/fhir-base-url", string_value=self.fhir_base_url)
        ssm.StringParameter(self, "DicomWebBaseUrlParam", parameter_name=f"{prefix}/dicomweb-base-url", string_value=self.dicomweb_base_url)
        ssm.StringParameter(self, "ViewerDicomWebUrlParam", parameter_name=f"{prefix}/viewer-dicomweb-base-url", string_value=self.viewer_dicomweb_url)
        ssm.StringParameter(self, "ApiIdParam", parameter_name=f"{prefix}/api-id", string_value=self.http_api.api_id)
        CfnOutput(self, "FhirBaseUrl", value=self.fhir_base_url, description="Reference FHIR server (IAM-signed requests only)")
        CfnOutput(self, "DicomWebBaseUrl", value=self.dicomweb_base_url, description="Reference PACS, DICOMweb (IAM-signed requests only)")
        CfnOutput(self, "ViewerDicomWebUrl", value=self.viewer_dicomweb_url, description="Reference PACS, DICOMweb for browsers (Cognito ID token, GET only)")
        CfnOutput(self, "SeedSummary", value=seed.get_att_string("findings"), description="Findings of the seed verification (none = every primitive search answered, every study on the PACS)")

    def grant_invoke(self, grantee: iam.IGrantable) -> iam.Grant:
        """Allow an identity to call the reference API: every method under /fhir and /dicom-web."""
        return iam.Grant.add_to_principal(
            grantee=grantee,
            actions=["execute-api:Invoke"],
            resource_arns=[self.http_api.arn_for_execute_api(method="*", path=p, stage="*") for p in ("/fhir", "/fhir/*", "/dicom-web", "/dicom-web/*")],
        )


def _file_hash(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _stage_shared_layer() -> str:
    from .api_stack import stage_shared_layer

    return stage_shared_layer()


def _stage_dicom_seed() -> tuple[str, str, str]:
    """
    The generated DICOM studies (seeding/dicom_seed.py) as an asset directory, the hash they were made from, and the
    marker every instance carries in SoftwareVersions (what the seed verification expects the PACS to serve).
    """
    try:
        from seeding.dicom_seed import DEFAULT_BUNDLE, seed_hash, seed_marker, stage_dicom_seed
    except ImportError as err:  # pydicom / numpy are in requirements.txt; synth needs them like it needs node_modules
        raise RuntimeError("generating the DICOM seed needs pydicom and numpy: pip install -r requirements.txt") from err
    with open(DEFAULT_BUNDLE, encoding="utf-8") as f:
        digest = seed_hash(json.load(f))
    return stage_dicom_seed(), digest, seed_marker(digest)
