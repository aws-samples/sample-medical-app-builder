import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Observation } from '@medplum/fhirtypes';
import { compileSpec, readiness } from '../spec';
import type { AppSpec } from '../spec';
import { resolveEffectiveScope } from '../manifest/roles';
import { lateralityOf } from '../primitives/data/fhirHelpers';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { SEED_ANCHOR } from '../primitives/data/mock/seed';
import { SEED } from '../primitives/data/mock/seed';
import type { AuditRecord } from '../primitives/data/types';
import { renderManifest } from './testUtils';

/**
 * Paired measurements — the physiotherapy lab's knee flexion and grip strength, left against right. The entry form asks
 * the side (and the test condition) and writes them as FHIR does: the SNOMED laterality qualifier and the structure in
 * bodySite, the condition in method; the validator refuses a missing side; the trend plots one line per side and the
 * readings table shows the side. The seed carries both sides, so the chart has two lines from the start.
 */

const file = '../../specs/composed-physio-assessment.yaml';
const spec = () => parseYaml(readFileSync(new URL(file, import.meta.url), 'utf8')) as AppSpec & { knobs: { sections: Record<string, unknown>[] } };

function pick(select: HTMLElement, text: string) {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  if (!listbox) throw new Error('no listbox');
  fireEvent.click(within(listbox).getByText(text));
}

describe('the seed and the helpers', () => {
  it('the lab measurements carry their side, and the helper reads it from bodySite alone', () => {
    const knee = SEED.observations.filter((o) => o.code?.coding?.some((c) => c.code === 'knee_flexion'));
    expect(knee).toHaveLength(12);
    expect(knee.map(lateralityOf).filter((s) => s === 'left')).toHaveLength(6);
    expect(knee.map(lateralityOf).filter((s) => s === 'right')).toHaveLength(6);
    expect(knee[0]!.method?.coding?.[0]?.code).toBe('active');
    expect(lateralityOf({ bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '49076000' }] } })).toBeUndefined();
    expect(lateralityOf({ bodySite: { coding: [{ system: 'http://loinc.org', code: '7771000' }] } })).toBeUndefined(); // the code alone is not laterality; the system is
    expect(lateralityOf({ bodySite: { coding: [{ system: 'http://snomed.info/sct', code: '51440002' }] } })).toBe('both');
  });

  it('the readiness check wants a display on every test condition and no condition twice', () => {
    const base = spec();
    const form = base.knobs.sections.find((s) => s.id === 'new_flexion')!;
    const patched = (patch: Record<string, unknown>) => ({ ...base, knobs: { ...base.knobs, sections: base.knobs.sections.map((s) => (s === form ? { ...form, ...patch } : s)) } });
    const messages = (s: unknown) => readiness(s).missing.map((i) => i.message);
    expect(messages(patched({ conditions: [{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'active' }] }))).toContain('every test condition needs its display text — it is what the clinician picks from');
    expect(messages(patched({ conditions: [{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'active', display: 'A' }, { system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'active', display: 'B' }] }))).toContain('each test condition at most once');
    expect(readiness(base)).toEqual({ ready: true, missing: [] });
  });
});

