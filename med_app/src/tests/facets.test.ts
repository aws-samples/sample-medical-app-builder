import { describe, expect, it } from 'vitest';
import { collectionIdFor, localCollectionsClient, CollectionsApiError } from '../collections';
import { facetCounts, facetsOf, humanise, matchesSearch, matchesSelection, type AppFacets } from '../manifest/facets';
import { loadRegistry, type RegistryEntry } from '../manifest/registry';
import { noteOpened, readPersonal, togglePin } from '../panel/personal';

/**
 * Browsing a growing catalog: what an app is about, read off its manifest and nothing else — kind, who it is about, what
 * it shows and records, who it is for — so the chips and the search box stay true as apps are published; the hospital's
 * collections over the local client; and the person's own pins and recent apps.
 */

type OkEntry = Extract<RegistryEntry, { ok: true }>;
const showcase = loadRegistry().filter((e): e is OkEntry => e.ok);
const facets = new Map(showcase.map((e) => [e.manifest.metadata.app_id, facetsOf(e)]));
const of = (appId: string): AppFacets => {
  const f = facets.get(appId);
  if (!f) throw new Error(appId);
  return f;
};

describe('facets derived from the manifests', () => {
  it('names the kind of each showcase app from what it does', () => {
    expect(Object.fromEntries([...facets].map(([id, f]) => [id, f.kind]))).toEqual({
      app_cardio_renal: 'Documentation', // intent class workflow: it records readings and status changes
      app_ckd_imaging_register: 'Cohort register',
      app_diabetes_follow_up: 'Patient view', // a chart with the therapy and the problems beside it is more than a trend
      app_falls_risk: 'Assessment', // the form wins over the chart of its answers
      app_htn_assessment_due: 'Worklist',
      app_hypertension_follow_up: 'Assessment',
      app_hypertension_register: 'Cohort register',
      app_imaging_3d: 'Imaging review',
      app_patient_360: 'Patient view',
      app_tumour_board: 'Patient view',
      app_ward_documentation: 'Documentation',
      app_ward_worklist: 'Worklist',
      app_wound_photos: 'Documentation',
    });
  });

  it('says who an app is about, what it shows, what it records, for whom — from scopes, primitives, forms and governance', () => {
    const register = of('app_hypertension_register');
    expect(register.scope).toBe('Cohort');
    expect(register.shows).toEqual(['Diagnoses', 'Observations']);
    expect(register.records).toEqual([]);
    expect(register.intended).toEqual(['Hypertension nurse', 'Cardiologist', 'General practitioner']);
    expect(register.context).toBe('Population health');
    expect(register.codes).toContain('http://loinc.org|85354-9');

    const falls = of('app_falls_risk');
    expect(falls.scope).toBe('One patient');
    expect(falls.records).toEqual(['Form answers']);
    expect(falls.forms).toEqual(['Falls risk screen']);
    expect(falls.shows).toContain('Forms');

    const imaging = of('app_imaging_3d');
    expect(imaging.shows).toContain('Imaging');
    expect(imaging.imaging.length).toBeGreaterThan(0);

    const p360 = of('app_patient_360');
    expect(p360.shows).toEqual(expect.arrayContaining(['Diagnoses', 'Medication', 'Observations']));
    expect(humanise('general_practitioner')).toBe('General practitioner');
    expect(humanise('ckd-monitoring')).toBe('Ckd monitoring');
  });

  it('search looks through name, description, domains, codes, roles and purpose; chips narrow by OR within a facet and AND across', () => {
    const all = [...facets.values()];
    expect(all.filter((f) => matchesSearch(f, 'blutdruck OR blood')).length).toBe(0); // every word must appear
    expect(all.filter((f) => matchesSearch(f, 'blood pressure')).length).toBeGreaterThanOrEqual(3);
    expect(all.filter((f) => matchesSearch(f, '85354-9')).map((f) => f.kind)).toContain('Cohort register');
    expect(all.filter((f) => matchesSearch(f, 'falls')).length).toBe(1);

    expect(all.filter((f) => matchesSelection(f, { kind: ['Cohort register'] })).length).toBe(2);
    expect(all.filter((f) => matchesSelection(f, { kind: ['Cohort register', 'Imaging review'] })).length).toBe(3);
    expect(all.filter((f) => matchesSelection(f, { kind: ['Cohort register'], shows: ['Imaging'] })).length).toBe(1);
    expect(all.filter((f) => matchesSelection(f, {})).length).toBe(all.length);
  });

  it('counts each chip against the apps the other chips and the search leave, and keeps a chosen chip visible', () => {
    const all = [...facets.values()];
    const kinds = facetCounts(all, 'kind', {}, '');
    expect(kinds.map((k) => [k.value, k.count])).toEqual([
      ['Documentation', 3],
      ['Patient view', 3],
      ['Assessment', 2],
      ['Cohort register', 2],
      ['Worklist', 2],
      ['Imaging review', 1],
    ]);
    const withImaging = facetCounts(all, 'kind', { shows: ['Imaging'] }, '');
    expect(withImaging.find((k) => k.value === 'Cohort register')?.count).toBe(1);
    expect(facetCounts(all, 'shows', { kind: ['Assessment'] }, '').find((c) => c.value === 'Forms')?.count).toBe(2);
    const chosenButGone = facetCounts(all, 'kind', { kind: ['Assessment'] }, 'register');
    expect(chosenButGone.find((k) => k.value === 'Assessment')).toEqual({ value: 'Assessment', count: 0 });
  });
});

