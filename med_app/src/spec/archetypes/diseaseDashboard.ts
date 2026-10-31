import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, type Code, type SpecIssue } from '../common';
import { REF, describeWindow, fhirQuery, node, observationsByCode, patientContextInput, patientIdentity, patientRead, windowContextInput } from '../blocks';
import { qualified } from '../terminology';
import { SeriesSchema } from './trend';

/**
 * APP-06 · Disease-specific follow-up dashboard — one patient, one chronic condition: the values that
 * matter over time against guideline lines, the therapy for it, and the related problems. The
 * catalog's templates (hypertension, diabetes, CKD) fill every clinical knob from one word; anything
 * given explicitly wins over the template. Threshold lines are visual only — no flags, no scores — and
 * each template names the guideline its lines come from, shown under the chart for the reviewer.
 *
 * A template's conditions carry both codings the platform meets — SNOMED CT (the synthetic record) and
 * ICD-10-GM (the hospital's) — as categories where the hierarchy allows (`I10` covers every I10.x), and
 * its therapy is ATC classes (`C09A` ACE inhibitors) rather than named drugs; the executors match a class
 * or category against every code under it (fhirHelpers.ts / fhir_source.py).
 */

const ThresholdSchema = z.strictObject({ value: z.number(), label: z.string().min(1) });

export const DISEASE_TEMPLATE_IDS = ['hypertension_follow_up', 'diabetes_follow_up', 'ckd_monitoring'] as const;
export type DiseaseTemplateId = (typeof DISEASE_TEMPLATE_IDS)[number];

interface Template {
  readonly label: string;
  readonly codes: readonly Code[];
  readonly series: readonly z.infer<typeof SeriesSchema>[];
  readonly unit: string;
  readonly thresholds: readonly z.infer<typeof ThresholdSchema>[];
  /** Where the threshold lines come from — shown under the chart, so the reviewer sees the guideline, not just a number. */
  readonly source: string;
  readonly medication_codes: readonly Code[];
  readonly condition_codes: readonly Code[];
}

/** Mirrors the templates in docs/application-catalog.yaml (APP-06); the catalog test keeps them aligned. */
export const DISEASE_TEMPLATES: Readonly<Record<DiseaseTemplateId, Template>> = {
  hypertension_follow_up: {
    label: 'Hypertension follow-up',
    codes: [
      { system: 'loinc', code: '8480-6', display: 'Systolic blood pressure' },
      { system: 'loinc', code: '8462-4', display: 'Diastolic blood pressure' },
    ],
    series: [
      { label: 'Systolic', component_code: '8480-6' },
      { label: 'Diastolic', component_code: '8462-4' },
    ],
    unit: 'mmHg',
    thresholds: [
      { value: 140, label: 'Systolic ≥ 140' },
      { value: 90, label: 'Diastolic ≥ 90' },
    ],
    source: 'ESC/ESH 2023 arterial hypertension guideline: office blood pressure ≥ 140/90 mmHg',
    medication_codes: [
      { system: 'atc', code: 'C09A', display: 'ACE inhibitors' },
      { system: 'atc', code: 'C09C', display: 'Angiotensin II receptor blockers' },
      { system: 'atc', code: 'C08CA', display: 'Dihydropyridine calcium channel blockers' },
      { system: 'atc', code: 'C03', display: 'Diuretics' },
      { system: 'atc', code: 'C07', display: 'Beta blocking agents' },
    ],
    condition_codes: [
      { system: 'snomed', code: '38341003', display: 'Hypertension' },
      { system: 'icd10gm', code: 'I10', display: 'Essential (primary) hypertension' },
    ],
  },
  diabetes_follow_up: {
    label: 'Diabetes follow-up',
    codes: [
      { system: 'loinc', code: '4548-4', display: 'Hemoglobin A1c' },
      { system: 'loinc', code: '29463-7', display: 'Body weight' },
    ],
    series: [{ label: 'HbA1c', code: '4548-4' }],
    unit: '%',
    thresholds: [{ value: 7, label: 'HbA1c ≥ 7 %' }],
    source: 'ADA Standards of Care in Diabetes: HbA1c goal < 7 % for most non-pregnant adults',
    medication_codes: [
      { system: 'atc', code: 'A10B', display: 'Blood glucose lowering drugs, excl. insulins' },
      { system: 'atc', code: 'A10A', display: 'Insulins and analogues' },
    ],
    condition_codes: [
      { system: 'snomed', code: '44054006', display: 'Type 2 diabetes mellitus' },
      { system: 'icd10gm', code: 'E11', display: 'Type 2 diabetes mellitus' },
    ],
  },
  ckd_monitoring: {
    label: 'CKD monitoring',
    codes: [{ system: 'loinc', code: '33914-3', display: 'eGFR' }],
    series: [{ label: 'eGFR', code: '33914-3' }],
    unit: 'mL/min/1.73m²',
    thresholds: [
      { value: 60, label: 'eGFR 60' },
      { value: 45, label: 'eGFR 45' },
    ],
    source: 'KDIGO 2024 CKD guideline: eGFR 60 and 45 mL/min/1.73 m² bound the G3a and G3b stages',
    medication_codes: [
      { system: 'atc', code: 'C09A', display: 'ACE inhibitors' },
      { system: 'atc', code: 'C09C', display: 'Angiotensin II receptor blockers' },
      { system: 'atc', code: 'C03C', display: 'High-ceiling (loop) diuretics' },
    ],
    condition_codes: [
      { system: 'snomed', code: '433144002', display: 'Chronic kidney disease stage 3' },
      { system: 'icd10gm', code: 'N18', display: 'Chronic kidney disease' },
    ],
  },
};

