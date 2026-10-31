import { describe, expect, it } from 'vitest';
import { referencedBindings, resolveDeep, type Diagnostic, type ExpressionEnv } from '../renderer/expressions';
import { resolveEffectiveScope, entitledRoles, selectInitialRole, isPlatformStaff, appAccess } from '../manifest/roles';
import { loadFixtureRegistry } from './fixtures';
import { resolveDateExpression } from '../primitives/data/dataCatalog';
import { loadRuntimeConfig, SYNTHETIC_VIEWER_SOURCE } from '../config/env';
import { createMockAuthProvider } from '../auth/mockAuth';
import { conceptMatches, flattenObservationValue, isClassCode } from '../primitives/data/fhirHelpers';
import { SEED } from '../primitives/data/mock/seed';

const bp = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_bp_trend');
if (!bp?.ok) throw new Error('bp manifest missing');
const manifest = bp.manifest;

describe('expressions', () => {
  const env: ExpressionEnv = {
    bindings: { cohort: { count: 2, patients: [{ id: 'a' }, { id: 'b' }] }, obs: [1, 2, 3] },
    context: { patient_id: 'pat-1' },
    metadata: manifest.metadata,
    auth: { role: 'viewer', effective: resolveEffectiveScope(manifest, 'viewer') },
    ui: { selected_study: 'uid-1' },
  };

  it('resolves nested paths, indices and length', () => {
    expect(resolveDeep('$bindings.cohort.count', env)).toBe(2);
    expect(resolveDeep('$bindings.cohort.patients[1].id', env)).toBe('b');
    expect(resolveDeep('$bindings.obs.length', env)).toBe(3);
    expect(resolveDeep('$context.patient_id', env)).toBe('pat-1');
    expect(resolveDeep('$metadata.name', env)).toBe('Longitudinal blood pressure');
    expect(resolveDeep('$auth.effective.phi_fields_visible', env)).toEqual(['name', 'dob', 'mrn']);
    expect(resolveDeep('$ui.selected_study', env)).toBe('uid-1');
  });

  it('leaves literals alone and reports unresolved references', () => {
    const diagnostics: Diagnostic[] = [];
    expect(resolveDeep({ title: 'Plain text', n: 3, list: ['$context.patient_id', 'x'] }, env, diagnostics)).toEqual({ title: 'Plain text', n: 3, list: ['pat-1', 'x'] });
    expect(resolveDeep('$bindings.nope.deeper', env, diagnostics)).toBeUndefined();
    expect(diagnostics[0]?.message).toContain('$bindings.nope.deeper');
    // Not a reference language: no code, no templates.
    expect(resolveDeep('${context.patient_id}', env)).toBe('${context.patient_id}');
    expect(resolveDeep('$window.location', env)).toBe('$window.location');
  });

  it('treats a $ui key nobody has set as "nothing selected yet", not as a problem', () => {
    // The viewer reads $ui.selected_study from the first render; the list writes it when the user clicks. Until then the
    // reference is undefined by design — the inspector must not show a warning for an app that is correct.
    const before: ExpressionEnv = { ...env, ui: {} };
    const diagnostics: Diagnostic[] = [];
    expect(resolveDeep('$ui.selected_study', before, diagnostics)).toBeUndefined();
    expect(resolveDeep({ study_uid: '$ui.imaging_selected', layout: 'mpr' }, before, diagnostics)).toEqual({ study_uid: undefined, layout: 'mpr' });
    expect(diagnostics).toEqual([]);
    // A path into a key that IS set but has no such member is an authoring problem and is still reported.
    expect(resolveDeep('$ui.selected_study.uid', env, diagnostics)).toBeUndefined();
    expect(diagnostics.map((d) => d.message)).toEqual(['Reference $ui.selected_study.uid did not resolve; rendered as undefined.']);
    // The other roots keep reporting: a binding that never existed is never "not yet".
    expect(resolveDeep('$context.nope', before, diagnostics)).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
  });

  it('lists binding dependencies of a config', () => {
    expect([...referencedBindings({ patients: '$bindings.cohort.patients', codes: ['85354-9'], x: { y: '$bindings.obs' } })].sort()).toEqual(['cohort', 'obs']);
  });
});

