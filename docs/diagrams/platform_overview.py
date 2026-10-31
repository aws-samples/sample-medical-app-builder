"""MedApp — platform overview: every component of one hospital deployment and the two flows through them."""

from svgdiagram import BLUE, GREEN, LINE, Box, Diagram, legend

d = Diagram(
    1980,
    900,
    "MedApp — platform overview",
    "One deployment per hospital (AWS CDK, EU region). Layer 1 is the validated platform, deployed once; Layer 2 is the apps: manifests — data, not code — produced by a compiler and run by a deterministic renderer.",
)

# ── Hospital staff ──────────────────────────────────────────────────────────────
d.group(30, 110, 240, 320, "Hospital staff", "grey")
d.box(Box("clin", 50, 146, 200, 70, "Clinicians", ["open published apps", "for a patient"], kind="person"))
d.box(Box("auth", 50, 228, 200, 70, "Authors", ["describe an app", "in plain language"], kind="person"))
d.box(Box("appr", 50, 310, 200, 70, "Approvers", ["review, sign off,", "publish"], kind="person"))

# ── Panel ───────────────────────────────────────────────────────────────────────
d.group(310, 110, 290, 420, "Panel", "green", sub="single-page app in the browser, served by CloudFront")
d.box(Box("registryui", 330, 150, 250, 62, "App registry", ["published apps · drafts · pending sign-off"]))
d.box(Box("drafting", 330, 232, 250, 62, "Drafting page", ["chat · typed draft · live preview"]))
d.box(Box("runtime", 330, 314, 250, 62, "App runtime", ["deterministic renderer · catalogs", "identity masking per role · OHIF viewer"]))
d.box(Box("config", 330, 420, 250, 62, "Runtime config", ["Cognito pool, API URL, hospital", "written at deploy time (config.json)"], dashed=True))

# ── AWS account ─────────────────────────────────────────────────────────────────
d.group(640, 110, 1020, 730, "AWS account of the hospital — Layer 1, deployed once with CDK", "warm")

d.group(660, 150, 240, 106, "HostingStack", "white", title_size=11)
d.box(Box("cf", 675, 182, 210, 60, "CloudFront + private S3", ["serves the panel over HTTPS", "security headers · runtime config"]))

d.group(920, 150, 720, 106, "IdentityStack", "white", title_size=11)
d.box(Box("cognito", 935, 182, 690, 60, "Cognito user pool", ["sign-in for every panel user · platform groups: authors, approvers, viewers, admins", "per-app role groups created at publish · federation to the hospital IdP (stretch)"]))

d.group(660, 280, 480, 190, "ApiStack", "white", title_size=11)
d.box(Box("apigw", 675, 310, 200, 70, "API Gateway (HTTP API)", ["JWT authorizer on the ID token", "CORS for the panel origin"]))
d.box(Box("regread", 905, 300, 215, 55, "Registry API", ["what each person may open"]))
d.box(Box("disp", 905, 385, 215, 70, "Dispatcher", ["re-validates manifest and role · applies the", "scope server-side · audit record per call"]))

d.group(1160, 280, 260, 190, "RegistryStack", "white", title_size=11)
d.box(Box("regtbl", 1175, 318, 230, 116, "App registry", ["DynamoDB", "immutable versions: manifest + spec, SHA-256", "append-only lifecycle events", "one published version per app"], kind="store", fill="#E8F1EE", stroke=GREEN))

d.box(Box("logs", 1440, 300, 200, 60, "CloudWatch Logs", ["structured audit records", "(→ Object Lock ledger, stretch)"]))

d.group(660, 500, 740, 260, "AuthoringStack", "white", title_size=11)
d.box(Box("draftsapi", 675, 548, 210, 60, "Drafts API", ["conversations and typed edits", "private to their author"]))
d.box(Box("kms", 925, 548, 210, 60, "KMS sign-off key", ["approval signs the manifest hash"]))
d.box(Box("regwrite", 1155, 548, 230, 60, "Registry write + lifecycle", ["draft → in review → approved → published", "four-eyes rule enforced here"]))
d.box(Box("agent", 675, 668, 210, 60, "Drafting agent", ["Strands Agents on Bedrock · fills the", "AppSpec through tools, never writes code"]))
d.box(Box("draftstbl", 925, 668, 230, 60, "Drafts table", ["DynamoDB · conversation + draft", "expires 30 days after the last change"], kind="store", fill="#E8F1EE", stroke=GREEN))
d.box(Box("manifest", 1175, 668, 210, 60, "Manifest service", ["compiler + validator — the same", "TypeScript the panel runs"]))

