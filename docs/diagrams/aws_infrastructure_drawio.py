"""
MedApp — AWS infrastructure diagram as a draw.io (diagrams.net) file, with the official AWS architecture
icons (the "AWS 2019+" shape library, mxgraph.aws4). Open the .drawio in app.diagrams.net, the desktop
app or the VS Code extension; every element is a real shape, so it can be edited, re-styled or exported.

Layout is explicit (absolute coordinates) but derived from a spacing system — stack padding, icon pitch, row corridors
for the connectors — so that nothing touches its container; containers hold their children so groups move as one.
"""

from __future__ import annotations

from xml.sax.saxutils import escape, quoteattr

# ── AWS icon styles ─────────────────────────────────────────────────────────────

POINTS = "points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];"
ICON_BASE = "sketch=0;" + POINTS + "outlineConnect=0;fontColor=#232F3E;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;"

# AWS category colours
COMPUTE = "#ED7100"
NETWORK = "#8C4FFF"
STORAGE = "#7AA116"
DATABASE = "#C925D1"
SECURITY = "#DD344C"
ML = "#01A88D"
MANAGEMENT = "#E7157B"
ANALYTICS = "#8C4FFF"
DEVTOOLS = "#C925D1"
GENERAL = "#232F3E"

ICONS = {
    "cloudfront": ("mxgraph.aws4.cloudfront", NETWORK),
    "api_gateway": ("mxgraph.aws4.api_gateway", NETWORK),
    "s3": ("mxgraph.aws4.s3", STORAGE),
    "lambda": ("mxgraph.aws4.lambda", COMPUTE),
    "cognito": ("mxgraph.aws4.cognito", SECURITY),
    "kms": ("mxgraph.aws4.key_management_service", SECURITY),
    "dynamodb": ("mxgraph.aws4.dynamodb", DATABASE),
    "bedrock": ("mxgraph.aws4.bedrock", ML),
    "cloudwatch": ("mxgraph.aws4.cloudwatch", MANAGEMENT),
    "ssm": ("mxgraph.aws4.systems_manager", MANAGEMENT),
    "cdk": ("mxgraph.aws4.cloud_development_kit", DEVTOOLS),
    "firehose": ("mxgraph.aws4.kinesis_data_firehose", ANALYTICS),
    "users": ("mxgraph.aws4.users", GENERAL),
    "client": ("mxgraph.aws4.client", GENERAL),
    "server": ("mxgraph.aws4.traditional_server", GENERAL),
    "fargate": ("mxgraph.aws4.fargate", COMPUTE),
    "rds": ("mxgraph.aws4.rds", DATABASE),
    "alb": ("mxgraph.aws4.application_load_balancer", NETWORK),
    "secrets": ("mxgraph.aws4.secrets_manager", SECURITY),
    "cloudtrail": ("mxgraph.aws4.cloudtrail", MANAGEMENT),
    "eventbridge": ("mxgraph.aws4.eventbridge", MANAGEMENT),
    "sns": ("mxgraph.aws4.sns", MANAGEMENT),
    "identity": ("mxgraph.aws4.identity_and_access_management", SECURITY),
}
VPC_GROUP = None  # set below, after GROUP_BASE

GROUP_BASE = "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;align=left;spacingLeft=30;"
GROUPS = {
    "cloud": GROUP_BASE + "grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;fontColor=#232F3E;dashed=0;",
    "region": GROUP_BASE + "grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fillColor=none;fontColor=#147EBA;dashed=1;",
    "datacenter": GROUP_BASE + "grIcon=mxgraph.aws4.group_corporate_data_center;strokeColor=#5A6C86;fillColor=none;fontColor=#5A6C86;dashed=0;",
    "vpc": GROUP_BASE + "grIcon=mxgraph.aws4.group_vpc;strokeColor=#8C4FFF;fillColor=none;fontColor=#AAB7B8;dashed=0;",
}
# A CDK stack: a plain rounded container (no AWS group icon) so it reads as "one deployable unit".
STACK = "rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=8 4;strokeColor=#5A6C86;strokeWidth=1;fillColor=#FFFFFF;fillOpacity=55;verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;fontStyle=1;fontSize=12;fontColor=#232F3E;container=1;collapsible=0;recursiveResize=0;"
STRETCH = "rounded=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=2 3;strokeColor=#8C8C8C;fillColor=#F7F7F7;verticalAlign=top;align=left;spacingLeft=8;fontStyle=2;fontSize=11;fontColor=#5A6C86;container=1;collapsible=0;recursiveResize=0;"

EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeWidth=1.3;fontSize=10;fontColor=#545B64;labelBackgroundColor=#FFFFFF;"
BLUE = "#2F6FB2"
GREEN = "#0F7B5F"
GREY = "#545B64"

