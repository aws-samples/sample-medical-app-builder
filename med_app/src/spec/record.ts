import { z } from 'zod';
import definitions from '../fhir/base-definitions.json';
import { CLOSED_KINDS, OPEN_KINDS, OPEN_KIND_PATHS, RECORD_RESOURCES, isAdmittedKind, isOpenKind, kindIssue, type RecordResource } from '../fhir/kinds';
import type { RecordEncoding, RecordEntryRules, RecordFieldRule, RecordFieldType, RecordStamp } from '../primitives/data/recordShape';
import { parsePath } from '../primitives/data/recordShape';
import { CodeSchema, identifier, type Code, type SpecIssue } from './common';
import { qualified, systemUrl } from './terminology';

/**
 * Declared-shape records — the compiler half. An author (or the assistant) declares a resource type and a few typed
 * fields, each mapped to an element path; this module resolves each path against the FHIR R4 StructureDefinitions the
 * panel ships (`src/fhir/base-definitions.json`), decides how the value is encoded there, checks that the required
 * elements of the resource are covered by a required field or a stamp, and emits the rules the runtime enforces on both
 * sides (`recordShape.ts`, `record_shape.py`). The reviewer sees the fields, the paths and the stamps — exactly what the
 * app will write — and nothing else can reach the record through this form.
 */

export { CLOSED_KINDS, OPEN_KINDS, RECORD_RESOURCES, isAdmittedKind, isOpenKind, kindIssue, type RecordResource };
export type OpenKind = string;

/** The platform's stamps for an admitted kind; a declared stamp's value is a literal or one of these placeholders. */
export const STAMP_PLACEHOLDERS = ['$patient', '$author', '$now', '$today'] as const;

const STATUS_CHOICES: Record<RecordResource, { readonly path: string; readonly values: readonly string[]; readonly initial: string }> = {
  Goal: { path: 'lifecycleStatus', values: ['proposed', 'planned', 'accepted', 'active'], initial: 'active' },
  CarePlan: { path: 'status', values: ['draft', 'active'], initial: 'active' },
  Encounter: { path: 'status', values: ['planned', 'in-progress', 'finished'], initial: 'finished' },
  DocumentReference: { path: 'status', values: ['current'], initial: 'current' },
  // A consent record in force; whether it permits or denies is the form's `provision.type`, so one shape records both answers.
  Consent: { path: 'status', values: ['active', 'proposed', 'draft'], initial: 'active' },
};

/** What the platform sets on every record of a type — never the form: who it is about, who made it, when, and its status. */
export function recordStamps(resource: RecordResource, status: string): RecordStamp[] {
  const s = STATUS_CHOICES[resource];
  switch (resource) {
    case 'Goal':
      return [{ path: s.path, value: status }, { path: 'subject', value: '$patient' }, { path: 'expressedBy', value: '$author' }, { path: 'statusDate', value: '$today' }];
    case 'CarePlan':
      return [{ path: s.path, value: status }, { path: 'intent', value: 'plan' }, { path: 'subject', value: '$patient' }, { path: 'author', value: '$author' }, { path: 'created', value: '$now' }];
    case 'Encounter':
      return [{ path: s.path, value: status }, { path: 'subject', value: '$patient' }];
    case 'DocumentReference':
      return [{ path: s.path, value: status }, { path: 'subject', value: '$patient' }, { path: 'date', value: '$now' }, { path: 'author[0]', value: '$author' }];
    case 'Consent':
      // No author stamp: Consent.performer is who consents (the patient), not who records it — the Provenance names the staff member.
      return [{ path: s.path, value: status }, { path: 'patient', value: '$patient' }, { path: 'dateTime', value: '$now' }];
  }
}

