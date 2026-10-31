import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, IdentityClaims, Session } from '../auth/types';
import { localAuthoringClient, LocalRegistryStore } from '../authoring/localClient';
import { actorName, approvalOf, describeEvent, historyOf, RECALL_NOTES, sentBack } from '../manifest/history';
import { loadRegistry, localRegistrySource, remoteRegistrySource, type RegistryEntry, type VersionEvent } from '../manifest/registry';
import { AppLauncher } from '../panel/AppLauncher';
import { LifecycleActions } from '../panel/drafting/LifecycleActions';
import { VersionHistory } from '../panel/VersionHistory';
import { theme } from '../theme';
import { loadFixtureRegistry } from './fixtures';
import { testConfig } from './testUtils';

/**
 * A version's history as people read it — submitted, sent back and why, recalled, approved and with what notes,
 * published, superseded — and where the panel shows it: the inspector's lifecycle row, the Drafts tab (a draft that was
 * sent back says so, with the reason), the review page. The events come from the registry; the local authoring client
 * writes the same ones in mock mode; a manifest without events falls back to its sign-off.
 */

type OkEntry = Extract<RegistryEntry, { ok: true }>;

const showcase = loadRegistry();
const register = showcase.find((e): e is OkEntry => e.ok && e.manifest.metadata.app_id === 'app_hypertension_register')!;

const lukas = { name: 'Lukas Hoffmann', email: 'lukas.hoffmann@klinikum-musterstadt.example' };
const ada = { name: 'Ada Approver' };

function ev(ts: string, from: VersionEvent['from_state'], to: VersionEvent['to_state'], extra: Partial<VersionEvent> = {}): VersionEvent {
  return { ts: `2026-10-${ts}:00.000Z`, actor_sub: 'sub-lukas', actor: lukas, from_state: from, to_state: to, ...extra };
}

/** The register as a draft v1.1.0 with a full life so far, newest first as the API returns it. */
function draftWithHistory(history: VersionEvent[], state: OkEntry['manifest']['lifecycle']['state'] = 'draft'): OkEntry {
  return {
    ...register,
    file: 'register-1.1.0',
    manifest: { ...register.manifest, metadata: { ...register.manifest.metadata, version: '1.1.0', parent_version: '1.0.0' }, lifecycle: { state, signoff: null } },
    meta: { ...register.meta, owner_sub: 'sub-lukas', created_by_sub: 'sub-lukas', author: lukas, history },
  };
}

const sentBackHistory: VersionEvent[] = [
  ev('09T12:00', 'draft', 'draft', { notes: 'revised from draft s1' }),
  ev('09T11:00', 'in_review', 'draft', { actor_sub: 'sub-ada', actor: ada, notes: 'The threshold is too low for the geriatric wards; 150 is what we agreed.' }),
  ev('09T10:00', 'draft', 'in_review'),
  { ...ev('09T09:00', null, 'draft', { notes: 'created from draft s1; iterates 1.0.0' }), actor: undefined }, // written before names were kept
];

