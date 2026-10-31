import type { AppManifest } from '../manifest/schema';
import type { EffectiveScope } from '../manifest/roles';

/**
 * The only dynamic behaviour a manifest can express in props/config: references.
 *
 *   $bindings.<name>[.path…]   output of a data primitive
 *   $context.<name>            launch context (patient_id, window_start, …)
 *   $metadata.<field>          manifest metadata (name, version, …)
 *   $auth.role                 active role id
 *   $auth.effective.<field>    effective data scope (phi_fields_visible, …)
 *   $ui.<key>                  ephemeral UI state set by components (e.g. selected study)
 *
 * No arithmetic, no function calls, no string templates. This is deliberately a lookup
 * language, not an expression language — the CEL "escape valve" is a later, separate step.
 *
 * An unresolved reference is reported as a diagnostic — with one exception. `$ui.<key>` is written by a
 * component when the user acts (a study is selected), so before that the key simply is not there: an app
 * whose viewer reads `$ui.selected_study` is correct and shows "select a study", not a warning. A missing
 * `$ui` key therefore resolves to undefined silently; a path *into* a key that is set but has no such
 * member (`$ui.selected_study.uid` when the selection is a string) is still an authoring problem.
 */
export interface ExpressionEnv {
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: AppManifest['metadata'];
  readonly auth: { readonly role: string; readonly effective: EffectiveScope };
  readonly ui: Readonly<Record<string, unknown>>;
}

export interface Diagnostic {
  readonly level: 'warning' | 'error';
  readonly message: string;
}

const REF = /^\$(bindings|context|metadata|auth|ui)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)$/;

export function isReference(value: unknown): value is string {
  return typeof value === 'string' && REF.test(value);
}

function tokenize(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

function lookup(root: unknown, path: (string | number)[]): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      cur = cur[key];
    } else if (key === 'length' && Array.isArray(cur)) {
      cur = cur.length;
    } else if (typeof cur === 'object') {
      if (!(key in (cur as Record<string, unknown>))) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

export function resolveReference(ref: string, env: ExpressionEnv, diagnostics?: Diagnostic[]): unknown {
  const m = REF.exec(ref);
  if (!m) return ref;
  const root = m[1] as 'bindings' | 'context' | 'metadata' | 'auth' | 'ui';
  const path = tokenize(m[2] ?? '');
  const { found, value } = lookup(env[root], path);
  if (!found) {
    if (!(root === 'ui' && isUnsetUiKey(env.ui, path))) {
      diagnostics?.push({ level: 'warning', message: `Reference ${ref} did not resolve; rendered as undefined.` });
    }
    return undefined;
  }
  return value;
}

/** `$ui.<key>…` whose key no component has written yet — the state before the user acts, not a problem. */
function isUnsetUiKey(ui: Readonly<Record<string, unknown>>, path: (string | number)[]): boolean {
  const key = path[0];
  return typeof key === 'string' && !(key in ui);
}

/** Recursively resolve references inside props/config. Non-reference values pass through untouched. */
export function resolveDeep(value: unknown, env: ExpressionEnv, diagnostics?: Diagnostic[]): unknown {
  if (isReference(value)) return resolveReference(value, env, diagnostics);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, env, diagnostics));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveDeep(v, env, diagnostics);
    return out;
  }
  return value;
}

export function resolveRecord(
  value: Record<string, unknown> | undefined,
  env: ExpressionEnv,
  diagnostics?: Diagnostic[]
): Record<string, unknown> {
  return (resolveDeep(value ?? {}, env, diagnostics) as Record<string, unknown>) ?? {};
}

/** Binding names a config/props object depends on — used to order primitive execution. */
export function referencedBindings(value: unknown, acc = new Set<string>()): Set<string> {
  if (isReference(value)) {
    const m = REF.exec(value);
    if (m && m[1] === 'bindings') {
      const first = tokenize(m[2] ?? '')[0];
      if (typeof first === 'string') acc.add(first);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => referencedBindings(v, acc));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) => referencedBindings(v, acc));
  }
  return acc;
}
