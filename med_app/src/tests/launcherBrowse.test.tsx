import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { localCollectionsClient, type CollectionsClient } from '../collections';
import { loadRegistry } from '../manifest/registry';
import { AppLauncher } from '../panel/AppLauncher';
import { theme } from '../theme';
import { testConfig } from './testUtils';

/**
 * Browsing a catalog that has grown: a clinician's launcher leads with their own apps (pinned, recently opened), then the
 * hospital's collections, then every app as a card narrowed by chips and a search over what the apps are about. Staff
 * keep their tabs with the same chips; approvers and admins curate the collections from a drawer whose changes leave in
 * one request. In the browser over the local clients; the API keeps the same rules.
 */

const registry = loadRegistry();
const knownIds = () => registry.filter((e) => e.ok).map((e) => (e.ok ? e.manifest.metadata.app_id : ''));

function sessionFor(groups: string[], sub = 'sub-x', name = 'Nora Nurse'): Session {
  return { idToken: 't', accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub, username: sub, name, groups } };
}

function providerFor(session: Session): AuthProvider {
  return { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
}

const cognito = { ...testConfig, auth: { ...testConfig.auth, mode: 'cognito' as const } };

function collectionsFor(session: Session): CollectionsClient {
  return localCollectionsClient({ knownAppIds: knownIds, caller: () => ({ sub: session.claims.sub, name: session.claims.name }), mayCurate: () => session.claims.groups.some((g) => g === 'medapp-approvers' || g === 'medapp-admins'), delayMs: 0, now: () => '2026-10-10T12:00:00.000Z' });
}

function renderLauncher(session: Session, config = cognito, collections = collectionsFor(session)) {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={providerFor(session)}>
        <MemoryRouter>
          <AppLauncher registry={registry} config={config} collections={collections} />
        </MemoryRouter>
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

// The hypertension clinic nurse: her role groups open four of the thirteen showcase apps.
const nurse = sessionFor(['app-app_hypertension_register-hypertension_clinic', 'app-app_hypertension_follow_up-hypertension_nurse', 'app-app_falls_risk-ward_nurse', 'app-app_patient_360-clinician']);

describe('a clinician browsing the catalog', () => {
  it('sees her own corner, the collections with only the apps she may open, and every app as a card', async () => {
    localStorage.clear();
    renderLauncher(nurse);
    const cards = await screen.findAllByTestId(/^app-card-/);
    expect(cards.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId('your-apps-empty')).toHaveTextContent('Pin an app, or open one');

    const collections = await screen.findByTestId('collections');
    const clinic = await within(collections).findByTestId('collection-col_chronic_disease_clinics');
    expect(clinic).toHaveTextContent('Chronic disease clinics');
    expect(within(clinic).getByTestId('app-card-app_hypertension_register')).toBeInTheDocument();
    expect(within(clinic).queryByTestId('app-card-app_htn_assessment_due')).not.toBeInTheDocument(); // not hers: not in her view of the collection
    expect(clinic).toHaveTextContent('2 apps'); // the register and the follow-up visit, of the collection's five
    expect(screen.queryByTestId('manage-collections')).not.toBeInTheDocument(); // not a curator

    const all = screen.getByTestId('all-apps');
    const register = within(all).getByTestId('app-card-app_hypertension_register');
    expect(register).toHaveTextContent('Cohort register');
    expect(register).toHaveTextContent('Cohort');
    expect(register).toHaveTextContent('Shows diagnoses, observations');
    expect(register).toHaveTextContent('for hypertension nurse, cardiologist, general practitioner');
    const falls = within(all).getByTestId('app-card-app_falls_risk');
    expect(falls).toHaveTextContent('Assessment');
    expect(falls).toHaveTextContent('Records form answers');
  });

  it('pins an app into her corner and keeps it there across visits', async () => {
    localStorage.clear();
    const view = renderLauncher(nurse);
    await screen.findAllByTestId(/^app-card-/);
    fireEvent.click(within(screen.getByTestId('all-apps')).getByTestId('pin-app_falls_risk'));
    const mine = screen.getByTestId('your-apps');
    expect(within(mine).getByTestId('app-card-app_falls_risk')).toBeInTheDocument();
    expect(mine).toHaveTextContent('1 pinned · 0 recent');
    expect(screen.queryByTestId('your-apps-empty')).not.toBeInTheDocument();
    view.unmount();
    renderLauncher(nurse);
    await screen.findAllByTestId(/^app-card-/);
    expect(within(screen.getByTestId('your-apps')).getByTestId('app-card-app_falls_risk')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('your-apps')).getByTestId('pin-app_falls_risk'));
    expect(screen.getByTestId('your-apps-empty')).toBeInTheDocument();
  });

  it('narrows by chips — OR within a facet, AND across — and by a search over what the apps are about', async () => {
    localStorage.clear();
    renderLauncher(nurse);
    await screen.findAllByTestId(/^app-card-/);
    const all = () => within(screen.getByTestId('all-apps')).queryAllByTestId(/^app-card-/);
    const before = all().length;
    expect(screen.getByTestId('chip-records-Form answers').parentElement).toHaveTextContent('Form answers2'); // offered (the test id sits on the chip's input): it would narrow the four to two
    fireEvent.click(screen.getByTestId('chip-kind-Assessment'));
    await waitFor(() => expect(all().length).toBe(2));
    fireEvent.click(screen.getByTestId('chip-kind-Cohort register'));
    await waitFor(() => expect(all().length).toBe(3));
    fireEvent.click(screen.getByTestId('chip-scope-Cohort'));
    await waitFor(() => expect(all().length).toBe(1)); // of the three, only the register is about a cohort
    fireEvent.click(screen.getByTestId('facets-clear'));
    await waitFor(() => expect(all().length).toBe(before));

    fireEvent.change(screen.getByTestId('registry-filter'), { target: { value: 'I10.90' } }); // the hypertension code: the register
    await waitFor(() => expect(all().map((c) => c.getAttribute('data-testid'))).toEqual(['app-card-app_hypertension_register']));
    fireEvent.change(screen.getByTestId('registry-filter'), { target: { value: 'nothing like this' } });
    await waitFor(() => expect(screen.getByText('No app matches. Clear a chip or shorten the search.')).toBeInTheDocument());
  });
});

describe('staff and curators', () => {
  it('staff keep the tabs, get the chips above them, and the collections strip in the Published tab; an approver curates', async () => {
    localStorage.clear();
    const approver = sessionFor(['medapp-approvers'], 'sub-sabine', 'Sabine Weber');
    renderLauncher(approver);
    await screen.findAllByTestId(/app-row-/);
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(1);
    expect(screen.getByTestId('facet-bar')).toBeInTheDocument();
    const ward = await screen.findByTestId('collection-col_ward_everyday_chores');
    expect(ward).toHaveTextContent('5 apps');

    // Staff have the pin on every card too: their corner is absent until something is pinned, then appears above the collections.
    expect(screen.queryByTestId('your-apps')).toBeNull();
    fireEvent.click(within(ward).getByTestId('pin-app_ward_worklist'));
    const mine = await screen.findByTestId('your-apps');
    expect(mine).toHaveTextContent('1 pinned · 0 recent');
    expect(within(mine).getByTestId('app-card-app_ward_worklist')).toBeInTheDocument();
    expect(mine.compareDocumentPosition(ward) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the corner comes first
    fireEvent.click(within(mine).getByTestId('pin-app_ward_worklist'));
    expect(screen.queryByTestId('your-apps')).toBeNull(); // unpinned, and nothing recent: the corner goes away again

    fireEvent.click(screen.getByTestId('manage-collections'));
    const drawer = await screen.findByTestId('collections-drawer');
    expect(within(drawer).getByTestId('collection-row-col_chronic_disease_clinics')).toHaveTextContent('5 apps');

    // A new collection: name, two apps ticked, one request on Create.
    fireEvent.click(within(drawer).getByTestId('collection-new'));
    fireEvent.change(await screen.findByTestId('collection-name'), { target: { value: 'Tumorboard' } });
    fireEvent.click(screen.getByTestId('collection-app-app_tumour_board'));
    fireEvent.click(screen.getByTestId('collection-app-app_imaging_3d'));
    expect(screen.getByTestId('collection-pending')).toHaveTextContent('2 apps');
    fireEvent.click(screen.getByTestId('collection-save'));
    expect(await screen.findByTestId('collections-notice')).toHaveTextContent("“Tumorboard” is in everyone's launcher now.");
    expect(within(drawer).getByTestId('collection-row-col_tumorboard')).toHaveTextContent('2 apps · by Sabine Weber');
    await waitFor(() => expect(screen.getByTestId('collection-col_tumorboard')).toHaveTextContent('2 apps')); // the strip behind the drawer reloaded

    // Editing gathers changes and saves them once; the pending count says what will leave.
    fireEvent.click(within(drawer).getByTestId('collection-edit-col_tumorboard'));
    const form = await screen.findByTestId('collection-form');
    expect(within(form).getByTestId('collection-save')).toBeDisabled(); // nothing changed yet
    fireEvent.click(within(form).getByTestId('collection-app-app_imaging_3d'));
    fireEvent.click(within(form).getByTestId('collection-app-app_patient_360'));
    expect(within(form).getByTestId('collection-pending')).toHaveTextContent('2 app changes pending');
    fireEvent.change(within(form).getByTestId('collection-description'), { target: { value: 'Für die Konferenz.' } });
    fireEvent.click(within(form).getByTestId('collection-save'));
    await waitFor(() => expect(within(drawer).getByTestId('collection-row-col_tumorboard')).toHaveTextContent('2 apps · Für die Konferenz.'));

    // Deleting asks in place.
    fireEvent.click(within(drawer).getByTestId('collection-delete-col_tumorboard'));
    fireEvent.click(await screen.findByTestId('collection-delete-yes'));
    await waitFor(() => expect(within(drawer).queryByTestId('collection-row-col_tumorboard')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('collection-col_tumorboard')).not.toBeInTheDocument());
  });

  it('with no collections yet, the strip says so and the drawer opens on an invitation to make the first one', async () => {
    localStorage.clear();
    const approver = sessionFor(['medapp-approvers'], 'sub-sabine', 'Sabine Weber');
    const inner = collectionsFor(approver);
    let empty = true;
    const client: CollectionsClient = { ...inner, list: async () => (empty ? [] : inner.list()), create: async (input) => ((empty = false), inner.create(input)) };
    renderLauncher(approver, cognito, client);
    await screen.findAllByTestId(/app-row-/);
    expect(await screen.findByTestId('collections-empty')).toHaveTextContent('No collections yet');
    fireEvent.click(screen.getByTestId('manage-collections'));
    const drawer = await screen.findByTestId('collections-drawer');
    const invitation = within(drawer).getByTestId('collections-drawer-empty');
    expect(invitation).toHaveTextContent('No collections yet');
    expect(invitation).toHaveTextContent('Hypertonie-Sprechstunde');
    fireEvent.click(within(invitation).getByTestId('collection-new'));
    fireEvent.change(await screen.findByTestId('collection-name'), { target: { value: 'Geriatrie' } });
    fireEvent.click(screen.getByTestId('collection-app-app_falls_risk'));
    fireEvent.click(screen.getByTestId('collection-save'));
    await screen.findByTestId('collections-notice');
    await waitFor(() => expect(within(drawer).queryByTestId('collections-drawer-empty')).not.toBeInTheDocument());
  });

  it('an author sees the collections but cannot curate them', async () => {
    localStorage.clear();
    renderLauncher(sessionFor(['medapp-authors'], 'sub-lukas', 'Lukas'));
    await screen.findAllByTestId(/app-row-/);
    expect(await screen.findByTestId('collections')).toBeInTheDocument();
    expect(screen.queryByTestId('manage-collections')).not.toBeInTheDocument();
  });
});