export const DiseaseDashboardKnobsSchema = z.strictObject({
  template: z.enum(DISEASE_TEMPLATE_IDS).optional().describe('A catalog template that fills codes, series, thresholds, unit, medication classes and condition codes; anything given explicitly overrides it'),
  codes: z.array(CodeSchema).min(1).optional().describe('Observation codes requested from the record (required unless a template is given)'),
  series: z.array(SeriesSchema).min(1).optional().describe('What is plotted, in legend order (required unless a template is given)'),
  thresholds: z.array(ThresholdSchema).optional().describe('Guideline lines on the chart — visual only'),
  thresholds_source: z.string().min(1).max(200).optional().describe('Where the lines come from (guideline and value), shown under the chart; template default'),
  unit: z.string().min(1).optional().describe('Axis unit label'),
  window: WindowSchema.default('now-2y'),
  chart_title: z.string().min(1).optional().describe('Defaults to the series labels and the window'),
  chart_height_px: z.number().int().min(160).max(800).default(380),
  readings_title: z.string().min(1).default('Latest readings'),
  readings_rows: z.number().int().positive().max(100).default(8).describe('Rows in the readings table'),
  medication: z
    .strictObject({
      codes: z.array(CodeSchema).optional().describe('ATC classes to list; template default; empty list = all active medication'),
      status: z.enum(['active', 'all']).default('active'),
      title: z.string().min(1).default('Current therapy'),
    })
    .default({ status: 'active', title: 'Current therapy' })
    .describe('The medication list beside the problems'),
  conditions: z
    .strictObject({
      codes: z.array(CodeSchema).optional().describe('Diagnosis codes to list; template default; empty list = every active problem'),
      title: z.string().min(1).default('Related conditions'),
    })
    .default({ title: 'Related conditions' })
    .describe('The problem list beside the medication'),
});

export type DiseaseDashboardKnobs = z.infer<typeof DiseaseDashboardKnobsSchema>;

interface Resolved {
  readonly codes: readonly Code[];
  readonly series: readonly z.infer<typeof SeriesSchema>[];
  readonly thresholds: readonly z.infer<typeof ThresholdSchema>[];
  readonly source: string | undefined;
  readonly unit: string | undefined;
  readonly medication_codes: readonly Code[];
  readonly condition_codes: readonly Code[];
}

/** Explicit knobs win; the template fills the rest; no template and nothing explicit = empty. Own thresholds take their own source (or none). */
export function resolveTemplate(k: DiseaseDashboardKnobs): Resolved {
  const t = k.template ? DISEASE_TEMPLATES[k.template] : undefined;
  return {
    codes: k.codes ?? t?.codes ?? [],
    series: k.series ?? t?.series ?? [],
    thresholds: k.thresholds ?? t?.thresholds ?? [],
    source: k.thresholds_source ?? (k.thresholds ? undefined : t?.source),
    unit: k.unit ?? t?.unit,
    medication_codes: k.medication.codes ?? t?.medication_codes ?? [],
    condition_codes: k.conditions.codes ?? t?.condition_codes ?? [],
  };
}

export const diseaseDashboard: ArchetypeDef<DiseaseDashboardKnobs> = {
  id: 'APP-06',
  name: 'Disease-specific follow-up dashboard',
  knobs: DiseaseDashboardKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const r = resolveTemplate(k);
    if (!r.codes.length) issues.push({ path: 'knobs.codes', message: `give a template (${DISEASE_TEMPLATE_IDS.join(', ')}) or the observation codes to chart` });
    if (!r.series.length) issues.push({ path: 'knobs.series', message: 'give a template or the series to plot' });
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const r = resolveTemplate(k);
    const primitives: BlockPrimitive[] = [patientRead(), observationsByCode({ id: 'p_series', binding: 'series', codes: r.codes, windowed: true, count: 500 })];

    const medParams: Record<string, string> = { patient: REF.patient };
    if (k.medication.status === 'active') medParams['status'] = 'active';
    if (r.medication_codes.length) medParams['code'] = r.medication_codes.map(qualified).join(',');
    primitives.push(fhirQuery({ id: 'p_medications', binding: 'medications', resource: 'MedicationRequest', params: medParams }));

    const condParams: Record<string, string> = { patient: REF.patient, 'clinical-status': 'active' };
    if (r.condition_codes.length) condParams['code'] = r.condition_codes.map(qualified).join(',');
    primitives.push(fhirQuery({ id: 'p_conditions', binding: 'conditions', resource: 'Condition', params: condParams }));

    const chart = node('ObservationTimeline', {
      title: k.chart_title ?? `${r.series.map((s) => s.label).join(' / ')}, ${describeWindow(k.window).toLowerCase()}`,
      observations: '$bindings.series',
      unit: r.unit,
      height_px: k.chart_height_px,
      series: r.series.map((s) => (s.code ? { label: s.label, code: s.code } : { label: s.label, component_code: s.component_code })),
      thresholds: r.thresholds.length ? r.thresholds.map((t) => ({ value: t.value, label: t.label })) : undefined,
      caption: r.thresholds.length && r.source ? `Reference lines: ${r.source}.` : undefined,
    });
    const readings = node('VitalsTable', { title: k.readings_title, observations: '$bindings.series', max_rows: k.readings_rows, compact: true });
    const medication = node('MedicationList', { medications: '$bindings.medications', title: k.medication.title });
    const conditions = node('ProblemList', { conditions: '$bindings.conditions', title: k.conditions.title });

    const children: LayoutNode[] = [patientIdentity('banner'), node('TwoColumn', { ratio: [8, 4] }, [chart, readings]), node('TwoColumn', { ratio: [6, 6] }, [medication, conditions])];

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children,
      context_inputs: [patientContextInput(), windowContextInput(k.window)],
      data_categories: ['clinical_measurements', 'medication'],
    };
  },
};
