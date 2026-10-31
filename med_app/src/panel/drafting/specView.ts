import type { z } from 'zod';
import type { PlainSpec, SpecIssue } from '../../authoring/types';
import { ARCHETYPES } from '../../spec/archetypes';
import type { ArchetypeId } from '../../spec/archetype';
import { PHI_FIELDS, type PhiField } from '../../manifest/schema';

/**
 * Reading a partial AppSpec for the editors. The draft is plain JSON until it is complete, so these
 * helpers read what is there and leave the rest undefined — the readiness list says what is missing.
 */

export interface RoleDraft {
  readonly id: string;
  readonly display_name: string;
  readonly group: { kind: 'app_group' } | { kind: 'existing'; name: string };
  readonly inherits?: string;
  readonly phi_fields_visible: readonly PhiField[];
  readonly capabilities: readonly string[];
}

export interface SpecReading {
  readonly archetype?: ArchetypeId;
  readonly app: { readonly app_id?: string; readonly name?: string; readonly description?: string; readonly language?: 'en' | 'de'; readonly version?: string; readonly parent_version?: string };
  readonly roles: readonly RoleDraft[];
  readonly default_role?: string;
  readonly governance: {
    readonly clinical_context?: string;
    readonly intended_users?: readonly string[];
    readonly intended_purpose?: string;
    readonly mdr_classification?: string;
    readonly data_categories?: readonly string[];
  };
  readonly knobs: Record<string, unknown>;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function readSpec(spec: PlainSpec): SpecReading {
  const app = rec(spec.app);
  const gov = rec(spec.governance);
  const archetype = strOrUndef(spec.archetype);
  const roles: RoleDraft[] = (Array.isArray(spec.roles) ? spec.roles : []).map((raw) => {
    const r = rec(raw);
    const group = rec(r.group);
    return {
      id: strOrUndef(r.id) ?? '',
      display_name: strOrUndef(r.display_name) ?? '',
      group: group.kind === 'existing' ? { kind: 'existing', name: strOrUndef(group.name) ?? '' } : { kind: 'app_group' },
      inherits: strOrUndef(r.inherits),
      phi_fields_visible: strList(r.phi_fields_visible).filter((f): f is PhiField => (PHI_FIELDS as readonly string[]).includes(f)),
      capabilities: strList(r.capabilities),
    };
  });
  return {
    archetype: archetype && archetype in ARCHETYPES ? (archetype as ArchetypeId) : undefined,
    app: {
      app_id: strOrUndef(app.app_id),
      name: strOrUndef(app.name),
      description: strOrUndef(app.description),
      language: app.language === 'de' ? 'de' : app.language === 'en' ? 'en' : undefined,
      version: strOrUndef(app.version),
      parent_version: strOrUndef(app.parent_version),
    },
    roles,
    default_role: strOrUndef(spec.default_role),
    governance: {
      clinical_context: strOrUndef(gov.clinical_context),
      intended_users: Array.isArray(gov.intended_users) ? strList(gov.intended_users) : undefined,
      intended_purpose: strOrUndef(gov.intended_purpose),
      mdr_classification: strOrUndef(gov.mdr_classification),
      data_categories: Array.isArray(gov.data_categories) ? strList(gov.data_categories) : undefined,
    },
    knobs: rec(spec.knobs),
  };
}

/* ── readiness, by section ────────────────────────────────────────────────── */

export type SectionId = 'overview' | 'roles' | 'governance' | 'knobs';

export const SECTION_LABELS: Record<SectionId, string> = {
  overview: 'App',
  roles: 'Roles & access',
  governance: 'Governance',
  knobs: 'Settings',
};

export function sectionOf(path: string): SectionId {
  const head = path.split('.')[0];
  switch (head) {
    case 'archetype':
    case 'app':
      return 'overview';
    case 'roles':
    case 'default_role':
      return 'roles';
    case 'governance':
      return 'governance';
    default:
      return 'knobs';
  }
}

/**
 * A short, human line for an open item — "Roles: at least one role", "App: name"; an item inside a
 * list of sections/groups/panels is prefixed with its position ("Section 2 · Observation codes").
 */
export function describeIssue(issue: SpecIssue): string {
  const parts = issue.path.split('.');
  const leaf = parts[parts.length - 1] ?? issue.path;
  const inList = /^knobs\.(sections|groups|panels)\.(\d+)(?:\.|$)/.exec(issue.path);
  const prefix = inList ? `${LIST_ITEM_LABELS[inList[1] ?? ''] ?? 'Item'} ${Number(inList[2]) + 1} · ` : '';
  const label = inList ? (/^\d+$/.test(leaf) ? 'settings' : (ITEM_LEAF_LABELS[leaf] ?? leaf.replace(/_/g, ' '))) : (LEAF_LABELS[issue.path] ?? LEAF_LABELS[leaf] ?? leaf.replace(/_/g, ' '));
  return issue.message === 'is required' ? `${prefix}${label}` : `${prefix}${label}: ${issue.message}`;
}

const LIST_ITEM_LABELS: Record<string, string> = { sections: 'Section', groups: 'Group', panels: 'Panel' };

/** Leaves inside a section, group or panel. */
const ITEM_LEAF_LABELS: Record<string, string> = {
  kind: 'Kind of section',
  codes: 'Observation codes',
  series: 'Plotted series',
  questionnaire: 'Which form (Questionnaire)',
  resource: 'Resource type',
  modalities: 'Imaging modalities',
  roles: 'Roles that see it',
  id: 'Id',
  label: 'Label',
  columns: 'Columns',
  path: 'Field path',
  category: 'Report category',
  type: 'Document type',
};

const LEAF_LABELS: Record<string, string> = {
  archetype: 'Which kind of app',
  app: 'App name and id',
  'app.app_id': 'App id',
  'app.name': 'App name',
  roles: 'At least one role',
  default_role: 'Default role',
  governance: 'Clinical context, intended users and purpose',
  'governance.clinical_context': 'Clinical context',
  'governance.intended_users': 'Intended users',
  'governance.intended_purpose': 'Intended purpose',
  knobs: 'The archetype settings',
  'knobs.codes': 'Observation codes',
  'knobs.series': 'Plotted series',
  'knobs.sections': 'Page sections',
  'knobs.condition': 'Cohort condition',
  'knobs.value': 'Compared value',
  'knobs.groups': 'Observation groups',
  'knobs.panels': 'Panels to show',
  'knobs.questionnaire': 'Which form (Questionnaire)',
  'knobs.vitals_codes': 'Codes counted as readings',
  'knobs.modalities': 'Imaging modalities',
  'knobs.template': 'Template',
};

/* ── knobs summary ────────────────────────────────────────────────────────── */

export interface KnobLine {
  readonly key: string;
  readonly description?: string;
  /** Formatted current value; undefined when the draft does not set it. */
  readonly value?: string;
  /** Formatted schema default, when the draft does not set the knob. */
  readonly fallback?: string;
  readonly required: boolean;
}

type AnySchema = z.ZodType & { def: Record<string, unknown>; description?: string };

function unwrap(schema: AnySchema): { inner: AnySchema; hasDefault: boolean; defaultValue?: unknown; optional: boolean; description?: string } {
  let cursor = schema;
  let hasDefault = false;
  let optional = false;
  let defaultValue: unknown;
  let description = schema.description;
  for (let i = 0; i < 6; i++) {
    const type = cursor.def.type;
    if (type === 'default') {
      hasDefault = true;
      const dv = cursor.def.defaultValue;
      defaultValue = typeof dv === 'function' ? (dv as () => unknown)() : dv;
    } else if (type === 'optional' || type === 'nullable') {
      optional = true;
    } else {
      break;
    }
    const next = cursor.def.innerType as AnySchema | undefined;
    if (!next) break;
    description ??= next.description;
    cursor = next;
  }
  return { inner: cursor, hasDefault, defaultValue, optional, description };
}

/** One line per knob of the archetype, in schema order, with the draft's value or the default. */
export function describeKnobs(archetype: ArchetypeId, knobs: Record<string, unknown>): KnobLine[] {
  const schema = ARCHETYPES[archetype].knobs as unknown as { shape?: Record<string, AnySchema> };
  const shape = schema.shape ?? {};
  return Object.entries(shape).map(([key, field]) => {
    const { hasDefault, defaultValue, optional, description } = unwrap(field);
    const has = key in knobs;
    return {
      key,
      description,
      value: has ? formatValue(knobs[key]) : undefined,
      fallback: !has && hasDefault ? formatValue(defaultValue) : undefined,
      required: !hasDefault && !optional,
    };
  });
}

export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    if (v.every((x) => typeof x !== 'object' || x === null)) return v.map(formatValue).join(', ');
    return v.map((x) => formatValue(x)).join('\n');
  }
  // A tagged item (a section, a panel) leads with its kind: "trend · span: 8 · codes: …".
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a === 'kind' ? -1 : b === 'kind' ? 1 : 0));
  return entries.map(([k, val]) => (k === 'kind' ? String(val) : `${k.replace(/_/g, ' ')}: ${Array.isArray(val) || (typeof val === 'object' && val !== null) ? formatValue(val).replace(/\n/g, '; ') : formatValue(val)}`)).join(' · ');
}