d.box(Box("bedrock", 1440, 668, 200, 60, "Amazon Bedrock", ["Claude · model id per deployment"]))

d.note(660, 792, "Compiler and renderer are one verified codebase: a manifest only ever contains catalog components and data primitives; anything else is refused before it reaches a clinician.", 9.8)
d.note(660, 810, "Every data call — read or write — goes through the dispatcher, which recomputes the role's scope from the stored manifest; the browser is never trusted.", 9.8)

# ── Hospital systems ─────────────────────────────────────────────────────────────
d.group(1700, 110, 250, 320, "Hospital systems", "blue", sub="provided by the hospital")
d.box(Box("fhir", 1715, 150, 220, 70, "FHIR server (R4)", ["system of record", "read and write through the dispatcher"]))
d.box(Box("dicom", 1715, 250, 220, 70, "DICOMweb gateway", ["QIDO-RS study lists via the dispatcher", "WADO-RS images to the OHIF viewer"]))

# ── Edges: people → panel ────────────────────────────────────────────────────────
d.connect("clin", "r", "registryui", "l", colour=BLUE)
d.connect("auth", "r", "drafting", "l", colour=GREEN)
d.connect("appr", "r", "runtime", "l", colour=GREEN)

# panel → API (one trunk for the whole panel)
d.edge([(600, 345), (675, 345)], colour=LINE, label="HTTPS · ID token")
d.edge([(600, 181), (612, 181), (612, 96), (1280, 96), (1280, 182)], colour=LINE, dashed=True, label="sign in (SRP; IdP later)", label_at=(950, 92))

# ── clinical run flow (blue) ─────────────────────────────────────────────────────
d.connect("apigw", "r", "regread", "l", colour=BLUE, at_a=330, via=890)
d.connect("apigw", "r", "disp", "l", colour=BLUE, at_a=362, via=890)
d.connect("regread", "r", "regtbl", "l", colour=BLUE, at_b=360, via=1150)
d.connect("disp", "r", "regtbl", "l", colour=BLUE, at_b=395, via=1150)
# dispatcher → hospital systems: one trunk down the gutter, two arrows
d.edge([(1060, 455), (1060, 490), (1680, 490), (1680, 185), (1715, 185)], colour=BLUE, label="reads and writes FHIR", label_at=(1600, 484))
d.edge([(1680, 285), (1715, 285)], colour=BLUE, label=None)
d.edge([(1680, 300), (1680, 285)], colour=BLUE, arrow=False)
# dispatcher → logs
d.edge([(1000, 455), (1000, 478), (1540, 478), (1540, 360)], colour=BLUE, label="audit", label_at=(1540, 420))

# ── authoring flow (green) ───────────────────────────────────────────────────────
d.edge([(735, 380), (735, 548)], colour=GREEN)
d.edge([(855, 380), (855, 520), (1200, 520), (1200, 548)], colour=GREEN)
d.connect("draftsapi", "b", "agent", "t", colour=GREEN, label="turn (async)", label_at=(720, 641))
d.connect("agent", "r", "draftstbl", "l", colour=GREEN)
d.edge([(885, 683), (905, 683), (905, 745), (1280, 745), (1280, 728)], colour=GREEN, label="readiness · compile", label_at=(1090, 741))
d.edge([(850, 668), (850, 640), (1540, 640), (1540, 668)], colour=GREEN, label="model", label_at=(1360, 636))
d.connect("regwrite", "l", "kms", "r", colour=GREEN, label="sign")
d.edge([(1360, 548), (1360, 434)], colour=GREEN)
d.edge([(1385, 592), (1430, 592), (1430, 242)], colour=GREEN, dashed=True, label="role groups at publish", label_at=(1430, 270))

legend(
    d,
    30,
    850,
    [
        (BLUE, "clinical use — open an app; every data call through the dispatcher", False),
        (GREEN, "authoring — chat → AppSpec → compiler → registry → sign-off → publish", False),
        (LINE, "serving, sign-in, provisioning", True),
    ],
)

open(__file__.replace("platform_overview.py", "platform-overview.svg"), "w", encoding="utf-8").write(d.render())
print("wrote platform-overview.svg")
