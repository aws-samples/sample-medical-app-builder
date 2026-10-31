"""
The agent's tools — the only way the conversation changes anything. Each tool mutates the Draft
through a typed operation (rejected with the schema's reason if invalid) and answers with what is
still open, so the model always knows what to ask next without guessing.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from strands import tool

from .catalog import Catalog
from .draft import Draft, InvalidChange, Issue
from .groups import GroupDirectory, known_group
from .manifest_service import ManifestService, ManifestServiceUnavailable, summarize_manifest
from .shapes import ShapeLibrary, shape_summary, unknown_shapes


def _result(ok: bool, **fields: Any) -> str:
    return json.dumps({"ok": ok, **fields}, ensure_ascii=False, default=str)


def _open(items: list[Issue]) -> list[dict[str, str]]:
    return [i.as_dict() for i in items]


def _guard(fn):  # type: ignore[no-untyped-def]
    def run() -> str:
        try:
            return fn()
        except InvalidChange as e:
            return _result(False, rejected=[i.as_dict() for i in e.issues], hint="Nothing was changed. Fix the value or ask the user.")

    return run()


ToolObserver = Callable[[str], None]


def make_tools(draft: Draft, catalog: Catalog, service: ManifestService | None, groups: GroupDirectory, hospital_id: str, on_tool: ToolObserver | None = None, shapes: ShapeLibrary | None = None) -> list[Any]:
    """Tools bound to one draft. A new list is made per turn; the draft carries the state.
    `on_tool(name)` is called as each tool starts — the worker reports it as progress."""

    def observed(name: str) -> None:
        if on_tool is not None:
            try:
                on_tool(name)
            except Exception:  # noqa: BLE001 — progress is best effort, never the reason a turn fails
                pass

    def _require_known_questionnaire(patch: dict) -> None:
        """A `questionnaire` URL names a Questionnaire that exists on the record; the catalog lists them — for a structured
        assessment's knob and for the assessment sections of a composed page alike. A form the record lacks is designed
        instead (`form`), which the schema validates; it is never pointed at by a made-up URL."""
        unknown = catalog.unknown_questionnaires(patch)
        if unknown:
            offered = [q["url"] for q in catalog.questionnaires()]
            hint = (f" Available: {', '.join(offered)}." if offered else " No Questionnaires are on this record.") + " For a form the record lacks, design it with `form` instead of naming a URL."
            raise InvalidChange([Issue(path, f'"{url}" is not a Questionnaire on this record.' + hint) for path, url in unknown])

    def _require_known_shape(patch: dict) -> None:
        """A `shape` in a record section names a shape with a published version in the library (list_record_shapes); one
        nobody has published is refused here, as the compiler would — and the fields are declared instead."""
        unknown = unknown_shapes(patch, shapes)
        if unknown:
            offered = [a["id"] for a in (shapes.published() if shapes else [])]
            hint = (f" Published: {', '.join(offered)}." if offered else " The library has no published shape yet.") + " For a form the library lacks, declare `resource` and `fields` on the section instead."
            raise InvalidChange([Issue(path, f'"{sid}" is not a published record shape.' + hint) for path, sid in unknown])

    def _library() -> list[dict[str, Any]] | None:
        return shapes.published() if shapes is not None else None

    def _require_known_group(name: str) -> None:
        # A role bound to a group nobody is in grants access to nobody: only groups the directory lists may be named.
        if not known_group(groups, name):
            offered = [g.name for g in groups.list_groups()]
            raise InvalidChange([Issue("roles.group.name", f'"{name}" is not an existing group in this hospital\'s user pool. ' + (f"Existing groups: {', '.join(offered)}." if offered else "There are no bindable groups; omit existing_group to create one for this app at publish time."))])

    @tool
    def choose_archetype(archetype: str, reason: str) -> str:
        """Choose which kind of app to build. Call this as soon as the kind is clear; changing it later discards the knobs.

        Args:
            archetype: A buildable archetype id such as APP-02. Only ids the deployment can build are accepted.
            reason: One sentence on why this archetype fits the request.
        """
        observed("choose_archetype")

        def go() -> str:
            open_items = draft.choose_archetype(archetype, reason)
            doc = catalog.archetype(archetype)
            return _result(True, archetype=archetype, knob_schema=json.loads(catalog.knob_schema_text(archetype)), limits=list(doc.limits) if doc else [], open=_open(open_items))

        return _guard(go)

    @tool
    def set_app(app_id: str | None = None, name: str | None = None, description: str | None = None, language: str | None = None) -> str:
        """Set the app's identity: a stable id (app_<slug>, lowercase), its display name, a one-sentence description, and the display language.

        Args:
            app_id: e.g. app_hba1c_trend. Propose one from the name; the user rarely cares.
            name: What clinicians see in the launcher.
            description: One sentence shown under the name.
            language: en or de — the language of the generated display texts.
        """
        observed("set_app")
        def go() -> str:
            open_items = draft.set_app(app_id=app_id, name=name, description=description, language=language)
            return _result(True, app=draft.spec.get("app"), open=_open(open_items))

        return _guard(go)

    @tool
    def set_knobs(patch: dict) -> str:
        """Set or change the archetype's knobs (its parameters). Pass only the fields you are setting; nested objects merge; null deletes a field.

        The knob schema was returned by choose_archetype. Codes are objects {system, code, display}; use lookup_codes to find them, never invent codes.

        Args:
            patch: A partial knobs object, e.g. {"codes": [{"system": "loinc", "code": "4548-4"}], "unit": "%"}.
        """
        observed("set_knobs")
        def go() -> str:
            _require_known_questionnaire(patch)
            _require_known_shape(patch)
            open_items = draft.patch_knobs(patch)
            return _result(True, knobs=draft.spec.get("knobs"), open=_open(open_items))

        return _guard(go)

    @tool
    def add_role(id: str, display_name: str, phi_fields_visible: list[str], existing_group: str | None = None, inherits: str | None = None, capabilities: list[str] | None = None) -> str:
        """Add (or replace) a role: who may use the app and which patient identity fields they see. Everything else the role may access is derived from the app itself.

        Args:
            id: Lowercase role id such as viewer, reviewer, nurse.
            display_name: How the role is shown, e.g. "Hypertension nurse".
            phi_fields_visible: Subset of name, dob, gender, mrn, address, phone, email.
            existing_group: Bind to an existing hospital group (from list_groups). Omit to create a group for this app at publish time.
            inherits: Another role of this app whose access this role extends (e.g. reviewer inherits viewer).
            capabilities: Declarative labels like view, export_pdf. Defaults to [view].
        """
        observed("add_role")
        role: dict[str, Any] = {"id": id, "display_name": display_name, "phi_fields_visible": phi_fields_visible}
        if existing_group:
            role["group"] = {"kind": "existing", "name": existing_group}
        if inherits:
            role["inherits"] = inherits
        if capabilities:
            role["capabilities"] = capabilities

        def go() -> str:
            if existing_group:
                _require_known_group(existing_group)
            open_items = draft.add_role(role)
            return _result(True, roles=draft.spec.get("roles"), default_role=draft.spec.get("default_role"), open=_open(open_items))

        return _guard(go)

    @tool
    def update_role(id: str, patch: dict) -> str:
        """Change fields of an existing role (display_name, phi_fields_visible, inherits, capabilities, group).

        Args:
            id: The role id.
            patch: Fields to change, e.g. {"phi_fields_visible": ["name", "dob", "mrn"]}.
        """
        observed("update_role")
        def go() -> str:
            group = patch.get("group") if isinstance(patch, dict) else None
            if isinstance(group, dict) and group.get("kind") == "existing":
                _require_known_group(str(group.get("name", "")))
            open_items = draft.update_role(id, patch)
            return _result(True, roles=draft.spec.get("roles"), open=_open(open_items))

        return _guard(go)

    @tool
    def remove_role(id: str) -> str:
        """Remove a role from the app.

        Args:
            id: The role id.
        """
        observed("remove_role")
        def go() -> str:
            open_items = draft.remove_role(id)
            return _result(True, roles=draft.spec.get("roles"), default_role=draft.spec.get("default_role"), open=_open(open_items))

        return _guard(go)

    @tool
    def set_default_role(id: str) -> str:
        """Set the role that people with blanket access get — by convention the least privileged one.

        Args:
            id: The role id.
        """
        observed("set_default_role")
        def go() -> str:
            open_items = draft.set_default_role(id)
            return _result(True, default_role=id, open=_open(open_items))

        return _guard(go)

    @tool
    def set_governance(clinical_context: str | None = None, intended_users: list[str] | None = None, intended_purpose: str | None = None, mdr_classification: str | None = None) -> str:
        """Record what the app is for — the statement an approver signs.

        Args:
            clinical_context: Where it is used, as a lowercase slug, e.g. outpatient_bp_monitoring.
            intended_users: Who uses it, as slugs, e.g. ["general_practitioner", "cardiologist"].
            intended_purpose: One or two sentences: what the app shows or records, and what it must not be used for (e.g. "Not for diagnosis.").
            mdr_classification: Leave unset unless the user is a regulatory owner; defaults to none.
        """
        observed("set_governance")
        def go() -> str:
            open_items = draft.patch_governance({"clinical_context": clinical_context, "intended_users": intended_users, "intended_purpose": intended_purpose, "mdr_classification": mdr_classification})
            return _result(True, governance=draft.spec.get("governance"), open=_open(open_items))

        return _guard(go)

    @tool
    def get_draft() -> str:
        """Read the whole draft as it stands, with the list of open points."""
        observed("get_draft")
        return _result(True, **draft.summary())

    @tool
    def check_readiness() -> str:
        """Ask the compiler whether the draft is complete and consistent. Use before telling the user the app is ready."""
        observed("check_readiness")
        if service is None:
            return _result(True, ready=not draft.open_items(), missing=_open(draft.open_items()), note="local check only; the compiler service is not connected")
        try:
            r = service.readiness(draft.full_spec(), shapes=_library())
        except ManifestServiceUnavailable as e:
            return _result(False, error=str(e))
        return _result(True, ready=r.ready, missing=[{"path": i.path, "message": i.message} for i in r.missing])

    @tool
    def compile_preview() -> str:
        """Compile the draft into its manifest and return a summary (roles and their data access, primitives, layout). Use it to describe the finished app to the user before they save it."""
        observed("compile_preview")
        if service is None:
            return _result(False, error="the compiler service is not connected in this environment")
        try:
            r = service.compile(draft.full_spec(), hospital_id, shapes=_library())
        except ManifestServiceUnavailable as e:
            return _result(False, error=str(e))
        if not r.ok or r.manifest is None:
            return _result(False, issues=[{"path": i.path, "message": i.message} for i in r.issues])
        draft.events.append({"tool": "compile_preview", "args": {}, "manifest_version": r.manifest["metadata"]["version"]})
        return _result(True, summary=summarize_manifest(r.manifest))

    @tool
    def list_record_shapes() -> str:
        """List the published record shapes — reviewed forms a composed page's `record` section can write with (`shape: <id>`) instead of declaring fields by hand. Use before designing a record section for a goal, care plan, visit or note."""
        observed("list_record_shapes")
        published = shapes.published() if shapes is not None else []
        return _result(True, shapes=[shape_summary(a) for a in published], note=None if published else "no shape is published yet: declare resource and fields on the section")

    @tool
    def list_groups() -> str:
        """List the hospital's existing user groups a role can be bound to (department or function groups). Use before proposing an existing_group."""
        observed("list_groups")
        return _result(True, groups=[{"name": g.name, "description": g.description} for g in groups.list_groups()])

    @tool
    def lookup_codes(term: str) -> str:
        """Find clinical codes (LOINC, SNOMED CT, ICD-10-GM, OPS, ATC) for a concept: the catalog's terminology hints and, where the deployment has read it, the vocabulary of the hospital's own record — the codes actually present there, searchable by display text (in the record's language, often German, or English) and by code.

        Args:
            term: A concept such as "blood pressure", "HbA1c", "Hämoglobin", "hypertension", "metformin" — or a code to verify, e.g. "2276-4".
        """
        observed("lookup_codes")
        hits = catalog.lookup_codes(term)
        record = catalog.record_summary()
        if hits and record.get("available") and not any(h.record for h in hits):
            note = "These are catalog hints and none of them is on the record: the app would show no data with them here. Try the term as the record spells it (its display texts are in the hospital's language) to find the record's own code."
        elif hits:
            note = None
        elif record.get("available"):
            note = "Neither the hints nor the record match; try the term as the record spells it (its display texts are in the hospital's language) or the code itself — otherwise ask the user, do not guess."
        else:
            note = "No hint matches; ask the user for the code or the exact concept, do not guess."
        return _result(
            True,
            term=term,
            codes=[{"name": h.name, "system": h.system, "code": h.code, "unit": h.unit, "components": h.components, "origin": h.origin, "record": h.record} for h in hits],
            record_vocabulary=f"read on {str(record.get('built_at', ''))[:10]}" if record.get("available") else "not available in this deployment",
            note=note,
        )

    @tool
    def record_refusal(refusal_id: str, detail: str) -> str:
        """Record that part of the request cannot be built (it is outside the catalog). Call it when you tell the user so; the reason list is in your instructions.

        Args:
            refusal_id: The refusal id from the catalog, e.g. writes, llm, calculations.
            detail: What exactly was asked for.
        """
        observed("record_refusal")
        def go() -> str:
            draft.record_refusal(refusal_id, detail)
            return _result(True, refusals=draft.refusals)

        return _guard(go)

    return [choose_archetype, set_app, set_knobs, add_role, update_role, remove_role, set_default_role, set_governance, get_draft, check_readiness, compile_preview, list_record_shapes, list_groups, lookup_codes, record_refusal]
