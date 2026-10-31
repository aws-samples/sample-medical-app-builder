import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { CodeSchema, identifier, type SpecIssue } from '../common';
import { assessmentDue, cohortByCondition, describePhi, node, submitAction, taskStatusUpdate, taskWorklist } from '../blocks';
import { systemLabel } from '../terminology';

/**
 * APP-13 · Worklist — the open tasks of a ward or a team across patients: which patient, what is to be done, by when,
 * how urgent, who has taken it. Overdue first. A row can be started, completed or cancelled (a status change the
 * record keeps, attributed to whoever did it), and can open the patient in another app of this registry. Tasks are
 * FHIR Task resources — made by a `create_task` section of a composed page, or by another system that writes them —
 * with the author's own task vocabulary as their code (`urn:medapp:task`). Nothing is scheduled, reminded or
 * notified: the list shows what is open; people pick it up.
 *
 * A second source derives the work from the record instead of from Tasks: `assessment_due` lists who is due an
 * assessment — the members of a cohort (or everyone assessed before) against their latest answer to one
 * Questionnaire, every N days — never assessed first, then the longest overdue. Doing the assessment is what
 * completes the row; there is nothing to tick off.
 */

export const TaskCodeSchema = z.strictObject({
  code: identifier.describe('Stable id of the task kind, e.g. falls_screen'),
  display: z.string().min(1).max(80).describe('The task kind as the ward reads it, e.g. "Falls risk screen"'),
});

export type TaskCode = z.infer<typeof TaskCodeSchema>;

export const TASK_STATUSES = ['requested', 'in-progress', 'completed', 'cancelled', 'on-hold'] as const;

export const WorklistKnobsSchema = z.strictObject({
  source: z.enum(['tasks', 'assessment_due']).default('tasks').describe('tasks: open FHIR Tasks by kind · assessment_due: who is due an assessment, derived from the record (see `due`)'),
  due: z
    .strictObject({
      questionnaire: z.string().min(1).describe('Canonical URL of the form whose answers count — one the record holds, or an app-authored one (https://<hospital>.medapp.eu/Questionnaire/<app-id>.<form-id>)'),
      every_days: z.number().int().positive().max(3650).describe('How often it is due, in days from the last answer — 365 for a yearly screen'),
      label: z.string().min(1).max(80).describe('The assessment in words, e.g. "falls risk screen"'),
      cohort: z
        .strictObject({
          codes: z.array(CodeSchema).min(1).describe('Diagnosis codes that define who should have it'),
          clinical_status: z.enum(['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']).optional(),
          label: z.string().min(1).describe('The cohort in words, e.g. "active hypertension"'),
        })
        .optional()
        .describe('Who should have the assessment: a coded diagnosis; omitted = everyone who had it before (a repeat-screening list)'),
      upcoming_days: z.number().int().min(0).max(365).default(0).describe('Also list those due within this many days from today'),
    })
    .optional()
    .describe('What is due and for whom — required when source is assessment_due'),
  codes: z.array(TaskCodeSchema).max(20).default([]).describe('The task kinds the list is about; empty = every open task, whatever made it'),
  statuses: z.array(z.enum(TASK_STATUSES)).min(1).default(['requested', 'in-progress']).describe('Which tasks count as open here'),
  title: z.string().min(1).default('Open tasks').describe('Heading of the list'),
  complete: z.boolean().default(true).describe('Offer "Start" and "Complete" on each row (status changes the record keeps, attributed to whoever did them)'),
  cancel: z.boolean().default(false).describe('Offer "Cancel" on each row as well'),
  mine: z.boolean().default(true).describe('Offer a "Mine / Everyone" switch — mine = the tasks I have taken'),
  open_in: z
    .string()
    .regex(/^app_[a-z0-9_]+$/, 'app_<slug>')
    .optional()
    .describe('app_id of a published app in this registry each row links to, opened on that patient — only when the clinician names one; never guess an id'),
  cards: z
    .strictObject({
      open_label: z.string().min(1).optional().describe('Label of the card counting the open tasks'),
      overdue_label: z.string().min(1).optional().describe('Label of the card counting the overdue ones'),
      scope_card: z.boolean().default(true).describe('Show a card stating what identity fields the default role sees'),
    })
    .default({ scope_card: true }),
});

export type WorklistKnobs = z.infer<typeof WorklistKnobsSchema>;

/** The `$ui` key a worklist's row actions write and its primitive reads. */
export const WORKLIST_STATE_KEY = 'worklist_status';

