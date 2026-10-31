import { describe, expect, it } from 'vitest';
import { loadRegistry, type RegistryEntry } from '../manifest/registry';
import { baselineFor, countChanges, deepChanges, hunks, lineDiff, reviewDiff } from '../review';
import { compileSpec } from '../spec';

/**
 * What an approver is shown as changed between the version in front of them and the published one: access first —
 * a role added, a scope widened or narrowed — then data, actions, forms, purpose and the author's settings. Built
 * from the showcase specs recompiled with one thing different each time, so the comparison runs on manifests the
 * compiler really produces.
 */

type OkEntry = Extract<RegistryEntry, { ok: true }>;

const registry = loadRegistry();
const published = (appId: string): OkEntry => {
  const e = registry.find((x): x is OkEntry => x.ok && x.manifest.metadata.app_id === appId);
  if (!e?.meta?.spec) throw new Error(`${appId} with its spec expected in the showcase registry`);
  return e;
};

/** The published spec with `edit` applied, compiled as the next version in review — with or without its spec attached. */
function nextVersion(base: OkEntry, edit: (spec: Record<string, unknown>) => void, withSpec = true): OkEntry {
  const spec = JSON.parse(JSON.stringify(base.meta!.spec)) as Record<string, unknown>;
  (spec.app as Record<string, unknown>).version = '1.1.0';
  (spec.app as Record<string, unknown>).parent_version = '1.0.0';
  edit(spec);
  const compiled = compileSpec(spec, { hospital_id: base.manifest.metadata.hospital_id, created_at: '2026-10-10T09:00:00.000Z', created_by_sub: 'sub-author' });
  if (!compiled.ok) throw new Error(compiled.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return { file: 'next.yaml', ok: true, manifest: { ...compiled.manifest, lifecycle: { ...compiled.manifest.lifecycle, state: 'in_review' } }, meta: withSpec ? { spec, created_by_sub: 'sub-author' } : { created_by_sub: 'sub-author' } };
}

const knobs = (spec: Record<string, unknown>) => spec.knobs as Record<string, unknown>;

describe('review diff', () => {
  it('finds the published version to compare against, and says when there is none', () => {
    const base = published('app_hypertension_register');
    const next = nextVersion(base, () => {});
    expect(baselineFor([...registry, next], next)?.manifest.metadata.version).toBe('1.0.0');
    expect(baselineFor([next], next)).toBeNull();
    const first = reviewDiff(next, null);
    expect(first.baseline).toBeNull();
    expect(first.summary.access).toBe('new');
    const roles = first.sections.find((s) => s.id === 'roles')!;
    expect(roles.changes.map((c) => [c.kind, c.severity, c.subject])).toEqual([['added', 'neutral', 'Role Hypertension clinic']]);
    expect(roles.changes[0]!.detail).toContain('granted by app-app_hypertension_register-hypertension_clinic');
    expect(roles.changes[0]!.detail).toContain('Condition search (3 codes)');
    expect(first.sections.find((s) => s.id === 'primitives')!.changes.every((c) => c.kind === 'added' && c.severity === 'neutral')).toBe(true);
    expect(first.sections.find((s) => s.id === 'settings')!.changes).toEqual([]); // nothing to compare the knobs with
  });

  it('a recompiled spec with nothing but a new version number changes nothing', () => {
    const base = published('app_hypertension_register');
    const diff = reviewDiff(nextVersion(base, () => {}), base);
    expect(diff.baseline).toEqual({ version: '1.0.0', state: 'published' });
    expect(diff.candidate).toEqual({ version: '1.1.0', state: 'in_review' });
    expect(diff.summary).toEqual({ access: 'unchanged', widenings: [], narrowings: [], total: 0 });
    expect(diff.text.of).toBe('spec');
  });

  it('a moved threshold is one setting, not three primitive configs; a reworded purpose is said', () => {
    const base = published('app_hypertension_register');
    const next = nextVersion(base, (spec) => {
      (knobs(spec).value as Record<string, unknown>).threshold = 130;
      (spec.governance as Record<string, unknown>).intended_purpose = 'Listing of patients with a coded hypertension diagnosis with their latest blood pressure, flagged from 130 mmHg.';
    });
    const diff = reviewDiff(next, base);
    expect(diff.summary.access).toBe('unchanged');
    const settings = diff.sections.find((s) => s.id === 'settings')!;
    expect(settings.changes).toEqual([{ kind: 'changed', severity: 'neutral', subject: 'value.threshold', before: '140', after: '130' }]);
    const purpose = diff.sections.find((s) => s.id === 'purpose')!;
    expect(purpose.changes.map((c) => c.subject)).toEqual(['Intended purpose']);
    expect(purpose.changes[0]!.after).toContain('130 mmHg');
    // where it lives in the manifest: one primitive's config, down to the leaf; and the layout's props — one line, not a prop dump
    expect(diff.sections.find((s) => s.id === 'primitives')!.changes).toEqual([{ kind: 'changed', severity: 'neutral', subject: 'p_latest · data.cohort.latest_observation', detail: 'threshold.value: 140 → 130' }]);
    expect(diff.sections.find((s) => s.id === 'layout')!.changes).toEqual([{ kind: 'changed', severity: 'neutral', subject: 'Layout', detail: 'the same components, arranged or configured differently' }]);
  });

  it('a new role is a widening; a code dropped from the condition is a narrowing of the scope and of the read', () => {
    const base = published('app_hypertension_register');
    const wider = nextVersion(base, (spec) => {
      (spec.roles as Record<string, unknown>[]).push({ id: 'research', display_name: 'Research office', phi_fields_visible: ['name', 'dob', 'mrn', 'address'], capabilities: ['view', 'export_csv'] });
    });
    const widened = reviewDiff(wider, base);
    expect(widened.summary.access).toBe('widened');
    expect(widened.summary.widenings.map((c) => c.subject)).toEqual(['Role Research office']);
    expect(widened.summary.widenings[0]!.detail).toContain('granted by app-app_hypertension_register-research');
    expect(widened.summary.widenings[0]!.detail).toContain('sees name, dob, mrn, address');

    const narrower = nextVersion(base, (spec) => {
      const condition = knobs(spec).condition as { codes: unknown[] };
      condition.codes = condition.codes.slice(0, 1); // SNOMED only
    });
    const narrowed = reviewDiff(narrower, base);
    expect(narrowed.summary.access).toBe('narrowed');
    const roles = narrowed.sections.find((s) => s.id === 'roles')!;
    expect(roles.changes).toHaveLength(1);
    expect(roles.changes[0]).toMatchObject({ kind: 'changed', severity: 'narrowing', subject: 'Role Hypertension clinic · Condition' });
    expect(roles.changes[0]!.detail).toContain('codes removed: http://fhir.de/CodeSystem/bfarm/icd-10-gm|I10.00');
    expect(narrowed.sections.find((s) => s.id === 'primitives')!.changes.some((c) => c.subject === 'p_cohort · data.cohort.by_condition' && c.detail?.includes('condition_codes'))).toBe(true);
    expect(narrowed.sections.find((s) => s.id === 'settings')!.changes.map((c) => [c.kind, c.subject])).toEqual([
      ['removed', 'condition.codes[code=I10.00]'],
      ['removed', 'condition.codes[code=I10.90]'],
    ]);
  });

  it('a role that sees more identity fields, and the default role moving to a wider role, are widenings', () => {
    const base = published('app_hypertension_register');
    const next = nextVersion(base, (spec) => {
      const roles = spec.roles as Record<string, unknown>[];
      roles[0]!.phi_fields_visible = ['name', 'dob', 'mrn', 'phone'];
      roles.push({ id: 'clerk', display_name: 'Ward clerk', phi_fields_visible: ['name'], capabilities: ['view'] });
      spec.default_role = 'clerk';
    });
    const diff = reviewDiff(next, base);
    expect(diff.summary.access).toBe('widened');
    const subjects = diff.summary.widenings.map((c) => c.subject);
    expect(subjects).toContain('Role Hypertension clinic · identity fields');
    expect(subjects).toContain('Role Ward clerk');
    const defaultRole = diff.sections.find((s) => s.id === 'roles')!.changes.find((c) => c.subject === 'Default role (blanket viewers)')!;
    expect(defaultRole).toMatchObject({ severity: 'neutral', before: 'Hypertension clinic', after: 'Ward clerk' }); // the clerk sees less than the clinic did
  });

  it('forms: a question added, one made required, one gone — by linkId, named by their text', () => {
    const base = published('app_falls_risk');
    const next = nextVersion(base, (spec) => {
      // The showcase ships the form inside an assessment section of a composed page.
      const form = (knobs(spec).sections as { kind: string; form?: unknown }[]).find((s) => s.kind === 'assessment')!.form as { items: { id: string; items?: { id: string; required?: boolean }[] }[] };
      const fall = form.items.find((i) => i.id === 'fall_details')!;
      fall.items!.find((i) => i.id === 'falls_count')!.required = true;
      fall.items = fall.items!.filter((i) => i.id !== 'injury');
      form.items.find((i) => i.id === 'history')!.items!.push({ id: 'fear_of_falling', type: 'boolean', text: 'Afraid of falling?' } as never);
    });
    const diff = reviewDiff(next, base);
    expect(diff.summary.access).toBe('unchanged');
    const forms = diff.sections.find((s) => s.id === 'forms')!;
    expect(forms.changes.map((c) => [c.kind, c.subject, c.detail])).toEqual([
      ['added', 'Form “Falls risk screen” · “Afraid of falling?”', 'a new boolean'],
      ['changed', 'Form “Falls risk screen” · “How many falls? (0–20)” · required', 'now required'],
      ['removed', 'Form “Falls risk screen” · “Worst injury from a fall”', 'this question is gone'],
    ]);
    const settings = diff.sections.find((s) => s.id === 'settings')!;
    expect(settings.changes.map((c) => c.subject)).toEqual(['sections[0].form.items[id=history].items[id=fear_of_falling]', 'sections[0].form.items[id=fall_details].items[id=falls_count].required', 'sections[0].form.items[id=fall_details].items[id=injury]']);
  });

  it('a new write action is a widening; a published version authored by hand has no settings to compare', () => {
    const base = published('app_falls_risk');
    const byHand: OkEntry = { ...base, meta: {} };
    const next = nextVersion(base, () => {});
    const diff = reviewDiff(next, byHand);
    expect(diff.sections.find((s) => s.id === 'settings')!.changes[0]!.detail).toContain('authored by hand');
    expect(diff.text.of).toBe('manifest');

    const actions = base.manifest.actions;
    expect(actions.length).toBeGreaterThan(0);
    const without: OkEntry = { ...base, manifest: { ...base.manifest, actions: [], primitives: base.manifest.primitives.filter((p) => !p.kind.startsWith('write.')) } };
    const gained = reviewDiff(base, without);
    expect(gained.summary.access).toBe('widened');
    expect(gained.summary.widenings.map((c) => [c.kind, c.subject])).toEqual([
      ['added', `${base.manifest.primitives.find((p) => p.kind.startsWith('write.'))!.id} · write.fhir.questionnaire_response.submit`],
      ['added', `“${actions[0]!.label}”`],
    ]);
  });

  it('deep changes: records by key, lists of records by an identifying key, lists of plain values as a whole', () => {
    // a list of plain values reads as one change — "the codes went from these to those" — not as positions
    expect(deepChanges({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] }, d: true })).toEqual([
      { kind: 'changed', severity: 'neutral', subject: 'b.c', before: '1, 2', after: '1, 3' },
      { kind: 'added', severity: 'neutral', subject: 'd', after: 'true' },
    ]);
    expect(deepChanges({ codes: [{ code: 'x', display: 'X' }, { code: 'y' }] }, { codes: [{ code: 'y' }, { code: 'z' }] }).map((c) => [c.kind, c.subject])).toEqual([
      ['added', 'codes[code=z]'],
      ['removed', 'codes[code=x]'],
    ]);
    expect(deepChanges(['a', 'b'], ['a', 'b', 'c'])).toEqual([{ kind: 'changed', severity: 'neutral', subject: 'value', before: 'a, b', after: 'a, b, c' }]);
    expect(deepChanges(5, 5)).toEqual([]);
  });
});

describe('line diff', () => {
  it('marks the lines that differ and folds the rest into hunks with context', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten').replace('line 25\n', 'line 25\nline 25b\n');
    const lines = lineDiff(before, after);
    expect(countChanges(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines.filter((l) => l.type !== 'same').map((l) => [l.type, l.text, l.before, l.after])).toEqual([
      ['del', 'line 10', 11, undefined],
      ['add', 'line ten', undefined, 11],
      ['add', 'line 25b', undefined, 27],
    ]);
    const folded = hunks(lines, 2);
    expect(folded).toHaveLength(2);
    expect(folded[0]!.skipped).toBe(8); // lines 0-7 folded, 8-9 are context
    expect(folded[0]!.lines.map((l) => l.text)).toEqual(['line 8', 'line 9', 'line 10', 'line ten', 'line 11', 'line 12']);
    expect(folded[1]!.skipped).toBe(11);
    expect(folded[1]!.lines.map((l) => l.text)).toEqual(['line 24', 'line 25', 'line 25b', 'line 26', 'line 27']);
    expect(lineDiff('', 'a\nb')).toEqual([
      { type: 'add', text: 'a', after: 1 },
      { type: 'add', text: 'b', after: 2 },
    ]);
  });
});
