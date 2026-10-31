import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, test } from 'vitest';
import { applyOps, classify, RejectedChange } from '../authoring/draftOps';
import { localAuthoringClient, LocalRegistryStore, nextMinor, OFFLINE_REPLY } from '../authoring/localClient';
import { AuthoringApiError, type DraftOp, type PlainSpec } from '../authoring/types';
import { localRegistrySource } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';

/**
 * The browser-side mirror of the draft operations and the local authoring client: the same outcomes
 * as infra/app_creator/draft.py and the drafts/registry-write APIs, so mock mode and the page tests
 * exercise the real loop.
 */

function fixture(name: string): PlainSpec {
  const rel = `../../specs/${name}`;
  return parseYaml(readFileSync(new URL(rel, import.meta.url), 'utf8')) as PlainSpec;
}

const completeOps: DraftOp[] = [
  { op: 'choose_archetype', args: { archetype: 'APP-02', reason: 'trend' } },
  { op: 'set_app', args: { app_id: 'app_hba1c', name: 'HbA1c over time' } },
  { op: 'set_knobs', args: { patch: { codes: [{ system: 'loinc', code: '4548-4' }], series: [{ label: 'HbA1c', code: '4548-4' }], unit: '%' } } },
  { op: 'add_role', args: { role: { id: 'clinician', display_name: 'Clinician', phi_fields_visible: ['name', 'dob', 'mrn'] } } },
  { op: 'set_governance', args: { patch: { clinical_context: 'diabetes_clinic', intended_users: ['diabetologist'], intended_purpose: 'Display only.' } } },
];

describe('draft operations mirror', () => {
  test('missing fields are open, wrong values are rejected — and a rejected batch changes nothing', () => {
    expect(classify({}).open.map((i) => i.path)).toEqual(['archetype', 'app', 'roles', 'default_role', 'governance']);
    const spec = applyOps({}, completeOps, null);
    expect(classify(spec).open).toEqual([]);
    expect(spec.default_role).toBe('clinician'); // the first role becomes the default

    let error: unknown;
    try {
      applyOps(spec, [{ op: 'set_knobs', args: { patch: { unit: 'mmol/mol' } } }, { op: 'set_knobs', args: { patch: { window: 'yesterday' } } }], null);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RejectedChange);
    expect((error as RejectedChange).issues[0]?.path).toBe('knobs.window');
    expect((spec.knobs as { unit: string }).unit).toBe('%');

    expect(() => applyOps({}, [{ op: 'set_knobs', args: { patch: { unit: '%' } } }], null)).toThrow(/choose an archetype/);
    expect(() => applyOps({}, [{ op: 'choose_archetype', args: { archetype: 'APP-77' } }], null)).toThrow(/cannot be built/);
  });

  test('roles: group bindings replace, removing a role clears what pointed at it, existing groups must exist', () => {
    let spec = applyOps({}, completeOps, ['kardiologie']);
    spec = applyOps(spec, [{ op: 'update_role', args: { id: 'clinician', patch: { group: { kind: 'existing', name: 'kardiologie' } } } }], ['kardiologie']);
    expect((spec.roles as { group: unknown }[])[0]?.group).toEqual({ kind: 'existing', name: 'kardiologie' });
    // Back to an app group: the old `name` must not linger (a tagged union does not deep-merge).
    spec = applyOps(spec, [{ op: 'update_role', args: { id: 'clinician', patch: { group: { kind: 'app_group' } } } }], ['kardiologie']);
    expect((spec.roles as { group: unknown }[])[0]?.group).toEqual({ kind: 'app_group' });

    expect(() => applyOps(spec, [{ op: 'update_role', args: { id: 'clinician', patch: { group: { kind: 'existing', name: 'diabetologie' } } } }], ['kardiologie'])).toThrow(/not an existing group/);

    spec = applyOps(spec, [{ op: 'add_role', args: { role: { id: 'nurse', display_name: 'Nurse', inherits: 'clinician', phi_fields_visible: ['name'] } } }], null);
    spec = applyOps(spec, [{ op: 'remove_role', args: { id: 'clinician' } }], null);
    expect(spec.roles).toEqual([{ id: 'nurse', display_name: 'Nurse', phi_fields_visible: ['name'] }]);
    expect(spec.default_role).toBeUndefined();
    expect(classify(spec).open.map((i) => i.path)).toEqual(['default_role']);
    expect(() => applyOps(spec, [{ op: 'set_default_role', args: { id: 'ghost' } }], null)).toThrow(/not a declared role/);
  });

  test('the bundled fixtures are complete drafts', () => {
    for (const name of ['bp-trend.yaml', 'patient-summary.yaml', 'hypertension-cohort.yaml']) {
      const { apiVersion: _a, kind: _k, ...spec } = fixture(name);
      expect(classify(spec)).toEqual({ open: [], invalid: [] });
    }
  });
});

