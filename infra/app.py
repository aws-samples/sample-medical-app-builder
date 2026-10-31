#!/usr/bin/env python3
"""
The CDK app: one stage per hospital. Each file under infra/hospitals/ is a deployment — its stacks are named
`<hospital_id>-<Stack>`, so several hospitals share one account and region without touching each other — and
`cdk deploy '<hospital_id>/*'` deploys one of them (stacks/hospitals.py, infra/README.md "Adding a hospital").
"""

import os
from collections.abc import Iterable
from pathlib import Path

import aws_cdk as cdk
import cdk_nag

from aws_cdk import Tags
from constructs import Construct
from stacks import *
from stacks.email_templates import parse_language
from stacks.hospitals import HOSPITALS_DIR, ConfigError, HospitalConfig, load_hospitals
from stacks.nag import apply_accepted_findings
from stacks.residency import ResidencyError, enforce as enforce_residency, model_region_pattern


class HospitalDeployment(cdk.Stage):
    """One hospital's stacks, named `<hospital_id>-<Stack>`: several hospitals share an account and a region without touching each other's stacks."""

    def __init__(self, scope: Construct, hospital: HospitalConfig) -> None:
        super().__init__(scope, hospital.hospital_id)
        self.hospital = hospital
        build(self, hospital)


def build(scope: Construct, hospital: HospitalConfig) -> None:
    """Every stack of one hospital's deployment, from its configuration (infra/hospitals/<id>.json) — called by the stage above and by the tests that check the whole app."""

    # The deployment's identifier — in every resource name and SSM path, so it must never change once deployed.
    hospital_id = hospital.hospital_id

    # The Bedrock model (or inference profile) the drafting agent runs on
    model_id = hospital.model_id

    env = cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=hospital.region or os.environ.get("CDK_DEFAULT_REGION") or "eu-central-1",
    )

    # Where data may be processed (`data_residency`, `eu` for this hospital): the deployment region and the
    # agent's model are checked here, at synth — a `us.` or `global.` inference profile does not deploy (stacks/residency.py).
    data_residency = hospital.data_residency

    try:
        enforce_residency(env.region, model_id, data_residency)
    except ResidencyError as err:
        raise SystemExit(f"{hospital_id}: data residency: {err}") from err

    # The panel on CloudFront. Built at synth from ../med_app (MEDAPP_APP_DIR overrides); its runtime config.json is
    # written by the ApiStack below, once the API URL exists. `frontend_origins` keeps the dev server allowed too.
    # First, because the identity stack's emails link to it (`panel_url` names a custom domain instead).
    hosting = HostingStack(
        scope, "HostingStack",
        hospital_id=hospital_id,
        branding_dir=hospital.branding_dir,  # the hospital's logo files, served under /branding/
        env=env,
        description=f"MedApp · panel hosting (S3 + CloudFront) · {hospital_id}",
    )

    identity = IdentityStack(
        scope, "IdentityStack",
        hospital_id=hospital_id,
        hospital_name=hospital.hospital_name,
        mfa_required=hospital.mfa_required,
        cognito_domain_prefix=hospital.cognito_domain_prefix,
        panel_url=hospital.panel_url or hosting.origin,
        invitation_language=parse_language(hospital.invitation_language),
        palette=hospital.palette,  # the emails in the hospital's colours
        env=env,
        description=f"MedApp · identity (Cognito user pool) · {hospital_id}",
    )

    registry = RegistryStack(
        scope, "RegistryStack",
        hospital_id=hospital_id,
        env=env,
        description=f"MedApp · app registry · {hospital_id}",
    )

    # The audit trail: every data access, write, account change and lifecycle step, kept indefinitely; read by administrators.
    audit = AuditStack(
        scope, "AuditStack",
        hospital_id=hospital_id,
        env=env,
        description=f"MedApp · audit trail · {hospital_id}",
    )

    frontend_origins = [*hospital.frontend_origins, hosting.origin]

    authoring = AuthoringStack(
        scope, "AuthoringStack",
        hospital_id=hospital_id,
        hospital_name=identity.hospital_name,
        registry_table=registry.table,
        registry_writer_policy=registry.writer_policy,
        registry_read_policy=registry.read_policy,  # the agent and the drafts API read the record-shape library
        user_pool=identity.user_pool,
        group_provisioning_policy=identity.group_provisioning_policy,
        audit_table=audit.table,
        audit_write_policy=audit.write_policy,
        model_id=model_id,
        model_region_pattern=model_region_pattern(data_residency),  # the agent may only invoke models in the geography
        env=env,
        description=f"MedApp · authoring (drafts, agent, manifest service, registry writes) · {hospital_id}",
    )

    # Where the dispatcher's clinical data comes from. `reference_servers` deploys a HAPI FHIR server seeded with the
    # synthetic record (ReferenceServersStack) and points the dispatcher at it (SigV4). It is deployment configuration,
    # not a per-deploy switch: left out, the ApiStack would redeploy with the in-memory bundle. Without it the
    # dispatcher serves the bundle packaged with the Lambda, or — `data_source: fhir` with `fhir_base_url`
    # [and `fhir_auth: bearer|none`] — a hospital server; a bearer token then goes into the dispatcher's
    # FHIR_BEARER_TOKEN out of band.
    data_source: str = hospital.data_source or "bundle"
    fhir_base_url: str | None = hospital.fhir_base_url
    fhir_auth: str | None = hospital.fhir_auth
    dicomweb_base_url: str | None = hospital.dicomweb_base_url  # a PACS gateway (QIDO-RS); the reference stack sets it

    reference: ReferenceServersStack | None = None
    hospital_stack: HospitalServersStack | None = None
    viewer: ViewerStack | None = None
    dispatcher_environment: dict[str, str] = {}
    ohif_viewer_url: str | None = hospital.ohif_viewer_url  # an external viewer; the ViewerStack sets it otherwise

    # `hospital_servers`: the hospital's own FHIR server and DICOMweb gateway, reached with OAuth2 client credentials
    # whose secret lives in Secrets Manager (scripts/set-hospital-credentials.py). When set, the dispatcher and the
    # viewer use them; the reference servers, if also deployed, serve the integration tests only.
    try:
        hospital_servers = HospitalServers.from_context(hospital.hospital_servers) if hospital.hospital_servers else None
    except ValueError as err:
        raise SystemExit(f"{hospital_id}: {err}") from err
    reference_servers = hospital.reference_servers

    if reference_servers or hospital_servers:
        # The imaging viewer (OHIF) — a separate site the panel embeds; it reads the PACS through a browser door with
        # the panel's Cognito token (the reference API's, or the hospital stack's).
        viewer = ViewerStack(
            scope, "ViewerStack",
            hospital_id=hospital_id,
            frame_ancestors=[hosting.origin, *[o for o in frontend_origins if o.startswith("http://localhost")]],
            env=env,
            description=f"MedApp · imaging viewer (OHIF on CloudFront) · {hospital_id}",
        )

    if reference_servers:
        reference = ReferenceServersStack(
            scope, "ReferenceServersStack",
            hospital_id=hospital_id,
            user_pool=identity.user_pool,
            web_client=identity.web_client,
            browser_origins=[viewer.origin, *frontend_origins],
            viewer=None if hospital_servers else viewer,  # the viewer's app-config is written by whoever is its data source
            # Likewise the record vocabulary the drafting assistant searches: written by the seed of the data source.
            vocabulary_bucket=None if hospital_servers else authoring.vocabulary_bucket,
            vocabulary_key=authoring.vocabulary_key,
            # And an app's own forms at publish: written to the record the apps run on.
            definitions_writer=not hospital_servers,
            env=env,
            description=f"MedApp reference servers · FHIR (HAPI) and DICOMweb (Orthanc) seeded with the synthetic record · {hospital_id}",
        )

        data_source, fhir_base_url, fhir_auth = "fhir", reference.fhir_base_url, "sigv4"
        dicomweb_base_url = reference.dicomweb_base_url
        ohif_viewer_url = ohif_viewer_url or viewer.url

    if hospital_servers:
        hospital_stack = HospitalServersStack(
            scope, "HospitalServersStack",
            hospital_id=hospital_id,
            servers=hospital_servers,
            user_pool=identity.user_pool,
            web_client=identity.web_client,
            browser_origins=[viewer.origin, *frontend_origins],
            viewer=viewer,
            vocabulary_bucket=authoring.vocabulary_bucket,  # the hospital's record is what the assistant must know the codes of
            vocabulary_key=authoring.vocabulary_key,
            # Previews run on the synthetic record: the viewer gets the reference servers' door as a second data source.
            synthetic_dicomweb_root=reference.viewer_dicomweb_url if reference is not None else None,
            env=env,
            description=f"MedApp · the hospital's FHIR server and DICOMweb gateway (OAuth2 client credentials) · {hospital_id}",
        )

        data_source, fhir_base_url, fhir_auth = "fhir", hospital_stack.fhir_base_url, "oauth2"
        dicomweb_base_url = hospital_stack.dicomweb_base_url
        dispatcher_environment = hospital_stack.dispatcher_environment
        ohif_viewer_url = ohif_viewer_url or viewer.url

    api = ApiStack(
        scope, "ApiStack",
        hospital_id=hospital_id,
        table=registry.table,
        registry_read_policy=registry.read_policy,
        user_pool=identity.user_pool,
        web_client=identity.web_client,
        frontend_origins=frontend_origins,
        data_source=data_source,
        fhir_base_url=fhir_base_url,
        fhir_auth=fhir_auth,
        dicomweb_base_url=dicomweb_base_url,
        dispatcher_environment=dispatcher_environment,
        manifest_fn=authoring.manifest_fn,
        drafts_fn=authoring.drafts_fn,
        registry_write_fn=authoring.registry_write_fn,
        audit_table=audit.table,
        audit_write_policy=audit.write_policy,
        audit_read_policy=audit.read_policy,
        env=env,
        description=f"MedApp · API · {hospital_id}",
    )

    if reference is not None and hospital_stack is None:
        reference.grant_invoke(api.dispatcher_fn)
    if hospital_stack is not None:
        hospital_stack.grant_read_credentials(api.dispatcher_fn)

    FrontendRuntimeConfig(
        api,"FrontendConfig",
        hosting=hosting,
        values=runtime_config_values(
            hospital_id=hospital_id,
            hospital_name=identity.hospital_name,
            region=identity.region,
            user_pool_id=identity.user_pool.user_pool_id,
            client_id=identity.web_client.user_pool_client_id,
            api_base_url=api.base_url,
            ohif_viewer_url=ohif_viewer_url,
            branding=hospital.frontend_branding(),  # palette override + logo → VITE_BRANDING; the panel applies it at boot
        ),
    )

    # ── App registry guardrails (optional) ────────────────────────────────────────────────────────────
    # A resource policy on the registry table that lets only the registry write Lambda (and the operator roles named in
    # `app_registry_guard_allowed_principals`, comma-separated role ARNs — the one the seed scripts run under, typically)
    # write items; CloudTrail on the table; alerts by email on denied writes, writes from anyone else, and tampering with
    # the guardrails. Deployed when `app_registry_guard_admin_email` is set; without it the registry relies on IAM alone.
    guard_admin_email: str | None = hospital.app_registry_guard_admin_email or None
    if guard_admin_email:
        allowed_principals = list(hospital.app_registry_guard_allowed_principals)
        AppRegistryGuardStack(
            scope, "AppRegistryGuardStack",
            hospital_id=hospital_id,
            table=registry.table,
            writer_role=authoring.registry_write_fn.role,  # type: ignore[arg-type]
            admin_email=guard_admin_email,
            allowed_principal_arns=allowed_principals,
            env=env,
            description=f"MedApp · app registry guardrails (deny policy, CloudTrail, alerting) · {hospital_id}",
        )

    Tags.of(scope).add("auto-delete", "no")
    Tags.of(scope).add("medapp:hospital", hospital_id)

    # cdk-nag: the AWS Solutions rules over every stack of this hospital, at every synth. An error-level finding fails the
    # synth; what is accepted on purpose is listed with its reason in stacks/nag.py (the register), applied after all the
    # stacks exist so cross-stack additions (the frontend config written into the API stack) are covered; the report of
    # every rule applied lands in cdk.out (AwsSolutions-<hospital_id>-<hospital_id>-<Stack>-NagReport.csv — cdk-nag
    # prefixes the stage's id to the stack's name). Added here, on the stage, because aspects do not cross stage
    # boundaries: an aspect on the app would never visit a hospital's stacks.
    apply_accepted_findings(scope)
    cdk.Aspects.of(scope).add(cdk_nag.AwsSolutionsChecks(reports=True, verbose=True))


def build_app(app: cdk.App, hospitals: Iterable[HospitalConfig]) -> list[HospitalDeployment]:
    """One stage per hospital — what `cdk synth` builds, and what the whole-app tests build."""
    return [HospitalDeployment(app, hospital) for hospital in hospitals]


if __name__ == "__main__":
    app = cdk.App()
    try:
        # `-c hospitals=hsp-a,hsp-b` synthesises a subset; by default every file under infra/hospitals/ is a deployment
        # (`-c hospitals_dir=<path>` reads the files from elsewhere — the tests, or a checkout that keeps them outside the repo).
        hospitals = load_hospitals(Path(app.node.try_get_context("hospitals_dir") or HOSPITALS_DIR), select=app.node.try_get_context("hospitals"))
    except ConfigError as err:
        raise SystemExit(str(err)) from err
    build_app(app, hospitals)
    app.synth()
