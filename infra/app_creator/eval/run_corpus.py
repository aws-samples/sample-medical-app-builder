"""
Run the evaluation corpus against a real model and report which cases the agent gets right.

    cd infra && python -m app_creator.eval.run_corpus [--only bp_trend_en,cohort_en] [--model <id>] [--region <r>]

Each case's transcript and final draft are written to .eval/<case>.json for reading. Exit code 1 when a
case fails — so this can gate a prompt or catalog change.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import yaml

from ..agent import Drafter
from ..catalog import Catalog
from ..vocabulary import RecordVocabulary, vocabulary_from_env
from ..harness import default_model_id, discover_hospital_name, group_directory
from ..language import detect_language
from ..manifest_service import CliManifestService
from ..shapes import StaticShapes, bundled_shapes
from ..session import DraftSession

HERE = Path(__file__).resolve().parent


def looks_german(text_: str) -> bool:
    return detect_language(text_) == "de"


def contains(actual: Any, expected: Any) -> bool:
    """Partial structural match: dict keys must be present and match; list items must each match some actual item.

    `{ _min_items: n }` expects a list of at least n items without naming them — for values that are the model's own
    words (task kinds are free identifiers: `falls_screen` and `falls_risk_screen` are both right), where naming one
    would pin wording, not behaviour."""
    if isinstance(expected, dict):
        if set(expected) == {"_min_items"}:
            return isinstance(actual, list) and len(actual) >= int(expected["_min_items"])
        return isinstance(actual, dict) and all(k in actual and contains(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and all(any(contains(a, e) for a in actual) for e in expected)
    return actual == expected


def form_items(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Every question of the draft's designed forms (the APP-11 knob and the assessment sections of a composed page), headings
    flattened — where the agent puts a question in the form is its call; what the form asks is what a case checks. A heading's
    `show_when` reaches the questions under it: a question asked "only if yes" looks the same whether the agent conditioned the
    question or the section it sits in (several conditions become a list, as the spec writes them)."""
    forms: list[dict[str, Any]] = []
    knobs = spec.get("knobs") or {}
    if isinstance(knobs.get("form"), dict):
        forms.append(knobs["form"])
    for section in knobs.get("sections") or []:
        if isinstance(section, dict) and isinstance(section.get("form"), dict):
            forms.append(section["form"])
    out: list[dict[str, Any]] = []

    def conditions(item: dict[str, Any]) -> list[dict[str, Any]]:
        when = item.get("show_when")
        return [] if not when else list(when) if isinstance(when, list) else [when]

    def walk(items: Any, inherited: list[dict[str, Any]]) -> None:
        for item in items or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "heading":
                walk(item.get("items"), inherited + conditions(item))
                continue
            asked_when = inherited + conditions(item)
            out.append({**item, "show_when": asked_when[0] if len(asked_when) == 1 else asked_when} if asked_when else item)

    for form in forms:
        walk(form.get("items"), [])
    return out


