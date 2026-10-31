import { z } from 'zod';

/**
 * Artifacts an app carries with it — FHIR definitions the app is made of, as opposed to the patient data it reads.
 * Today: the Questionnaires behind its assessment forms, designed in the drafting conversation and compiled here, so
 * the form is reviewed, hashed and signed with the app that renders it. The manifest is the source of truth: the
 * renderer and the response validation read the form from here; at publish time the platform also writes it to the
 * hospital's FHIR server (best effort), so a QuestionnaireResponse on the record resolves for other systems too.
 *
 * The shape is a constrained FHIR R4 Questionnaire — the item types the form component renders and the validators on
 * both sides check, nothing the compiler does not emit. A hand-written questionnaire the record already holds is not
 * an artifact; it is referenced by URL as before.
 */

export const QUESTIONNAIRE_ITEM_TYPES = ['group', 'display', 'boolean', 'decimal', 'integer', 'date', 'string', 'text', 'choice'] as const;
export type QuestionnaireItemType = (typeof QUESTIONNAIRE_ITEM_TYPES)[number];

/** The FHIR extension that names the unit of a numeric answer (shown beside the field, kept on the response). */
export const QUESTIONNAIRE_UNIT_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/questionnaire-unit';
/** The item-control extension: a repeating choice renders as check boxes with it, as single-select radios without. */
export const QUESTIONNAIRE_ITEM_CONTROL_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl';
/** The range of a numeric answer — enforced on submission by both validators; the renderer shows the range in the question text. */
export const QUESTIONNAIRE_MIN_VALUE_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/minValue';
export const QUESTIONNAIRE_MAX_VALUE_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/maxValue';
/** SDC's observation-based extraction marker: the answer to this item is also written as an Observation with the item's `code`. */
export const QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION = 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-observationExtract';

export const ENABLE_WHEN_OPERATORS = ['exists', '=', '!=', '>', '<', '>=', '<='] as const;
export type EnableWhenOperator = (typeof ENABLE_WHEN_OPERATORS)[number];

const linkId = z.string().regex(/^[a-z][a-z0-9_]*$/, 'a lowercase identifier');
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'semver');

const AnswerOptionSchema = z.strictObject({
  valueCoding: z.strictObject({
    code: z.string().min(1),
    display: z.string().min(1),
    system: z.string().min(1).optional(),
  }),
});

const UnitExtensionSchema = z.strictObject({
  url: z.literal(QUESTIONNAIRE_UNIT_EXTENSION),
  valueCoding: z.strictObject({ display: z.string().min(1), code: z.string().min(1).optional(), system: z.string().min(1).optional() }),
});

const ItemControlExtensionSchema = z.strictObject({
  url: z.literal(QUESTIONNAIRE_ITEM_CONTROL_EXTENSION),
  valueCodeableConcept: z.strictObject({ coding: z.array(z.strictObject({ system: z.literal('http://hl7.org/fhir/questionnaire-item-control'), code: z.literal('check-box') })).length(1) }),
});

const MinValueExtensionSchema = z.union([
  z.strictObject({ url: z.literal(QUESTIONNAIRE_MIN_VALUE_EXTENSION), valueInteger: z.number().int() }),
  z.strictObject({ url: z.literal(QUESTIONNAIRE_MIN_VALUE_EXTENSION), valueDecimal: z.number() }),
]);
const MaxValueExtensionSchema = z.union([
  z.strictObject({ url: z.literal(QUESTIONNAIRE_MAX_VALUE_EXTENSION), valueInteger: z.number().int() }),
  z.strictObject({ url: z.literal(QUESTIONNAIRE_MAX_VALUE_EXTENSION), valueDecimal: z.number() }),
]);

const ObservationExtractExtensionSchema = z.strictObject({ url: z.literal(QUESTIONNAIRE_OBSERVATION_EXTRACT_EXTENSION), valueBoolean: z.literal(true) });

const ItemExtensionSchema = z.union([UnitExtensionSchema, ItemControlExtensionSchema, MinValueExtensionSchema, MaxValueExtensionSchema, ObservationExtractExtensionSchema]);

/** The code an extracted answer is recorded under (Questionnaire.item.code), a full coding. */
const ItemCodeSchema = z.strictObject({ system: z.string().min(1), code: z.string().min(1), display: z.string().min(1).optional() });

/**
 * `enableWhen`, as FHIR R4 has it and as the form component evaluates it: the item shows when the answer to `question`
 * meets the operator against the one typed value given. The compiler types the value after the question it looks at.
 */
