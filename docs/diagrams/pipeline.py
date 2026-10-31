"""From a sentence to a running app: the three hand-offs and who decides at each (portrait)."""

from svgdiagram import AMBER, BLUE, GREEN, LINE, Box, Diagram, legend

VIOLET = "#6B4FA8"

d = Diagram(
    1300,
    1610,
    "From a plain-language request to a running, audited app",
    "Three hand-offs, each narrowing what the next stage may do: the model proposes within a typed vocabulary, a pure function decides what it means, people approve it, two interpreters execute only that.",
)

# ── Band 1: the model, within a schema ─────────────────────────────────────────
d.group(30, 90, 1240, 400, "1 · The model decides — within a schema", "violet", title_size=13)
d.box(Box("clin", 50, 140, 300, 110, "Clinician", ["“Knee flexion over the course of", "therapy, both sides, with the", "assessment form”"], kind="person", title_size=12.5))
d.box(Box("lookups", 50, 280, 300, 120, "Lookups — the hospital's facts", ["lookup_codes: terminology hints + the", "record's own vocabulary (what is on the record)", "list_record_shapes · list_groups"], desc_size=9.6))
d.box(Box("agent", 390, 140, 860, 110, "Drafting agent — Strands Agent on Amazon Bedrock (eu. inference profile)", ["system prompt generated from the catalogue: archetypes, knob names, refusals — never a manifest or a component", "fifteen typed tools are the only way to change the draft · the readiness list drives the questions it asks"], desc_size=9.6))
d.box(Box("spec", 390, 280, 860, 120, "AppSpec — the typed specification", ["apiVersion medapp.eu/v1 · kind AppSpec · archetype + its knobs · roles with identity fields · governance statement", "every tool argument validated against the Zod / JSON Schema before it is applied: the draft can be incomplete, never invalid", "recorded refusals travel with the draft"], desc_size=9.6))
d.note(50, 440, "Checked here: every argument against the knob schema · codes verified on the record · unknown shapes refused · readiness empty before compile", size=9.8, colour="#1F2933")
d.edge([(350, 195), (390, 195)], colour=VIOLET, label="sentence", label_at=(370, 182))
d.edge([(820, 250), (820, 280)], colour=VIOLET, label="tool calls", label_at=(870, 270))
d.edge([(390, 340), (350, 340)], colour=VIOLET)

# ── Band 2: the compiler ───────────────────────────────────────────────────────
d.group(30, 530, 1240, 300, "2 · Deterministic code — the compiler", "green", title_size=13)
d.box(Box("compiler", 50, 580, 590, 130, "compileSpec() — a pure TypeScript function", ["same spec + options → the same manifest, byte for byte; compiler version in provenance", "the archetype's build turns knobs into data primitives and a layout tree of catalogue components", "data scopes derived from what the primitives read and write · forms → FHIR Questionnaires", "golden fixture per archetype · runs in the panel, the Lambda and the CLI — one implementation"], desc_size=9.6))
d.box(Box("manifest", 660, 580, 590, 130, "AppManifest — the resolved artefact", ["metadata · roles → groups · data scopes (resource types, operations, codes, identity fields)", "primitives · layout · context inputs · actions · the app's Questionnaires", "provenance: compiler version, prompt hash · SHA-256 hash addresses the version", "validated by one shared Zod schema in the registry, the panel and the Lambdas"], desc_size=9.6))
d.note(50, 775, "Checked here: the spec validated again, with cross-field rules · the manifest against the shared schema", size=9.8, colour="#1F2933")
d.edge([(640, 645), (660, 645)], colour=GREEN, label="build", label_at=(650, 632))
d.edge([(820, 400), (820, 580)], colour=GREEN, label="compile", label_at=(860, 510))

# ── Band 3: people ────────────────────────────────────────────────────────────
d.group(30, 870, 1240, 300, "3 · People decide — review, approval, publication", "warm", title_size=13)
d.box(Box("review", 50, 920, 590, 130, "Review page", ["the manifest shown as facts: what is read and under which filter, which identity fields each role", "sees, which groups grant which role, what is written — and the agent's recorded refusals", "the difference against the published version, widenings first"], desc_size=9.6))
d.box(Box("lifecycle", 660, 920, 590, 130, "Governed lifecycle — the registry", ["draft → in_review → approved → published → deprecated; only published versions reach clinicians", "the author never approves their own version · approval signs the manifest hash with the", "hospital's KMS key · lifecycle events are append-only · a new version records its parent"], desc_size=9.6))
d.note(50, 1115, "Checked here: a person who is not the author reads the role bindings, scopes and writes · the signature is stored with approver, time and notes · role groups created at publish", size=9.8, colour="#1F2933")
d.edge([(640, 985), (660, 985)], colour=AMBER, label="approve · publish", label_at=(650, 972))
d.edge([(955, 710), (955, 920)], colour=AMBER, label="save as a draft version", label_at=(1040, 850))

# ── Band 4: runtime ───────────────────────────────────────────────────────────
d.group(30, 1210, 1240, 300, "4 · Deterministic code — two interpreters at runtime", "green", title_size=13)
d.box(Box("renderer", 50, 1260, 590, 130, "Renderer — in the browser", ["validates the manifest with the same schema · plans primitives in dependency waves", "manifest node → exactly one catalogue component; there is no third path", "$bindings · $context · $auth references, no expression language; identity fields masked per role"], desc_size=9.6))
d.box(Box("dispatcher", 660, 1260, 590, 130, "Dispatcher — on the server", ["loads the published version itself; role from the token's groups; primitive declared? scope grants it?", "runs the manifest's config, not the browser's; FHIR / DICOMweb with the platform's credentials", "writes validated and stamped; one audit record per call, refusals included"], desc_size=9.6))
d.note(50, 1455, "Checked here: version published · caller's groups · primitive declared · resource type and operation in scope · declared config resolved from the manifest, not the request · audit record always", size=9.8, colour="#1F2933")
d.edge([(955, 1050), (955, 1260)], colour=BLUE, label="published version", label_at=(1030, 1190))
d.edge([(640, 1325), (660, 1325)], colour=BLUE, label="one POST per primitive", label_at=(650, 1312))

legend(d, 50, 1545, [(VIOLET, "model", False), (GREEN, "pure functions, tested against golden outputs", False), (AMBER, "human sign-off", False), (BLUE, "runtime, enforced server-side", False)])

open(__file__.replace(".py", ".svg"), "w", encoding="utf-8").write(d.render())
print("wrote", __file__.replace(".py", ".svg"))
