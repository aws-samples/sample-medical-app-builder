import { StrictMode, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { localAuthoringClient, LocalRegistryStore, type LocalAgent } from '../authoring/localClient';
import type { AuthoringClient } from '../authoring/types';
import { localRegistrySource, type RegistryEntry } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';
import { AppLauncher } from '../panel/AppLauncher';
import { DraftingPage, NewDraft } from '../panel/DraftingPage';
import { Providers, testConfig, testMedplum } from './testUtils';

/**
 * The drafting page end to end over the local authoring client: a scripted "agent" fills most of
 * the draft from the first message, the roles form completes it, the preview renders the compiled
 * manifest with the real renderer, and saving + submitting moves it into the registry the launcher
 * lists. Same page, same operations as against the deployed API — only the transport differs.
 */

const session: Session = {
  idToken: 'mock.id.token',
  accessToken: 'mock.access.token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  claims: { sub: 'mock-author', username: 'author', name: 'Ada Author', groups: ['medapp-authors'] },
};

const authProvider: AuthProvider = {
  kind: 'mock',
  restoreSession: async () => session,
  signIn: async () => ({ status: 'signed_in', session }),
  signOut: async () => {},
  forgotPassword: async () => ({}),
  confirmForgotPassword: async () => {},
};

/** Answers the first message by choosing the trend archetype and filling everything but the roles. */
const scriptedAgent: LocalAgent = ({ message }) => ({
  reply: `Understood — **${message}**. I set up a trend app; who will use it?`,
  ops: [
    { op: 'choose_archetype', args: { archetype: 'APP-02', reason: 'a value over time' } },
    { op: 'set_app', args: { app_id: 'app_hba1c', name: 'HbA1c over time', description: 'Five years of HbA1c against the 7 % target.' } },
    { op: 'set_knobs', args: { patch: { codes: [{ system: 'loinc', code: '4548-4' }], series: [{ label: 'HbA1c', code: '4548-4' }], unit: '%', thresholds: [{ value: 7, label: 'Target' }], window: 'now-5y' } } },
    { op: 'set_governance', args: { patch: { clinical_context: 'diabetes_clinic', intended_users: ['diabetologist'], intended_purpose: 'Display only.' } } },
  ],
});

function world(agent?: LocalAgent) {
  const store = new LocalRegistryStore();
  const client = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'mock-author', registry: store, agent, turnDelayMs: 5, knownVersions: () => undefined });
  return { store, client };
}

/** The registry as the app holds it: loaded once, reloaded when a page reports a change (App.tsx's `registry.reload`). */
function Pages({ client, path, source, initial }: { client: AuthoringClient; path: string; source: ReturnType<typeof localRegistrySource>; initial: RegistryEntry[] }) {
  const [entries, setEntries] = useState(initial);
  const reload = async () => setEntries(await source.load());
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/drafts/new" element={<NewDraft client={client} registry={entries} />} />
        <Route path="/drafts/:draftId" element={<DraftingPage client={client} registry={entries} config={testConfig} onRegistryChanged={reload} />} />
        <Route path="/" element={<AppLauncher registry={entries} config={testConfig} authoring={client} onRegistryChanged={reload} />} />
      </Routes>
    </MemoryRouter>
  );
}

