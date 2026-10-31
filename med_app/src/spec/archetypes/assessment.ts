import { z } from 'zod';
import type { ArchetypeDef, BuildOutput } from '../archetype';
import type { SpecIssue } from '../common';
import { REF, fhirQuery, node, patientContextInput, patientIdentity, patientRead, questionnaireRead, questionnaireResponseSubmit, submitAction } from '../blocks';
import { FormSchema, compileForm, formExtraction, formIssues, questionnaireCanonical } from '../forms';

/**
 * APP-11 · Structured assessment — the first kind of app that writes to the record. The form is a Questionnaire:
 * one the record already holds (`questionnaire`, by canonical URL), or one designed in the conversation (`form`),
 * which the compiler turns into a FHIR Questionnaire the app carries — reviewed and signed with it, published to the
 * record with it. A completed response is written through an action (never at load) and the earlier submissions are
 * listed beside it. Reference manifest: manifests/htn-assessment.yaml.
 */

const STATE_KEY = 'assessment_response';
const ACTION_ID = 'submit_assessment';

export const AssessmentKnobsSchema = z.strictObject({
  questionnaire: z
    .string()
    .regex(/^(https?:\/\/|urn:)\S+$/, 'a canonical URL')
    .optional()
    .describe("Canonical URL of a Questionnaire (form definition) the record already holds — one of this deployment's available forms. Either this or `form`"),
  form: FormSchema.optional().describe('A form designed in this conversation — when the record has no form for what the clinician wants to document. Either this or `questionnaire`'),
  action_label: z.string().min(1).default('Submit assessment').describe('The submit button'),
  success_message: z.string().min(1).default('The assessment is now part of the patient record.').describe('Shown after a successful submission'),
  confirm: z.string().min(1).optional().describe('A confirmation asked before writing, for entries that should not be made lightly'),
  form_title: z.string().min(1).optional().describe("Heading above the form; defaults to the Questionnaire's own title"),
  submissions_title: z.string().min(1).default('Previous assessments').describe('Heading of the list of earlier submissions'),
  column_ratio: z.tuple([z.number().int().min(1).max(11), z.number().int().min(1).max(11)]).default([7, 5]).describe('Form vs list width, out of 12'),
});

export type AssessmentKnobs = z.infer<typeof AssessmentKnobsSchema>;

export const assessment: ArchetypeDef<AssessmentKnobs> = {
  id: 'APP-11',
  name: 'Structured assessment',
  knobs: AssessmentKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    if (k.column_ratio[0] + k.column_ratio[1] !== 12) issues.push({ path: 'knobs.column_ratio', message: 'the two widths must add up to 12' });
    if (!k.questionnaire && !k.form) issues.push({ path: 'knobs.questionnaire', message: 'name a Questionnaire the record holds (questionnaire), or design the form here (form)' });
    if (k.questionnaire && k.form) issues.push({ path: 'knobs.form', message: 'either a Questionnaire of the record or a form designed here, not both' });
    if (k.form) issues.push(...formIssues(k.form, 'knobs.form'));
    return issues;
  },

  build(ctx, k): BuildOutput {
    // The form the app renders: the record's, or the one it carries — same primitives either way, the URL decides.
    const own = k.form ? compileForm(k.form, { app_id: ctx.app.app_id, version: ctx.app.version, base: ctx.questionnaire_base, date: ctx.created_at, language: ctx.app.language }) : undefined;
    const url = k.questionnaire ?? questionnaireCanonical(ctx.questionnaire_base, ctx.app.app_id, k.form!.id);
    const primitives = [
      patientRead(),
      questionnaireRead({ url }),
      fhirQuery({ id: 'p_submissions', binding: 'submissions', resource: 'QuestionnaireResponse', params: { patient: REF.patient, questionnaire: url } }),
      questionnaireResponseSubmit({ url, stateKey: STATE_KEY, extract: k.form ? formExtraction(k.form) : undefined }),
    ];
    // The button reads the action's label; the component's own default is the knob's default, so only another label is written.
    const form = node('AssessmentForm', { questionnaire: '$bindings.questionnaire', action: ACTION_ID, state_key: STATE_KEY, title: k.form_title, submit_label: k.action_label === 'Submit assessment' ? undefined : k.action_label });
    const list = node('SubmissionList', { responses: '$bindings.submissions', title: k.submissions_title });

    return {
      intent_class: 'workflow',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity('banner', { compact: true }), node('TwoColumn', { ratio: [...k.column_ratio] }, [form, list])],
      context_inputs: [patientContextInput()],
      actions: [submitAction({ id: ACTION_ID, label: k.action_label, primitive: 'p_submit', success_message: k.success_message, confirm: k.confirm })],
      data_categories: ['clinical_documentation'],
      questionnaires: own ? [own] : undefined,
    };
  },
};
