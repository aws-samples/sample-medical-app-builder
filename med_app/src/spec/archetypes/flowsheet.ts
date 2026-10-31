import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, type SpecIssue } from '../common';
import { describeWindow, node, observationsByCode, patientContextInput, patientIdentity, patientRead, windowContextInput } from '../blocks';

/**
 * APP-03 · Observation flowsheet — the numbers, as tables: one or more groups of observation codes
 * (vitals, renal panel, …), each a tab when there are several, newest first, within a window.
 */

const GroupSchema = z.strictObject({
  label: z.string().min(1).describe('Tab label, e.g. "Vitals", "Renal panel"'),
  codes: z.array(CodeSchema).min(1).describe('Observation codes in this group'),
  title: z.string().min(1).optional().describe('Table heading; defaults to the label and the window'),
  rows: z.number().int().positive().max(500).default(40).describe('Rows shown (newest first)'),
});

export const FlowsheetKnobsSchema = z.strictObject({
  groups: z.array(GroupSchema).min(1).describe('Groups of observations, in display order; the first is the default tab'),
  window: WindowSchema.default('now-1y'),
  compact: z.boolean().default(true).describe('Dense rows'),
});

export type FlowsheetKnobs = z.infer<typeof FlowsheetKnobsSchema>;

export const flowsheet: ArchetypeDef<FlowsheetKnobs> = {
  id: 'APP-03',
  name: 'Observation flowsheet',
  knobs: FlowsheetKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const labels = new Set<string>();
    for (const [i, g] of k.groups.entries()) {
      if (labels.has(g.label)) issues.push({ path: `knobs.groups.${i}.label`, message: `duplicate group label "${g.label}"` });
      labels.add(g.label);
    }
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const primitives: BlockPrimitive[] = [patientRead()];
    const tables: { label: string; content: LayoutNode }[] = [];
    for (const [i, g] of k.groups.entries()) {
      const binding = k.groups.length === 1 ? 'observations' : `group_${i + 1}`;
      primitives.push(observationsByCode({ id: `p_${binding}`, binding, codes: g.codes, windowed: true, count: g.rows }));
      tables.push({ label: g.label, content: node('VitalsTable', { observations: `$bindings.${binding}`, title: g.title ?? `${g.label}, ${describeWindow(k.window).toLowerCase()}`, max_rows: g.rows, compact: k.compact ? true : undefined }) });
    }
    const body: LayoutNode =
      tables.length === 1 && tables[0]
        ? node('Section', undefined, [tables[0].content])
        : node('Tabs', { default_tab: tables[0]?.label }, tables.map((t) => node('Tab', { label: t.label }, [t.content])));

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity('banner', { compact: true }), body],
      context_inputs: [patientContextInput(), windowContextInput(k.window)],
      data_categories: ['clinical_measurements'],
    };
  },
};
