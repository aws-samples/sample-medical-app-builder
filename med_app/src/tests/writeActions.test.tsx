import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec } from '../spec';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { renderManifest } from './testUtils';

/**
 * The ward-entry page end to end in the renderer: a reading recorded through the entry form shows up in
 * the trend beside it; a problem marked resolved leaves the active list; a stopped prescription leaves
 * the active medication. Every one of these is an action → write primitive → reload, audited.
 */

// A variable, not a literal: Vite would otherwise rewrite the URL into an asset import.
const specRel = '../../specs/composed-ward-entry.yaml';
const specFile = new URL(specRel, import.meta.url);

async function mountWardEntry() {
  const result = compileSpec(parseYaml(readFileSync(specFile, 'utf8')), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const audit: AuditRecord[] = [];
  // A real clock: the form dates the reading "now", and the executor must agree it is not in the future.
  const executor = new MockPrimitiveExecutor(undefined, new Date(), 0);
  await renderManifest(result.manifest, { role: 'ward_nurse', context: { patient_id: 'pat-kms-0001' }, executor, onAudit: (r) => audit.push(r) });
  await screen.findByTestId('observation-entry');
  return { audit };
}

describe('writes from a composed page', () => {
  it('records a blood pressure the trend then shows, and refuses an implausible one with the reason', async () => {
    const { audit } = await mountWardEntry();
    // The seed is anchored on 2026-09-10 but the app's window is `now-1y` on the real clock (the write below must not be
    // "in the future"), so the number of readings in view shrinks as the calendar moves: count what is there, then expect one more.
    await waitFor(() => expect(screen.getByTestId('observation-timeline')).toHaveTextContent(/\d+ data points/), { timeout: 4000 });
    const shown = Number(/(\d+) data points/.exec(screen.getByTestId('observation-timeline').textContent ?? '')?.[1]);
    expect(shown).toBeGreaterThan(0);

    const entry = screen.getByTestId('observation-entry');
    fireEvent.change(within(entry).getByTestId('entry-8480-6'), { target: { value: '900' } });
    fireEvent.change(within(entry).getByTestId('entry-8462-4'), { target: { value: '86' } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('900 mmHg is outside the accepted range 50–300');
    expect(audit.filter((a) => a.primitive_id === 'p_bp_entry')).toHaveLength(0); // refused in the browser, never sent

    // The two fields swapped: each value is within its own range, the panel is impossible (an issue seen in use).
    // The compiler put the relation on the blood pressure panel by itself; the form names it as the labels read.
    fireEvent.change(within(entry).getByTestId('entry-8480-6'), { target: { value: '90' } });
    fireEvent.change(within(entry).getByTestId('entry-8462-4'), { target: { value: '120' } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    await waitFor(() => expect(screen.getByTestId('entry-problems')).toHaveTextContent('Systolic must be above diastolic (90 vs 120 mmHg)'));
    expect(screen.getByTestId('entry-problems')).not.toHaveTextContent('outside the accepted range');
    expect(audit.filter((a) => a.primitive_id === 'p_bp_entry')).toHaveLength(0);

    fireEvent.change(within(entry).getByTestId('entry-8480-6'), { target: { value: '138' } });
    fireEvent.change(within(entry).getByTestId('entry-8462-4'), { target: { value: '86' } });
    fireEvent.change(within(entry).getByTestId('entry-note'), { target: { value: 'Nach 5 Minuten Ruhe.' } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('The reading is now part of the patient record.');
    await waitFor(() => expect(screen.getByTestId('observation-timeline')).toHaveTextContent(`${shown + 1} data points`), { timeout: 4000 });
    const write = audit.find((a) => a.primitive_id === 'p_bp_entry');
    expect(write?.outcome).toBe('ok');
    expect(write?.detail).toMatch(/^Observation\/obs-mock-/);
  });

  it('marks a problem resolved and stops a prescription — versioned status changes that the lists reflect', async () => {
    const { audit } = await mountWardEntry();
    const problems = await screen.findByText('Active problems');
    const problemFrame = problems.closest('section, div[class*="Paper"]') ?? problems.parentElement!.parentElement!;
    await waitFor(() => expect(within(problemFrame as HTMLElement).getByText('Osteoarthritis of knee')).toBeInTheDocument(), { timeout: 4000 });

    fireEvent.click(screen.getByTestId('row-action-cond-kms-0003'));
    const form = await screen.findByTestId('row-action-form-cond-kms-0003');
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'Beschwerdefrei seit der Arthroskopie.' } });
    fireEvent.click(within(form).getByTestId('row-action-confirm-cond-kms-0003'));
    await screen.findByTestId('row-action-saved-resolve_problems', {}, { timeout: 4000 });
    await waitFor(() => expect(screen.queryByText('Osteoarthritis of knee')).toBeNull(), { timeout: 4000 });
    const resolved = audit.find((a) => a.primitive_id === 'p_problems_resolve');
    expect(resolved?.outcome).toBe('ok');
    expect(resolved?.detail).toBe('Condition/cond-kms-0003');

    fireEvent.click(screen.getByTestId('row-action-medrx-kms-0003'));
    const stop = await screen.findByTestId('row-action-form-medrx-kms-0003');
    fireEvent.change(stop.querySelector('textarea')!, { target: { value: 'Knöchelödeme' } });
    fireEvent.click(within(stop).getByTestId('row-action-confirm-medrx-kms-0003'));
    await screen.findByTestId('row-action-saved-stop_medication', {}, { timeout: 4000 });
    await waitFor(() => expect(screen.queryByText('Amlodipin 5 mg')).toBeNull(), { timeout: 4000 });
    expect(audit.find((a) => a.primitive_id === 'p_medication_stop')?.outcome).toBe('ok');
  });
});