describe('roles and scopes', () => {
  it('follows inherits: reviewer gets viewer resources plus its own, and overrides PHI visibility', () => {
    const viewer = resolveEffectiveScope(manifest, 'viewer');
    const reviewer = resolveEffectiveScope(manifest, 'reviewer');
    expect(viewer.fhir.map((f) => f.resource)).toEqual(['Patient', 'Observation']);
    expect(reviewer.fhir.map((f) => f.resource)).toEqual(['Patient', 'Observation', 'Condition']);
    expect(reviewer.phi_fields_visible).toContain('address');
    expect(viewer.phi_fields_visible).not.toContain('address');
    expect(reviewer.lineage).toEqual(['scope_viewer', 'scope_reviewer']);
  });

  it('grants roles from exact Cognito groups and from mock wildcard groups', () => {
    const claims = { sub: 's', username: 'u', groups: ['app-app_bp_trend-reviewer', 'other'] };
    expect(entitledRoles(manifest, claims).map((r) => r.id)).toEqual(['reviewer']);
    expect(selectInitialRole(manifest, claims)).toMatchObject({ role: { id: 'reviewer' }, source: 'group' });
    const none = { sub: 's', username: 'u', groups: [] as string[] };
    expect(selectInitialRole(manifest, none)).toMatchObject({ role: { id: 'viewer' }, source: 'default' });
    const wildcard = { sub: 's', username: 'u', groups: ['app-*-viewer'] };
    expect(entitledRoles(manifest, wildcard).map((r) => r.id)).toEqual(['viewer']);
  });

  it('blanket-access groups grant the default role; explicit app groups still win', () => {
    const viewerAll = { sub: 's', username: 'u', groups: ['medapp-viewers'] };
    expect(entitledRoles(manifest, viewerAll).map((r) => r.id)).toEqual(['viewer']);
    expect(selectInitialRole(manifest, viewerAll)).toMatchObject({ role: { id: 'viewer' }, source: 'group' });
    const approverWithReview = { sub: 's', username: 'u', groups: ['medapp-approvers', 'app-app_bp_trend-reviewer'] };
    expect(entitledRoles(manifest, approverWithReview).map((r) => r.id)).toEqual(['reviewer', 'viewer']);
    expect(selectInitialRole(manifest, approverWithReview).role.id).toBe('reviewer');
    expect(entitledRoles(manifest, { sub: 's', username: 'u', groups: ['medapp-authors'] })).toEqual([]);
  });

  it('clinicians open only published versions; staff open everything; no role means no access', () => {
    const published = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_patient_summary');
    if (!published?.ok) throw new Error('published example missing');
    expect(manifest.lifecycle.state).toBe('in_review');
    expect(published.manifest.lifecycle.state).toBe('published');

    const viewer = { sub: 's', username: 'u', groups: ['medapp-viewers'] };
    const approver = { sub: 's', username: 'u', groups: ['medapp-approvers'] };
    const nobody = { sub: 's', username: 'u', groups: ['app-app_other-viewer'] };
    const real = { isMock: false };

    expect(appAccess(manifest, viewer, real)).toMatchObject({ canOpen: false, reason: 'not_published' });
    expect(appAccess(published.manifest, viewer, real)).toMatchObject({ canOpen: true });
    expect(appAccess(manifest, approver, real)).toMatchObject({ canOpen: true });
    expect(appAccess(manifest, nobody, real)).toMatchObject({ canOpen: false, reason: 'no_role' });
    expect(appAccess(published.manifest, nobody, real)).toMatchObject({ canOpen: false, reason: 'no_role' });
    // mock mode: everything is openable so the renderer can be exercised without a pool
    expect(appAccess(manifest, nobody, { isMock: true })).toMatchObject({ canOpen: true });
  });

  it('recognises platform staff from the shared group names', () => {
    expect(isPlatformStaff({ sub: 's', username: 'u', groups: ['medapp-authors'] })).toBe(true);
    expect(isPlatformStaff({ sub: 's', username: 'u', groups: ['medapp-approvers', 'app-app_bp_trend-viewer'] })).toBe(true);
    expect(isPlatformStaff({ sub: 's', username: 'u', groups: ['app-app_bp_trend-reviewer'] })).toBe(false);
    expect(isPlatformStaff({ sub: 's', username: 'u', groups: [] })).toBe(false);
  });
});

