"""
ViewerStack — the OHIF Viewer on CloudFront, opened by the panel on a study the clinician selected.

The panel's `DicomViewer` component embeds `https://<viewer>/viewer?StudyInstanceUIDs=<uid>#token=<Cognito ID
token>`. OHIF then talks DICOMweb (QIDO-RS for the study's series, WADO-RS for metadata and frames) to the
reference API's browser door, `/viewer/dicom-web/…`, which admits the panel's Cognito token (JWT authorizer)
and forwards to the PACS. The token travels in the URL fragment — never sent to a server, never in an access
log — and app-config.js (written at deploy, ViewerRuntimeConfig) turns it into the `Authorization` header OHIF
attaches to every request. Identity, not authorisation: any signed-in user may open any study through that door
in this slice; a study-scoped grant minted by the dispatcher is the follow-up (docs/reference-servers.md).

OHIF itself is the published build of `@ohif/app` from npm (pinned version and sha512), staged at synth into
.build/ohif — no build of the OHIF monorepo, no fork, and the viewer is a separate system from the PACS as it
is in a hospital. Excluded from the upload: source maps, the ONNX runtime for AI segmentation (136 MB, unused
here), whole-slide microscopy, and Netlify artefacts. app-config.js is ours; the default one is dropped.

Distribution: private S3 origin (OAC), HTTPS, SPA routing (403/404 → index.html), security headers with a
`frame-ancestors` CSP naming the panel (and localhost for development) instead of X-Frame-Options, so the panel
may embed the viewer and nobody else may.
"""

from __future__ import annotations

import base64
import hashlib
import shutil
import ssl
import tarfile
import urllib.request
from pathlib import Path

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
from .hosting_stack import StagingError

# Pinned: the published build of the OHIF Viewer. Bump both together (the integrity is the registry's sha512).
OHIF_VERSION = "3.12.12"
OHIF_INTEGRITY = "sha512-h6/TgDrnPpReKO7sa0PXtDlx3B43V/FmKdenmNfyGBKcG8CcvG4AH+6pfjphj4UhLSen1p0dNEevOeJj9Vhxgw=="
OHIF_TARBALL = f"https://registry.npmjs.org/@ohif/app/-/app-{OHIF_VERSION}.tgz"
BUILD = INFRA_ROOT / ".build" / "ohif"

# Not uploaded: the ONNX runtime (AI segmentation, 136 MB), whole-slide microscopy, source maps, Netlify files,
# and OHIF's own app-config.js / google.js (ours is written at deploy).
EXCLUDED_DIRS = ("ort/", "dicom-microscopy-viewer/")
EXCLUDED_FILES = frozenset({"app-config.js", "google.js", "_headers", "_redirects", "serve.json"})
APP_CONFIG_KEY = "app-config.js"


def _ssl_context() -> ssl.SSLContext:
    """The platform's trust store, or the AWS SDK's bundle when the Python at hand reads none (python.org builds on macOS)."""
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0) == 0:
        for module, attr in (("certifi", "where"), ("botocore.httpsession", "where")):
            try:
                bundle = getattr(__import__(module, fromlist=[attr]), attr)()
                context.load_verify_locations(cafile=bundle)
                break
            except (ImportError, OSError):
                continue
    return context


def _download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=120, context=_ssl_context()) as res, open(tmp, "wb") as out:  # noqa: S310 — a pinned registry URL
        shutil.copyfileobj(res, out)
    tmp.replace(target)


def _integrity(path: Path) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii")


def _keep(member: str) -> bool:
    if not member.startswith("package/dist/"):
        return False
    rel = member[len("package/dist/") :]
    if not rel or rel.endswith("/") or rel.endswith(".map"):
        return False
    if rel.startswith(EXCLUDED_DIRS) or rel in EXCLUDED_FILES:
        return False
    return True