export const RecordFieldSchema = z
  .strictObject({
    id: identifier.describe('Stable id of the field'),
    label: z.string().min(1).max(80).describe('As the clinician reads it'),
    type: z.enum(['text', 'long_text', 'number', 'integer', 'date', 'datetime', 'boolean', 'code', 'choice']).describe('What is entered: text, a number (with unit and range), a date, yes/no, a code from a terminology (code), or one of fixed options (choice)'),
    path: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?)*$/, 'an element path like target.detailQuantity or note[0].text')
      .describe('Where the value lands in the FHIR resource — an element path; choice elements by their typed name (target.detailQuantity, target.dueDate)'),
    required: z.boolean().default(false),
    unit: z.string().min(1).optional().describe('number: the unit, e.g. s, kg, mmHg — required when the element is a Quantity'),
    range: z.strictObject({ min: z.number().optional(), max: z.number().optional() }).optional().describe('number: the plausible range'),
    past_days: z.number().int().min(0).max(3650).optional().describe('date: how far back the date may lie'),
    future_days: z.number().int().min(0).max(3650).optional().describe('date: how far ahead the date may lie'),
    max_length: z.number().int().positive().max(20000).optional().describe('text: the longest text accepted (default 2000)'),
    codes: z.array(CodeSchema).min(1).max(50).optional().describe('code: the codings the field may carry (from lookup_codes), each with its display'),
    options: z.array(z.strictObject({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a code: letters, digits, dots, hyphens, underscores — as the code system spells it (high-priority, patient-privacy)'), display: z.string().min(1).max(80) })).min(2).max(30).optional().describe('choice: the fixed options, their codes spelt as the system spells them'),
    system: z
      .union([z.enum(['loinc', 'snomed', 'atc', 'icd10gm', 'ops', 'ucum']), z.string().regex(/^(https?:\/\/|urn:)\S+$/, 'a system URL')])
      .optional()
      .describe('choice: the system the options are codes of, when the element wants a coding'),
  })
  .describe('One field of a record: typed, mapped to an element path, with its own rules');

export type RecordField = z.infer<typeof RecordFieldSchema>;

export const RecordStatusSchema = z.string().min(1).optional().describe('The status the record is written with: Goal proposed|planned|accepted|active (active), CarePlan draft|active (active), Encounter planned|in-progress|finished (finished), DocumentReference current, Consent active|proposed|draft (active — permit or deny is the form\'s provision.type)');

// ── StructureDefinitions ─────────────────────────────────────────────────────────────────────────────────────────────

interface Element {
  readonly path: string;
  readonly min?: number;
  readonly max?: string;
  readonly type?: readonly { readonly code: string }[];
}

type Bundle = { entry: { resource: { resourceType: string; name?: string; type?: string; kind?: string; snapshot?: { element: Element[] } } }[] };

const byType = new Map<string, Element[]>();
for (const e of (definitions as unknown as Bundle).entry) {
  const sd = e.resource;
  if (sd.resourceType === 'StructureDefinition' && sd.type && sd.snapshot) byType.set(sd.type, sd.snapshot.element);
}
// The open kinds ship as element paths only (path, cardinality, types) — all the resolver reads.
for (const [resource, elements] of Object.entries(OPEN_KIND_PATHS as Record<string, Element[]>)) byType.set(resource, elements);

export interface ResolvedElement {
  /** The FHIR type the path lands on (`Quantity`, `string`, `CodeableConcept` …). */
  readonly type: string;
  readonly min: number;
  readonly max: string;
}

const typeName = (code: string) => code.replace(/^http:\/\/hl7\.org\/fhirpath\/System\./, '').replace(/^String$/, 'string');

/**
 * The element a path lands on, walking into complex types (`note[0].text` → Goal.note is Annotation → Annotation.text)
 * and through choice elements by their typed name (`target.detailQuantity` → Goal.target.detail[x] as Quantity).
 * Undefined when the path names nothing the definitions know.
 */
export function resolveElement(resourceType: string, path: string): ResolvedElement | undefined {
  let elements = byType.get(resourceType);
  if (!elements) return undefined;
  let prefix = resourceType;
  let current: Element | undefined;
  for (const seg of parsePath(path)) {
    const exact = elements.find((el) => el.path === `${prefix}.${seg.key}`);
    let chosen: string | undefined;
    if (exact) current = exact;
    else {
      // A choice element named by its type: detailQuantity → detail[x] with Quantity among its types.
      const choice = elements.find((el) => el.path.endsWith('[x]') && el.path.startsWith(`${prefix}.`) && el.path.split('.').length === prefix.split('.').length + 1 && seg.key.startsWith(el.path.slice(prefix.length + 1, -3)));
      if (!choice) return undefined;
      const stem = choice.path.slice(prefix.length + 1, -3);
      const suffix = seg.key.slice(stem.length);
      const t = (choice.type ?? []).find((t) => typeName(t.code).toLowerCase() === suffix.toLowerCase());
      if (!t) return undefined;
      current = choice;
      chosen = typeName(t.code);
    }
    const types = chosen ? [chosen] : (current.type ?? []).map((t) => typeName(t.code));
    const type = types[0];
    if (!type) return undefined;
    if (type === 'BackboneElement' || type === 'Element') {
      prefix = `${prefix}.${seg.key}`; // stays in this definition
    } else {
      const next = byType.get(type);
      if (!next) {
        // A primitive, or a type the bundle does not carry: this must be the last segment.
        prefix = `${prefix}.${seg.key}`;
        elements = [];
      } else {
        elements = next;
        prefix = type;
      }
    }
    if (seg.index !== undefined && current.max === '1') return undefined; // an index on a single-valued element
    current = { ...current, type: [{ code: type }] };
  }
  const type = typeName(current!.type![0]!.code);
  return { type, min: current!.min ?? 0, max: current!.max ?? '1' };
}

/** The elements a resource requires that the stamps do not set — a field must cover each, and be required. */
export function requiredCoreElements(resource: string, stamps: readonly RecordStamp[]): string[] {
  const elements = byType.get(resource) ?? [];
  const stamped = new Set(stamps.map((s) => s.path.replace(/\[\d+\]/g, '')));
  return elements
    .filter((el) => el.path.split('.').length === 2 && (el.min ?? 0) >= 1)
    .map((el) => el.path.split('.')[1]!.replace(/\[x\]$/, ''))
    .filter((name) => !stamped.has(name));
}

// ── Encoding ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a field of this type writes into an element of that FHIR type; undefined when they do not go together. */
export function encodingFor(fieldType: RecordFieldType, elementType: string): RecordEncoding | undefined {
  switch (fieldType) {
    case 'text':
    case 'long_text':
      return elementType === 'string' || elementType === 'markdown' ? 'string' : elementType === 'CodeableConcept' ? 'concept_text' : elementType === 'Attachment' ? 'attachment_text' : undefined;
    case 'number':
      return elementType === 'Quantity' || elementType === 'SimpleQuantity' ? 'quantity' : elementType === 'decimal' ? 'decimal' : elementType === 'integer' || elementType === 'positiveInt' || elementType === 'unsignedInt' ? 'integer' : undefined;
    case 'integer':
      return elementType === 'integer' || elementType === 'positiveInt' || elementType === 'unsignedInt' ? 'integer' : elementType === 'Quantity' || elementType === 'SimpleQuantity' ? 'quantity' : elementType === 'decimal' ? 'decimal' : undefined;
    case 'date':
      return elementType === 'date' ? 'date' : elementType === 'dateTime' || elementType === 'instant' ? 'datetime' : undefined;
    case 'datetime':
      return elementType === 'dateTime' || elementType === 'instant' ? 'datetime' : elementType === 'date' ? 'date' : undefined;
    case 'boolean':
      return elementType === 'boolean' ? 'boolean' : undefined;
    case 'code':
      return elementType === 'CodeableConcept' ? 'codeable_concept' : elementType === 'Coding' ? 'coding' : undefined;
    case 'choice':
      return elementType === 'code' ? 'code' : elementType === 'CodeableConcept' ? 'codeable_concept' : elementType === 'Coding' ? 'coding' : elementType === 'string' ? 'string' : undefined;
  }
}

/** A stamp a shape declares for a kind the platform has not admitted: an element path and a literal or a placeholder. */
export const DeclaredStampSchema = z.strictObject({
  path: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?)*$/, 'an element path like status or subject'),
  value: z.union([z.string().min(1), z.number(), z.boolean()]).describe('A literal (active, completed, true) or a placeholder: $patient (the patient in context), $author (who records it), $now, $today'),
});
export type DeclaredStamp = z.infer<typeof DeclaredStampSchema>;

