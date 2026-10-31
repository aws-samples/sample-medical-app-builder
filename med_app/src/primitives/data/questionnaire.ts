import type { Questionnaire, QuestionnaireItem, QuestionnaireItemEnableWhen, QuestionnaireResponse, QuestionnaireResponseItem, QuestionnaireResponseItemAnswer } from '@medplum/fhirtypes';

/**
 * Structural validation of a QuestionnaireResponse against its Questionnaire — the check that
 * matters for form submissions: every answered linkId exists, every required item is answered,
 * answer value types match item types, non-repeating items carry one answer, choice answers are
 * among the offered options (system and code, when the option is coded), numbers stay within the
 * item's minValue/maxValue, and an item whose `enableWhen` is not met — or whose group's is not — is
 * neither required nor answered. Mirrored by infra/lambdas/dispatcher/questionnaire.py; the
 * dispatcher's verdict is the one that counts, this one explains problems before a request leaves the browser.
 */
export function flattenItems(items: QuestionnaireItem[] | undefined, acc = new Map<string, QuestionnaireItem>()): Map<string, QuestionnaireItem> {
  for (const item of items ?? []) {
    acc.set(item.linkId, item);
    if (item.item) flattenItems(item.item, acc);
  }
  return acc;
}

function parentsOf(items: QuestionnaireItem[] | undefined, parent: string | undefined, acc = new Map<string, string | undefined>()): Map<string, string | undefined> {
  for (const item of items ?? []) {
    acc.set(item.linkId, parent);
    if (item.item) parentsOf(item.item, item.linkId, acc);
  }
  return acc;
}

const MIN_VALUE = 'http://hl7.org/fhir/StructureDefinition/minValue';
const MAX_VALUE = 'http://hl7.org/fhir/StructureDefinition/maxValue';

function bound(item: QuestionnaireItem, url: string): number | undefined {
  const ext = item.extension?.find((e) => e.url === url);
  return ext?.valueInteger ?? ext?.valueDecimal;
}

/** The comparable value of an answer: a coding as `system|code` (or `code`), everything else as is. */
function comparable(a: QuestionnaireResponseItemAnswer): unknown {
  if (a.valueCoding) return a.valueCoding.code;
  return a.valueBoolean ?? a.valueInteger ?? a.valueDecimal ?? a.valueString ?? a.valueDate ?? a.valueDateTime ?? a.valueTime;
}

/**
 * One `enableWhen` against the answers given to the question it looks at — as the form component evaluates it:
 * `exists` is about whether any answer is there; the other operators hold when any given answer satisfies them, and
 * never when none is given.
 */
export function conditionMet(when: QuestionnaireItemEnableWhen, given: readonly QuestionnaireResponseItemAnswer[]): boolean {
  const present = given.filter((a) => answerValueKey(a));
  if (when.operator === 'exists') return present.length > 0 === (when.answerBoolean ?? true);
  if (present.length === 0) return false;
  const expected = when.answerCoding ? when.answerCoding.code : (when.answerBoolean ?? when.answerInteger ?? when.answerDecimal ?? when.answerString ?? when.answerDate ?? when.answerDateTime ?? when.answerTime);
  return present.some((a) => {
    if (when.answerCoding && a.valueCoding && when.answerCoding.system && a.valueCoding.system && when.answerCoding.system !== a.valueCoding.system) return false;
    const actual = comparable(a);
    switch (when.operator) {
      case '=':
        return actual === expected;
      case '!=':
        return actual !== expected;
      case '>':
        return typeof actual === typeof expected && (actual as number) > (expected as number);
      case '<':
        return typeof actual === typeof expected && (actual as number) < (expected as number);
      case '>=':
        return typeof actual === typeof expected && (actual as number) >= (expected as number);
      case '<=':
        return typeof actual === typeof expected && (actual as number) <= (expected as number);
      default:
        return false;
    }
  });
}

