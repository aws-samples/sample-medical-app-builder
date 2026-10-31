import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildContext, BuildOutput } from '../archetype';
import { CodeSchema, type SpecIssue } from '../common';
import { cohortByCondition, cohortLatestObservation, cohortWithImaging, describePhi, describeWindow, node } from '../blocks';
import { systemLabel } from '../terminology';

/**
 * APP-09 · Condition-defined cohort register — everyone with a coded diagnosis, optionally narrowed to those with
 * imaging studies (a modality, a window, a minimum count), their latest value of one observation, headline counts
 * and a flag at a threshold. Reference manifest: manifests/hypertension-cohort.yaml.
 */

const MODALITY = z.string().regex(/^[A-Z]{2,4}$/, 'a DICOM modality code such as CT, MR, US, DX');

export const CohortKnobsSchema = z.strictObject({
  condition: z.strictObject({
    codes: z.array(CodeSchema).min(1).describe('Diagnosis codes that define membership'),
    clinical_status: z.enum(['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']).optional(),
    label: z.string().min(1).describe('The condition in words, e.g. "active hypertension"'),
  }).describe('Which patients belong: a coded diagnosis, optionally restricted by clinical status'),
  imaging: z
    .strictObject({
      modalities: z.array(MODALITY).describe('DICOM modality codes a study must carry — CT, MR, US, DX, …; empty: any imaging study'),
      within: z
        .string()
        .regex(/^now-\d+[dmy]$/, 'now-<n>d|m|y')
        .optional()
        .describe('Only studies started within this window, e.g. now-2y; omitted: ever'),
      min_studies: z.number().int().positive().default(1).describe('How many matching studies a member needs to stay in the cohort'),
      label: z.string().min(1).describe('The imaging in words, e.g. "a CT scan" or "an MRI in the last two years"'),
      card_label: z.string().min(1).optional().describe('Label of the headline card counting the members with imaging'),
      open_in: z
        .string()
        .regex(/^app_[a-z0-9_]+$/, 'app_<slug>')
        .optional()
        .describe('app_id of a published imaging app (APP-05) in this registry that each row links to, opened on that patient — only when the clinician names one; never guess an id, the register lists the studies regardless'),
    })
    .optional()
    .describe('Narrow membership to patients with imaging studies: by modality, window and minimum count. The table gains the study count and the latest study per member; the studies are named, never retrieved'),
  value: z
    .strictObject({
      codes: z.array(CodeSchema).min(1).describe('The observation (or panel) whose latest value is shown per member'),
      component_code: z.string().min(1).optional().describe('Compare this component of the panel against the threshold'),
      name: z.string().min(1).optional().describe('The compared value in words, e.g. "systolic"'),
      unit: z.string().min(1).optional(),
      threshold: z.number().optional().describe('Flag members at or above this value'),
      label: z.string().min(1).default('Latest value').describe('Column label in the member table'),
      range: z
        .strictObject({
          min: z.number().optional().describe("Lower bound of the slider; omitted: the cohort's lowest value"),
          max: z.number().optional().describe("Upper bound of the slider; omitted: the cohort's highest value"),
          step: z.number().positive().default(1).describe('Slider step, in the unit of the value'),
          default: z.tuple([z.number(), z.number()]).optional().describe('The range selected when the app opens, e.g. [140, 180]; omitted: the whole span'),
          label: z.string().min(1).optional().describe('Heading of the slider, e.g. "Systolic range"'),
          card_label: z.string().min(1).optional().describe('Label of the headline card counting the members in range'),
        })
        .optional()
        .describe('An adjustable range over the compared value: a two-handle slider filters the member table and counts the members in range, live, without reading the record again'),
    })
    .optional()
    .describe('Which observation is shown per member, the threshold that flags a member, and an optional adjustable range. Omit it for a register defined by diagnosis and imaging alone'),
  cards: z
    .strictObject({
      count_label: z.string().min(1).optional(),
      count_hint: z.string().min(1).optional(),
      threshold_label: z.string().min(1).optional(),
      threshold_hint: z.string().min(1).optional(),
      scope_card: z.boolean().default(true).describe('Show a card stating what identity fields the default role sees'),
    })
    .default({ scope_card: true })
    .describe('Wording of the headline cards; defaults are derived from condition, imaging and value'),
  table_title: z.string().min(1).default('Cohort members').describe('Heading of the member table'),
});

