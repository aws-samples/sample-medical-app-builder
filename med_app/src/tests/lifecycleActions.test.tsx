import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { IdentityClaims } from '../auth/types';
import { localAuthoringClient, LocalRegistryStore } from '../authoring/localClient';
import { localRegistrySource, type RegistryEntry } from '../manifest/registry';
import { LifecycleActions } from '../panel/drafting/LifecycleActions';
import { loadFixtureRegistry } from './fixtures';
import { Providers, testMedplum } from './testUtils';

/**
 * The way back into the editor depends on where a version stands. A draft is continued as it is; a version under review
 * or approved is recalled first — off the reviewers' desk, sign-off removed — and then continued; a published one is
 * iterated on as a new version. First demo round: "Iterate" on a version in review opened a new draft while the stale
 * version stayed in the reviewers' queue.
 */

const author: IdentityClaims = { sub: 'mock-author', username: 'author', name: 'Ada Author', groups: ['medapp-authors'] };

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

async function world() {
  const store = new LocalRegistryStore();
  const client = localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => 'mock-author', registry: store, turnDelayMs: 5, knownVersions: () => undefined });
  const { session_id } = await client.createDraft({});
  await client.patchDraft(session_id, [
    { op: 'choose_archetype', args: { archetype: 'APP-02', reason: 'a trend' } },
    { op: 'set_app', args: { app_id: 'app_hba1c', name: 'HbA1c over time', description: 'Five years.' } },
    { op: 'set_knobs', args: { patch: { codes: [{ system: 'loinc', code: '4548-4' }], series: [{ label: 'HbA1c', code: '4548-4' }], unit: '%', window: 'now-5y' } } },
    { op: 'set_governance', args: { patch: { clinical_context: 'diabetes_clinic', intended_users: ['diabetologist'], intended_purpose: 'Display only.' } } },
    { op: 'add_role', args: { role: { id: 'clinician', display_name: 'Clinician', phi_fields_visible: ['name', 'dob'] } } },
  ]);
  await client.saveApp(session_id);
  return { store, client, session_id };
}

async function entryOf(store: LocalRegistryStore): Promise<Extract<RegistryEntry, { ok: true }>> {
  const entries = await localRegistrySource(store, loadFixtureRegistry).load();
  const e = entries.find((x) => x.ok && x.manifest.metadata.app_id === 'app_hba1c');
  if (!e || !e.ok) throw new Error('app_hba1c missing');
  return e;
}

async function renderActions(store: LocalRegistryStore, client: ReturnType<typeof localAuthoringClient>) {
  const medplum = await testMedplum();
  const entry = await entryOf(store);
  let changes = 0;
  const view = render(
    <Providers medplum={medplum}>
      <MemoryRouter initialEntries={['/apps/app_hba1c/0.1.0']}>
        <Routes>
          <Route path="/apps/:appId/:version" element={<LifecycleActions entry={entry} claims={author} isMock={false} client={client} onChanged={() => void changes++} />} />
          <Route path="/drafts/new" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </Providers>
  );
  return { view, changed: () => changes };
}

describe('the way back into the editor', () => {
  test('a draft is continued, a version in review is recalled first, a published one is iterated on', async () => {
    const { store, client, session_id } = await world();

    // Draft: continue the same conversation.
    let page = await renderActions(store, client);
    expect(screen.getByTestId('iterate')).toHaveTextContent('Continue editing');
    fireEvent.click(screen.getByTestId('iterate'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/drafts/new?from=app_hba1c&version=0.1.0');
    page.view.unmount();

    // In review: recalling is explicit, explained, and happens before the editor opens; the version is back in draft.
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    page = await renderActions(store, client);
    expect(screen.getByTestId('iterate')).toHaveTextContent('Recall and edit');
    fireEvent.click(screen.getByTestId('iterate'));
    const confirm = screen.getByTestId('recall-confirm');
    expect(confirm).toHaveTextContent('Recalling takes v0.1.0 out of review; reviewers see it leave their queue.');
    fireEvent.click(screen.getByTestId('recall-confirm-no'));
    expect(screen.queryByTestId('recall-confirm')).toBeNull();
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('in_review'); // kept, as asked
    fireEvent.click(screen.getByTestId('iterate'));
    fireEvent.click(screen.getByTestId('recall-confirm-yes'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/drafts/new?from=app_hba1c&version=0.1.0');
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('draft');
    expect(page.changed()).toBe(1);
    expect((await client.getDraft(session_id)).saved_as).toMatchObject({ state: 'draft' }); // the conversation thaws with the version
    expect(await client.listDrafts()).toHaveLength(1); // no second draft was made
    page.view.unmount();

    // Approved: the same, and the sign-off goes with it.
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    await client.transition('app_hba1c', '0.1.0', 'approved', 'fine');
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.signoff).toBeTruthy();
    page = await renderActions(store, client);
    fireEvent.click(screen.getByTestId('iterate'));
    expect(screen.getByTestId('recall-confirm')).toHaveTextContent('out of the approved state and removes its sign-off');
    fireEvent.click(screen.getByTestId('recall-confirm-yes'));
    await screen.findByTestId('where');
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle).toMatchObject({ state: 'draft', signoff: null });
    page.view.unmount();

    // Published: what clinicians use does not move — a new version instead.
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    await client.transition('app_hba1c', '0.1.0', 'approved', 'fine');
    await client.transition('app_hba1c', '0.1.0', 'published');
    page = await renderActions(store, client);
    expect(screen.getByTestId('iterate')).toHaveTextContent('Iterate on this app');
    fireEvent.click(screen.getByTestId('iterate'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/drafts/new?from=app_hba1c&version=0.1.0');
    await waitFor(() => expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('published'));
    page.view.unmount();
  }, 20000);

  test('deprecating asks first and says what it does to clinicians', async () => {
    const { store, client } = await world();
    await client.transition('app_hba1c', '0.1.0', 'in_review');
    await client.transition('app_hba1c', '0.1.0', 'approved', 'fine');
    await client.transition('app_hba1c', '0.1.0', 'published');
    const page = await renderActions(store, client);
    fireEvent.click(screen.getByTestId('transition-deprecated'));
    const confirm = screen.getByTestId('deprecate-confirm');
    expect(confirm).toHaveTextContent('Deprecating withdraws v0.1.0 from clinicians');
    fireEvent.click(screen.getByTestId('deprecate-confirm-no'));
    expect(screen.queryByTestId('deprecate-confirm')).toBeNull();
    expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('published');
    fireEvent.click(screen.getByTestId('transition-deprecated'));
    fireEvent.click(screen.getByTestId('deprecate-confirm-yes'));
    await waitFor(() => expect(store.find('app_hba1c', '0.1.0')?.manifest.lifecycle.state).toBe('deprecated'));
    expect(page.changed()).toBe(1); // the page reloads the registry; with the deprecated entry the button is gone
    page.view.unmount();
  }, 20000);
});
