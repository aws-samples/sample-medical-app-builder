import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import { PHI_FIELDS } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { CodeSchema, WindowSchema, type SpecIssue } from '../common';
import { REF, describeWindow, fhirQuery, node, observationsByCode, patientContextInput, patientIdentity, patientRead, windowContextInput } from '../blocks';

/**
 * APP-01 · Patient summary — one patient's problems, medication, vitals and raw record, as tabs
 * or stacked sections. Reference manifest: manifests/patient-summary.yaml.
 */

const SectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('problems'),
    status: z.enum(['active', 'all']).default('active'),
    label: z.string().min(1).default('Problems'),
    title: z.string().min(1).optional().describe('Defaults to "Active problems" / "Problem list"'),
  }),
  z.strictObject({
    kind: z.literal('medication'),
    status: z.enum(['active', 'all']).default('active'),
    label: z.string().min(1).default('Medication'),
    title: z.string().min(1).optional().describe('Defaults to "Active medication" / "Medication history"'),
  }),
  z.strictObject({
    kind: z.literal('vitals'),
    codes: z.array(CodeSchema).min(1).describe('Observation codes counted as vitals and labs'),
    label: z.string().min(1).default('Vitals & labs'),
    title: z.string().min(1).optional().describe('Defaults to the window, e.g. "Last two years"'),
    rows: z.number().int().positive().max(200).default(40),
  }),
  z.strictObject({
    kind: z.literal('record'),
    label: z.string().min(1).default('FHIR record'),
    title: z.string().min(1).default('Patient resource'),
  }),
]);

export const PatientSummaryKnobsSchema = z
  .strictObject({
    identity: z.enum(['header', 'banner']).default('header').describe("Medplum's stock header shows full PHI; the banner masks per role"),
    arrangement: z.enum(['tabs', 'stack']).default('tabs').describe('Tabs, or sections stacked down the page'),
    window: WindowSchema.default('now-2y'),
    sections: z.array(SectionSchema).min(1).describe('In display order; the first is the default tab'),
  })
  .refine((k) => new Set(k.sections.map((s) => s.kind)).size === k.sections.length, { message: 'each section kind appears at most once', path: ['sections'] });

export type PatientSummaryKnobs = z.infer<typeof PatientSummaryKnobsSchema>;

export const patientSummary: ArchetypeDef<PatientSummaryKnobs> = {
  id: 'APP-01',
  name: 'Patient summary',
  knobs: PatientSummaryKnobsSchema,

  check(ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    if (k.identity === 'header') {
      // The stock header cannot mask: every role of this app would see the full identity.
      for (const [i, r] of ctx.roles.entries()) {
        if (PHI_FIELDS.some((f) => !r.phi_fields_visible.includes(f))) {
          issues.push({ path: `roles.${i}.phi_fields_visible`, message: `role "${r.id}" masks identity fields, but identity "header" shows them all — use identity "banner"` });
        }
      }
    }
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const primitives: BlockPrimitive[] = [patientRead()];
    const panels: { label: string; content: LayoutNode }[] = [];
    let measurements = false;

    for (const s of k.sections) {
      switch (s.kind) {
        case 'problems': {
          const params: Record<string, string> = s.status === 'active' ? { patient: REF.patient, 'clinical-status': 'active' } : { patient: REF.patient };
          primitives.push(fhirQuery({ id: 'p_conditions', binding: 'conditions', resource: 'Condition', params }));
          panels.push({ label: s.label, content: node('ProblemList', { conditions: '$bindings.conditions', title: s.title ?? (s.status === 'active' ? 'Active problems' : 'Problem list') }) });
          break;
        }
        case 'medication': {
          const params: Record<string, string> = s.status === 'active' ? { patient: REF.patient, status: 'active' } : { patient: REF.patient };
          primitives.push(fhirQuery({ id: 'p_medications', binding: 'medications', resource: 'MedicationRequest', params }));
          panels.push({ label: s.label, content: node('MedicationList', { medications: '$bindings.medications', title: s.title ?? (s.status === 'active' ? 'Active medication' : 'Medication history') }) });
          break;
        }
        case 'vitals': {
          measurements = true;
          primitives.push(observationsByCode({ id: 'p_vitals', binding: 'vitals', codes: s.codes, windowed: true, count: s.rows }));
          panels.push({ label: s.label, content: node('VitalsTable', { observations: '$bindings.vitals', title: s.title ?? describeWindow(k.window), max_rows: s.rows }) });
          break;
        }
        case 'record': {
          panels.push({ label: s.label, content: node('ResourceDetails', { resource: '$bindings.patient', title: s.title }) });
          break;
        }
      }
    }

    const body =
      k.arrangement === 'tabs'
        ? node('Tabs', { default_tab: panels[0]?.label }, panels.map((p) => node('Tab', { label: p.label }, [p.content])))
        : node('Section', undefined, panels.map((p) => node('Section', { title: p.label }, [p.content])));

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity(k.identity), body],
      context_inputs: measurements ? [patientContextInput(), windowContextInput(k.window)] : [patientContextInput()],
      data_categories: measurements ? ['clinical_measurements'] : [],
    };
  },
};
