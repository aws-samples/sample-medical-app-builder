import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ImagingStudy, QuestionnaireResponse } from '@medplum/fhirtypes';
import { loadRegistry, parseManifestSource } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';
import { resolveEffectiveScope } from '../manifest/roles';
import type { AppManifest } from '../manifest/schema';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { SEED, SEED_ANCHOR } from '../primitives/data/mock/seed';
import type { AuditRecord } from '../primitives/data/types';
import type { Diagnostic } from '../renderer/expressions';
import { reconstructable, viewerUrl, volumeSeriesUid } from '../primitives/ui/Imaging';
import { renderManifest, testConfig } from './testUtils';

const registry = loadFixtureRegistry();
const valid = registry.filter((e): e is Extract<(typeof registry)[number], { ok: true }> => e.ok);
const byId = (id: string): AppManifest => {
  const m = valid.find((e) => e.manifest.metadata.app_id === id)?.manifest;
  if (!m) throw new Error(`manifest ${id} missing`);
  return m;
};

describe('registry', () => {
  it('the bundled registry is the showcase set: every manifest valid and published, nothing in draft or review', () => {
    const bundled = loadRegistry();
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.filter((e) => !e.ok)).toEqual([]);
    const states = bundled.map((e) => (e.ok ? `${e.file}: ${e.manifest.lifecycle.state}` : e.file));
    expect(states.every((s) => s.endsWith(': published')), states.join(', ')).toBe(true);
    expect(bundled.every((e) => e.ok && e.manifest.lifecycle.signoff !== null)).toBe(true);
  });

  it('loads every reference fixture and rejects exactly the intentionally broken one', () => {
    expect(valid.map((e) => e.file).sort()).toEqual(['bp-trend.yaml', 'dicom-study-review.yaml', 'htn-assessment.yaml', 'hypertension-cohort.yaml', 'patient-summary.yaml']);
    const rejected = registry.filter((e) => !e.ok);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.file).toBe('rejected-example.yaml');
    const messages = rejected[0] && !rejected[0].ok ? rejected[0].issues.map((i) => `${i.path}: ${i.message}`) : [];
    expect(messages.some((m) => m.startsWith('metadata.version'))).toBe(true);
    expect(messages.some((m) => m.includes('default_role'))).toBe(true);
    expect(messages.some((m) => m.includes('scope_missing'))).toBe(true);
    expect(messages.some((m) => m.startsWith('layout.root') && /unrecognized|Unrecognized/i.test(m))).toBe(true);
  });

  it('refuses a manifest with a role gate on an unknown role', () => {
    const src = `
apiVersion: medapp.eu/v1
kind: AppManifest
metadata: { app_id: x, version: 0.0.1, name: X, intent_class: viewer, hospital_id: h }
lifecycle: { state: draft }
auth:
  roles: [{ id: viewer, display_name: V, cognito_group: g, data_scope_ref: s }]
  default_role: viewer
data_scopes: { s: { fhir: [{ resource: Patient, operations: [read] }] } }
primitives: []
layout:
  design_system_version: 1.0.0
  root: { component: PageShell, show_only_if_role_in: [admin] }
`;
    const entry = parseManifestSource('inline.yaml', src);
    expect(entry.ok).toBe(false);
    if (!entry.ok) expect(entry.issues.some((i) => i.message.includes('unknown role "admin"'))).toBe(true);
  });
});

