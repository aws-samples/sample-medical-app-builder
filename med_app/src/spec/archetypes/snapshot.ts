import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, type SpecIssue } from '../common';
import { REF, describeWindow, fhirQuery, node, observationsByCode, patientContextInput, patientIdentity, patientRead, windowContextInput } from '../blocks';

/**
 * APP-07 · Pre-consultation snapshot — the one-screen glance before the patient walks in: headline
 * counts (active problems, current medication, recent readings), then the compact lists behind
 * them, over a short window.
 */

export const SnapshotKnobsSchema = z.strictObject({
  vitals_codes: z.array(CodeSchema).min(1).describe('Observation codes counted as recent readings (vitals, key labs)'),
  window: WindowSchema.default('now-90d').describe('Short by design — what happened since the last visit'),
  rows: z.number().int().positive().max(50).default(8).describe('Rows in the readings table'),
  cards: z
    .strictObject({
      problems: z.boolean().default(true),
      medication: z.boolean().default(true),
      readings: z.boolean().default(true),
    })
    .default({ problems: true, medication: true, readings: true })
    .describe('Which headline counts to show'),
});

export type SnapshotKnobs = z.infer<typeof SnapshotKnobsSchema>;

export const snapshot: ArchetypeDef<SnapshotKnobs> = {
  id: 'APP-07',
  name: 'Pre-consultation snapshot',
  knobs: SnapshotKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    return Object.values(k.cards).some(Boolean) ? [] : [{ path: 'knobs.cards', message: 'show at least one headline count' }];
  },

  build(_ctx, k): BuildOutput {
    const since = describeWindow(k.window);
    const primitives = [
      patientRead(),
      fhirQuery({ id: 'p_conditions', binding: 'conditions', resource: 'Condition', params: { patient: REF.patient, 'clinical-status': 'active' } }),
      fhirQuery({ id: 'p_medications', binding: 'medications', resource: 'MedicationRequest', params: { patient: REF.patient, status: 'active' } }),
      observationsByCode({ id: 'p_vitals', binding: 'vitals', codes: k.vitals_codes, windowed: true, count: 100 }),
    ];

    const cards: LayoutNode[] = [];
    if (k.cards.problems) cards.push(node('StatCard', { label: 'Active problems', value: '$bindings.conditions.length', hint: 'On the problem list now' }));
    if (k.cards.medication) cards.push(node('StatCard', { label: 'Current medication', value: '$bindings.medications.length', hint: 'Active prescriptions' }));
    if (k.cards.readings) cards.push(node('StatCard', { label: `Readings, ${since.toLowerCase()}`, value: '$bindings.vitals.length', hint: 'Vitals and key labs recorded in the window', tone: 'accent' }));

    const readings = node('VitalsTable', { observations: '$bindings.vitals', title: `Recent readings — ${since.toLowerCase()}`, max_rows: k.rows, compact: true });
    const problems = node('ProblemList', { conditions: '$bindings.conditions', title: 'Active problems' });
    const medication = node('MedicationList', { medications: '$bindings.medications', title: 'Current medication' });

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity('banner', { compact: true }), node('Grid', { columns: cards.length }, cards), node('TwoColumn', { ratio: [7, 5] }, [readings, node('Section', undefined, [problems, medication])])],
      context_inputs: [patientContextInput(), windowContextInput(k.window)],
      data_categories: ['clinical_measurements', 'medication'],
    };
  },
};