describe('the hospital’s collections, locally', () => {
  const known = () => showcase.map((e) => e.manifest.metadata.app_id);
  let who: { sub: string; name?: string; groups: string[] } = { sub: 'sub-sabine', name: 'Sabine Weber', groups: ['medapp-approvers'] };
  const client = () => localCollectionsClient({ knownAppIds: known, caller: () => who, mayCurate: () => who.groups.includes('medapp-approvers') || who.groups.includes('medapp-admins'), delayMs: 0, now: () => '2026-10-10T12:00:00.000Z' });

  it('starts with the seeded ones, creates with a slug id, updates in one request, refuses what the API would refuse', async () => {
    const c = client();
    const seeded = await c.list();
    expect(seeded.map((x) => x.collection_id)).toEqual(['col_ward_everyday_chores', 'col_chronic_disease_clinics', 'col_case_review_and_imaging']); // collections/showcase.yaml, in its order
    expect(seeded.every((x) => x.app_ids.every((a) => known().includes(a)))).toBe(true); // every app a collection names is a shipped manifest
    expect(collectionIdFor('Geriatrie Übersicht')).toBe('col_geriatrie_uebersicht');
    expect(() => collectionIdFor(' — ')).toThrow(CollectionsApiError);

    const made = await c.create({ name: 'Tumorboard', description: ' Für die Konferenz. ', app_ids: ['app_tumour_board', 'app_imaging_3d', 'app_tumour_board'] });
    expect(made).toEqual({ collection_id: 'col_tumorboard', name: 'Tumorboard', description: 'Für die Konferenz.', app_ids: ['app_tumour_board', 'app_imaging_3d'], updated_at: '2026-10-10T12:00:00.000Z', updated_by: { name: 'Sabine Weber' } });
    await expect(c.create({ name: 'Tumorboard', app_ids: [] })).rejects.toMatchObject({ status: 409 });
    await expect(c.create({ name: 'Nirgendwo', app_ids: ['app_nowhere'] })).rejects.toMatchObject({ status: 404 });

    const changed = await c.update('col_tumorboard', { description: '', app_ids: ['app_imaging_3d'] });
    expect(changed.description).toBeNull();
    expect(changed.app_ids).toEqual(['app_imaging_3d']);
    expect((await c.list()).map((x) => x.collection_id)).toContain('col_tumorboard');
    await c.remove('col_tumorboard');
    expect((await c.list()).map((x) => x.collection_id)).not.toContain('col_tumorboard');
    await expect(c.remove('col_tumorboard')).rejects.toMatchObject({ status: 404 });

    who = { sub: 'sub-lukas', name: 'Lukas', groups: ['medapp-authors'] };
    await expect(c.create({ name: 'Meine', app_ids: [] })).rejects.toMatchObject({ status: 403 });
    expect((await c.list()).length).toBe(3); // reading is for everyone
  });
});

describe('pins and recent apps', () => {
  it('are kept per hospital and person and bounded', () => {
    const memory = new Map<string, string>();
    const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
    expect(readPersonal('hsp', 'me', store)).toEqual({ pins: [], recent: [] });
    expect(togglePin('hsp', 'me', 'app_a', store)).toEqual(['app_a']);
    expect(togglePin('hsp', 'me', 'app_b', store)).toEqual(['app_a', 'app_b']);
    expect(togglePin('hsp', 'me', 'app_a', store)).toEqual(['app_b']);
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) noteOpened('hsp', 'me', id, store);
    noteOpened('hsp', 'me', 'a3', store);
    expect(readPersonal('hsp', 'me', store).recent).toEqual(['a3', 'a9', 'a8', 'a7', 'a6', 'a5', 'a4', 'a2']);
    expect(readPersonal('hsp', 'someone-else', store)).toEqual({ pins: [], recent: [] });
    expect(readPersonal('hsp', 'me', undefined)).toEqual({ pins: [], recent: [] }); // no storage: nothing remembered, nothing thrown
  });
});
