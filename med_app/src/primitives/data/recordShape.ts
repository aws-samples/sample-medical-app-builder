/**
 * Declared-shape records — the runtime half. A `record` section declares a FHIR resource type and a handful of typed
 * fields, each mapped to an element path; the compiler resolved every field's encoding against the StructureDefinition
 * and put the result in the manifest (`write.fhir.record.create` config). From here on nothing knows FHIR schemas:
 * the form builds the resource by writing each field's value at its path, this module validates the payload against
 * the declared fields — and refuses any element the shape did not declare — and the dispatcher applies the stamps
 * (status, subject, author, dates) before writing. Mirrored by infra/lambdas/dispatcher/record_shape.py: same rules,
 * same words (writeCases.json `record_cases`).
 */

import type { Resource } from '@medplum/fhirtypes';

/** How a field's value is written at its path — what the element's FHIR type calls for. */
export type RecordEncoding = 'string' | 'concept_text' | 'quantity' | 'decimal' | 'integer' | 'codeable_concept' | 'coding' | 'code' | 'date' | 'datetime' | 'boolean' | 'attachment_text';

export type RecordFieldType = 'text' | 'long_text' | 'number' | 'integer' | 'date' | 'datetime' | 'boolean' | 'code' | 'choice';

export interface RecordFieldRule {
  readonly id: string;
  readonly label: string;
  readonly type: RecordFieldType;
  /** Element path within the resource, dotted, with `[n]` indices: `target.detailQuantity`, `note[0].text`. */
  readonly path: string;
  readonly as: RecordEncoding;
  readonly required?: boolean;
  /** `number` / `integer`: the unit every value carries (quantity) and the plausible range. */
  readonly unit?: string;
  readonly range?: { readonly min?: number; readonly max?: number };
  /** `date` / `datetime`: how far back and ahead a date may lie, in days from today. */
  readonly past_days?: number;
  readonly future_days?: number;
  /** `text` / `long_text`: the longest text accepted. */
  readonly max_length?: number;
  /** `code`: the codings the field may carry, qualified `system|code`, with their displays. */
  readonly codes?: readonly { readonly system: string; readonly code: string; readonly display: string }[];
  /** `choice`: fixed options; `system` when they are codings. */
  readonly options?: readonly { readonly code: string; readonly display: string }[];
  readonly system?: string;
}

/** A stamp the dispatcher writes: a path and a value, where `$patient`, `$author`, `$now`, `$today` are filled in. */
export interface RecordStamp {
  readonly path: string;
  readonly value: unknown;
}

export interface RecordEntryRules {
  readonly resource: string;
  readonly fields: readonly RecordFieldRule[];
  readonly stamps?: readonly RecordStamp[];
}

export type PathSegment = { readonly key: string; readonly index?: number };

/** `note[0].text` → [{key: 'note', index: 0}, {key: 'text'}]. */
export function parsePath(path: string): PathSegment[] {
  return path.split('.').map((part) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(part);
    if (!m) throw new Error(`bad path segment "${part}" in "${path}"`);
    return m[2] !== undefined ? { key: m[1]!, index: Number(m[2]) } : { key: m[1]! };
  });
}

export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parsePath(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg.key];
    if (seg.index !== undefined) cur = Array.isArray(cur) ? cur[seg.index] : undefined;
  }
  return cur;
}

/** Writes `value` at `path`, creating objects and arrays on the way; `undefined` removes the leaf. */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parsePath(path);
  let cur: Record<string, unknown> | unknown[] = root;
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1;
    const holder = cur as Record<string, unknown>;
    if (seg.index === undefined) {
      if (last) {
        if (value === undefined) delete holder[seg.key];
        else holder[seg.key] = value;
        return;
      }
      if (typeof holder[seg.key] !== 'object' || holder[seg.key] === null) holder[seg.key] = {};
      cur = holder[seg.key] as Record<string, unknown>;
    } else {
      if (!Array.isArray(holder[seg.key])) holder[seg.key] = [];
      const arr = holder[seg.key] as unknown[];
      while (arr.length <= seg.index) arr.push({});
      if (last) {
        if (value === undefined) arr.splice(seg.index, 1);
        else arr[seg.index] = value;
        return;
      }
      if (typeof arr[seg.index] !== 'object' || arr[seg.index] === null) arr[seg.index] = {};
      cur = arr[seg.index] as Record<string, unknown>;
    }
  }
}