ICON = 78  # AWS icons are square


class Drawio:
    def __init__(self) -> None:
        self.cells: list[str] = []
        self.geometry: dict[str, tuple[float, float, float, float, str]] = {}  # id → (abs x, abs y, w, h, parent)
        self.labels: dict[str, str] = {}
        self.edge_preview: list[tuple[list[tuple[float, float]], str, str]] = []
        self._n = 0

    def _id(self, hint: str) -> str:
        self._n += 1
        return f"{hint}-{self._n}"

    def _rel(self, x: float, y: float, parent: str) -> tuple[float, float]:
        if parent == "1":
            return x, y
        px, py, _, _, _ = self.geometry[parent]
        return x - px, y - py

    def group(self, hint: str, label: str, x: float, y: float, w: float, h: float, style: str, parent: str = "1") -> str:
        cid = self._id(hint)
        rx, ry = self._rel(x, y, parent)
        self.cells.append(f'<mxCell id="{cid}" value={quoteattr(label)} style={quoteattr(style)} vertex="1" parent="{parent}"><mxGeometry x="{rx}" y="{ry}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        self.geometry[cid] = (x, y, w, h, parent)
        self.labels[cid] = label
        return cid

    def icon(self, hint: str, kind: str, title: str, subtitle: str, x: float, y: float, parent: str = "1", dashed: bool = False) -> str:
        res, colour = ICONS[kind]
        cid = self._id(hint)
        rx, ry = self._rel(x, y, parent)
        label = f"<b>{escape(title)}</b>" + (f"<br><font style=\"font-size:10px\" color=\"#545B64\">{escape(subtitle)}</font>" if subtitle else "")
        style = ICON_BASE + f"fillColor={colour};resIcon={res};" + ("opacity=60;" if dashed else "")
        self.cells.append(f'<mxCell id="{cid}" value={quoteattr(label)} style={quoteattr(style)} vertex="1" parent="{parent}"><mxGeometry x="{rx}" y="{ry}" width="{ICON}" height="{ICON}" as="geometry"/></mxCell>')
        self.geometry[cid] = (x, y, ICON, ICON, parent)
        self.labels[cid] = title
        return cid

    def text(self, hint: str, html: str, x: float, y: float, w: float, h: float, style_extra: str = "", parent: str = "1") -> str:
        cid = self._id(hint)
        rx, ry = self._rel(x, y, parent)
        style = "text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontColor=#232F3E;" + style_extra
        self.cells.append(f'<mxCell id="{cid}" value={quoteattr(html)} style={quoteattr(style)} vertex="1" parent="{parent}"><mxGeometry x="{rx}" y="{ry}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return cid

    def edge(self, source: str, target: str, label: str = "", colour: str = GREY, dashed: bool = False, points: list[tuple[float, float]] | None = None, exit_: tuple[float, float] | None = None, entry: tuple[float, float] | None = None, label_pos: float | None = None) -> str:
        """`label_pos` places the label along the edge: -1 = start, 0 = middle (default), 1 = end."""
        cid = self._id("e")
        style = EDGE + f"strokeColor={colour};" + ("dashed=1;dashPattern=6 4;" if dashed else "")
        if exit_:
            style += f"exitX={exit_[0]};exitY={exit_[1]};exitDx=0;exitDy=0;"
        if entry:
            style += f"entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;"
        pts = ""
        if points:
            pts = "<Array as=\"points\">" + "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in points) + "</Array>"
        def _pt(cid_, frac):
            gx, gy, gw, gh, _ = self.geometry[cid_]
            fx, fy = frac if frac else (0.5, 0.5)
            return (gx + gw * fx, gy + gh * fy)
        self.edge_preview.append(([_pt(source, exit_)] + list(points or []) + [_pt(target, entry)], colour, label))
        pos = f' x="{label_pos}"' if label_pos is not None else ""
        self.cells.append(f'<mxCell id="{cid}" value={quoteattr(label)} style={quoteattr(style)} edge="1" parent="1" source="{source}" target="{target}"><mxGeometry{pos} relative="1" as="geometry">{pts}</mxGeometry></mxCell>')
        return cid

    def preview_svg(self, width: int, height: int) -> str:
        """A rough SVG of the same geometry (boxes, labels, edge waypoints) to check the layout without draw.io."""
        import re as _re
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><rect width="{width}" height="{height}" fill="white"/>']
        for cid, (x, y, w, h, parent) in self.geometry.items():
            is_icon = w == ICON and h == ICON
            out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{"#FFE8CC" if is_icon else "none"}" stroke="{"#ED7100" if is_icon else "#5A6C86"}" stroke-width="1" rx="{0 if is_icon else 8}"/>')
            label = _re.sub(r"<[^>]+>", " ", self.labels.get(cid, "")).replace("&amp;", "&")
            if is_icon:
                out.append(f'<text x="{x + w / 2}" y="{y + h + 12}" text-anchor="middle" font-size="9" font-family="Helvetica">{escape(label[:34])}</text>')
            else:
                out.append(f'<text x="{x + 8}" y="{y + 16}" font-size="11" font-weight="700" font-family="Helvetica">{escape(label[:60])}</text>')
        for pts, colour, label in self.edge_preview:
            d_ = "M" + " L".join(f"{px},{py}" for px, py in pts)
            out.append(f'<path d="{d_}" fill="none" stroke="{colour}" stroke-width="1.2"/>')
            if label:
                mx, my = pts[len(pts) // 2]
                out.append(f'<text x="{mx}" y="{my - 3}" font-size="8.5" fill="{colour}" font-family="Helvetica">{escape(label)}</text>')
        out.append("</svg>")
        return "\n".join(out)

    def render(self, name: str, width: int, height: int) -> str:
        cells = "\n        ".join(self.cells)
        return f"""<mxfile host="app.diagrams.net" agent="medapp docs" version="24.7.17" type="device">
  <diagram id="medapp-aws-infrastructure" name="{escape(name)}">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{width}" pageHeight="{height}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        {cells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
"""


# ── The diagram ─────────────────────────────────────────────────────────────────
#
# Spacing system. Icons sit on a grid inside their stack: PAD from the stack's sides, TOP below its title band, STEP
# between columns (an icon is 78 wide; its two-line label needs ~170), ROWP between rows (icon + label + air). Stacks
# are GAP apart; rows of stacks are RGAP apart, and that corridor is where the long connectors run, one y per line.

PAD, TOP, STEP, ROWP = 36, 56, 180, 160
GAP, RGAP = 40, 80
LEFT_PAD = 60                                   # the region's left margin carries two long verticals
Y1, Y2, Y3, Y4 = 190, 480, 930, 1380           # the four rows of stacks
H1, H2, H3, H4 = 210, 370, 370, 420            # their heights (one icon row; two; two; a VPC with two)
RX, RW = 320, 1590                              # the region
REGION_RIGHT = RX + RW


def at(stack_x: float, stack_y: float, col: int, row: int, top: float = TOP, step: float = STEP) -> tuple[float, float]:
    return stack_x + PAD + col * step, stack_y + top + row * ROWP


d = Drawio()
G = d.geometry


def L(c): return G[c][0]
def R(c): return G[c][0] + G[c][2]
def T(c): return G[c][1]
def B(c): return G[c][1] + G[c][3]
def CX(c): return G[c][0] + G[c][2] / 2
def CY(c): return G[c][1] + G[c][3] / 2


d.text("title", "<font style=\"font-size:20px\"><b>AWS infrastructure, as built</b></font><br><font style=\"font-size:11px\" color=\"#545B64\">One deployment per hospital: ten CDK stacks in one account and one EU region. The browser talks only to CloudFront, Cognito and API Gateway; every clinical data call goes through the dispatcher. The reference servers stand in for the hospital's systems until those are reachable; the hospital's own servers are reached with OAuth 2.0 client credentials.</font>", 60, 20, 1700, 60)

# people and browser
users = d.icon("users", "users", "Hospital staff", "clinicians · authors · approvers · admins", 130, 240)
browser = d.icon("browser", "client", "Browser — the panel", "React SPA · embedded OHIF viewer", 130, 670)

# AWS cloud and region
cloud = d.group("cloud", "AWS Cloud — the hospital's account", RX - 20, 90, RW + 40, Y4 + H4 + 40 + 20 - 90, GROUPS["cloud"])
region = d.group("region", "eu-central-1 — EU data residency (checked at synth)", RX, 130, RW, Y4 + H4 + 40 - 130, GROUPS["region"], parent=cloud)

# ── Row 1: identity, hosting, viewer, deployment ────────────────────────────────
x = RX + LEFT_PAD
identity = d.group("identity", "IdentityStack", x, Y1, 380, H1, STACK, parent=region)
cognito = d.icon("cognito", "cognito", "Amazon Cognito", "one user pool · platform + app groups", *at(x + 24, Y1, 0, 0), parent=identity)
d.text("idnote", "<font style=\"font-size:10px\" color=\"#545B64\">SRP web client · e-mails in the panel's look · MFA switch<br>per-app role groups created at publish by the registry writer</font>", R(cognito) + 14, T(cognito) + 4, 190, 70, parent=identity)
x += 380 + GAP
hosting = d.group("hosting", "HostingStack", x, Y1, 330, H1, STACK, parent=region)
cf = d.icon("cf", "cloudfront", "Amazon CloudFront", "HTTPS · headers · SPA routes", *at(x, Y1, 0, 0), parent=hosting)
s3 = d.icon("s3", "s3", "Amazon S3 (private)", "build + config.json · OAC", *at(x, Y1, 1, 0), parent=hosting)
x += 330 + GAP
viewer = d.group("viewer", "ViewerStack", x, Y1, 330, H1, STACK, parent=region)
cfv = d.icon("cfv", "cloudfront", "Amazon CloudFront", "OHIF viewer · pinned release", *at(x, Y1, 0, 0), parent=viewer)
s3v = d.icon("s3v", "s3", "Amazon S3 (private)", "@ohif/app · app-config.js", *at(x, Y1, 1, 0), parent=viewer)
x += 330 + GAP
deploy = d.group("deploy", "Deployment and configuration", x, Y1, REGION_RIGHT - GAP - x, H1, STACK, parent=region)
cdk = d.icon("cdk", "cdk", "AWS CDK (Python)", "10 stacks · cdk.json · cdk-nag", *at(x, Y1, 0, 0), parent=deploy)
ssm = d.icon("ssm", "ssm", "Systems Manager", "Parameter Store /medapp/*", *at(x, Y1, 1, 0), parent=deploy)

# ── Row 2: API, registry, audit, regional services ─────────────────────────────
x = RX + LEFT_PAD
api = d.group("api", "ApiStack", x, Y2, 600, H2, STACK, parent=region)
apigw = d.icon("apigw", "api_gateway", "Amazon API Gateway", "HTTP API · JWT authorizer · CORS", *at(x, Y2, 0, 0), parent=api)
media = d.icon("media", "s3", "Amazon S3 — media", "photo documentation · presigned", *at(x, Y2, 0, 1), parent=api)
LX = x + PAD + 220  # the Lambdas' first column leaves room for the fan-out from the gateway
regread = d.icon("regread", "lambda", "Lambda — Registry API", "what each person may open", LX, T(apigw), parent=api)
useradmin = d.icon("useradmin", "lambda", "Lambda — User admin", "accounts · groups · invitations", LX + STEP, T(apigw), parent=api)
disp = d.icon("disp", "lambda", "Lambda — Dispatcher", "version · role · scope · config · audit", LX, T(media), parent=api)
auditapi = d.icon("auditapi", "lambda", "Lambda — Audit API", "the trail, filtered", LX + STEP, T(media), parent=api)
x += 600 + GAP
registry = d.group("registry", "RegistryStack", x, Y2, 190, H2, STACK, parent=region)
ddb_registry = d.icon("ddbreg", "dynamodb", "Amazon DynamoDB", "registry: versions · events · shapes", x + (190 - ICON) / 2, Y2 + TOP, parent=registry)
kms_reg = d.icon("kmsreg", "kms", "AWS KMS", "registry CMK · PITR · streams", x + (190 - ICON) / 2, Y2 + TOP + ROWP, parent=registry)
x += 190 + GAP
audit = d.group("audit", "AuditStack", x, Y2, 190, H2, STACK, parent=region)
ddb_audit = d.icon("ddbaudit", "dynamodb", "Amazon DynamoDB", "audit trail · append-only · RETAIN", x + (190 - ICON) / 2, Y2 + TOP, parent=audit)
kms_audit = d.icon("kmsaudit", "kms", "AWS KMS", "audit CMK · PITR", x + (190 - ICON) / 2, Y2 + TOP + ROWP, parent=audit)
x += 190 + 60  # a wider gap: three connectors run down this corridor
CORRIDOR_X = x - 60
services = d.group("services", "Regional services", x, Y2, REGION_RIGHT - GAP - x, H2, STACK, parent=region)
bedrock = d.icon("bedrock", "bedrock", "Amazon Bedrock", "Claude · eu. inference profile", *at(x, Y2, 0, 0), parent=services)
cloudwatch = d.icon("cw", "cloudwatch", "CloudWatch Logs", "function logs", *at(x, Y2, 1, 0), parent=services)
d.text("svcnote", "<font style=\"font-size:10px\" color=\"#545B64\">Only the drafting agent may invoke Bedrock, and only eu.* profiles. Audit records are items in the AuditStack table, not log lines.</font>", L(bedrock), T(bedrock) + ROWP, 300, 100, parent=services)

# ── Row 3: authoring, guardrails ───────────────────────────────────────────────
x = RX + LEFT_PAD
authoring = d.group("authoring", "AuthoringStack", x, Y3, CORRIDOR_X - x, H3, STACK, parent=region)
drafts = d.icon("drafts", "lambda", "Lambda — Drafts API", "sessions · async turns · PATCH", *at(x, Y3, 0, 0, step=190), parent=authoring)
agent = d.icon("agent", "lambda", "Lambda — Drafting agent", "Strands · 15 tools · async", *at(x, Y3, 1, 0, step=190), parent=authoring)
manifest = d.icon("manifest", "lambda", "Lambda — Manifest service", "Node · the TypeScript compiler", *at(x, Y3, 2, 0, step=190), parent=authoring)
regwrite = d.icon("regwrite", "lambda", "Lambda — Registry write", "lifecycle · four-eyes · publish", *at(x, Y3, 3, 0, step=190), parent=authoring)
ddb_drafts = d.icon("ddbdrafts", "dynamodb", "Amazon DynamoDB", "drafts · TTL 30 days · CMK", *at(x, Y3, 0, 1, step=190), parent=authoring)
vocab = d.icon("vocab", "s3", "Amazon S3 — vocabulary", "the record's codes, nightly", *at(x, Y3, 1, 1, step=190), parent=authoring)
kms_sign = d.icon("kmssign", "kms", "AWS KMS — sign-off key", "ECC P-256 · signs manifest hash", *at(x, Y3, 2, 1, step=190), parent=authoring)
d.text("authnote", "<font style=\"font-size:10px\" color=\"#545B64\">Staged at synth, no Docker: the Python dependency layer (arm64), the TypeScript bundle (esbuild), the frontend build, the OHIF release.<br>The drafts API only enqueues turns; the agent runs them. Publishing creates the app's role groups in Cognito and writes its forms to the record.</font>", R(regwrite) + 50, T(kms_sign), CORRIDOR_X - PAD - (R(regwrite) + 50), 110, parent=authoring)
x = CORRIDOR_X + 60
guard = d.group("guard", "AppRegistryGuardStack (optional)", x, Y3, REGION_RIGHT - GAP - x, H3, STACK, parent=region)
trail = d.icon("trail", "cloudtrail", "AWS CloudTrail", "table data events", *at(x, Y3, 0, 0), parent=guard)
events = d.icon("events", "eventbridge", "Amazon EventBridge", "denied · foreign · tampering", *at(x, Y3, 1, 0), parent=guard)
alertfn = d.icon("alertfn", "lambda", "Lambda — alert", "plain-text e-mail", *at(x, Y3, 0, 1), parent=guard)
sns = d.icon("sns", "sns", "Amazon SNS", "e-mail subscription", *at(x, Y3, 1, 1), parent=guard)

# ── Row 4: data sources ────────────────────────────────────────────────────────
x = RX + LEFT_PAD
reference = d.group("reference", "ReferenceServersStack — stand-ins for the hospital's systems, synthetic record only (reference_servers: true)", x, Y4, 800, H4, STACK, parent=region)
vpc = d.group("vpc", "VPC — public + isolated subnets, no NAT", x + 20, Y4 + 40, 760, H4 - 70, GROUPS["vpc"], parent=reference)
vx, vy = L(vpc), T(vpc)
refapi = d.icon("refapi", "api_gateway", "HTTP API (IAM, SigV4)", "/fhir · /dicom-web · VPC link", *at(vx, vy, 0, 0), parent=vpc)
alb = d.icon("alb", "alb", "Internal ALB", "HTTP → tasks", *at(vx, vy, 1, 0), parent=vpc)
hapi = d.icon("hapi", "fargate", "HAPI FHIR R4", "Fargate task", *at(vx, vy, 2, 0), parent=vpc)
rds = d.icon("rds", "rds", "Amazon RDS", "Postgres 16 · db.t4g.micro", *at(vx, vy, 3, 0), parent=vpc)
seedref = d.icon("seedref", "lambda", "Lambda — seed", "bundle · vocabulary · verify", *at(vx, vy, 0, 1), parent=vpc)
s3seed = d.icon("s3seed", "s3", "Amazon S3 — seed", "bundle + DICOM studies", *at(vx, vy, 1, 1), parent=vpc)
orthanc = d.icon("orthanc", "fargate", "Orthanc PACS", "Fargate task · DICOMweb", *at(vx, vy, 2, 1), parent=vpc)
d.text("refnote", "<font style=\"font-size:10px\" color=\"#545B64\">Studies generated at synth from the same patients; a browser door on the API admits the panel's token for OHIF.</font>", L(rds) - 30, T(orthanc), 190, 110, parent=vpc)
x += 800 + GAP
hospsrv = d.group("hospsrv", "HospitalServersStack", x, Y4, REGION_RIGHT - GAP - x, H4, STACK, parent=region)
secret = d.icon("secret", "secrets", "Secrets Manager", "OAuth2 client id + secret", *at(x, Y4, 0, 0, top=96), parent=hospsrv)
door_api = d.icon("doorapi", "api_gateway", "HTTP API — viewer door", "JWT authorizer (panel users)", CORRIDOR_X + 15 - ICON / 2, T(secret), parent=hospsrv)  # under the viewer's connector
door_fn = d.icon("doorfn", "lambda", "Lambda — door", "adds the hospital's token", L(door_api) + STEP, T(secret), parent=hospsrv)
seedhosp = d.icon("seedhosp", "lambda", "Lambda — definitions seed", "forms at publish · vocabulary", L(secret), T(secret) + ROWP, parent=hospsrv)
spill = d.icon("spill", "s3", "Amazon S3 — spill", "large frames · presigned · 1 day", L(door_api), T(secret) + ROWP, parent=hospsrv)
d.text("hospnote", "<font style=\"font-size:10px\" color=\"#545B64\">Optional: a hospital's own FHIR server and DICOMweb gateway, by configuration (hospital_servers). The secret is written by a script, never by code or cdk.json; the dispatcher, the door and the seed may read it. The browser never sees the hospital's credentials.</font>", L(door_fn), T(spill), REGION_RIGHT - GAP - PAD - L(door_fn), 130, parent=hospsrv)

# Hospital systems
DC_X = REGION_RIGHT + 20 + 60
hospital = d.group("hospital", "Hospital data centre<br><font style=\"font-size:10px\" color=\"#5A6C86\">optional: a hospital's own FHIR server and PACS</font>", DC_X, Y2, 340, 760, GROUPS["datacenter"])
fhir = d.icon("fhir", "server", "FHIR server (R4)", "system of record · read + write", DC_X + (340 - ICON) / 2, Y2 + 90, parent=hospital)
dicom = d.icon("dicom", "server", "DICOMweb gateway", "QIDO-RS · WADO-RS", DC_X + (340 - ICON) / 2, Y2 + 300, parent=hospital)
idp = d.icon("idp", "identity", "Hospital IdP", "Entra ID / Keycloak — production SSO", DC_X + (340 - ICON) / 2, Y2 + 520, parent=hospital, dashed=True)

# ── Edges ───────────────────────────────────────────────────────────────────────
# Corridor lines: between row 1 and 2 (y 400–480) and between row 2 and 3 (y 850–930), one y per connector.
C1_AUTH, C1_VIEWER, C1_PANEL, C1_SIGNIN = 415, 428, 441, 454
C2_AUDIT, C2_REF, C2_FHIR, C2_MODEL, C2_API, C2_EVENTS = 860, 872, 884, 896, 908, 920
C3_FORMS, C3_VOCAB = Y3 + H3 + 20, Y3 + H3 + 40
DOOR_X, EVENTS_X, MODEL_X = CORRIDOR_X + 15, CORRIDOR_X + 30, CORRIDOR_X + 45   # the three verticals in the wide gap
FHIR_X, DICOM_X = REGION_RIGHT + 20 + 20, REGION_RIGHT + 20 + 40                 # between the cloud and the data centre
REG_X = R(registry) - 8                                                           # inside RegistryStack, right of the icons and their labels
AUDIT_X, EVENTS_OUT_X = L(audit) - 24, L(audit) - 8                               # the gap between RegistryStack and AuditStack

d.edge(users, browser, "", GREY)
d.edge(browser, cognito, "sign in (SRP) · tokens", GREY, dashed=True, points=[(265, CY(browser)), (265, C1_SIGNIN), (CX(cognito), C1_SIGNIN)], exit_=(1, 0.5), entry=(0.5, 1), label_pos=0.4)
d.edge(browser, cf, "HTTPS — panel, config.json", GREY, points=[(245, CY(browser)), (245, C1_PANEL), (CX(cf), C1_PANEL)], exit_=(1, 0.5), entry=(0.5, 1), label_pos=0.22)
d.edge(cf, s3, "OAC", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(browser, cfv, "viewer", GREY, points=[(230, CY(browser)), (230, C1_VIEWER), (CX(cfv), C1_VIEWER)], exit_=(1, 0.5), entry=(0.5, 1), label_pos=0.1)
d.edge(cfv, s3v, "OAC", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(browser, apigw, "API calls — ID token (JWT)", GREY, points=[(280, CY(browser)), (280, CY(apigw))], exit_=(1, 0.5), entry=(0, 0.5), label_pos=-0.33)
d.edge(apigw, cognito, "JWT authorizer: issuer + audience", GREY, dashed=True, points=[(CX(apigw), C1_AUTH), (L(cognito) + ICON * 0.25, C1_AUTH)], exit_=(0.5, 0), entry=(0.25, 1), label_pos=0.2)
d.edge(idp, cognito, "federation (production)", GREY, dashed=True, points=[(R(hospital) + 40, CY(idp)), (R(hospital) + 40, 165), (L(cognito) + ICON * 0.8, 165)], exit_=(1, 0.5), entry=(0.8, 0), label_pos=0.45)

# the gateway fans out to its four functions; the two to the far column go over and under their neighbours
d.edge(apigw, regread, "", BLUE, points=[(R(apigw) + 70, T(apigw) + ICON * 0.3), (R(apigw) + 70, CY(regread))], exit_=(1, 0.3), entry=(0, 0.5))
d.edge(apigw, disp, "", BLUE, points=[(R(apigw) + 85, T(apigw) + ICON * 0.6), (R(apigw) + 85, T(disp) + ICON * 0.3)], exit_=(1, 0.6), entry=(0, 0.3))
d.edge(apigw, useradmin, "", BLUE, points=[(L(apigw) + ICON * 0.75, Y2 + 28), (CX(useradmin), Y2 + 28)], exit_=(0.75, 0), entry=(0.5, 0))
d.edge(apigw, auditapi, "", BLUE, points=[(R(apigw) + 55, T(apigw) + ICON * 0.85), (R(apigw) + 55, B(api) - 25), (CX(auditapi), B(api) - 25)], exit_=(1, 0.85), entry=(0.5, 1))
d.edge(regread, ddb_registry, "", BLUE, points=[(CX(regread), Y2 + 14), (L(registry) - 20, Y2 + 14), (L(registry) - 20, T(ddb_registry) + ICON * 0.25)], exit_=(0.5, 0), entry=(0, 0.25))
d.edge(disp, ddb_registry, "published manifest + scopes", BLUE, points=[(R(disp) + 40, T(disp) + ICON * 0.3), (R(disp) + 40, T(disp) - 22), (L(registry) - 20, T(disp) - 22), (L(registry) - 20, T(ddb_registry) + ICON * 0.75)], exit_=(1, 0.3), entry=(0, 0.75), label_pos=0.1)
d.edge(disp, media, "", BLUE, exit_=(0, 0.7), entry=(1, 0.7))
d.edge(disp, fhir, "FHIR R4 — reads and writes (OAuth2 client credentials)", BLUE, points=[(CX(disp), C2_FHIR), (FHIR_X, C2_FHIR), (FHIR_X, CY(fhir))], exit_=(0.5, 1), entry=(0, 0.5), label_pos=0.5)
d.edge(disp, refapi, "reference servers (SigV4) — by configuration", BLUE, dashed=True, points=[(L(disp) + ICON * 0.25, C2_REF), (RX + 40, C2_REF), (RX + 40, CY(refapi))], exit_=(0.25, 1), entry=(0, 0.5), label_pos=0.62)
d.edge(disp, ddb_audit, "audit record per call", BLUE, points=[(L(disp) + ICON * 0.75, C2_AUDIT), (AUDIT_X, C2_AUDIT), (AUDIT_X, CY(ddb_audit))], exit_=(0.75, 1), entry=(0, 0.5), label_pos=-0.35)
d.edge(useradmin, cognito, "", GREY, dashed=True, points=[(L(useradmin) + ICON * 0.75, C1_AUTH), (L(cognito) + ICON * 0.75, C1_AUTH)], exit_=(0.75, 0), entry=(0.75, 1))

# authoring: the gateway's routes reach the drafts API, the manifest service and the registry writer from the left
API_OUT_X = RX + 20  # down the region's margin, left of the stacks
for target in (drafts, manifest, regwrite):
    d.edge(apigw, target, "", GREEN, points=[(API_OUT_X, T(apigw) + ICON * 0.8), (API_OUT_X, C2_API), (CX(target), C2_API)], exit_=(0, 0.8), entry=(0.5, 0))
d.edge(drafts, agent, "async invoke (turn)", GREEN, dashed=True, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(drafts, ddb_drafts, "", GREEN, exit_=(0.5, 1), entry=(0.5, 0))
d.edge(agent, ddb_drafts, "progress · result", GREEN, points=[(CX(agent), T(ddb_drafts) - 26), (R(ddb_drafts) + 26, T(ddb_drafts) - 26), (R(ddb_drafts) + 26, T(ddb_drafts) + ICON * 0.3)], exit_=(0.5, 1), entry=(1, 0.3))
d.edge(agent, vocab, "codes on the record", GREEN, exit_=(0.9, 1), entry=(0.9, 0), label_pos=0.6)
d.edge(agent, manifest, "readiness · compile", GREEN, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(agent, bedrock, "InvokeModel", GREEN, points=[(CX(agent), C2_MODEL), (MODEL_X, C2_MODEL), (MODEL_X, CY(bedrock))], exit_=(0.5, 0), entry=(0, 0.5), label_pos=-0.3)
d.edge(regwrite, ddb_registry, "versions · events", GREEN, points=[(REG_X, CY(regwrite)), (REG_X, CY(ddb_registry))], exit_=(1, 0.5), entry=(1, 0.5), label_pos=-0.35)
d.edge(regwrite, kms_sign, "Sign (manifest hash)", GREEN, points=[(CX(regwrite), T(kms_sign) - 26), (R(kms_sign) + 26, T(kms_sign) - 26), (R(kms_sign) + 26, T(kms_sign) + ICON * 0.3)], exit_=(0.5, 1), entry=(1, 0.3))
d.edge(regwrite, manifest, "compile", GREEN, exit_=(0, 0.5), entry=(1, 0.5))
d.edge(regwrite, seedhosp, "forms at publish (async)", GREEN, dashed=True, points=[(L(regwrite) + ICON * 0.75, C3_FORMS), (L(hospsrv) - 20, C3_FORMS), (L(hospsrv) - 20, CY(seedhosp))], exit_=(0.75, 1), entry=(0, 0.5), label_pos=0.3)

d.edge(trail, events, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(events, alertfn, "", GREY, points=[(CX(events), T(alertfn) - 26), (CX(alertfn), T(alertfn) - 26)], exit_=(0.5, 1), entry=(0.5, 0))
d.edge(alertfn, sns, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(ddb_registry, trail, "data events", GREY, dashed=True, points=[(EVENTS_OUT_X, T(ddb_registry) + ICON * 0.75), (EVENTS_OUT_X, C2_EVENTS), (EVENTS_X, C2_EVENTS), (EVENTS_X, CY(trail))], exit_=(1, 0.75), entry=(0, 0.5), label_pos=0.6)

d.edge(refapi, alb, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(alb, hapi, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(hapi, rds, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(alb, orthanc, "", GREY, points=[(R(alb) + 26, T(alb) + ICON * 0.8), (R(alb) + 26, CY(orthanc))], exit_=(1, 0.8), entry=(0, 0.5))
d.edge(seedref, s3seed, "", GREY, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(seedref, vocab, "vocabulary", GREY, dashed=True, points=[(CX(seedref), C3_VOCAB), (L(vocab) - 16, C3_VOCAB), (L(vocab) - 16, T(vocab) + ICON * 0.75)], exit_=(0.5, 0), entry=(0, 0.75), label_pos=0.3)

d.edge(cfv, door_api, "DICOMweb via the door", BLUE, dashed=True, points=[(L(cfv) + ICON * 0.75, C1_SIGNIN), (DOOR_X, C1_SIGNIN), (DOOR_X, T(door_api))], exit_=(0.75, 1), entry=(0.5, 0), label_pos=0.8)
d.edge(door_api, door_fn, "", BLUE, exit_=(1, 0.5), entry=(0, 0.5))
d.edge(door_fn, dicom, "QIDO-RS · WADO-RS (hospital token)", BLUE, points=[(DICOM_X, CY(door_fn)), (DICOM_X, CY(dicom))], exit_=(1, 0.5), entry=(0, 0.5), label_pos=-0.8)
d.edge(door_fn, spill, "spill > 6 MB", BLUE, points=[(CX(door_fn), T(spill) - 30), (CX(spill), T(spill) - 30)], exit_=(0.5, 1), entry=(0.5, 0), label_pos=0.3)
d.edge(secret, door_fn, "", GREY, dashed=True, points=[(CX(secret), T(secret) - 24), (CX(door_fn), T(secret) - 24)], exit_=(0.5, 0), entry=(0.5, 0))

PAGE_W, PAGE_H = R(hospital) + 80, B(cloud) + 90
d.text("legend", "<font style=\"font-size:10px\"><font color=\"#2F6FB2\">━━</font> clinical use: open an app, data through the dispatcher &nbsp;&nbsp; <font color=\"#0F7B5F\">━━</font> authoring: drafts, agent, compiler, registry, sign-off &nbsp;&nbsp; <font color=\"#545B64\">━━</font> serving, sign-in, guardrails &nbsp;&nbsp; <font color=\"#545B64\">╌╌</font> optional / by configuration / production</font>", 60, B(cloud) + 30, 1400, 30)

out = __file__.replace("aws_infrastructure_drawio.py", "aws-infrastructure.drawio")
open(out, "w", encoding="utf-8").write(d.render("AWS infrastructure", int(PAGE_W), int(PAGE_H)))
import os as _os
open(_os.path.join(_os.environ.get("TMPDIR", "/tmp"), "aws-infrastructure-preview.svg"), "w", encoding="utf-8").write(d.preview_svg(int(PAGE_W), int(PAGE_H)))  # layout check without draw.io
print("wrote", out, int(PAGE_W), int(PAGE_H))
