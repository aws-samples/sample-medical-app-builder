import { describe, expect, it } from 'vitest';
import { specsEqual } from '../panel/drafting/specView';

/**
 * "Save as new version" and "Save changes" stay disabled while the draft equals the version it came from. The registry
 * writer assigns the header and the version numbers, so those never count as a difference; anything else does.
 */
describe('specsEqual', () => {
  const saved = { apiVersion: 'medapp.eu/v1', kind: 'AppSpec', archetype: 'APP-02', app: { app_id: 'app_x', name: 'X', version: '0.1.0' }, knobs: { codes: [{ system: 'loinc', code: '4548-4' }], window: 'now-5y' }, roles: [{ id: 'v', phi_fields_visible: ['name', 'dob'] }] };

  it('ignores what the writer sets and the order of keys', () => {
    expect(specsEqual(saved, { ...saved, apiVersion: undefined, kind: undefined, app: { name: 'X', app_id: 'app_x', version: '0.2.0', parent_version: '0.1.0' } })).toBe(true);
    expect(specsEqual({ roles: saved.roles, knobs: { window: 'now-5y', codes: saved.knobs.codes }, app: saved.app, archetype: 'APP-02' }, saved)).toBe(true);
    expect(specsEqual({ ...saved, knobs: { ...saved.knobs, chart_title: undefined } }, saved)).toBe(true);
  });

  it('sees every real change', () => {
    expect(specsEqual({ ...saved, app: { ...saved.app, name: 'X, revised' } }, saved)).toBe(false);
    expect(specsEqual({ ...saved, knobs: { ...saved.knobs, window: 'now-2y' } }, saved)).toBe(false);
    expect(specsEqual({ ...saved, roles: [{ id: 'v', phi_fields_visible: ['name'] }] }, saved)).toBe(false);
    expect(specsEqual({ ...saved, roles: [...saved.roles, { id: 'r', phi_fields_visible: [] }] }, saved)).toBe(false);
    expect(specsEqual({ ...saved, knobs: { ...saved.knobs, codes: [{ code: '4548-4', system: 'loinc' }, { system: 'loinc', code: '718-7' }] } }, saved)).toBe(false);
    expect(specsEqual(undefined, saved)).toBe(false);
    expect(specsEqual(undefined, undefined)).toBe(true);
  });
});
