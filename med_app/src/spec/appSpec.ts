import { z } from 'zod';
import type { ArchetypeDef, ArchetypeId, BuildContext } from './archetype';
import type { ShapeLookup } from './shapes';
import { ARCHETYPES } from './archetypes';
import { CommonSpecSchema, type SpecIssue } from './common';
import { defaultQuestionnaireBase } from './forms';

/**
 * AppSpec — what a drafting conversation produces. One variant per archetype: the common
 * sections (app, roles, governance) plus that archetype's knobs. Complete ⇒ compilable.
 */

export const AppSpecSchema = z
  .discriminatedUnion('archetype', [
    CommonSpecSchema.extend({ archetype: z.literal('APP-01'), knobs: ARCHETYPES['APP-01'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-02'), knobs: ARCHETYPES['APP-02'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-03'), knobs: ARCHETYPES['APP-03'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-04'), knobs: ARCHETYPES['APP-04'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-05'), knobs: ARCHETYPES['APP-05'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-06'), knobs: ARCHETYPES['APP-06'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-07'), knobs: ARCHETYPES['APP-07'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-08'), knobs: ARCHETYPES['APP-08'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-09'), knobs: ARCHETYPES['APP-09'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-10'), knobs: ARCHETYPES['APP-10'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-11'), knobs: ARCHETYPES['APP-11'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-12'), knobs: ARCHETYPES['APP-12'].knobs }),
    CommonSpecSchema.extend({ archetype: z.literal('APP-13'), knobs: ARCHETYPES['APP-13'].knobs }),
  ])
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    for (const [i, r] of spec.roles.entries()) {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: ['roles', i, 'id'], message: `duplicate role id "${r.id}"` });
      ids.add(r.id);
    }
    for (const [i, r] of spec.roles.entries()) {
      if (r.inherits && !ids.has(r.inherits)) ctx.addIssue({ code: 'custom', path: ['roles', i, 'inherits'], message: `"${r.inherits}" is not a declared role` });
      if (r.inherits === r.id) ctx.addIssue({ code: 'custom', path: ['roles', i, 'inherits'], message: 'a role cannot inherit itself' });
    }
    // Inheritance must be a tree.
    for (const r of spec.roles) {
      const seen = new Set<string>([r.id]);
      let cursor = r.inherits;
      while (cursor) {
        if (seen.has(cursor)) {
          ctx.addIssue({ code: 'custom', path: ['roles'], message: `cyclic inheritance through "${cursor}"` });
          break;
        }
        seen.add(cursor);
        cursor = spec.roles.find((x) => x.id === cursor)?.inherits;
      }
    }
    if (!ids.has(spec.default_role)) ctx.addIssue({ code: 'custom', path: ['default_role'], message: `"${spec.default_role}" is not a declared role` });
  });

export type AppSpec = z.infer<typeof AppSpecSchema>;
export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ArchetypeId[];

export interface ContextOptions {
  readonly hospital_id?: string;
  readonly questionnaire_base?: string;
  readonly created_at?: string;
  /** The published record shapes this compile may refer to. */
  readonly shapes?: ShapeLookup;
}

export function buildContext(spec: AppSpec, options?: ContextOptions): BuildContext {
  return {
    app: spec.app,
    roles: spec.roles,
    default_role: spec.default_role,
    questionnaire_base: options?.questionnaire_base ?? defaultQuestionnaireBase(options?.hospital_id),
    created_at: options?.created_at,
    shapes: options?.shapes,
    hospital_id: options?.hospital_id,
  };
}

/** Archetype-level cross-checks (knobs against roles etc.), on a schema-valid spec. */
export function archetypeIssues(spec: AppSpec, options?: ContextOptions): SpecIssue[] {
  // The union guarantees `knobs` is the archetype's own type; the registry lookup erases that, hence the cast.
  const def = ARCHETYPES[spec.archetype] as ArchetypeDef<unknown>;
  return def.check(buildContext(spec, options), spec.knobs);
}

function friendly(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.message.includes('received undefined')) return 'is required';
  if (issue.code === 'invalid_union' && 'errors' in issue) return 'does not match any allowed form';
  return issue.message;
}

export interface Readiness {
  /** True when the spec compiles; the agent stops asking. */
  readonly ready: boolean;
  /** What is still unclear or wrong — each item is a field the conversation must settle. */
  readonly missing: readonly SpecIssue[];
}

/**
 * The deterministic "is this clear enough?" the agent asks its questions from. A partial draft is
 * the normal input: every schema problem is an open point, every archetype check a contradiction.
 */
export function readiness(input: unknown, options?: ContextOptions): Readiness {
  const parsed = AppSpecSchema.safeParse(input);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: friendly(i) }));
    return { ready: false, missing: dedupe(missing) };
  }
  const issues = archetypeIssues(parsed.data, options);
  return { ready: issues.length === 0, missing: issues };
}

function dedupe(items: readonly SpecIssue[]): SpecIssue[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.path}::${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type SpecValidation = { ok: true; spec: AppSpec } | { ok: false; issues: SpecIssue[] };

export function validateSpec(input: unknown, options?: ContextOptions): SpecValidation {
  const r = readiness(input, options);
  if (!r.ready) return { ok: false, issues: [...r.missing] };
  return { ok: true, spec: AppSpecSchema.parse(input) };
}
