#!/usr/bin/env node
/**
 * Bundle the manifest-service Lambda (src/spec/lambda.ts) into a single CommonJS file for the
 * Node.js Lambda runtime. The AuthoringStack runs this at synth time:
 *
 *   node scripts/bundle-lambda.mjs <outdir>        → <outdir>/index.js  (handler: index.handler)
 *
 * Everything is bundled (zod, yaml): the Lambda has no node_modules.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outdir = resolve(process.argv[2] ?? resolve(root, '.build', 'manifest-service'));

mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [resolve(root, 'src/spec/lambda.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(outdir, 'index.js'),
  sourcemap: false,
  minify: false,
  logLevel: 'silent',
});
writeFileSync(resolve(outdir, 'package.json'), JSON.stringify({ name: 'medapp-manifest-service', private: true, type: 'commonjs' }, null, 2));
console.log(`bundled manifest service → ${outdir}/index.js`);
