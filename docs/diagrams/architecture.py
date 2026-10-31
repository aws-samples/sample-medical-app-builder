"""As-built architecture of one hospital deployment (the README's architecture figure)."""

from svgdiagram import BLUE, GREEN, LINE, Box, Diagram, legend

d = Diagram(
    1900,
    1250,
    "One hospital deployment, as built",
    "Ten AWS CDK stacks in the hospital's own account (eu-central-1). The browser talks only to CloudFront, Cognito and API Gateway; every clinical data call goes through the dispatcher.",
)

# ── People and browser ────────────────────────────────────────────────────────
d.group(30, 100, 300, 340, "Hospital staff", "grey")
d.box(Box("people", 50, 140, 260, 70, "Clinicians · authors · approvers", ["sign in with the hospital's user pool"], kind="person"))
d.box(Box("panel", 50, 240, 260, 80, "The panel — React SPA", ["launcher · drafting · review · registry", "record shapes · users · audit trail"]))
d.box(Box("ohif", 50, 345, 260, 75, "Imaging viewer — OHIF", ["opened by the panel on a selected study"]))

# ── AWS account ──────────────────────────────────────────────────────────────
d.group(360, 100, 1200, 1030, "AWS account of the hospital — eu-central-1 (EU data residency enforced at synth)", "blue", title_size=13)

# Row 1
d.group(380, 145, 320, 135, "IdentityStack", "white", title_size=11, sub="one user pool per hospital · SRP web client · MFA switch")
d.box(Box("cognito", 395, 195, 290, 68, "Amazon Cognito user pool", ["platform groups: authors · approvers · admins · viewers", "per-app role groups created at publish"], desc_size=8.8))

d.group(720, 145, 400, 135, "HostingStack", "white", title_size=11, sub="HTTPS, security headers, SPA routing; config.json written at deploy")
d.box(Box("cf", 735, 195, 180, 68, "CloudFront", ["the panel"]))
d.box(Box("s3site", 930, 195, 175, 68, "S3 site bucket", ["Vite build · private (OAC)"], kind="store", fill="#F4F6F8"))

d.group(1140, 145, 400, 135, "ViewerStack", "white", title_size=11, sub="OHIF release pinned by hash; reaches DICOMweb only through a viewer door")
d.box(Box("cfv", 1155, 195, 180, 68, "CloudFront", ["the viewer"]))
d.box(Box("s3v", 1350, 195, 175, 68, "S3 viewer bucket", ["@ohif/app · app-config.js"], kind="store", fill="#F4F6F8"))

# Row 2
d.group(380, 320, 500, 300, "ApiStack", "white", title_size=11, sub="HTTP API Gateway · JWT authorizer on the user pool · CORS to the panel · shared Python layer · media bucket")
d.box(Box("apigw", 395, 375, 150, 225, "API Gateway", ["HTTP API", "JWT authorizer", "issuer + audience", "every route"]))
d.box(Box("regapi", 565, 375, 300, 48, "Registry API — Lambda", ["apps, versions, collections, shapes a person may open"], desc_size=8.8))
d.box(Box("dispatcher", 565, 433, 300, 62, "Primitive dispatcher — Lambda", ["POST /primitives/{kind} · GET /patients", "version → role → primitive → scope → execute → audit"], desc_size=8.8))
d.box(Box("useradmin", 565, 505, 300, 40, "User administration — Lambda", ["accounts, groups, invitations (admins)"], title_size=11.5, desc_size=8.8))
d.box(Box("auditapi", 565, 555, 300, 45, "Audit read API — Lambda", ["the trail by day, person, app, patient"], title_size=11.5, desc_size=8.8))

d.group(900, 320, 310, 300, "RegistryStack", "white", title_size=11, sub="KMS key · PITR · deletion protection · streams")
d.box(Box("registry", 915, 380, 280, 110, "App registry — DynamoDB", ["HEAD + VERSION items (manifest + spec)", "lifecycle events · collections · record shapes", "SHA-256 manifest hash per version"], kind="store", fill="#F4F6F8", desc_size=8.8))
d.box(Box("guard", 915, 510, 255, 95, "AppRegistryGuardStack (optional)", ["table policy denies writes to all but the writer", "CloudTrail data events · EventBridge → SNS alerts"], dashed=True, title_size=11, desc_size=8.8))

