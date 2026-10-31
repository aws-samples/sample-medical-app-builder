import type { AllergyIntolerance, CodeableConcept, Condition, Media, Observation, Procedure, Quantity, Resource, Task } from '@medplum/fhirtypes';
import { LATERALITY, SNOMED_SYSTEM } from './fhirHelpers';

/**
 * Validation of the record changes an app may make besides a form submission: recording a measurement
 * (an Observation whose code, unit, plausibility range and date the manifest fixed in advance), adding a
 * coded entry — a problem (Condition), an allergy (AllergyIntolerance), a procedure (Procedure) — from a
 * fixed list of codes with the few fields the form took, and changing the status of a problem or a
 * prescription (one field, an allowed set, the patient's own record).
 *
 * Mirror of infra/lambdas/dispatcher/writes.py — same rules, same messages; `writeCases.json` is asserted
 * by both test suites. The browser uses this copy to explain a problem before a request leaves; the
 * dispatcher's copy is the verdict that counts. Data-quality rules only, never clinical interpretation.
 */

/** One component of a panel must be above another — systolic above diastolic. The one relation a panel can state. */
export interface ComponentRule {
  readonly component: string;
  readonly above: string;
  /** How the problem is named; defaults to the two component codes. The values follow in brackets either way. */
  readonly message?: string;
}

export interface ObservationEntryRules {
  readonly codes: readonly string[];
  readonly components?: readonly string[];
  readonly unit?: string;
  readonly ranges?: Readonly<Record<string, { readonly min?: number; readonly max?: number }>>;
  readonly max_backdate_days?: number;
  /** Relations between a panel's components, checked once every component is present and numeric. */
  readonly rules?: readonly ComponentRule[];
  /** Whether the form asks the side of the body: `bodySite` may then carry one SNOMED laterality qualifier (left, right, both); `required` means it must. Absent: a side is refused. */
  readonly side?: 'optional' | 'required';
  /** The structure measured (qualified code) — the only coding bodySite may carry besides the laterality. */
  readonly body_site?: string;
  /** Test conditions (qualified codes) `method` must be one of; absent: a method is refused. */
  readonly conditions?: readonly string[];
}

export interface StatusChange {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly versionId?: unknown;
  readonly reason?: unknown;
  readonly note?: unknown;
}

function qualified(concept: CodeableConcept | undefined): string | undefined {
  for (const c of concept?.coding ?? []) {
    if (c.code) return c.system ? `${c.system}|${c.code}` : c.code;
  }
  return undefined;
}

const bare = (token: string): string => (token.includes('|') ? token.slice(token.indexOf('|') + 1) : token);

/** Allowed entries and the payload's coding may each be `system|code` or a bare code; a bare side matches on the code. */
function matches(q: string | undefined, allowed: readonly string[]): boolean {
  if (q === undefined) return false;
  return allowed.some((a) => a === q || ((!a.includes('|') || !q.includes('|')) && bare(a) === bare(q)));
}

function rangeFor(code: string | undefined, ranges: ObservationEntryRules['ranges']): { min?: number; max?: number } | undefined {
  if (!code || !ranges) return undefined;
  if (ranges[code]) return ranges[code];
  for (const [key, value] of Object.entries(ranges)) if (bare(key) === bare(code)) return value;
  return undefined;
}

/** `900` → "900", `6.8` → "6.8" — the same as Python's `:g` for the numbers a form produces. */
const g = (n: number): string => String(Number(n.toPrecision(6)));

