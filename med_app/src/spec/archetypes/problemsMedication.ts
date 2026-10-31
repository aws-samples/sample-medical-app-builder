import { z } from 'zod';
import { PHI_FIELDS } from '../../manifest/schema';
import type { ArchetypeDef, BuildOutput } from '../archetype';
import type { SpecIssue } from '../common';
import { REF, fhirQuery, node, patientContextInput, patientIdentity, patientRead } from '../blocks';

/**
 * APP-04 · Problem list and medication review — the two lists a consultation starts from, side by
 * side or stacked, each filtered to active entries or showing the history.
 */

const ListSchema = (defaultTitles: { active: string; all: string }) =>
  z.strictObject({
    status: z.enum(['active', 'all']).default('active').describe('Active entries only, or the full history'),
    title: z.string().min(1).optional().describe(`Defaults to "${defaultTitles.active}" / "${defaultTitles.all}"`),
  });

export const ProblemsMedicationKnobsSchema = z.strictObject({
  identity: z.enum(['header', 'banner']).default('banner').describe("Medplum's stock header shows full PHI; the banner masks per role"),
  arrangement: z.enum(['side_by_side', 'stacked']).default('side_by_side'),
  problems: ListSchema({ active: 'Active problems', all: 'Problem list' }).default({ status: 'active' }),
  medication: ListSchema({ active: 'Active medication', all: 'Medication history' }).default({ status: 'active' }),
});

export type ProblemsMedicationKnobs = z.infer<typeof ProblemsMedicationKnobsSchema>;

export const problemsMedication: ArchetypeDef<ProblemsMedicationKnobs> = {
  id: 'APP-04',
  name: 'Problem list and medication review',
  knobs: ProblemsMedicationKnobsSchema,

  check(ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    if (k.identity === 'header') {
      for (const [i, r] of ctx.roles.entries()) {
        if (PHI_FIELDS.some((f) => !r.phi_fields_visible.includes(f))) {
          issues.push({ path: `roles.${i}.phi_fields_visible`, message: `role "${r.id}" masks identity fields, but identity "header" shows them all — use identity "banner"` });
        }
      }
    }
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const condParams: Record<string, string> = k.problems.status === 'active' ? { patient: REF.patient, 'clinical-status': 'active' } : { patient: REF.patient };
    const medParams: Record<string, string> = k.medication.status === 'active' ? { patient: REF.patient, status: 'active' } : { patient: REF.patient };
    const primitives = [
      patientRead(),
      fhirQuery({ id: 'p_conditions', binding: 'conditions', resource: 'Condition', params: condParams }),
      fhirQuery({ id: 'p_medications', binding: 'medications', resource: 'MedicationRequest', params: medParams }),
    ];
    const problems = node('ProblemList', { conditions: '$bindings.conditions', title: k.problems.title ?? (k.problems.status === 'active' ? 'Active problems' : 'Problem list') });
    const medication = node('MedicationList', { medications: '$bindings.medications', title: k.medication.title ?? (k.medication.status === 'active' ? 'Active medication' : 'Medication history') });
    const body = k.arrangement === 'side_by_side' ? node('TwoColumn', { ratio: [6, 6] }, [problems, medication]) : node('Section', undefined, [problems, medication]);

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity(k.identity), body],
      context_inputs: [patientContextInput()],
      data_categories: ['medication'],
    };
  },
};
