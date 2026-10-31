"""
Structural validation of a QuestionnaireResponse against its Questionnaire — the check that decides
whether a form submission may be written to the record.

Mirror of med_app/src/primitives/data/questionnaire.ts (same rules, same messages): the browser
uses its copy to explain problems before a request leaves; this one is the verdict that counts.
Rules: every answered linkId exists · every required item is answered · non-repeating items carry one
answer · answer value types match item types · coded choice answers are among the offered options (system
and code, when the option is coded) · numbers stay within the item's minValue/maxValue · an item whose
`enableWhen` is not met — or whose group's is not — is neither required nor answered · group/display items
carry no answers · the response names this questionnaire (if it names one).
"""

from __future__ import annotations

from typing import Any

Item = dict[str, Any]

VALUE_KEYS: dict[str, tuple[str, ...]] = {
    "boolean": ("valueBoolean",),
    "decimal": ("valueDecimal",),
    "integer": ("valueInteger",),
    "date": ("valueDate",),
    "dateTime": ("valueDateTime",),
    "time": ("valueTime",),
    "string": ("valueString",),
    "text": ("valueString",),
    "url": ("valueUri",),
    "choice": ("valueCoding", "valueString"),
    "open-choice": ("valueCoding", "valueString"),
    "attachment": ("valueAttachment",),
    "reference": ("valueReference",),
    "quantity": ("valueQuantity",),
}


def flatten_items(items: list[Item] | None, acc: dict[str, Item] | None = None) -> dict[str, Item]:
    acc = {} if acc is None else acc
    for item in items or []:
        acc[item["linkId"]] = item
        if item.get("item"):
            flatten_items(item["item"], acc)
    return acc


def _flatten_answers(items: list[Item] | None, acc: dict[str, list[Item]] | None = None) -> dict[str, list[Item]]:
    acc = {} if acc is None else acc
    for item in items or []:
        acc.setdefault(item.get("linkId", ""), []).extend(item.get("answer") or [])
        if item.get("item"):
            _flatten_answers(item["item"], acc)
        for a in item.get("answer") or []:
            if a.get("item"):
                _flatten_answers(a["item"], acc)
    return acc


def _answer_value_key(answer: Item) -> str | None:
    return next((k for k, v in answer.items() if k.startswith("value") and v is not None), None)


MIN_VALUE = "http://hl7.org/fhir/StructureDefinition/minValue"
MAX_VALUE = "http://hl7.org/fhir/StructureDefinition/maxValue"


def _parents(items: list[Item] | None, parent: str | None, acc: dict[str, str | None] | None = None) -> dict[str, str | None]:
    acc = {} if acc is None else acc
    for item in items or []:
        acc[item["linkId"]] = parent
        if item.get("item"):
            _parents(item["item"], item["linkId"], acc)
    return acc


def _bound(item: Item, url: str) -> float | None:
    ext = next((e for e in item.get("extension") or [] if e.get("url") == url), None)
    if not ext:
        return None
    value = ext.get("valueInteger", ext.get("valueDecimal"))
    return float(value) if value is not None else None


def _comparable(answer: Item) -> Any:
    """The comparable value of an answer: a coding by its code, everything else as is."""
    if answer.get("valueCoding"):
        return answer["valueCoding"].get("code")
    for key in ("valueBoolean", "valueInteger", "valueDecimal", "valueString", "valueDate", "valueDateTime", "valueTime"):
        if answer.get(key) is not None:
            return answer[key]
    return None


def condition_met(when: Item, given: list[Item]) -> bool:
    """
    One `enableWhen` against the answers to the question it looks at — as the form component evaluates it: `exists`
    is about whether any answer is there; the other operators hold when any given answer satisfies them, never when none is given.
    """
    present = [a for a in given if _answer_value_key(a)]
    op = when.get("operator")
    if op == "exists":
        return (len(present) > 0) == bool(when.get("answerBoolean", True))
    if not present:
        return False
    coding = when.get("answerCoding")
    expected = coding.get("code") if coding else next((when[k] for k in ("answerBoolean", "answerInteger", "answerDecimal", "answerString", "answerDate", "answerDateTime", "answerTime") if when.get(k) is not None), None)
    for a in present:
        if coding and a.get("valueCoding") and coding.get("system") and a["valueCoding"].get("system") and coding["system"] != a["valueCoding"]["system"]:
            continue
        actual = _comparable(a)
        if op == "=" and actual == expected:
            return True
        if op == "!=" and actual != expected:
            return True
        if op in (">", "<", ">=", "<=") and _kind(actual) is not None and _kind(actual) == _kind(expected):
            if (op == ">" and actual > expected) or (op == "<" and actual < expected) or (op == ">=" and actual >= expected) or (op == "<=" and actual <= expected):
                return True
    return False


