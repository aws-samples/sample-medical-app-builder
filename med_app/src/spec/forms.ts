import { z } from 'zod';
import { QUESTIONNAIRE_MAX_VALUE_EXTENSION, QUESTIONNAIRE_MIN_VALUE_EXTENSION, QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION, QUESTIONNAIRE_UNIT_EXTENSION, checkBoxControl, type QuestionnaireArtifact, type QuestionnaireArtifactItem, type QuestionnaireEnableWhen } from '../manifest/artifacts';
import { CodeSchema, type Code, type SpecIssue } from './common';
import { SYSTEM_ALIASES, systemUrl } from './terminology';

/**
 * A form designed in the drafting conversation — the questions a clinician wants asked, in their words — and its
 * compilation into the FHIR Questionnaire the app carries (manifest `artifacts.questionnaires`). The spec side speaks
 * the clinician's language (a "yes/no" question, a "choice" with options, a "heading"); the artifact side is FHIR R4,
 * which the form component renders and both validators check. The compiler is deterministic: the same form and the
 * same app version give the same Questionnaire, byte for byte.
 */

export const FORM_ITEM_TYPES = ['text', 'long_text', 'integer', 'decimal', 'boolean', 'date', 'choice', 'multiple_choice', 'heading', 'note'] as const;
export type FormItemType = (typeof FORM_ITEM_TYPES)[number];

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, 'a lowercase identifier (a-z, 0-9, _)');

const SYSTEM_ALIAS_NAMES = Object.keys(SYSTEM_ALIASES) as [string, ...string[]];

export const FormOptionSchema = z.strictObject({
  display: z.string().min(1).describe('The option as the clinician reads it'),
  code: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Stable code stored with the answer. Without a system: a lowercase identifier, derived from the display text when omitted. With a system: that system’s code (e.g. a SNOMED CT concept id from lookup_codes)'),
  system: z
    .union([z.enum(SYSTEM_ALIAS_NAMES), z.string().regex(/^(https?:\/\/|urn:)\S+$/, 'a system URL')])
    .optional()
    .describe('The code system of a coded option — snomed, loinc, icd10gm, ops or a URL — so the answer lands on the record as that coding, not as the form’s own word. Only with a code that is really in that system (lookup_codes), never invented'),
});

/** When a question is shown: the answer to another question of the form meets one condition. Several conditions must all hold. */
export const FormConditionSchema = z
  .strictObject({
    question: identifier.describe('The id of the question whose answer decides'),
    is: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Shown when that answer equals this: true/false for a yes/no, an option’s code (or display) for a choice, a number, a text, a date'),
    is_not: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Shown when that answer is anything but this'),
    answered: z.boolean().optional().describe('true: shown once that question has any answer; false: shown while it has none'),
    at_least: z.number().optional().describe('For a number: shown when the answer is this or more'),
    at_most: z.number().optional().describe('For a number: shown when the answer is this or less'),
  })
  .describe('One condition on another question’s answer');

export type FormCondition = z.infer<typeof FormConditionSchema>;

export interface FormItem {
  readonly id: string;
  readonly text: string;
  readonly type: FormItemType;
  readonly required?: boolean;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: z.infer<typeof FormOptionSchema>[];
  readonly show_when?: FormCondition | FormCondition[];
  readonly items?: FormItem[];
  readonly as_observation?: Code;
}

export const FormItemSchema: z.ZodType<FormItem> = z
  .strictObject({
    id: identifier.describe('Stable id of the question (its linkId); the answers are stored under it'),
    text: z.string().min(1).max(500).describe('The question as asked, or the heading / note text'),
    type: z
      .enum(FORM_ITEM_TYPES)
      .describe(
        'text (one line) · long_text (a paragraph) · integer · decimal · boolean (yes/no; required → a Yes/No choice, optional → a tick box) · date · choice (one of the options) · multiple_choice (any of the options, check boxes) · heading (a section with items) · note (explanatory text, not answered)'
      ),
    required: z.boolean().optional().describe('The form cannot be submitted without an answer'),
    unit: z.string().min(1).max(20).optional().describe('Unit of a number, e.g. kg, mmHg, cm'),
    min: z.number().optional().describe('The smallest value a number may take; an answer below it is refused on submission'),
    max: z.number().optional().describe('The largest value a number may take; an answer above it is refused on submission'),
    options: z.array(FormOptionSchema).min(2).max(30).optional().describe('The options of a choice or multiple_choice, in display order'),
    show_when: z
      .union([FormConditionSchema, z.array(FormConditionSchema).min(1).max(5)])
      .optional()
      .describe('Ask this only when another answer meets a condition — "How many falls?" only after "Has the patient fallen?" is yes. On a heading it shows or hides the whole section; on a note, the text. A list means every condition must hold. Hidden questions are not required and are not answered'),
    items: z.lazy(() => z.array(FormItemSchema).min(1)).optional().describe('The questions under a heading'),
    as_observation: CodeSchema.optional().describe(
      'For a number that is a measurement in its own right (pain NRS, a test score, a distance): the Observation code it is also recorded under on submission — a code from lookup_codes, never invented. The answer stays in the response and is written as an Observation too (unit from the item, category survey, derived from the response), so it charts and compares like any other measurement'
    ),
  })
  .describe('One question, heading or note of the form');

