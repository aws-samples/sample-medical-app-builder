import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { localAuthoringClient, LocalRegistryStore, remoteAuthoringClient } from '../authoring';
import { panelSections } from '../panel/PanelShell';
import { ShapeEditorPage } from '../panel/shapes/ShapeEditorPage';
import { ShapesPage } from '../panel/shapes/ShapesPage';
import { draftSpecForShape } from '../panel/shapes/openAsApp';
import { NEW_SHAPE_TEMPLATE, parseShapeYaml, previewSpecFor } from '../panel/shapes/preview';
import { localShapesClient, publishedArtifacts, remoteShapesClient, ShapesApiError, type ShapesClient } from '../shapes';
import { compileSpec } from '../spec';
import { compileShape, shapeLookup } from '../spec/shapes';
import { resolveEffectiveScope } from '../manifest/roles';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { Providers, testConfig, testMedplum } from './testUtils';

/**
 * The record-shape library in the panel: the local client keeps the registry's rules (ids fixed, drafts revised in
 * place, a new draft after a publication, one published version, curators publish and deprecate); the compile of a
 * draft is handed the published artifacts; the pages list the library, edit a document with live checks, preview it as
 * a form on the synthetic record, and move it through its lifecycle.
 */

function sessionFor(groups: string[], sub = 'sub-lukas', name = 'Lukas Hoffmann'): Session {
  return { idToken: 'mock.id.token', accessToken: 'mock.access.token', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub, username: sub, name, email: `${sub}@klinikum-musterstadt.example`, groups } };
}

