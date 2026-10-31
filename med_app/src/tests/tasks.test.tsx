import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec } from '../spec';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { renderManifest } from './testUtils';

/**
 * Tasks end to end in the renderer: the patient page lists the open tasks and takes a new one through its form; the
 * worklist shows the ward's open tasks across patients, overdue first, lets someone take one on and complete it, and
 * narrows to "mine" — every change an action → write primitive → reload, audited, the same Task resources on both pages.
 */

// Variables, not literals: Vite would otherwise rewrite the URLs into asset imports.
const patientPage = '../../specs/composed-ward-tasks.yaml';
const worklistPage = '../../specs/ward-worklist.yaml';
const duePage = '../../specs/htn-assessment-due.yaml';

async function mount(rel: string, role: string, context: Record<string, unknown>, executor = new MockPrimitiveExecutor(undefined, new Date(), 0)) {
  const result = compileSpec(parseYaml(readFileSync(new URL(rel, import.meta.url), 'utf8')), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const audit: AuditRecord[] = [];
  await renderManifest(result.manifest, { role, context, executor, onAudit: (r) => audit.push(r) });
  return { audit, executor };
}

/** Mantine's Select in jsdom: the dropdown never leaves display:none, so pick the option inside the listbox the input points at. */
function pick(select: HTMLElement, text: string) {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  if (!listbox) throw new Error('no listbox');
  fireEvent.click(within(listbox).getByText(text));
}

const isoDaysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('tasks on the patient page', () => {
  it('lists the open tasks with the overdue one marked, takes a new task, refuses one due yesterday', async () => {
    const { audit } = await mount(patientPage, 'ward_nurse', { patient_id: 'pat-kms-0001' });
    const list = await screen.findByTestId('task-list');
    expect(list).toHaveTextContent('2 tasks'); // the falls screen and the discharge letter; the completed screen is Jonas's anyway
    expect(within(list).getByTestId('task-row-task-kms-0001')).toHaveTextContent('Falls risk screen');
    expect(within(within(list).getByTestId('task-row-task-kms-0001')).getByTestId('task-overdue')).toBeInTheDocument(); // due 2026-09-13, long gone on the real clock
    expect(within(list).getByTestId('task-row-task-kms-0002')).toHaveTextContent('Dr. med. Lukas Hoffmann'); // the owner

    const form = screen.getByTestId('task-entry');
    pick(within(form).getByTestId('entry-code'), 'Physiotherapy referral');
    pick(within(form).getByTestId('entry-priority'), 'Urgent');
    fireEvent.change(within(form).getByTestId('entry-due'), { target: { value: isoDaysFromNow(-1) } });
    fireEvent.click(within(form).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('due date must not be in the past');
    expect(audit.filter((a) => a.primitive_id === 'p_new_task')).toHaveLength(0);

    fireEvent.change(within(form).getByTestId('entry-due'), { target: { value: isoDaysFromNow(3) } });
    fireEvent.change(within(form).getByTestId('entry-description'), { target: { value: 'Nach Sturz mobilisieren.' } });
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('The task is on the list.');
    await waitFor(() => expect(list).toHaveTextContent('3 tasks'), { timeout: 4000 });
    expect(list).toHaveTextContent('Physiotherapy referral');
    expect(list).toHaveTextContent('Nach Sturz mobilisieren.');
    expect(list).toHaveTextContent('Urgent');
    expect(audit.find((a) => a.primitive_id === 'p_new_task')?.detail).toMatch(/^Task\/task-mock-/);
  });

  it('starts and completes a task from the row; the completed one leaves the open list', async () => {
    await mount(patientPage, 'ward_nurse', { patient_id: 'pat-kms-0001' });
    const list = await screen.findByTestId('task-list');
    const row = within(list).getByTestId('task-row-task-kms-0001');
    expect(within(row).getByRole('button', { name: 'Start' })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Start' }));
    await screen.findByTestId('row-action-form-task-kms-0001');
    fireEvent.click(screen.getByTestId('row-action-confirm-task-kms-0001'));
    await waitFor(() => expect(within(list).getByTestId('task-row-task-kms-0001')).toHaveTextContent('in progress'), { timeout: 4000 });
    expect(within(list).getByTestId('task-row-task-kms-0001')).toHaveTextContent('test-sub'); // mine now — the owner column names the signed-in person
    expect(within(within(list).getByTestId('task-row-task-kms-0001')).queryByRole('button', { name: 'Start' })).toBeNull(); // taken: only Complete and Cancel remain
    fireEvent.click(within(within(list).getByTestId('task-row-task-kms-0001')).getByRole('button', { name: 'Complete' }));
    await screen.findByTestId('row-action-form-task-kms-0001');
    fireEvent.click(screen.getByTestId('row-action-confirm-task-kms-0001'));
    await waitFor(() => expect(within(list).queryByTestId('task-row-task-kms-0001')).toBeNull(), { timeout: 4000 });
    expect(list).toHaveTextContent('1 task');
  });
});

describe('the ward worklist', () => {
  it('shows the open tasks across patients, overdue first, with the patient and a link into their app; "Mine" narrows to what I took', async () => {
    await mount(worklistPage, 'ward_team', {});
    const worklist = await screen.findByTestId('worklist');
    expect(screen.getByTestId('worklist-count')).toHaveTextContent('3 tasks');
    const rows = within(worklist).getAllByTestId(/^worklist-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rows[0]).toBe('worklist-row-task-kms-0001'); // the overdue screen first
    expect(within(worklist).getByTestId('worklist-row-task-kms-0001')).toHaveAttribute('data-overdue', 'true');
    expect(within(worklist).getByTestId('worklist-row-task-kms-0003')).toHaveTextContent('Yıldız'); // Fatma's follow-up call, with her name
    expect(within(worklist).getByTestId('worklist-row-task-kms-0003')).toHaveTextContent('Urgent');
    expect(within(worklist).getAllByTestId('worklist-open')[0]).toHaveAttribute('href', '/apps/app_ward_documentation?patient_id=pat-kms-0001');
    const cards = screen.getAllByTestId('stat-card');
    expect(cards[0]).toHaveTextContent('Open tasks');
    expect(cards[0]).toHaveTextContent('3');
    expect(cards[1]).toHaveTextContent('Overdue');

    // Nobody has taken anything on as me yet.
    fireEvent.click(within(worklist).getByText('Mine'));
    expect(await screen.findByTestId('worklist-empty')).toHaveTextContent('Nothing taken on by you.');
    fireEvent.click(within(worklist).getByText('Everyone'));

    // Take the follow-up call on: it becomes mine, and "Mine" shows it.
    const row = within(worklist).getByTestId('worklist-row-task-kms-0003');
    fireEvent.click(within(row).getByRole('button', { name: 'Start' }));
    await screen.findByTestId('row-action-form-task-kms-0003');
    fireEvent.click(screen.getByTestId('row-action-confirm-task-kms-0003'));
    await waitFor(() => expect(within(worklist).getByTestId('worklist-row-task-kms-0003')).toHaveTextContent('in progress'), { timeout: 4000 });
    fireEvent.click(within(worklist).getByText('Mine'));
    await waitFor(() => expect(screen.getByTestId('worklist-count')).toHaveTextContent('1 of 3'));
    expect(within(worklist).getByTestId('worklist-row-task-kms-0003')).toBeInTheDocument();
    expect(within(worklist).queryByTestId('worklist-row-task-kms-0001')).toBeNull();
  });
});

describe('who is due an assessment — derived from the record, not from tasks', () => {
  it('lists the hypertension patients never assessed or overdue, in that order, each opening the follow-up app; a new answer clears the row', async () => {
    const executor = new MockPrimitiveExecutor(undefined, new Date(), 0);
    await mount(duePage, 'hypertension_nurse', {}, executor);
    const list = await screen.findByTestId('assessment-due-list');
    expect(screen.getByTestId('assessment-due-count')).toHaveTextContent('2 patients · every 90 days');
    const rows = within(list).getAllByTestId(/^due-row-/);
    expect(rows.map((r) => r.getAttribute('data-standing'))).toEqual(['never', 'overdue']); // Fatma never answered; Anneliese's answer is long past 90 days on the real clock
    expect(rows[0]).toHaveTextContent('Yıldız');
    expect(rows[0]).toHaveTextContent('never assessed');
    expect(rows[1]).toHaveTextContent('Krüger');
    expect(rows[1]).toHaveTextContent(/overdue \d+ days/);
    expect(within(rows[0]!).getByTestId('due-open')).toHaveAttribute('href', '/apps/app_hypertension_follow_up?patient_id=pat-kms-0003');
    const cards = screen.getAllByTestId('stat-card');
    expect(cards[0]).toHaveTextContent('Due a follow-up assessment');
    expect(cards[1]).toHaveTextContent('Never assessed');
    expect(cards[1]).toHaveTextContent('1');
    expect(cards[2]).toHaveTextContent('Overdue');
    expect(cards[2]).toHaveTextContent('1');
  });
});