export const worklist: ArchetypeDef<WorklistKnobs> = {
  id: 'APP-13',
  name: 'Worklist',
  knobs: WorklistKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const codes = k.codes.map((c) => c.code);
    if (new Set(codes).size !== codes.length) issues.push({ path: 'knobs.codes', message: 'each task kind at most once' });
    if (k.cancel && !k.complete) issues.push({ path: 'knobs.cancel', message: 'cancelling needs the row actions (complete: true)' });
    if (k.source === 'assessment_due' && !k.due) issues.push({ path: 'knobs.due', message: 'say what is due: the form (questionnaire), how often (every_days) and for whom (cohort, or everyone assessed before)' });
    if (k.source === 'tasks' && k.due) issues.push({ path: 'knobs.due', message: 'a due list needs source: assessment_due' });
    return issues;
  },

  build(ctx, k): BuildOutput {
    if (k.source === 'assessment_due' && k.due) return buildDueList(ctx, k, k.due);
    const primitives: BlockPrimitive[] = [taskWorklist({ codes: k.codes, statuses: k.statuses })];
    const actions = [];
    let statusAction: string | undefined;
    if (k.complete) {
      statusAction = 'update_task';
      primitives.push(taskStatusUpdate({ id: 'p_task_status', binding: 'task_updated', allowed: ['in-progress', 'completed', ...(k.cancel ? ['cancelled'] : [])], stateKey: WORKLIST_STATE_KEY, perPatient: false }));
      actions.push(submitAction({ id: statusAction, label: 'Update task', primitive: 'p_task_status', success_message: 'The task was updated.' }));
    }
    const kinds = k.codes.length ? k.codes.map((c) => c.display).join(', ') : 'every kind';
    const cards: LayoutNode[] = [
      node('StatCard', { label: k.cards.open_label ?? 'Open tasks', value: '$bindings.worklist.count', hint: `${k.statuses.join(' or ')} · ${kinds}`, tone: 'accent' }),
      node('StatCard', { label: k.cards.overdue_label ?? 'Overdue', value: '$bindings.worklist.overdue_count', hint: 'Due date before today', tone: 'alert' }),
    ];
    if (k.cards.scope_card) {
      const defaultRole = ctx.roles.find((r) => r.id === ctx.default_role) ?? ctx.roles[0];
      cards.push(node('StatCard', { label: 'Data scope', value: 'cohort', hint: describePhi(defaultRole?.phi_fields_visible ?? []) }));
    }
    const children: LayoutNode[] = [
      node('Grid', { columns: cards.length }, cards),
      node('Worklist', {
        rows: '$bindings.worklist.rows',
        title: k.title,
        status_action: statusAction,
        state_key: statusAction ? WORKLIST_STATE_KEY : undefined,
        cancel: k.cancel ? true : undefined,
        mine: k.mine ? undefined : false,
        open_in: k.open_in,
      }),
    ];
    return {
      intent_class: k.complete ? 'workflow' : 'cohort_dashboard',
      patient_scope: 'cohort',
      primitives,
      children,
      context_inputs: [],
      data_categories: ['tasks'],
      actions: actions.length ? actions : undefined,
    };
  },
};

type DueKnobs = NonNullable<WorklistKnobs['due']>;

/** The derived list: who is due the assessment — no row actions, the assessment itself completes a row. */
function buildDueList(ctx: Parameters<ArchetypeDef<WorklistKnobs>['build']>[0], k: WorklistKnobs, due: DueKnobs): BuildOutput {
  const primitives: BlockPrimitive[] = [];
  if (due.cohort) primitives.push(cohortByCondition({ codes: due.cohort.codes, clinical_status: due.cohort.clinical_status }));
  primitives.push(assessmentDue({ questionnaire: due.questionnaire, every_days: due.every_days, patients: due.cohort ? '$bindings.cohort.patients' : undefined, upcoming_days: due.upcoming_days }));
  const who = due.cohort ? `patients with ${due.cohort.label}` : 'everyone assessed before';
  const cards: LayoutNode[] = [
    node('StatCard', { label: k.cards.open_label ?? `Due a ${due.label}`, value: '$bindings.due.count', hint: `${who} · every ${due.every_days} days`, tone: 'accent' }),
    node('StatCard', { label: 'Never assessed', value: '$bindings.due.never_count', hint: due.cohort ? `${due.cohort.codes.map((c) => `${systemLabel(c)} ${c.code}`).join(', ')} on the problem list, no answer on record` : 'Not possible without a cohort: the list is those assessed before', tone: 'alert' }),
    node('StatCard', { label: k.cards.overdue_label ?? 'Overdue', value: '$bindings.due.overdue_count', hint: `Last answer more than ${due.every_days} days ago`, tone: 'alert' }),
  ];
  if (k.cards.scope_card) {
    const defaultRole = ctx.roles.find((r) => r.id === ctx.default_role) ?? ctx.roles[0];
    cards.push(node('StatCard', { label: 'Data scope', value: 'cohort', hint: describePhi(defaultRole?.phi_fields_visible ?? []) }));
  }
  return {
    intent_class: 'cohort_dashboard',
    patient_scope: 'cohort',
    primitives,
    children: [node('Grid', { columns: cards.length }, cards), node('AssessmentDueList', { rows: '$bindings.due.rows', title: k.title === 'Open tasks' ? `Due a ${due.label}` : k.title, label: due.label, every_days: due.every_days, open_in: k.open_in })],
    context_inputs: [],
    data_categories: ['clinical_documentation'],
  };
}
