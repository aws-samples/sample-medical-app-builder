import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { validateManifest } from '../manifest/schema';
import { readiness } from './appSpec';
import { compileSpec } from './compiler';
import { compileShape, shapeLookup, type RecordShapeArtifact, type ShapeLookup } from './shapes';
import { appSpecJsonSchema } from './jsonSchema';
import { recordKinds } from '../fhir/kinds';

/**
 * appspec — the compiler and validators from a terminal, for developing the agent against them
 * before any Lambda exists. Run through scripts/appspec.mjs (esbuild bundles this file).
 *
 *   appspec compile <spec.yaml> [--hospital <id>] [--created-at <iso>] [--created-by <sub>] [--shapes <dir|file.yaml|file.json>] [--out <manifest.yaml>] [--json]
 *   appspec readiness <spec.yaml> [--shapes <dir|file>]
 *   appspec shape <shape.yaml> [--json]        compile a record shape to its artifact (or list its problems)
 *   appspec validate <manifest.yaml>
 *   appspec schema [--out <file.json>]
 *   appspec kinds [--out <file.json>]         the kinds of record (admitted, open, closed, queryable) — the dispatcher's copy
 */

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const readDoc = (file: string): unknown => parseYaml(readFileSync(file, 'utf8'));

/**
 * The record shapes a compile may refer to: a directory of RecordShape YAML files (every *.yaml in it), one such file,
 * or a JSON file holding compiled artifacts (what the registry hands the manifest service). Absent: none.
 */
export function loadShapes(path: string | undefined, io: CliIo): ShapeLookup | undefined {
  if (!path) return undefined;
  const files = statSync(path).isDirectory() ? readdirSync(path).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort().map((f) => join(path, f)) : [path];
  const artifacts: RecordShapeArtifact[] = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      const docs = JSON.parse(readFileSync(file, 'utf8')) as RecordShapeArtifact[] | { shapes: RecordShapeArtifact[] };
      artifacts.push(...(Array.isArray(docs) ? docs : docs.shapes));
      continue;
    }
    const r = compileShape(readDoc(file));
    if (!r.ok) {
      io.err(`shape ${file} does not compile:`);
      for (const i of r.issues) io.err(`  ${i.path}: ${i.message}`);
      continue;
    }
    artifacts.push(r.artifact);
  }
  return shapeLookup(artifacts);
}

export function main(argv: readonly string[], io: CliIo = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }): number {
  const [command, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1]?.startsWith('--') ?? false));

  switch (command) {
    case 'compile': {
      const file = positional[0];
      if (!file) return usage(io);
      const createdBy = flag(rest, 'created-by');
      const shapes = loadShapes(flag(rest, 'shapes'), io);
      const result = compileSpec(readDoc(file), {
        hospital_id: flag(rest, 'hospital') ?? 'hsp-musterstadt',
        created_at: flag(rest, 'created-at') ?? new Date().toISOString(),
        ...(createdBy ? { created_by_sub: createdBy } : {}),
        ...(shapes ? { shapes } : {}),
      });
      if (rest.includes('--json')) {
        // Machine form for other processes (the Python agent): one JSON document, exit code says ok/not.
        io.out(JSON.stringify(result));
        return result.ok ? 0 : 1;
      }
      if (!result.ok) {
        io.err('The spec does not compile:');
        for (const i of result.issues) io.err(`  ${i.path}: ${i.message}`);
        return 1;
      }
      const yaml = toYaml(result.manifest, { lineWidth: 0 });
      const out = flag(rest, 'out');
      if (out) {
        writeFileSync(out, yaml);
        io.out(`wrote ${out}`);
      } else {
        io.out(yaml.trimEnd());
      }
      return 0;
    }
    case 'readiness': {
      const file = positional[0];
      if (!file) return usage(io);
      const shapes = loadShapes(flag(rest, 'shapes'), io);
      const r = readiness(readDoc(file), shapes ? { shapes } : undefined);
      io.out(JSON.stringify(r, null, 2));
      return r.ready ? 0 : 2;
    }
    case 'shape': {
      const file = positional[0];
      if (!file) return usage(io);
      const r = compileShape(readDoc(file));
      if (rest.includes('--json')) {
        io.out(JSON.stringify(r));
        return r.ok ? 0 : 1;
      }
      if (!r.ok) {
        io.err('The shape does not compile:');
        for (const i of r.issues) io.err(`  ${i.path}: ${i.message}`);
        return 1;
      }
      io.out(toYaml(r.artifact, { lineWidth: 0 }).trimEnd());
      return 0;
    }
    case 'validate': {
      const file = positional[0];
      if (!file) return usage(io);
      const r = validateManifest(readDoc(file));
      if (r.ok) {
        io.out(`valid: ${r.manifest.metadata.app_id}@${r.manifest.metadata.version}`);
        return 0;
      }
      io.err('invalid manifest:');
      for (const i of r.issues) io.err(`  ${i.path}: ${i.message}`);
      return 1;
    }
    case 'schema': {
      const json = JSON.stringify(appSpecJsonSchema(), null, 2);
      const out = flag(rest, 'out');
      if (out) {
        writeFileSync(out, `${json}\n`);
        io.out(`wrote ${out}`);
      } else {
        io.out(json);
      }
      return 0;
    }
    case 'kinds': {
      // One source for both sides: the rule in src/fhir/kinds.ts, written for the dispatcher (data/record-kinds.json); a test on each side fails on drift.
      const json = JSON.stringify(recordKinds(), null, 2);
      const out = flag(rest, 'out');
      if (out) {
        writeFileSync(out, `${json}\n`);
        io.out(`wrote ${out}`);
      } else {
        io.out(json);
      }
      return 0;
    }
    default:
      return usage(io);
  }
}

function usage(io: CliIo): number {
  io.err(
    [
      'usage:',
      '  appspec compile <spec.yaml> [--hospital <id>] [--created-at <iso>] [--created-by <sub>] [--shapes <dir|file>] [--out <manifest.yaml>] [--json]',
      '  appspec readiness <spec.yaml> [--shapes <dir|file>]   exit 0 when ready, 2 when not',
      '  appspec shape <shape.yaml> [--json]     compile a record shape to its artifact',
      '  appspec validate <manifest.yaml>',
      '  appspec schema [--out <file.json>]      JSON Schema of the AppSpec (input form)',
      '  appspec kinds [--out <file.json>]       the kinds of record and the query allow-list, for the dispatcher (npm run export:kinds)',
    ].join('\n')
  );
  return 64;
}