describe('a version history as people read it', () => {
  it('names each step, keeps the notes that matter and drops the bookkeeping', () => {
    const entry = draftWithHistory(sentBackHistory);
    const items = historyOf(entry);
    expect(items.map((i) => [i.label, i.tone, i.notes ?? null])).toEqual([
      ['Revised', 'neutral', null],
      ['Sent back to draft', 'attention', 'The threshold is too low for the geriatric wards; 150 is what we agreed.'],
      ['Submitted for review', 'neutral', null],
      ['Created as a draft, iterating on v1.0.0', 'neutral', null],
    ]);
    expect(actorName(items[1]!.event)).toBe('Ada Approver');
    expect(actorName({ actor_sub: 'sub-x', actor: { email: 'x@klinikum-musterstadt.example' } })).toBe('x@klinikum-musterstadt.example');
    expect(actorName({ actor_sub: 'sub-me' }, 'sub-me')).toBe('you');
    expect(actorName({ actor_sub: 'sub-old' })).toBe('sub-old');
  });

  it('tells a recall by the author from a send-back by a reviewer, an approval with its signature, a supersession', () => {
    const entry = draftWithHistory([]);
    expect(describeEvent(ev('09T11:00', 'in_review', 'draft', { notes: RECALL_NOTES }), entry)).toMatchObject({ label: 'Recalled by the author', tone: 'neutral' });
    expect(describeEvent(ev('09T11:00', 'approved', 'draft', { actor_sub: 'sub-lukas' }), entry)).toMatchObject({ label: 'Recalled by the author', tone: 'neutral' }); // the author took it back without a word
    expect(describeEvent(ev('09T11:00', 'approved', 'draft', { actor_sub: 'sub-ada', actor: ada, notes: 'Second thoughts.' }), entry)).toMatchObject({ label: 'Sent back to draft after approval', tone: 'attention', notes: 'Second thoughts.' });
    expect(describeEvent(ev('09T11:00', 'in_review', 'approved', { actor_sub: 'sub-ada', actor: ada, notes: 'Checked with the ward.', signed: true }), entry)).toMatchObject({ label: 'Approved and signed', tone: 'approval', notes: 'Checked with the ward.' });
    expect(describeEvent(ev('09T11:00', 'approved', 'published', { actor_sub: 'sub-ada', actor: ada }), entry)).toMatchObject({ label: 'Published', tone: 'approval' });
    expect(describeEvent(ev('09T11:00', 'published', 'deprecated', { notes: 'superseded by 1.1.0' }), entry)).toMatchObject({ label: 'Superseded by v1.1.0', tone: 'neutral' });
    expect(describeEvent(ev('09T11:00', 'published', 'deprecated', { notes: 'retired: replaced by the KIS module' }), entry)).toMatchObject({ label: 'Deprecated', notes: 'retired: replaced by the KIS module' });
  });

  it('a draft that was sent back carries the reason until it is resubmitted — through revisions, not past a recall', () => {
    expect(sentBack(draftWithHistory(sentBackHistory))?.notes).toContain('150 is what we agreed');
    expect(sentBack(draftWithHistory(sentBackHistory, 'in_review'))).toBeNull(); // resubmitted
    expect(sentBack(draftWithHistory([ev('09T11:00', 'in_review', 'draft', { notes: RECALL_NOTES }), ...sentBackHistory]))).toBeNull(); // the author's own recall is the last decision
    expect(sentBack(draftWithHistory([ev('09T09:00', null, 'draft')]))).toBeNull();
  });

  it('a manifest without events falls back to its sign-off for the approval', () => {
    const items = historyOf(register); // the bundled showcase: published, an example sign-off, no events
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'Approved and signed', tone: 'approval', inferred: true });
    expect(items[0]!.notes).toContain('Listing of patients by a coded diagnosis');
    expect(approvalOf(register)?.event.actor_sub).toBe('example-approver-sub');
    expect(historyOf(draftWithHistory([]))).toEqual([]);
  });
});

