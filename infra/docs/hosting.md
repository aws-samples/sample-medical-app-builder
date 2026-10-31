# Hosting the panel — S3 + CloudFront

`stacks/hosting_stack.py` puts the frontend (`med_app`, a Vite single-page app) behind CloudFront.

## What is deployed

- **A private S3 bucket** with the build output. Block-public-access on, SSL enforced, S3-managed encryption.
  CloudFront reaches it through an origin access control; nothing else can. The bucket is a build artefact,
  so it is destroyed with the stack (`auto_delete_objects`).
- **A CloudFront distribution**: HTTPS only (HTTP redirects), HTTP/2 and 3, compression, `PRICE_CLASS_100`
  (European and North American edges), a response-headers policy with HSTS, `X-Content-Type-Options`,
  `X-Frame-Options: DENY` and a strict referrer policy. Two custom error responses turn a missing object
  (403 behind OAC, or 404) into `/index.html` with status 200 — that is how client-side routes such as
  `/drafts/abc` or `/apps/app_bp_trend` survive a reload or a shared link.
- **Two site deployments**: `assets/` (Vite's hashed bundles) with `Cache-Control: max-age=31536000, immutable`;
  everything else (`index.html`, fonts, favicon) with `no-cache`, so a deploy shows up on the next request.
  The second deployment invalidates `/*` in CloudFront.
- **`config.json`** — see below. Written by a small construct the ApiStack owns (`FrontendRuntimeConfig`),
  with `prune=False` so it never touches the site files, and excluded from the site deployment's pruning.

Outputs: `SiteUrl` (the panel), `DistributionId`, `SiteBucketName`.

## One build, any deployment: `config.json`

The frontend used to read its configuration from `.env` at build time (`VITE_*`). A deployed panel now
also fetches `/config.json` before it starts (`src/main.tsx` → `fetchRuntimeOverrides` →
`initRuntimeConfig`, then the app module is imported). The file carries the same `VITE_*` keys with the
deployment's values — Cognito region, pool and client ids, the API base URL, the hospital id and name,
`VITE_AUTH_MODE=cognito`, `VITE_DATA_MODE=dispatcher`, `VITE_REGISTRY_MODE=remote` — filled from the other
stacks' tokens and resolved by CloudFormation at deploy. The build therefore contains nothing
deployment-specific and the same artefact would serve another hospital. In development there is no
`config.json` (the dev server answers with `index.html`, which the loader ignores by content type), so
`.env` applies as before.

## Build at synth

`stage_frontend()` runs `npx vite build --mode hosting` in `../med_app` (or `MEDAPP_APP_DIR`) into
`infra/.build/frontend/dist`, cached by a hash of the sources (`src`, `public`, `manifests`, `specs`,
`index.html`, the package files, the catalog YAML and the spec schema). An unchanged frontend makes synth
no slower; a change costs the build (~10 s). It needs `med_app/node_modules`, and one that matches `package.json`: when a pull adds a dependency, the staging step says which package is missing and asks for `npm install` in med_app before it builds.

## Order and CORS

`app.py` creates the HostingStack before the ApiStack and appends the distribution's origin
(`https://<id>.cloudfront.net`) to the API's CORS allow-list, alongside the `frontend_origins` context
(the dev server by default). The ApiStack therefore depends on the HostingStack; the runtime config —
which needs the API URL — is created inside the ApiStack and written into the hosting bucket. No cycle.

## Not yet

- A hospital domain: `domain_names` + an ACM certificate (us-east-1) on the distribution, which is also
  what unlocks a TLS 1.2-only policy — with the default `*.cloudfront.net` certificate CloudFront fixes
  the TLS policy.
- A Content-Security-Policy header. The app uses Mantine's inline styles and embeds OHIF in an iframe
  from a configurable URL, so a CSP needs to be written against a concrete OHIF deployment.
- CloudFront access logs / WAF. Straightforward to add once the hospital says where logs must live.
