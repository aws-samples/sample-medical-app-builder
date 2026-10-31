import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec } from '../spec';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { renderManifest } from './testUtils';

/**
 * The ward-documentation page end to end in the renderer: a diagnosis added through its form appears on the
 * problem list beside it, an allergy on the allergy list, a procedure in the procedures — each an action → write
 * primitive → reload, audited; each refused in the browser, with the reason, before anything is sent.
 */

// A variable, not a literal: Vite would otherwise rewrite the URL into an asset import.
const specRel = '../../specs/composed-ward-documentation.yaml';
const specFile = new URL(specRel, import.meta.url);

async function mount() {
  const result = compileSpec(parseYaml(readFileSync(specFile, 'utf8')), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const audit: AuditRecord[] = [];
  const executor = new MockPrimitiveExecutor(undefined, new Date(), 0);
  await renderManifest(result.manifest, { role: 'ward_physician', context: { patient_id: 'pat-kms-0001' }, executor, onAudit: (r) => audit.push(r) });
  await screen.findByTestId('problem-entry');
  return { audit };
}

/** Mantine's Select in jsdom: the dropdown never leaves display:none, so pick the option inside the listbox the input points at. */
function pick(select: HTMLElement, text: string) {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  if (!listbox) throw new Error('no listbox');
  fireEvent.click(within(listbox).getByText(text));
}

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const localDaysAgo = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('coded entries from a composed page', () => {
  it('adds a diagnosis the problem list then shows; an onset in the future is refused with the reason', async () => {
    const { audit } = await mount();
    const list = (await screen.findByText('Problem list')).closest('[class*="Paper"]') as HTMLElement;
    const before = Number(/(\d+) entr/.exec(list.textContent ?? '')?.[1] ?? '0');

    const entry = screen.getByTestId('problem-entry');
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('choose the diagnosis to add'); // nothing chosen yet

    pick(within(entry).getByTestId('entry-code'), 'Hypokalaemia (E87.6)');
    fireEvent.change(within(entry).getByTestId('entry-onset'), { target: { value: isoDaysAgo(-30) } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('onset must not be in the future');
    expect(audit.filter((a) => a.primitive_id === 'p_add_problem')).toHaveLength(0); // refused in the browser, never sent

    fireEvent.change(within(entry).getByTestId('entry-onset'), { target: { value: isoDaysAgo(10) } });
    pick(within(entry).getByTestId('entry-severity'), 'Moderate');
    fireEvent.change(within(entry).getByTestId('entry-note'), { target: { value: 'Kalium 3.1 mmol/L heute.' } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('Added to the problem list.');
    await waitFor(() => expect(list).toHaveTextContent(`${before + 1} entries`), { timeout: 4000 });
    expect(list).toHaveTextContent('Hypokalaemia');
    const write = audit.find((a) => a.primitive_id === 'p_add_problem');
    expect(write?.outcome).toBe('ok');
    expect(write?.detail).toMatch(/^Condition\/cond-mock-/);
  });

  it('records a drug allergy with its reaction, which the allergy list then shows', async () => {
    const { audit } = await mount();
    const list = await screen.findByTestId('allergy-list');
    const before = Number(/(\d+) entr/.exec(list.textContent ?? '')?.[1] ?? '0');

    const entry = screen.getByTestId('allergy-entry');
    pick(within(entry).getByTestId('entry-code'), 'Ramipril (C09AA05)');
    expect(within(entry).queryByTestId('entry-category')).toBeNull(); // one category offered: fixed, not asked
    pick(within(entry).getByTestId('entry-criticality'), 'High');
    fireEvent.change(within(entry).getByTestId('entry-reaction'), { target: { value: 'Angio-oedema' } });
    pick(within(entry).getByTestId('entry-reaction-severity'), 'Severe');
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('Recorded on the allergy list.');
    await waitFor(() => expect(list).toHaveTextContent(`${before + 1} entries`), { timeout: 4000 });
    expect(list).toHaveTextContent('Ramipril');
    expect(list).toHaveTextContent('Angio-oedema');
    expect(list).toHaveTextContent('(severe)');
    expect(audit.find((a) => a.primitive_id === 'p_add_allergy')?.detail).toMatch(/^AllergyIntolerance\/allergy-mock-/);
  });

  it('documents a procedure within the window; one dated too far back is refused', async () => {
    const { audit } = await mount();
    const list = await screen.findByTestId('resource-list');
    const before = Number(/(\d+) entr/.exec(list.textContent ?? '')?.[1] ?? '0');

    const entry = screen.getByTestId('procedure-entry');
    pick(within(entry).getByTestId('entry-code'), 'Gastroscopy (1-632.0)');
    fireEvent.change(within(entry).getByTestId('entry-when'), { target: { value: localDaysAgo(40) } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('performed date must not be more than 14 days ago');

    fireEvent.change(within(entry).getByTestId('entry-when'), { target: { value: localDaysAgo(2) } });
    pick(within(entry).getByTestId('entry-status'), 'Completed');
    fireEvent.change(within(entry).getByTestId('entry-body-site'), { target: { value: 'Stomach' } });
    fireEvent.click(within(entry).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    await waitFor(() => expect(list).toHaveTextContent(`${before + 1} entries`), { timeout: 4000 });
    expect(list).toHaveTextContent('Gastroscopy');
    expect(list).toHaveTextContent('Stomach');
    expect(audit.find((a) => a.primitive_id === 'p_add_procedure')?.detail).toMatch(/^Procedure\/proc-mock-/);
  });
});