describe('where the history comes from', () => {
  it('the registry API: staff get each version’s events newest first; an unknown state is dropped, not shown', async () => {
    const apiBody = {
      apps: [
        {
          app_id: register.manifest.metadata.app_id,
          version: '1.0.0',
          state: 'published',
          roles: [],
          manifest: register.manifest,
          history: [
            { ts: '2026-10-02T10:00:00Z', actor_sub: 'sub-ada', actor: { name: 'Ada Approver', email: null }, from_state: 'approved', to_state: 'published', notes: null, signed: false },
            { ts: '2026-10-01T15:00:00Z', actor_sub: 'sub-ada', actor: { name: 'Ada Approver' }, from_state: 'in_review', to_state: 'approved', notes: 'Checked with the ward.', signed: true },
            { ts: '2026-10-01T09:00:00Z', actor_sub: 'sub-old', actor: null, from_state: null, to_state: 'draft', notes: 'created from draft s0' },
            { ts: '2026-10-01T08:00:00Z', actor_sub: 'sub-old', from_state: 'limbo', to_state: 'draft' },
          ],
        },
      ],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(apiBody), { status: 200 })) as typeof fetch;
    const [entry] = await remoteRegistrySource('https://api.example.test', () => 'tok', fetchImpl).load();
    if (!entry?.ok) throw new Error('entry');
    expect(entry.meta?.history).toEqual([
      { ts: '2026-10-02T10:00:00Z', actor_sub: 'sub-ada', actor: { name: 'Ada Approver' }, from_state: 'approved', to_state: 'published' },
      { ts: '2026-10-01T15:00:00Z', actor_sub: 'sub-ada', actor: { name: 'Ada Approver' }, from_state: 'in_review', to_state: 'approved', notes: 'Checked with the ward.', signed: true },
      { ts: '2026-10-01T09:00:00Z', actor_sub: 'sub-old', from_state: null, to_state: 'draft', notes: 'created from draft s0' },
    ]);
    expect(historyOf(entry).map((i) => i.label)).toEqual(['Published', 'Approved and signed', 'Created as a draft']);
  });

  it('mock mode: the local authoring client writes the same events as the API would, with the person behind each', async () => {
    const store = new LocalRegistryStore();
    let who: { sub: string; name: string } = { sub: 'sub-lukas', name: 'Lukas Hoffmann' };
    const client = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => who.sub, getCallerIdentity: () => ({ name: who.name }), registry: store, turnDelayMs: 5, knownVersions: () => undefined });
    const { session_id } = await client.createDraft({});
    await client.patchDraft(session_id, [
      { op: 'choose_archetype', args: { archetype: 'APP-02', reason: 'a trend' } },
      { op: 'set_app', args: { app_id: 'app_hba1c', name: 'HbA1c over time', description: 'Five years.' } },
      { op: 'set_knobs', args: { patch: { codes: [{ system: 'loinc', code: '4548-4' }], series: [{ label: 'HbA1c', code: '4548-4' }], unit: '%', window: 'now-5y' } } },
      { op: 'set_governance', args: { patch: { clinical_context: 'diabetes_clinic', intended_users: ['diabetologist'], intended_purpose: 'Display only.' } } },
      { op: 'add_role', args: { role: { id: 'clinician', display_name: 'Clinician', phi_fields_visible: ['name', 'dob'] } } },
    ]);
    await client.saveApp(session_id);
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    who = { sub: 'sub-ada', name: 'Ada Approver' };
    await client.transition('app_hba1c', '0.1.0', 'draft', 'Five years is too long for the clinic screen.');
    who = { sub: 'sub-lukas', name: 'Lukas Hoffmann' };
    await client.patchDraft(session_id, [{ op: 'set_knobs', args: { patch: { window: 'now-2y' } } }]);
    await client.replaceVersion('app_hba1c', '0.1.0', session_id);
    const entries = await localRegistrySource(store, loadFixtureRegistry).load();
    const hba1c = entries.find((e): e is OkEntry => e.ok && e.manifest.metadata.app_id === 'app_hba1c')!;
    expect(historyOf(hba1c).map((i) => [i.label, actorName(i.event), i.notes ?? null])).toEqual([
      ['Revised', 'Lukas Hoffmann', null],
      ['Sent back to draft', 'Ada Approver', 'Five years is too long for the clinic screen.'],
      ['Submitted for review', 'Lukas Hoffmann', null],
      ['Created as a draft', 'Lukas Hoffmann', null],
    ]);
    expect(sentBack(hba1c)?.notes).toBe('Five years is too long for the clinic screen.');

    await client.transition('app_hba1c', '0.1.0', 'in_review');
    who = { sub: 'sub-ada', name: 'Ada Approver' };
    await client.transition('app_hba1c', '0.1.0', 'approved', 'Two years, as agreed.');
    await client.transition('app_hba1c', '0.1.0', 'published');
    const after = (await localRegistrySource(store, loadFixtureRegistry).load()).find((e): e is OkEntry => e.ok && e.manifest.metadata.app_id === 'app_hba1c')!;
    expect(historyOf(after).slice(0, 2).map((i) => [i.label, i.notes ?? null, i.event.signed ?? false])).toEqual([
      ['Published', null, false],
      ['Approved and signed', 'Two years, as agreed.', true],
    ]);
    expect(sentBack(after)).toBeNull();
  });
});