d.group(1230, 320, 310, 300, "AuditStack", "white", title_size=11, sub="KMS key · PITR · RETAIN · writers may only PutItem")
d.box(Box("audit", 1245, 380, 280, 110, "Audit trail — DynamoDB", ["one record per data call, write, account", "change and lifecycle step — refusals included", "indexes by person, app and patient"], kind="store", fill="#F4F6F8", desc_size=8.8))
d.box(Box("auditnote", 1245, 510, 280, 95, "Written by every Lambda that acts", ["dispatcher · registry write · user admin", "viewer door — fail-open, never blocking care"], dashed=True, title_size=11, desc_size=8.8))

# Row 3
d.group(380, 660, 1160, 230, "AuthoringStack — everything that turns a conversation into a registered app", "warm", title_size=11)
d.box(Box("draftsapi", 395, 705, 215, 70, "Drafts API — Lambda", ["sessions · async turns · PATCH edits"], desc_size=8.8))
d.box(Box("agent", 630, 705, 240, 70, "Drafting agent — Lambda", ["Strands Agent · 15 typed tools", "asynchronous turn worker"], desc_size=8.8))
d.box(Box("manifest", 890, 705, 240, 70, "Manifest service — Node.js Lambda", ["the panel's TypeScript compiler:", "readiness · compile · validate"], desc_size=8.8))
d.box(Box("regwrite", 1150, 705, 215, 70, "Registry write — Lambda", ["create · iterate · lifecycle · shapes", "four-eyes rule · KMS sign-off"], desc_size=8.8))
d.box(Box("bedrock", 1385, 705, 140, 70, "Amazon Bedrock", ["Claude · eu.* profile"], fill="#EEF6F3", stroke=GREEN, desc_size=8.8))
d.box(Box("drafts", 395, 795, 215, 75, "Drafts table — DynamoDB", ["sessions · spec · conversation", "KMS key · TTL 30 days"], kind="store", fill="#F4F6F8", desc_size=8.8))
d.box(Box("vocab", 630, 795, 240, 75, "Record vocabulary — S3", ["the codes actually on the record,", "written by the data source's seed"], kind="store", fill="#F4F6F8", desc_size=8.8))
d.box(Box("kmssign", 890, 795, 240, 75, "Sign-off key — KMS (ECC P-256)", ["signs the manifest hash at approval", "retained for the record's lifetime"], desc_size=8.8))
d.box(Box("layers", 1150, 795, 375, 75, "Built at synth, no Docker", ["Python dependency layer (arm64) · TypeScript bundle (esbuild)", "frontend build · OHIF release · DICOM seed"], dashed=True, title_size=11, desc_size=8.8))

# Row 4
d.group(380, 920, 570, 190, "ReferenceServersStack — stand-ins for the hospital's systems, synthetic record only", "grey", title_size=11, sub="deployed while reference_servers is true; no NAT, small tasks, one small database")
d.box(Box("refapi", 395, 980, 165, 110, "HTTP API (IAM, SigV4)", ["/fhir · /dicom-web", "VPC link → internal ALB", "+ browser door for OHIF"], desc_size=8.8))
d.box(Box("hapi", 575, 980, 175, 110, "HAPI FHIR R4 — Fargate", ["Postgres 16 on RDS", "seeded with 189 resources", "verified at deploy"], desc_size=8.8))
d.box(Box("orthanc", 765, 980, 170, 110, "Orthanc PACS — Fargate", ["DICOMweb QIDO/WADO", "studies generated at synth", "from the same patients"], desc_size=8.8))

d.group(970, 920, 570, 190, "HospitalServersStack — a hospital's own FHIR server and DICOMweb gateway (optional)", "grey", title_size=11, sub="deployed while hospital_servers is set; the dispatcher is pointed at it by configuration")
d.box(Box("secret", 985, 980, 170, 110, "Secrets Manager", ["OAuth2 client credentials", "written by a script, read by", "dispatcher, door and seed only"], desc_size=8.8))
d.box(Box("door", 1170, 980, 175, 110, "Viewer door — API + Lambda", ["admits the panel's Cognito token,", "forwards to DICOMweb with the", "hospital's token; spills big frames"], desc_size=8.8))
d.box(Box("seedhosp", 1360, 980, 165, 110, "Definitions seed — Lambda", ["an app's forms at publish —", "never patients; record", "vocabulary nightly"], desc_size=8.8))

