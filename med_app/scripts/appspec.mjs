#!/usr/bin/env node
/**
 * appspec — compile an AppSpec to a manifest, check readiness, validate a manifest, or print the
 * AppSpec JSON Schema. Bundles src/spec/cli.ts with esbuild (a Vite dependency, and the tool the
 * Node manifest-service Lambda will use) so the TypeScript sources run unchanged on plain Node.
 *
 *   npm run appspec -- compile specs/bp-trend.yaml
 *   npm run appspec -- readiness specs/bp-trend.yaml
 *   npm run appspec -- validate manifests/bp-trend.yaml
 *   npm run appspec -- schema --out docs/app-spec.schema.json
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = resolve(root, '.build', 'appspec-cli.mjs');

mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/spec/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external', // zod and yaml resolve from node_modules at runtime; only our sources are transpiled
  outfile,
  logLevel: 'silent',
});

const { main } = await import(pathToFileURL(outfile).href);
process.exitCode = main(process.argv.slice(2));
