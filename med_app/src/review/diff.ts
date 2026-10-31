import { stringify as toYaml } from 'yaml';
import type { QuestionnaireArtifact, QuestionnaireArtifactItem } from '../manifest/artifacts';
import { QUESTIONNAIRE_MAX_VALUE_EXTENSION, QUESTIONNAIRE_MIN_VALUE_EXTENSION, QUESTIONNAIRE_UNIT_EXTENSION } from '../manifest/artifacts';
import type { RegistryEntry } from '../manifest/registry';
import { resolveEffectiveScope, type EffectiveScope } from '../manifest/roles';
import type { AppManifest, LayoutNode, LifecycleState, PhiField } from '../manifest/schema';

/**
 * What an approver reviews: the difference between the version in front of them and the one clinicians use today.
 *
 * The comparison runs on the manifests — what actually runs and what is signed — for everything that bears on
 * access: roles and the scope each effectively gets (after `inherits`), the data primitives and their configuration,
 * the write actions, the app's own forms, the purpose the approver signs, the launch context. Any step that gives a
 * role access it did not have is a *widening* and is said first; what takes access away is a *narrowing*; the rest is
 * neutral. The author's own level — the spec's knobs — is compared too, when both versions carry a spec of the same
 * archetype, so a threshold moved from 140 to 130 reads as that and not as a change to three primitive configs.
 *
 * Pure functions, no React: `reviewDiff(candidate, baseline)`.
 */

export type Severity = 'widening' | 'narrowing' | 'neutral';

export interface Change {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly severity: Severity;
  /** What changed, named — "Role Hypertension nurse", "Observation", "Question “Home systolic”". */
  readonly subject: string;
  /** The change in words. */
  readonly detail?: string;
  readonly before?: string;
  readonly after?: string;
}

export type SectionId = 'purpose' | 'roles' | 'primitives' | 'actions' | 'forms' | 'context' | 'settings' | 'layout';

export interface ReviewSection {
  readonly id: SectionId;
  readonly title: string;
  readonly changes: readonly Change[];
}

export interface VersionRef {
  readonly version: string;
  readonly state: LifecycleState;
}

export type AccessVerdict = 'new' | 'widened' | 'narrowed' | 'mixed' | 'unchanged';

export interface ReviewDiff {
  readonly app_id: string;
  readonly candidate: VersionRef;
  /** The published version compared against; null for a first version. */
  readonly baseline: VersionRef | null;
  /** Both versions carry a spec of a different archetype: the app was rebuilt, knob-level comparison is not meaningful. */
  readonly archetype: { readonly before: string; readonly after: string } | null;
  readonly sections: readonly ReviewSection[];
  readonly summary: {
    readonly access: AccessVerdict;
    readonly widenings: readonly Change[];
    readonly narrowings: readonly Change[];
    /** Every change, across sections. */
    readonly total: number;
  };
  /** The two versions as text, for a line diff: the specs when both exist, else the manifests. */
  readonly text: { readonly before: string; readonly after: string; readonly of: 'spec' | 'manifest' };
}

type OkEntry = Extract<RegistryEntry, { ok: true }>;

/* ── helpers ──────────────────────────────────────────────────────────────────────────────────── */

const PATIENT_SCOPE_RANK = { individual: 0, cohort: 1, population: 2 } as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object' || v === null)) return value.length ? value.map(String).join(', ') : '(none)';
  return JSON.stringify(value);
}

function list(values: Iterable<string>): string {
  return [...values].join(', ');
}

