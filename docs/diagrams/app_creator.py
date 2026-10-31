"""MedApp — app_creator: the drafting agent and the authoring plumbing around it."""

from svgdiagram import GREEN, LINE, Box, Diagram, legend

d = Diagram(
    1800,
    850,
    "MedApp — app_creator (the drafting agent)",
    "A clinician's sentences become a typed AppSpec through tools; the platform's compiler turns the spec into the app. The model never writes code, a layout or a data scope.",
)

# ── Panel ───────────────────────────────────────────────────────────────────────
d.group(30, 110, 260, 300, "Panel — drafting page", "green")
d.box(Box("ui", 50, 150, 220, 110, "Conversation + editors", ["the author writes; the assistant asks", "only about what is still open", "the panel polls the turn's progress"]))
d.box(Box("save", 50, 290, 220, 90, "Save and lifecycle", ["Save to registry · Submit for review", "approve · publish (an approver,", "never the author)"]))

# ── API + tables ────────────────────────────────────────────────────────────────
d.group(330, 110, 340, 300, "ApiStack — API Gateway + JWT authorizer", "white", title_size=11)
d.box(Box("draftsapi", 350, 150, 270, 110, "Drafts API (Lambda)", ["POST /drafts · POST turns (202, async)", "PATCH typed edits — same rules as the tools", "GET /groups · DELETE · author-only"]))
d.box(Box("regwrite", 350, 290, 270, 90, "Registry write + lifecycle (Lambda)", ["saves app or version: spec + manifest", "transitions with the four-eyes rule", "KMS-signed approval · role groups at publish"]))

d.group(330, 440, 340, 140, "Tables", "white", title_size=11, sub="RegistryStack · AuthoringStack")
d.box(Box("regtbl", 345, 485, 150, 80, "App registry", ["DynamoDB", "versions keep their spec", "→ iterate from it later"], kind="store", fill="#E8F1EE", stroke=GREEN))
d.box(Box("draftstbl", 505, 485, 150, 80, "Drafts table", ["DynamoDB · TTL 30 days", "session, spec, turn status", "private to the author"], kind="store", fill="#E8F1EE", stroke=GREEN))

# ── Agent ───────────────────────────────────────────────────────────────────────
d.group(700, 110, 620, 480, "Drafting agent — Lambda, asynchronous turn worker (AuthoringStack)", "warm")
d.box(Box("drafter", 720, 150, 580, 60, "Drafter.turn(session, text)", ["one exchange, runtime-agnostic: the Lambda, AgentCore or the terminal harness call exactly this"]))
d.box(Box("prompt", 720, 240, 280, 90, "System prompt", ["generated from the catalog — it cannot", "describe an app the renderer cannot build", "author's language decided per turn (EN / DE)"]))
d.box(Box("strands", 1020, 240, 280, 90, "Strands Agent on Bedrock", ["conversation kept in the session", "each tool call is reported as progress", "replies in the author's language"]))
d.box(Box("draft", 720, 360, 280, 110, "Draft", ["partial AppSpec + events + refusals", "validated against the published JSON Schema", "missing field = still open", "wrong value = rejected, nothing changes"]))
d.box(Box("tools", 1020, 360, 280, 110, "Tools — the model's only way to change anything", ["choose_archetype · set_app · set_knobs", "add / update / remove_role · set_default_role · set_governance", "get_draft · check_readiness · compile_preview", "lookup_codes · list_record_shapes · list_groups · record_refusal"]))
d.box(Box("catalog", 720, 500, 580, 70, "Catalog", ["application-catalog.yaml + app-spec.schema.json: buildable archetypes and their knobs, refusals with reasons,", "terminology hints, questionnaires on the record — the same files the frontend publishes"]))

