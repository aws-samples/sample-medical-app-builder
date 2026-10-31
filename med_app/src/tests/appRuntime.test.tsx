import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { localRegistrySource } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';
import { AppRuntime, LOOK_AGAIN } from '../panel/AppRuntime';
import { Providers, testConfig, testExecutor, testMedplum } from './testUtils';

/**
 * The app page when a single-patient app is opened without a patient in the URL — the link from the
 * drafting page's "Saved as …" box, a bookmark, a pasted URL. It must offer the patient picker and then
 * run, not fail with "needs a launch context".
 */

const session: Session = {
  idToken: 'mock.id.token',
  accessToken: 'mock.access.token',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  claims: { sub: 'mock-viewer', username: 'viewer', name: 'Vera Viewer', groups: ['app-*-viewer'] },
};
const authProvider: AuthProvider = { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };

describe('app runtime without a patient in the URL', () => {
  test('offers the patient picker, then opens the app for the chosen patient', async () => {
    const medplum = await testMedplum();
    const entries = await localRegistrySource(undefined, loadFixtureRegistry).load();
    render(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={authProvider}>
          <MemoryRouter initialEntries={['/apps/app_bp_trend/0.3.0']}>
            <Routes>
              <Route path="/apps/:appId/:version?" element={<AppRuntime registry={entries} config={testConfig} executor={testExecutor} />} />
            </Routes>
          </MemoryRouter>
        </AuthProviderBoundary>
      </Providers>
    );

    const chooser = await screen.findByTestId('choose-patient');
    expect(chooser).toHaveTextContent('This app is about one patient');
    expect(screen.queryByText('This app needs a launch context')).toBeNull();

    fireEvent.click(screen.getByTestId('open-for-patient'));
    await waitFor(() => expect(screen.queryByTestId('choose-patient')).toBeNull());
    // The app runs for the picked (first) synthetic patient.
    await waitFor(() => expect(screen.getByText('Latest readings')).toBeInTheDocument(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText('Anneliese Krüger')).toBeInTheDocument(), { timeout: 4000 });
  }, 15000);
});

/**
 * Opened right after "Save to registry": the list in memory may not include the new app yet. That is a
 * loading state, not an error — the page looks once more and only then says the app does not exist.
 */
describe('app runtime while the registry catches up', () => {
  function mount(entries: Awaited<ReturnType<ReturnType<typeof localRegistrySource>['load']>>, loading: boolean, onRegistryChanged: () => void) {
    return (
      <MemoryRouter initialEntries={['/apps/app_brand_new/0.1.0']}>
        <Routes>
          <Route path="/apps/:appId/:version?" element={<AppRuntime registry={entries} registryLoading={loading} config={testConfig} executor={testExecutor} onRegistryChanged={onRegistryChanged} />} />
        </Routes>
      </MemoryRouter>
    );
  }

  /** A reload the test completes when it wants to. */
  function deferredReload() {
    let finish: () => void = () => {};
    const reload = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    return { reload, finish: () => finish() };
  }

  test('an app that is not in the list yet shows a loader and asks for one refresh; the fresh list renders it', async () => {
    const medplum = await testMedplum();
    const entries = await localRegistrySource(undefined, loadFixtureRegistry).load();
    const { reload, finish } = deferredReload();
    const view = render(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={authProvider}>{mount(entries, false, reload)}</AuthProviderBoundary>
      </Providers>
    );
    await screen.findByTestId('app-loading');
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('No such app')).toBeNull();

    // The fresh list has the app (here: the trend app under a new id) — it renders, and nobody asked twice.
    const trend = entries.find((e) => e.ok && e.manifest.metadata.app_id === 'app_bp_trend');
    if (!trend?.ok) throw new Error('fixture');
    const renamed = { ...trend, manifest: { ...trend.manifest, metadata: { ...trend.manifest.metadata, app_id: 'app_brand_new', version: '0.1.0' } } };
    view.rerender(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={authProvider}>{mount([...entries, renamed], false, reload)}</AuthProviderBoundary>
      </Providers>
    );
    finish();
    await screen.findByTestId('choose-patient');
    expect(reload).toHaveBeenCalledTimes(1);
  }, 15000);

  test('only after a few looks have come back empty does it say the app does not exist', async () => {
    const medplum = await testMedplum();
    const entries = await localRegistrySource(undefined, loadFixtureRegistry).load();
    const reload = vi.fn(async () => {}); // the list index has nothing new, every time
    render(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={authProvider}>{mount(entries, false, reload)}</AuthProviderBoundary>
      </Providers>
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('app-loading')).toBeInTheDocument();
    expect(screen.queryByText('No such app')).toBeNull();
    await screen.findByText('No such app', {}, { timeout: LOOK_AGAIN.attempts * LOOK_AGAIN.spacingMs + 3000 });
    expect(reload).toHaveBeenCalledTimes(LOOK_AGAIN.attempts);
  }, 15000);
});

/**
 * The inspector's audit trail is the browser's view of the app's calls; each row names the record the data source
 * wrote about the call, and for an administrator opens it in the Audit trail section. The forwarded records carry the
 * same id, so in mock mode the panel's own trail holds them under it too.
 */
describe('app runtime inspector and the audit trail', () => {
  test('rows name their trail record and open it for an administrator; the forwarded records carry the same id', async () => {
    const medplum = await testMedplum();
    const entries = await localRegistrySource(undefined, loadFixtureRegistry).load();
    const adminSession: Session = { ...session, claims: { sub: 'mock-ada', username: 'ada', name: 'Ada Admin', groups: ['medapp-admins'] } };
    const adminProvider: AuthProvider = { ...authProvider, restoreSession: async () => adminSession };
    const forwarded: { audit_id?: string; outcome: string }[] = [];
    render(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={adminProvider}>
          <MemoryRouter initialEntries={['/apps/app_bp_trend/0.3.0?patient_id=pat-kms-0001']}>
            <Routes>
              <Route path="/apps/:appId/:version?" element={<AppRuntime registry={entries} config={testConfig} executor={testExecutor} onAudit={(r) => forwarded.push({ audit_id: r.audit_id, outcome: r.outcome })} />} />
              <Route path="/audit" element={<div data-testid="trail-page">trail</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProviderBoundary>
      </Providers>
    );
    await waitFor(() => expect(screen.getByText('Latest readings')).toBeInTheDocument(), { timeout: 4000 });
    await waitFor(() => expect(forwarded.length).toBeGreaterThan(0));
    expect(forwarded.every((r) => r.outcome === 'ok' && r.audit_id?.startsWith('mock-'))).toBe(true);

    fireEvent.click(screen.getByLabelText('Open inspector'));
    const links = await screen.findAllByTestId('audit-open-trail');
    expect(links).toHaveLength(forwarded.length);
    expect(links[0]!.getAttribute('href')).toContain(`/audit?id=${forwarded[0]!.audit_id}&at=`);
    expect(links[0]!.getAttribute('href')).toMatch(/^\/audit\?id=mock-\d{4}-[a-z0-9]+&at=\d{4}-\d{2}-\d{2}T/);
    fireEvent.click(links[0]!);
    expect(await screen.findByTestId('trail-page')).toBeInTheDocument();
  }, 15000);
});