export interface RecordSectionLike {
  readonly resource: string;
  readonly fields: readonly RecordField[];
  readonly status?: string | undefined;
  /** For a kind the platform has not admitted (OPEN_KINDS): what the platform sets on every record — the patient, the status, the dates. */
  readonly stamps?: readonly DeclaredStamp[] | undefined;
}

/** The stamps of a section: the platform's for an admitted kind, the declared ones for an open kind. */
export function stampsOf(section: RecordSectionLike): RecordStamp[] {
  if (isAdmittedKind(section.resource)) return recordStamps(section.resource, section.status ?? STATUS_CHOICES[section.resource].initial);
  return (section.stamps ?? []).map((st) => ({ path: st.path, value: st.value }));
}

const PLACEHOLDER_TYPES: Readonly<Record<string, readonly string[]>> = { $patient: ['Reference'], $author: ['Reference'], $now: ['dateTime', 'instant'], $today: ['date', 'dateTime'] };
const LITERAL_TYPES = ['code', 'string', 'boolean', 'uri', 'canonical', 'id', 'decimal', 'integer', 'positiveInt', 'unsignedInt', 'markdown'];

/** The authoring problems of a record section: paths that name nothing, fields that do not fit their element, uncovered required elements. */
export function checkRecordSection(section: RecordSectionLike, pathPrefix: string): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const kind = kindIssue(section.resource);
  if (kind) return [{ path: `${pathPrefix}.resource`, message: kind }];
  if (isAdmittedKind(section.resource)) {
    const statusChoice = STATUS_CHOICES[section.resource];
    if (section.status && !statusChoice.values.includes(section.status)) issues.push({ path: `${pathPrefix}.status`, message: `a ${section.resource} is written as one of ${statusChoice.values.join(', ')}` });
    if (section.stamps?.length) issues.push({ path: `${pathPrefix}.stamps`, message: `the platform stamps a ${section.resource} itself (${recordStamps(section.resource, statusChoice.initial).map((st) => st.path).join(', ')}); stamps are declared only for a kind it has not admitted` });
  } else {
    // An open kind: the shape says what the platform sets. It must at least name the patient; every stamp lands on an element
    // of the right type; a placeholder on a Reference or a date element, a literal on a primitive.
    if (section.status) issues.push({ path: `${pathPrefix}.status`, message: `${section.resource} is not a kind the platform admits: set its status as a stamp (e.g. { path: status, value: active })` });
    const declared = section.stamps ?? [];
    if (!declared.some((st) => st.value === '$patient')) issues.push({ path: `${pathPrefix}.stamps`, message: `a ${section.resource} must name the patient: a stamp with value $patient on its patient or subject element` });
    for (const [i, st] of declared.entries()) {
      const at = `${pathPrefix}.stamps.${i}`;
      const el = resolveElement(section.resource, st.path);
      if (!el) {
        issues.push({ path: `${at}.path`, message: `${section.resource} has no element ${st.path}` });
        continue;
      }
      if (typeof st.value === 'string' && (STAMP_PLACEHOLDERS as readonly string[]).includes(st.value)) {
        const ok = PLACEHOLDER_TYPES[st.value] ?? [];
        if (!ok.includes(el.type)) issues.push({ path: `${at}.value`, message: `${st.value} needs ${ok.join(' or ')}; ${st.path} is ${el.type}` });
      } else if (!LITERAL_TYPES.includes(el.type)) {
        issues.push({ path: `${at}.value`, message: `a literal stamp sets a primitive element; ${st.path} is ${el.type}` });
      }
    }
    const stampPaths = declared.map((st) => st.path.replace(/\[\d+\]/g, ''));
    if (new Set(stampPaths).size !== stampPaths.length) issues.push({ path: `${pathPrefix}.stamps`, message: 'each stamped element at most once' });
  }
  const ids = section.fields.map((f) => f.id);
  if (new Set(ids).size !== ids.length) issues.push({ path: `${pathPrefix}.fields`, message: 'each field id at most once' });
  const paths = section.fields.map((f) => f.path);
  if (new Set(paths).size !== paths.length) issues.push({ path: `${pathPrefix}.fields`, message: 'each element path at most once' });
  const stamps = stampsOf(section);
  for (const [i, f] of section.fields.entries()) {
    const at = `${pathPrefix}.fields.${i}`;
    if (stamps.some((s) => s.path.replace(/\[\d+\]/g, '') === f.path.replace(/\[\d+\]/g, ''))) issues.push({ path: `${at}.path`, message: `${f.path} is set by the platform (${stamps.find((s) => s.path.replace(/\[\d+\]/g, '') === f.path.replace(/\[\d+\]/g, ''))!.value}); a form does not write it` });
    const el = resolveElement(section.resource, f.path);
    if (!el) {
      issues.push({ path: `${at}.path`, message: `${section.resource} has no element ${f.path}` });
      continue;
    }
    const enc = encodingFor(f.type, el.type);
    if (!enc) issues.push({ path: `${at}.type`, message: `a ${f.type} field cannot be written into ${f.path} (${el.type})` });
    if (enc === 'quantity' && !f.unit) issues.push({ path: `${at}.unit`, message: `${f.path} is a Quantity: give the unit` });
    if (f.type === 'code' && !f.codes?.length) issues.push({ path: `${at}.codes`, message: 'a code field lists the codings it may carry (from lookup_codes)' });
    if (f.type === 'choice' && !f.options?.length) issues.push({ path: `${at}.options`, message: 'a choice field lists its options' });
    if (f.type === 'choice' && (enc === 'coding' || enc === 'codeable_concept') && !f.system) issues.push({ path: `${at}.system`, message: `${f.path} wants a coding: name the system the options are codes of` });
    if (f.codes?.some((c) => !c.display)) issues.push({ path: `${at}.codes`, message: 'every code needs its display text — it is what the clinician picks from' });
    if (f.range && f.range.min !== undefined && f.range.max !== undefined && f.range.min >= f.range.max) issues.push({ path: `${at}.range`, message: 'min must be below max' });
  }
  for (const required of requiredCoreElements(section.resource, stamps)) {
    const covering = section.fields.find((f) => f.path.replace(/\[\d+\]/g, '').split('.')[0] === required);
    if (!covering) issues.push({ path: `${pathPrefix}.fields`, message: `a ${section.resource} needs ${required}: add a required field for it` });
    else if (!covering.required) issues.push({ path: `${pathPrefix}.fields.${section.fields.indexOf(covering)}.required`, message: `${required} is required on a ${section.resource}: mark the field required` });
  }
  return issues;
}