/* ── tool names → what the progress chips say ─────────────────────────────── */

export const TOOL_LABELS: Record<string, string> = {
  describe_archetype: 'reading the catalog',
  choose_archetype: 'choosing the kind of app',
  set_app: 'naming the app',
  set_knobs: 'setting it up',
  add_role: 'adding a role',
  update_role: 'changing a role',
  remove_role: 'removing a role',
  set_default_role: 'choosing the default role',
  set_governance: 'recording governance',
  get_draft: 'reading the draft',
  check_readiness: 'checking what is still open',
  compile_preview: 'compiling a preview',
  list_groups: 'checking hospital groups',
  lookup_codes: 'looking up codes',
  record_refusal: 'noting a limit',
  seed_spec: 'starting from the saved app',
  panel_edit: 'edited in the panel',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

/**
 * Would saving this draft change anything? The registry writer sets `apiVersion`/`kind` and the `app.version` /
 * `app.parent_version` it assigns, so those are not differences; everything else is compared structurally with sorted
 * keys. Used to keep "Save as new version" and "Save changes" disabled when the draft equals the version it came from.
 */
export function specsEqual(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  return canonical(comparable(a)) === canonical(comparable(b));
}

function comparable(spec: Record<string, unknown> | undefined): Record<string, unknown> {
  const { apiVersion: _api, kind: _kind, app, ...rest } = spec ?? {};
  const { version: _v, parent_version: _pv, ...appRest } = (app as Record<string, unknown> | undefined) ?? {};
  return { ...rest, app: appRest };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