/** The declared path and everything under it count as declared: `note[0]` covers `note[0].text`. */
function covers(declared: string, leaf: string): boolean {
  return leaf === declared || leaf.startsWith(`${declared}.`);
}

/** Every leaf path of a value, with `[n]` on array members — the shape is checked leaf by leaf. */
export function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return prefix ? [prefix] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}[${i}]`));
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return prefix ? [prefix] : [];
  return entries.flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

/** The paths a payload may carry besides the fields: the resource type, the submission identifier, and the stamps (overwritten anyway). */
const ALWAYS_ALLOWED = ['resourceType', 'identifier', 'meta'];

/** What the form writes for a field value, by encoding. `undefined` when the value is empty. */
export function encodeValue(field: RecordFieldRule, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (field.as) {
    case 'string':
      return String(raw);
    case 'concept_text':
      return { text: String(raw) };
    case 'quantity':
      return { value: Number(raw), ...(field.unit ? { unit: field.unit } : {}) };
    case 'decimal':
      return Number(raw);
    case 'integer':
      return Math.trunc(Number(raw));
    case 'boolean':
      return Boolean(raw);
    case 'date':
      return String(raw).slice(0, 10);
    case 'datetime':
      return String(raw);
    case 'codeable_concept': {
      const chosen = optionFor(field, String(raw));
      return chosen ? { coding: [chosen], text: chosen.display } : undefined;
    }
    case 'coding':
      return optionFor(field, String(raw));
    case 'code':
      return String(raw);
    case 'attachment_text':
      return { contentType: 'text/plain', data: toBase64(String(raw)) };
  }
}

function optionFor(field: RecordFieldRule, code: string): { system?: string; code: string; display?: string } | undefined {
  if (field.codes) {
    const c = field.codes.find((c) => c.code === code || `${c.system}|${c.code}` === code);
    return c ? { system: c.system, code: c.code, display: c.display } : undefined;
  }
  const o = field.options?.find((o) => o.code === code);
  return o ? { ...(field.system ? { system: field.system } : {}), code: o.code, display: o.display } : undefined;
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(data: string): string | undefined {
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

const fmt = (n: number) => String(n);

function parseIso(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The problems with one field's value, named as the form labels the field. */
function checkField(field: RecordFieldRule, value: unknown, now: Date, problems: string[]): void {
  const name = `"${field.label}"`;
  if (value === undefined) {
    if (field.required) problems.push(`${name} is required`);
    return;
  }
  switch (field.as) {
    case 'string':
    case 'concept_text':
    case 'attachment_text': {
      const text = field.as === 'string' ? value : field.as === 'concept_text' ? (value as { text?: unknown }).text : fromBase64(String((value as { data?: unknown }).data ?? ''));
      if (typeof text !== 'string' || !text.trim()) return void problems.push(`${name}: text is required`);
      if (field.as === 'attachment_text' && (value as { contentType?: unknown }).contentType !== 'text/plain') problems.push(`${name}: the attachment must be text/plain`);
      if (field.max_length && text.length > field.max_length) problems.push(`${name}: ${text.length} characters is more than the ${field.max_length} allowed`);
      return;
    }
    case 'quantity':
    case 'decimal':
    case 'integer': {
      const n = field.as === 'quantity' ? (value as { value?: unknown }).value : value;
      if (typeof n !== 'number' || Number.isNaN(n)) return void problems.push(`${name}: a numeric value is required`);
      if (field.as === 'integer' && !Number.isInteger(n)) problems.push(`${name}: a whole number is required`);
      if (field.as === 'quantity' && field.unit) {
        const unit = (value as { unit?: unknown; code?: unknown }).unit ?? (value as { code?: unknown }).code;
        if (unit !== undefined && unit !== field.unit) problems.push(`${name}: the value must be in ${field.unit}, not ${String(unit)}`);
      }
      if (field.range && ((field.range.min !== undefined && n < field.range.min) || (field.range.max !== undefined && n > field.range.max)))
        problems.push(`${name}: ${fmt(n)}${field.unit ? ` ${field.unit}` : ''} is outside the accepted range ${field.range.min !== undefined ? fmt(field.range.min) : '…'}–${field.range.max !== undefined ? fmt(field.range.max) : '…'}`);
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${name}: yes or no`);
      return;
    case 'date':
    case 'datetime': {
      if (typeof value !== 'string') return void problems.push(`${name} is not a valid date`);
      if (field.as === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return void problems.push(`${name} is not a valid date`);
      const when = parseIso(value);
      if (!when) return void problems.push(`${name} is not a valid date`);
      const day = 86_400_000;
      if (field.past_days !== undefined && when.getTime() < now.getTime() - field.past_days * day) problems.push(`${name} must not be more than ${field.past_days} days ago`);
      if (field.future_days !== undefined && when.getTime() > now.getTime() + (field.future_days + 1) * day) problems.push(`${name} must not be more than ${field.future_days} days ahead`);
      return;
    }
    case 'codeable_concept':
    case 'coding':
    case 'code': {
      const coding = field.as === 'codeable_concept' ? (value as { coding?: { system?: string; code?: string }[] }).coding?.[0] : field.as === 'coding' ? (value as { system?: string; code?: string }) : { code: value as string };
      const allowed = field.codes ? field.codes.map((c) => `${c.system}|${c.code}`) : (field.options ?? []).map((o) => (field.system && field.as !== 'code' ? `${field.system}|${o.code}` : o.code));
      const given = coding?.code === undefined ? undefined : field.as === 'code' || (!field.system && !field.codes) ? String(coding.code) : `${coding.system ?? ''}|${coding.code}`;
      if (given === undefined || !allowed.includes(given)) problems.push(`${name}: ${given ?? '(none)'} is not one of the offered options (${allowed.join(', ')})`);
      return;
    }
  }
}

