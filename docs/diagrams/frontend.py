"""MedApp — the panel (frontend): pages, the verified core, and the clients that connect it to the platform."""

from svgdiagram import BLUE, GREEN, LINE, Box, Diagram, legend

d = Diagram(
    1800,
    960,
    "MedApp — panel (frontend) components",
    "One React single-page app (Vite · TypeScript · Mantine · Medplum React). The same compiler and renderer serve the drafting preview and the published app — there is no second code path.",
)

# ── Pages ───────────────────────────────────────────────────────────────────────
d.group(30, 110, 630, 540, "Pages", "green", sub="clinicians: App registry + App runtime · authors: Drafting page · approvers: Pending sign-off tab + inspector")
d.box(Box("launcher", 95, 150, 545, 70, "App registry", ["Published apps · Drafts · Pending sign-off", "patient picker · New app · Submit for review"]))

d.group(95, 250, 545, 225, "Drafting page", "white", title_size=11)
d.box(Box("chat", 110, 290, 165, 70, "Chat pane", ["assistant replies (markdown)", "progress while it works"]))
d.box(Box("readiness", 290, 290, 165, 70, "Readiness list", ["what is still open,", "per tab"]))
d.box(Box("preview", 470, 290, 165, 70, "Preview pane", ["compile → validate → render", "on synthetic data, as any role"]))
d.box(Box("editors", 110, 390, 525, 60, "Editors — App · Roles & access · Governance · Settings", ["form-first for access (hospital groups, identity fields per role); YAML for staff"]))

d.box(Box("runtime", 95, 505, 545, 115, "App runtime", ["role from the person's groups (most capable wins) · patient picker when launched without one", "inspector for staff: preview as another role, entitlements, audit trail,", "lifecycle actions (submit · approve · publish · iterate)"]))

# ── Core ────────────────────────────────────────────────────────────────────────
d.group(760, 110, 1010, 550, "Core — the verified compiler and renderer (Layer 1)", "warm", sub="also bundled as the manifest-service Lambda and a CLI: one compiler and one validator everywhere")

d.group(780, 150, 970, 120, "AppSpec → manifest", "white", title_size=11)
d.box(Box("appspec", 795, 190, 290, 60, "AppSpec schema", ["12 archetypes · knobs · roles · governance", "JSON Schema published for the agent"]))
d.box(Box("compiler", 1105, 190, 300, 60, "Compiler", ["blocks → data primitives, derived data", "scopes per role, layout — deterministic"]))
d.box(Box("readinessfn", 1425, 190, 310, 60, "Readiness", ["what a partial draft still lacks —", "the assistant's next questions"]))

d.group(780, 290, 970, 110, "Manifest (Layer 2 — data, never code)", "white", title_size=11)
d.box(Box("schema", 795, 330, 460, 55, "Manifest schema (zod, strict)", ["lookup-only expressions: $bindings · $context · $metadata · $auth · $ui"]))
d.box(Box("access", 1275, 330, 460, 55, "Access rules", ["roles → groups · effective scope with inheritance · identity allow-list"]))

d.group(780, 420, 970, 225, "Deterministic renderer", "white", title_size=11)
d.box(Box("manifestapp", 795, 460, 300, 70, "ManifestApp", ["runs data primitives in order · scope check", "audit record per call · actions for writes"]))
d.box(Box("rendernode", 1115, 460, 290, 70, "RenderNode", ["manifest node → catalog component", "unknown component = visible refusal · role gates"]))
d.box(Box("medplum", 1425, 460, 310, 70, "Medplum React + FHIR definitions", ["typed FHIR components used by the catalog", "StructureDefinitions bundled, works offline"]))
d.box(Box("datacatalog", 795, 555, 300, 65, "Data catalog", ["data.fhir.* · data.dicom.* · data.cohort.* · write.fhir.*", "config schemas · scope each kind requires"]))
d.box(Box("uicatalog", 1115, 555, 620, 75, "UI catalog (design system)", ["layout: PageShell · TwoColumn · Grid · Section · Tabs", "display: PatientBanner · PatientHeader · VitalsTable · ObservationTimeline · ProblemList · MedicationList · ImagingStudyList", "DicomViewer (OHIF) · StatCard · CohortTable · ResourceDetails · AssessmentForm · SubmissionList"]))