def _kind(value: Any) -> str | None:
    """What an ordered comparison may compare: numbers with numbers, dates (strings) with dates; booleans and codings with neither."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "text"
    return None


def item_enabled(link_id: str, items: dict[str, Item], parents: dict[str, str | None], answers: dict[str, list[Item]]) -> bool:
    """Whether an item is asked at all: its own conditions hold (all, or any — `enableBehavior`) and so do its group's."""
    item = items.get(link_id)
    if not item:
        return False
    parent = parents.get(link_id)
    if parent and not item_enabled(parent, items, parents, answers):
        return False
    conditions = item.get("enableWhen") or []
    if not conditions:
        return True
    results = [condition_met(w, answers.get(w.get("question", ""), [])) for w in conditions]
    return all(results) if item.get("enableBehavior") == "all" else any(results)


def _label(item: Item, link_id: str) -> str:
    """How a problem names an item: the question as the clinician reads it, the linkId when the item has no text."""
    text = item.get("text")
    return text.strip() if isinstance(text, str) and text.strip() else link_id


def validate_questionnaire_response(questionnaire: Item, response: Item) -> list[str]:
    problems: list[str] = []
    if response.get("resourceType") != "QuestionnaireResponse":
        return ["response is not a QuestionnaireResponse"]
    if response.get("questionnaire") and questionnaire.get("url") and response["questionnaire"] != questionnaire["url"]:
        problems.append(f"response answers {response['questionnaire']}, not {questionnaire['url']}")

    items = flatten_items(questionnaire.get("item"))
    parents = _parents(questionnaire.get("item"), None)
    answers = _flatten_answers(response.get("item"))

    for link_id in answers:
        if link_id not in items:
            problems.append(f'unknown item "{link_id}"')

    for link_id, item in items.items():
        given = [a for a in answers.get(link_id, []) if _answer_value_key(a)]
        name = _label(item, link_id)
        item_type = item.get("type") or ""
        if item_type in ("group", "display"):
            if given:
                problems.append(f'"{name}" is a {item_type} and cannot carry answers')
            continue
        if not item_enabled(link_id, items, parents, answers):
            # Not asked this time: its condition (or its group's) is not met — so not required, and an answer to it is a mistake.
            if given:
                problems.append(f'"{name}" is not asked (its condition is not met) and cannot carry answers')
            continue
        if item.get("required") and not given:
            problems.append(f'"{name}" is required')
        if not item.get("repeats") and len(given) > 1:
            problems.append(f'"{name}" allows one answer, got {len(given)}')
        allowed = VALUE_KEYS.get(item_type, ())
        lo, hi = _bound(item, MIN_VALUE), _bound(item, MAX_VALUE)
        for a in given:
            key = _answer_value_key(a) or ""
            if allowed and key not in allowed:
                problems.append(f'"{name}" expects {"/".join(allowed)} not {key}')
            if key == "valueCoding" and item.get("answerOption"):
                offered = [o["valueCoding"] for o in item["answerOption"] if (o.get("valueCoding") or {}).get("code")]
                coding = a.get("valueCoding") or {}
                code, system = coding.get("code"), coding.get("system")
                match = any(o["code"] == code and (not o.get("system") or not system or o["system"] == system) for o in offered)
                if not match:
                    problems.append(f'"{name}": {f"{system}|" if system else ""}{code or "(no code)"} is not one of the offered options')
            if key in ("valueInteger", "valueDecimal"):
                n = a[key]
                if isinstance(n, (int, float)) and not isinstance(n, bool):
                    if lo is not None and n < lo:
                        problems.append(f'"{name}": {_num(n)} is below the minimum {_num(lo)}')
                    if hi is not None and n > hi:
                        problems.append(f'"{name}": {_num(n)} is above the maximum {_num(hi)}')
    return problems


def _num(value: float) -> str:
    """Numbers as the TypeScript side prints them: 20, not 20.0."""
    return str(int(value)) if float(value).is_integer() else str(value)


def extract_answers(rules: list[Any] | None, response: Item) -> list[dict[str, Any]]:
    """
    The answers a submission also records as Observations — the manifest's `extract` rules ({link_id, code, display?, unit?})
    matched against the response: only a numeric answer (integer or decimal) is a measurement; an unanswered or hidden item
    yields nothing. Mirror of questionnaire.ts::extractAnswers.
    """
    if not rules:
        return []
    answers = _flatten_answers(response.get("item"))
    out: list[dict[str, Any]] = []
    for rule in rules:
        if not isinstance(rule, dict) or not rule.get("link_id") or not rule.get("code"):
            continue
        first = (answers.get(str(rule["link_id"])) or [None])[0]
        if not isinstance(first, dict):
            continue
        value = first.get("valueDecimal", first.get("valueInteger"))
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out.append({**{k: rule[k] for k in ("link_id", "code", "display", "unit") if rule.get(k) is not None}, "value": value})
    return out


__all__ = ["validate_questionnaire_response", "flatten_items", "condition_met", "item_enabled", "extract_answers", "VALUE_KEYS"]
