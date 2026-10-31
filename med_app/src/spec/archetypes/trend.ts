import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, identifier, type SpecIssue } from '../common';
import { REF, clean, describeWindow, fhirQuery, node, observationsByCode, patientContextInput, patientIdentity, patientRead, windowContextInput } from '../blocks';

/**
 * APP-02 · Longitudinal observation trend — one patient, one or more series over time against
 * reference lines, with a table of the latest readings and an optional role-gated clinical context.
 * Reference manifest: manifests/bp-trend.yaml.
 */

export const SeriesSchema = z
  .strictObject({
    label: z.string().min(1),
    code: z.string().min(1).optional().describe('Plot observations whose own code is this (single-value observations)'),
    component_code: z.string().min(1).optional().describe('Plot this component of a panel (e.g. 8480-6 inside a blood-pressure panel)'),
  })
  .refine((s) => (s.code ? 1 : 0) + (s.component_code ? 1 : 0) === 1, { message: 'a series names exactly one of code or component_code' });

export const TrendKnobsSchema = z.strictObject({
  codes: z.array(CodeSchema).min(1).describe('Observation codes requested from the record (the panel or the single-value codes)'),
  series: z.array(SeriesSchema).min(1).describe('What is plotted, in legend order'),
  thresholds: z.array(z.strictObject({ value: z.number(), label: z.string().min(1) })).default([]).describe('Horizontal reference lines'),
  unit: z.string().min(1).optional().describe('Axis unit label, e.g. mmHg'),
  by_side: z.boolean().default(false).describe('Plot each series once per side of the body (left, right, both — read from Observation.bodySite), so a side comparison is one chart; the readings table shows the side'),
  compare: z.boolean().default(false).describe('Under the chart, a table of the first and the latest value of each series (and side) with their dates and the difference — "first finding against today", as recorded, nothing graded'),
  window: WindowSchema.default('now-2y'),
  max_observations: z.number().int().positive().max(1000).default(500).describe('Most observations requested from the record'),
  chart_title: z.string().min(1).optional().describe('Defaults to the series labels and the window'),
  chart_height_px: z.number().int().min(160).max(800).default(380).describe('Chart height'),
  readings_title: z.string().min(1).default('Latest readings').describe('Heading of the readings table'),
  readings_rows: z.number().int().positive().max(100).default(10).describe('Rows in the readings table'),
  column_ratio: z.tuple([z.number().int().min(1).max(11), z.number().int().min(1).max(11)]).default([8, 4]).describe('Chart vs table width, out of 12'),
  conditions_section: z
    .strictObject({
      roles: z.array(identifier).min(1).describe('Only these roles see the section and issue the Condition search'),
      title: z.string().min(1).default('Clinical context'),
      description: z.string().min(1).optional(),
      list_title: z.string().min(1).default('Recorded conditions'),
    })
    .optional()
    .describe('A role-gated problem list beneath the chart'),
});

export type TrendKnobs = z.infer<typeof TrendKnobsSchema>;

export const trend: ArchetypeDef<TrendKnobs> = {
  id: 'APP-02',
  name: 'Longitudinal observation trend',
  knobs: TrendKnobsSchema,

  check(ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const roleIds = new Set(ctx.roles.map((r) => r.id));
    for (const [i, r] of (k.conditions_section?.roles ?? []).entries()) {
      if (!roleIds.has(r)) issues.push({ path: `knobs.conditions_section.roles.${i}`, message: `"${r}" is not a declared role` });
    }
    if (k.column_ratio[0] + k.column_ratio[1] !== 12) issues.push({ path: 'knobs.column_ratio', message: 'the two widths must add up to 12' });
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const primitives: BlockPrimitive[] = [patientRead(), observationsByCode({ id: 'p_series', binding: 'series', codes: k.codes, windowed: true, count: k.max_observations })];

    const chart = node('ObservationTimeline', {
      title: k.chart_title ?? `${k.series.map((s) => s.label).join(' / ')}, ${describeWindow(k.window).toLowerCase()}`,
      observations: '$bindings.series',
      unit: k.unit,
      height_px: k.chart_height_px,
      series: k.series.map((s) => (s.code ? { label: s.label, code: s.code } : { label: s.label, component_code: s.component_code })),
      thresholds: k.thresholds.length ? k.thresholds.map((t) => ({ value: t.value, label: t.label })) : undefined,
      split_by_side: k.by_side ? true : undefined,
    });
    const readings = node('VitalsTable', { title: k.readings_title, observations: '$bindings.series', max_rows: k.readings_rows, compact: true });

    const left = k.compare
      ? node('Grid', { columns: 1 }, [chart, node('ObservationComparison', clean({ observations: '$bindings.series', series: k.series.map((s) => (s.code ? { label: s.label, code: s.code } : { label: s.label, component_code: s.component_code })), split_by_side: k.by_side ? true : undefined, unit: k.unit }))])
      : chart;
    const children: LayoutNode[] = [patientIdentity('banner'), node('TwoColumn', { ratio: [...k.column_ratio] }, [left, readings])];

    if (k.conditions_section) {
      const s = k.conditions_section;
      primitives.push(fhirQuery({ id: 'p_conditions', binding: 'conditions', resource: 'Condition', params: { patient: REF.patient }, only_for_roles: s.roles }));
      children.push(node('Section', { title: s.title, description: s.description }, [node('ProblemList', { conditions: '$bindings.conditions', title: s.list_title })], s.roles));
    }

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children,
      context_inputs: [patientContextInput(), windowContextInput(k.window)],
      data_categories: ['clinical_measurements'],
    };
  },
};