function setDiff<T>(before: Iterable<T>, after: Iterable<T>): { added: T[]; removed: T[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

/* ── access: roles and their effective scopes ─────────────────────────────────────────────────── */

interface ResourceAccess {
  readonly operations: Set<string>;
  /** null = any code of the resource. */
  readonly codes: Set<string> | null;
  readonly filters: Set<string>;
}

interface DicomAccess {
  readonly operations: Set<string>;
  /** null = any modality. */
  readonly modalities: Set<string> | null;
}

interface NormalisedScope {
  readonly fhir: Map<string, ResourceAccess>;
  readonly dicom: DicomAccess | null;
  readonly patient_scope: EffectiveScope['patient_scope'];
  readonly phi: Set<PhiField>;
}

/** The effective scope as what it grants: per resource the union of operations, and the codes unless one entry is unrestricted. */
export function normaliseScope(scope: EffectiveScope): NormalisedScope {
  const fhir = new Map<string, ResourceAccess>();
  for (const entry of scope.fhir) {
    const current: ResourceAccess = fhir.get(entry.resource) ?? { operations: new Set<string>(), codes: new Set<string>(), filters: new Set<string>() };
    entry.operations.forEach((op) => current.operations.add(op));
    let codes: Set<string> | null = current.codes;
    if (!entry.codes) codes = null;
    else if (codes) entry.codes.forEach((c) => codes!.add(c));
    if (entry.filter) current.filters.add(entry.filter);
    fhir.set(entry.resource, { operations: current.operations, codes, filters: current.filters });
  }
  let dicom: DicomAccess | null = null;
  for (const entry of scope.dicom) {
    const current: DicomAccess = dicom ?? { operations: new Set<string>(), modalities: new Set<string>() };
    entry.operations.forEach((op) => current.operations.add(op));
    let modalities: Set<string> | null = current.modalities;
    if (!entry.modalities) modalities = null;
    else if (modalities) entry.modalities.forEach((m) => modalities!.add(m));
    dicom = { operations: current.operations, modalities };
  }
  return { fhir, dicom, patient_scope: scope.patient_scope, phi: new Set(scope.phi_fields_visible) };
}

function describeScope(scope: NormalisedScope): string {
  const parts: string[] = [];
  for (const [resource, access] of scope.fhir) parts.push(`${resource} ${[...access.operations].join('/')}${access.codes ? ` (${access.codes.size} code${access.codes.size === 1 ? '' : 's'})` : ''}`);
  if (scope.dicom) parts.push(`DICOM ${[...scope.dicom.operations].join('/')}${scope.dicom.modalities ? ` (${[...scope.dicom.modalities].join(', ')})` : ''}`);
  parts.push(`${scope.patient_scope} patient scope`);
  parts.push(scope.phi.size ? `sees ${[...scope.phi].join(', ')}` : 'sees no identity fields');
  return parts.join('; ');
}

/** The changes between two effective scopes of one role, each a widening or a narrowing. */
export function scopeChanges(roleLabel: string, before: NormalisedScope, after: NormalisedScope): Change[] {
  const out: Change[] = [];
  const resources = new Set([...before.fhir.keys(), ...after.fhir.keys()]);
  for (const resource of [...resources].sort()) {
    const b = before.fhir.get(resource);
    const a = after.fhir.get(resource);
    if (!b && a) {
      out.push({ kind: 'added', severity: 'widening', subject: `${roleLabel} · ${resource}`, detail: `may now ${[...a.operations].join(' and ')} ${resource}${a.codes ? ` (${a.codes.size} code${a.codes.size === 1 ? '' : 's'})` : ' — any code'}` });
      continue;
    }
    if (b && !a) {
      out.push({ kind: 'removed', severity: 'narrowing', subject: `${roleLabel} · ${resource}`, detail: `no longer reaches ${resource}` });
      continue;
    }
    if (!b || !a) continue;
    const ops = setDiff(b.operations, a.operations);
    if (ops.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · ${resource}`, detail: `may now ${ops.added.join(' and ')} ${resource}`, before: list(b.operations), after: list(a.operations) });
    if (ops.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · ${resource}`, detail: `may no longer ${ops.removed.join(' or ')} ${resource}`, before: list(b.operations), after: list(a.operations) });
    if (b.codes && !a.codes) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · ${resource}`, detail: `any ${resource} code now, not only ${b.codes.size}`, before: list(b.codes), after: 'any code' });
    else if (!b.codes && a.codes) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · ${resource}`, detail: `limited to ${a.codes.size} ${resource} code${a.codes.size === 1 ? '' : 's'}`, before: 'any code', after: list(a.codes) });
    else if (b.codes && a.codes) {
      const codes = setDiff(b.codes, a.codes);
      if (codes.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · ${resource}`, detail: `codes added: ${codes.added.join(', ')}`, before: list(b.codes), after: list(a.codes) });
      if (codes.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · ${resource}`, detail: `codes removed: ${codes.removed.join(', ')}`, before: list(b.codes), after: list(a.codes) });
    }
    const filters = setDiff(b.filters, a.filters);
    if (filters.removed.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · ${resource}`, detail: `filter removed: ${filters.removed.join('; ')}` });
    if (filters.added.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · ${resource}`, detail: `filter added: ${filters.added.join('; ')}` });
  }
  if (!before.dicom && after.dicom) out.push({ kind: 'added', severity: 'widening', subject: `${roleLabel} · imaging`, detail: `may now ${[...after.dicom.operations].join(' and ')} imaging${after.dicom.modalities ? ` (${[...after.dicom.modalities].join(', ')})` : ' — any modality'}` });
  else if (before.dicom && !after.dicom) out.push({ kind: 'removed', severity: 'narrowing', subject: `${roleLabel} · imaging`, detail: 'no longer reaches imaging' });
  else if (before.dicom && after.dicom) {
    const ops = setDiff(before.dicom.operations, after.dicom.operations);
    if (ops.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · imaging`, detail: `may now ${ops.added.join(' and ')}`, before: list(before.dicom.operations), after: list(after.dicom.operations) });
    if (ops.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · imaging`, detail: `may no longer ${ops.removed.join(' or ')}`, before: list(before.dicom.operations), after: list(after.dicom.operations) });
    if (before.dicom.modalities && !after.dicom.modalities) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · imaging`, detail: 'any modality now', before: list(before.dicom.modalities), after: 'any modality' });
    else if (!before.dicom.modalities && after.dicom.modalities) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · imaging`, detail: `limited to ${list(after.dicom.modalities)}`, before: 'any modality', after: list(after.dicom.modalities) });
    else if (before.dicom.modalities && after.dicom.modalities) {
      const mods = setDiff(before.dicom.modalities, after.dicom.modalities);
      if (mods.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · imaging`, detail: `modalities added: ${mods.added.join(', ')}`, before: list(before.dicom.modalities), after: list(after.dicom.modalities) });
      if (mods.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · imaging`, detail: `modalities removed: ${mods.removed.join(', ')}`, before: list(before.dicom.modalities), after: list(after.dicom.modalities) });
    }
  }
  if (before.patient_scope !== after.patient_scope) {
    const wider = PATIENT_SCOPE_RANK[after.patient_scope] > PATIENT_SCOPE_RANK[before.patient_scope];
    out.push({ kind: 'changed', severity: wider ? 'widening' : 'narrowing', subject: `${roleLabel} · patient scope`, detail: wider ? `reaches ${after.patient_scope === 'population' ? 'the whole population' : 'a cohort'}, not only ${before.patient_scope === 'individual' ? 'one patient' : 'a cohort'}` : `limited to ${after.patient_scope === 'individual' ? 'one patient' : 'a cohort'}`, before: before.patient_scope, after: after.patient_scope });
  }
  const phi = setDiff(before.phi, after.phi);
  if (phi.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${roleLabel} · identity fields`, detail: `now sees ${phi.added.join(', ')}`, before: list(before.phi) || '(none)', after: list(after.phi) });
  if (phi.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${roleLabel} · identity fields`, detail: `no longer sees ${phi.removed.join(', ')}`, before: list(before.phi), after: list(after.phi) || '(none)' });
  return out;
}

function roleChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  const scopesAfter = new Map(after.auth.roles.map((r) => [r.id, normaliseScope(resolveEffectiveScope(after, r.id))]));
  const scopesBefore = new Map((before?.auth.roles ?? []).map((r) => [r.id, normaliseScope(resolveEffectiveScope(before!, r.id))]));
  const label = (m: AppManifest, id: string) => `Role ${m.auth.roles.find((r) => r.id === id)?.display_name ?? id}`;

  for (const role of after.auth.roles) {
    const prev = before?.auth.roles.find((r) => r.id === role.id);
    const scope = scopesAfter.get(role.id)!;
    if (!prev) {
      out.push({ kind: 'added', severity: before ? 'widening' : 'neutral', subject: label(after, role.id), detail: `granted by ${role.cognito_group}: ${describeScope(scope)}` });
      continue;
    }
    if (prev.cognito_group !== role.cognito_group) out.push({ kind: 'changed', severity: 'neutral', subject: `${label(after, role.id)} · group`, detail: 'a different group grants this role now', before: prev.cognito_group, after: role.cognito_group });
    if (prev.display_name !== role.display_name) out.push({ kind: 'changed', severity: 'neutral', subject: `${label(after, role.id)} · name`, before: prev.display_name, after: role.display_name });
    const caps = setDiff(prev.ui_capabilities, role.ui_capabilities);
    if (caps.added.length) out.push({ kind: 'changed', severity: 'widening', subject: `${label(after, role.id)} · capabilities`, detail: `gains ${caps.added.join(', ')}`, before: list(prev.ui_capabilities), after: list(role.ui_capabilities) });
    if (caps.removed.length) out.push({ kind: 'changed', severity: 'narrowing', subject: `${label(after, role.id)} · capabilities`, detail: `loses ${caps.removed.join(', ')}`, before: list(prev.ui_capabilities), after: list(role.ui_capabilities) });
    out.push(...scopeChanges(label(after, role.id), scopesBefore.get(role.id)!, scope));
  }
  for (const role of before?.auth.roles ?? []) {
    if (!after.auth.roles.some((r) => r.id === role.id)) out.push({ kind: 'removed', severity: 'narrowing', subject: label(before!, role.id), detail: `${role.cognito_group} no longer grants anything in this app` });
  }
  if (before && before.auth.default_role !== after.auth.default_role) {
    const b = scopesBefore.get(before.auth.default_role);
    const a = scopesAfter.get(after.auth.default_role);
    const widenings = b && a ? scopeChanges('default role', b, a).filter((c) => c.severity === 'widening') : [];
    out.push({
      kind: 'changed',
      severity: widenings.length ? 'widening' : 'neutral',
      subject: 'Default role (blanket viewers)',
      detail: widenings.length ? `blanket viewers get a wider scope: ${widenings.map((w) => w.detail).join('; ')}` : 'blanket viewers run as a different role',
      before: label(before, before.auth.default_role).replace(/^Role /, ''),
      after: label(after, after.auth.default_role).replace(/^Role /, ''),
    });
  }
  return out;
}