async function renderPage(client: AuthoringClient, path: string, registry = new LocalRegistryStore(), strict = false) {
  const medplum = await testMedplum();
  const source = localRegistrySource(registry, loadFixtureRegistry);
  const entries = await source.load();
  const tree = (
    <Providers medplum={medplum}>
      <AuthProviderBoundary provider={authProvider}>
        <Pages client={client} path={path} source={source} initial={entries} />
      </AuthProviderBoundary>
    </Providers>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('drafting page', () => {
  test('chat fills the draft, the roles form completes it, the preview renders, saving and submitting reach the registry', async () => {
    const { store, client } = world(scriptedAgent);
    const { session_id } = await client.createDraft({ message: 'HbA1c over five years' });
    const page = await renderPage(client, `/drafts/${session_id}`, store);

    // The turn lands: the person's message, then the assistant's Markdown reply.
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveTextContent('who will use it?'), { timeout: 4000 });
    expect(within(screen.getByTestId('message-assistant')).getByText('HbA1c over five years').tagName).toBe('STRONG');
    expect(screen.getByTestId('message-user')).toHaveTextContent('HbA1c over five years');

    // What is still open sits on the tabs: the roles tab carries its two fields, the badge counts sections (the first
    // reviewers read "5 open items" against four rows and could not tell what was counted). The App tab, on screen,
    // says it is complete and points at the other section.
    expect(screen.getByTestId('open-sections')).toHaveTextContent('1 section missing required information');
    expect(screen.getByTestId('tab-open-roles')).toHaveTextContent('2');
    expect(screen.queryByTestId('tab-open-overview')).toBeNull();
    expect(screen.getByRole('tab', { name: /^App/ })).toHaveAttribute('data-standing', 'complete');
    expect(screen.getByRole('tab', { name: /Roles & access/ })).toHaveAttribute('data-standing', 'open');
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('data-standing', 'complete');
    expect(screen.getByTestId('readiness')).toHaveTextContent('Complete. 1 other section is missing required information — marked above.');
    // The Preview tab is locked and says what unlocks it.
    expect(screen.getByTestId('tab-preview')).toHaveAttribute('data-locked', 'true');
    expect(screen.getByTestId('tab-preview')).toBeDisabled();
    expect(screen.queryByTestId('chat-handoff')).toBeNull(); // nothing to save yet

    // Roles & access: the form adds a role through PATCH; the first role becomes the default. On that tab the line names the fields.
    fireEvent.click(screen.getByRole('tab', { name: /Roles & access/ }));
    expect(screen.getByTestId('readiness')).toHaveTextContent('Still needed here: At least one role · Default role — the last section missing anything.');
    fireEvent.click(await screen.findByTestId('add-role'));
    const form = screen.getByTestId('new-role');
    fireEvent.change(within(form).getByLabelText(/Display name/), { target: { value: 'Diabetes clinician' } });
    expect((within(form).getByLabelText(/^Id/) as HTMLInputElement).value).toBe('diabetes_clinician');
    fireEvent.click(within(form).getByRole('button', { name: 'Add role' }));
    const card = await screen.findByTestId('role-diabetes_clinician');
    expect(card).toHaveTextContent('default role');
    await waitFor(() => expect(screen.getByText('ready to save')).toBeInTheDocument());
    expect(screen.queryByTestId('tab-open-roles')).toBeNull();
    expect(screen.getByTestId('readiness')).toHaveTextContent('Complete. Every section is');
    expect(screen.getByTestId('tab-preview')).not.toHaveAttribute('data-locked');
    // The chat hands over where the conversation ends: the real save button and what follows it — the assistant itself
    // cannot save, submit, approve or publish, and the first demo round showed it claiming otherwise.
    const handoff = screen.getByTestId('chat-handoff');
    expect(handoff).toHaveTextContent('The draft is complete.');
    expect(handoff).toHaveTextContent('an approver — not you — approves and publishes it, and only then do clinicians see it');
    expect(within(handoff).getByTestId('chat-save')).toHaveTextContent('Save to registry');

    // Preview: the compiled manifest, rendered by the real renderer on synthetic data.
    fireEvent.click(screen.getByRole('tab', { name: /Preview/ }));
    await screen.findByTestId('preview', {}, { timeout: 4000 });
    expect(screen.getByTestId('preview')).toHaveTextContent('app_hba1c');
    await waitFor(() => expect(screen.getByText('Latest readings')).toBeInTheDocument(), { timeout: 4000 });

    // A wrong value is refused with the schema's reason, and the draft is unchanged.
    fireEvent.click(screen.getByRole('tab', { name: /Settings/ }));
    expect(screen.getByTestId('knobs-summary')).toHaveTextContent('now-5y');
    fireEvent.click(screen.getByText('Advanced: edit the settings as YAML'));
    const yaml = await screen.findByLabelText('Settings as YAML');
    fireEvent.change(yaml, { target: { value: (yaml as HTMLTextAreaElement).value.replace('now-5y', 'yesterday') } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByTestId('rejected');
    expect(screen.getByTestId('rejected')).toHaveTextContent('knobs.window');
    expect(screen.getByTestId('knobs-summary')).toHaveTextContent('now-5y');

    // Save (from the chat's hand-off — the same save as the header's button).
    fireEvent.click(screen.getByTestId('chat-save'));
    await screen.findByTestId('saved');
    expect(screen.getByTestId('saved')).toHaveTextContent('Saved as app_hba1c v0.1.0');
    // The next steps are buttons apart from the text (inline links at the end of the paragraph were overlooked).
    expect(screen.getByTestId('saved-open-app')).toHaveAttribute('href', '/apps/app_hba1c/0.1.0');
    expect(screen.getByTestId('saved-back')).toHaveAttribute('href', '/?tab=drafts');
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('draft');
    // A draft version is still its author's to change: the conversation stays open, "Save changes" waits for a change.
    expect(screen.getByLabelText('Message to the drafting assistant')).toBeEnabled();
    expect(screen.queryByTestId('chat-handoff')).toBeNull(); // nothing to save: the draft equals the saved version
    expect(screen.getByTestId('save')).toHaveTextContent('Save changes');
    expect(screen.getByTestId('save')).toBeDisabled();
    expect(screen.getByTestId('save')).toHaveAttribute('data-unchanged', 'true');
    expect(screen.getByTestId('submit-review')).toBeEnabled();

    // Change the saved draft → the same version is revised in place; no 0.2.0 appears.
    fireEvent.click(screen.getByRole('tab', { name: /^App/ }));
    const nameField = await screen.findByLabelText(/App name/);
    expect(nameField).toBeRequired();
    fireEvent.change(nameField, { target: { value: 'HbA1c, five years' } });
    // The field commits a moment after typing stops — the title follows without leaving the field.
    await waitFor(() => expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('HbA1c, five years'), { timeout: 4000 });
    expect((nameField as HTMLInputElement).value).toBe('HbA1c, five years'); // what came back did not overwrite the field
    // Emptied and left: a required field keeps its previous value and says so (the spec has no "unset").
    fireEvent.change(nameField, { target: { value: '' } });
    fireEvent.blur(nameField);
    await waitFor(() => expect((nameField as HTMLInputElement).value).toBe('HbA1c, five years'));
    expect(screen.getByText(/Required — kept “HbA1c, five years”/)).toBeInTheDocument();
    expect(nameField).not.toBeDisabled(); // and it stays editable
    fireEvent.change(nameField, { target: { value: 'HbA1c, five years' } });
    await waitFor(() => expect(screen.getByTestId('save')).toBeEnabled(), { timeout: 4000 });
    expect(screen.getByTestId('submit-review')).toBeDisabled(); // what is reviewed is what is saved: save first
    expect(screen.getByTestId('chat-handoff')).toHaveTextContent('You changed the draft since it was saved as v0.1.0');
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('save')).toBeDisabled(), { timeout: 4000 });
    expect(store.find('app_hba1c', '0.1.0')?.manifest.metadata.name).toBe('HbA1c, five years');
    expect(store.find('app_hba1c', '0.2.0')).toBeUndefined();
    expect(store.list().filter((v) => v.app_id === 'app_hba1c')).toHaveLength(1);

    // Submit for review — a separate step; from here the conversation is frozen and changes mean a new version.
    fireEvent.click(screen.getByTestId('submit-review'));
    await waitFor(() => expect(screen.getByTestId('saved')).toHaveTextContent('Submitted for review'));
    expect(screen.getByTestId('saved-back')).toHaveAttribute('href', '/?tab=review'); // back to where the version now sits
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('in_review');
    await waitFor(() => expect(screen.getByLabelText('Message to the drafting assistant')).toBeDisabled());
    expect(screen.queryByTestId('save')).toBeNull();
    expect(screen.queryByTestId('submit-review')).toBeNull();
    page.unmount();

    // Home: the submitted version sits under "Pending sign-off", not among the apps.
    await renderPage(client, '/?tab=review', store);
    expect(screen.getByRole('tab', { name: /Pending sign-off/ })).toHaveAttribute('aria-selected', 'true');
    const review = screen.getByTestId('review-versions');
    expect(within(review).getByTestId('app-row-app_hba1c')).toHaveTextContent('in review');
    expect(within(review).getByTestId('app-row-app_hba1c')).toHaveTextContent('0.1.0');
    fireEvent.click(screen.getByRole('tab', { name: /^Published apps/ }));
    expect(screen.queryByTestId('app-row-app_hba1c')).toBeNull();
    expect(screen.getByTestId('app-row-app_patient_summary')).toBeInTheDocument();
  }, 20000);

  test('without an agent the chat says so, and the launcher lists drafts and offers a new app', async () => {
    const { store, client } = world();
    const { session_id } = await client.createDraft({ message: 'Anyone there?' });
    const view = await renderPage(client, `/drafts/${session_id}`, store);
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveTextContent('deployed environment'), { timeout: 4000 });
    expect(screen.getByTestId('readiness')).toHaveTextContent('Still needed here: Which kind of app');
    expect(screen.getByTestId('open-sections')).toHaveTextContent('3 sections missing required information');
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('data-standing', 'pending');
    view.unmount();

    await renderPage(client, '/', store);
    expect(await screen.findByTestId('new-app')).toHaveAttribute('href', '/drafts/new');
    expect(screen.getByRole('tab', { name: /^Published apps/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('drafts-list')).toBeNull();
    fireEvent.click(screen.getByTestId('tab-drafts'));
    const drafts = await screen.findByTestId('drafts-list');
    // One list, two stages: the conversation not yet saved, and the bundled imaging manifest — a
    // version saved as a draft — which belongs here, not among the apps.
    await waitFor(() => expect(drafts).toHaveTextContent('Untitled draft'));
    expect(drafts).toHaveTextContent('in conversation');
    const imaging = within(drafts).getByTestId('app-row-app_dicom_review');
    expect(imaging).toHaveTextContent('Imaging study review');
    expect(imaging).toHaveTextContent('saved v0.1.0 · not submitted');
    expect(within(imaging).getByTestId('submit-app_dicom_review')).toBeInTheDocument();

    // Deleting a conversation: asks in place, then it is gone — from the list and from the client.
    fireEvent.click(screen.getByTestId(`delete-${session_id}`));
    expect(drafts).toHaveTextContent('Delete this draft for good?');
    fireEvent.click(screen.getByTestId(`confirm-delete-${session_id}`));
    await waitFor(() => expect(screen.queryByTestId(`draft-session-${session_id}`)).toBeNull());
    expect(await client.listDrafts()).toEqual([]);
    expect(imaging).toBeInTheDocument(); // saved versions are not deletable here
  }, 20000);

  test('iterating on your own app reopens its conversation — the same draft while the version is a draft, a continued one once submitted; someone else\'s starts from the spec', async () => {
    // First demo round: save, open the app, "Iterate" — and a blank chat opened, seeded with the spec alone.
    const { store, client } = world(scriptedAgent);
    const { session_id } = await client.createDraft({ message: 'HbA1c over five years' });
    await waitFor(async () => expect((await client.getDraft(session_id)).turn?.status).toBe('done'), { timeout: 4000 });
    await client.patchDraft(session_id, [{ op: 'add_role', args: { role: { id: 'clinician', display_name: 'Clinician', phi_fields_visible: ['name', 'dob'] } } }]);
    await client.saveApp(session_id);
    const entries = await localRegistrySource(store, loadFixtureRegistry).load();
    expect(entries.some((e) => e.ok && e.manifest.metadata.app_id === 'app_hba1c')).toBe(true);

    // The version is still a draft: "Iterate" is simply the same conversation again — no second draft, no second version.
    const same = await renderPage(client, '/drafts/new?from=app_hba1c&version=0.1.0', store);
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveTextContent('who will use it?'), { timeout: 4000 });
    expect(screen.getByTestId('message-user')).toHaveTextContent('HbA1c over five years');
    expect(screen.getByTestId('saved')).toHaveTextContent('Saved as app_hba1c v0.1.0');
    expect(screen.getByLabelText('Message to the drafting assistant')).toBeEnabled();
    expect(screen.getByTestId('save')).toHaveTextContent('Save changes');
    expect(await client.listDrafts()).toHaveLength(1);
    same.unmount();

    // Submitted for review: the conversation is frozen, so iterating continues it in a new draft that becomes the next version.
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    const page = await renderPage(client, '/drafts/new?from=app_hba1c&version=0.1.0', store);
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveTextContent('who will use it?'), { timeout: 4000 });
    expect(screen.getByText(/new version of app_hba1c/)).toBeInTheDocument();
    expect(screen.getByLabelText('Message to the drafting assistant')).toBeEnabled();
    const drafts = await client.listDrafts();
    expect(drafts).toHaveLength(2);
    const source = drafts.find((d) => d.session_id === session_id);
    expect(source?.saved_as).toEqual({ app_id: 'app_hba1c', version: '0.1.0', state: 'in_review' }); // untouched: still the version's record, frozen
    const continued = drafts.find((d) => d.session_id !== session_id)!;
    expect((await client.getDraft(continued.session_id)).iterates).toEqual({ app_id: 'app_hba1c', version: '0.1.0' });
    expect(screen.getByTestId('save')).toHaveTextContent('Save as new version');
    expect(screen.getByTestId('save')).toBeDisabled(); // identical to v0.1.0 so far
    page.unmount();

    // Another author iterating on the same app has no conversation to continue: the version's spec seeds a fresh draft.
    const other = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'someone-else', registry: store, agent: scriptedAgent, turnDelayMs: 5, knownVersions: () => undefined });
    const theirs = await renderPage(other, '/drafts/new?from=app_hba1c&version=0.1.0', store);
    await waitFor(() => expect(screen.getByText(/new version of app_hba1c/)).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByTestId('message-assistant')).toBeNull();
    // The empty transcript sets the scene for an iteration rather than asking what the app should be.
    expect(screen.getByTestId('chat-empty')).toHaveTextContent('You are iterating on HbA1c over time (v0.1.0). The assistant knows the app as it stands');
    expect(screen.getByTestId('transcript')).not.toHaveTextContent('Describe the app in your own words');
    theirs.unmount();
  }, 20000);

  test('a fresh draft offers the catalog\'s example requests to send with one click, in English or German; an iterating draft does not', async () => {
    const { store, client } = world(scriptedAgent);
    const { session_id } = await client.createDraft({});
    const view = await renderPage(client, `/drafts/${session_id}`, store);
    const starters = await screen.findByTestId('starter-prompts');
    // Four to start with — a trend, a designed form, an imaging cohort, a composed page — the rest behind "More ideas".
    expect(within(starters).getAllByTestId(/^starter-APP-/).map((b) => b.getAttribute('data-testid'))).toEqual(['starter-APP-02', 'starter-APP-11', 'starter-APP-09', 'starter-APP-12']);
    expect(within(starters).getByTestId('starter-APP-11')).toHaveTextContent('A falls-risk screen for the ward');
    expect(within(starters).getByTestId('starter-APP-11')).toHaveTextContent('Structured assessment');
    fireEvent.click(within(starters).getByTestId('starters-more'));
    expect(within(starters).getAllByTestId(/^starter-APP-/).length).toBe(13); // one per archetype
    expect(within(starters).getByTestId('starters-more')).toHaveTextContent('Fewer ideas');
    // The same requests in German, as the catalog gives them to the assistant.
    fireEvent.click(within(starters).getByText('Deutsch'));
    expect(within(starters).getByTestId('starter-APP-11')).toHaveTextContent('Ein Sturzrisiko-Screening für die Station');
    // One click sends: the request is the person's first message, and the assistant answers it.
    fireEvent.click(within(starters).getByTestId('starter-APP-02'));
    await waitFor(() => expect(screen.getByTestId('message-user')).toHaveTextContent('Blutdruckverlauf der letzten zwei Jahre'), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId('message-assistant')).toHaveTextContent('who will use it?'), { timeout: 4000 });
    expect(screen.queryByTestId('starter-prompts')).toBeNull();
    view.unmount();

    // Iterating on an app: the empty transcript sets the scene instead; no starters (they would start a different app).
    await renderPage(client, '/drafts/new?from=app_bp_trend&version=0.3.0', store);
    await screen.findByTestId('chat-empty', {}, { timeout: 4000 });
    expect(screen.queryByTestId('starter-prompts')).toBeNull();
  }, 20000);

  test('"New app" opens exactly one draft, even with StrictMode running effects twice, and can iterate on a bundled app', async () => {
    const { store, client } = world();
    await renderPage(client, '/drafts/new', store, true);
    await screen.findByText('Drafting assistant', {}, { timeout: 4000 });
    expect((await client.listDrafts()).length).toBe(1);

    // Iterating on a bundled app: the fixture spec seeds the draft, complete from the start.
    const seeded = await renderPage(client, '/drafts/new?from=app_bp_trend&version=0.3.0', store, true);
    await waitFor(() => expect(screen.getByText('ready to save')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText(/new version of app_bp_trend/)).toBeInTheDocument();
    // Seeded from the stored spec, the draft equals v0.3.0: there is nothing to save until something changes.
    const saveButton = screen.getByRole('button', { name: 'Save as new version' });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute('data-unchanged', 'true');
    expect(screen.queryByTestId('chat-handoff')).toBeNull();
    expect((await client.listDrafts()).length).toBe(2);
    seeded.unmount();
  }, 20000);
});