describe('local authoring client', () => {
  function world(agent?: Parameters<typeof localAuthoringClient>[0]['agent']) {
    const registry = new LocalRegistryStore();
    const client = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'mock-author', registry, agent, groups: [{ name: 'kardiologie', description: '' }], turnDelayMs: 1, knownVersions: () => undefined });
    return { registry, client };
  }

  test('draft → edit → compile → save → lifecycle → next version, as the API would answer', async () => {
    const { registry, client } = world();
    const { session_id, turn } = await client.createDraft({});
    expect(turn).toBeNull();

    const patched = await client.patchDraft(session_id, completeOps);
    expect(patched.open).toEqual([]);
    const view = await client.getDraft(session_id);
    expect(view.title).toBe('HbA1c over time');
    expect(view.spec).toMatchObject({ apiVersion: 'medapp.eu/v1', kind: 'AppSpec', archetype: 'APP-02' });

    await expect(client.patchDraft(session_id, [{ op: 'set_knobs', args: { patch: { window: 'yesterday' } } }])).rejects.toMatchObject({ status: 422, rejected: [{ path: 'knobs.window' }] });

    const compiled = await client.compile(view.spec);
    expect(compiled.ok).toBe(true);

    const saved = await client.saveApp(session_id);
    expect(saved).toEqual({ app_id: 'app_hba1c', version: '0.1.0', state: 'draft' });
    expect((await client.getDraft(session_id)).saved_as).toMatchObject({ app_id: 'app_hba1c', version: '0.1.0', state: 'draft' });
    await expect(client.saveApp(session_id)).rejects.toMatchObject({ status: 409 }); // the app exists: revise or iterate
    await expect(client.deleteDraft(session_id)).rejects.toMatchObject({ status: 409 }); // saved: it is the version's record now
    // A draft version is still its author's: the conversation stays editable and "Save changes" revises v0.1.0 in place.
    await client.patchDraft(session_id, [{ op: 'set_app', args: { name: 'HbA1c, revised' } }]);
    expect(await client.replaceVersion('app_hba1c', '0.1.0', session_id)).toEqual({ app_id: 'app_hba1c', version: '0.1.0', state: 'draft', revised: true });
    expect(registry.find('app_hba1c', '0.1.0')?.manifest.metadata.name).toBe('HbA1c, revised');
    expect(registry.list().filter((v) => v.app_id === 'app_hba1c')).toHaveLength(1);
    await expect(client.replaceVersion('app_hba1c', '0.1.0', (await client.createDraft({})).session_id)).rejects.toMatchObject({ status: 409 }); // not the conversation it was saved from

    // The launcher sees it next to the bundled manifests, with what staff need for the lifecycle.
    const entries = await localRegistrySource(registry, loadFixtureRegistry).load();
    const mine = entries.find((e) => e.ok && e.manifest.metadata.app_id === 'app_hba1c');
    expect(mine && mine.ok && mine.meta).toMatchObject({ owner_sub: 'mock-author', created_by_sub: 'mock-author' });
    expect(mine && mine.ok && mine.manifest.lifecycle.state).toBe('draft');
    const bundled = entries.find((e) => e.ok && e.manifest.metadata.app_id === 'app_bp_trend');
    expect(bundled && bundled.ok && bundled.meta?.spec).toBeTruthy(); // fixture spec attached: "iterate" works on bundled apps too

    expect((await client.transition('app_hba1c', '0.1.0', 'in_review')).state).toBe('in_review');
    // Submitted: the conversation freezes and the version is no longer revisable — iterate for the next one.
    expect((await client.getDraft(session_id)).saved_as).toMatchObject({ state: 'in_review' });
    await expect(client.patchDraft(session_id, completeOps)).rejects.toMatchObject({ status: 409 });
    await expect(client.replaceVersion('app_hba1c', '0.1.0', session_id)).rejects.toMatchObject({ status: 409 });
    await expect(client.transition('app_hba1c', '0.1.0', 'published')).rejects.toMatchObject({ status: 409 });
    expect((await client.transition('app_hba1c', '0.1.0', 'approved', 'fine')).state).toBe('approved');
    expect((await client.transition('app_hba1c', '0.1.0', 'published')).state).toBe('published');
    expect(registry.find('app_hba1c', '0.1.0')?.manifest.lifecycle).toMatchObject({ state: 'published', signoff: { approver_sub: 'mock-author', clinical_notes: 'fine' } });

    // Iterate: a new draft from the stored spec, saved as the next minor; publishing it deprecates 0.1.0.
    const seeded = await client.createDraft({ spec: registry.find('app_hba1c', '0.1.0')!.spec, iterates: { app_id: 'app_hba1c', version: '0.1.0' } });
    const seededView = await client.getDraft(seeded.session_id);
    expect(seededView.open).toEqual([]);
    expect(seededView.iterates).toEqual({ app_id: 'app_hba1c', version: '0.1.0' });
    await client.patchDraft(seeded.session_id, [{ op: 'set_knobs', args: { patch: { unit: 'mmol/mol' } } }]);
    const v2 = await client.saveVersion('app_hba1c', seeded.session_id);
    expect(v2).toEqual({ app_id: 'app_hba1c', version: '0.2.0', parent_version: '0.1.0', state: 'draft' });
    expect(registry.find('app_hba1c', '0.2.0')?.manifest.metadata).toMatchObject({ version: '0.2.0', parent_version: '0.1.0' });
    // Staff see both: the published version and the draft that iterates on it (two rows, two tabs).
    const presented = (await localRegistrySource(registry, loadFixtureRegistry).load()).filter((e) => e.ok && e.manifest.metadata.app_id === 'app_hba1c');
    expect(presented.map((e) => (e.ok ? `${e.manifest.metadata.version}:${e.manifest.lifecycle.state}` : ''))).toEqual(['0.1.0:published', '0.2.0:draft']);
    await client.transition('app_hba1c', '0.2.0', 'in_review');
    await client.transition('app_hba1c', '0.2.0', 'approved');
    await client.transition('app_hba1c', '0.2.0', 'published');
    expect(registry.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('deprecated');

    await expect(client.createDraft({ spec: { ...seededView.spec, knobs: { ...(seededView.spec.knobs as object), window: 'yesterday' } } })).rejects.toMatchObject({ status: 422 });
    expect(nextMinor('1.9.3')).toBe('1.10.0');
  });

  test('a turn runs the scripted agent asynchronously and lands in the transcript; without one the chat says so', async () => {
    const scripted = world(({ message }) => ({
      reply: `Got it: ${message}. I chose the trend archetype.`,
      ops: [{ op: 'choose_archetype', args: { archetype: 'APP-02', reason: 'trend' } }],
    }));
    const { session_id, turn } = await scripted.client.createDraft({ message: 'HbA1c over five years' });
    expect(turn?.status).toBe('queued');
    await expect(scripted.client.sendTurn(session_id, 'again')).rejects.toMatchObject({ status: 409 });
    await new Promise((r) => setTimeout(r, 30));
    const done = await scripted.client.getDraft(session_id);
    expect(done.turn).toMatchObject({ status: 'done', reply: 'Got it: HbA1c over five years. I chose the trend archetype.', tool_calls: ['choose_archetype'] });
    expect(done.transcript).toEqual([
      { role: 'user', text: 'HbA1c over five years' },
      { role: 'assistant', text: 'Got it: HbA1c over five years. I chose the trend archetype.' },
    ]);
    expect(done.spec.archetype).toBe('APP-02');
    expect((await scripted.client.listDrafts())[0]).toMatchObject({ session_id, archetype: 'APP-02', turn_status: 'done' });

    const offline = world();
    const created = await offline.client.createDraft({ message: 'hello?' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await offline.client.getDraft(created.session_id)).turn?.reply).toBe(OFFLINE_REPLY);

    // Another caller has no oracle for this draft.
    const other = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'someone-else', registry: new LocalRegistryStore() });
    await expect(other.getDraft(session_id)).rejects.toBeInstanceOf(AuthoringApiError);

    // Deleting: for good, by the author, while unsaved.
    await expect(other.deleteDraft(session_id)).rejects.toMatchObject({ status: 404 });
    await scripted.client.deleteDraft(session_id);
    await expect(scripted.client.getDraft(session_id)).rejects.toMatchObject({ status: 404 });
    expect(await scripted.client.listDrafts()).toEqual([]);
  });
});