function providerFor(session: Session): AuthProvider {
  return { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
}

function clientFor(session: () => Session, storage?: Storage): ShapesClient {
  return localShapesClient({
    caller: () => ({ sub: session().claims.sub, name: session().claims.name, email: session().claims.email }),
    mayAuthor: () => session().claims.groups.some((g) => g === 'medapp-authors' || g === 'medapp-admins'),
    mayCurate: () => session().claims.groups.some((g) => g === 'medapp-approvers' || g === 'medapp-admins'),
    storage,
    delayMs: 0,
  });
}

const AUTHOR = sessionFor(['medapp-authors']);
const OTHER = sessionFor(['medapp-authors'], 'sub-other', 'Other Author');
const APPROVER = sessionFor(['medapp-approvers'], 'sub-ada', 'Ada Approver');

const wardNote = {
  apiVersion: 'medapp.eu/v1',
  kind: 'RecordShape',
  shape: { id: 'ward_note', name: 'Ward note', description: 'A short nursing note.', resource: 'DocumentReference', status: 'current', fields: [{ id: 'text', label: 'Note', type: 'long_text', path: 'content[0].attachment', required: true, max_length: 2000 }] },
};

describe('the local library keeps the registry rules', () => {
  it('seeds the bundled shapes as published, creates and revises drafts, publishes one version at a time, deprecates', async () => {
    let who = AUTHOR;
    const client = clientFor(() => who);
    const seeded = await client.list();
    expect(seeded.map((s) => [s.shape_id, s.active_version, s.latest_state])).toEqual([
      ['consent_per_purpose', '0.1.0', 'published'],
      ['measurable_goal', '0.1.0', 'published'],
      ['patient_alert', '0.1.0', 'published'],
      ['progress_note', '0.1.0', 'published'],
    ]);
    expect(publishedArtifacts(seeded).map((a) => a.id)).toEqual(['consent_per_purpose', 'measurable_goal', 'patient_alert', 'progress_note']);
    expect(seeded.find((s) => s.shape_id === 'patient_alert')?.latest?.artifact.open_kind).toBe(true); // the bundled example of an administrator-defined kind

    await expect(client.create({ ...wardNote, shape: { ...wardNote.shape, fields: [] } })).rejects.toMatchObject({ status: 422 });
    const made = await client.create(wardNote);
    expect(made).toMatchObject({ shape_id: 'ward_note', resource: 'DocumentReference', latest_version: '0.1.0', latest_state: 'draft', active_version: null, published: null });
    expect(made.latest?.artifact.rules.fields[0]).toMatchObject({ id: 'text', as: 'attachment_text' });
    await expect(client.create(wardNote)).rejects.toMatchObject({ status: 409 });

    // Revising: in place while a draft; another author may not; the id does not change.
    who = OTHER;
    await expect(client.revise('ward_note', wardNote)).rejects.toMatchObject({ status: 403 });
    who = AUTHOR;
    await expect(client.revise('ward_note', { ...wardNote, shape: { ...wardNote.shape, id: 'other_note' } })).rejects.toMatchObject({ status: 409 });
    const renamed = { ...wardNote, shape: { ...wardNote.shape, name: 'Nursing note' } };
    const revised = await client.revise('ward_note', renamed);
    expect(revised.name).toBe('Nursing note');
    expect(revised.latest_version).toBe('0.1.0');

    // Publishing: curators; the compile library grows; a published version is followed by a new draft; publishing it supersedes.
    await expect(client.transition('ward_note', '0.1.0', 'published')).rejects.toMatchObject({ status: 403 });
    who = APPROVER;
    const published = await client.transition('ward_note', '0.1.0', 'published', 'Reviewed with the ward.');
    expect(published.active_version).toBe('0.1.0');
    expect(published.published?.checksum).toBe(revised.latest?.checksum);
    expect(publishedArtifacts(await client.list()).map((a) => a.id)).toEqual(['consent_per_purpose', 'measurable_goal', 'ward_note', 'patient_alert', 'progress_note']);
    await expect(client.transition('ward_note', '0.1.0', 'published')).rejects.toMatchObject({ status: 409 });
    who = AUTHOR;
    const wider = { ...renamed, shape: { ...renamed.shape, fields: [...renamed.shape.fields, { id: 'title', label: 'Title', type: 'text', path: 'description', max_length: 120 }] } };
    const second = await client.revise('ward_note', wider);
    expect(second).toMatchObject({ latest_version: '0.2.0', latest_state: 'draft', active_version: '0.1.0' });
    expect(second.published?.artifact.fields).toHaveLength(1);
    expect(second.latest?.artifact.fields).toHaveLength(2);
    who = APPROVER;
    const superseding = await client.transition('ward_note', '0.2.0', 'published');
    expect(superseding.active_version).toBe('0.2.0');
    const detail = await client.get('ward_note');
    expect(detail.versions.map((v) => [v.version, v.state])).toEqual([
      ['0.2.0', 'published'],
      ['0.1.0', 'deprecated'],
    ]);
    expect(detail.history.map((h) => [h.from_state, h.to_state, h.notes ?? null])).toEqual([
      ['draft', 'published', null],
      ['published', 'deprecated', 'superseded by 0.2.0'],
      [null, 'draft', 'from 0.1.0'],
      ['draft', 'published', 'Reviewed with the ward.'],
      ['draft', 'draft', 'revised'],
      [null, 'draft', 'created'],
    ]);
    const retired = await client.transition('ward_note', '0.2.0', 'deprecated', 'The ward writes notes in the HIS now.');
    expect(retired.active_version).toBeNull();
    expect(retired.published).toBeNull();
    expect(publishedArtifacts(await client.list()).map((a) => a.id)).toEqual(['consent_per_purpose', 'measurable_goal', 'patient_alert', 'progress_note']);
    await expect(client.get('nowhere')).rejects.toBeInstanceOf(ShapesApiError);
  });

  it('the authoring clients hand the published artifacts to every compile — local and remote', async () => {
    const shapes = clientFor(() => AUTHOR);
    const library = () => shapes.list().then(publishedArtifacts);
    const spec = { ...draftSpecForShape((await shapes.list()).find((s) => s.shape_id === 'measurable_goal')!).spec, app: { app_id: 'app_goals', name: 'Goals' }, roles: [{ id: 'physio', display_name: 'Physio', phi_fields_visible: ['name'], capabilities: ['view', 'record_entry'] }], default_role: 'physio', governance: { clinical_context: 'physio', intended_users: ['physio'], intended_purpose: 'Goals.', mdr_classification: 'none' } };
    const local = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'sub-lukas', registry: new LocalRegistryStore(), shapes: library });
    const compiled = await local.compile(spec);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect((compiled.manifest as { primitives: { kind: string; config: { shape?: { id: string } } }[] }).primitives.find((p) => p.kind === 'write.fhir.record.create')?.config.shape?.id).toBe('measurable_goal');
    const bare = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'sub-lukas', registry: new LocalRegistryStore() });
    const unresolved = await bare.compile(spec);
    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) expect(unresolved.issues.map((i) => i.message)).toContain('no published record shape "measurable_goal" — the library has none yet');

    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sent.push({ url, body });
      if (url.endsWith('/registry/shapes')) return new Response(JSON.stringify({ shapes: await shapes.list() }), { status: 200 });
      if (url.endsWith('/manifest/compile')) return new Response(JSON.stringify({ ok: false, issues: [] }), { status: 422 });
      if (url.endsWith('/manifest/shape')) return new Response(JSON.stringify({ ok: true, artifact: { id: 'x' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const remoteShapes = remoteShapesClient('https://api.test', () => 'tok', fetchImpl);
    const remote = remoteAuthoringClient('https://api.test', () => 'tok', fetchImpl, { shapes: () => remoteShapes.list().then(publishedArtifacts) });
    await remote.compile(spec);
    const compileCall = sent.find((c) => c.url.endsWith('/manifest/compile'))!;
    expect((compileCall.body.shapes as { id: string }[]).map((a) => a.id)).toEqual(['consent_per_purpose', 'measurable_goal', 'patient_alert', 'progress_note']);
    await remoteShapes.compile(wardNote);
    expect(sent.find((c) => c.url.endsWith('/manifest/shape'))?.body).toEqual({ shape: wardNote });
  });

  it('a document is checked as it is typed; the preview page and the "open as an app" draft compile', async () => {
    const parsed = parseShapeYaml(NEW_SHAPE_TEMPLATE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('template');
    const own = compileShape(parsed.raw);
    const preview = compileSpec(previewSpecFor(parsed.doc), { hospital_id: 'hsp-test', created_at: '2026-01-01T00:00:00Z', shapes: own.ok ? shapeLookup([own.artifact]) : undefined });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.manifest.primitives.map((p) => p.kind)).toEqual(expect.arrayContaining(['data.fhir.query', 'write.fhir.record.create']));
    expect(parseShapeYaml('shape: [')).toMatchObject({ ok: false, issues: [{ path: '(yaml)' }] });
    expect(parseShapeYaml('')).toMatchObject({ ok: false, issues: [{ path: '(root)' }] });
    const wrong = parseShapeYaml(NEW_SHAPE_TEMPLATE.replace('type: number, path: "target[0].detailQuantity"', 'type: number, path: priority'));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues.map((i) => i.message)).toContain('a number field cannot be written into priority (CodeableConcept)');

    for (const resource of ['CarePlan', 'Encounter', 'DocumentReference'] as const) {
      const fields = resource === 'Encounter' ? [{ id: 'kind', label: 'Kind', type: 'code', path: 'class', required: true, codes: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Ambulatory' }] }] : resource === 'DocumentReference' ? wardNote.shape.fields : [{ id: 'title', label: 'Title', type: 'text', path: 'title', required: true }];
      const doc = parseShapeYaml(JSON.stringify({ apiVersion: 'medapp.eu/v1', kind: 'RecordShape', shape: { id: `x_${resource.toLowerCase()}`, name: `X ${resource}`, resource, fields } }));
      expect(doc.ok, resource).toBe(true);
      if (doc.ok) {
        const art = compileShape(doc.raw);
        expect(compileSpec(previewSpecFor(doc.doc), { hospital_id: 'hsp-test', created_at: '2026-01-01T00:00:00Z', shapes: art.ok ? shapeLookup([art.artifact]) : undefined }).ok, resource).toBe(true);
      }
    }

    const shapes = clientFor(() => AUTHOR);
    const goal = (await shapes.list()).find((s) => s.shape_id === 'measurable_goal')!;
    const seed = draftSpecForShape(goal);
    expect(seed.message).toContain('Start from the record shape "Measurable goal" (measurable_goal, version 0.1.0)');
    expect(seed.message).toContain('Goal, Measured by, Target value');
    const full = { apiVersion: 'medapp.eu/v1', kind: 'AppSpec', ...seed.spec, app: { app_id: 'app_goals', name: 'Goals' }, roles: [{ id: 'physio', display_name: 'Physio', phi_fields_visible: ['name'], capabilities: ['view', 'record_entry'] }], default_role: 'physio', governance: { clinical_context: 'physio', intended_users: ['physio'], intended_purpose: 'Goals.', mdr_classification: 'none' } };
    const r = compileSpec(full, { hospital_id: 'hsp-test', created_at: '2026-01-01T00:00:00Z', shapes: shapeLookup(publishedArtifacts(await shapes.list())) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('compile');
    // The manifest pins the shape — id, checksum, version — and carries the tag every record written with it will bear.
    const write = r.manifest.primitives.find((p) => p.kind === 'write.fhir.record.create')!;
    const tag = { system: 'https://hsp-test.medapp.eu/CodeSystem/record-shape', code: 'measurable_goal', version: '0.1.0', display: 'Measurable goal' };
    expect(write.config).toMatchObject({ resource: 'Goal', shape: { id: 'measurable_goal', checksum: goal.published?.checksum, version: '0.1.0', tag } });
    // … and the executor stamps it on the record (meta.tag), beside the platform's source; an inline shape leaves none.
    const executor = new MockPrimitiveExecutor(undefined, new Date('2026-09-11T12:00:00Z'), 0);
    const record = { resourceType: 'Goal', identifier: [{ system: 'urn:medapp:submission', value: 's1' }], description: { text: 'Walk unaided' }, target: [{ measure: { coding: [{ system: 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio', code: 'tug', display: 'Timed up-and-go' }], text: 'Timed up-and-go' } }] };
    const scope = resolveEffectiveScope(r.manifest, 'physio');
    const written = (await executor.execute({ manifest: r.manifest, role: 'physio', scope, decl: write, config: { ...write.config, subject: 'pat-kms-0001', record }, context: { patient_id: 'pat-kms-0001' }, idToken: 't', userSub: 'u1' })) as { meta?: { tag?: unknown[]; source?: string } };
    expect(written.meta?.tag).toEqual([tag]);
    expect(written.meta?.source).toBe('urn:medapp:app_goals@0.1.0');
  });
});

async function renderShapes(session: Session, client: ShapesClient, path: string) {
  const medplum = await testMedplum();
  return render(
    <Providers medplum={medplum}>
      <AuthProviderBoundary provider={providerFor(session)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/shapes" element={<ShapesPage client={client} config={testConfig} />} />
            <Route path="/shapes/new" element={<ShapeEditorPage client={client} config={testConfig} />} />
            <Route path="/shapes/:shapeId" element={<ShapeEditorPage client={client} config={testConfig} />} />
            <Route path="/drafts/new" element={<div data-testid="new-draft">new draft</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProviderBoundary>
    </Providers>
  );
}

describe('the Record shapes section', () => {
  it('is a panel section for staff, lists the library, and opens a shape', async () => {
    expect(panelSections(AUTHOR.claims, false).map((s) => s.to)).toEqual(['/', '/shapes', '/catalog']);
    expect(panelSections(sessionFor(['medapp-viewers']).claims, false)).toEqual([]);
    const client = clientFor(() => AUTHOR);
    await renderShapes(AUTHOR, client, '/shapes');
    const list = await screen.findByTestId('shape-list');
    expect(within(list).getAllByTestId(/^shape-row-/)).toHaveLength(4);
    const goal = within(list).getByTestId('shape-row-measurable_goal');
    expect(goal).toHaveTextContent('Measurable goal');
    expect(goal).toHaveTextContent('Goal');
    expect(within(goal).getByTestId('shape-state-published')).toHaveTextContent('0.1.0 · published');
    expect(screen.getByTestId('new-shape')).toBeInTheDocument();
    // Below the list: how the library grows — an author's steps beside the platform's, and the types the engine admits, read from the engine.
    const grows = screen.getByTestId('how-the-library-grows');
    expect(grows).toHaveTextContent('A new shape');
    expect(grows).toHaveTextContent('A new kind of record');
    expect(grows).toHaveTextContent('Decide what the platform stamps');
    expect(within(grows).getByTestId('admitted-types')).toHaveTextContent('GoalCarePlanEncounterDocumentReferenceConsent');
    fireEvent.click(goal);
    expect(((await screen.findByTestId('shape-yaml')) as HTMLTextAreaElement).value).toContain('id: measurable_goal');
    expect(screen.getByTestId('shape-fields')).toHaveTextContent('Measured by *');
    expect(screen.getByTestId('open-as-app')).toBeEnabled();
    await screen.findByTestId('shape-preview');
    expect(await screen.findByTestId('record-entry-goal', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('edits with live checks, saves a draft, publishes it as a curator, and offers it as an app', async () => {
    let who = AUTHOR;
    const storage = new Map<string, string>();
    const storageLike = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as Storage;
    const client = clientFor(() => who, storageLike);
    const view = await renderShapes(AUTHOR, client, '/shapes/new');
    const yaml = await screen.findByTestId('shape-yaml');
    expect((yaml as HTMLTextAreaElement).value).toContain('id: ward_goal');
    expect(screen.queryByTestId('open-as-app')).toBeNull();
    fireEvent.change(yaml, { target: { value: (yaml as HTMLTextAreaElement).value.replace('type: number, path: "target[0].detailQuantity"', 'type: number, path: priority') } });
    expect(await screen.findByTestId('shape-issues')).toHaveTextContent('a number field cannot be written into priority (CodeableConcept)');
    expect(screen.getByTestId('save-shape')).toBeDisabled();
    fireEvent.change(yaml, { target: { value: NEW_SHAPE_TEMPLATE } });
    await waitFor(() => expect(screen.queryByTestId('shape-issues')).toBeNull());
    expect(screen.getByTestId('save-shape')).toBeEnabled();
    fireEvent.click(screen.getByTestId('save-shape'));
    await waitFor(() => expect((screen.getByTestId('shape-yaml') as HTMLTextAreaElement).value).toContain('id: ward_goal'));
    await screen.findByTestId('shape-state-draft');
    expect((await client.list()).map((s) => s.shape_id)).toContain('ward_goal');
    view.unmount();

    // The author revises the draft in place; a curator publishes it; the app button comes alive.
    await renderShapes(AUTHOR, client, '/shapes/ward_goal');
    const editor = await screen.findByTestId('shape-yaml');
    expect(screen.getByTestId('publish-shape')).toBeEnabled(); // mock mode: anyone may curate
    fireEvent.change(editor, { target: { value: (editor as HTMLTextAreaElement).value.replace('name: Ward goal', 'name: Ward goal (short term)') } });
    expect(screen.getByTestId('publish-shape')).toBeDisabled(); // not with an unsaved edit: what is published is what the registry holds
    fireEvent.click(screen.getByTestId('save-shape'));
    expect(await screen.findByTestId('shape-notice')).toHaveTextContent('Draft 0.1.0 revised.');
    const detail = await client.get('ward_goal');
    expect(detail.name).toBe('Ward goal (short term)');
    expect(detail.history.map((h) => h.notes)).toEqual(['revised', 'created']);
    screen.getByTestId('shape-notice');
    who = APPROVER;
    const curatorView = await renderShapes(APPROVER, client, '/shapes/ward_goal');
    const publish = await within(curatorView.container).findByTestId('publish-shape');
    expect(publish).toHaveTextContent('Publish 0.1.0');
    fireEvent.click(publish);
    fireEvent.change(await screen.findByTestId('transition-notes'), { target: { value: 'Agreed with the ward lead.' } });
    fireEvent.click(screen.getByTestId('confirm-transition'));
    await waitFor(() => expect(within(curatorView.container).getByTestId('shape-notice')).toHaveTextContent('is published: apps can write with `shape: ward_goal`'));
    expect(within(curatorView.container).getByTestId('shape-state-published')).toHaveTextContent('0.1.0 · published');
    expect(within(curatorView.container).getByTestId('open-as-app')).toBeEnabled();
    expect(within(curatorView.container).getByTestId('shape-history')).toHaveTextContent('0.1.0: draft → published · Ada Approver — Agreed with the ward lead.');
    expect(within(curatorView.container).getByTestId('deprecate-shape')).toHaveTextContent('Deprecate 0.1.0');
    fireEvent.click(within(curatorView.container).getByTestId('open-as-app'));
    await screen.findByTestId('new-draft');
  });
});