const EnableWhenSchema = z
  .strictObject({
    question: z.string().min(1),
    operator: z.enum(ENABLE_WHEN_OPERATORS),
    answerBoolean: z.boolean().optional(),
    answerInteger: z.number().int().optional(),
    answerDecimal: z.number().optional(),
    answerString: z.string().min(1).optional(),
    answerDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date').optional(),
    answerCoding: z.strictObject({ system: z.string().min(1).optional(), code: z.string().min(1) }).optional(),
  })
  .superRefine((e, ctx) => {
    const given = ['answerBoolean', 'answerInteger', 'answerDecimal', 'answerString', 'answerDate', 'answerCoding'].filter((k) => (e as Record<string, unknown>)[k] !== undefined);
    if (given.length !== 1) ctx.addIssue({ code: 'custom', path: [], message: 'exactly one answer value' });
    if (e.operator === 'exists' && e.answerBoolean === undefined) ctx.addIssue({ code: 'custom', path: ['answerBoolean'], message: 'exists compares with a boolean' });
    if ((e.operator === '>' || e.operator === '<' || e.operator === '>=' || e.operator === '<=') && e.answerInteger === undefined && e.answerDecimal === undefined && e.answerDate === undefined)
      ctx.addIssue({ code: 'custom', path: ['operator'], message: `${e.operator} compares numbers or dates` });
  });

export type QuestionnaireEnableWhen = z.infer<typeof EnableWhenSchema>;

export interface QuestionnaireArtifactItem {
  readonly linkId: string;
  readonly text: string;
  readonly type: QuestionnaireItemType;
  readonly required?: boolean;
  readonly repeats?: boolean;
  readonly answerOption?: z.infer<typeof AnswerOptionSchema>[];
  /** For an answer also written as an Observation: the Observation code (with the observationExtract extension set). */
  readonly code?: z.infer<typeof ItemCodeSchema>[];
  readonly extension?: z.infer<typeof ItemExtensionSchema>[];
  readonly enableWhen?: QuestionnaireEnableWhen[];
  readonly enableBehavior?: 'all' | 'any';
  readonly item?: QuestionnaireArtifactItem[];
}

export const QuestionnaireItemSchema: z.ZodType<QuestionnaireArtifactItem> = z
  .strictObject({
    linkId,
    text: z.string().min(1),
    type: z.enum(QUESTIONNAIRE_ITEM_TYPES),
    required: z.boolean().optional(),
    repeats: z.boolean().optional(),
    answerOption: z.array(AnswerOptionSchema).min(1).optional(),
    code: z.array(ItemCodeSchema).length(1).optional(),
    extension: z.array(ItemExtensionSchema).min(1).optional(),
    enableWhen: z.array(EnableWhenSchema).min(1).optional(),
    enableBehavior: z.enum(['all', 'any']).optional(),
    item: z.lazy(() => z.array(QuestionnaireItemSchema).min(1)).optional(),
  })
  .superRefine((item, ctx) => {
    if (item.enableBehavior && !item.enableWhen) ctx.addIssue({ code: 'custom', path: ['enableBehavior'], message: 'enableBehavior belongs with enableWhen' });
    if (item.enableWhen?.some((e) => e.question === item.linkId)) ctx.addIssue({ code: 'custom', path: ['enableWhen'], message: 'an item cannot depend on its own answer' });
    const isNumber = item.type === 'integer' || item.type === 'decimal';
    const lo = item.extension?.find((e) => e.url === QUESTIONNAIRE_MIN_VALUE_EXTENSION) as { valueInteger?: number; valueDecimal?: number } | undefined;
    const hi = item.extension?.find((e) => e.url === QUESTIONNAIRE_MAX_VALUE_EXTENSION) as { valueInteger?: number; valueDecimal?: number } | undefined;
    if ((lo || hi) && !isNumber) ctx.addIssue({ code: 'custom', path: ['extension'], message: 'a range belongs to a number' });
    const low = lo?.valueInteger ?? lo?.valueDecimal;
    const high = hi?.valueInteger ?? hi?.valueDecimal;
    if (low !== undefined && high !== undefined && low > high) ctx.addIssue({ code: 'custom', path: ['extension'], message: `max (${high}) is below min (${low})` });
    if (item.type === 'choice' && !item.answerOption) ctx.addIssue({ code: 'custom', path: ['answerOption'], message: 'a choice needs its options' });
    if (item.type !== 'choice' && item.answerOption) ctx.addIssue({ code: 'custom', path: ['answerOption'], message: `options belong to a choice, not a ${item.type}` });
    if (item.type === 'group' && !item.item) ctx.addIssue({ code: 'custom', path: ['item'], message: 'a group needs items' });
    if (item.type !== 'group' && item.item) ctx.addIssue({ code: 'custom', path: ['item'], message: `only a group has items, not a ${item.type}` });
    if (item.type === 'display' && (item.required || item.repeats)) ctx.addIssue({ code: 'custom', path: ['required'], message: 'a display item is not answered' });
    for (const [i, ext] of (item.extension ?? []).entries()) {
      if (ext.url === QUESTIONNAIRE_UNIT_EXTENSION && item.type !== 'integer' && item.type !== 'decimal') ctx.addIssue({ code: 'custom', path: ['extension', i], message: 'a unit belongs to a number' });
      if (ext.url === QUESTIONNAIRE_ITEM_CONTROL_EXTENSION && !(item.type === 'choice' && item.repeats)) ctx.addIssue({ code: 'custom', path: ['extension', i], message: 'check boxes belong to a repeating choice' });
    }
    if (item.repeats && item.type !== 'choice') ctx.addIssue({ code: 'custom', path: ['repeats'], message: 'only a choice repeats (several answers)' });
  });