export type CohortKnobs = z.infer<typeof CohortKnobsSchema>;

/** The `$ui` key a cohort's RangeFilter writes and its table and range card read. */
export const RANGE_KEY = 'cohort_range';

/** What must hold for the membership and value knobs — shared with the KPI tiles (APP-10), which take the same knobs. */
export function cohortChecks(k: Omit<CohortKnobs, 'table_title'>): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!k.value && !k.imaging) {
    issues.push({ path: 'knobs.value', message: 'give the observation shown per member (value), the imaging that narrows the cohort (imaging), or both' });
  }
  if (k.value?.threshold !== undefined && !k.value.name && !k.cards.threshold_label) {
    issues.push({ path: 'knobs.value.name', message: 'name the compared value (e.g. "systolic") or give cards.threshold_label' });
  }
  const r = k.value?.range;
  if (r) {
    if (r.min !== undefined && r.max !== undefined && r.min >= r.max) issues.push({ path: 'knobs.value.range.max', message: 'the upper bound must be above the lower bound' });
    if (r.default && r.default[0] > r.default[1]) issues.push({ path: 'knobs.value.range.default', message: 'the default range must be [low, high]' });
    if (r.default && r.min !== undefined && r.default[0] < r.min) issues.push({ path: 'knobs.value.range.default', message: "the default range starts below the slider's lower bound" });
    if (r.default && r.max !== undefined && r.default[1] > r.max) issues.push({ path: 'knobs.value.range.default', message: "the default range ends above the slider's upper bound" });
  }
  return issues;
}

export const cohort: ArchetypeDef<CohortKnobs> = {
  id: 'APP-09',
  name: 'Condition-defined cohort register',
  knobs: CohortKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    return cohortChecks(k);
  },

  build(ctx, k): BuildOutput {
    const { primitives, cards } = cohortHeadline(ctx, k);
    const children: LayoutNode[] = [];
    // The member table: the latest-value rows when a value is asked for, the imaging rows otherwise; with both, the
    // imaging rows are joined onto the value rows by patient, so one line per member carries the value and the study.
    const table: Record<string, unknown> = { title: k.table_title };
    if (k.value) {
      table.rows = '$bindings.latest.rows';
      table.value_label = k.value.label;
    }
    if (k.imaging) {
      table.imaging = '$bindings.imaging.rows';
      if (k.imaging.open_in) table.open_in = k.imaging.open_in;
    }
    const r = k.value?.range;
    if (k.value && r) {
      // The range is a view over data fetched once: the slider writes $ui.cohort_range, the card and the table read it.
      const what = k.value.name ?? 'value';
      // Beside the count and the threshold card, before the scope card: the numbers first, the policy last.
      cards.splice(
        cards.length - (k.cards.scope_card ? 1 : 0),
        0,
        node('CohortRangeCard', {
          label: r.card_label ?? `Latest ${what} in range`,
          rows: '$bindings.latest.rows',
          range: `$ui.${RANGE_KEY}`,
          unit: k.value.unit,
          hint: 'Members whose latest value lies in the selected range',
        })
      );
      children.push(node('Grid', { columns: cards.length }, cards));
      children.push(
        node('RangeFilter', {
          selection_key: RANGE_KEY,
          label: r.label ?? `Latest ${what}`,
          unit: k.value.unit,
          min: r.min,
          max: r.max,
          step: r.step,
          initial: r.default,
          rows: '$bindings.latest.rows',
          hint: 'The range filters the table and the count; nothing is read again.',
        })
      );
      table.range = `$ui.${RANGE_KEY}`;
      table.unit = k.value.unit;
    } else {
      children.push(node('Grid', { columns: cards.length }, cards));
    }
    children.push(node('CohortTable', table));
    return {
      intent_class: 'cohort_dashboard',
      patient_scope: 'cohort',
      primitives,
      children,
      context_inputs: [],
      data_categories: k.imaging && !k.value ? ['imaging'] : k.imaging ? ['clinical_measurements', 'imaging'] : ['clinical_measurements'],
    };
  },
};