/* ── where it shows ─────────────────────────────────────────────────────────────────────────── */

const claims: IdentityClaims = { sub: 'sub-lukas', username: 'lukas', name: 'Lukas Hoffmann', groups: ['medapp-authors'] };
const session: Session = { idToken: 't', accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims };
const provider: AuthProvider = { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };

describe('where the panel shows it', () => {
  it('the lifecycle row of the inspector lists the steps, the send-back with its reason first; the rest on request', () => {
    const entry = draftWithHistory([ev('09T13:00', 'draft', 'draft', { notes: 'revised from draft s1' }), ...sentBackHistory]);
    const client = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'sub-lukas', registry: new LocalRegistryStore(), knownVersions: () => undefined });
    render(
      <MantineProvider theme={theme}>
        <MemoryRouter>
          <LifecycleActions entry={entry} claims={claims} isMock={false} client={client} onChanged={() => {}} />
        </MemoryRouter>
      </MantineProvider>
    );
    const history = screen.getByTestId('version-history');
    let events = within(history).getAllByTestId('history-event');
    expect(events).toHaveLength(4); // the four most recent of five
    expect(events[0]).toHaveTextContent('Revised');
    expect(events[2]).toHaveTextContent('Sent back to draft');
    expect(events[2]).toHaveAttribute('data-tone', 'attention');
    expect(within(events[2]!).getByTestId('history-notes')).toHaveTextContent('150 is what we agreed');
    expect(events[2]).toHaveTextContent('Ada Approver');
    expect(events[3]).toHaveTextContent('Submitted for review');
    expect(events[3]).toHaveTextContent('Lukas Hoffmann ·');
    fireEvent.click(screen.getByTestId('history-toggle'));
    events = within(history).getAllByTestId('history-event');
    expect(events).toHaveLength(5);
    expect(events[4]).toHaveTextContent('Created as a draft, iterating on v1.0.0');
    expect(events[4]).toHaveTextContent('you ·'); // an event without a name on it, by the signed-in person
  });

  it('a published showcase app shows its sign-off as the approval, marked as inferred', () => {
    render(
      <MantineProvider theme={theme}>
        <VersionHistory entry={register} />
      </MantineProvider>
    );
    const event = screen.getByTestId('history-event');
    expect(event).toHaveTextContent('Approved and signed');
    expect(event).toHaveTextContent('from the sign-off');
    expect(event).toHaveTextContent('example-approver-sub');
    expect(within(event).getByTestId('history-notes')).toHaveTextContent('Listing of patients by a coded diagnosis');
  });

  it('the Drafts tab marks a draft that was sent back and shows the reviewer’s reason on the row', async () => {
    const entry = draftWithHistory(sentBackHistory);
    render(
      <MantineProvider theme={theme}>
        <AuthProviderBoundary provider={provider}>
          <MemoryRouter initialEntries={['/?tab=drafts']}>
            <Routes>
              <Route path="/" element={<AppLauncher registry={[...showcase, entry]} config={testConfig} authoring={localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'sub-lukas', registry: new LocalRegistryStore(), knownVersions: () => undefined })} />} />
            </Routes>
          </MemoryRouter>
        </AuthProviderBoundary>
      </MantineProvider>
    );
    const row = await screen.findByTestId('sent-back-app_hypertension_register');
    expect(row).toHaveTextContent('Sent back to draft');
    expect(row).toHaveTextContent('Ada Approver');
    expect(within(row).getByTestId('history-notes')).toHaveTextContent('The threshold is too low for the geriatric wards; 150 is what we agreed.');
    expect(screen.getByText('saved v1.1.0 · sent back')).toBeInTheDocument();
  });
});