export const FormSchema = z
  .strictObject({
    id: identifier.describe('Stable id of the form within the app, e.g. falls_risk; the Questionnaire id becomes <app_id>-<id>'),
    title: z.string().min(1).max(120).describe('The form’s title, shown above it'),
    description: z.string().min(1).max(1000).optional().describe('What the form documents and when it is filled'),
    items: z.array(FormItemSchema).min(1).max(60).describe('The questions, headings and notes, in order'),
  })
  .describe('A form designed in this conversation: the platform compiles it into a FHIR Questionnaire the app carries, reviewed with the app and published with it');

export type FormSpec = z.infer<typeof FormSchema>;

const NUMBER_TYPES: readonly FormItemType[] = ['integer', 'decimal'];
const CHOICE_TYPES: readonly FormItemType[] = ['choice', 'multiple_choice'];

/** What the schema cannot say: ids unique across the form, options only on choices, units and ranges only on numbers, a heading has questions, a condition fits the question it looks at. */
export function formIssues(form: FormSpec, path: string): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const seen = new Set<string>();
  let questions = 0;
  const walk = (items: readonly FormItem[], at: string) => {
    items.forEach((item, i) => {
      const here = `${at}.items.${i}`;
      if (seen.has(item.id)) issues.push({ path: `${here}.id`, message: `"${item.id}" is used twice; every question needs its own id` });
      seen.add(item.id);
      if (CHOICE_TYPES.includes(item.type) && !item.options) issues.push({ path: `${here}.options`, message: 'a choice needs its options' });
      if (!CHOICE_TYPES.includes(item.type) && item.options) issues.push({ path: `${here}.options`, message: `options belong to a choice, not a ${item.type}` });
      if (item.unit && !NUMBER_TYPES.includes(item.type)) issues.push({ path: `${here}.unit`, message: 'a unit belongs to a number' });
      if (item.as_observation && !NUMBER_TYPES.includes(item.type)) issues.push({ path: `${here}.as_observation`, message: 'only a number is recorded as an Observation' });
      if ((item.min !== undefined || item.max !== undefined) && !NUMBER_TYPES.includes(item.type)) issues.push({ path: `${here}.min`, message: 'a range (min/max) belongs to a number' });
      if (item.min !== undefined && item.max !== undefined && item.min > item.max) issues.push({ path: `${here}.max`, message: `max (${item.max}) is below min (${item.min})` });
      if (item.type === 'integer' && [item.min, item.max].some((v) => v !== undefined && !Number.isInteger(v))) issues.push({ path: `${here}.min`, message: 'an integer’s range is whole numbers' });
      if (item.type === 'heading' && !item.items) issues.push({ path: `${here}.items`, message: 'a heading needs the questions under it' });
      if (item.type !== 'heading' && item.items) issues.push({ path: `${here}.items`, message: 'only a heading has items under it' });
      if (item.type === 'note' && item.required) issues.push({ path: `${here}.required`, message: 'a note is not answered, so it cannot be required' });
      if (item.options) {
        const codes = new Set<string>();
        for (const [j, option] of item.options.entries()) {
          const code = optionCode(option);
          if (codes.has(code)) issues.push({ path: `${here}.options.${j}`, message: `two options share the code "${code}"; give them distinct codes` });
          codes.add(code);
          if (option.system && !option.code) issues.push({ path: `${here}.options.${j}.code`, message: 'a coded option names its code in that system' });
          if (!option.system && option.code && !/^[a-z][a-z0-9_]*$/.test(option.code)) issues.push({ path: `${here}.options.${j}.code`, message: `"${option.code}" is not a lowercase identifier; a code from a terminology needs its system (snomed, loinc, …)` });
        }
      }
      if (item.type !== 'heading' && item.type !== 'note') questions += 1;
      if (item.items) walk(item.items, here);
    });
  };
  walk(form.items, path);
  if (questions === 0) issues.push({ path: `${path}.items`, message: 'the form has no question to answer — only headings and notes' });
  // Conditions, once every question is known: the question exists, is answerable, is not the item itself, and the value fits it.
  const byId = new Map<string, FormItem>();
  const index = (items: readonly FormItem[]) => items.forEach((i) => (byId.set(i.id, i), i.items && index(i.items)));
  index(form.items);
  const check = (items: readonly FormItem[], at: string) => {
    items.forEach((item, i) => {
      const here = `${at}.items.${i}`;
      conditionsOf(item).forEach((c, j) => {
        const where = `${here}.show_when${Array.isArray(item.show_when) ? `.${j}` : ''}`;
        const target = byId.get(c.question);
        if (!target) return void issues.push({ path: `${where}.question`, message: `no question "${c.question}" in this form` });
        if (target.id === item.id) return void issues.push({ path: `${where}.question`, message: 'a question cannot depend on its own answer' });
        if (item.items && descendantIds(item).has(target.id)) return void issues.push({ path: `${where}.question`, message: `"${c.question}" is inside this heading; a heading cannot depend on a question it hides` });
        if (target.type === 'heading' || target.type === 'note') return void issues.push({ path: `${where}.question`, message: `"${c.question}" is a ${target.type}; a condition needs an answered question` });
        const given = (['is', 'is_not', 'answered', 'at_least', 'at_most'] as const).filter((k) => c[k] !== undefined);
        if (given.length !== 1) return void issues.push({ path: where, message: 'one condition: is, is_not, answered, at_least or at_most' });
        const kind = given[0]!;
        if ((kind === 'at_least' || kind === 'at_most') && !NUMBER_TYPES.includes(target.type)) issues.push({ path: `${where}.${kind}`, message: `"${c.question}" is not a number` });
        if (kind === 'is' || kind === 'is_not') {
          const value = c[kind];
          if (target.type === 'boolean' && typeof value !== 'boolean') issues.push({ path: `${where}.${kind}`, message: `"${c.question}" is a yes/no: compare with true or false` });
          if (NUMBER_TYPES.includes(target.type) && typeof value !== 'number') issues.push({ path: `${where}.${kind}`, message: `"${c.question}" is a number` });
          if (CHOICE_TYPES.includes(target.type) && target.options && !target.options.some((o) => optionCode(o) === String(value) || o.display === String(value))) issues.push({ path: `${where}.${kind}`, message: `"${String(value)}" is not an option of "${c.question}"` });
        }
      });
      if (item.items) check(item.items, here);
    });
  };
  check(form.items, path);
  return issues;
}

