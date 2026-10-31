#!/usr/bin/env node
/**
 * build-showcase — compile each hospital's seed set into the published manifests its registry ships.
 *
 *   npm run showcase                 # every set under showcase/<hospital_id>.yaml → manifests/<hospital_id>/<spec>.yaml
 *   npm run showcase -- hsp-musterstadt   # one hospital
 *
 * A set names its apps by spec (specs/<spec>.yaml) with the clinical note of an example sign-off, and groups them into
 * collections for the launcher. The manifests under med_app/manifests/<hospital_id>/ are not hand-written: each is the
 * deterministic compiler's output for its spec, stamped with the hospital's id, the lifecycle set to `published` with
 * that sign-off (the registry seed takes the state from the manifest). A manifest the set no longer names is removed.
 * Run this after changing a set, a spec or the compiler; src/tests/specCompiler.test.ts fails until the two agree
 * again. The hand-authored reference manifests live in fixtures/manifests and are not touched.
 */
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Document, parse, visit } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export const SHOWCASE_SIGNOFF = { approver_sub: 'example-approver-sub', approved_at: '2026-10-01T15:00:00Z', signature: 'example: KMS-signed manifest_hash goes here' };
export const SHOWCASE_CREATED_AT = '2026-10-01T14:00:00Z';

/** The seed sets: showcase/<hospital_id>.yaml, each `{ hospital_id, apps: [{ spec, note }], collections: [...] }`. */
export function loadSets(only) {
  const dir = resolve(root, 'showcase');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ file: f, ...parse(readFileSync(resolve(dir, f), 'utf8')) }))
    .filter((set) => {
      if (set.hospital_id !== basename(set.file, '.yaml')) throw new Error(`showcase/${set.file}: hospital_id ${set.hospital_id} must be the file's name`);
      if (!Array.isArray(set.apps) || set.apps.some((a) => !a?.spec || !a?.note)) throw new Error(`showcase/${set.file}: apps need a spec and a note each`);
      return !only || set.hospital_id === only;
    });
}

// The compiler itself (src/spec), bundled for plain Node like scripts/appspec.mjs does for the CLI.
const outfile = resolve(root, '.build', 'spec-index.mjs');
mkdirSync(dirname(outfile), { recursive: true });
await build({ entryPoints: [resolve(root, 'src/spec/index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', outfile, logLevel: 'silent' });
const { compileSpec } = await import(pathToFileURL(outfile).href);

const only = process.argv[2];
const sets = loadSets(only);
if (!sets.length) {
  console.error(only ? `no set showcase/${only}.yaml` : 'no sets under showcase/');
  process.exitCode = 1;
}

for (const set of sets) {
  const outDir = resolve(root, 'manifests', set.hospital_id);
  mkdirSync(outDir, { recursive: true });
  const wanted = new Set(set.apps.map((a) => `${a.spec}.yaml`));
  for (const stale of readdirSync(outDir).filter((f) => f.endsWith('.yaml') && !wanted.has(f))) {
    rmSync(resolve(outDir, stale));
    console.log(`manifests/${set.hospital_id}/${stale} removed (no longer in the set)`);
  }
  for (const { spec: name, note } of set.apps) {
    const source = readFileSync(resolve(root, 'specs', `${name}.yaml`), 'utf8');
    const result = compileSpec(parse(source), { hospital_id: set.hospital_id, created_at: SHOWCASE_CREATED_AT });
    if (!result.ok) {
      console.error(`${set.hospital_id}/${name}: not ready —`, JSON.stringify(result, null, 1));
      process.exitCode = 1;
      continue;
    }
    const manifest = { ...result.manifest, lifecycle: { state: 'published', signoff: { ...SHOWCASE_SIGNOFF, clinical_notes: note }, provenance: result.manifest.lifecycle.provenance } };
    const header = `# Seed app of ${set.hospital_id} — compiled from specs/${name}.yaml by scripts/build-showcase.mjs (npm run showcase); do not edit by hand.\n# The lifecycle block is an example sign-off: the registry seed publishes the app with it.\n`;
    // Written with the YAML 1.1 schema: PyYAML (the seed script) reads these files, and in YAML 1.1 an unquoted `Yes`,
    // `no`, `on` or a timestamp is a boolean or a datetime — so the writer quotes exactly those scalars. PyYAML also
    // reads a bare `=` as the YAML 1.1 "value" tag (an enableWhen operator is one), so that one is quoted by hand.
    const doc = new Document(manifest, { version: '1.1' });
    visit(doc, {
      Scalar(_key, node) {
        if (typeof node.value === 'string' && /^(=|~)$/.test(node.value)) node.type = 'QUOTE_DOUBLE';
      },
    });
    writeFileSync(resolve(outDir, `${name}.yaml`), header + doc.toString(), 'utf8');
    console.log(`manifests/${set.hospital_id}/${name}.yaml ← specs/${name}.yaml (${manifest.metadata.app_id}, published)`);
  }
  const ids = new Set(set.apps.map((a) => parse(readFileSync(resolve(root, 'specs', `${a.spec}.yaml`), 'utf8')).app.app_id));
  for (const c of set.collections ?? []) for (const id of c.apps ?? []) if (!ids.has(id)) console.warn(`showcase/${set.file}: collection "${c.name}" names ${id}, which is not in the set`);
}
