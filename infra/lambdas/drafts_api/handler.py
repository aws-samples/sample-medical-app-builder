"""
Drafts API — drafting sessions for the app builder (authors and admins; each draft only for its author).

    POST  /drafts                      { message?, spec?, iterates?, from_session? } → 201 { session_id, turn? }
                                       open a draft; `spec` seeds it (iterating on an app); `from_session` (one of the caller's
                                       saved drafts) continues that conversation — messages, spec, refusals — in the new draft
    GET   /drafts                                              → 200 { drafts: [ summary… ] }  the caller's drafts
    GET   /groups                                              → 200 { groups: [ {name, description} ] }  bindable hospital groups for the role editor, newest first
    GET   /drafts/{id}                                         → 200 { session_id, spec, open, refusals, transcript, turn, saved_as, … }
    DELETE /drafts/{id}                                        → 204                            remove a conversation for good; 409 once saved or while a turn runs
    PATCH /drafts/{id}                 { ops: [ {op, args} ] } → 200 { spec, open } | 422 { rejected }   the panel's structured editor
    POST  /drafts/{id}/turns           { message }             → 202 { turn }                  the chat; the agent runs asynchronously

A turn is asynchronous: the API records `turn = queued`, invokes the agent worker and returns; the
panel polls GET /drafts/{id} and watches `turn.status` go running → done (with `turn.reply`) or
failed, and `turn.progress` name the tools as they run. Chat turns and PATCH operations change the
same draft through the same validated operations (`app_creator.draft.Draft`), so nothing enters a
draft from the form that the conversation could not have produced, and vice versa.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable

from app_creator.catalog import Catalog
from app_creator.draft import Draft, InvalidChange, Issue
from app_creator.dynamo_store import DynamoSessionStore
from app_creator.groups import CognitoGroups, GroupDirectory, StaticGroups, known_group
from app_creator.shapes import RegistryShapes, ShapeLibrary, unknown_shapes
from app_creator.session import DraftSession, now_iso
from medapp_shared.http_auth import Caller, caller_from_event, json_body, response

MAX_MESSAGE_CHARS = 4000

# PATCH operations → Draft methods and the arguments they take.
OPS: dict[str, tuple[str, tuple[str, ...]]] = {
    "choose_archetype": ("choose_archetype", ("archetype", "reason")),
    "set_app": ("set_app", ()),  # args are the fields
    "set_knobs": ("patch_knobs", ("patch",)),
    "add_role": ("add_role", ("role",)),
    "update_role": ("update_role", ("id", "patch")),
    "remove_role": ("remove_role", ("id",)),
    "set_default_role": ("set_default_role", ("id",)),
    "set_governance": ("patch_governance", ("patch",)),
}


def frozen(s: DraftSession) -> bool:
    """
    A saved conversation stays editable while its version is a `draft` — the author revises the version in place — and
    freezes when the version is submitted (the registry writer stamps `saved_as.state`). A saved conversation without a
    state is one from before that stamp existed: treated as frozen, the safe reading.
    """
    return bool(s.saved_as) and str((s.saved_as or {}).get("state") or "") != "draft"


class DraftsApi:
    def __init__(self, store: DynamoSessionStore, catalog: Catalog, groups: GroupDirectory, invoke_worker: Callable[[str, str], None], hospital_id: str, shapes: ShapeLibrary | None = None):
        self._store = store
        self._catalog = catalog
        self._groups = groups
        self._shapes = shapes
        self._invoke = invoke_worker
        self._hospital = hospital_id

    # ── views ──────────────────────────────────────────────────────────────

    def _view(self, s: DraftSession) -> dict[str, Any]:
        draft = Draft(self._catalog, spec=s.spec, events=s.events, refusals=s.refusals)
        return {
            "session_id": s.session_id,
            "title": s.title,
            "spec": draft.full_spec(),
            "open": [i.as_dict() for i in draft.open_items()],
            "refusals": s.refusals,
            "transcript": s.transcript(),
            "turn": s.presented_turn(),
            "saved_as": s.saved_as,
            "iterates": s.iterates,
            "created_at": s.created_at,
            "updated_at": s.updated_at,
        }

    def _load_for(self, caller: Caller, session_id: str) -> DraftSession | None:
        # A conversation is its author's working material — nobody else, admins included, reads or
        # changes it. Oversight starts once it is saved to the registry. Same 404 either way: no oracle.
        s = self._store.load(session_id)
        if s is None or s.author_sub != caller.sub:
            return None
        return s

    # ── operations ─────────────────────────────────────────────────────────

    def create(self, caller: Caller, body: dict[str, Any]) -> dict[str, Any]:
        s = DraftSession.new(self._hospital, author_sub=caller.sub)
        source_id = str(body.get("from_session") or "")
        if source_id:
            # Iterating on an app the caller drafted: the new draft continues the conversation that produced it, so the
            # author picks up where they left off and the agent keeps its context. A saved draft never changes (it is
            # the provenance of its version); the copy does. Only the author's own drafts can be continued — the same
            # rule as reading them — so an admin iterating on someone else's app starts from the spec alone.
            source = self._load_for(caller, source_id)
            if source is None:
                return response(404, {"message": "No such draft to continue."})
            if source.turn_busy:
                return response(409, {"message": "The agent is still working on that draft; continue it when it is done.", "turn": source.turn})
            copied = json.loads(json.dumps({"spec": source.spec, "events": source.events, "refusals": source.refusals, "messages": source.messages}))
            s.spec, s.events, s.refusals, s.messages = copied["spec"], copied["events"], copied["refusals"], copied["messages"]
            s.language = source.language
            iterates = body.get("iterates")
            if isinstance(iterates, dict) and iterates.get("app_id"):
                s.iterates = {"app_id": str(iterates["app_id"]), "version": str(iterates.get("version", ""))}
            elif source.saved_as:
                s.iterates = {"app_id": str(source.saved_as.get("app_id", "")), "version": str(source.saved_as.get("version", ""))}
            s.events.append({"at": now_iso(), "tool": "continue_from", "args": {"session_id": source.session_id, "iterates": s.iterates, "by": caller.sub}})
        seed = body.get("spec")
        if seed is not None and not source_id:
            # Iterating on an app: start from its stored spec. It goes through the same validation as any
            # edit; a spec the schema rejects cannot become a draft.
            if not isinstance(seed, dict):
                return response(400, {"message": "spec must be an object."})
            candidate = {k: v for k, v in seed.items() if k not in ("apiVersion", "kind")}
            probe = Draft(self._catalog, spec=candidate)
            invalid = probe.invalid_items()
            if invalid:
                return response(422, {"rejected": [i.as_dict() for i in invalid]})
            s.spec = candidate
            iterates = body.get("iterates")
            if isinstance(iterates, dict) and iterates.get("app_id"):
                s.iterates = {"app_id": str(iterates["app_id"]), "version": str(iterates.get("version", ""))}
            s.events.append({"at": now_iso(), "tool": "seed_spec", "args": {"iterates": s.iterates, "by": caller.sub}})
        message = str(body.get("message") or "").strip()
        if message:
            if len(message) > MAX_MESSAGE_CHARS:
                return response(400, {"message": f"Message longer than {MAX_MESSAGE_CHARS} characters."})
            turn = s.begin_turn(message)
            self._store.save(s)
            self._invoke(s.session_id, turn["id"])
            return response(201, {"session_id": s.session_id, "turn": turn})
        self._store.save(s)
        return response(201, {"session_id": s.session_id, "turn": None})

    def list(self, caller: Caller) -> dict[str, Any]:
        return response(200, {"drafts": self._store.list_for_author(caller.sub)})

    def groups(self) -> dict[str, Any]:
        """The hospital groups a role may be bound to — the same list the agent's list_groups tool sees."""
        return response(200, {"groups": [{"name": g.name, "description": g.description} for g in self._groups.list_groups()]})

    def get(self, caller: Caller, session_id: str) -> dict[str, Any]:
        s = self._load_for(caller, session_id)
        if s is None:
            return response(404, {"message": "No such draft."})
        return response(200, self._view(s))

    def delete(self, caller: Caller, session_id: str) -> dict[str, Any]:
        s = self._load_for(caller, session_id)
        if s is None:
            return response(404, {"message": "No such draft."})
        if s.turn_busy:
            return response(409, {"message": "The agent is still working on this draft; delete it when it is done.", "turn": s.turn})
        if s.saved_as:
            # The conversation is the provenance of a registry version now; the registry's lifecycle (deprecate) is the way out.
            return response(409, {"message": "This draft has been saved to the registry and is kept as that version's record.", "saved_as": s.saved_as})
        self._store.delete(session_id)
        return {"statusCode": 204, "headers": {"cache-control": "no-store"}, "body": ""}

    def turn(self, caller: Caller, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        s = self._load_for(caller, session_id)
        if s is None:
            return response(404, {"message": "No such draft."})
        message = str(body.get("message") or "").strip()
        if not message:
            return response(400, {"message": "message is required."})
        if len(message) > MAX_MESSAGE_CHARS:
            return response(400, {"message": f"Message longer than {MAX_MESSAGE_CHARS} characters."})
        if s.turn_busy:
            return response(409, {"message": "The agent is still working on the previous message.", "turn": s.turn})
        if frozen(s):
            return response(409, {"message": "This version has been submitted for review; iterate on the app to change it.", "saved_as": s.saved_as})
        turn = s.begin_turn(message)
        self._store.save(s)
        self._invoke(s.session_id, turn["id"])
        return response(202, {"turn": turn})

    def patch(self, caller: Caller, session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        s = self._load_for(caller, session_id)
        if s is None:
            return response(404, {"message": "No such draft."})
        if s.turn_busy:
            return response(409, {"message": "The agent is still working on the previous message; edit when it is done.", "turn": s.turn})
        if frozen(s):
            return response(409, {"message": "This version has been submitted for review; iterate on the app to change it.", "saved_as": s.saved_as})
        ops = body.get("ops")
        if not isinstance(ops, list) or not ops:
            return response(400, {"message": "ops must be a non-empty list of {op, args}."})

        draft = Draft(self._catalog, spec=json.loads(json.dumps(s.spec)), events=list(s.events), refusals=list(s.refusals))
        try:
            for i, op in enumerate(ops):
                if not isinstance(op, dict) or op.get("op") not in OPS:
                    return response(400, {"message": f"ops[{i}]: unknown op {op.get('op') if isinstance(op, dict) else op!r}; known: {', '.join(OPS)}"})
                method, arg_names = OPS[str(op["op"])]
                args = op.get("args") if isinstance(op.get("args"), dict) else {}
                self._check_groups(op, args)
                self._check_questionnaire(op, args)
                self._check_shape(op, args)
                fn = getattr(draft, method)
                if method == "set_app":
                    fn(**args)
                else:
                    fn(*[args.get(a) for a in arg_names])
        except InvalidChange as e:
            return response(422, {"rejected": [i.as_dict() for i in e.issues]})
        except TypeError as e:
            return response(400, {"message": f"bad arguments: {e}"})

        # All operations applied atomically: the session only changes if every op was accepted.
        s.spec, s.events, s.refusals = draft.spec, draft.events, draft.refusals
        s.events.append({"at": now_iso(), "tool": "panel_edit", "args": {"ops": [o.get("op") for o in ops], "by": caller.sub}})
        self._store.save(s)
        return response(200, {"spec": draft.full_spec(), "open": [i.as_dict() for i in draft.open_items()]})

    def _check_questionnaire(self, op: dict[str, Any], args: dict[str, Any]) -> None:
        """Same rule as the agent's set_knobs: a form renders a Questionnaire that exists on the record — the knob of a
        structured assessment or an assessment section of a composed page."""
        if op.get("op") != "set_knobs" or not isinstance(args.get("patch"), dict):
            return
        unknown = self._catalog.unknown_questionnaires(args["patch"])
        if unknown:
            offered = [q["url"] for q in self._catalog.questionnaires()]
            hint = f" Available: {', '.join(offered)}." if offered else ""
            raise InvalidChange([Issue(path, f'"{url}" is not a Questionnaire on this record.' + hint) for path, url in unknown])

    def _check_shape(self, op: dict[str, Any], args: dict[str, Any]) -> None:
        """Same rule as the agent's set_knobs: a record section's `shape` names a shape with a published version."""
        if op.get("op") != "set_knobs" or not isinstance(args.get("patch"), dict):
            return
        unknown = unknown_shapes(args["patch"], self._shapes)
        if unknown:
            offered = [a["id"] for a in (self._shapes.published() if self._shapes else [])]
            hint = f" Published: {', '.join(offered)}." if offered else " The library has no published shape yet."
            raise InvalidChange([Issue(path, f'"{sid}" is not a published record shape.' + hint) for path, sid in unknown])

    def _check_groups(self, op: dict[str, Any], args: dict[str, Any]) -> None:
        """Same rule as the agent's tools: an existing group must exist in the pool."""
        group = None
        if op.get("op") == "add_role":
            group = (args.get("role") or {}).get("group") if isinstance(args.get("role"), dict) else None
        elif op.get("op") == "update_role":
            group = (args.get("patch") or {}).get("group") if isinstance(args.get("patch"), dict) else None
        if isinstance(group, dict) and group.get("kind") == "existing":
            name = str(group.get("name", ""))
            if not known_group(self._groups, name):
                offered = [g.name for g in self._groups.list_groups()]
                raise InvalidChange([Issue("roles.group.name", f'"{name}" is not an existing group in this hospital\'s user pool.' + (f" Existing groups: {', '.join(offered)}." if offered else ""))])


# ── Lambda wiring ──────────────────────────────────────────────────────────────

_api: DraftsApi | None = None


def _get_api() -> DraftsApi:
    global _api
    if _api is None:
        import boto3  # local import keeps unit tests free of the SDK

        table = boto3.resource("dynamodb").Table(os.environ["DRAFTS_TABLE"])
        lambda_client = boto3.client("lambda")
        worker = os.environ["AGENT_FUNCTION_NAME"]

        def invoke(session_id: str, turn_id: str) -> None:
            lambda_client.invoke(FunctionName=worker, InvocationType="Event", Payload=json.dumps({"session_id": session_id, "turn_id": turn_id}).encode("utf-8"))

        pool = os.environ.get("USER_POOL_ID")
        registry = os.environ.get("REGISTRY_TABLE_NAME")
        _api = DraftsApi(DynamoSessionStore(table), Catalog.load(), CognitoGroups(pool) if pool else StaticGroups([]), invoke, os.environ["HOSPITAL_ID"], shapes=RegistryShapes(registry) if registry else None)
    return _api


def handle(event: dict[str, Any], api: DraftsApi) -> dict[str, Any]:
    caller = caller_from_event(event)
    if not caller.sub:
        return response(401, {"message": "No authenticated caller."})
    if not caller.may_author:
        return response(403, {"message": "Drafting apps is for authors and admins (medapp-authors / medapp-admins)."})

    route = event.get("routeKey", "")
    params = event.get("pathParameters") or {}
    try:
        body = json_body(event) if route.startswith(("POST", "PATCH")) else {}
    except (ValueError, json.JSONDecodeError):
        return response(400, {"message": "Body must be a JSON object."})

    if route == "POST /drafts":
        return api.create(caller, body)
    if route == "GET /drafts":
        return api.list(caller)
    if route == "GET /groups":
        return api.groups()
    if route == "GET /drafts/{id}":
        return api.get(caller, params.get("id", ""))
    if route == "PATCH /drafts/{id}":
        return api.patch(caller, params.get("id", ""), body)
    if route == "DELETE /drafts/{id}":
        return api.delete(caller, params.get("id", ""))
    if route == "POST /drafts/{id}/turns":
        return api.turn(caller, params.get("id", ""), body)
    return response(404, {"message": f"Unknown route {route}"})


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(event, _get_api())
