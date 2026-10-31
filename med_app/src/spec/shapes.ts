import { z } from 'zod';
import type { RecordEntryRules } from '../primitives/data/recordShape';
import { identifier, type SpecIssue } from './common';
import { canonicalJson } from './canonical';
import { DeclaredStampSchema, OPEN_KINDS, RECORD_RESOURCES, RecordFieldSchema, RecordStatusSchema, checkRecordSection, isAdmittedKind, recordRules, type RecordField } from './record';

/**
 * A record shape as a document of its own — the library's unit. The same declaration a `record` section carries inline
 * (resource, fields, status), under a stable id and a name, so that many apps can say `shape: measurable_goal` and
 * write the same thing, reviewed once. Compiles to an artifact: the runtime rules (fields with encodings, stamps) the
 * composer embeds into a manifest, plus a checksum so a pinned version can be told from a later one.
 */

export const RecordShapeSchema = z
  .strictObject({
    apiVersion: z.literal('medapp.eu/v1'),
    kind: z.literal('RecordShape'),
    shape: z.strictObject({
      id: identifier.describe('Stable id apps refer to: `shape: measurable_goal`'),
      name: z.string().min(1).max(120).describe('As the library lists it'),
      description: z.string().max(2000).optional().describe('What it records and for whom — the sentence a reviewer reads'),
      resource: z
        .string()
        .regex(/^[A-Z][A-Za-z]+$/, 'a FHIR resource type')
        .describe(`The kind of record: one the platform admits (${RECORD_RESOURCES.join(', ')}) — or, defined by an administrator, one it opens (${OPEN_KINDS.join(', ')}) with its stamps declared`),
      fields: z.array(RecordFieldSchema).min(1).max(20),
      status: RecordStatusSchema,
      stamps: z
        .array(DeclaredStampSchema)
        .min(1)
        .max(8)
        .optional()
        .describe('For a kind the platform has not admitted: what it sets on every record — at least the patient ($patient on the patient or subject element), usually the status (a literal) and the moment ($now or $today); never a field'),
    }),
  })
  .describe('A record shape: a resource type and the fields a form for it has, reusable across apps');

export type RecordShapeDoc = z.infer<typeof RecordShapeSchema>;

export interface RecordShapeArtifact {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** An admitted kind, or an open kind an administrator defined the stamps for. */
  readonly resource: string;
  /** True for a kind the platform has not admitted — the stamps are the administrator's, and the review page says so. */
  readonly open_kind?: boolean;
  /** The author-facing fields, for the panel to show and edit. */
  readonly fields: readonly RecordField[];
  readonly status?: string;
  /** What the composer embeds and the dispatcher enforces. */
  readonly rules: RecordEntryRules;
  /** A fingerprint of the canonical shape document (FNV-1a 64) — the same document is the same shape; a change detector, not a signature. The registry hashes the stored version with sha256 server-side. */
  readonly checksum: string;
  /** The version the registry published this artifact as (`0.2.0`) — set by whoever hands a library over (the registry writer, the agent's library, the panel); absent for a bundled or freshly compiled artifact. */
  readonly version?: string;
}

/** The code system of the `meta.tag` every record written with a library shape carries: `<system>|<shape id>`, the coding's `version` the shape's version. */
export function recordShapeTagSystem(hospitalId: string | undefined): string {
  return hospitalId ? `https://${hospitalId}.medapp.eu/CodeSystem/record-shape` : 'https://medapp.eu/CodeSystem/record-shape';
}

/** The tag a record written with this shape carries — the shape and its version, readable on the record itself (`_tag=<system>|<id>`). */
export function recordShapeTag(artifact: RecordShapeArtifact, hospitalId: string | undefined): { system: string; code: string; version: string; display: string } {
  return { system: recordShapeTagSystem(hospitalId), code: artifact.id, version: artifact.version ?? artifact.checksum, display: artifact.name };
}

/** The authoring problems of a shape document (schema, then the field checks of a record section), as the panel lists them. */
export function shapeIssues(input: unknown): SpecIssue[] {
  const parsed = RecordShapeSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.code === 'invalid_type' && i.message.includes('received undefined') ? 'is required' : i.message }));
  return checkRecordSection(parsed.data.shape, 'shape');
}

export type ShapeCompileResult = { ok: true; artifact: RecordShapeArtifact } | { ok: false; issues: SpecIssue[] };

export function compileShape(input: unknown): ShapeCompileResult {
  const issues = shapeIssues(input);
  if (issues.length) return { ok: false, issues };
  const doc = RecordShapeSchema.parse(input);
  const s = doc.shape;
  const rules = recordRules(s);
  return {
    ok: true,
    artifact: {
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      resource: s.resource,
      ...(isAdmittedKind(s.resource) ? {} : { open_kind: true }),
      fields: s.fields,
      ...(s.status ? { status: s.status } : {}),
      rules,
      checksum: `fnv1a64:${fnv1a64(canonicalJson(doc))}`,
    },
  };
}

/** FNV-1a over the UTF-8 bytes of a string, 64-bit, as 16 hex digits — runs the same in the browser and in Node. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The shapes a compile may refer to, by id. */
export type ShapeLookup = ReadonlyMap<string, RecordShapeArtifact>;

export function shapeLookup(artifacts: readonly RecordShapeArtifact[]): ShapeLookup {
  return new Map(artifacts.map((a) => [a.id, a]));
}