describe('helpers', () => {
  it('resolves relative dates', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    expect(resolveDateExpression('now-2y', now)).toBe('2024-09-10T00:00:00.000Z');
    expect(resolveDateExpression('now-90d', now)).toBe('2026-06-12T00:00:00.000Z');
    expect(resolveDateExpression('2025-01-01', now)).toBe('2025-01-01');
    expect(resolveDateExpression(undefined, now)).toBeUndefined();
  });

  it('an ATC class or an ICD-10-GM category matches every code under it; other systems match exactly (mirror of fhir_source.py)', () => {
    const atc = 'http://www.whocc.no/atc';
    const icd = 'http://fhir.de/CodeSystem/bfarm/icd-10-gm';
    expect(isClassCode(atc, 'C09A') && isClassCode(atc, 'C03') && !isClassCode(atc, 'C09AA05')).toBe(true);
    expect(isClassCode(icd, 'I10') && !isClassCode(icd, 'I10.90') && !isClassCode('http://loinc.org', '854')).toBe(true);
    const ramipril = { coding: [{ system: atc, code: 'C09AA05' }] };
    expect(conceptMatches(ramipril, [`${atc}|C09A`])).toBe(true);
    expect(conceptMatches(ramipril, [`${atc}|C08CA`])).toBe(false);
    expect(conceptMatches(ramipril, ['C09A'])).toBe(false); // a bare class without its system is not a hierarchy
    expect(conceptMatches(ramipril, ['C09AA05'])).toBe(true);
    const hypertension = { coding: [{ system: icd, code: 'I10.90' }] };
    expect(conceptMatches(hypertension, [`${icd}|I10`])).toBe(true);
    expect(conceptMatches(hypertension, [`${icd}|I1`])).toBe(false);
    expect(conceptMatches({ coding: [{ system: icd, code: 'I100' }] }, [`${icd}|I10`])).toBe(false); // the category covers I10.x, not letters that merely match
  });

  it('flattens every value[x] shape present in the seed', () => {
    const kinds = new Set(SEED.observations.map((o) => flattenObservationValue(o).kind));
    expect([...kinds].sort()).toEqual(['components', 'concept', 'quantity']);
  });

  it('validates runtime config and reports actionable problems', () => {
    const cfg = loadRuntimeConfig({ VITE_AUTH_MODE: 'cognito', VITE_COGNITO_REGION: 'eu-central-1', VITE_COGNITO_USER_POOL_ID: 'eu-west-1_abc', VITE_COGNITO_CLIENT_ID: '' });
    expect(cfg.problems).toEqual(['VITE_COGNITO_CLIENT_ID is not set.', 'VITE_COGNITO_USER_POOL_ID (eu-west-1_abc) does not belong to region eu-central-1.']);
    expect(loadRuntimeConfig({ VITE_AUTH_MODE: 'mock', VITE_DATA_MODE: 'mock' }).problems).toEqual([]);
    expect(() => loadRuntimeConfig({ VITE_AUTH_MODE: 'saml' })).toThrow(/VITE_AUTH_MODE/);
  });

  it('points the viewer at the synthetic studies when the data is synthetic', () => {
    // Mock data mode: every study the panel shows is synthetic, so the viewer opens them from its `reference` source.
    expect(loadRuntimeConfig({ VITE_AUTH_MODE: 'mock', VITE_DATA_MODE: 'mock' }).imaging.viewerDataSource).toBe(SYNTHETIC_VIEWER_SOURCE);
    // The deployed panel on the hospital's record: the viewer's default source (the hospital's PACS) — the preview overrides this per render.
    expect(loadRuntimeConfig({ VITE_AUTH_MODE: 'cognito', VITE_DATA_MODE: 'dispatcher', VITE_API_BASE_URL: 'https://api.example', VITE_COGNITO_REGION: 'eu-central-1', VITE_COGNITO_USER_POOL_ID: 'eu-central-1_x', VITE_COGNITO_CLIENT_ID: 'c' }).imaging.viewerDataSource).toBeUndefined();
    expect(loadRuntimeConfig({ VITE_AUTH_MODE: 'mock', VITE_DATA_MODE: 'mock', VITE_OHIF_DATA_SOURCE: 'other' }).imaging.viewerDataSource).toBe('other');
  });

  it('mock auth turns +role suffixes into wildcard groups', async () => {
    const provider = createMockAuthProvider();
    const result = await provider.signIn('dr.hoffmann+viewer,reviewer', 'x');
    expect(result.status).toBe('signed_in');
    if (result.status === 'signed_in') {
      expect(result.session.claims.username).toBe('dr.hoffmann');
      expect(result.session.claims.groups).toEqual(['app-*-viewer', 'app-*-reviewer']);
    }
    // A platform group named as is stays one: `+medapp-admins` opens the administrator's views in mock mode.
    const admin = await provider.signIn('ada+medapp-admins,reviewer', 'x');
    if (admin.status === 'signed_in') expect(admin.session.claims.groups).toEqual(['medapp-admins', 'app-*-reviewer']);
    await expect(provider.signIn('', 'x')).rejects.toThrow(/username/);
  });
});