/** The runtime rules of a section — what goes into the write primitive's config and the form's props. */
export function recordRules(section: RecordSectionLike): RecordEntryRules {
  const fields: RecordFieldRule[] = section.fields.map((f) => {
    const el = resolveElement(section.resource, f.path);
    const as = (el && encodingFor(f.type, el.type)) ?? 'string';
    const rule: RecordFieldRule = {
      id: f.id,
      label: f.label,
      type: f.type,
      path: f.path,
      as,
      ...(f.required ? { required: true } : {}),
      ...(f.unit ? { unit: f.unit } : {}),
      ...(f.range ? { range: { ...(f.range.min !== undefined ? { min: f.range.min } : {}), ...(f.range.max !== undefined ? { max: f.range.max } : {}) } } : {}),
      ...(f.past_days !== undefined ? { past_days: f.past_days } : {}),
      ...(f.future_days !== undefined ? { future_days: f.future_days } : {}),
      ...((f.type === 'text' || f.type === 'long_text') ? { max_length: f.max_length ?? 2000 } : {}),
      ...(f.codes ? { codes: f.codes.map((c: Code) => ({ system: systemUrl(c.system), code: c.code, display: c.display ?? c.code })) } : {}),
      ...(f.options ? { options: f.options.map((o) => ({ code: o.code, display: o.display })) } : {}),
      ...(f.system ? { system: systemUrl(f.system) } : {}),
    };
    return rule;
  });
  return { resource: section.resource, fields, stamps: stampsOf(section) };
}

export { qualified };