export function conditionsOf(item: FormItem): FormCondition[] {
  return !item.show_when ? [] : Array.isArray(item.show_when) ? item.show_when : [item.show_when];
}

function descendantIds(item: FormItem, into = new Set<string>()): Set<string> {
  for (const i of item.items ?? []) {
    into.add(i.id);
    descendantIds(i, into);
  }
  return into;
}

/** The code an option is stored under: the one given, else the display text as a slug ("Walking stick" → walking_stick). */
export function optionCode(option: z.infer<typeof FormOptionSchema>): string {
  if (option.code) return option.code;
  const slug = option.display
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, (d) => `n${d}`);
  return slug || 'option';
}

/** `<base>/<id>` — stable across versions, like the Questionnaire id, so a published update replaces the form in place. */
export function questionnaireCanonical(base: string, appId: string, formId: string): string {
  return `${base.replace(/\/+$/, '')}/${questionnaireId(appId, formId)}`;
}

/**
 * The Questionnaire id: `app-falls-risk.falls-risk` — a FHIR id allows letters, digits, `-` and `.`, so the
 * underscores of the app and form ids become hyphens and the dot keeps the two apart.
 */
export function questionnaireId(appId: string, formId: string): string {
  return `${appId.replace(/_/g, '-')}.${formId.replace(/_/g, '-')}`;
}

/** The canonical namespace of a deployment's app-authored forms when the deployment names none. */
export function defaultQuestionnaireBase(hospitalId: string | undefined): string {
  return hospitalId ? `https://${hospitalId}.medapp.eu/Questionnaire` : 'https://medapp.eu/Questionnaire';
}