/* ── primitives, actions, context ─────────────────────────────────────────────────────────────── */

/** A primitive's (or an action's) configuration differences, one line each, down to the leaf that moved. */
function configChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return deepChanges(before, after).map((c) => (c.kind === 'added' ? `${c.subject}: ${c.after} (new)` : c.kind === 'removed' ? `${c.subject} removed (was ${c.before})` : `${c.subject}: ${c.before} → ${c.after}`));
}

function primitiveChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  for (const p of after.primitives) {
    const prev = before?.primitives.find((q) => q.id === p.id);
    const roles = p.only_for_roles ? ` for ${p.only_for_roles.join(', ')}` : '';
    if (!prev) {
      out.push({ kind: 'added', severity: before ? (p.kind.startsWith('write.') ? 'widening' : 'neutral') : 'neutral', subject: `${p.id} · ${p.kind}`, detail: `${p.kind.startsWith('write.') ? 'a new write' : 'a new read'}${roles}${Object.keys(p.config).length ? `: ${configChanges({}, p.config).map((c) => c.replace(' (new)', '')).join('; ')}` : ''}` });
      // A record of a kind the platform has not admitted: the stamps are an administrator's, not the platform's — the approver should know.
      const shape = (p.config as { shape?: { id?: string; open_kind?: boolean }; resource?: string }).shape;
      if (p.kind === 'write.fhir.record.create' && shape?.open_kind) out.push({ kind: 'added', severity: 'widening', subject: `${p.id} · ${(p.config as { resource?: string }).resource ?? 'record'}`, detail: `a kind the platform has not admitted, written through the administrator-defined shape ${shape.id ?? ''}: its stamps (status, patient, dates) are the shape's own, not the platform's` });
      continue;
    }
    if (prev.kind !== p.kind) out.push({ kind: 'changed', severity: 'neutral', subject: `${p.id} · kind`, before: prev.kind, after: p.kind });
    const cfg = configChanges(prev.config, p.config);
    if (cfg.length) out.push({ kind: 'changed', severity: 'neutral', subject: `${p.id} · ${p.kind}`, detail: cfg.join('; ') });
    if (!same(prev.only_for_roles ?? null, p.only_for_roles ?? null)) {
      // Runs for more roles than before (or for every role now): a widening; for fewer: a narrowing.
      const widening = !p.only_for_roles || (prev.only_for_roles !== undefined && p.only_for_roles.some((r) => !prev.only_for_roles!.includes(r)));
      out.push({ kind: 'changed', severity: widening ? 'widening' : 'narrowing', subject: `${p.id} · runs for`, before: prev.only_for_roles ? list(prev.only_for_roles) : 'every role', after: p.only_for_roles ? list(p.only_for_roles) : 'every role' });
    }
  }
  for (const p of before?.primitives ?? []) {
    if (!after.primitives.some((q) => q.id === p.id)) out.push({ kind: 'removed', severity: 'narrowing', subject: `${p.id} · ${p.kind}`, detail: p.kind.startsWith('write.') ? 'this write is gone' : 'this read is gone' });
  }
  return out;
}

function actionChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  for (const a of after.actions) {
    const prev = before?.actions.find((b) => b.id === a.id);
    const primitive = after.primitives.find((p) => p.id === a.primitive);
    if (!prev) {
      out.push({ kind: 'added', severity: before ? 'widening' : 'neutral', subject: `“${a.label}”`, detail: `a new action: ${primitive?.kind ?? a.primitive}${a.confirm ? ', asks before it writes' : ''}` });
      continue;
    }
    const fields = configChanges({ label: prev.label, primitive: prev.primitive, on_success: prev.on_success, confirm: prev.confirm, success_message: prev.success_message }, { label: a.label, primitive: a.primitive, on_success: a.on_success, confirm: a.confirm, success_message: a.success_message });
    if (fields.length) out.push({ kind: 'changed', severity: 'neutral', subject: `“${a.label}”`, detail: fields.join('; ') });
  }
  for (const a of before?.actions ?? []) {
    if (!after.actions.some((b) => b.id === a.id)) out.push({ kind: 'removed', severity: 'narrowing', subject: `“${a.label}”`, detail: 'this action is gone' });
  }
  return out;
}

function contextChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  for (const c of after.context_inputs) {
    const prev = before?.context_inputs.find((p) => p.name === c.name);
    if (!prev) out.push({ kind: 'added', severity: 'neutral', subject: `Launch context · ${c.name}`, detail: `${c.required ? 'required' : 'optional'} ${c.type}` });
    else if (prev.required !== c.required || prev.type !== c.type) out.push({ kind: 'changed', severity: 'neutral', subject: `Launch context · ${c.name}`, before: `${prev.required ? 'required' : 'optional'} ${prev.type}`, after: `${c.required ? 'required' : 'optional'} ${c.type}` });
  }
  for (const c of before?.context_inputs ?? []) {
    if (!after.context_inputs.some((p) => p.name === c.name)) out.push({ kind: 'removed', severity: 'neutral', subject: `Launch context · ${c.name}`, detail: 'no longer asked for' });
  }
  return out;
}

/* ── purpose ──────────────────────────────────────────────────────────────────────────────────── */

function purposeChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  const field = (subject: string, b: unknown, a: unknown, severity: Severity = 'neutral') => {
    if (same(b, a)) return;
    if (!before) out.push({ kind: 'added', severity: 'neutral', subject, after: show(a) });
    else if (a === undefined) out.push({ kind: 'removed', severity, subject, before: show(b) });
    else out.push({ kind: 'changed', severity, subject, before: show(b), after: show(a) });
  };
  field('Name', before?.metadata.name, after.metadata.name);
  field('Description', before?.metadata.description, after.metadata.description);
  field('Kind', before?.metadata.intent_class, after.metadata.intent_class);
  field('Intended purpose', before?.audit?.intended_purpose, after.audit?.intended_purpose);
  field('Clinical context', before?.audit?.clinical_context, after.audit?.clinical_context);
  field('Intended users', before?.audit?.intended_users, after.audit?.intended_users);
  field('MDR classification', before?.audit?.mdr_classification, after.audit?.mdr_classification);
  field('Data categories', before?.audit?.data_categories, after.audit?.data_categories);
  return out;
}

/* ── forms ────────────────────────────────────────────────────────────────────────────────────── */

interface FlatItem {
  readonly item: QuestionnaireArtifactItem;
  readonly path: string;
}

function flattenItems(items: readonly QuestionnaireArtifactItem[], trail: string[] = []): Map<string, FlatItem> {
  const out = new Map<string, FlatItem>();
  for (const it of items) {
    out.set(it.linkId, { item: it, path: trail.join(' › ') });
    if (it.item) for (const [k, v] of flattenItems(it.item, [...trail, it.text])) out.set(k, v);
  }
  return out;
}

