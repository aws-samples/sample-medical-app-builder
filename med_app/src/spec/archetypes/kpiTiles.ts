import { z } from 'zod';
import type { ArchetypeDef, BuildOutput } from '../archetype';
import type { SpecIssue } from '../common';
import { node } from '../blocks';
import { CohortKnobsSchema, cohortChecks, cohortHeadline } from './cohort';

/**
 * APP-10 · Cohort KPI tiles — the cohort register (APP-09) reduced to its headline numbers, for a
 * landing tile or a wall display: how many patients, how many above the threshold, what the
 * default role sees. Same membership, imaging and value knobs, no member table, so no per-patient rows.
 */

export const KpiTilesKnobsSchema = CohortKnobsSchema.omit({ table_title: true });

export type KpiTilesKnobs = z.infer<typeof KpiTilesKnobsSchema>;

export const kpiTiles: ArchetypeDef<KpiTilesKnobs> = {
  id: 'APP-10',
  name: 'Cohort KPI tiles',
  knobs: KpiTilesKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    return cohortChecks(k);
  },

  build(ctx, k): BuildOutput {
    const { primitives, cards } = cohortHeadline(ctx, k);
    return {
      intent_class: 'cohort_dashboard',
      patient_scope: 'cohort',
      primitives,
      children: [node('Grid', { columns: cards.length }, cards)],
      context_inputs: [],
      data_categories: k.imaging && !k.value ? ['imaging'] : k.imaging ? ['clinical_measurements', 'imaging'] : ['clinical_measurements'],
    };
  },
};