const FHIR_TYPE: Record<FormItemType, QuestionnaireArtifactItem['type']> = {
  text: 'string',
  long_text: 'text',
  integer: 'integer',
  decimal: 'decimal',
  boolean: 'boolean',
  date: 'date',
  choice: 'choice',
  multiple_choice: 'choice',
  heading: 'group',
  note: 'display',
};

const YES_NO: Record<'en' | 'de', readonly [string, string]> = { en: ['Yes', 'No'], de: ['Ja', 'Nein'] };

/** A required yes/no compiles to a Yes/No choice (see compileItem); a condition on it compares codings, not booleans. */
function isYesNoChoice(target: FormItem): boolean {
  return target.type === 'boolean' && Boolean(target.required);
}

function optionCoding(o: z.infer<typeof FormOptionSchema>): { system?: string; code: string; display: string } {
  return { ...(o.system ? { system: systemUrl(o.system) } : {}), code: optionCode(o), display: o.display };
}

/** The FHIR `enableWhen` of a condition — the answer typed after the question it looks at. */
function compileCondition(c: FormCondition, target: FormItem): QuestionnaireEnableWhen {
  const q = c.question;
  if (c.answered !== undefined) return { question: q, operator: 'exists', answerBoolean: c.answered };
  if (c.at_least !== undefined) return { question: q, operator: '>=', ...(target.type === 'integer' ? { answerInteger: c.at_least } : { answerDecimal: c.at_least }) };
  if (c.at_most !== undefined) return { question: q, operator: '<=', ...(target.type === 'integer' ? { answerInteger: c.at_most } : { answerDecimal: c.at_most }) };
  const operator = c.is !== undefined ? '=' : '!=';
  const value = c.is !== undefined ? c.is : c.is_not;
  if (isYesNoChoice(target)) return { question: q, operator, answerCoding: { code: value === true ? 'yes' : value === false ? 'no' : String(value) } };
  if (target.type === 'boolean') return { question: q, operator, answerBoolean: Boolean(value) };
  if (CHOICE_TYPES.includes(target.type)) {
    const option = target.options?.find((o) => optionCode(o) === String(value) || o.display === String(value));
    const coding = option ? optionCoding(option) : { code: String(value), display: String(value) };
    return { question: q, operator, answerCoding: { ...(coding.system ? { system: coding.system } : {}), code: coding.code } };
  }
  if (target.type === 'integer') return { question: q, operator, answerInteger: Number(value) };
  if (target.type === 'decimal') return { question: q, operator, answerDecimal: Number(value) };
  if (target.type === 'date') return { question: q, operator, answerDate: String(value) };
  return { question: q, operator, answerString: String(value) };
}

function rangeText(item: FormItem): string {
  if (item.min === undefined && item.max === undefined) return '';
  if (item.min !== undefined && item.max !== undefined) return `${item.min}–${item.max}`;
  return item.min !== undefined ? `≥ ${item.min}` : `≤ ${item.max}`;
}