export const QuestionnaireArtifactSchema = z
  .strictObject({
    resourceType: z.literal('Questionnaire'),
    /** `<app_id>-<form_id>`: stable across versions, so a PUT at publish updates the form in place. */
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9\-.]{0,63}$/, 'a FHIR id'),
    /** The canonical URL a QuestionnaireResponse references; stable across versions like the id. */
    url: z.string().url(),
    /** The app version the form was compiled with. */
    version: semver,
    name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'a computable name').optional(),
    title: z.string().min(1),
    status: z.literal('active'),
    subjectType: z.array(z.literal('Patient')).min(1),
    date: z.string().optional(),
    publisher: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    item: z.array(QuestionnaireItemSchema).min(1),
  })
  .superRefine((q, ctx) => {
    const seen = new Set<string>();
    const walk = (items: readonly QuestionnaireArtifactItem[], path: (string | number)[]) => {
      items.forEach((it, i) => {
        if (seen.has(it.linkId)) ctx.addIssue({ code: 'custom', path: [...path, i, 'linkId'], message: `duplicate linkId "${it.linkId}"` });
        seen.add(it.linkId);
        if (it.item) walk(it.item, [...path, i, 'item']);
      });
    };
    walk(q.item, ['item']);
    if (![...seen].some((id) => id)) ctx.addIssue({ code: 'custom', path: ['item'], message: 'a form needs at least one item' });
    const conditions = (items: readonly QuestionnaireArtifactItem[], path: (string | number)[]) => {
      items.forEach((it, i) => {
        const inside = new Set<string>();
        const collect = (items: readonly QuestionnaireArtifactItem[]) => items.forEach((c) => (inside.add(c.linkId), c.item && collect(c.item)));
        if (it.item) collect(it.item);
        it.enableWhen?.forEach((e, j) => {
          if (!seen.has(e.question)) ctx.addIssue({ code: 'custom', path: [...path, i, 'enableWhen', j, 'question'], message: `enableWhen looks at "${e.question}", which is not an item of this form` });
          else if (inside.has(e.question)) ctx.addIssue({ code: 'custom', path: [...path, i, 'enableWhen', j, 'question'], message: `enableWhen looks at "${e.question}", which is inside the group it would hide` });
        });
        if (it.item) conditions(it.item, [...path, i, 'item']);
      });
    };
    conditions(q.item, ['item']);
    const answerable = (items: readonly QuestionnaireArtifactItem[]): boolean => items.some((it) => (it.type === 'group' ? answerable(it.item ?? []) : it.type !== 'display'));
    if (!answerable(q.item)) ctx.addIssue({ code: 'custom', path: ['item'], message: 'a form needs at least one question (not only headings and notes)' });
  });

export type QuestionnaireArtifact = z.infer<typeof QuestionnaireArtifactSchema>;

export const ArtifactsSchema = z.strictObject({
  questionnaires: z.array(QuestionnaireArtifactSchema).default([]),
});

export type Artifacts = z.infer<typeof ArtifactsSchema>;

/** The app-owned Questionnaire a primitive refers to — by canonical URL, or by id — or nothing when the form is the record's. */
export function findArtifactQuestionnaire(artifacts: Artifacts | undefined, ref: string): QuestionnaireArtifact | undefined {
  return artifacts?.questionnaires.find((q) => q.url === ref || q.id === ref);
}
/** A fresh check-box control extension (the schema's own type, so the compiler can place it on an item). */
export function checkBoxControl(): z.infer<typeof ItemControlExtensionSchema> {
  return { url: QUESTIONNAIRE_ITEM_CONTROL_EXTENSION, valueCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/questionnaire-item-control', code: 'check-box' }] } };
}