describe('rendering from manifests (mock data plane)', () => {
  it('patient summary: Medplum PatientHeader, tabs, problem list and schema-driven ResourceTable', async () => {
    const audit: AuditRecord[] = [];
    await renderManifest(byId('app_patient_summary'), { onAudit: (r) => audit.push(r) });

    await screen.findByRole('heading', { name: 'Patient summary' });
    expect(await screen.findByTestId('medplum-patient-header')).toHaveTextContent('Krüger');
    // Problems tab is the default
    expect(await screen.findByText('Hypertensive disorder')).toBeInTheDocument();
    expect(screen.getByText('Type 2 diabetes mellitus')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Medication' }));
    expect(await screen.findByText('Amlodipin 5 mg')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Vitals & labs' }));
    // BP panel rendered as components, smoking status rendered as a CodeableConcept, HbA1c as a Quantity.
    expect(await screen.findByText('Former smoker')).toBeInTheDocument();
    expect(screen.getAllByText(/mmHg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Hemoglobin A1c/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'FHIR record' }));
    const details = await screen.findByText('Patient resource');
    expect(details).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/KMS-0048213/).length).toBeGreaterThan(0));

    expect(audit.map((a) => a.primitive_id)).toEqual(['p_patient', 'p_conditions', 'p_medications', 'p_vitals']);
    expect(audit.every((a) => a.outcome === 'ok' && a.patient_context === 'pat-kms-0001')).toBe(true);
  });

  it('bp trend as viewer: PHI masked per scope, reviewer section hidden, Condition primitive never runs', async () => {
    const audit: AuditRecord[] = [];
    const diagnostics: Diagnostic[] = [];
    await renderManifest(byId('app_bp_trend'), { role: 'viewer', onAudit: (r) => audit.push(r), onDiagnostic: (d) => diagnostics.push(d) });

    const banner = await screen.findByTestId('patient-banner');
    expect(banner).toHaveTextContent('Anneliese Krüger');
    expect(banner).toHaveTextContent('MRN KMS-0048213');
    // Fields the reviewer role may see are announced as hidden; email, which no role sees, is simply absent.
    expect(within(banner).getByText('Address hidden')).toBeInTheDocument();
    expect(within(banner).getByText('Phone hidden')).toBeInTheDocument();
    expect(within(banner).getByText('Gender hidden')).toBeInTheDocument();
    expect(within(banner).queryByText('Email hidden')).toBeNull();
    expect(within(banner).queryByText(/Lindenweg/)).toBeNull();
    expect(within(banner).queryByText('female')).toBeNull();

    const timeline = await screen.findByTestId('observation-timeline');
    expect(timeline).toHaveTextContent('24 data points');
    expect(screen.queryByText('Reviewer context')).toBeNull();
    expect(audit.map((a) => a.primitive_id)).toEqual(['p_patient', 'p_series']);
    // The hidden reviewer section references `$bindings.conditions`, which this role never loads: not resolved, not reported.
    await waitFor(() => expect(screen.queryAllByTestId('pending-node')).toHaveLength(0));
    expect(diagnostics).toEqual([]);
  });

  it('bp trend as reviewer: address visible, reviewer section and conditions present', async () => {
    const audit: AuditRecord[] = [];
    await renderManifest(byId('app_bp_trend'), { role: 'reviewer', onAudit: (r) => audit.push(r) });

    const banner = await screen.findByTestId('patient-banner');
    expect(banner).toHaveTextContent('Lindenweg 12');
    expect(banner).toHaveTextContent('female');
    expect(within(banner).queryByText(/hidden/)).toBeNull(); // the reviewer sees everything any role of this app sees
    expect(await screen.findByText('Reviewer context')).toBeInTheDocument();
    expect(await screen.findByText('Osteoarthritis of knee')).toBeInTheDocument();
    expect(audit.map((a) => a.primitive_id)).toEqual(['p_patient', 'p_series', 'p_conditions']);
  });

  it('patient banner: a field no role of the app may see is omitted, not announced', async () => {
    // Same viewer scope as bp-trend, but the reviewer role removed: address/phone/gender are not part of this app at all.
    const base = byId('app_bp_trend');
    const singleRole: AppManifest = { ...base, auth: { ...base.auth, roles: base.auth.roles.filter((r) => r.id === 'viewer') } };
    await renderManifest(singleRole, { role: 'viewer' });
    const banner = await screen.findByTestId('patient-banner');
    expect(banner).toHaveTextContent('Anneliese Krüger');
    expect(within(banner).queryByText(/hidden/)).toBeNull();
    expect(within(banner).queryByText(/Lindenweg/)).toBeNull();
  });

  it('dicom review: study list drives the viewer through $ui state', async () => {
    const diagnostics: Diagnostic[] = [];
    await renderManifest(byId('app_dicom_review'), { context: { patient_id: 'pat-kms-0003' }, onDiagnostic: (d) => diagnostics.push(d) });

    await screen.findByText('Sonographie Nieren beidseits');
    const viewer = screen.getByTestId('dicom-viewer');
    expect(viewer).toHaveTextContent('Select a study from the list');
    // The viewer reads $ui.selected_study before anyone has selected anything: that is the app working, not a warning for the inspector.
    expect(diagnostics).toEqual([]);

    fireEvent.click(screen.getByText('CT Abdomen nativ').closest('tr') as HTMLElement);
    await waitFor(() => expect(viewer).toHaveTextContent('1.2.276.0.7230010.3.1.2.8323329.3001'));
    expect(viewer).toHaveTextContent('Abdomen axial 3 mm');
    expect(viewer).toHaveTextContent('No OHIF viewer configured');
    expect(diagnostics).toEqual([]);
  });

  it('dicom review with a viewer configured: the iframe opens the study and hands over the session token in the URL fragment only', async () => {
    const config = { ...testConfig, imaging: { ...testConfig.imaging, ohifViewerUrl: 'https://viewer.example' } };
    await renderManifest(byId('app_dicom_review'), { context: { patient_id: 'pat-kms-0003' }, config, identity: { sub: 'rad-1', idToken: 'eyJ.jwt.token' } });

    await screen.findByText('Sonographie Nieren beidseits');
    fireEvent.click(screen.getByText('CT Abdomen nativ').closest('tr') as HTMLElement);
    const frame = await screen.findByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3001');
    const src = new URL(frame.getAttribute('src') ?? '');
    // Synthetic data (mock data mode, every preview): the study is opened from the viewer's `reference` data source — the
    // reference PACS that holds the synthetic studies — never from the hospital's, which cannot have this UID.
    expect(src.origin + src.pathname).toBe('https://viewer.example/viewer/reference');
    expect(src.searchParams.get('StudyInstanceUIDs')).toBe('1.2.276.0.7230010.3.1.2.8323329.3001');
    expect(src.hash).toBe('#token=eyJ.jwt.token'); // the fragment: never sent to a server, never logged
    expect(src.search).not.toContain('token');
    expect(viewerUrl('https://viewer.example', '1.2.3', undefined)).toBe('https://viewer.example/viewer?StudyInstanceUIDs=1.2.3'); // the deployment's default source: the hospital's PACS
    expect(viewerUrl('https://viewer.example', '1.2.3', undefined, { dataSource: 'reference' })).toBe('https://viewer.example/viewer/reference?StudyInstanceUIDs=1.2.3');
    expect(viewerUrl('https://v', '1', 't', { layout: 'mpr', dataSource: 'reference' })).toBe('https://v/viewer/reference?StudyInstanceUIDs=1&hangingProtocolId=mpr#token=t');

    // A reading viewer wants the whole screen: "expand" lays the same iframe over the page without reloading it; Esc brings the page back.
    const viewer = screen.getByTestId('dicom-viewer');
    expect(viewer).not.toHaveAttribute('data-expanded');
    fireEvent.click(screen.getByTestId('viewer-expand'));
    expect(viewer).toHaveAttribute('data-expanded', 'true');
    expect(viewer.style.position).toBe('fixed');
    expect(screen.getByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3001')).toBe(frame); // the same element: no second load
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(viewer).not.toHaveAttribute('data-expanded');
    expect(viewer.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByTestId('viewer-fullscreen')).toHaveAttribute('aria-label', 'Full screen');

    // 2D / MPR / 3D: a reconstruction names its hanging protocol and the series that is the volume (the 210-slice axial, not the topogram).
    const layout = screen.getByTestId('viewer-layout');
    expect(layout).toHaveAttribute('data-reconstructable', 'true');
    fireEvent.click(within(layout).getByText('3D'));
    const volumeSrc = new URL(screen.getByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3001').getAttribute('src') ?? '');
    expect(volumeSrc.searchParams.get('hangingProtocolId')).toBe('fourUp');
    expect(volumeSrc.searchParams.get('SeriesInstanceUIDs')).toBe('1.2.276.0.7230010.3.1.2.8323329.3001.2');
    expect(volumeSrc.hash).toBe('#token=eyJ.jwt.token');
    fireEvent.click(within(layout).getByText('MPR'));
    expect(new URL(screen.getByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3001').getAttribute('src') ?? '').searchParams.get('hangingProtocolId')).toBe('mpr');
    fireEvent.click(within(layout).getByText('2D'));
    expect(new URL(screen.getByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3001').getAttribute('src') ?? '').search).toBe('?StudyInstanceUIDs=1.2.276.0.7230010.3.1.2.8323329.3001');

    // The ultrasound sweep has no volume: the reconstruction segments are disabled and the study opens 2-D whatever was chosen before.
    fireEvent.click(within(layout).getByText('3D'));
    fireEvent.click(screen.getByText('Sonographie Nieren beidseits').closest('tr') as HTMLElement);
    const usFrame = await screen.findByTitle('OHIF viewer — 1.2.276.0.7230010.3.1.2.8323329.3002');
    expect(screen.getByTestId('viewer-layout')).not.toHaveAttribute('data-reconstructable');
    expect(new URL(usFrame.getAttribute('src') ?? '').searchParams.get('hangingProtocolId')).toBeNull();
    expect(within(screen.getByTestId('viewer-layout')).getByText('3D').closest('label')).toHaveAttribute('data-disabled');
  });

  it('viewer URL: layout and volume series', () => {
    const ct = { resourceType: 'ImagingStudy', status: 'available', subject: {}, series: [{ uid: '1.1', modality: {}, numberOfInstances: 2 }, { uid: '1.2', modality: {}, numberOfInstances: 350 }, { uid: '1.3', modality: {}, numberOfInstances: 60 }] } satisfies ImagingStudy;
    expect(volumeSeriesUid(ct)).toBe('1.2');
    expect(reconstructable(ct)).toBe(true);
    expect(reconstructable({ ...ct, series: [{ uid: '2.1', modality: {}, numberOfInstances: 2 }] })).toBe(false);
    expect(reconstructable({ ...ct, series: undefined })).toBe(true); // a PACS that lists no series: let the viewer try
    expect(volumeSeriesUid(undefined)).toBeUndefined();
    expect(viewerUrl('https://v', '1', 't', { layout: 'volume', seriesUid: '1.2' })).toBe('https://v/viewer?StudyInstanceUIDs=1&SeriesInstanceUIDs=1.2&hangingProtocolId=fourUp#token=t');
    expect(viewerUrl('https://v', '1', undefined, { layout: 'mpr' })).toBe('https://v/viewer?StudyInstanceUIDs=1&hangingProtocolId=mpr');
    expect(viewerUrl('https://v', '1', undefined, { layout: 'stack', seriesUid: '1.2' })).toBe('https://v/viewer?StudyInstanceUIDs=1'); // 2-D: OHIF lays the whole study out itself
  });

  it('structured assessment: write primitive never runs at load; submit goes through the action, is audited and reloads the list', async () => {
    const audit: AuditRecord[] = [];
    const executor = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0); // own instance: writes are stateful
    await renderManifest(byId('app_htn_assessment'), { executor, identity: { sub: 'test-sub', idToken: 'test-token', displayName: 'Nurse Example' }, onAudit: (r) => audit.push(r) });

    await screen.findByRole('heading', { name: 'Hypertension follow-up assessment', level: 2 });
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull(); // Medplum's own form heading is suppressed
    const list = await screen.findByTestId('submission-list');
    await waitFor(() => expect(list).toHaveTextContent('1 entry'));
    expect(audit.map((a) => a.primitive_id)).toEqual(['p_patient', 'p_questionnaire', 'p_submissions']);

    // Medplum QuestionnaireForm: radios for choice items, checkboxes for the multi-select one.
    fireEvent.click(screen.getByLabelText('Daily'));
    fireEvent.click(screen.getByLabelText('All doses taken'));
    fireEvent.click(screen.getByLabelText('Headache'));
    fireEvent.click(screen.getByLabelText('Ankle swelling'));
    fireEvent.click(screen.getByLabelText('No')); // an explicit negative answer must be recordable (a required boolean could not)
    fireEvent.change(screen.getByLabelText('Notes for the next visit'), { target: { value: 'Consider dose review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }));

    const saved = await screen.findByTestId('action-saved');
    expect(saved).toHaveTextContent('The assessment is now part of the patient record.');
    await waitFor(() => expect(screen.getByTestId('submission-list')).toHaveTextContent('2 entries'));
    expect(screen.getByTestId('submission-list')).toHaveTextContent('Nurse Example');
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement); // newest entry
    const answers = (await screen.findAllByTestId('answer-list'))[0] as HTMLElement; // panels stay mounted; first = newest
    expect(answers).toHaveTextContent('Headache, Ankle swelling');
    expect(answers).toHaveTextContent('Side effects of current medication reportedNo');

    const write = audit.find((a) => a.primitive_id === 'p_submit');
    expect(write).toMatchObject({ kind: 'write.fhir.questionnaire_response.submit', outcome: 'ok', role: 'nurse', patient_context: 'pat-kms-0001' });
    expect(write?.detail).toBe('QuestionnaireResponse/qr-mock-0001');
    // The reload after the write re-runs the read primitives only.
    expect(audit.filter((a) => a.primitive_id === 'p_submit')).toHaveLength(1);
    expect(audit.filter((a) => a.primitive_id === 'p_submissions')).toHaveLength(2);

    // The record carries the answers and server-side provenance, not the client's.
    const stored = (await executor.execute({
      manifest: byId('app_htn_assessment'),
      role: 'nurse',
      scope: resolveEffectiveScope(byId('app_htn_assessment'), 'nurse'),
      decl: byId('app_htn_assessment').primitives.find((p) => p.id === 'p_submissions')!,
      config: { resource: 'QuestionnaireResponse', params: { patient: 'pat-kms-0001' }, count: 10 },
      context: {},
      idToken: 't',
      userSub: 'test-sub',
    })) as QuestionnaireResponse[];
    const mine = stored.find((r) => r.id === 'qr-mock-0001')!;
    expect(mine.author).toEqual({ identifier: { system: 'urn:medapp:cognito-sub', value: 'test-sub' }, display: 'Nurse Example' });
    expect(mine.source).toBeUndefined();
    const byLink = Object.fromEntries((mine.item ?? []).map((i) => [i.linkId, i.answer]));
    expect(byLink['home_bp']).toEqual([{ valueCoding: { code: 'daily', display: 'Daily' } }]);
    expect(byLink['symptoms']).toEqual([{ valueCoding: { code: 'headache', display: 'Headache' } }, { valueCoding: { code: 'ankle_swelling', display: 'Ankle swelling' } }]);
    expect(byLink['side_effects']).toEqual([{ valueCoding: { code: 'no', display: 'No' } }]);
    expect(byLink['notes']).toEqual([{ valueString: 'Consider dose review.' }]);

    // "Record another assessment" brings back an empty form; a second submission is a second record.
    fireEvent.click(screen.getByRole('button', { name: 'Record another assessment' }));
    expect(screen.queryByTestId('action-saved')).toBeNull();
    expect((screen.getByLabelText('Daily') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Notes for the next visit') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByLabelText('Weekly'));
    fireEvent.click(screen.getByLabelText('Some doses missed'));
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }));
    await screen.findByTestId('action-saved');
    await waitFor(() => expect(screen.getByTestId('submission-list')).toHaveTextContent('3 entries'));
    expect(audit.filter((a) => a.primitive_id === 'p_submit' && a.outcome === 'ok')).toHaveLength(2);
    expect(audit.filter((a) => a.primitive_id === 'p_submit').map((a) => a.detail)).toEqual(['QuestionnaireResponse/qr-mock-0001', 'QuestionnaireResponse/qr-mock-0002']);
  });

  it('structured assessment: an incomplete form is refused by the write primitive and the problems are shown', async () => {
    const audit: AuditRecord[] = [];
    await renderManifest(byId('app_htn_assessment'), { executor: new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0), onAudit: (r) => audit.push(r) });
    await screen.findByLabelText('Daily');
    fireEvent.click(screen.getByLabelText('Daily'));
    // The browser's own `required` check blocks an incomplete form (jsdom enforces it too). A tampered
    // client can skip that, so submit the form element directly: the primitive must still refuse.
    fireEvent.submit(screen.getByRole('button', { name: 'Submit assessment' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('"Medication adherence over the last four weeks" is required')).toBeInTheDocument();
    expect(screen.getByText('"Side effects of current medication reported" is required')).toBeInTheDocument();
    expect(screen.queryByTestId('action-saved')).toBeNull();
    expect(audit.find((a) => a.primitive_id === 'p_submit')).toMatchObject({ outcome: 'refused' });
    expect(screen.getByTestId('submission-list')).toHaveTextContent('1 entry');
  });

  it('cohort dashboard: chained primitives, nested binding paths, threshold flags — and no diagnostics while data streams in', async () => {
    const diagnostics: Diagnostic[] = [];
    await renderManifest(byId('app_htn_cohort'), { context: {}, onDiagnostic: (d) => diagnostics.push(d) });

    // First paint: the static shell is there, every data-bound node is a placeholder, nothing ran with `undefined`.
    expect(screen.getByRole('heading', { name: 'Hypertension cohort' })).toBeInTheDocument();
    const placeholders = screen.getAllByTestId('pending-node');
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.some((p) => p.getAttribute('data-waiting-for') === 'latest')).toBe(true);

    // The static "Data scope" card renders at once; the data-bound cards replace their placeholders as bindings arrive.
    await waitFor(() => expect(screen.queryAllByTestId('pending-node')).toHaveLength(0));
    const cards = screen.getAllByTestId('stat-card');
    expect(diagnostics).toEqual([]); // `$bindings.latest.*` arrives second; that is not an unresolved reference
    expect(cards[0]).toHaveTextContent('2'); // Krüger + Yıldız have active hypertension
    expect(cards[1]).toHaveTextContent('1'); // only Yıldız is still ≥ 140 systolic
    expect(screen.getByText(/Krüger/)).toBeInTheDocument();
    expect(screen.getByText(/Yıldız/)).toBeInTheDocument();
    expect(screen.queryByText(/Bergmann/)).toBeNull();
    expect(screen.getAllByText('above threshold')).toHaveLength(1);
  });
});

describe('refusals', () => {
  const base = byId('app_bp_trend');

  it('renders a visible refusal for a component outside the catalog and leaves the rest intact', async () => {
    const tampered: AppManifest = {
      ...base,
      layout: {
        ...base.layout,
        root: { ...base.layout.root, children: [...(base.layout.root.children ?? []), { component: 'FreeformHtml', props: { html: '<script>' } }] },
      },
    };
    await renderManifest(tampered, { role: 'viewer' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Component is not in the catalog');
    expect(alert).toHaveTextContent('FreeformHtml');
    expect(screen.getByTestId('patient-banner')).toBeInTheDocument();
  });

  it('still reports a reference to a binding no primitive produces (an authoring mistake)', async () => {
    const diagnostics: Diagnostic[] = [];
    const tampered: AppManifest = {
      ...base,
      layout: {
        ...base.layout,
        root: { ...base.layout.root, children: [...(base.layout.root.children ?? []), { component: 'StatCard', props: { label: 'Typo', value: '$bindings.nope.count' } }] },
      },
    };
    await renderManifest(tampered, { role: 'viewer', onDiagnostic: (d) => diagnostics.push(d) });
    await screen.findByTestId('observation-timeline');
    await waitFor(() => expect(diagnostics.map((d) => d.message)).toEqual(['Reference $bindings.nope.count did not resolve; rendered as undefined.']));
  });

  it('refuses a data primitive the role scope does not grant, and audits the refusal', async () => {
    const audit: AuditRecord[] = [];
    const tampered: AppManifest = {
      ...base,
      primitives: [
        ...base.primitives.filter((p) => p.id !== 'p_conditions'),
        { id: 'p_reports', kind: 'data.fhir.query', catalog_version: '1.0.0', config: { resource: 'DiagnosticReport', params: {} }, output_binding: 'reports' },
      ],
    };
    await renderManifest(tampered, { role: 'viewer', onAudit: (r) => audit.push(r) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Request refused by data scope');
    expect(alert).toHaveTextContent('DiagnosticReport.search');
    expect(audit.at(-1)).toMatchObject({ primitive_id: 'p_reports', outcome: 'refused', detail: 'DiagnosticReport.search' });
  });

  it('refuses an unknown data primitive kind', async () => {
    const tampered: AppManifest = {
      ...base,
      primitives: [{ id: 'p_llm', kind: 'data.llm.freeform', catalog_version: '1.0.0', config: {}, output_binding: 'x' }],
    };
    await renderManifest(tampered, { role: 'viewer' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Data primitive is not in the catalog');
    expect(alert).toHaveTextContent('data.llm.freeform');
  });

  it('asks for a launch context instead of guessing a patient', async () => {
    await renderManifest(base, { role: 'viewer', context: {} });
    expect(await screen.findByText(/needs a launch context/)).toBeInTheDocument();
    expect(screen.getByText(/Missing: patient_id/)).toBeInTheDocument();
  });
});