def stage_ohif() -> str:
    """The OHIF build for the viewer bucket: downloaded once per pinned version, integrity-checked, filtered."""
    dist = BUILD / OHIF_VERSION / "dist"
    if (dist / "index.html").exists():
        return str(dist)
    tarball = BUILD / f"app-{OHIF_VERSION}.tgz"
    if not tarball.exists():
        try:
            _download(OHIF_TARBALL, tarball)
        except OSError as err:
            raise StagingError(f"downloading {OHIF_TARBALL} failed: {err}") from err
    actual = _integrity(tarball)
    if actual != OHIF_INTEGRITY:
        tarball.unlink(missing_ok=True)
        raise StagingError(f"@ohif/app {OHIF_VERSION}: integrity mismatch ({actual}); the download was discarded")
    staging = dist.parent / "dist.staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with tarfile.open(tarball, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile() or not _keep(member.name):
                continue
            rel = member.name[len("package/dist/") :]
            target = staging / rel
            if not target.resolve().is_relative_to(staging.resolve()):
                raise StagingError(f"refusing to extract {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                continue
            with source, open(target, "wb") as out:
                shutil.copyfileobj(source, out)
    if dist.exists():
        shutil.rmtree(dist)
    staging.rename(dist)
    return str(dist)


# The name of the data source that serves the synthetic record — a contract with the panel (med_app/src/config/env.ts
# SYNTHETIC_VIEWER_SOURCE): a preview, or a panel running on mock data, opens studies as /viewer/reference?StudyInstanceUIDs=…
SYNTHETIC_SOURCE_NAME = "reference"


def _data_source(name: str, root: str, friendly_name: str, bulk: str) -> str:
    return f"""    {{
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: '{name}',
      configuration: {{
        friendlyName: '{friendly_name}',
        name: '{name}',
        wadoUriRoot: '{root}',
        qidoRoot: '{root}',
        wadoRoot: '{root}',
        qidoSupportsIncludeField: true,
        supportsReject: false,
        dicomUploadEnabled: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        omitQuotationForMultipartRequest: true,
        bulkDataURI: {bulk},
        // Every request to the PACS door carries the token the panel handed over.
        requestOptions: {{ auth: function () {{ return window.medappAuthorization(); }} }},
      }},
    }},"""


def _bulk(root: str, upstream_root: str | None) -> str:
    if upstream_root and upstream_root.rstrip("/") != root:
        return f"{{ enabled: true, relativeResolution: 'studies', startsWith: '{upstream_root.rstrip('/')}', prefixWith: '{root}' }}"
    return "{ enabled: true, relativeResolution: 'studies' }"


def ohif_app_config(
    dicomweb_root: str,
    friendly_name: str = "MedApp reference PACS (synthetic record)",
    upstream_root: str | None = None,
    synthetic_root: str | None = None,
    synthetic_friendly_name: str = "Reference PACS (synthetic record — previews)",
) -> str:
    """
    OHIF's app-config.js for this deployment: the default DICOMweb data source (the browser door — of the reference
    API, or of the hospital stack in front of the hospital's gateway), the token bridge — the Cognito ID token the
    panel put in the URL fragment becomes the Authorization header — and, with `synthetic_root`, a second data source
    named `reference` for the synthetic record. OHIF registers one route per data source (`/viewer/<name>`), so the
    panel opens a preview's study as `/viewer/reference?StudyInstanceUIDs=…` and a clinician's as `/viewer?…`: the
    hospital's PACS never sees a synthetic UID, and a preview never touches a patient's study. `upstream_root` is the
    PACS's own base URL when the door proxies another server: the PACS writes absolute BulkDataURIs on itself into
    its metadata, and OHIF would fetch them directly (no token, no CORS); with it set, OHIF re-prefixes them onto the door.
    """
    root = dicomweb_root.rstrip("/")
    bulk = _bulk(root, upstream_root)
    roots = [root]
    sources = [_data_source("medapp", root, friendly_name, bulk)]
    if synthetic_root:
        synthetic = synthetic_root.rstrip("/")
        if synthetic not in roots:
            roots.append(synthetic)
        sources.append(_data_source(SYNTHETIC_SOURCE_NAME, synthetic, synthetic_friendly_name, _bulk(synthetic, None)))
    roots_js = ", ".join(f"'{r}'" for r in roots)
    data_sources = "\n".join(sources)
    return f"""/* MedApp — OHIF Viewer configuration, written at deploy (infra/stacks/viewer_stack.py). */
(function () {{
  // The published OHIF build folds Node checks in the ONNX runtime glue (AI segmentation, unused here) to true, and
  // that chunk touches `__filename` when it loads: in a browser a ReferenceError that stops the viewer. Defined, harmless.
  if (typeof globalThis.__filename === 'undefined') {{ globalThis.__filename = ''; globalThis.__dirname = ''; }}

  // The panel opens the viewer as /viewer?StudyInstanceUIDs=<uid>#token=<Cognito ID token>. The fragment never
  // leaves the browser (not sent to any server, not in access logs); keep it for this tab and clear it from the URL.
  var match = /(?:^#|[#&])token=([^&]+)/.exec(window.location.hash || '');
  var token = match ? decodeURIComponent(match[1]) : window.sessionStorage.getItem('medapp.viewer.token');
  if (match) {{
    window.sessionStorage.setItem('medapp.viewer.token', token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }}
  var roots = [{roots_js}];
  var authorization = function () {{ return token ? 'Bearer ' + token : ''; }};
  window.medappAuthorization = authorization;
  var isPacs = function (url) {{
    if (typeof url !== 'string') {{ return false; }}
    for (var i = 0; i < roots.length; i++) {{ if (url.indexOf(roots[i]) === 0) {{ return true; }} }}
    return false;
  }};

  // OHIF 3.12 takes the Authorization header from its userAuthenticationService (the OIDC flow), not from the data
  // source's requestOptions. This deployment has no OIDC flow — the panel already authenticated the user — so the
  // header is attached here, at the transport, for every request to the PACS door: XMLHttpRequest (dicomweb-client,
  // the image loader) and fetch (bulk data, streaming). Nothing else is touched; other origins see no header.
  var open = XMLHttpRequest.prototype.open;
  var setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {{
    this.__medappPacs = isPacs(url);
    this.__medappAuthorized = false;
    return open.apply(this, arguments);
  }};
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {{
    if (String(name).toLowerCase() === 'authorization') {{ this.__medappAuthorized = true; }}
    return setRequestHeader.apply(this, arguments);
  }};
  XMLHttpRequest.prototype.send = function () {{
    if (this.__medappPacs && !this.__medappAuthorized && authorization()) {{
      setRequestHeader.call(this, 'Authorization', authorization());
      this.__medappAuthorized = true;
    }}
    return send.apply(this, arguments);
  }};
  var fetch0 = window.fetch;
  window.fetch = function (input, init) {{
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (isPacs(url) && authorization()) {{
      init = Object.assign({{}}, init || {{}});
      var headers = new Headers(init.headers || (input && input.headers) || undefined);
      if (!headers.has('Authorization')) {{ headers.set('Authorization', authorization()); }}
      init.headers = headers;
    }}
    return fetch0.call(this, input, init);
  }};

  // And OHIF's own service, once the app has created it, so requests it builds carry the header itself.
  var registered = false;
  var register = function () {{
    var service = window.services && window.services.userAuthenticationService;
    if (service && !registered && typeof service.setServiceImplementation === 'function') {{
      service.setServiceImplementation({{ getAuthorizationHeader: function () {{ return authorization() ? {{ Authorization: authorization() }} : {{}}; }} }});
      registered = true;
    }}
    if (!registered) {{ window.setTimeout(register, 50); }}
  }};
  register();

  // Crosshairs in MPR: OHIF recomputes the crosshair centre on every camera reset as the intersection of the three
  // viewport planes. When a user gives a viewport an orientation another viewport already has (the orientation menu:
  // axial → sagittal next to the sagittal view), two planes are parallel, the intersection is NaN, and the tool moves
  // every camera of the group to NaN — three black viewports. Ignore a centre that is not a point; the cameras stay
  // where they are and the viewport shows the orientation that was asked for.
  var guarded = false;
  var guardCrosshairs = function () {{
    var tools = window.cornerstoneTools;
    var Crosshairs = tools && tools.CrosshairsTool;
    if (Crosshairs && Crosshairs.prototype && typeof Crosshairs.prototype.setToolCenter === 'function' && !guarded) {{
      var setToolCenter = Crosshairs.prototype.setToolCenter;
      Crosshairs.prototype.setToolCenter = function (center, suppressEvents) {{
        var finite = center && center.length >= 3 && isFinite(center[0]) && isFinite(center[1]) && isFinite(center[2]);
        if (!finite) {{ return; }}
        return setToolCenter.call(this, center, suppressEvents);
      }};
      guarded = true;
    }}
    if (!guarded) {{ window.setTimeout(guardCrosshairs, 50); }}
  }};
  guardCrosshairs();
}})();

/** @type {{AppTypes.Config}} */
window.config = {{
  routerBasename: '/',
  showStudyList: false,
  extensions: [],
  modes: [],
  // No onboarding tour and no investigational-use dialog inside the panel's frame.
  customizationService: {{ 'ohif.tours': {{ $set: [] }} }},
  investigationalUseDialog: {{ option: 'never' }},
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  maxNumberOfWebWorkers: 3,
  defaultDataSourceName: 'medapp',
  dataSources: [
{data_sources}
  ],
}};
"""


class ViewerStack(Stack):
    """OHIF on CloudFront. `origin` is what the reference API's CORS and the panel's config need; `url` is where the panel points its iframe."""

    def __init__(self, scope: Construct, construct_id: str, *, hospital_id: str, frame_ancestors: list[str], ohif_dist: str | None = None, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        Tags.of(self).add("medapp:hospital", hospital_id)
        Tags.of(self).add("medapp:layer", "1")
        Tags.of(self).add("medapp:component", "viewer")

        self.bucket = s3.Bucket(
            self, "ViewerBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # Frameable by the panel and by nobody else: a frame-ancestors CSP instead of X-Frame-Options.
        ancestors = " ".join(["'self'", *frame_ancestors])
        headers = cloudfront.ResponseHeadersPolicy(
            self, "ViewerHeaders",
            response_headers_policy_name=f"medapp-{hospital_id}-viewer-headers",
            security_headers_behavior=cloudfront.ResponseSecurityHeadersBehavior(
                strict_transport_security=cloudfront.ResponseHeadersStrictTransportSecurity(access_control_max_age=Duration.days(365), include_subdomains=True, override=True),
                content_type_options=cloudfront.ResponseHeadersContentTypeOptions(override=True),
                referrer_policy=cloudfront.ResponseHeadersReferrerPolicy(referrer_policy=cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override=True),
                content_security_policy=cloudfront.ResponseHeadersContentSecurityPolicy(content_security_policy=f"frame-ancestors {ancestors}", override=True),
            ),
        )

        self.distribution = cloudfront.Distribution(
            self, "Distribution",
            comment=f"MedApp imaging viewer (OHIF) · {hospital_id}",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(self.bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                response_headers_policy=headers,
                compress=True,
            ),
            error_responses=[
                cloudfront.ErrorResponse(http_status=403, response_http_status=200, response_page_path="/index.html", ttl=Duration.seconds(0)),
                cloudfront.ErrorResponse(http_status=404, response_http_status=200, response_page_path="/index.html", ttl=Duration.seconds(0)),
            ],
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
            http_version=cloudfront.HttpVersion.HTTP2_AND_3,
        )

        dist = ohif_dist or stage_ohif()
        # Content-named bundles and binaries: cached for a year. index.html and the rest: revalidated on every request.
        s3deploy.BucketDeployment(
            self, "ViewerBundles",
            sources=[s3deploy.Source.asset(dist, exclude=["*", "!*.bundle.*.js", "!*.wasm", "!*.woff2"])],
            destination_bucket=self.bucket,
            exclude=["*"],
            include=["*.bundle.*.js", "*.wasm", "*.woff2"],
            cache_control=[s3deploy.CacheControl.max_age(Duration.days(365)), s3deploy.CacheControl.immutable()],
            prune=False,
            memory_limit=512,
        )
        s3deploy.BucketDeployment(
            self, "ViewerPages",
            sources=[s3deploy.Source.asset(dist, exclude=["*.bundle.*.js", "*.wasm", "*.woff2"])],
            destination_bucket=self.bucket,
            exclude=[APP_CONFIG_KEY],  # written at deploy by ViewerRuntimeConfig; must survive the sync
            cache_control=[s3deploy.CacheControl.no_cache()],
            prune=False,
            distribution=self.distribution,
            distribution_paths=["/index.html", "/"],
            memory_limit=512,
        )

        self.origin = f"https://{self.distribution.distribution_domain_name}"
        self.url = self.origin

        CfnOutput(self, "ViewerUrl", value=self.url, description="OHIF Viewer (VITE_OHIF_VIEWER_URL)")
        CfnOutput(self, "ViewerBucketName", value=self.bucket.bucket_name)


class ViewerRuntimeConfig(Construct):
    """
    Writes OHIF's app-config.js into the viewer bucket at deploy time with this deployment's DICOMweb door.
    Created by whichever stack is the viewer's data source (the ReferenceServersStack or the HospitalServersStack),
    which knows the door's URL — the same pattern as the panel's config.json.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        viewer: ViewerStack,
        dicomweb_root: str,
        friendly_name: str | None = None,
        upstream_root: str | None = None,
        synthetic_root: str | None = None,
    ) -> None:
        super().__init__(scope, construct_id)
        config = ohif_app_config(dicomweb_root, **({"friendly_name": friendly_name} if friendly_name else {}), upstream_root=upstream_root, synthetic_root=synthetic_root)
        s3deploy.BucketDeployment(
            self, "AppConfig",
            sources=[s3deploy.Source.data(APP_CONFIG_KEY, config)],
            destination_bucket=viewer.bucket,
            prune=False,
            cache_control=[s3deploy.CacheControl.no_cache()],
            distribution=viewer.distribution,
            distribution_paths=[f"/{APP_CONFIG_KEY}"],
        )


__all__ = ["ViewerStack", "ViewerRuntimeConfig", "ohif_app_config", "stage_ohif", "OHIF_VERSION", "APP_CONFIG_KEY", "SYNTHETIC_SOURCE_NAME"]
