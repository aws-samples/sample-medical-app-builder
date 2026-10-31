"""
HostingStack — the panel (med_app) on CloudFront.

  - a private S3 bucket with the Vite build, reachable only through CloudFront (origin access control)
  - a CloudFront distribution: HTTPS only, TLS 1.2+, security headers, SPA routing (403/404 → index.html),
    hashed assets cached for a year, index.html, config.json and version.json revalidated on every request
  - `config.json`: the runtime configuration the frontend reads before it starts (Cognito pool and client,
    API base URL, hospital name, modes). It is written at DEPLOY time from the other stacks' values, so the
    build itself carries no deployment-specific settings — one build, any hospital deployment
    (`FrontendRuntimeConfig`, instantiated by the ApiStack once the API URL exists). The hospital's branding
    travels the same way: its palette and logo in config.json (`VITE_BRANDING`), the logo files from
    infra/hospitals/<id>/ under `/branding/` — the panel applies them at boot (med_app/src/theme.ts).

The frontend is built at synth time (`npm run build` in med_app, MEDAPP_APP_DIR overrides the checkout)
into infra/.build/frontend/dist, cached by a hash of the sources so an unchanged frontend costs nothing.
The distribution's origin (https://<id>.cloudfront.net) is what the API's CORS must allow — app.py passes
it to the ApiStack, which is why the ApiStack depends on this one and not the other way round.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    Tags,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
)
from constructs import Construct

from .api_stack import INFRA_ROOT
from .hospitals import BRANDING_PREFIX

MED_APP = Path(os.environ["MEDAPP_APP_DIR"]).resolve() if os.environ.get("MEDAPP_APP_DIR") else INFRA_ROOT.parent / "med_app"
BUILD = INFRA_ROOT / ".build" / "frontend"

# What the build depends on; anything else in med_app (tests, docs prose, node_modules) does not change the bundle.
SOURCE_ROOTS = ("src", "public", "manifests", "showcase", "specs", "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "docs/application-catalog.yaml", "docs/app-spec.schema.json")

CONFIG_KEY = "config.json"


class StagingError(RuntimeError):
    pass


def _source_digest() -> str:
    h = hashlib.sha256()
    for rel in SOURCE_ROOTS:
        p = MED_APP / rel
        if p.is_file():
            h.update(rel.encode())
            h.update(p.read_bytes())
        elif p.is_dir():
            for f in sorted(x for x in p.rglob("*") if x.is_file()):
                h.update(str(f.relative_to(MED_APP)).encode())
                h.update(f.read_bytes())
    return h.hexdigest()


def _missing_dependencies() -> list[str]:
    """Runtime dependencies named in package.json that node_modules does not have — a stale install, after a pull that added one."""
    with open(MED_APP / "package.json", encoding="utf-8") as f:
        wanted = json.load(f).get("dependencies") or {}
    return sorted(name for name in wanted if not (MED_APP / "node_modules" / name / "package.json").exists())


def stage_frontend() -> str:
    """`vite build` med_app into .build/frontend/dist (cached by source hash); returns the dist path."""
    dist = BUILD / "dist"
    stamp = BUILD / ".stamp"
    if not (MED_APP / "node_modules").exists():
        raise StagingError(f"{MED_APP}/node_modules is missing — run `npm install` in med_app; the frontend is built from there at synth time")
    missing = _missing_dependencies()
    if missing:
        raise StagingError(f"med_app/node_modules is behind package.json ({', '.join(missing)} not installed) — run `npm install` in med_app, then deploy again")

    digest = _source_digest()
    if stamp.exists() and stamp.read_text() == digest and (dist / "index.html").exists():
        return str(dist)

    if dist.exists():
        shutil.rmtree(dist)
    BUILD.mkdir(parents=True, exist_ok=True)
    # `--mode hosting`: the deployment-specific values come from config.json at runtime, not from .env.
    proc = subprocess.run(["npx", "vite", "build", "--mode", "hosting", "--outDir", str(dist), "--emptyOutDir"], cwd=str(MED_APP), capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise StagingError(f"building the frontend failed:\n{proc.stdout}\n{proc.stderr}")
    stamp.write_text(digest)
    return str(dist)


class HostingStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, branding_dir: Path | None = None, **kwargs) -> None:
        """`branding_dir`: the hospital's logo files (infra/hospitals/<id>/), served under /branding/ — the panel loads
        them by the names config.json carries (stacks/hospitals.py). None: the files the build itself ships, if any."""
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "hosting")

        # The site is a build artefact: nothing in this bucket is a record, so it may go with the stack.
        self.bucket = s3.Bucket(
            self, "SiteBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        headers = cloudfront.ResponseHeadersPolicy(
            self, "SecurityHeaders",
            response_headers_policy_name=f"medapp-{hospital_id}-security-headers",
            security_headers_behavior=cloudfront.ResponseSecurityHeadersBehavior(
                strict_transport_security=cloudfront.ResponseHeadersStrictTransportSecurity(access_control_max_age=Duration.days(365), include_subdomains=True, override=True),
                content_type_options=cloudfront.ResponseHeadersContentTypeOptions(override=True),
                frame_options=cloudfront.ResponseHeadersFrameOptions(frame_option=cloudfront.HeadersFrameOption.DENY, override=True),
                referrer_policy=cloudfront.ResponseHeadersReferrerPolicy(referrer_policy=cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override=True),
            ),
        )

        self.distribution = cloudfront.Distribution(
            self, "Distribution",
            comment=f"MedApp panel · {hospital_id}",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(self.bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,  # honours the objects' own Cache-Control
                response_headers_policy=headers,
                compress=True,
            ),
            # A single-page app: every route is index.html; a missing object behind OAC surfaces as 403.
            error_responses=[
                cloudfront.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html", ttl=Duration.seconds(0)),
                cloudfront.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html", ttl=Duration.seconds(0)),
            ],
            # TLS policy: with the default *.cloudfront.net certificate CloudFront fixes it; a hospital domain
            # (ACM certificate + `domain_names`) is where TLS 1.2-only and the real hostname come in — a follow-up.
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,  # Europe and North America edges
            http_version=cloudfront.HttpVersion.HTTP2_AND_3,
        )

        dist = stage_frontend()

        # Hashed assets: immutable, cached for a year. Everything else (index.html, fonts, favicon, version.json —
        # the build id an open panel compares with its own to offer a reload): revalidated on every request so a
        # deploy shows up at once. config.json is written by FrontendRuntimeConfig and must survive the site sync —
        # hence excluded from pruning here.
        s3deploy.BucketDeployment(
            self, "SiteAssets",
            sources=[s3deploy.Source.asset(str(Path(dist) / "assets"))],
            destination_bucket=self.bucket,
            destination_key_prefix="assets",
            cache_control=[s3deploy.CacheControl.max_age(Duration.days(365)), s3deploy.CacheControl.immutable()],
            prune=True,
            memory_limit=512,
        )
        pages = s3deploy.BucketDeployment(
            self, "SitePages",
            sources=[s3deploy.Source.asset(dist, exclude=["assets", "assets/**"])],
            destination_bucket=self.bucket,
            # With a branding folder of its own the hospital's files replace whatever the build put under /branding/.
            exclude=["assets/*", CONFIG_KEY, *([f"{BRANDING_PREFIX}/*"] if branding_dir else [])],
            cache_control=[s3deploy.CacheControl.no_cache()],
            prune=True,
            distribution=self.distribution,
            distribution_paths=["/*"],
            memory_limit=512,
        )
        if branding_dir is not None:
            if not branding_dir.is_dir():
                raise StagingError(f"{hospital_id}: branding folder {branding_dir} does not exist")
            branding = s3deploy.BucketDeployment(
                self, "Branding",
                sources=[s3deploy.Source.asset(str(branding_dir))],
                destination_bucket=self.bucket,
                destination_key_prefix=BRANDING_PREFIX,
                cache_control=[s3deploy.CacheControl.no_cache()],  # a replaced logo shows at the next load
                prune=True,
                distribution=self.distribution,
                distribution_paths=[f"/{BRANDING_PREFIX}/*"],
                memory_limit=512,
            )
            branding.node.add_dependency(pages)

        self.origin = f"https://{self.distribution.distribution_domain_name}"

        CfnOutput(self, "SiteUrl", value=self.origin, description="The panel")
        CfnOutput(self, "DistributionId", value=self.distribution.distribution_id)
        CfnOutput(self, "SiteBucketName", value=self.bucket.bucket_name)


class FrontendRuntimeConfig(Construct):
    """
    Writes config.json into the site bucket at deploy time — the same VITE_* keys the frontend reads from
    .env in development, with the values of this deployment (tokens resolved by CloudFormation). Created by
    the ApiStack, which knows the API URL; `prune=False` so it never touches the site files.
    """

    def __init__(self, scope: Construct, construct_id: str, *, hosting: HostingStack, values: dict[str, str]) -> None:
        super().__init__(scope, construct_id)
        s3deploy.BucketDeployment(
            self, "ConfigJson",
            sources=[s3deploy.Source.json_data(CONFIG_KEY, values)],
            destination_bucket=hosting.bucket,
            prune=False,
            cache_control=[s3deploy.CacheControl.no_cache()],
            distribution=hosting.distribution,
            distribution_paths=[f"/{CONFIG_KEY}"],
        )


def runtime_config_values(*, hospital_id: str, hospital_name: str, region: str, user_pool_id: str, client_id: str, api_base_url: str, ohif_viewer_url: str | None, branding: Mapping[str, Any] | None = None) -> dict[str, str]:
    """The frontend's configuration for a deployed hospital; keys mirror med_app/src/config/env.ts. `branding` is the
    hospital's palette override and logo (HospitalConfig.frontend_branding), carried as one JSON string — config.json
    is strings only; an empty string means the panel's defaults."""
    return {
        "VITE_BRANDING": json.dumps(branding, separators=(",", ":"), sort_keys=True) if branding else "",
        "VITE_HOSPITAL_ID": hospital_id,
        "VITE_HOSPITAL_NAME": hospital_name,
        "VITE_AUTH_MODE": "cognito",
        "VITE_COGNITO_REGION": region,
        "VITE_COGNITO_USER_POOL_ID": user_pool_id,
        "VITE_COGNITO_CLIENT_ID": client_id,
        "VITE_DATA_MODE": "dispatcher",
        "VITE_REGISTRY_MODE": "remote",
        "VITE_API_BASE_URL": api_base_url,
        "VITE_OHIF_VIEWER_URL": ohif_viewer_url or "",
    }


__all__ = ["HostingStack", "FrontendRuntimeConfig", "runtime_config_values", "stage_frontend", "CONFIG_KEY"]