describe('runtime configuration from config.json', () => {
  it('takes the deployment values over .env, ignores non-JSON answers and unknown keys', async () => {
    const { fetchRuntimeOverrides, loadRuntimeConfig } = await import('../config/env');
    const json = (body: unknown, type = 'application/json') => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': type } });

    // A deployed panel: the hospital's values, only VITE_ strings survive.
    const overrides = await fetchRuntimeOverrides(json({ VITE_API_BASE_URL: 'https://api.example', VITE_REGISTRY_MODE: 'remote', VITE_DATA_MODE: 'dispatcher', VITE_AUTH_MODE: 'cognito', VITE_COGNITO_REGION: 'eu-central-1', VITE_COGNITO_USER_POOL_ID: 'eu-central-1_abc', VITE_COGNITO_CLIENT_ID: 'client', evil: 'x', VITE_NUMBER: 3 }));
    expect(Object.keys(overrides).sort()).toEqual(['VITE_API_BASE_URL', 'VITE_AUTH_MODE', 'VITE_COGNITO_CLIENT_ID', 'VITE_COGNITO_REGION', 'VITE_COGNITO_USER_POOL_ID', 'VITE_DATA_MODE', 'VITE_REGISTRY_MODE']);
    const cfg = loadRuntimeConfig({ VITE_HOSPITAL_ID: 'hsp-dev', VITE_AUTH_MODE: 'mock', ...overrides });
    expect(cfg.auth.mode).toBe('cognito');
    expect(cfg.data.apiBaseUrl).toBe('https://api.example');
    expect(cfg.problems).toEqual([]);

    // The dev server answers /config.json with index.html (200, text/html): no overrides.
    expect(await fetchRuntimeOverrides(json('<!doctype html>', 'text/html'))).toEqual({});
    // Missing or broken: no overrides, no exception.
    expect(await fetchRuntimeOverrides(async () => new Response('', { status: 404 }))).toEqual({});
    expect(await fetchRuntimeOverrides(async () => { throw new Error('offline'); })).toEqual({});
    expect(await fetchRuntimeOverrides(json([1, 2]))).toEqual({});
  });
});