def evaluate(case: dict[str, Any], session: DraftSession, replies: list[str], readiness_ready: bool, tool_calls: list[list[str]] | None = None) -> list[str]:
    exp = case.get("expect", {})
    failures: list[str] = []
    spec = session.spec
    if "archetype" in exp and spec.get("archetype") != exp["archetype"]:
        failures.append(f"archetype: expected {exp['archetype']}, got {spec.get('archetype')}")
    if "archetype_any" in exp and spec.get("archetype") not in exp["archetype_any"]:
        failures.append(f"archetype: expected one of {', '.join(exp['archetype_any'])}, got {spec.get('archetype')}")
    if "knobs_contain" in exp and not contains(spec.get("knobs", {}), exp["knobs_contain"]):
        failures.append(f"knobs missing expected values: {json.dumps(exp['knobs_contain'], ensure_ascii=False)} in {json.dumps(spec.get('knobs', {}), ensure_ascii=False)}")
    if "knobs_contain_any" in exp and not any(contains(spec.get("knobs", {}), alt) for alt in exp["knobs_contain_any"]):
        failures.append(f"knobs match none of the alternatives: {json.dumps(exp['knobs_contain_any'], ensure_ascii=False)} in {json.dumps(spec.get('knobs', {}), ensure_ascii=False)}")
    if "spec_contain" in exp and not contains(spec, exp["spec_contain"]):
        failures.append("spec missing expected values")
    if "knobs_exclude_text" in exp:
        # What the knobs must not spell out — a record section that names a library shape declares no fields of its own.
        blob = json.dumps(spec.get("knobs", {}), ensure_ascii=False)
        for text in exp["knobs_exclude_text"]:
            if text in blob:
                failures.append(f"knobs contain {text!r}, which the case excludes")
    if "tools_called" in exp:
        called = {name for turn in tool_calls or [] for name in turn}
        for name in exp["tools_called"]:
            if name not in called:
                failures.append(f"tool {name} was never called (called: {sorted(called)})")
    if "form_items_contain" in exp or "form_items_contain_any" in exp:
        questions = form_items(spec)
        if "form_items_contain" in exp and not contains(questions, exp["form_items_contain"]):
            failures.append(f"the designed form lacks a question like: {json.dumps(exp['form_items_contain'], ensure_ascii=False)} — it asks {json.dumps([{k: q.get(k) for k in ('id', 'type', 'required', 'unit', 'min', 'max', 'show_when', 'options') if k in q} for q in questions], ensure_ascii=False)}")
        if "form_items_contain_any" in exp and not any(contains(questions, alt) for alt in exp["form_items_contain_any"]):
            failures.append(f"the designed form matches none of: {json.dumps(exp['form_items_contain_any'], ensure_ascii=False)}")
    if "roles_min" in exp and len(spec.get("roles", [])) < exp["roles_min"]:
        failures.append(f"roles: expected at least {exp['roles_min']}, got {len(spec.get('roles', []))}")
    if "default_role" in exp and spec.get("default_role") != exp["default_role"]:
        failures.append(f"default_role: expected {exp['default_role']}, got {spec.get('default_role')}")
    if "ready" in exp and readiness_ready != exp["ready"]:
        failures.append(f"ready: expected {exp['ready']}, got {readiness_ready}")
    if "refusal" in exp and exp["refusal"] not in [r["refusal"] for r in session.refusals]:
        failures.append(f"refusal {exp['refusal']} not recorded (recorded: {[r['refusal'] for r in session.refusals]})")
    if "refusal_any" in exp and not any(r["refusal"] in exp["refusal_any"] for r in session.refusals):
        failures.append(f"none of the refusals {exp['refusal_any']} recorded (recorded: {[r['refusal'] for r in session.refusals]})")
    if exp.get("no_refusal") and session.refusals:
        # For requests that used to be refused and are now buildable: the precise check is the tool call, not the words
        # of the reply — the agent may truthfully say what the app does not do (measure, remind) while building it.
        failures.append(f"a refusal was recorded where none was expected: {[r['refusal'] for r in session.refusals]}")
    if "reply_contains_any" in exp:
        joined = " ".join(replies).lower()
        if not any(s.lower() in joined for s in exp["reply_contains_any"]):
            failures.append(f"no reply contains any of {exp['reply_contains_any']}")
    if "reply_not_matching" in exp:
        # Claims the agent must never make (it saves, deploys, publishes nothing): regular expressions, case-insensitive, any reply.
        for pattern in exp["reply_not_matching"]:
            hits = [r for r in replies if re.search(pattern, r, re.IGNORECASE)]
            if hits:
                failures.append(f"a reply matches the forbidden /{pattern}/: {hits[0][:160]!r}")
    if exp.get("reply_language") == "de" and not looks_german(replies[-1] if replies else ""):
        failures.append("last reply does not look German")
    if exp.get("reply_language") == "en" and looks_german(replies[-1] if replies else ""):
        failures.append("last reply looks German, the request was English")
    if "spec_excludes_text" in exp:
        blob = json.dumps(spec, ensure_ascii=False)
        for s in exp["spec_excludes_text"]:
            if s in blob:
                failures.append(f"spec contains patient text {s!r}")
    return failures