/** The imaging criterion as a card label — "With a CT scan", "With an MRI in the last two years" — from the author's words for it. */
export function describeImaging(imaging: NonNullable<CohortKnobs['imaging']>): string {
  return `With ${imaging.label}`;
}

/** The criterion as the record sees it — "At least one CT study on record", "At least two CT or MR studies, last two years". */
export function imagingHint(imaging: NonNullable<CohortKnobs['imaging']>): string {
  const mods = imaging.modalities.length ? `${imaging.modalities.join(' or ')} ` : '';
  const count = imaging.min_studies > 1 ? `At least ${imaging.min_studies} ${mods}studies` : `At least one ${mods}study`;
  return imaging.within ? `${count}, ${describeWindow(imaging.within).toLowerCase()}` : `${count} on record`;
}

/** Membership (narrowed by imaging when asked) + latest value, and the headline cards over them — shared with the KPI tiles (APP-10). */
export function cohortHeadline(ctx: BuildContext, k: Omit<CohortKnobs, 'table_title'>): { primitives: BlockPrimitive[]; cards: LayoutNode[] } {
  const primitives: BlockPrimitive[] = [cohortByCondition({ codes: k.condition.codes, clinical_status: k.condition.clinical_status })];
  if (k.imaging) {
    primitives.push(cohortWithImaging({ modalities: k.imaging.modalities, since: k.imaging.within, min_studies: k.imaging.min_studies === 1 ? undefined : k.imaging.min_studies }));
  }
  const threshold = k.value?.threshold !== undefined ? { component_code: k.value.component_code, value: k.value.threshold } : undefined;
  if (k.value) {
    // `component_code` on the primitive itself (not only inside the threshold): a range filter compares the same component.
    // After an imaging step the values are read for the narrowed cohort only — exactly the members the table lists.
    primitives.push(
      cohortLatestObservation({
        patients: k.imaging ? '$bindings.imaging.patients' : undefined,
        codes: k.value.codes,
        component_code: threshold ? undefined : k.value.component_code,
        threshold,
      })
    );
  }

  const cards: LayoutNode[] = [
    node('StatCard', {
      label: k.cards.count_label ?? `Patients with ${k.condition.label}`,
      value: '$bindings.cohort.count',
      hint: k.cards.count_hint ?? `${k.condition.codes.map((c) => `${systemLabel(c)} ${c.code}`).join(', ')} on the problem list`,
      tone: 'accent',
    }),
  ];
  if (k.imaging) {
    cards.push(
      node('StatCard', {
        label: k.imaging.card_label ?? describeImaging(k.imaging),
        value: '$bindings.imaging.count',
        hint: imagingHint(k.imaging),
        tone: 'accent',
      })
    );
  }
  if (k.value && threshold) {
    const unit = k.value.unit ? ` ${k.value.unit}` : '';
    cards.push(
      node('StatCard', {
        label: k.cards.threshold_label ?? `Latest ${k.value.name} ≥ ${threshold.value}${unit}`,
        value: '$bindings.latest.above_threshold_count',
        hint: k.cards.threshold_hint ?? 'Most recent value per patient',
        tone: 'alert',
      })
    );
  }
  if (k.cards.scope_card) {
    const defaultRole = ctx.roles.find((r) => r.id === ctx.default_role) ?? ctx.roles[0];
    cards.push(node('StatCard', { label: 'Data scope', value: 'cohort', hint: describePhi(defaultRole?.phi_fields_visible ?? []) }));
  }
  return { primitives, cards };
}