function compileItem(item: FormItem, language: 'en' | 'de', byId: ReadonlyMap<string, FormItem>): QuestionnaireArtifactItem {
  const conditions = conditionsOf(item);
  const enableWhen = conditions.length ? { enableWhen: conditions.map((c) => compileCondition(c, byId.get(c.question) ?? { id: c.question, text: '', type: 'text' })), ...(conditions.length > 1 ? { enableBehavior: 'all' as const } : {}) } : {};
  // Two rules the renderer imposes (see docs/application-catalog.md, APP-11): a yes/no that must be answered is a
  // choice with Yes/No options — a required boolean is a checkbox that has to be ticked, so "No" could never be
  // submitted; and a multiple choice carries the check-box item control, or it renders as single-select radios.
  if (item.type === 'boolean' && item.required) {
    const [yes, no] = YES_NO[language];
    return { linkId: item.id, text: item.text, type: 'choice', required: true, answerOption: [{ valueCoding: { code: 'yes', display: yes } }, { valueCoding: { code: 'no', display: no } }], ...enableWhen };
  }
  // Key order is the manifest's byte order: the same form compiles to the same bytes. A unit and a range are both the
  // standard extensions (for whoever reads the response) and part of the question text (for whoever fills the form:
  // the renderer shows neither extension, and only the submission enforces the range).
  const suffix = [item.unit, rangeText(item)].filter(Boolean).join(', ');
  const extensions: NonNullable<QuestionnaireArtifactItem['extension']> = [];
  if (item.unit) extensions.push({ url: QUESTIONNAIRE_UNIT_EXTENSION as typeof QUESTIONNAIRE_UNIT_EXTENSION, valueCoding: { display: item.unit } });
  if (item.min !== undefined) extensions.push(item.type === 'integer' ? { url: QUESTIONNAIRE_MIN_VALUE_EXTENSION as typeof QUESTIONNAIRE_MIN_VALUE_EXTENSION, valueInteger: item.min } : { url: QUESTIONNAIRE_MIN_VALUE_EXTENSION as typeof QUESTIONNAIRE_MIN_VALUE_EXTENSION, valueDecimal: item.min });
  if (item.max !== undefined) extensions.push(item.type === 'integer' ? { url: QUESTIONNAIRE_MAX_VALUE_EXTENSION as typeof QUESTIONNAIRE_MAX_VALUE_EXTENSION, valueInteger: item.max } : { url: QUESTIONNAIRE_MAX_VALUE_EXTENSION as typeof QUESTIONNAIRE_MAX_VALUE_EXTENSION, valueDecimal: item.max });
  if (item.type === 'multiple_choice') extensions.push(checkBoxControl());
  // An answer that is also a measurement: SDC's observation-based extraction, said the standard way — the Observation code on
  // the item and the observationExtract marker — so whoever reads the Questionnaire knows which answers the record also holds
  // as Observations (the dispatcher writes them from the manifest's `extract`, which the same rule produces).
  if (item.as_observation) extensions.push({ url: QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION as typeof QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION, valueBoolean: true });
  return {
    linkId: item.id,
    text: suffix ? `${item.text} (${suffix})` : item.text,
    type: FHIR_TYPE[item.type],
    ...(item.required ? { required: true } : {}),
    ...(item.type === 'multiple_choice' ? { repeats: true } : {}),
    ...(item.options ? { answerOption: item.options.map((o) => ({ valueCoding: optionCoding(o) })) } : {}),
    ...(item.as_observation ? { code: [{ system: systemUrl(item.as_observation.system), code: item.as_observation.code, ...(item.as_observation.display ? { display: item.as_observation.display } : {}) }] } : {}),
    ...(extensions.length ? { extension: extensions } : {}),
    ...enableWhen,
    ...(item.items ? { item: item.items.map((i) => compileItem(i, language, byId)) } : {}),
  };
}

export interface CompileFormOptions {
  readonly app_id: string;
  readonly version: string;
  readonly base: string;
  /** ISO timestamp of the compile — the Questionnaire's `date`. */
  readonly date?: string;
  /** The app's display language — the Yes/No of a required yes/no question. */
  readonly language?: 'en' | 'de';
}

/** The FHIR Questionnaire the app carries for this form. */
export function compileForm(form: FormSpec, o: CompileFormOptions): QuestionnaireArtifact {
  return {
    resourceType: 'Questionnaire',
    id: questionnaireId(o.app_id, form.id),
    url: questionnaireCanonical(o.base, o.app_id, form.id),
    version: o.version,
    title: form.title,
    status: 'active',
    subjectType: ['Patient'],
    ...(o.date ? { date: o.date } : {}),
    ...(form.description ? { description: form.description } : {}),
    item: form.items.map((i) => compileItem(i, o.language ?? 'en', indexItems(form.items))),
  };
}

function indexItems(items: readonly FormItem[], into = new Map<string, FormItem>()): Map<string, FormItem> {
  for (const i of items) {
    into.set(i.id, i);
    if (i.items) indexItems(i.items, into);
  }
  return into;
}

/** What the submit primitive writes besides the response: one Observation per answer flagged `as_observation`. */
export interface ExtractRule {
  readonly link_id: string;
  /** `system|code` of the Observation. */
  readonly code: string;
  readonly display?: string;
  readonly unit?: string;
}

export function formExtraction(form: FormSpec): ExtractRule[] {
  const out: ExtractRule[] = [];
  const walk = (items: readonly FormItem[]) => {
    for (const item of items) {
      if (item.as_observation) out.push({ link_id: item.id, code: `${systemUrl(item.as_observation.system)}|${item.as_observation.code}`, ...(item.as_observation.display ? { display: item.as_observation.display } : {}), ...(item.unit ? { unit: item.unit } : {}) });
      if (item.items) walk(item.items);
    }
  };
  walk(form.items);
  return out;
}
