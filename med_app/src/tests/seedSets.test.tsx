import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { bundledHospitals, bundledSetFor, loadRegistry } from '../manifest/registry';
import type { Diagnostic } from '../renderer/expressions';
import { renderManifest } from './testUtils';

/**
 * One seed set per hospital (showcase/<hospital_id>.yaml → manifests/<hospital_id>/): the configured hospital sees its own,
 * a hospital id without a set sees them all, and every app of every set renders on the mock record without a renderer
 * diagnostic. The repository ships one set — Klinikum Musterstadt's — and a second hospital adds its own file.
 */
describe('the seed sets', () => {
  it('are one per hospital, selected by the configured hospital id', () => {
    expect(bundledHospitals()).toEqual(['hsp-musterstadt']);
    expect(bundledSetFor('hsp-musterstadt')).toEqual(['hsp-musterstadt']);
    expect(bundledSetFor('hsp-local'), 'an id without a set of its own sees every set').toEqual(['hsp-musterstadt']);
    const musterstadt = loadRegistry('hsp-musterstadt');
    expect(musterstadt).toHaveLength(13);
    expect(loadRegistry('hsp-local')).toHaveLength(13);
    for (const entry of musterstadt) expect(entry.ok, entry.file).toBe(true);
    expect(musterstadt.every((e) => e.ok && e.manifest.metadata.hospital_id === 'hsp-musterstadt' && e.manifest.lifecycle.state === 'published')).toBe(true);
    expect(musterstadt.every((e) => e.ok && e.meta?.spec !== undefined), 'every seed app carries the spec it was compiled from').toBe(true);
  });

  for (const hospitalId of bundledHospitals()) {
    for (const entry of loadRegistry(hospitalId)) {
      if (!entry.ok) continue;
      it(`${hospitalId}: ${entry.manifest.metadata.name} renders on the mock record without a diagnostic`, async () => {
        const diagnostics: Diagnostic[] = [];
        const { unmount } = await renderManifest(entry.manifest, { onDiagnostic: (d) => diagnostics.push(d) });
        await screen.findByRole('heading', { name: entry.manifest.metadata.name });
        expect(diagnostics.map((d) => `${d.level}: ${d.message}`)).toEqual([]);
        unmount();
      });
    }
  }
});
