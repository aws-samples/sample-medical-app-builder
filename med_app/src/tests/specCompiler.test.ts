import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { screen } from '@testing-library/react';
import { QuestionnaireArtifactSchema } from '../manifest/artifacts';
import { validateManifest, type AppManifest } from '../manifest/schema';
import { ARCHETYPE_IDS, AppSpecSchema, appSpecJsonSchema, canonical, compileSpec, readiness, type AppSpec } from '../spec';
import { describePhi, describeWindow } from '../spec/blocks';
import { loadBundledShapes } from '../manifest/registry';
import { shapeLookup } from '../spec/shapes';
import { renderManifest } from './testUtils';

// The record shapes bundled with the panel (med_app/shapes): what `shape:` references in the fixtures resolve against.
const SHAPES = shapeLookup(loadBundledShapes());

const read = (rel: string): unknown => parseYaml(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const spec = (name: string): unknown => read(`../../specs/${name}.yaml`);
/** A hand-authored reference manifest (fixtures/manifests) or a seed app (manifests/<hospital_id>): the compiler must reproduce both from their specs. */
const reference = (name: string, dir = 'fixtures/manifests'): AppManifest => {
  const r = validateManifest(read(`../../${dir}/${name}.yaml`));
  if (!r.ok) throw new Error(`reference manifest ${name} invalid: ${JSON.stringify(r.issues)}`);
  return r.manifest;
};
const withoutLifecycle = ({ lifecycle: _l, ...rest }: AppManifest) => rest;
/** Archetypes without a hand-authored manifest: the compiler's own output, checked in under specs/expected. */
const expected = (name: string): AppManifest => {
  const r = validateManifest(read(`../../specs/expected/${name}.yaml`));
  if (!r.ok) throw new Error(`expected manifest ${name} invalid: ${JSON.stringify(r.issues)}`);
  return r.manifest;
};
const REFERENCE_FIXTURES = ['bp-trend', 'patient-summary', 'hypertension-cohort', 'htn-assessment', 'dicom-study-review'];
// The seed sets the registries ship (med_app/showcase/<hospital_id>.yaml → manifests/<hospital_id>/): each app compiled from
// its spec, published with an example sign-off, stamped with its hospital's id.
const SETS = readdirSync(resolve('showcase')) // vitest runs from med_app
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => read(`../../showcase/${f}`) as { hospital_id: string; apps: { spec: string; note: string }[]; collections?: { name: string; apps: string[] }[] });
const SHOWCASE = [...new Set(SETS.flatMap((set) => set.apps.map((a) => a.spec)))];
const EXPECTED_FIXTURES = ['vitals-flowsheet', 'problems-medication', 'hypertension-dashboard', 'preconsultation-snapshot', 'record-inspector', 'hypertension-kpi', 'composed-consultation', 'composed-nurse-visit', 'composed-record-review', 'composed-ward-entry', 'composed-ward-documentation', 'composed-ward-tasks', 'ward-worklist', 'htn-assessment-due', 'composed-falls-course', 'composed-wound-photos', 'falls-risk-form', 'composed-therapy-plan', 'composed-therapy-plan-library', 'composed-physio-assessment', 'composed-patient-alerts'];
// Specs written for the hospital's record (a German hospital record: ICD-10-GM diagnoses, OPS procedures, a German lab panel, no MRN) — see docs/example-prompts.md §8.
const HOSPITAL_FIXTURES = ['hospital-oncology-overview', 'hospital-haemoglobin-trend', 'hospital-hypertension-register'];

/**
 * The golden rule: the compiler must reproduce the hand-authored manifests from their specs, so
 * the manifests we already trust are the compiler's specification. Lifecycle is registry-managed
 * (the reference files carry example sign-offs); everything else must match exactly.
 */
describe('spec compiler — golden manifests', () => {
  for (const name of REFERENCE_FIXTURES) {
    it(`compile(specs/${name}.yaml) == fixtures/manifests/${name}.yaml`, () => {
      const ref = reference(name);
      const result = compileSpec(spec(name), { hospital_id: ref.metadata.hospital_id, created_at: ref.metadata.created_at ?? '', shapes: SHAPES });
      expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
      if (!result.ok) return;
      expect(canonical(withoutLifecycle(result.manifest))).toEqual(canonical(withoutLifecycle(ref)));
      expect(result.manifest.lifecycle).toEqual({ state: 'draft', signoff: null, provenance: { generated_by_pipeline_version: '0.1.0' } });
    });
  }

  for (const set of SETS) {
    for (const { spec: name, note } of set.apps) {
      it(`compile(specs/${name}.yaml) == manifests/${set.hospital_id}/${name}.yaml (${set.hospital_id}'s seed app, published)`, () => {
        const ref = reference(name, `manifests/${set.hospital_id}`);
        expect(ref.lifecycle.state).toBe('published');
        expect(ref.metadata.hospital_id).toBe(set.hospital_id);
        expect(ref.lifecycle.signoff?.clinical_notes).toBe(note);
        const result = compileSpec(spec(name), { hospital_id: set.hospital_id, created_at: ref.metadata.created_at ?? '', shapes: SHAPES });
        expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
        if (!result.ok) return;
        expect(canonical(withoutLifecycle(result.manifest))).toEqual(canonical(withoutLifecycle(ref)));
      });
    }
    it(`${set.hospital_id}: the set's folder holds exactly its apps, and its collections name apps of the set`, () => {
      const files = readdirSync(resolve('manifests', set.hospital_id)).filter((f) => f.endsWith('.yaml')).sort();
      expect(files).toEqual(set.apps.map((a) => `${a.spec}.yaml`).sort());
      const ids = new Set(set.apps.map((a) => (spec(a.spec) as { app: { app_id: string } }).app.app_id));
      for (const c of set.collections ?? []) for (const id of c.apps) expect(ids.has(id), `${c.name} names ${id}`).toBe(true);
    });
  }

  for (const name of [...EXPECTED_FIXTURES, ...HOSPITAL_FIXTURES]) {
    it(`compile(specs/${name}.yaml) == specs/expected/${name}.yaml (regenerate deliberately when the compiler changes)`, () => {
      const ref = expected(name);
      const result = compileSpec(spec(name), { hospital_id: ref.metadata.hospital_id, created_at: ref.metadata.created_at ?? '', shapes: SHAPES });
      expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
      if (!result.ok) return;
      expect(canonical(withoutLifecycle(result.manifest))).toEqual(canonical(withoutLifecycle(ref)));
    });
  }

  it('compiles deterministically', () => {
    const a = compileSpec(spec('bp-trend'), { hospital_id: 'h', created_at: 't' });
    const b = compileSpec(spec('bp-trend'), { hospital_id: 'h', created_at: 't' });
    expect(a).toEqual(b);
  });

  it('every archetype has a fixture spec', () => {
    const covered = new Set([...REFERENCE_FIXTURES, ...EXPECTED_FIXTURES, ...SHOWCASE].map((n) => (spec(n) as { archetype: string }).archetype));
    expect([...covered].sort()).toEqual([...ARCHETYPE_IDS].sort());
  });
});