describe('the knee page', () => {
  // The clock a week after the seed's anchor, so the six weekly knee readings (42 to 7 days before the anchor) sit inside
  // the page's three-month window and an entry dated "now" is not in the future — whatever the real date is. Only Date is
  // faked, advancing in real time, so the page's polling and waitFor keep working.
  beforeEach(() => vi.useFakeTimers({ now: new Date(SEED_ANCHOR.getTime() + 7 * 86_400_000), toFake: ['Date'], shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('plots left against right, shows the side in the readings, refuses an entry without a side, and writes side, structure and condition', async () => {
    const result = compileSpec(spec(), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const write = result.manifest.primitives.find((p) => p.kind === 'write.fhir.observation.create')!;
    expect(write.config).toMatchObject({ side: 'required', body_site: 'http://snomed.info/sct|49076000', conditions: ['https://hsp-musterstadt.medapp.eu/CodeSystem/physio|active', 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio|passive'] });

    const audit: AuditRecord[] = [];
    const executor = new MockPrimitiveExecutor(undefined, new Date(), 0);
    await renderManifest(result.manifest, { role: 'physiotherapist', context: { patient_id: 'pat-kms-0001' }, executor, onAudit: (r) => audit.push(r) });

    // The chart: one line per side, named after the series and the side; the readings table: a side column.
    const chart = await screen.findByTestId('observation-timeline');
    await waitFor(() => expect(chart).toHaveTextContent('6 data points'));
    // jsdom draws no SVG, so the plotted lines are read from the card's data attribute: one per side, left first.
    expect(chart.getAttribute('data-lines')).toBe('Knee flexion · left | Knee flexion · right');
    const readings = screen.getAllByTestId('reading-side');
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.map((r) => r.textContent)).toEqual(expect.arrayContaining(['left', 'right']));
    // Under the chart, first against latest per side: the seed's left knee from 95° to 118°, the right from 134° to 136° — the
    // two numbers, their dates and the arithmetic difference, nothing graded.
    const comparison = screen.getByTestId('observation-comparison');
    const rows = within(comparison).getAllByTestId('comparison-row');
    expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' '))).toEqual([expect.stringMatching(/^Knee flexion · left95 °.*118 °.*\+23 °6$/), expect.stringMatching(/^Knee flexion · right134 °.*136 °.*\+2 °6$/)]);

    // The form: a value without a side is refused before any request leaves; with the side, the record carries it.
    const forms = screen.getAllByTestId('observation-entry');
    const knee = forms.find((f) => within(f).queryByText('Record knee flexion'))!;
    fireEvent.change(within(knee).getByTestId('entry-value'), { target: { value: '121' } });
    fireEvent.click(within(knee).getByTestId('entry-submit'));
    expect(await within(knee).findByTestId('entry-problems')).toHaveTextContent('the side of the body is required: left, right or both');
    expect(audit.filter((a) => a.primitive_id === 'p_new_flexion')).toHaveLength(0);
    pick(within(knee).getByTestId('entry-side'), 'Left');
    pick(within(knee).getByTestId('entry-conditions'), 'Passive movement');
    fireEvent.click(within(knee).getByTestId('entry-submit'));
    await waitFor(() => expect(audit.find((a) => a.primitive_id === 'p_new_flexion')?.outcome).toBe('ok'), { timeout: 4000 });
    // The chart reloads with the new left value (a seventh day) and the comparison follows; the written resource, read back
    // through the same primitive the page uses, has the side, the structure and the method.
    await waitFor(() => expect(chart).toHaveTextContent('7 data points'), { timeout: 4000 });
    await waitFor(() => expect(within(screen.getByTestId('observation-comparison')).getAllByTestId('comparison-row')[0]).toHaveTextContent(/121 °.*\+26 °7$/), { timeout: 4000 });
    const read = result.manifest.primitives.find((p) => p.id === 'p_flexion')!;
    const stored = (await executor.execute({
      manifest: result.manifest,
      role: 'physiotherapist',
      scope: resolveEffectiveScope(result.manifest, 'physiotherapist'),
      decl: read,
      config: { ...read.config, patient: 'pat-kms-0001', since: undefined },
      context: { patient_id: 'pat-kms-0001' },
      idToken: 't',
      userSub: 'u1',
    })) as Observation[];
    const mine = stored.find((o) => o.valueQuantity?.value === 121);
    expect(mine, JSON.stringify(stored.map((o) => o.id))).toBeDefined();
    expect(mine!.bodySite?.coding).toEqual([
      { system: 'http://snomed.info/sct', code: '49076000', display: 'Knee joint structure' },
      { system: 'http://snomed.info/sct', code: '7771000', display: 'Left' },
    ]);
    expect(mine!.bodySite?.text).toBe('Knee joint structure · left');
    expect(mine!.method).toEqual({ coding: [{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'passive', display: 'Passive movement' }], text: 'Passive movement' });
  });
});
