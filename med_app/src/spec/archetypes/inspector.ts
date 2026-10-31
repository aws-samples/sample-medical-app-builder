import { z } from 'zod';
import type { LayoutNode } from '../../manifest/schema';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from '../archetype';
import { identifier, type SpecIssue } from '../common';
import { REF, fhirQuery, node, patientContextInput, patientIdentity, patientRead } from '../blocks';

/**
 * APP-08 · FHIR resource inspector — one resource rendered from its schema with references resolved:
 * the patient record itself, or the most recent resource of a type (latest report, latest encounter),
 * selected by index from a query. One resource per panel; there is no list component for these yet.
 */

/** Resource types a "latest of" panel may query — the allow-list of data.fhir.query minus what has its own block. */
export const QUERYABLE = ['DiagnosticReport', 'Encounter', 'Condition', 'MedicationRequest', 'Observation', 'QuestionnaireResponse'] as const;

const PanelSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('patient'),
    label: z.string().min(1).default('Patient'),
    title: z.string().min(1).default('Patient resource'),
  }),
  z.strictObject({
    kind: z.literal('latest'),
    resource: z.enum(QUERYABLE).describe('The resource type; its most recent instance for the patient is shown'),
    id: identifier.optional().describe('Panel id used in bindings; defaults to the resource type in snake case'),
    label: z.string().min(1).optional().describe('Tab label; defaults to "Latest <resource>"'),
    title: z.string().min(1).optional(),
    params: z.record(z.string(), z.string()).optional().describe('Extra search parameters, e.g. { status: final }'),
  }),
]);

export const InspectorKnobsSchema = z.strictObject({
  panels: z.array(PanelSchema).min(1).describe('In display order; one tab each when there are several'),
});

export type InspectorKnobs = z.infer<typeof InspectorKnobsSchema>;

const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

export const inspector: ArchetypeDef<InspectorKnobs> = {
  id: 'APP-08',
  name: 'FHIR resource inspector',
  knobs: InspectorKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    const ids = new Set<string>();
    for (const [i, p] of k.panels.entries()) {
      const id = p.kind === 'patient' ? 'patient' : (p.id ?? snake(p.resource));
      if (ids.has(id)) issues.push({ path: `knobs.panels.${i}`, message: `duplicate panel "${id}" — give the second one its own id` });
      ids.add(id);
      if (p.kind === 'latest' && p.params && ('patient' in p.params || 'subject' in p.params)) issues.push({ path: `knobs.panels.${i}.params`, message: 'the patient is the launch context; do not set it as a parameter' });
    }
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const primitives: BlockPrimitive[] = [patientRead()];
    const panels: { label: string; content: LayoutNode }[] = [];
    for (const p of k.panels) {
      if (p.kind === 'patient') {
        panels.push({ label: p.label, content: node('ResourceDetails', { resource: '$bindings.patient', title: p.title }) });
        continue;
      }
      const binding = p.id ?? snake(p.resource);
      primitives.push(fhirQuery({ id: `p_${binding}`, binding, resource: p.resource, params: { patient: REF.patient, ...(p.params ?? {}) } }));
      const readable = p.resource.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      panels.push({ label: p.label ?? `Latest ${readable}`, content: node('ResourceDetails', { resource: `$bindings.${binding}[0]`, title: p.title ?? `Most recent ${readable}` }) });
    }
    const body: LayoutNode =
      panels.length === 1 && panels[0]
        ? node('Section', undefined, [panels[0].content])
        : node('Tabs', { default_tab: panels[0]?.label }, panels.map((t) => node('Tab', { label: t.label }, [t.content])));

    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives,
      children: [patientIdentity('banner', { compact: true }), body],
      context_inputs: [patientContextInput()],
      data_categories: ['clinical_documentation'],
    };
  },
};
