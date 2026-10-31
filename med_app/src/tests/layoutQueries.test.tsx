import { describe, expect, it } from 'vitest';
import { validateManifest } from '../manifest/schema';
import { loadFixtureRegistry } from './fixtures';
import { renderManifest } from './testUtils';

/**
 * The layout primitives size themselves by their container, not the viewport (so a page looks the same
 * in the runtime and in the drafting preview). Mantine writes the breakpoints of a container-query grid
 * into `@container` rules verbatim: a theme name like `sm` there is not a length, the rule is dropped,
 * and a tile grid collapses to one column — which is what happened to the cohort app's three cards.
 * jsdom does no layout, but the generated rules are in the document, so this pins them.
 */
describe('container-query layouts', () => {
  it('emit @container rules with lengths, never theme breakpoint names', async () => {
    const entry = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_htn_cohort');
    if (!entry?.ok) throw new Error('cohort manifest missing');
    const cohort = validateManifest(entry.manifest);
    if (!cohort.ok) throw new Error('cohort manifest invalid');
    await renderManifest(cohort.manifest, { role: 'cohort_analyst', context: {} });

    const rules = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').filter((t) => t.includes('@container'));
    expect(rules.length).toBeGreaterThan(0);
    const gridRules = rules.filter((t) => t.includes('simple-grid'));
    expect(gridRules.length).toBeGreaterThan(0);
    for (const rule of gridRules) {
      expect(rule).toMatch(/@container simple-grid \(min-width: \d+(\.\d+)?(em|px|rem)\)/);
      expect(rule).not.toMatch(/\(min-width: (xs|sm|md|lg|xl)\)/);
      expect(rule).toContain('--sg-cols:3');
    }
  });
});