function describeItem(it: QuestionnaireArtifactItem): string {
  const unit = it.extension?.find((e) => e.url === QUESTIONNAIRE_UNIT_EXTENSION);
  const parts = [it.type === 'group' ? 'heading' : it.type === 'display' ? 'note' : it.type, it.required ? 'required' : null, it.repeats ? 'several answers' : null, it.answerOption ? `${it.answerOption.length} options` : null, unit && 'valueCoding' in unit ? `in ${unit.valueCoding.display}` : null];
  return parts.filter(Boolean).join(', ');
}

function itemChanges(formTitle: string, before: QuestionnaireArtifact, after: QuestionnaireArtifact): Change[] {
  const out: Change[] = [];
  const b = flattenItems(before.item);
  const a = flattenItems(after.item);
  for (const [linkId, { item }] of a) {
    const prev = b.get(linkId)?.item;
    const subject = `${formTitle} · “${item.text}”`;
    if (!prev) {
      out.push({ kind: 'added', severity: 'neutral', subject, detail: `a new ${describeItem(item)}` });
      continue;
    }
    if (prev.text !== item.text) out.push({ kind: 'changed', severity: 'neutral', subject: `${formTitle} · question reworded`, before: prev.text, after: item.text });
    if (prev.type !== item.type) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · type`, before: prev.type, after: item.type });
    if (Boolean(prev.required) !== Boolean(item.required)) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · required`, detail: item.required ? 'now required' : 'no longer required' });
    if (Boolean(prev.repeats) !== Boolean(item.repeats)) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · answers`, detail: item.repeats ? 'several answers allowed now' : 'one answer now' });
    const optionLabel = (o: NonNullable<QuestionnaireArtifactItem['answerOption']>[number]) => `${o.valueCoding.display}${o.valueCoding.system ? ` [${o.valueCoding.system.split('/').pop()}|${o.valueCoding.code}]` : ''}`;
    const options = setDiff((prev.answerOption ?? []).map(optionLabel), (item.answerOption ?? []).map(optionLabel));
    if (options.added.length) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · options`, detail: `added: ${options.added.join('; ')}` });
    if (options.removed.length) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · options`, detail: `removed: ${options.removed.join('; ')}` });
    const unitOf = (it: QuestionnaireArtifactItem) => {
      const u = it.extension?.find((e) => e.url === QUESTIONNAIRE_UNIT_EXTENSION);
      return u && 'valueCoding' in u ? u.valueCoding.display : undefined;
    };
    if (unitOf(prev) !== unitOf(item)) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · unit`, before: unitOf(prev) ?? '—', after: unitOf(item) ?? '—' });
    const rangeOf = (it: QuestionnaireArtifactItem) => {
      const value = (url: string) => {
        const e = it.extension?.find((x) => x.url === url) as { valueInteger?: number; valueDecimal?: number } | undefined;
        return e?.valueInteger ?? e?.valueDecimal;
      };
      const lo = value(QUESTIONNAIRE_MIN_VALUE_EXTENSION);
      const hi = value(QUESTIONNAIRE_MAX_VALUE_EXTENSION);
      return lo === undefined && hi === undefined ? undefined : `${lo ?? '…'}–${hi ?? '…'}`;
    };
    if (rangeOf(prev) !== rangeOf(item)) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · range`, before: rangeOf(prev) ?? 'any value', after: rangeOf(item) ?? 'any value' });
    const whenOf = (it: QuestionnaireArtifactItem) => (it.enableWhen ?? []).map((e) => `${e.question} ${e.operator} ${JSON.stringify(e.answerCoding?.code ?? e.answerBoolean ?? e.answerInteger ?? e.answerDecimal ?? e.answerString ?? e.answerDate)}`).join(it.enableBehavior === 'any' ? ' or ' : ' and ');
    if (whenOf(prev) !== whenOf(item)) out.push({ kind: 'changed', severity: 'neutral', subject: `${subject} · shown when`, before: whenOf(prev) || 'always', after: whenOf(item) || 'always' });
  }
  for (const [linkId, { item }] of b) {
    if (!a.has(linkId)) out.push({ kind: 'removed', severity: 'neutral', subject: `${formTitle} · “${item.text}”`, detail: `this ${item.type === 'group' ? 'heading' : item.type === 'display' ? 'note' : 'question'} is gone` });
  }
  return out;
}

function formChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const out: Change[] = [];
  const bForms = before?.artifacts?.questionnaires ?? [];
  const aForms = after.artifacts?.questionnaires ?? [];
  const key = (q: QuestionnaireArtifact) => q.url;
  for (const q of aForms) {
    const prev = bForms.find((p) => key(p) === key(q));
    if (!prev) {
      const flat = flattenItems(q.item);
      const questions = [...flat.values()].filter(({ item }) => item.type !== 'group' && item.type !== 'display').length;
      out.push({ kind: 'added', severity: 'neutral', subject: `Form “${q.title}”`, detail: `${before ? 'a new form' : 'the app’s own form'}: ${questions} question${questions === 1 ? '' : 's'}${q.description ? ` — ${q.description}` : ''}` });
      continue;
    }
    if (prev.title !== q.title) out.push({ kind: 'changed', severity: 'neutral', subject: 'Form title', before: prev.title, after: q.title });
    if ((prev.description ?? '') !== (q.description ?? '')) out.push({ kind: 'changed', severity: 'neutral', subject: `Form “${q.title}” · description`, before: prev.description ?? '—', after: q.description ?? '—' });
    out.push(...itemChanges(`Form “${q.title}”`, prev, q));
  }
  for (const q of bForms) {
    if (!aForms.some((p) => key(p) === key(q))) out.push({ kind: 'removed', severity: 'neutral', subject: `Form “${q.title}”`, detail: 'this form is gone; recorded answers keep referring to it' });
  }
  return out;
}

/* ── settings: the spec's knobs ───────────────────────────────────────────────────────────────── */

type Spec = { archetype?: string; knobs?: unknown; app?: { language?: string } };

function specOf(entry: OkEntry | null): Spec | null {
  const spec = entry?.meta?.spec;
  return spec && typeof spec === 'object' ? (spec as Spec) : null;
}

const MATCH_KEYS = ['id', 'code', 'name', 'linkId', 'key', 'label'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Leaf-level differences between two values; arrays of records are matched by an identifying key when they have one, else by position. */
export function deepChanges(before: unknown, after: unknown, path = ''): Change[] {
  if (same(before, after)) return [];
  const at = (key: string | number) => (path ? (typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`) : String(key));
  if (isRecord(before) && isRecord(after)) {
    const out: Change[] = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!(key in after)) out.push({ kind: 'removed', severity: 'neutral', subject: at(key), before: show(before[key]) });
      else if (!(key in before)) out.push({ kind: 'added', severity: 'neutral', subject: at(key), after: show(after[key]) });
      else out.push(...deepChanges(before[key], after[key], at(key)));
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.every(isRecord) && after.every(isRecord)) {
    const matchKey = MATCH_KEYS.find((k) => before.every((r) => k in r) && after.every((r) => k in r));
    if (matchKey) {
      const out: Change[] = [];
      const bBy = new Map(before.map((r) => [String(r[matchKey]), r]));
      const aBy = new Map(after.map((r) => [String(r[matchKey]), r]));
      for (const [k, r] of aBy) {
        if (!bBy.has(k)) out.push({ kind: 'added', severity: 'neutral', subject: `${path}[${matchKey}=${k}]`, after: show(r) });
        else out.push(...deepChanges(bBy.get(k), r, `${path}[${matchKey}=${k}]`));
      }
      for (const [k, r] of bBy) if (!aBy.has(k)) out.push({ kind: 'removed', severity: 'neutral', subject: `${path}[${matchKey}=${k}]`, before: show(r) });
      return out;
    }
    const out: Change[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (i >= after.length) out.push({ kind: 'removed', severity: 'neutral', subject: at(i), before: show(before[i]) });
      else if (i >= before.length) out.push({ kind: 'added', severity: 'neutral', subject: at(i), after: show(after[i]) });
      else out.push(...deepChanges(before[i], after[i], at(i)));
    }
    return out;
  }
  return [{ kind: 'changed', severity: 'neutral', subject: path || 'value', before: show(before), after: show(after) }];
}