# ── Hospital side ────────────────────────────────────────────────────────────
d.group(1590, 100, 280, 1030, "Hospital data centre (optional)", "grey")
d.box(Box("idp", 1605, 160, 250, 80, "Hospital IdP (Entra ID / Keycloak)", ["production SSO, federated into the", "user pool — configuration, not code"], dashed=True, title_size=11.5, desc_size=8.8))
d.box(Box("fhir", 1605, 620, 250, 90, "FHIR server (R4)", ["system of record · read + write", "e.g. HAPI behind an API gateway"], desc_size=8.8))
d.box(Box("dicom", 1605, 740, 250, 80, "DICOMweb gateway", ["QIDO-RS study lists · WADO-RS frames"], desc_size=8.8))

# ── Edges ────────────────────────────────────────────────────────────────────
# sign-in
d.edge([(310, 175), (345, 175), (345, 229), (395, 229)], colour=LINE, dashed=True, label="sign in · tokens", label_at=(345, 212))
# panel and viewer over HTTPS
d.edge([(310, 280), (350, 280), (350, 300), (825, 300), (825, 263)], colour=BLUE, label="HTTPS · panel", label_at=(590, 294))
d.edge([(310, 382), (340, 382), (340, 310), (1245, 310), (1245, 263)], colour=BLUE, label="viewer", label_at=(1100, 304))
# API calls
d.edge([(250, 320), (250, 332), (355, 332), (355, 487), (395, 487)], colour=BLUE, label="API calls · ID token (JWT)", label_at=(355, 420))
for y in (399, 464, 525, 577):
    d.edge([(545, y), (565, y)], colour=BLUE)
# registry read
d.edge([(880, 430), (915, 430)], colour=BLUE, label="manifests", label_at=(897, 448))
# dispatcher → hospital FHIR
d.edge([(715, 495), (715, 640), (1575, 640), (1575, 665), (1605, 665)], colour=BLUE, label="FHIR R4 — reads and writes (OAuth2 client credentials · SigV4)", label_at=(900, 634))
# door → DICOMweb
d.edge([(1345, 1035), (1575, 1035), (1575, 780), (1605, 780)], colour=BLUE, label="DICOMweb", label_at=(1575, 900))
# audit
d.edge([(1210, 470), (1245, 470)], colour=LINE, label="audit", label_at=(1228, 494))
# authoring
d.edge([(470, 600), (470, 705)], colour=GREEN, label="/drafts · /manifest · /registry writes", label_at=(620, 650))
d.edge([(610, 740), (630, 740)], colour=GREEN)
d.edge([(870, 740), (890, 740)], colour=GREEN)
d.edge([(1130, 740), (1150, 740)], colour=GREEN)
d.edge([(1365, 740), (1385, 740)], colour=GREEN)
d.edge([(500, 775), (500, 795)], colour=GREEN)
d.edge([(750, 775), (750, 795)], colour=GREEN, label="codes on the record", label_at=(810, 790))
d.edge([(1010, 775), (1010, 795)], colour=GREEN, label="sign(hash)", label_at=(1050, 790))
d.edge([(1257, 705), (1257, 648), (1185, 648), (1185, 490)], colour=GREEN, label="versions", label_at=(1192, 560))
d.edge([(1300, 705), (1300, 655), (1220, 655), (1220, 292), (540, 292), (540, 263)], colour=GREEN, dashed=True, label="role groups at publish", label_at=(900, 286))
# federation
d.edge([(1605, 200), (1575, 200), (1575, 128), (540, 128), (540, 195)], colour=LINE, dashed=True, label="federation (production)", label_at=(1300, 124))

legend(d, 380, 1160, [(BLUE, "clinical use: open an app, data through the dispatcher", False), (GREEN, "authoring: drafts, agent, compiler, registry, sign-off", False), (LINE, "sign-in, audit, platform plumbing", False), (LINE, "optional / production configuration", True)])

open(__file__.replace(".py", ".svg"), "w", encoding="utf-8").write(d.render())
print("wrote", __file__.replace(".py", ".svg"))