# ── Clients ─────────────────────────────────────────────────────────────────────
d.group(30, 700, 1740, 185, "Clients", "grey")
d.note(44, 872, "Each client has a remote form against the platform — every call carries the Cognito ID token, refreshed before it expires — and a local form for development and the drafting preview.", 9.8)
d.box(Box("regsrc", 50, 745, 300, 100, "Registry source", ["remote: Registry API —", "what this person may open", "local: bundled manifests + apps saved here"]))
d.box(Box("authclient", 380, 745, 320, 100, "Authoring client", ["remote: Drafts API · manifest service ·", "registry write and lifecycle", "local: in-browser mirror of the draft rules"]))
d.box(Box("auth", 730, 745, 320, 100, "Auth", ["Cognito sign-in (SRP) · ID token refreshed", "before it expires · sign-out on failure", "mock provider: roles from the username"]))
d.box(Box("config", 1080, 745, 320, 100, "Runtime config", ["config.json written at deploy time:", "hospital, Cognito pool, API URL, modes", ".env in development"]))
d.box(Box("executor", 1430, 745, 320, 100, "Primitive executor", ["dispatcher: POST /primitives/{kind}", "mock: synthetic record (Medplum MockClient) —", "the preview never touches real data"]))

# ── Edges ───────────────────────────────────────────────────────────────────────
# registry: launcher and runtime read it (one bus down the left margin)
d.edge([(95, 185), (48, 185), (48, 690), (200, 690), (200, 745)], colour=BLUE, label="apps and versions", label_at=(130, 686))
d.edge([(95, 562), (48, 562)], colour=BLUE, arrow=False)
# drafting page ↔ authoring client
d.edge([(110, 420), (62, 420), (62, 680), (540, 680), (540, 745)], colour=GREEN, label="turns · typed edits · save · transitions", label_at=(330, 676))
# preview → compiler pipeline, and → renderer
d.edge([(552, 290), (552, 237), (740, 237), (740, 212), (780, 212)], colour=GREEN, label="compile the draft", label_at=(650, 233))
d.edge([(635, 325), (735, 325), (735, 480), (795, 480)], colour=GREEN, label="preview render", label_at=(686, 319))
# runtime → renderer
d.edge([(640, 562), (745, 562), (745, 510), (795, 510)], colour=BLUE, label="run the manifest", label_at=(692, 556))
# renderer → executor (out the left margin, along the corridor)
d.edge([(795, 525), (770, 525), (770, 690), (1590, 690), (1590, 745)], colour=BLUE, label="data primitives, scope-checked before every call", label_at=(1180, 686))
# inside the core
d.edge([(1085, 220), (1105, 220)], colour=LINE)
d.edge([(1200, 250), (1200, 330)], colour=LINE, label="validated by", label_at=(1240, 293))
d.edge([(1095, 495), (1115, 495)], colour=LINE)
d.edge([(1260, 530), (1260, 555)], colour=LINE)
d.edge([(1580, 555), (1580, 530)], colour=LINE, label="built on", label_at=(1615, 546))
d.edge([(945, 530), (945, 555)], colour=LINE)
d.edge([(1000, 460), (1000, 410), (1300, 410), (1300, 385)], colour=LINE, label="effective scope · identity masking", label_at=(1150, 406))

legend(
    d,
    30,
    915,
    [
        (BLUE, "clinical use — registry, runtime, data through the dispatcher", False),
        (GREEN, "authoring — drafting page, compiler, preview", False),
    ],
)
d.note(700, 915, "Everything a clinician sees is produced by the renderer from a manifest; the manifest only ever names catalog components and data primitives, and the same catalogs are what the compiler may emit.", 9.8)

open(__file__.replace("frontend.py", "frontend.svg"), "w", encoding="utf-8").write(d.render())
print("wrote frontend.svg")