function settingChanges(before: OkEntry | null, after: OkEntry): { changes: Change[]; archetype: ReviewDiff['archetype'] } {
  const b = specOf(before);
  const a = specOf(after);
  if (!a) return { changes: [], archetype: null };
  if (!before) return { changes: [], archetype: null }; // a first version: the manifest sections say it all
  if (!b) return { changes: [{ kind: 'changed', severity: 'neutral', subject: 'Settings', detail: 'the published version was authored by hand (no spec); compare the sections above' }], archetype: null };
  if (b.archetype !== a.archetype) return { changes: [], archetype: { before: String(b.archetype), after: String(a.archetype) } };
  const changes = deepChanges(b.knobs, a.knobs);
  if ((b.app?.language ?? 'en') !== (a.app?.language ?? 'en')) changes.push({ kind: 'changed', severity: 'neutral', subject: 'language', before: b.app?.language ?? 'en', after: a.app?.language ?? 'en' });
  return { changes, archetype: null };
}

/* ── layout ───────────────────────────────────────────────────────────────────────────────────── */

function countComponents(node: LayoutNode, into = new Map<string, number>()): Map<string, number> {
  into.set(node.component, (into.get(node.component) ?? 0) + 1);
  node.children?.forEach((c) => countComponents(c, into));
  return into;
}