/** The numeric value of the component with this (qualified or bare) code, if present and numeric. */
function componentValue(components: readonly { code?: unknown; valueQuantity?: unknown }[], code: string): number | undefined {
  const found = components.find((c) => matches(qualified(c.code as Observation['code']), [code]));
  const value = (found?.valueQuantity as Quantity | undefined)?.value;
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

function checkQuantity(label: string, quantity: unknown, unit: string | undefined, range: { min?: number; max?: number } | undefined, problems: string[]): void {
  const q = quantity as Quantity | undefined;
  if (!q || typeof q !== 'object' || typeof q.value !== 'number' || Number.isNaN(q.value)) {
    problems.push(`${label}: a numeric value is required`);
    return;
  }
  // The unit is fixed by the form; a payload may repeat it as the display unit or the UCUM code, or omit it.
  if (unit && !(q.unit === unit || q.code === unit) && (q.unit !== undefined || q.code !== undefined)) {
    problems.push(`${label}: the value must be in ${unit}, not ${q.unit ?? q.code}`);
  }
  if (range) {
    const { min, max } = range;
    if ((min !== undefined && q.value < min) || (max !== undefined && q.value > max)) {
      problems.push(`${label}: ${g(q.value)}${unit ? ` ${unit}` : ''} is outside the accepted range ${g(min ?? Number.NaN)}–${g(max ?? Number.NaN)}`);
    }
  }
}

function parseIso(value: string): Date | undefined {
  const text = value.length === 10 ? `${value}T00:00:00Z` : value;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The Observation an entry form produced, against what the manifest allows it to record. */
export function validateObservationEntry(rules: ObservationEntryRules, observation: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const obs = observation as Observation | undefined;
  if (!obs || typeof obs !== 'object' || obs.resourceType !== 'Observation') return ['payload must be an Observation'];

  const code = qualified(obs.code);
  if (!matches(code, rules.codes)) problems.push(`code ${code ?? '(none)'} is not one this form may record (${rules.codes.join(', ')})`);

  const claimed = obs.subject?.reference;
  if (claimed && claimed !== `Patient/${patientId}`) problems.push(`observation subject ${claimed} is not the patient in context`);

  const expected = rules.components ?? [];
  if (expected.length) {
    const given = Array.isArray(obs.component) ? obs.component : [];
    const seen: string[] = [];
    for (const comp of given) {
      const compCode = qualified(comp.code);
      if (!matches(compCode, expected)) {
        problems.push(`component ${compCode ?? '(none)'} is not part of this form`);
        continue;
      }
      seen.push(compCode ?? '');
      checkQuantity(`component ${compCode}`, comp.valueQuantity, rules.unit, rangeFor(compCode, rules.ranges), problems);
    }
    for (const e of expected) if (!seen.some((s) => matches(s, [e]))) problems.push(`component ${e} is missing`);
    if (obs.valueQuantity !== undefined) problems.push('a panel carries its values in components, not a single value');
    // Relations between components — a swapped systolic/diastolic is a common slip and a physiologically impossible
    // panel; only judged when both values are there and numeric (their own problems are named above).
    for (const rule of rules.rules ?? []) {
      const a = componentValue(given, rule.component);
      const b = componentValue(given, rule.above);
      if (a === undefined || b === undefined || a > b) continue;
      const what = rule.message ?? `component ${rule.component} must be above component ${rule.above}`;
      problems.push(`${what} (${a} vs ${b}${rules.unit ? ` ${rules.unit}` : ''})`);
    }
  } else {
    if (obs.component?.length) problems.push('this form records a single value, not components');
    checkQuantity('value', obs.valueQuantity, rules.unit, rangeFor(code, rules.ranges), problems);
  }

  if (obs.effectiveDateTime !== undefined) {
    const when = parseIso(String(obs.effectiveDateTime));
    if (!when) problems.push('effective date is not a valid date-time');
    else {
      if (when.getTime() > now.getTime() + 5 * 60_000) problems.push('effective date must not be in the future');
      const maxDays = rules.max_backdate_days ?? 7;
      if (when.getTime() < now.getTime() - maxDays * 86_400_000) problems.push(`effective date must not be more than ${maxDays} days ago`);
    }
  }

  // The side of the body and the structure measured, as bodySite codings: one SNOMED laterality qualifier when the form
  // asks for a side (and only then), the declared structure and nothing else besides.
  const codings = obs.bodySite?.coding ?? [];
  const sides = codings.filter((c) => c.system === SNOMED_SYSTEM && c.code !== undefined && LATERALITY[c.code] !== undefined);
  const others = codings.filter((c) => !sides.includes(c));
  if (sides.length > 1) problems.push('bodySite names more than one side');
  if (sides.length && !rules.side) problems.push('this form does not record a side of the body');
  if (rules.side === 'required' && !sides.length) problems.push('the side of the body is required: left, right or both');
  for (const c of others) {
    const q = c.system ? `${c.system}|${c.code ?? ''}` : (c.code ?? '');
    if (!rules.body_site || !matches(q, [rules.body_site])) problems.push(`bodySite ${q || '(none)'} is not the structure this form records${rules.body_site ? ` (${rules.body_site})` : ''}`);
  }
  // Test conditions: one of the offered codes, or none; a form that offers none takes none.
  if (obs.method !== undefined) {
    const method = qualified(obs.method);
    if (!rules.conditions?.length) problems.push('this form does not record test conditions');
    else if (!matches(method, rules.conditions)) problems.push(`method ${method ?? '(none)'} is not one of the test conditions this form offers (${rules.conditions.join(', ')})`);
  }
  return problems;
}

function currentStatus(resource: Resource, field: string): string | undefined {
  const value = (resource as unknown as Record<string, unknown>)[field];
  if (value && typeof value === 'object' && 'coding' in (value as object)) {
    for (const c of (value as CodeableConcept).coding ?? []) if (c.code) return c.code;
    return undefined;
  }
  return value === undefined || value === null ? undefined : String(value);
}

/** A status change {id, status, versionId?, reason?, note?} for a Condition, MedicationRequest or Task of the patient in context. */
export function validateStatusChange(rules: { readonly allowed: readonly string[] }, change: unknown, current: Resource | undefined, resourceType: string, statusField: string, patientId: string): string[] {
  const problems: string[] = [];
  const c = change as StatusChange | undefined;
  if (!c || typeof c !== 'object') return ['payload must be a status change {id, status}'];
  if (typeof c.id !== 'string' || !c.id) problems.push('target id is required');
  if (typeof c.status !== 'string' || !rules.allowed.includes(c.status)) problems.push(`status '${typeof c.status === 'string' ? c.status : '(none)'}' is not one of ${rules.allowed.join(', ')}`);
  if (problems.length) return problems;
  if (!current) return [`${resourceType}/${String(c.id)} was not found`];
  const owner = current as { subject?: { reference?: string }; patient?: { reference?: string }; for?: { reference?: string } };
  const subject = owner.subject?.reference ?? owner.patient?.reference ?? owner.for?.reference; // Task names its patient `for`
  if (subject !== `Patient/${patientId}`) return [`${resourceType}/${String(c.id)} belongs to another patient`];
  if (currentStatus(current, statusField) === c.status) problems.push(`${resourceType}/${String(c.id)} is already ${String(c.status)}`);
  return problems;
}

// ── coded entries: a problem, an allergy, a procedure ──────────────────────────────────────────

export interface ConditionEntryRules {
  readonly codes: readonly string[];
  readonly verification?: readonly string[];
  readonly severity?: boolean;
}

export interface AllergyEntryRules {
  readonly codes: readonly string[];
  readonly types?: readonly string[];
  readonly categories?: readonly string[];
  readonly verification?: readonly string[];
  readonly criticality?: boolean;
  readonly reaction?: boolean;
}

export interface ProcedureEntryRules {
  readonly codes: readonly string[];
  readonly statuses?: readonly string[];
  readonly max_backdate_days?: number;
  readonly body_site?: boolean;
  readonly outcome?: boolean;
}

/** SNOMED CT severity codes — the only ones a severity may carry (Condition.severity, AllergyIntolerance.reaction.severity is a code). */
export const SEVERITY_CODES: Readonly<Record<string, string>> = Object.freeze({ '255604002': 'mild', '6736007': 'moderate', '24484000': 'severe' });
const REACTION_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
const CRITICALITIES = ['low', 'high', 'unable-to-assess'] as const;

function codeOf(concept: CodeableConcept | undefined): string | undefined {
  for (const c of concept?.coding ?? []) if (c.code) return c.code;
  return undefined;
}

/** A date or date-time that must parse and must not lie in the future (five minutes of clock skew allowed). */
function checkPastDate(label: string, value: unknown, now: Date, problems: string[], maxDays?: number): void {
  if (value === undefined) return;
  const when = typeof value === 'string' ? parseIso(value) : undefined;
  if (!when) return void problems.push(`${label} is not a valid date`);
  if (when.getTime() > now.getTime() + 5 * 60_000) problems.push(`${label} must not be in the future`);
  if (maxDays !== undefined && when.getTime() < now.getTime() - maxDays * 86_400_000) problems.push(`${label} must not be more than ${maxDays} days ago`);
}

function checkOneOf(label: string, value: unknown, allowed: readonly string[], problems: string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) problems.push(`${label} '${typeof value === 'string' ? value : '(none)'}' is not one of ${allowed.join(', ')}`);
}

function checkCode(payloadCode: string | undefined, allowed: readonly string[], problems: string[]): void {
  if (!matches(payloadCode, allowed)) problems.push(`code ${payloadCode ?? '(none)'} is not one this form may record (${allowed.join(', ')})`);
}

function checkSubject(label: string, claimed: string | undefined, patientId: string, problems: string[]): void {
  if (claimed && claimed !== `Patient/${patientId}`) problems.push(`${label} ${claimed} is not the patient in context`);
}

/** The Condition an entry form produced: one of the allowed codes, active, verified as offered, with an onset in the past. */
export function validateConditionEntry(rules: ConditionEntryRules, condition: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const c = condition as Condition | undefined;
  if (!c || typeof c !== 'object' || c.resourceType !== 'Condition') return ['payload must be a Condition'];
  checkCode(qualified(c.code), rules.codes, problems);
  checkSubject('condition subject', c.subject?.reference, patientId, problems);
  const clinical = codeOf(c.clinicalStatus);
  if (clinical !== undefined && clinical !== 'active') problems.push(`a new problem is recorded as active, not '${clinical}'`);
  const verification = codeOf(c.verificationStatus);
  if (verification !== undefined) checkOneOf('verification status', verification, rules.verification ?? ['confirmed'], problems);
  if (c.severity !== undefined) {
    const severity = codeOf(c.severity);
    if (!rules.severity) problems.push('severity is not part of this form');
    else if (!severity || !SEVERITY_CODES[severity]) problems.push(`severity '${severity ?? '(none)'}' is not mild, moderate or severe`);
  }
  checkPastDate('onset', c.onsetDateTime, now, problems);
  return problems;
}

/** The AllergyIntolerance an entry form produced: an allowed substance, active, typed and categorised as offered. */
export function validateAllergyEntry(rules: AllergyEntryRules, allergy: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const a = allergy as AllergyIntolerance | undefined;
  if (!a || typeof a !== 'object' || a.resourceType !== 'AllergyIntolerance') return ['payload must be an AllergyIntolerance'];
  checkCode(qualified(a.code), rules.codes, problems);
  checkSubject('allergy patient', a.patient?.reference, patientId, problems);
  const clinical = codeOf(a.clinicalStatus);
  if (clinical !== undefined && clinical !== 'active') problems.push(`a new allergy is recorded as active, not '${clinical}'`);
  const verification = codeOf(a.verificationStatus);
  if (verification !== undefined) checkOneOf('verification status', verification, rules.verification ?? ['confirmed', 'unconfirmed'], problems);
  if (a.type !== undefined) checkOneOf('type', a.type, rules.types ?? ['allergy', 'intolerance'], problems);
  const categories = Array.isArray(a.category) ? a.category : [];
  if (categories.length === 0) problems.push('a category is required');
  for (const cat of categories) checkOneOf('category', cat, rules.categories ?? ['medication', 'food', 'environment'], problems);
  if (a.criticality !== undefined) {
    if (rules.criticality === false) problems.push('criticality is not part of this form');
    else if (!CRITICALITIES.includes(a.criticality as (typeof CRITICALITIES)[number])) problems.push(`criticality '${String(a.criticality)}' is not low, high or unable-to-assess`);
  }
  const reactions = Array.isArray(a.reaction) ? a.reaction : [];
  if (reactions.length && rules.reaction === false) problems.push('a reaction is not part of this form');
  for (const r of reactions) {
    const manifestation = Array.isArray(r.manifestation) ? r.manifestation : [];
    if (!manifestation.some((m) => (m.text && m.text.trim()) || codeOf(m))) problems.push('a reaction needs its manifestation');
    if (r.severity !== undefined && !REACTION_SEVERITIES.includes(r.severity as (typeof REACTION_SEVERITIES)[number])) problems.push(`reaction severity '${String(r.severity)}' is not mild, moderate or severe`);
  }
  checkPastDate('onset', a.onsetDateTime, now, problems);
  return problems;
}

/** The Procedure an entry form produced: an allowed code, an offered status, performed within the window. */
export function validateProcedureEntry(rules: ProcedureEntryRules, procedure: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const p = procedure as Procedure | undefined;
  if (!p || typeof p !== 'object' || p.resourceType !== 'Procedure') return ['payload must be a Procedure'];
  checkCode(qualified(p.code), rules.codes, problems);
  checkSubject('procedure subject', p.subject?.reference, patientId, problems);
  checkOneOf('status', p.status, rules.statuses ?? ['completed'], problems);
  if (p.performedDateTime === undefined) problems.push('performed date is required');
  else checkPastDate('performed date', p.performedDateTime, now, problems, rules.max_backdate_days ?? 30);
  if (p.bodySite?.length && !rules.body_site) problems.push('body site is not part of this form');
  if (p.outcome !== undefined && !rules.outcome) problems.push('outcome is not part of this form');
  return problems;
}

// ── a task ───────────────────────────────────────────────────────────────────────────────────────

export interface TaskEntryRules {
  readonly codes: readonly string[];
  readonly priorities?: readonly string[];
  readonly due?: boolean;
}

/** The Task a form produced: an allowed code, a priority the form offers, requested, due today or later. */
export function validateTaskEntry(rules: TaskEntryRules, task: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const t = task as Task | undefined;
  if (!t || typeof t !== 'object' || t.resourceType !== 'Task') return ['payload must be a Task'];
  checkCode(qualified(t.code), rules.codes, problems);
  checkSubject('task patient', t.for?.reference, patientId, problems);
  if (t.status !== undefined && t.status !== 'requested') problems.push(`a new task is requested, not '${String(t.status)}'`);
  if (t.priority !== undefined) checkOneOf('priority', t.priority, rules.priorities ?? ['routine', 'urgent'], problems);
  const due = t.restriction?.period?.end;
  if (due !== undefined) {
    if (rules.due === false) problems.push('a due date is not part of this form');
    else {
      const when = typeof due === 'string' ? parseIso(due) : undefined;
      if (!when) problems.push('due date is not a valid date');
      else if (when.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) problems.push('due date must not be in the past');
    }
  }
  if (t.description !== undefined && (typeof t.description !== 'string' || t.description.length > 500)) problems.push('description must be text of at most 500 characters');
  return problems;
}

// ── a photo ──────────────────────────────────────────────────────────────────────────────────

export interface MediaEntryRules {
  readonly kinds: readonly string[];
  readonly body_site?: boolean;
  readonly max_bytes?: number;
  readonly max_backdate_days?: number;
}

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** `1.7 MB` from a megabyte up, `320 KB` below — the same words as writes.py `_human_size`. */
export const humanSize = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`);

/** The byte size of a base64 payload, or undefined when it is not valid base64. */
export function decodedImageSize(data: unknown): number | undefined {
  if (typeof data !== 'string' || !data) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return undefined;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length * 3) / 4 - padding;
}

/** The Media a photo form produced: a photo of an allowed kind, of the patient in context, an image of an accepted type and size, taken within the window. */
export function validateMediaEntry(rules: MediaEntryRules, media: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const m = media as Media | undefined;
  if (!m || typeof m !== 'object' || m.resourceType !== 'Media') return ['payload must be a Media'];
  const mediaType = codeOf(m.type);
  if (mediaType !== undefined && mediaType !== 'photo') problems.push(`a photo is recorded, not '${mediaType}'`);
  checkCode(qualified(m.reasonCode?.[0]), rules.kinds, problems);
  checkSubject('photo subject', m.subject?.reference, patientId, problems);
  const content = (m.content ?? {}) as { contentType?: string; data?: unknown };
  if (!IMAGE_TYPES.includes(content.contentType as (typeof IMAGE_TYPES)[number])) problems.push(`content type '${content.contentType ?? '(none)'}' is not one of ${IMAGE_TYPES.join(', ')}`);
  const size = decodedImageSize(content.data);
  if (content.data === undefined || content.data === null || content.data === '') problems.push('the photo has no image data');
  else if (size === undefined) problems.push('image data is not valid base64');
  else {
    const maxBytes = rules.max_bytes ?? 1_500_000;
    if (size > maxBytes) problems.push(`the image is ${humanSize(size)}; the form accepts up to ${humanSize(maxBytes)}`);
  }
  if (m.bodySite !== undefined && !rules.body_site) problems.push('body site is not part of this form');
  checkPastDate('taken date', m.createdDateTime, now, problems, rules.max_backdate_days ?? 30);
  return problems;
}