# ── Services ────────────────────────────────────────────────────────────────────
d.group(1370, 110, 400, 320, "Services", "grey")
d.box(Box("bedrock", 1390, 150, 360, 60, "Amazon Bedrock", ["Claude · model id from cdk.json"]))
d.box(Box("manifestsvc", 1390, 240, 360, 70, "Manifest service (Node Lambda)", ["readiness · compile · validate —", "the panel's own compiler, nothing reimplemented"]))
d.box(Box("groups", 1390, 340, 360, 60, "Cognito user pool", ["bindable hospital groups — never platform or app groups"]))

# ── Developer loop ──────────────────────────────────────────────────────────────
d.group(30, 640, 1740, 140, "Developer loop — the same Drafter, no deployment needed", "violet")
d.box(Box("harness", 50, 680, 400, 80, "Terminal harness", ["chat against Bedrock from a laptop", "/spec · /open · /compile · /save"]))
d.box(Box("corpus", 480, 680, 520, 80, "Evaluation corpus", ["48 scripted conversations (EN / DE, refusals, pasted patient data, composed pages, the physio test set)", "with expectations on the resulting draft — run against the real model"]))
d.box(Box("scripted", 1030, 680, 340, 80, "ScriptedModel", ["a Strands model that answers from a script:", "the whole loop in unit tests, without Bedrock"]))
d.box(Box("cli", 1400, 680, 350, 80, "CLI manifest service", ["runs the compiler in the med_app checkout", "(~0.1 s) — the local twin of the Lambda"]))

# ── Edges ───────────────────────────────────────────────────────────────────────
d.edge([(270, 205), (350, 205)], colour=GREEN, label="turns · edits", label_at=(310, 199))
d.edge([(270, 335), (350, 335)], colour=GREEN, label="save · transitions", label_at=(310, 329))
d.edge([(620, 190), (690, 190), (690, 180), (720, 180)], colour=GREEN, label="turn: async invoke", label_at=(660, 160))
d.edge([(620, 230), (690, 230), (690, 415), (720, 415)], colour=GREEN, label="PATCH: the same operations", label_at=(690, 330))
d.edge([(620, 250), (650, 250), (650, 465), (580, 465), (580, 485)], colour=GREEN, label="create · poll · save edits", label_at=(650, 430))
d.edge([(420, 380), (420, 485)], colour=GREEN, label="versions · events", label_at=(420, 440))
d.edge([(760, 590), (760, 604), (580, 604), (580, 565)], colour=LINE, label="turn progress · result", label_at=(670, 618))

d.edge([(860, 210), (860, 240)], colour=LINE, label="built per turn", label_at=(910, 230))
d.edge([(1160, 210), (1160, 240)], colour=LINE)
d.edge([(1160, 330), (1160, 360)], colour=LINE, label="tool calls", label_at=(1195, 350))
d.edge([(1020, 415), (1000, 415)], colour=LINE, label="typed operations", label_at=(1010, 430))
d.edge([(1100, 470), (1100, 500)], colour=LINE, label="knob docs · refusals · codes", label_at=(1180, 491))
d.edge([(860, 470), (860, 500)], colour=LINE, label="JSON Schema, one variant per archetype", label_at=(875, 491))
d.edge([(1300, 285), (1332, 285), (1332, 180), (1390, 180)], colour=LINE, label="model", label_at=(1360, 176))
d.edge([(1300, 385), (1340, 385), (1340, 275), (1390, 275)], colour=LINE, label="readiness · compile", label_at=(1340, 322))
d.edge([(1300, 445), (1348, 445), (1348, 370), (1390, 370)], colour=LINE, label="list_groups", label_at=(1348, 465))

legend(d, 30, 820, [(GREEN, "authoring flow — panel → API → agent → tables", False), (LINE, "inside the agent, and its services", False)])
d.note(700, 820, "Guard-rails are in code, not prose: buildable archetypes come from the schema, codes and groups from lookups, the language from a detector — anything the model must get right every time is decided outside the model.", 9.8)

open(__file__.replace("app_creator.py", "app-creator.svg"), "w", encoding="utf-8").write(d.render())
print("wrote app-creator.svg")
