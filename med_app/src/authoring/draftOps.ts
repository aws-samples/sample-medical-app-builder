import { AppSpecSchema, ARCHETYPE_IDS, archetypeIssues } from '../spec/appSpec';
import { CommonSpecSchema } from '../spec/common';
import type { DraftOp, PlainSpec, SpecIssue } from './types';

/**
 * The draft operations, in the browser — a mirror of infra/app_creator/draft.py for the local
 * authoring client (mock mode, tests). Same rules: a wrong value is rejected and nothing changes; a
 * missing required field is simply still open. The deployed panel never runs these — the drafts
 * API applies them server-side — so the mirror only has to agree on outcomes, not on wording.
 */

export const SPEC_HEADER = { apiVersion: 'medapp.eu/v1', kind: 'AppSpec' } as const;

export class RejectedChange extends Error {
  constructor(readonly issues: readonly SpecIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    this.name = 'RejectedChange';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Recursive merge; `null` in the patch deletes the key; arrays replace. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) {
      if (v === null) delete out[k];
    } else if (isRecord(v) && isRecord(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

const REQUIRED = 'is required';

/** Split what the schema says into what is still open (missing) and what is wrong (rejected). */
export function classify(spec: PlainSpec): { open: SpecIssue[]; invalid: SpecIssue[] } {
  const full = { ...SPEC_HEADER, ...spec };
  if (!('archetype' in spec)) {
    // No archetype yet: the common sections still tell the conversation what is missing.
    const open: SpecIssue[] = [{ path: 'archetype', message: REQUIRED }];
    const invalid: SpecIssue[] = [];
    const common = CommonSpecSchema.safeParse(full);
    if (!common.success) {
      for (const issue of common.error.issues) {
        const path = issue.path.map(String).join('.') || '(root)';
        const missing = issue.code === 'invalid_type' && issue.message.includes('received undefined');
        (missing ? open : invalid).push({ path, message: missing ? REQUIRED : issue.message });
      }
    }
    return { open: dedupe(open), invalid: dedupe(invalid) };
  }
  // Schema: a missing required field is open, anything else is wrong. Archetype cross-checks (a knob
  // contradicting the roles, …) are open points too — the draft is accepted and the checklist says
  // what to settle, exactly as the drafts API behaves.
  const parsed = AppSpecSchema.safeParse(full);
  const open: SpecIssue[] = [];
  const invalid: SpecIssue[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.') || '(root)';
      const missing = issue.code === 'invalid_type' && issue.message.includes('received undefined');
      (missing ? open : invalid).push({ path, message: missing ? REQUIRED : issue.code === 'invalid_union' && 'errors' in issue ? 'does not match any allowed form' : issue.message });
    }
  } else {
    open.push(...archetypeIssues(parsed.data));
  }
  return { open: dedupe(open), invalid: dedupe(invalid) };
}

function dedupe(items: SpecIssue[]): SpecIssue[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.path}::${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function roles(spec: PlainSpec): Record<string, unknown>[] {
  return Array.isArray(spec.roles) ? (spec.roles as Record<string, unknown>[]) : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Apply one operation to a spec (without header) and return the new spec, or throw RejectedChange.
 * `knownGroups` is the hospital's group list; `null` means "not checked" (the API checks it).
 */
export function applyOp(spec: PlainSpec, op: DraftOp, knownGroups: readonly string[] | null): PlainSpec {
  const args = op.args ?? {};
  let next: PlainSpec = { ...spec };
  switch (op.op) {
    case 'choose_archetype': {
      const id = str(args.archetype);
      if (!(ARCHETYPE_IDS as readonly string[]).includes(id)) {
        throw new RejectedChange([{ path: 'archetype', message: `${id || '(none)'} cannot be built by this deployment; buildable: ${ARCHETYPE_IDS.join(', ')}` }]);
      }
      if (next.archetype !== id) delete next.knobs; // knobs belong to an archetype
      next.archetype = id;
      break;
    }
    case 'set_app': {
      const patch = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
      next.app = deepMerge(isRecord(next.app) ? next.app : {}, patch);
      break;
    }
    case 'set_knobs': {
      if (!('archetype' in next)) throw new RejectedChange([{ path: 'archetype', message: 'choose an archetype before setting knobs' }]);
      next.knobs = deepMerge(isRecord(next.knobs) ? next.knobs : {}, isRecord(args.patch) ? args.patch : {});
      break;
    }
    case 'add_role': {
      const role = isRecord(args.role) ? args.role : {};
      checkGroup(role.group, knownGroups);
      const kept = roles(next).filter((r) => r.id !== role.id);
      kept.push(Object.fromEntries(Object.entries(clone(role)).filter(([, v]) => v !== null && v !== undefined)));
      next.roles = kept;
      if (kept.length === 1 && !('default_role' in next)) next.default_role = role.id;
      break;
    }
    case 'update_role': {
      const id = str(args.id);
      const patch = isRecord(args.patch) ? args.patch : {};
      const list = roles(next).map((r) => ({ ...r }));
      const idx = list.findIndex((r) => r.id === id);
      const current = list[idx];
      if (idx < 0 || !current) throw new RejectedChange([{ path: 'roles', message: `no role "${id}"` }]);
      if ('group' in patch) checkGroup(patch.group, knownGroups);
      // `group` is a tagged union: a new binding replaces the old one, it does not merge with it.
      const { group, ...rest } = patch;
      let merged = deepMerge(current, rest);
      if ('group' in patch) {
        delete merged.group;
        if (group !== null && group !== undefined) merged = { ...merged, group: clone(group) };
      }
      list[idx] = merged;
      next.roles = list;
      break;
    }
    case 'remove_role': {
      const id = str(args.id);
      const kept = roles(next)
        .filter((r) => r.id !== id)
        .map((r) => {
          if (r.inherits === id) {
            const { inherits: _dropped, ...rest } = r;
            return rest;
          }
          return r;
        });
      next.roles = kept;
      if (next.default_role === id) delete next.default_role;
      break;
    }
    case 'set_default_role': {
      const id = str(args.id);
      if (!roles(next).some((r) => r.id === id)) throw new RejectedChange([{ path: 'default_role', message: `"${id}" is not a declared role` }]);
      next.default_role = id;
      break;
    }
    case 'set_governance': {
      const patch = Object.fromEntries(Object.entries(isRecord(args.patch) ? args.patch : {}).filter(([, v]) => v !== null && v !== undefined));
      next.governance = deepMerge(isRecord(next.governance) ? next.governance : {}, patch);
      break;
    }
    default:
      throw new RejectedChange([{ path: '(root)', message: `unknown op ${String((op as { op: unknown }).op)}` }]);
  }
  next = clone(next);
  const { invalid } = classify(next);
  if (invalid.length) throw new RejectedChange(invalid);
  return next;
}

function checkGroup(group: unknown, knownGroups: readonly string[] | null): void {
  if (knownGroups === null || !isRecord(group) || group.kind !== 'existing') return;
  const name = str(group.name);
  if (!knownGroups.includes(name)) {
    throw new RejectedChange([
      {
        path: 'roles.group.name',
        message: `"${name}" is not an existing group in this hospital's user pool.${knownGroups.length ? ` Existing groups: ${knownGroups.join(', ')}.` : ''}`,
      },
    ]);
  }
}

/** All operations or none. */
export function applyOps(spec: PlainSpec, ops: readonly DraftOp[], knownGroups: readonly string[] | null): PlainSpec {
  let next = spec;
  for (const op of ops) next = applyOp(next, op, knownGroups);
  return next;
}

/** The spec as the compiler expects it. */
export function withHeader(spec: PlainSpec): PlainSpec {
  return { ...SPEC_HEADER, ...clone(spec) };
}

/** Strip the header and anything that is not a spec section. */
export function withoutHeader(spec: PlainSpec): PlainSpec {
  const { apiVersion: _a, kind: _k, ...rest } = spec;
  return clone(rest);
}