function layoutChanges(before: AppManifest | null, after: AppManifest): Change[] {
  const b = before ? countComponents(before.layout.root) : new Map<string, number>();
  const a = countComponents(after.layout.root);
  const out: Change[] = [];
  for (const component of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const nb = b.get(component) ?? 0;
    const na = a.get(component) ?? 0;
    if (nb === na) continue;
    out.push({ kind: nb === 0 ? 'added' : na === 0 ? 'removed' : 'changed', severity: 'neutral', subject: component, detail: nb === 0 ? `${na} new` : na === 0 ? `${nb} removed` : `${nb} → ${na}`, before: String(nb), after: String(na) });
  }
  if (before && out.length === 0 && !same(before.layout.root, after.layout.root)) out.push({ kind: 'changed', severity: 'neutral', subject: 'Layout', detail: 'the same components, arranged or configured differently' });
  return out;
}

/* ── the whole ────────────────────────────────────────────────────────────────────────────────── */

function textOf(entry: OkEntry, of: 'spec' | 'manifest'): string {
  if (of === 'spec' && entry.meta?.spec) return toYaml(entry.meta.spec, { version: '1.1' });
  const { lifecycle, ...rest } = entry.manifest;
  void lifecycle; // the sign-off block differs by construction and says nothing about the app
  return toYaml(rest, { version: '1.1' });
}

/** The published version of the same app among the entries — what clinicians use today. */
export function baselineFor(entries: readonly RegistryEntry[], candidate: OkEntry): OkEntry | null {
  const appId = candidate.manifest.metadata.app_id;
  const version = candidate.manifest.metadata.version;
  return (
    entries.find((e): e is OkEntry => e.ok && e.manifest.metadata.app_id === appId && e.manifest.lifecycle.state === 'published' && e.manifest.metadata.version !== version) ?? null
  );
}

export function reviewDiff(candidate: OkEntry, baseline: OkEntry | null): ReviewDiff {
  const after = candidate.manifest;
  const before = baseline?.manifest ?? null;
  const settings = settingChanges(baseline, candidate);
  const sections: ReviewSection[] = [
    { id: 'purpose', title: 'Purpose and governance', changes: purposeChanges(before, after) },
    { id: 'roles', title: 'Roles and access', changes: roleChanges(before, after) },
    { id: 'primitives', title: 'Data read and written', changes: primitiveChanges(before, after) },
    { id: 'actions', title: 'Actions', changes: actionChanges(before, after) },
    { id: 'forms', title: 'Forms', changes: formChanges(before, after) },
    { id: 'context', title: 'Launch context', changes: contextChanges(before, after) },
    { id: 'settings', title: 'Settings', changes: settings.changes },
    { id: 'layout', title: 'Layout', changes: layoutChanges(before, after) },
  ];
  const all = sections.flatMap((s) => s.changes);
  const widenings = all.filter((c) => c.severity === 'widening');
  const narrowings = all.filter((c) => c.severity === 'narrowing');
  const access: AccessVerdict = !baseline ? 'new' : widenings.length && narrowings.length ? 'mixed' : widenings.length ? 'widened' : narrowings.length ? 'narrowed' : 'unchanged';
  const of: 'spec' | 'manifest' = candidate.meta?.spec && (!baseline || baseline.meta?.spec) ? 'spec' : 'manifest';
  return {
    app_id: after.metadata.app_id,
    candidate: { version: after.metadata.version, state: after.lifecycle.state },
    baseline: before ? { version: before.metadata.version, state: before.lifecycle.state } : null,
    archetype: settings.archetype,
    sections,
    summary: { access, widenings, narrowings, total: all.length },
    text: { before: baseline ? textOf(baseline, of) : '', after: textOf(candidate, of), of },
  };
}
