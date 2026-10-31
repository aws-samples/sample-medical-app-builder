import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allSeedResources, SEED_ANCHOR } from '../primitives/data/mock/seed';

/**
 * The dispatcher Lambda serves infra/lambdas/dispatcher/data/synthetic-musterstadt.bundle.json, exported
 * from this seed with `npm run export:seed`. Mock mode and dispatcher mode must show the same
 * patients, so this test fails whenever the seed changes without re-exporting.
 */
const bundlePath = resolve(__dirname, '../../../infra/lambdas/dispatcher/data/synthetic-musterstadt.bundle.json');

describe('exported synthetic bundle', () => {
  it.skipIf(!existsSync(bundlePath))('matches the TypeScript seed exactly (run `npm run export:seed` after changing the seed)', () => {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as { type: string; timestamp: string; entry: { resource: unknown }[] };
    const fromSeed = JSON.parse(JSON.stringify(allSeedResources())) as unknown[];
    expect(bundle.type).toBe('collection');
    expect(bundle.timestamp).toBe(SEED_ANCHOR.toISOString());
    expect(bundle.entry.map((e) => e.resource)).toEqual(fromSeed);
  });
});