describe('spec compiler — variations are knob values, not new code', () => {
  const base = spec('bp-trend') as AppSpec & { archetype: 'APP-02' };

  it('an HbA1c trend: single-value series, one threshold, one role, no gated section', async () => {
    const hba1c = {
      ...base,
      app: { app_id: 'app_hba1c_trend', name: 'HbA1c over time', description: 'Glycated haemoglobin against the 7 % target.' },
      knobs: {
        codes: [{ system: 'loinc', code: '4548-4' }],
        series: [{ label: 'HbA1c', code: '4548-4' }],
        thresholds: [{ value: 7, label: 'Target ≤ 7 %' }],
        unit: '%',
        window: 'now-5y',
        readings_rows: 6,
      },
      roles: [{ id: 'clinician', display_name: 'Treating clinician', phi_fields_visible: ['name', 'dob', 'gender', 'mrn'] }],
      default_role: 'clinician',
    };
    const result = compileSpec(hba1c, { hospital_id: 'hsp-musterstadt', created_at: '2026-09-13T00:00:00Z' });
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.primitives.map((p) => p.id)).toEqual(['p_patient', 'p_series']); // no conditions primitive without a gated section
    expect(m.primitives[1]?.config).toEqual({ patient: '$context.patient_id', codes: ['http://loinc.org|4548-4'], since: '$context.window_start', count: 500 });
    expect(m.data_scopes['scope_clinician']).toEqual({
      patient_scope: 'individual',
      phi_fields_visible: ['name', 'dob', 'gender', 'mrn'],
      fhir: [
        { resource: 'Patient', operations: ['read'] },
        { resource: 'Observation', operations: ['search'], codes: ['http://loinc.org|4548-4'], filter: 'subject={context.patient_id}&date=ge{context.window_start}' },
      ],
    });
    expect(m.auth.roles[0]?.cognito_group).toBe('app-app_hba1c_trend-clinician');
    expect(m.context_inputs.find((c) => c.name === 'window_start')?.default).toBe('now-5y');
    const chart = m.layout.root.children?.[1]?.children?.[0];
    expect(chart?.props?.['title']).toBe('HbA1c, last five years'); // default wording from series + window
    expect(chart?.props?.['series']).toEqual([{ label: 'HbA1c', code: '4548-4' }]);

    await renderManifest(m, { role: 'clinician' });
    expect(await screen.findByTestId('observation-timeline')).toHaveTextContent('HbA1c, last five years');
    expect(screen.getByTestId('patient-banner')).toHaveTextContent('Anneliese Krüger');
  });

  it('a role bound to an existing hospital group and a German-labelled cohort', () => {
    const cohort = spec('hypertension-cohort') as AppSpec & { archetype: 'APP-09' };
    const de = {
      ...cohort,
      app: { ...cohort.app, app_id: 'app_htn_kohorte', name: 'Hypertonie-Kohorte', language: 'de' },
      knobs: {
        ...cohort.knobs,
        condition: { ...cohort.knobs.condition, label: 'aktiver Hypertonie' },
        value: { ...cohort.knobs.value, label: 'Letzter Blutdruck' },
        cards: { count_label: 'Patienten mit aktiver Hypertonie', threshold_label: 'Letzter systolischer Wert ≥ 140 mmHg', threshold_hint: 'Jüngstes Blutdruckpanel pro Patient', scope_card: false },
        table_title: 'Kohortenmitglieder',
      },
      roles: [{ id: 'cohort_analyst', display_name: 'Kohortenanalyst', group: { kind: 'existing', name: 'kardiologie-pflege' }, phi_fields_visible: ['name', 'dob', 'mrn'] }],
    };
    const result = compileSpec(de, { hospital_id: 'hsp-musterstadt', created_at: '2026-09-13T00:00:00Z' });
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.auth.roles[0]?.cognito_group).toBe('kardiologie-pflege');
    const grid = result.manifest.layout.root.children?.[0];
    expect(grid?.props?.['columns']).toBe(2);
    expect(grid?.children?.map((c) => c.props?.['label'])).toEqual(['Patienten mit aktiver Hypertonie', 'Letzter systolischer Wert ≥ 140 mmHg']);
  });

  it('patient summary as masked banner with stacked sections and fewer parts', async () => {
    const summary = spec('patient-summary') as AppSpec & { archetype: 'APP-01' };
    const stacked = {
      ...summary,
      app: { ...summary.app, app_id: 'app_ward_snapshot', name: 'Ward snapshot' },
      knobs: { identity: 'banner', arrangement: 'stack', sections: [{ kind: 'medication', status: 'all' }, { kind: 'problems' }] },
      roles: [{ id: 'nurse', display_name: 'Ward nurse', phi_fields_visible: ['name', 'dob', 'mrn'] }],
      default_role: 'nurse',
    };
    const result = compileSpec(stacked, { hospital_id: 'hsp-musterstadt', created_at: '2026-09-13T00:00:00Z' });
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.primitives.map((p) => p.id)).toEqual(['p_patient', 'p_medications', 'p_conditions']);
    expect(m.primitives[1]?.config).toEqual({ resource: 'MedicationRequest', params: { patient: '$context.patient_id' } }); // status: all → no status filter
    expect(m.context_inputs.map((c) => c.name)).toEqual(['patient_id']); // no vitals → no window
    expect(m.audit?.data_categories).toEqual(['phi']);
    expect(m.layout.root.children?.[0]?.component).toBe('PatientBanner');
    expect(m.layout.root.children?.[1]?.children?.map((c) => c.props?.['title'])).toEqual(['Medication', 'Problems']);

    await renderManifest(m, { role: 'nurse' });
    expect(await screen.findByText('Medication history')).toBeInTheDocument();
    expect(await screen.findByText('Amlodipin 5 mg')).toBeInTheDocument();
  });
});