/** Whether an item is asked at all: its own conditions hold (all, or any — `enableBehavior`) and so do its group's. */
export function itemEnabled(linkId: string, items: Map<string, QuestionnaireItem>, parents: Map<string, string | undefined>, answers: Map<string, QuestionnaireResponseItemAnswer[]>): boolean {
  const item = items.get(linkId);
  if (!item) return false;
  const parent = parents.get(linkId);
  if (parent && !itemEnabled(parent, items, parents, answers)) return false;
  if (!item.enableWhen?.length) return true;
  const results = item.enableWhen.map((w) => conditionMet(w, answers.get(w.question) ?? []));
  return item.enableBehavior === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function flattenAnswers(items: QuestionnaireResponseItem[] | undefined, acc = new Map<string, QuestionnaireResponseItemAnswer[]>()): Map<string, QuestionnaireResponseItemAnswer[]> {
  for (const item of items ?? []) {
    acc.set(item.linkId, [...(acc.get(item.linkId) ?? []), ...(item.answer ?? [])]);
    if (item.item) flattenAnswers(item.item, acc);
    for (const a of item.answer ?? []) if (a.item) flattenAnswers(a.item, acc);
  }
  return acc;
}

const VALUE_KEYS: Record<string, string[]> = {
  boolean: ['valueBoolean'],
  decimal: ['valueDecimal'],
  integer: ['valueInteger'],
  date: ['valueDate'],
  dateTime: ['valueDateTime'],
  time: ['valueTime'],
  string: ['valueString'],
  text: ['valueString'],
  url: ['valueUri'],
  choice: ['valueCoding', 'valueString'],
  'open-choice': ['valueCoding', 'valueString'],
  attachment: ['valueAttachment'],
  reference: ['valueReference'],
  quantity: ['valueQuantity'],
};

function answerValueKey(a: QuestionnaireResponseItemAnswer): string | undefined {
  return Object.keys(a).find((k) => k.startsWith('value') && (a as Record<string, unknown>)[k] !== undefined);
}

/** How a problem names an item: the question as the clinician reads it, the linkId when the item has no text. */
function label(item: QuestionnaireItem, linkId: string): string {
  return item.text?.trim() || linkId;
}

export function validateQuestionnaireResponse(questionnaire: Questionnaire, response: QuestionnaireResponse): string[] {
  const problems: string[] = [];
  if (response.resourceType !== 'QuestionnaireResponse') return ['response is not a QuestionnaireResponse'];
  if (response.questionnaire && questionnaire.url && response.questionnaire !== questionnaire.url) {
    problems.push(`response answers ${response.questionnaire}, not ${questionnaire.url}`);
  }
  const items = flattenItems(questionnaire.item);
  const parents = parentsOf(questionnaire.item, undefined);
  const answers = flattenAnswers(response.item);

  for (const linkId of answers.keys()) {
    if (!items.has(linkId)) problems.push(`unknown item "${linkId}"`);
  }
  for (const [linkId, item] of items) {
    const given = (answers.get(linkId) ?? []).filter((a) => answerValueKey(a));
    const name = label(item, linkId);
    if (item.type === 'group' || item.type === 'display') {
      if (given.length) problems.push(`"${name}" is a ${item.type} and cannot carry answers`);
      continue;
    }
    if (!itemEnabled(linkId, items, parents, answers)) {
      // Not asked this time: its condition (or its group's) is not met — so not required, and an answer to it is a mistake.
      if (given.length) problems.push(`"${name}" is not asked (its condition is not met) and cannot carry answers`);
      continue;
    }
    if (item.required && given.length === 0) problems.push(`"${name}" is required`);
    if (!item.repeats && given.length > 1) problems.push(`"${name}" allows one answer, got ${given.length}`);
    const allowed = VALUE_KEYS[item.type ?? ''] ?? [];
    const lo = bound(item, MIN_VALUE);
    const hi = bound(item, MAX_VALUE);
    for (const a of given) {
      const key = answerValueKey(a) ?? '';
      if (allowed.length && !allowed.includes(key)) problems.push(`"${name}" expects ${allowed.join('/')} not ${key}`);
      if (key === 'valueCoding' && item.answerOption?.length) {
        const offered = item.answerOption.map((o) => o.valueCoding).filter((c): c is NonNullable<typeof c> => Boolean(c?.code));
        const match = offered.some((o) => o.code === a.valueCoding?.code && (!o.system || !a.valueCoding?.system || o.system === a.valueCoding.system));
        if (!match) problems.push(`"${name}": ${a.valueCoding?.system ? `${a.valueCoding.system}|` : ''}${a.valueCoding?.code ?? '(no code)'} is not one of the offered options`);
      }
      const n = key === 'valueInteger' || key === 'valueDecimal' ? (a.valueInteger ?? a.valueDecimal) : undefined;
      if (n !== undefined) {
        if (lo !== undefined && n < lo) problems.push(`"${name}": ${n} is below the minimum ${lo}`);
        if (hi !== undefined && n > hi) problems.push(`"${name}": ${n} is above the maximum ${hi}`);
      }
    }
  }
  return problems;
}

/** One answer also written as an Observation: the rule from the manifest (`extract`) and the number the response holds for it. */
export interface ExtractedAnswer {
  readonly link_id: string;
  readonly code: string;
  readonly display?: string;
  readonly unit?: string;
  readonly value: number;
}

/**
 * The answers a submission also records as Observations — the manifest's `extract` rules matched against the response:
 * only a numeric answer (integer or decimal) is a measurement; an unanswered or hidden item yields nothing. Shared by the
 * mock executor and, in spirit, by primitives.py::extract_answers.
 */
export function extractAnswers(rules: readonly { link_id: string; code: string; display?: string; unit?: string }[] | undefined, response: QuestionnaireResponse): ExtractedAnswer[] {
  if (!rules?.length) return [];
  const answers = flattenAnswers(response.item);
  const out: ExtractedAnswer[] = [];
  for (const rule of rules) {
    const first = answers.get(rule.link_id)?.[0];
    const value = first?.valueDecimal ?? first?.valueInteger;
    if (typeof value === 'number') out.push({ ...rule, value });
  }
  return out;
}
