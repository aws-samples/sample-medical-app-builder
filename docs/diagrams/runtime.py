"""One data call at runtime: what the dispatcher checks before any FHIR or DICOMweb request (portrait)."""

from svgdiagram import BLUE, LINE, Box, Diagram, legend

RED = "#B42318"

d = Diagram(
    1300,
    1200,
    "One data call at runtime — the enforcement chain of the dispatcher",
    "The browser sends the primitive id, the app and version, the role and the launch context. The server decides everything else from the registry and the token; a refusal is audited like a success.",
)

d.box(Box("browser", 50, 100, 380, 100, "Panel in the browser", ["the renderer plans the manifest's primitives and sends one request each:", "POST /primitives/{kind} · Authorization: Cognito ID token"], desc_size=9.6))
d.box(Box("apigw", 470, 100, 380, 100, "API Gateway — JWT authorizer", ["issuer and audience of the hospital's user pool,", "signature and expiry; the claims reach the Lambda"], desc_size=9.6))
d.edge([(430, 150), (470, 150)], colour=BLUE)
d.edge([(660, 200), (660, 240)], colour=BLUE, label="claims + request", label_at=(740, 226))

steps = [
    ("1 · Version", ["load app_id@version from the registry — never from the client"], "unknown version → 404"),
    ("2 · Published?", ["the version is published, or the caller is platform staff previewing a draft"], "otherwise → 403"),
    ("3 · Role", ["the token's groups against the manifest's own role bindings; blanket viewers get the default role"], "no binding → 403"),
    ("4 · Primitive", ["declared by this version, of the stated kind, allowed for this role (only_for_roles)"], "undeclared → 404"),
    ("5 · Scope", ["the role's effective data scope grants the resource type and operation; cohort scope for cross-patient lists"], "not granted → 403"),
    ("6 · Configuration", ["the launch context fits the declared inputs; codes, patient filter, window and write rules are resolved from the manifest — a request that differs is refused, the paths recorded"], "differs → 400"),
    ("7 · Execute", ["FHIR or DICOMweb with the platform's credentials; writes validated against the declared rules, stamped with Provenance"], "payload invalid → 422"),
]
y = 240
for i, (title, desc, refusal) in enumerate(steps):
    d.box(Box(f"s{i}", 50, y, 800, 78, title, desc, title_size=12.5, desc_size=9.6))
    d.box(Box(f"r{i}", 880, y + 16, 240, 46, refusal, [], title_size=10.5, fill="#FBEDEB", stroke=RED))
    d.edge([(850, y + 39), (880, y + 39)], colour=RED, arrow=True)
    if i < len(steps) - 1:
        d.edge([(450, y + 78), (450, y + 98)], colour=BLUE)
    y += 98

d.box(Box("audit", 50, y + 20, 1070, 90, "8 · Audit record — written whatever happened", ["audit_id · app · version · primitive · kind · role and how it was obtained (group, blanket, staff preview) · caller · patient in context", "hash of the data scope that applied · outcome ok / refused / error · duration · what was read or written · payload hash for writes · config paths that differed or were dropped", "the audit writer may only PutItem: nothing can update or delete a record"], desc_size=9.6))
d.edge([(450, y + 78 - 98), (450, y + 20)], colour=LINE, label="every outcome", label_at=(520, y + 8))
d.edge([(1000, 240 + 6 * 98 + 62), (1000, y + 20)], colour=LINE, dashed=True)

d.note(50, y + 150, "What the client cannot change", size=11, colour="#1F2933", weight=700)
d.note(50, y + 172, "which manifest and version run · which role it holds · which primitives exist · which resource types and operations a role may touch · that the call is on the record ·", size=9.8)
d.note(50, y + 188, "the primitive's configuration — code list, patient filter, window, a write's ranges and allowed values — which the dispatcher resolves from the published manifest itself", size=9.8)
d.note(50, y + 204, "(declared_config.py); a request that spells a declared value differently is refused (400) with the paths on its audit record.", size=9.8)
d.note(50, y + 228, "Still the client's, by nature: what the manifest marks as the person's input ($ui — validated as a write) or an earlier primitive's output ($bindings — within the role's scope).", size=9.8)

legend(d, 1150, y + 172, [(BLUE, "request path", False), (RED, "refusal (audited)", False), (LINE, "audit", False)])

open(__file__.replace(".py", ".svg"), "w", encoding="utf-8").write(d.render())
print("wrote", __file__.replace(".py", ".svg"))