describe('readiness — the deterministic "is this clear enough?"', () => {
  it('lists what a partial draft still lacks, as fields', () => {
    const partial = { apiVersion: 'medapp.eu/v1', kind: 'AppSpec', archetype: 'APP-02', app: { app_id: 'app_x', name: 'X' }, knobs: { codes: [{ system: 'loinc', code: '4548-4' }] } };
    const r = readiness(partial);
    expect(r.ready).toBe(false);
    const paths = r.missing.map((m) => m.path);
    expect(paths).toEqual(expect.arrayContaining(['roles', 'default_role', 'governance', 'knobs.series']));
    expect(r.missing.find((m) => m.path === 'roles')?.message).toBe('is required');
  });

  it('is ready exactly when the spec compiles', () => {
    expect(readiness(spec('bp-trend'))).toEqual({ ready: true, missing: [] });
    expect(readiness(spec('patient-summary')).ready).toBe(true);
    expect(readiness(spec('hypertension-cohort')).ready).toBe(true);
  });

  it('catches contradictions between knobs and roles', () => {
    const summary = spec('patient-summary') as AppSpec & { archetype: 'APP-01' };
    const masked = { ...summary, roles: [{ ...summary.roles[0], phi_fields_visible: ['name', 'mrn'] }] }; // header shows everything
    const r = readiness(masked);
    expect(r.ready).toBe(false);
    expect(r.missing[0]).toMatchObject({ path: 'roles.0.phi_fields_visible', message: expect.stringContaining('use identity "banner"') });

    const trend = spec('bp-trend') as AppSpec & { archetype: 'APP-02' };
    const ghost = { ...trend, knobs: { ...trend.knobs, conditions_section: { ...trend.knobs.conditions_section, roles: ['auditor'] } } };
    expect(readiness(ghost).missing).toEqual([{ path: 'knobs.conditions_section.roles.0', message: '"auditor" is not a declared role' }]);
    expect(compileSpec(ghost, { hospital_id: 'h', created_at: 't' }).ok).toBe(false);
  });

  it('refuses unknown fields and unknown code systems (the agent cannot smuggle structure in)', () => {
    const trend = spec('bp-trend') as Record<string, unknown>;
    expect(readiness({ ...trend, layout: { component: 'FreeformHtml' } }).missing.some((m) => /unrecognized/i.test(m.message))).toBe(true);
    const badSystem = { ...trend, knobs: { ...(trend['knobs'] as object), codes: [{ system: 'icd', code: 'I10' }] } };
    expect(readiness(badSystem).missing.some((m) => m.path === 'knobs.codes.0.system')).toBe(true);
  });

  it('imaging review: the viewer layout knob reaches the DicomViewer only when it is not the default (the goldens stay untouched)', () => {
    const base = spec('dicom-study-review') as AppSpec & { knobs: Record<string, unknown> };
    const find = (node: { component: string; props?: Record<string, unknown>; children?: unknown[] }): Record<string, unknown> | undefined =>
      node.component === 'DicomViewer' ? node.props : (node.children as typeof node[] | undefined)?.map(find).find(Boolean);
    const plain = compileSpec(base, { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    expect(plain.ok && find(plain.manifest.layout.root)?.['layout']).toBeUndefined();
    const volume = compileSpec({ ...base, knobs: { ...base.knobs, viewer_layout: 'volume' } }, { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    expect(volume.ok && find(volume.manifest.layout.root)?.['layout']).toBe('volume');
    expect(readiness({ ...base, knobs: { ...base.knobs, viewer_layout: 'hologram' } }).missing.map((m) => m.path)).toEqual(['knobs.viewer_layout']);

    const composed = spec('composed-consultation') as AppSpec & { knobs: { sections: Record<string, unknown>[] } };
    const section = { ...composed, knobs: { ...composed.knobs, sections: composed.knobs.sections.map((sec) => (sec['kind'] === 'imaging' ? { ...sec, layout: 'mpr' } : sec)) } };
    const result = compileSpec(section, { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    expect(result.ok && find(result.manifest.layout.root)?.['layout']).toBe('mpr');
  });

  it('the schema parses every fixture with defaults applied', () => {
    for (const name of ['bp-trend', 'patient-summary', 'hypertension-cohort', 'htn-assessment', 'dicom-study-review']) {
      const parsed = AppSpecSchema.safeParse(spec(name));
      expect(parsed.success, name).toBe(true);
    }
  });
});

describe('published JSON Schema', () => {
  it('docs/app-spec.schema.json is what the code generates (run `npm run appspec -- schema --out docs/app-spec.schema.json`)', () => {
    const published = read('../../docs/app-spec.schema.json');
    expect(published).toEqual(JSON.parse(JSON.stringify(appSpecJsonSchema())));
  });

  it('exposes what an agent tool needs: one variant per archetype, closed objects, descriptions and defaults', () => {
    const schema = appSpecJsonSchema() as { oneOf: { properties: Record<string, { const?: string; properties?: Record<string, unknown>; additionalProperties?: boolean; required?: string[] }> }[] };
    expect(schema.oneOf.map((v) => v.properties['archetype']?.const).sort()).toEqual([...ARCHETYPE_IDS].sort());
    for (const v of schema.oneOf) {
      expect(v.properties['knobs']?.additionalProperties).toBe(false);
      expect(v.properties['knobs']?.properties).toBeDefined();
    }
    const trend = schema.oneOf.find((v) => v.properties['archetype']?.const === 'APP-02');
    const window = (trend?.properties['knobs']?.properties as Record<string, { default?: string; description?: string }>)['window'];
    expect(window?.default).toBe('now-2y');
    expect(window?.description).toContain('How far back to look');
  });
});

describe('deterministic wording', () => {
  it('describes windows and PHI allow-lists', () => {
    expect(describeWindow('now-2y')).toBe('Last two years');
    expect(describeWindow('now-6m')).toBe('Last six months');
    expect(describeWindow('now-90d')).toBe('Last 90 days');
    expect(describeWindow('now-1y')).toBe('Last year');
    expect(describeWindow('2025-01-01')).toBe('Since 2025-01-01');
    expect(describePhi(['name', 'dob', 'mrn'])).toBe('Name, date of birth and MRN visible; no contact details');
    expect(describePhi(['mrn', 'name', 'phone', 'address'])).toBe('Name and MRN visible; address and phone visible');
    expect(describePhi([])).toBe('No identity fields visible; no contact details');
  });
});

describe('every compiled archetype renders against the synthetic record', () => {
  const EXPECT_TEXT: Record<string, string[]> = {
    'vitals-flowsheet': ['Vitals, last six months', 'Renal'],
    'problems-medication': ['Active problems', 'Medication history'],
    'hypertension-dashboard': ['Systolic / Diastolic, last year', 'Current therapy', 'Amlodipin', 'Ramipril', 'Related conditions', 'Hypertensive disorder', 'Reference lines: ESC/ESH 2023'], // the therapy by ATC class, the problem by its SNOMED coding, the guideline under the chart
    'preconsultation-snapshot': ['Active problems', 'Current medication', 'Readings, last 90 days'],
    'record-inspector': ['Patient', 'Latest assessment'],
    'hypertension-kpi': ['Patients with active hypertension', 'Latest systolic ≥ 140 mmHg'],
    'htn-assessment': ['Previous assessments'],
    'dicom-study-review': ['Available studies'],
    'composed-consultation': ['Systolic / Diastolic, last two years', 'Current therapy', 'Kidney values', 'Active problems'],
    'composed-nurse-visit': ['Overview', 'Assessment', 'Active problems', 'Current medication', 'Readings, last year'],
    'composed-record-review': ['Allergies and intolerances', 'Penicillin', 'Visits', 'Stationärer Aufenthalt Orthopädie', 'Reports', 'Kein Nachweis eines Infiltrats', 'Letters and notes', 'Entlassungsbrief Orthopädie', 'Procedures', 'Arthroskopie Knie rechts', 'Immunizations', 'Influenza-Impfung 2025/26', 'Laboratory results', 'Hemoglobin A1c'],
    'composed-ward-entry': ['Record a blood pressure', 'Systolic', 'Diastolic', 'Record reading', 'Active problems', 'Mark resolved', 'Active medication', 'Stop'],
    'composed-ward-documentation': ['Problem list', 'Add a diagnosis', 'Diagnosis', 'Add to problem list', 'Allergies and intolerances', 'Record an allergy or intolerance', 'Substance or agent', 'Record allergy', 'Procedures', 'Document a procedure', 'Performed at', 'Body site (optional)', 'Record procedure'],
    'composed-ward-tasks': ['Open tasks', 'Falls risk screen', 'Discharge letter', 'overdue', 'New task', 'Create task', 'Active problems'],
    'ward-worklist': ['Open tasks on the ward', 'Overdue', 'Falls risk screen', 'Follow-up call', 'Krüger', 'Everyone', 'Open'],
    'composed-falls-course': ['Timed up-and-go across screens', '3 data points · s', 'Reference lines: Shumway-Cook 2000', 'Last falls screen', 'Walking aid in use', 'Falls reported per screen', '1 data point', 'Active problems'], // three screens, one with a fall
    'composed-wound-photos': ['Wound course', '2 photos', 'Wound', 'Left heel', 'Document a wound', 'Take or choose a photo', 'Active problems'], // Anneliese's two synthetic wound tiles, the form beside them
    'composed-therapy-plan': ['Goals', 'Timed up-and-go under 12 seconds', 'Set a goal', 'Measured by', 'Target value', 'Progress notes', 'Progress note', 'Kind of note'], // the seed goal, the two declared-shape forms
    'composed-therapy-plan-library': ['Goals', 'Measurable goal', 'Measured by', 'Progress notes', 'Progress note', 'Kind of note', 'Consent decisions', 'Research', 'Consent decision', 'Kind of consent'], // the same page from the library: the shapes' names head the forms; the seed's two consent decisions
    'composed-physio-assessment': ['Knee flexion, both sides', '6 data points · °', 'First against latest', 'Knee flexion · left', '+23 °', 'Latest measurements', 'Record knee flexion', 'Side (Knee joint structure)', 'Test conditions', 'Record grip strength'],
    'composed-patient-alerts': ['Alerts on record', 'No alert on record.', 'Patient alert', 'Alert', 'Kind of alert', 'Review by', 'Raise alert'], // an administrator-defined kind (Flag) written through the library; nothing seeded, so the list is empty // the seed's paired measurements split by side, the sided forms
    'htn-assessment-due': ['Due the follow-up assessment', 'Never assessed', 'Overdue', 'Last follow-up assessment', 'Yıldız', 'never assessed', 'Krüger', 'overdue'], // Fatma has hypertension and no answer; Anneliese answered ~3 months before the seed anchor, over a year ago by the real clock
    // The hospital-record specs render on the synthetic record too (their sections name no codes, or codes the seed carries).
    'hospital-oncology-overview': ['Active diagnoses', 'Procedures', 'Radiology reports', 'Imaging studies'],
    'hospital-haemoglobin-trend': ['Haemoglobin, last five years', 'Haemoglobin'],
    'hospital-hypertension-register': ['essential hypertension', 'Latest blood pressure'],
    // The showcase set the registry ships.
    'patient-360': ['Active problems', 'Current medication', 'Blood pressure, last two years', 'Latest vitals', 'Allergies and intolerances', 'Visits', 'Reports', 'Letters and notes', 'Procedures', 'Immunizations', 'Laboratory results'],
    'cardio-renal-follow-up': ['Blood pressure, last three years', 'Blood pressure readings', 'Kidney function (eGFR)', 'Body weight', 'Heart rate', 'Active problems', 'Mark resolved', 'Active medication', 'Stop'],
    'tumour-board': ['Diagnoses', 'Procedures', 'Radiology reports', 'Haemoglobin, last five years', 'CRP', 'Leukocytes', 'Imaging studies', 'Letters and notes'],
    'imaging-review-3d': ['Imaging studies'],
    'hypertension-register': ['hypertension', 'Latest blood pressure', 'Systolic range', 'Systolic in range'],
    'ckd-imaging-register': ['chronic kidney disease', 'With renal imaging', 'Latest eGFR', 'Latest study', 'Open imaging', 'Yıldız'], // Fatma: CKD stage 3, a CT and a renal ultrasound, four eGFRs
    'follow-up-due': ['Due the follow-up assessment', 'Never assessed', 'Overdue', 'Yıldız', 'Krüger'],
    'diabetes-follow-up': ['HbA1c', 'Reference lines: ADA', 'Current therapy', 'Metformin', 'Related conditions', 'Type 2 diabetes mellitus'], // the template: goal line with its source, therapy by ATC class, the problem by its coding
    'ward-documentation': ['Open tasks', 'New task', 'Problem list', 'Add a diagnosis', 'Allergies and intolerances', 'Record an allergy or intolerance', 'Procedures', 'Document a procedure'],
    'ward-open-tasks': ['Open tasks on the ward', 'Overdue', 'Falls risk screen', 'Mine', 'Everyone'],
    'wound-documentation': ['Wound course', '2 photos', 'Document a wound', 'Take or choose a photo', 'Active problems'],
    'hypertension-follow-up': ['Follow-up assessment', 'Earlier assessments', 'Blood pressure, last two years', 'Readings', 'Active problems', 'Active medication'],
    'falls-risk-assessment': ['Falls risk screen', 'Has the patient fallen in the last 12 months?', 'Walking aid in use', 'Timed up-and-go (s, 0–300)', 'Earlier screens', 'Record screen', 'Timed up-and-go across screens', 'Last falls screen', 'Active problems'], // the designed form, and its answers read back as data (the seed's screens sit under hsp-musterstadt's canonical — see the showcase test)
  };
  for (const [name, texts] of Object.entries(EXPECT_TEXT)) {
    it(`${name}: compiles and shows its parts`, async () => {
      const result = compileSpec(spec(name), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z', shapes: SHAPES });
      expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
      if (!result.ok) return;
      const manifest = result.manifest;
      const context = manifest.context_inputs.some((c) => c.name === 'patient_id') ? { patient_id: 'pat-kms-0001' } : {};
      const diagnostics: string[] = [];
      await renderManifest(manifest, { context, onDiagnostic: (d) => diagnostics.push(d.message) });
      for (const t of texts) expect((await screen.findAllByText(t, { exact: false }, { timeout: 4000 })).length).toBeGreaterThan(0);
      // An unresolved reference is an authoring mistake; the compiler must not produce one. Two misses are
      // legitimate: an empty "latest" list in the inspector, and a `$ui` selection nobody has made yet.
      expect(diagnostics.filter((d) => !d.includes('[0]') && !d.includes('$ui.'))).toEqual([]);
    });
  }
});

describe('the showcase set', () => {
  it('Hypertension register: the systolic range is a slider over data fetched once — the table and the count follow it, nothing is read again', async () => {
    const m = reference('hypertension-register', 'manifests/hsp-musterstadt');
    const rows = m.layout.root.children ?? [];
    const [grid, slider, table] = rows;
    expect(grid?.component).toBe('Grid');
    expect(grid?.children?.map((c) => c.component)).toEqual(['StatCard', 'StatCard', 'CohortRangeCard', 'StatCard']);
    expect(slider).toMatchObject({ component: 'RangeFilter', props: { selection_key: 'cohort_range', min: 90, max: 220, step: 5, initial: [140, 180], unit: 'mmHg', rows: '$bindings.latest.rows' } });
    expect(table).toMatchObject({ component: 'CohortTable', props: { range: '$ui.cohort_range', unit: 'mmHg' } });
    expect(m.primitives.map((p) => p.kind)).toEqual(['data.cohort.by_condition', 'data.cohort.latest_observation']); // no third request for the range

    // The compared value of the register is the systolic component: the same one the threshold flags.
    const latest = m.primitives.find((p) => p.kind === 'data.cohort.latest_observation')!;
    expect(latest.config).toMatchObject({ threshold: { component_code: '8480-6', value: 140 } });

    const audit: { kind: string }[] = [];
    await renderManifest(m, { context: {}, onAudit: (r) => audit.push(r) });
    const filter = await screen.findByTestId('range-filter', {}, { timeout: 4000 });
    expect(filter).toHaveTextContent('Systolic range');
    // The app opens on the configured range (shown by the slider, the card and the table's heading, which says how many members are in it).
    await screen.findByText('140–180 mmHg', { selector: '[data-testid="range-filter-value"]' }, { timeout: 4000 });
    const count = await screen.findByTestId('cohort-table-count');
    await screen.findByText(/140–180 mmHg/, { selector: '[data-testid="cohort-table-count"]' }, { timeout: 4000 });
    expect(count.textContent).toMatch(/^\d+ of \d+ patients · 140–180 mmHg$/);
    const [shown = -1, total = -1] = count.textContent!.match(/\d+/g)!.map(Number);
    expect(total).toBeGreaterThan(0);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown).toBeLessThanOrEqual(total);
    expect(screen.getByTestId('cohort-range-card')).toHaveTextContent(`${shown}`);
    expect(audit.filter((r) => r.kind.startsWith('data.cohort'))).toHaveLength(2); // the range costs no request
  });

  it('CKD register with renal imaging: the diagnosis cohort is narrowed by imaging before the values are read, the table names the studies and links to the imaging app', async () => {
    const m = reference('ckd-imaging-register', 'manifests/hsp-musterstadt');
    // Three steps, each over the previous one's members: diagnosis → with renal imaging → latest eGFR of exactly those.
    expect(m.primitives.map((p) => [p.kind, p.output_binding])).toEqual([
      ['data.cohort.by_condition', 'cohort'],
      ['data.cohort.with_imaging', 'imaging'],
      ['data.cohort.latest_observation', 'latest'],
    ]);
    expect(m.primitives[1]?.config).toEqual({ patients: '$bindings.cohort.patients', modalities: ['CT', 'US'] });
    expect(m.primitives[2]?.config).toMatchObject({ patients: '$bindings.imaging.patients' });
    expect(m.primitives[2]?.config).not.toHaveProperty('threshold'); // eGFR is shown, not flagged: lower is worse and the register has no "below"
    // The scope grants the imaging question both ways the deployment may answer it — and only the question: no wado.
    const scope = m.data_scopes['scope_nephrology_clinic']!;
    expect(scope.fhir?.find((e) => e.resource === 'ImagingStudy')).toEqual({ resource: 'ImagingStudy', operations: ['search'] });
    expect(scope.dicom).toEqual([{ operations: ['qido'], modalities: ['CT', 'US'] }]);
    expect(scope.patient_scope).toBe('cohort');
    const [grid, table] = m.layout.root.children ?? [];
    expect(grid?.children?.map((c) => (c.props as { label: string }).label)).toEqual(['Patients with chronic kidney disease', 'With renal imaging', 'Data scope']);
    expect(table).toMatchObject({ component: 'CohortTable', props: { rows: '$bindings.latest.rows', imaging: '$bindings.imaging.rows', open_in: 'app_imaging_3d' } });
    expect(m.audit?.data_categories).toEqual(['phi', 'clinical_measurements', 'imaging']);

    // On the synthetic record one patient has CKD (stage 3), with a CT of the abdomen and a renal ultrasound; the others are not asked about.
    const audit: { kind: string; result_summary?: string }[] = [];
    await renderManifest(m, { context: {}, onAudit: (r) => audit.push(r) });
    const members = await screen.findAllByTestId('cohort-member', {}, { timeout: 4000 });
    expect(members).toHaveLength(1);
    expect(members[0]).toHaveTextContent('Yıldız');
    expect(screen.getAllByTestId('cohort-study-count').map((td) => td.textContent)).toEqual(['2']);
    const studies = screen.getAllByTestId('cohort-latest-study').map((td) => td.textContent);
    expect(studies[0]).toMatch(/^\S+ · CT · CT Abdomen nativ/); // date · modality · description — the CT is the later study
    expect(screen.getAllByTestId('cohort-open-imaging').map((a) => a.getAttribute('href'))).toEqual(['/apps/app_imaging_3d?patient_id=pat-kms-0003']);
    expect(screen.getAllByTestId('stat-card').map((c) => c.textContent)).toEqual([
      expect.stringContaining('Patients with chronic kidney disease1'),
      expect.stringContaining('With renal imaging1'),
      expect.stringContaining('Data scope'),
    ]);
    expect(audit.filter((r) => r.kind.startsWith('data.cohort')).map((r) => r.kind)).toEqual(['data.cohort.by_condition', 'data.cohort.with_imaging', 'data.cohort.latest_observation']);
  });

  it('a register by diagnosis and imaging alone lists the members with their studies; one with neither is not ready', async () => {
    const register = spec('ckd-imaging-register') as AppSpec & { archetype: 'APP-09'; knobs: Record<string, unknown> };
    const { value: _value, ...withoutValue } = register.knobs as { value: unknown };
    const imagingOnly = { ...register, knobs: { ...withoutValue, imaging: { modalities: ['CT', 'US'], within: 'now-3y', min_studies: 2, label: 'two CT or ultrasound studies in three years' } } };
    expect(readiness(imagingOnly)).toEqual({ ready: true, missing: [] });
    const compiled = compileSpec(imagingOnly, { hospital_id: 'h', created_at: 't' });
    expect(compiled.ok, JSON.stringify(compiled, null, 1)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.manifest.primitives.map((p) => p.kind)).toEqual(['data.cohort.by_condition', 'data.cohort.with_imaging']);
    expect(compiled.manifest.primitives[1]?.config).toEqual({ patients: '$bindings.cohort.patients', modalities: ['CT', 'US'], since: 'now-3y', min_studies: 2 });
    expect(compiled.manifest.data_scopes['scope_nephrology_clinic']?.fhir?.map((e) => e.resource)).toEqual(['Patient', 'Condition', 'ImagingStudy']);
    expect(compiled.manifest.audit?.data_categories).toEqual(['phi', 'imaging']);
    const [grid, table] = compiled.manifest.layout.root.children ?? [];
    expect(grid?.children?.map((c) => (c.props as { label: string; hint?: string }).hint)).toContain('At least 2 CT or US studies, last three years');
    expect(table?.props).toEqual({ title: 'Patients with CKD and renal imaging', imaging: '$bindings.imaging.rows' }); // no value columns, no link without open_in

    // Fatma Yıldız: CT abdomen (Apr 2026) and renal ultrasound (Sep 2025), both within three years of the seed anchor.
    await renderManifest(compiled.manifest, { context: {} });
    const members = await screen.findAllByTestId('cohort-member', {}, { timeout: 4000 });
    expect(members).toHaveLength(1);
    expect(members[0]).toHaveTextContent('Yıldız');
    expect(screen.getByTestId('cohort-study-count')).toHaveTextContent('2');
    expect(screen.getByTestId('cohort-latest-study')).toHaveTextContent('CT · CT Abdomen nativ');
    expect(screen.queryByText('Latest eGFR')).toBeNull(); // no value columns without a value
    expect(screen.getByTestId('cohort-table-count')).toHaveTextContent('1 patients');

    const { imaging: _imaging, ...bare } = withoutValue as { imaging: unknown };
    const neither = { ...register, knobs: bare };
    expect(readiness(neither).missing).toEqual([{ path: 'knobs.value', message: 'give the observation shown per member (value), the imaging that narrows the cohort (imaging), or both' }]);
    const badModality = { ...register, knobs: { ...register.knobs, imaging: { modalities: ['ct scan'], label: 'a CT' } } };
    expect(readiness(badModality).ready).toBe(false);
  });

  it('Falls risk screen: a form designed in the spec becomes a Questionnaire the app carries, in the deployment\'s namespace, read by the same primitives', async () => {
    // The single-purpose form (APP-11), compiled as the showcase would be; the showcase itself ships the same form on a composed page (below).
    const compiledForm = compileSpec(spec('falls-risk-form'), { hospital_id: 'hsp-musterstadt', created_at: '2026-10-01T14:00:00Z' });
    expect(compiledForm.ok, JSON.stringify(compiledForm, null, 1)).toBe(true);
    if (!compiledForm.ok) return;
    const m = compiledForm.manifest;
    const q = m.artifacts?.questionnaires[0];
    expect(m.artifacts?.questionnaires).toHaveLength(1);
    // A FHIR id (letters, digits, - and .), the canonical URL under the hospital's namespace, the app's version.
    expect(q).toMatchObject({ resourceType: 'Questionnaire', id: 'app-falls-risk.falls-risk', url: 'https://hsp-musterstadt.medapp.eu/Questionnaire/app-falls-risk.falls-risk', version: '1.0.0', status: 'active', subjectType: ['Patient'], title: 'Falls risk screen', date: '2026-10-01T14:00:00Z' });
    // The clinician's vocabulary became FHIR's — with the renderer's two rules: a required yes/no is a Yes/No choice (a
    // required boolean would be a box that has to be ticked), a multiple choice carries the check-box control.
    const items = q!.item;
    expect(items.map((i) => [i.linkId, i.type])).toEqual([['intro', 'display'], ['history', 'group'], ['fall_details', 'group'], ['mobility', 'group'], ['risk_factors', 'group'], ['plan', 'text'], ['next_review', 'date']]);
    const history = items[1]!.item!;
    expect(history[0]).toEqual({ linkId: 'fell_last_year', text: 'Has the patient fallen in the last 12 months?', type: 'choice', required: true, answerOption: [{ valueCoding: { code: 'yes', display: 'Yes' } }, { valueCoding: { code: 'no', display: 'No' } }] });
    const fall = items[2]!.item!;
    expect(fall[1]!.answerOption!.map((o) => o.valueCoding.code)).toEqual(['none', 'minor', 'fracture', 'head_injury']); // given code kept, the others slugged from the display
    const mobility = items[3]!.item!;
    expect(mobility[1]).toEqual({ linkId: 'unsteady', text: 'Unsteady when standing or turning?', type: 'boolean' }); // optional yes/no: a tick box
    expect(mobility[2]).toEqual({
      linkId: 'timed_up_and_go',
      text: 'Timed up-and-go (s, 0–300)', // the unit and the range in the text: the renderer shows neither extension
      type: 'decimal',
      // The answer is also a measurement: the Observation code on the item, SDC's observationExtract marker beside the rest.
      code: [{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'tug', display: 'Timed up-and-go' }],
      extension: [
        { url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-unit', valueCoding: { display: 's' } },
        { url: 'http://hl7.org/fhir/StructureDefinition/minValue', valueDecimal: 0 },
        { url: 'http://hl7.org/fhir/StructureDefinition/maxValue', valueDecimal: 300 },
        { url: 'http://hl7.org/fhir/uv/sdc/StructureDefinition/sdc-questionnaire-observationExtract', valueBoolean: true },
      ],
    });
    // The whole "About the falls" section is asked only once there was a fall: the condition sits on the group and compares
    // the Yes/No choice's coding, since that is what a required yes/no compiles to; the questions inside carry none of their own.
    expect(items[2]).toMatchObject({ linkId: 'fall_details', text: 'About the falls', type: 'group', enableWhen: [{ question: 'fell_last_year', operator: '=', answerCoding: { code: 'yes' } }] });
    expect(fall[0]).toEqual({
      linkId: 'falls_count',
      text: 'How many falls? (0–20)',
      type: 'integer',
      extension: [
        { url: 'http://hl7.org/fhir/StructureDefinition/minValue', valueInteger: 0 },
        { url: 'http://hl7.org/fhir/StructureDefinition/maxValue', valueInteger: 20 },
      ],
    });
    expect(fall[1]!.enableWhen).toBeUndefined();
    expect(items[4]!.item![0]).toMatchObject({ type: 'choice', repeats: true, extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl', valueCodeableConcept: { coding: [{ code: 'check-box' }] } }] });
    // In German the required yes/no reads Ja/Nein.
    const german = compileSpec({ ...(spec('falls-risk-form') as AppSpec), app: { ...(spec('falls-risk-form') as AppSpec).app, language: 'de' } }, { hospital_id: 'hsp-test', created_at: 't' });
    expect(german.ok && german.manifest.artifacts?.questionnaires[0]?.item[1]?.item?.[0]?.answerOption?.map((o) => o.valueCoding.display)).toEqual(['Ja', 'Nein']);
    // The primitives read and write by the canonical URL — the dispatcher and the mock resolve it from the manifest, not the record.
    for (const p of m.primitives.filter((p) => p.kind !== 'data.fhir.patient.read')) expect(JSON.stringify(p.config)).toContain(q!.url);
    expect((m.layout.root.children?.[1]?.children?.[0]?.props as { submit_label?: string }).submit_label).toBe('Record screen');

    // What the readiness check says about a form that is not right.
    const base = spec('falls-risk-form') as AppSpec & { archetype: 'APP-11'; knobs: { form: { items: unknown[] } } };
    const withItems = (items: unknown[]) => ({ ...base, knobs: { ...base.knobs, form: { ...base.knobs.form, items } } });
    expect(readiness(withItems([{ id: 'a', text: 'A?', type: 'choice' }])).missing.map((i) => i.message)).toContain('a choice needs its options');
    expect(readiness(withItems([{ id: 'a', text: 'A', type: 'heading' }])).missing.map((i) => i.message)).toContain('a heading needs the questions under it');
    expect(readiness(withItems([{ id: 'a', text: 'A', type: 'note' }])).missing.map((i) => i.message)).toContain('the form has no question to answer — only headings and notes');
    expect(readiness(withItems([{ id: 'a', text: 'A?', type: 'boolean' }, { id: 'a', text: 'B?', type: 'boolean' }])).missing.map((i) => i.message)).toContain('"a" is used twice; every question needs its own id');
    expect(readiness(withItems([{ id: 'a', text: 'A?', type: 'text', unit: 'kg' }])).missing.map((i) => i.message)).toContain('a unit belongs to a number');
    // Round two: ranges, coded options and conditions — and what is wrong with them.
    const messages = (items: unknown[]) => readiness(withItems(items)).missing.map((i) => i.message);
    expect(messages([{ id: 'a', text: 'A?', type: 'text', min: 1 }])).toContain('a range (min/max) belongs to a number');
    expect(messages([{ id: 'a', text: 'A?', type: 'integer', min: 10, max: 5 }])).toContain('max (5) is below min (10)');
    expect(messages([{ id: 'a', text: 'A?', type: 'integer', min: 0.5 }])).toContain('an integer’s range is whole numbers');
    expect(messages([{ id: 'a', text: 'A?', type: 'choice', options: [{ display: 'Smoker', code: '77176002' }, { display: 'Never' }] }])).toContain('"77176002" is not a lowercase identifier; a code from a terminology needs its system (snomed, loinc, …)');
    expect(messages([{ id: 'a', text: 'A?', type: 'choice', options: [{ display: 'Smoker', system: 'snomed' }, { display: 'Never' }] }])).toContain('a coded option names its code in that system');
    expect(messages([{ id: 'a', text: 'A?', type: 'boolean' }, { id: 'b', text: 'B?', type: 'integer', show_when: { question: 'zzz', is: 1 } }])).toContain('no question "zzz" in this form');
    expect(messages([{ id: 'a', text: 'A?', type: 'boolean', show_when: { question: 'a', is: true } }])).toContain('a question cannot depend on its own answer');
    expect(messages([{ id: 'h', text: 'H', type: 'heading', items: [{ id: 'a', text: 'A?', type: 'boolean' }], show_when: { question: 'a', is: true } }])).toContain('"a" is inside this heading; a heading cannot depend on a question it hides');
    expect(messages([{ id: 'a', text: 'A?', type: 'boolean' }, { id: 'h', text: 'H', type: 'heading', items: [{ id: 'b', text: 'B?', type: 'text' }], show_when: { question: 'a', is: true } }, { id: 'n', text: 'Consider physio.', type: 'note', show_when: { question: 'a', is: true } }])).toEqual([]); // a whole section, or a note, may hinge on an answer
    expect(messages([{ id: 'a', text: 'A?', type: 'boolean' }, { id: 'b', text: 'B?', type: 'integer', show_when: { question: 'a', is: 'yes' } }])).toContain('"a" is a yes/no: compare with true or false');
    expect(messages([{ id: 'a', text: 'A?', type: 'boolean' }, { id: 'b', text: 'B?', type: 'integer', show_when: { question: 'a', is: true, is_not: false } }])).toContain('one condition: is, is_not, answered, at_least or at_most');
    expect(messages([{ id: 'a', text: 'A?', type: 'choice', options: [{ display: 'Stick' }, { display: 'Frame' }] }, { id: 'b', text: 'B?', type: 'text', show_when: { question: 'a', is: 'wheelchair' } }])).toContain('"wheelchair" is not an option of "a"');
    expect(messages([{ id: 'a', text: 'A?', type: 'text' }, { id: 'b', text: 'B?', type: 'text', show_when: { question: 'a', at_least: 3 } }])).toContain('"a" is not a number');
    // …and how they compile: a coded option lands on the record as that coding; conditions are typed after the question they look at.
    const compiled = compileSpec(
      withItems([
        { id: 'smokes', text: 'Smoking status', type: 'choice', options: [{ display: 'Smoker', code: '77176002', system: 'snomed' }, { display: 'Never smoked', code: '266919005', system: 'snomed' }] },
        { id: 'per_day', text: 'Cigarettes per day', type: 'integer', min: 1, max: 100, show_when: { question: 'smokes', is: '77176002' } },
        { id: 'unsteady', text: 'Unsteady?', type: 'boolean' },
        { id: 'aid', text: 'Which aid?', type: 'text', show_when: [{ question: 'unsteady', is: true }, { question: 'per_day', at_least: 10 }] },
        { id: 'note', text: 'Anything else?', type: 'long_text', show_when: { question: 'aid', answered: true } },
        { id: 'heavy', text: 'Heavy smoker', type: 'heading', show_when: { question: 'per_day', at_least: 20 }, items: [{ id: 'quit_plan', text: 'Quit plan discussed?', type: 'boolean' }] },
      ]),
      { hospital_id: 'hsp-test', created_at: 't' }
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    const r2 = compiled.manifest.artifacts!.questionnaires[0]!.item;
    expect(r2[0]!.answerOption).toEqual([{ valueCoding: { system: 'http://snomed.info/sct', code: '77176002', display: 'Smoker' } }, { valueCoding: { system: 'http://snomed.info/sct', code: '266919005', display: 'Never smoked' } }]);
    expect(r2[1]!.enableWhen).toEqual([{ question: 'smokes', operator: '=', answerCoding: { system: 'http://snomed.info/sct', code: '77176002' } }]);
    expect(r2[1]!.text).toBe('Cigarettes per day (1–100)');
    expect(r2[3]!.enableWhen).toEqual([{ question: 'unsteady', operator: '=', answerBoolean: true }, { question: 'per_day', operator: '>=', answerInteger: 10 }]);
    expect(r2[3]!.enableBehavior).toBe('all');
    expect(r2[4]!.enableWhen).toEqual([{ question: 'aid', operator: 'exists', answerBoolean: true }]);
    expect(r2[5]).toMatchObject({ type: 'group', enableWhen: [{ question: 'per_day', operator: '>=', answerInteger: 20 }], item: [{ linkId: 'quit_plan', type: 'boolean' }] }); // the section hides as one
    // The manifest side keeps the same rule for a hand-written or tampered artifact: a group cannot hinge on what it hides.
    const circular = QuestionnaireArtifactSchema.safeParse({ ...compiled.manifest.artifacts!.questionnaires[0]!, item: [{ linkId: 'g', text: 'G', type: 'group', enableWhen: [{ question: 'x', operator: 'exists', answerBoolean: true }], item: [{ linkId: 'x', text: 'X?', type: 'boolean' }] }] });
    expect(!circular.success && circular.error.issues.map((i) => i.message)).toEqual(['enableWhen looks at "x", which is inside the group it would hide']);
    expect(readiness({ ...base, knobs: { ...base.knobs, questionnaire: 'https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup' } }).missing.map((i) => i.message)).toContain('either a Questionnaire of the record or a form designed here, not both');
    const { form: _f, ...noForm } = base.knobs as { form: unknown };
    expect(readiness({ ...base, knobs: noForm }).missing.map((i) => i.message)).toContain('name a Questionnaire the record holds (questionnaire), or design the form here (form)');

    // The same form compiles to the same bytes; a deployment may name its own namespace.
    const once = compileSpec(spec('falls-risk-form'), { hospital_id: 'hsp-test', created_at: 't' });
    const twice = compileSpec(spec('falls-risk-form'), { hospital_id: 'hsp-test', created_at: 't' });
    expect(once.ok && twice.ok && JSON.stringify(once.manifest) === JSON.stringify(twice.manifest)).toBe(true);
    const named = compileSpec(spec('falls-risk-form'), { hospital_id: 'hsp-test', created_at: 't', questionnaire_base: 'https://klinikum-musterstadt.example/fhir/Questionnaire/' });
    expect(named.ok && named.manifest.artifacts?.questionnaires[0]?.url).toBe('https://klinikum-musterstadt.example/fhir/Questionnaire/app-falls-risk.falls-risk');

    // The showcase ships that form on a composed page: the same Questionnaire (same id, URL, items), and the chart and the
    // last-screen block read its answers by the same canonical — the form designed here is the data those sections draw.
    const showcase = reference('falls-risk-assessment', 'manifests/hsp-musterstadt');
    expect(showcase.artifacts?.questionnaires).toHaveLength(1);
    expect(showcase.artifacts?.questionnaires[0]).toEqual(q);
    expect(showcase.primitives.find((p) => p.kind === 'data.fhir.questionnaire_response.answers')?.config).toMatchObject({ questionnaire: q!.url, link_ids: ['timed_up_and_go'] });
    expect(showcase.primitives.filter((p) => p.kind === 'data.fhir.query' && (p.config as { resource: string }).resource === 'QuestionnaireResponse').every((p) => JSON.stringify(p.config).includes(q!.url))).toBe(true);
    // On the synthetic record Anneliese has three screens under that very URL: the chart draws them, the last one shows in full.
    await renderManifest(showcase, { context: { patient_id: 'pat-kms-0001' } });
    expect((await screen.findAllByText('3 data points · s', { exact: false }, { timeout: 4000 })).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reference lines: Shumway-Cook', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('latest-answers')).toHaveTextContent('Walking aid in use');
  });

  it('panel rules: stated ones are checked against the components; a single-value form has none; another panel gets no default', () => {
    const base = spec('composed-ward-entry') as AppSpec & { archetype: 'APP-12'; knobs: { sections: Record<string, unknown>[] } };
    const entry = base.knobs.sections.find((s) => s.kind === 'record_observation') as Record<string, unknown> & { components: { code: { system: string; code: string }; label: string }[] };
    const withRules = (rules: unknown, patch: Record<string, unknown> = {}) => ({ ...base, knobs: { ...base.knobs, sections: base.knobs.sections.map((s) => (s === entry ? { ...entry, ...patch, rules } : s)) } });
    expect(readiness(withRules([{ component: { system: 'loinc', code: '8480-6' }, above: { system: 'loinc', code: '9999-9' } }])).missing.map((i) => i.message)).toContain('http://loinc.org|9999-9 is not a component of this panel');
    expect(readiness(withRules([{ component: { system: 'loinc', code: '8480-6' }, above: { system: 'loinc', code: '8480-6' } }])).missing.map((i) => i.message)).toContain('a component cannot be above itself');
    expect(readiness(withRules([{ component: { system: 'loinc', code: '8480-6' }, above: { system: 'loinc', code: '8462-4' } }], { components: undefined, code: { system: 'loinc', code: '29463-7', display: 'Body weight' }, unit: 'kg', range: { min: 20, max: 300 } })).missing.map((i) => i.message)).toContain('rules relate the components of a panel; this form records a single value');
    // A stated rule is taken as given (and named by the labels); a panel the compiler does not know gets no rule of its own.
    const stated = compileSpec(withRules([{ component: { system: 'loinc', code: '8462-4' }, above: { system: 'loinc', code: '8480-6' } }]), { hospital_id: 'h', created_at: 't' });
    expect(stated.ok && (stated.manifest.primitives.find((p) => p.id === 'p_bp_entry')!.config as { rules: unknown }).rules).toEqual([{ component: 'http://loinc.org|8462-4', above: 'http://loinc.org|8480-6', message: 'Diastolic must be above systolic' }]);
    const other = compileSpec(withRules(undefined, { code: { system: 'loinc', code: '55284-4', display: 'Blood pressure systolic and diastolic' } }), { hospital_id: 'h', created_at: 't' });
    expect(other.ok && (other.manifest.primitives.find((p) => p.id === 'p_bp_entry')!.config as { rules?: unknown }).rules).toBeUndefined();
  });

  it('a range that contradicts itself is an authoring problem the readiness check names', () => {
    const register = spec('hypertension-register') as AppSpec & { archetype: 'APP-09' };
    const upsideDown = { ...register, knobs: { ...register.knobs, value: { ...register.knobs.value, range: { min: 200, max: 100 } } } };
    expect(readiness(upsideDown).missing).toEqual([{ path: 'knobs.value.range.max', message: 'the upper bound must be above the lower bound' }]);
    const outside = { ...register, knobs: { ...register.knobs, value: { ...register.knobs.value, range: { min: 90, max: 220, default: [80, 230] } } } };
    expect(readiness(outside).missing.map((m) => m.path)).toEqual(['knobs.value.range.default', 'knobs.value.range.default']);
    const fine = { ...register, knobs: { ...register.knobs, value: { ...register.knobs.value, range: { step: 5 } } } }; // bounds from the data
    expect(readiness(fine)).toEqual({ ready: true, missing: [] });
    const compiled = compileSpec(fine, { hospital_id: 'h', created_at: 't' });
    expect(compiled.ok && (compiled.manifest.layout.root.children ?? [])[1]).toMatchObject({ component: 'RangeFilter', props: { step: 5, rows: '$bindings.latest.rows' } });
  });

  it('Patient 360: the senior clinician sees the FHIR record, the treating clinician does not; both roles request their own scope; no viewer here', async () => {
    const m = reference('patient-360', 'manifests/hsp-musterstadt');
    expect(m.lifecycle.state).toBe('published');
    expect(m.auth.roles.map((r) => r.id)).toEqual(['clinician', 'senior_clinician']);
    expect(m.data_scopes['scope_clinician']?.dicom).toBeUndefined();
    expect(m.data_scopes['scope_senior_clinician']?.dicom).toBeUndefined(); // imaging lives in the tumour board and the imaging review
    expect(m.data_scopes['scope_senior_clinician']?.phi_fields_visible).toContain('address'); // the wider identity is what the senior role adds
    const rows = m.layout.root.children ?? [];
    const gated = rows.filter((r) => r.show_only_if_role_in?.includes('senior_clinician'));
    expect(gated).toHaveLength(1); // the Patient resource, a row of its own
    expect(rows.length).toBeGreaterThanOrEqual(8); // banner, tiles, 6+6, 8+4, 6+6, 6+6, 6+6, labs, details

    await renderManifest(m, { role: 'clinician', context: { patient_id: 'pat-kms-0001' } });
    expect(screen.queryByText('Imaging studies')).toBeNull();
    expect(screen.queryByText('Patient record (FHIR)')).toBeNull();
    await renderManifest(m, { role: 'senior_clinician', context: { patient_id: 'pat-kms-0001' } });
    await screen.findByText('Patient record (FHIR)');
    expect(screen.queryByText('Imaging studies')).toBeNull();
  });

  it('Cardio-renal follow-up: the nurse records, the physician resolves and stops — each on their own rows, as a workflow app', async () => {
    const m = reference('cardio-renal-follow-up', 'manifests/hsp-musterstadt');
    expect(m.metadata.intent_class).toBe('workflow');
    // The blood pressure panel carries systolic-above-diastolic without the author stating it — on the write (the dispatcher
    // enforces it) and on the form (the browser refuses before sending), named as the components are labelled.
    const bp = m.primitives.find((p) => p.id === 'p_bp_entry')!;
    expect((bp.config as { rules?: unknown }).rules).toEqual([{ component: 'http://loinc.org|8480-6', above: 'http://loinc.org|8462-4', message: 'Systolic must be above diastolic' }]);
    expect(JSON.stringify(m.layout)).toContain('"rules":[{"component":"http://loinc.org|8480-6","above":"http://loinc.org|8462-4","message":"Systolic must be above diastolic"}]');
    expect(m.actions?.map((a) => a.id).sort()).toEqual(['record_bp_entry', 'resolve_problems', 'stop_medication']);
    const fhirScope = (role: string) => m.data_scopes[`scope_${role}`]?.fhir ?? [];
    expect(fhirScope('ward_nurse').some((e) => e.resource === 'Observation' && e.operations.includes('create'))).toBe(true);
    expect(fhirScope('physician').some((e) => e.resource === 'Condition' && e.operations.includes('update'))).toBe(true);
    expect(fhirScope('physician').some((e) => e.resource === 'Observation' && e.operations.includes('create'))).toBe(false);
    await renderManifest(m, { role: 'ward_nurse', context: { patient_id: 'pat-kms-0001' } });
    await screen.findByText('Record a blood pressure');
    expect(screen.queryByText('Mark resolved')).toBeNull();
  });

  it('Imaging review (3D) opens studies as a volume; the register names the diagnosis in both codings', () => {
    const imaging = reference('imaging-review-3d', 'manifests/hsp-musterstadt');
    const viewer = JSON.stringify(imaging.layout);
    expect(viewer).toContain('"layout":"volume"');
    const register = reference('hypertension-register', 'manifests/hsp-musterstadt');
    const codes = JSON.stringify(register.primitives.find((p) => p.id === 'p_cohort')?.config);
    expect(codes).toContain('http://snomed.info/sct|38341003');
    expect(codes).toContain('http://fhir.de/CodeSystem/bfarm/icd-10-gm|I10.90');
  });
});

describe('disease dashboard templates', () => {
  it('match the catalog (docs/application-catalog.yaml APP-06 templates)', async () => {
    const { DISEASE_TEMPLATES } = await import('../spec/archetypes/diseaseDashboard');
    const catalog = read('../../docs/application-catalog.yaml') as { archetypes: { id: string; templates?: { id: string; series: unknown[]; observation_codes: string[]; thresholds: unknown[]; source: string; medication_codes: string[]; condition_codes: string[] }[] }[] };
    const app06 = catalog.archetypes.find((a) => a.id === 'APP-06');
    expect(app06?.templates?.map((t) => t.id).sort()).toEqual(Object.keys(DISEASE_TEMPLATES).sort());
    for (const t of app06?.templates ?? []) {
      const ours = DISEASE_TEMPLATES[t.id as keyof typeof DISEASE_TEMPLATES];
      expect(ours.codes.map((c) => c.code)).toEqual(t.observation_codes);
      expect(ours.series).toEqual(t.series);
      expect(ours.thresholds).toEqual(t.thresholds);
      expect(ours.source).toBe(t.source);
      expect(ours.medication_codes.map((c) => c.code)).toEqual(t.medication_codes);
      expect(ours.condition_codes.map((c) => c.code)).toEqual(t.condition_codes);
    }
  });

  it('a template fills the clinical knobs; explicit knobs win; without either the draft stays open', async () => {
    const { resolveTemplate, DiseaseDashboardKnobsSchema } = await import('../spec/archetypes/diseaseDashboard');
    const fromTemplate = resolveTemplate(DiseaseDashboardKnobsSchema.parse({ template: 'diabetes_follow_up' }));
    expect(fromTemplate.series).toEqual([{ label: 'HbA1c', code: '4548-4' }]);
    expect(fromTemplate.medication_codes.map((c) => c.code)).toEqual(['A10B', 'A10A']); // ATC classes, not named drugs
    expect(fromTemplate.condition_codes.map((c) => `${c.system}|${c.code}`)).toEqual(['snomed|44054006', 'icd10gm|E11']); // both codings: the synthetic record's and the hospital's
    expect(fromTemplate.source).toContain('ADA');
    const overridden = resolveTemplate(DiseaseDashboardKnobsSchema.parse({ template: 'diabetes_follow_up', thresholds: [{ value: 6.5, label: 'Tight target' }], medication: { codes: [] } }));
    expect(overridden.thresholds).toEqual([{ value: 6.5, label: 'Tight target' }]);
    expect(overridden.source).toBeUndefined(); // own lines, no borrowed guideline under them
    expect(overridden.medication_codes).toEqual([]); // explicit empty list = every active medication
    const bare = readiness({ ...(spec('hypertension-dashboard') as object), knobs: { window: 'now-1y' } });
    expect(bare.ready).toBe(false);
    expect(bare.missing.map((m) => m.path)).toEqual(['knobs.codes', 'knobs.series']);
  });
});

describe('composed page (APP-12) — sections are the closed vocabulary, the layout follows the spans', () => {
  const base = spec('composed-consultation') as AppSpec & { archetype: 'APP-12'; knobs: { sections: Record<string, unknown>[] } };
  const compile = (input: unknown) => compileSpec(input, { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });

  it("charts a form's answers: a form designed in the same spec is named by its id and resolves to the app's own canonical; a form elsewhere by URL", () => {
    const falls = (spec('falls-risk-form') as AppSpec & { knobs: { form: unknown } }).knobs.form;
    const withForm = {
      ...base,
      knobs: {
        ...base.knobs,
        sections: [
          { kind: 'assessment', id: 'screen', span: 6, form: falls },
          { kind: 'form_trend', id: 'tug', span: 6, form: 'falls_risk', questions: [{ link_id: 'timed_up_and_go', label: 'TUG' }] },
          { kind: 'latest_answers', id: 'last', span: 12, form: 'falls_risk' },
        ],
      },
    };
    const result = compile(withForm);
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    const url = 'https://hsp-test.medapp.eu/Questionnaire/app-htn-consultation.falls-risk';
    expect(result.manifest.artifacts?.questionnaires[0]?.url).toBe(url);
    expect(result.manifest.primitives.find((p) => p.id === 'p_tug')).toMatchObject({ kind: 'data.fhir.questionnaire_response.answers', config: { questionnaire: url, link_ids: ['timed_up_and_go'] } });
    expect(result.manifest.primitives.find((p) => p.id === 'p_last')).toMatchObject({ kind: 'data.fhir.query', config: { resource: 'QuestionnaireResponse', params: { questionnaire: url } } });
    const scope = result.manifest.data_scopes[result.manifest.auth.roles[0]!.data_scope_ref]!;
    expect(scope.fhir?.find((e) => e.resource === 'QuestionnaireResponse')?.operations).toEqual(['search', 'create']);
    expect(scope.fhir?.find((e) => e.resource === 'Questionnaire')?.operations).toEqual(['read']);
    // What is refused: no form named, both named, a form this spec does not design, a question twice.
    const messages = (sections: unknown[]) => readiness({ ...base, knobs: { ...base.knobs, sections } }).missing.map((m) => m.message);
    expect(messages([{ kind: 'form_trend', questions: [{ link_id: 'a', label: 'A' }] }])).toContain('name the form: a Questionnaire the record holds (questionnaire), or a form designed in this spec (form)');
    expect(messages([{ kind: 'latest_answers', questionnaire: 'https://x/Questionnaire/y', form: 'falls_risk' }])).toContain('either a Questionnaire of the record or a form designed here, not both');
    expect(messages([{ kind: 'latest_answers', form: 'nope' }])).toContain('no form "nope" is designed in this spec — an assessment section\'s form.id');
    expect(messages([{ kind: 'form_trend', questionnaire: 'https://x/Questionnaire/y', questions: [{ link_id: 'a', label: 'A' }, { link_id: 'a', label: 'B' }] }])).toContain('each question at most once');
  });

  it('packs consecutive sections into rows while their spans fit, and gives a gated section a row of its own', async () => {
    const { packRows } = await import('../spec/archetypes/composed');
    const spans = (rows: { span: number }[][]) => rows.map((r) => r.map((s) => s.span));
    expect(spans(packRows([{ span: 8 }, { span: 4 }, { span: 6 }, { span: 6 }, { span: 12 }]))).toEqual([[8, 4], [6, 6], [12]]);
    expect(spans(packRows([{ span: 4 }, { span: 4 }, { span: 4 }, { span: 8 }, { span: 8 }]))).toEqual([[4, 4, 4], [8], [8]]);
    expect(spans(packRows([{ span: 6 }, { span: 12 }, { span: 6 }]))).toEqual([[6], [12], [6]]);

    const result = compile(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.manifest.layout.root.children ?? [];
    expect(rows.map((r) => r.component)).toEqual(['PatientBanner', 'TwoColumn', 'TwoColumn', 'TwoColumn']);
    expect(rows[1]?.props?.['ratio']).toEqual([8, 4]);
    expect(rows[2]?.props?.['ratio']).toEqual([6, 6]);
    // The imaging section is gated to reviewers: its own row, its own primitive gate, and only the reviewer's scope carries DICOM.
    expect(rows[3]?.show_only_if_role_in).toEqual(['reviewer']);
    expect(result.manifest.primitives.find((p) => p.id === 'p_imaging')?.only_for_roles).toEqual(['reviewer']);
    expect(result.manifest.data_scopes['scope_viewer']?.dicom).toBeUndefined();
    expect(result.manifest.data_scopes['scope_reviewer']?.dicom?.[0]?.modalities).toEqual(['CT', 'MR', 'US']);
  });

  it('derives section ids from the kind, numbers repeats, and refuses clashes and unknown roles as open points', () => {
    const twice = { ...base, knobs: { ...base.knobs, sections: [{ kind: 'problems' }, { kind: 'problems', status: 'all' }] } };
    const r = compile(twice);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.primitives.map((p) => p.id)).toEqual(['p_patient', 'p_problems', 'p_problems_2']);

    const clash = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'problems', id: 'x' }, { kind: 'medication', id: 'x' }] } });
    expect(clash.missing).toEqual([{ path: 'knobs.sections.1.id', message: 'two sections are called "x" — give one of them its own id' }]);

    const ghost = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'problems', roles: ['ghost'] }] } });
    expect(ghost.missing).toEqual([{ path: 'knobs.sections.0.roles.0', message: '"ghost" is not a declared role' }]);

    const reserved = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'details', id: 'patient', resource: 'Encounter' }] } });
    expect(reserved.missing.map((m) => m.message)).toContain('"patient" is the patient record itself — give the section another id');

    // A half-filled section is an open point, not a rejection — the checklist names the field.
    const open = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'trend' }] } });
    expect(open.ready).toBe(false);
    expect(open.missing.map((m) => `${m.path}: ${m.message}`)).toEqual(['knobs.sections.0.codes: is required', 'knobs.sections.0.series: is required']);
  });

  it('the record sections each query their own resource type with the derived scope, and the generic list carries its columns', () => {
    const result = compile(spec('composed-record-review'));
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    const byId = Object.fromEntries(m.primitives.map((p) => [p.id, p]));
    expect(byId['p_allergies']?.config).toEqual({ resource: 'AllergyIntolerance', params: { patient: '$context.patient_id', 'clinical-status': 'active' } });
    expect(byId['p_notes']?.config).toEqual({ resource: 'DocumentReference', params: { patient: '$context.patient_id' } });
    expect(byId['p_labs']?.config).toEqual({ resource: 'Observation', params: { patient: '$context.patient_id', category: 'laboratory' } });
    const scope = m.data_scopes['scope_ward_clinician'];
    expect(scope?.fhir?.map((e) => e.resource).sort()).toEqual(['AllergyIntolerance', 'DiagnosticReport', 'DocumentReference', 'Encounter', 'Immunization', 'Observation', 'Patient', 'Procedure']);
    expect(m.audit?.data_categories).toEqual(['phi', 'clinical_measurements', 'allergies', 'encounters', 'procedures', 'immunizations', 'clinical_documentation']);
    const rows = m.layout.root.children ?? [];
    expect(rows.map((r) => r.component)).toEqual(['PatientBanner', 'AllergyList', 'TwoColumn', 'DocumentList', 'TwoColumn', 'ResourceList']);
    const labs = rows[5];
    expect(labs?.props?.['columns']).toEqual([
      { label: 'Date', path: 'effectiveDateTime' },
      { label: 'Test', path: 'code' },
      { label: 'Result', path: 'valueQuantity' },
      { label: 'Status', path: 'status', status: true },
    ]);
    // A `list` may not smuggle a patient in, and a bad field path is refused by the schema itself.
    const smuggled = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'list', resource: 'Encounter', params: { patient: 'x' }, columns: [{ label: 'Date', path: 'period.start' }] }] } });
    expect(smuggled.missing.map((m) => m.message)).toContain('the patient is the launch context; do not set it as a parameter');
    const badPath = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'list', resource: 'Encounter', columns: [{ label: 'Date', path: 'period..start' }] }] } });
    expect(badPath.ready).toBe(false);
    expect(badPath.missing.some((m) => m.path === 'knobs.sections.0.columns.0.path')).toBe(true);
  });

  it('write sections derive create/update scopes with a Provenance grant, and each write is an action', () => {
    const result = compile(spec('composed-ward-entry'));
    expect(result.ok, JSON.stringify(result, null, 1)).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.metadata.intent_class).toBe('workflow');
    expect(m.actions.map((a) => [a.id, a.primitive])).toEqual([
      ['record_bp_entry', 'p_bp_entry'],
      ['resolve_problems', 'p_problems_resolve'],
      ['stop_medication', 'p_medication_stop'],
    ]);
    const scope = m.data_scopes['scope_ward_nurse']!;
    const ops = Object.fromEntries((scope.fhir ?? []).map((e) => [e.resource, [...e.operations].sort()]));
    expect(ops).toEqual({ Patient: ['read'], Observation: ['create', 'search'], Provenance: ['create'], Condition: ['search', 'update'], MedicationRequest: ['search', 'update'] });
    const entry = m.primitives.find((p) => p.id === 'p_bp_entry')!;
    expect(entry.kind).toBe('write.fhir.observation.create');
    expect(entry.config).toMatchObject({ codes: ['http://loinc.org|85354-9'], components: ['http://loinc.org|8480-6', 'http://loinc.org|8462-4'], unit: 'mmHg', observation: '$ui.bp_entry_entry' });
    const form = m.layout.root.children?.[1]?.children?.[0];
    expect(form?.component).toBe('ObservationEntryForm');
    expect(form?.props?.['components']).toEqual([
      { code: { system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }, label: 'Systolic', range: { min: 50, max: 300 } },
      { code: { system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }, label: 'Diastolic', range: { min: 30, max: 200 } },
    ]);
    const problems = m.layout.root.children?.[2]?.children?.[0];
    expect(problems?.props).toMatchObject({ resolve_action: 'resolve_problems', state_key: 'problems_resolve' });
    // A range that is upside down, or given on a panel, is a spec problem.
    const upside = readiness({ ...base, knobs: { ...base.knobs, sections: [{ kind: 'record_observation', code: { system: 'loinc', code: '29463-7' }, unit: 'kg', range: { min: 300, max: 2 } }] } });
    expect(upside.ready).toBe(false);
  });

  it('becomes a workflow app when a section writes, and gates a tab away from roles that may not see it', async () => {
    const result = compile(spec('composed-nurse-visit'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.manifest;
    expect(m.metadata.intent_class).toBe('workflow');
    expect(m.actions.map((a) => a.id)).toEqual(['submit_assessment']);
    expect(m.data_scopes['scope_nurse']?.fhir?.find((e) => e.resource === 'QuestionnaireResponse')?.operations).toEqual(['search', 'create']);

    const nurse = await renderManifest(m, { role: 'nurse' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Assessment']);
    nurse.unmount();
    await renderManifest(m, { role: 'lead_nurse' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Assessment', 'Record']);
  });
});