def turns_of(case: dict[str, Any]) -> list[str]:
    """The human side of the conversation. A turn containing ": " and left unquoted parses as a one-key mapping — say so, by case."""
    turns = case.get("turns") or []
    for i, turn in enumerate(turns):
        if not isinstance(turn, str):
            raise ValueError(f"case {case.get('id')!r}: turn {i + 1} is not text ({type(turn).__name__}) — quote it in corpus.yaml (a ': ' inside an unquoted line makes YAML read a mapping)")
    return list(turns)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="app_creator.eval.run_corpus")
    ap.add_argument("--corpus", default=str(HERE / "corpus.yaml"))
    ap.add_argument("--only", help="comma-separated case ids")
    ap.add_argument("--model", default=default_model_id(), help="Bedrock model id or inference profile (default: MEDAPP_MODEL_ID, else cdk.json's model_id)")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION"))
    ap.add_argument("--hospital", default="hsp-musterstadt")
    ap.add_argument("--out", default=".eval")
    ap.add_argument("--user-pool", default=os.environ.get("MEDAPP_USER_POOL_ID"))
    ap.add_argument("--demo-groups", action="store_true", help="offer a fake group list instead of the pool's real groups")
    args = ap.parse_args(argv)

    from strands.models import BedrockModel

    kwargs: dict[str, Any] = {}
    if args.model:
        kwargs["model_id"] = args.model
    if args.region:
        kwargs["region_name"] = args.region
    model = BedrockModel(**kwargs)

    # The synthetic record's vocabulary by default (what the corpus cases assume); MEDAPP_VOCABULARY_FILE overrides.
    vocabulary = vocabulary_from_env() if os.environ.get("MEDAPP_VOCABULARY_FILE") or os.environ.get("RECORD_VOCABULARY_BUCKET") else RecordVocabulary.from_file(Path(__file__).with_name("record-vocabulary.synthetic.json"))
    catalog = Catalog.load(vocabulary=vocabulary)
    service = CliManifestService()
    # The record-shape library the cases assume: the bundled shapes (med_app/shapes), as the registry seed publishes them.
    shapes = StaticShapes(bundled_shapes(service))
    drafter = Drafter(model, catalog, service, hospital_id=args.hospital, hospital_name=discover_hospital_name(args.hospital), groups=group_directory(args.hospital, args.user_pool, args.demo_groups), shapes=shapes)
    cases = yaml.safe_load(Path(args.corpus).read_text(encoding="utf-8"))["cases"]
    if args.only:
        wanted = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in wanted]
    out_dir = Path(args.out)
    out_dir.mkdir(exist_ok=True)

    failed = 0
    for case in cases:
        session = DraftSession.new(args.hospital, author_sub="eval")
        seed = case.get("seed")
        if seed:
            # "Iterate on this app": the draft starts from a published app's spec, with no conversation behind it — what
            # the panel does for an app the caller did not draft (the showcase apps, or someone else's).
            spec = yaml.safe_load((Path(__file__).resolve().parents[3] / "med_app" / "specs" / seed["spec"]).read_text(encoding="utf-8"))
            session.spec = {k: v for k, v in spec.items() if k not in ("apiVersion", "kind")}
            session.iterates = {"app_id": session.spec["app"]["app_id"], "version": str(session.spec["app"].get("version", ""))}
        replies: list[str] = []
        tool_calls: list[list[str]] = []
        for turn in turns_of(case):
            result = drafter.turn(session, turn)
            replies.append(result.reply)
            tool_calls.append(result.tool_calls)
        ready = service.readiness({"apiVersion": "medapp.eu/v1", "kind": "AppSpec", **session.spec}, shapes=shapes.published()).ready if session.spec.get("archetype") else False
        failures = evaluate(case, session, replies, ready, tool_calls)
        (out_dir / f"{case['id']}.json").write_text(
            json.dumps({"case": case, "replies": replies, "tool_calls": tool_calls, "spec": session.spec, "refusals": session.refusals, "ready": ready, "failures": failures}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        status = "PASS" if not failures else "FAIL"
        failed += bool(failures)
        print(f"{status}  {case['id']:<24} tools={sum(len(t) for t in tool_calls):<3} ready={ready}")
        for f in failures:
            print(f"      - {f}")
    print(f"\n{len(cases) - failed}/{len(cases)} passed; transcripts in {out_dir}/", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
