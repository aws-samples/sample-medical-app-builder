/**
 * Export the synthetic Musterstadt dataset as a FHIR Bundle for the dispatcher Lambda.
 *
 *   npm run export:seed
 *
 * The TypeScript generator in src/primitives/data/mock/seed.ts is the single source of truth;
 * this writes infra/lambdas/dispatcher/data/synthetic-musterstadt.bundle.json, which the Lambda serves
 * until the hospital FHIR server is reachable. src/tests/seedBundle.test.ts fails if the two drift.
 *
 * Runs on plain Node (≥ 22.6 with --experimental-strip-types, ≥ 23.6 without the flag).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allSeedResources, SEED_ANCHOR } from '../src/primitives/data/mock/seed.ts';

export function buildSeedBundle() {
  return {
    resourceType: 'Bundle',
    id: 'synthetic-musterstadt',
    type: 'collection',
    meta: {
      tag: [{ system: 'https://medapp.eu/tags', code: 'synthetic', display: 'Synthetic data — no real persons' }],
    },
    timestamp: SEED_ANCHOR.toISOString(),
    entry: allSeedResources().map((resource) => ({ resource })),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../infra/lambdas/dispatcher/data/synthetic-musterstadt.bundle.json');
mkdirSync(dirname(target), { recursive: true });
const bundle = buildSeedBundle();
writeFileSync(target, JSON.stringify(bundle, null, 1) + '\n');
console.log(`wrote ${bundle.entry.length} resources → ${target}`);