/**
 * The payload against the shape: the resource type; every declared field present when required and well-formed; and
 * nothing the shape did not declare — an element outside the fields and the stamps is refused by name, since the
 * reviewer approved the fields and only the fields.
 */
export function validateRecordEntry(rules: RecordEntryRules, payload: unknown, patientId: string, now: Date): string[] {
  const problems: string[] = [];
  const r = payload as Resource | undefined;
  if (!r || typeof r !== 'object' || r.resourceType !== rules.resource) return [`payload must be a ${rules.resource}`];
  const subject = (r as { subject?: { reference?: string } }).subject?.reference;
  if (subject && subject !== `Patient/${patientId}`) problems.push(`subject ${subject} is not the patient in context`);
  for (const field of rules.fields) checkField(field, getPath(r, field.path), now, problems);
  const declared = [...rules.fields.map((f) => f.path), ...(rules.stamps ?? []).map((s) => s.path), ...ALWAYS_ALLOWED];
  const stray = leafPaths(r).filter((leaf) => !declared.some((d) => covers(d, leaf) || covers(d.replace(/\[\d+\]/g, ''), leaf.replace(/\[\d+\]/g, ''))));
  for (const leaf of [...new Set(stray)]) problems.push(`element ${leaf} is not part of this form`);
  return problems;
}

/** The stamps with their placeholders filled: who, when, for whom. */
export function applyStamps(resource: Record<string, unknown>, stamps: readonly RecordStamp[] | undefined, ctx: { patientId: string; author: unknown; now: string }): void {
  for (const s of stamps ?? []) {
    const v = s.value === '$patient' ? { reference: `Patient/${ctx.patientId}` } : s.value === '$author' ? ctx.author : s.value === '$now' ? ctx.now : s.value === '$today' ? ctx.now.slice(0, 10) : s.value;
    setPath(resource, s.path, v);
  }
}
