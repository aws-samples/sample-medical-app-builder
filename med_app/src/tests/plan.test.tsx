import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec } from '../spec';
import type { AppManifest } from '../manifest/schema';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { affectedBindings, bindingRefs, resourcesRead, waves } from '../renderer/plan';
import { renderManifest } from './testUtils';
import { loadRegistry } from '../manifest/registry';

/**
 * The data plan's schedule and a write's reach. Independent primitives run together and dependents after; a successful
 * write refreshes exactly the bindings of the resource type it wrote (and what reads them), so the saved entry is on the
 * page with the "Saved" notice instead of after every primitive has run again one by one — a user's "saved, but
 * the list did not change" (issue, 2026-10-14).
 */

type Primitive = AppManifest['primitives'][number];
// A variable, not a literal: Vite would otherwise rewrite the URL into an asset import.
const patientPage = '../../specs/composed-ward-tasks.yaml';
const prim = (id: string, kind: string, config: Record<string, unknown>, binding = id): Primitive => ({ id, kind, catalog_version: '1.0.0', config, output_binding: binding }) as Primitive;

const ckd = loadRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_ckd_imaging_register');
if (!ckd?.ok) throw new Error('showcase ckd register expected');

describe('scheduling the plan in waves', () => {
  it('reads the bindings a config references', () => {
    expect([...bindingRefs(prim('x', 'data.cohort.latest_observation', { patients: '$bindings.imaging.patients', codes: ['a'], note: 'see $bindings.cohort.count' }))]).toEqual(['imaging', 'cohort']);
    expect([...bindingRefs(prim('y', 'data.fhir.query', { resource: 'Condition', params: { patient: '$context.patient_id' } }))]).toEqual([]);
  });

  it('puts independent primitives in one wave and dependents after, in the register chain cohort → imaging → latest', () => {
    const plan = ckd.manifest.primitives;
    expect(waves(plan).map((w) => w.map((p) => p.id))).toEqual([['p_cohort'], ['p_imaging'], ['p_latest']]);
    const page = [prim('p_patient', 'data.fhir.patient.read', { patient: '$context.patient_id' }, 'patient'), prim('p_a', 'data.fhir.query', { resource: 'Condition' }, 'a'), prim('p_b', 'data.fhir.query', { resource: 'Task' }, 'b'), prim('p_c', 'data.cohort.latest_observation', { patients: '$bindings.b.patients' }, 'c')];
    expect(waves(page).map((w) => w.map((p) => p.id))).toEqual([['p_patient', 'p_a', 'p_b'], ['p_c']]);
  });

  it('a reference to a binding nothing produces, or a cycle, does not hang the plan', () => {
    const orphan = [prim('p_a', 'data.fhir.query', { resource: 'Condition', x: '$bindings.nowhere' }, 'a')];
    expect(waves(orphan).map((w) => w.map((p) => p.id))).toEqual([['p_a']]);
    const cycle = [prim('p_a', 'data.fhir.query', { x: '$bindings.b' }, 'a'), prim('p_b', 'data.fhir.query', { x: '$bindings.a' }, 'b')];
    expect(waves(cycle).map((w) => w.map((p) => p.id))).toEqual([['p_a'], ['p_b']]);
  });
});

describe('what a write stales', () => {
  it('names the resource types a data primitive reads', () => {
    expect([...resourcesRead(prim('q', 'data.fhir.query', { resource: 'Media' }))]).toEqual(['Media']);
    expect([...resourcesRead(prim('t', 'data.task.worklist', {}))]).toEqual(['Task']);
    expect([...resourcesRead(prim('d', 'data.cohort.assessment_due', {}))]).toEqual(['QuestionnaireResponse']);
    expect([...resourcesRead(prim('a', 'data.fhir.questionnaire_response.answers', {}))]).toEqual(['QuestionnaireResponse']);
    expect([...resourcesRead(prim('p', 'data.fhir.patient.read', {}))]).toEqual(['Patient']);
  });

  it('a write refreshes the reads of its type and their dependents, nothing else; an unknown kind refreshes everything', () => {
    const plan = [
      prim('p_patient', 'data.fhir.patient.read', {}, 'patient'),
      prim('p_tasks', 'data.fhir.query', { resource: 'Task' }, 'tasks'),
      prim('p_problems', 'data.fhir.query', { resource: 'Condition' }, 'problems'),
      prim('p_cohort', 'data.cohort.by_condition', {}, 'cohort'),
      prim('p_latest', 'data.cohort.latest_observation', { patients: '$bindings.cohort.patients' }, 'latest'),
      prim('p_new_task', 'write.fhir.task.create', {}, 'new_task_created'),
    ];
    expect([...affectedBindings(plan, { kind: 'write.fhir.task.create' })!]).toEqual(['tasks']);
    expect([...affectedBindings(plan, { kind: 'write.fhir.task.update_status' })!]).toEqual(['tasks']);
    expect([...affectedBindings(plan, { kind: 'write.fhir.condition.create' })!].sort()).toEqual(['cohort', 'latest', 'problems']); // latest reads the cohort, which reads Conditions
    expect([...affectedBindings(plan, { kind: 'write.fhir.observation.create' })!]).toEqual(['latest']);
    expect([...affectedBindings(plan, { kind: 'write.fhir.media.create' })!]).toEqual([]); // nothing on this page reads Media
    expect(affectedBindings(plan, { kind: 'write.fhir.something.new' })).toBeUndefined();
  });
});

describe('after a save, the page refreshes what changed — and only that', () => {
  it('creating a task re-runs the task query alone; the list shows the task with the notice', async () => {
    const result = compileSpec(parseYaml(readFileSync(new URL(patientPage, import.meta.url), 'utf8')), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const audit: AuditRecord[] = [];
    await renderManifest(result.manifest, { role: 'ward_nurse', context: { patient_id: 'pat-kms-0001' }, executor: new MockPrimitiveExecutor(undefined, new Date(), 0), onAudit: (r) => audit.push(r) });
    const list = await screen.findByTestId('task-list');
    await waitFor(() => expect(list).toHaveTextContent('2 tasks'));
    const before = audit.length;
    expect(audit.map((a) => a.primitive_id)).toEqual(['p_patient', 'p_tasks', 'p_problems']); // the first load, every read

    const form = screen.getByTestId('task-entry');
    fireEvent.click(within(form).getByTestId('entry-code'));
    const listbox = document.getElementById(within(form).getByTestId('entry-code').getAttribute('aria-controls') ?? '');
    fireEvent.click(within(listbox!).getByText('Follow-up call'));
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    await waitFor(() => expect(list).toHaveTextContent('3 tasks'), { timeout: 4000 });
    expect(list).toHaveTextContent('Follow-up call');
    // The write, then the one read it stales. The patient and the problem list were not fetched again.
    expect(audit.slice(before).map((a) => a.primitive_id)).toEqual(['p_new_task', 'p_tasks']);
    // The problem list kept its content throughout.
    expect(screen.getByText('3 entries')).toBeInTheDocument(); // the problem list's count, untouched
  });
});
