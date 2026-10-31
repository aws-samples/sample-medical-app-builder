import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { loadRuntimeConfig } from '../config/env';
import { loadRegistry, presentVersions, type RegistryEntry } from '../manifest/registry';
import { AppLauncher, cannotOpenBecause } from '../panel/AppLauncher';
import { AppRuntime } from '../panel/AppRuntime';
import { theme } from '../theme';
import { Providers, testConfig, testExecutor, testMedplum } from './testUtils';

/**
 * The registry's tabs for staff: published apps, drafts, pending sign-off — and the deprecated versions, which get a
 * tab of their own, each saying why it is out of service (superseded by a published version, or retired).
 */

function sessionFor(groups: string[]): Session {
  return { idToken: 't', accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub: 'sub-x', username: 'x', name: 'X', groups } };
}

function providerFor(session: Session): AuthProvider {
  return { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
}

type Valid = Extract<RegistryEntry, { ok: true }>;

/** The showcase set plus two deprecated versions: an older hypertension register (superseded) and a retired app (no published version). */
function registryWithDeprecated(): RegistryEntry[] {
  const published = loadRegistry();
  const register = published.find((e): e is Valid => e.ok && e.manifest.metadata.app_id === 'app_hypertension_register')!;
  const superseded: Valid = {
    file: 'hypertension-register-0.9.yaml',
    ok: true,
    manifest: { ...register.manifest, metadata: { ...register.manifest.metadata, version: '0.9.0' }, lifecycle: { ...register.manifest.lifecycle, state: 'deprecated' } },
  };
  const retired: Valid = {
    file: 'ward-board.yaml',
    ok: true,
    manifest: {
      ...register.manifest,
      metadata: { ...register.manifest.metadata, app_id: 'app_ward_board', name: 'Ward board', description: 'A register nobody uses any more.', version: '1.2.0' },
      lifecycle: { ...register.manifest.lifecycle, state: 'deprecated' },
    },
  };
  return [...published, superseded, retired];
}

function renderLauncher(groups: string[], registry: RegistryEntry[], config = testConfig, searchPatients?: (name: string) => Promise<never[]>) {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={providerFor(sessionFor(groups))}>
        <MemoryRouter>
          <AppLauncher registry={registry} config={config} searchPatients={searchPatients} />
        </MemoryRouter>
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

/** The showcase set with attribution: one version by a named person, one by someone with an email only, one by the signed-in person. */
function registryWithAuthors(): RegistryEntry[] {
  return loadRegistry().map((e): RegistryEntry => {
    if (!e.ok) return e;
    switch (e.manifest.metadata.app_id) {
      case 'app_hypertension_register':
        return { ...e, meta: { ...e.meta, owner_sub: 'sub-lukas', created_by_sub: 'sub-lukas', author: { name: 'Lukas Hoffmann', email: 'lukas.hoffmann@klinikum-musterstadt.example' } } };
      case 'app_patient_360':
        return { ...e, meta: { ...e.meta, owner_sub: 'sub-m', created_by_sub: 'sub-m', author: { email: 'm.schulz@klinikum-musterstadt.example' } } };
      case 'app_tumour_board':
        return { ...e, meta: { ...e.meta, owner_sub: 'sub-x', created_by_sub: 'sub-x', author: { name: 'X' } } }; // the signed-in person (sessionFor → sub-x)
      default:
        return e;
    }
  });
}

describe('what the local registry presents', () => {
  it('keeps the published version, its newer successor and every deprecated version — a superseded one must not vanish', () => {
    const presented = presentVersions(registryWithDeprecated());
    const register = presented.filter((e): e is Valid => e.ok && e.manifest.metadata.app_id === 'app_hypertension_register');
    expect(register.map((e) => [e.manifest.metadata.version, e.manifest.lifecycle.state])).toEqual([
      ['1.0.0', 'published'],
      ['0.9.0', 'deprecated'],
    ]);
    const retired = presented.filter((e): e is Valid => e.ok && e.manifest.metadata.app_id === 'app_ward_board');
    expect(retired.map((e) => [e.manifest.metadata.version, e.manifest.lifecycle.state])).toEqual([['1.2.0', 'deprecated']]); // the retired version is the newest: listed once
  });
});

describe('the registry tabs', () => {
  it('deprecated versions sit in their own tab, named superseded or retired, and leave the published list', async () => {
    const registry = registryWithDeprecated();
    renderLauncher(['medapp-approvers'], registry);
    const published = await screen.findByRole('tab', { name: /Published apps/ });
    expect(published).toHaveTextContent('13');
    expect(screen.getAllByTestId('app-row-app_hypertension_register')).toHaveLength(1); // the published 1.0.0 only
    expect(screen.queryByTestId('app-row-app_ward_board')).toBeNull();

    const tab = screen.getByTestId('tab-deprecated');
    expect(tab).toHaveTextContent('2');
    fireEvent.click(tab);
    const panel = await screen.findByTestId('deprecated-versions');
    expect(panel).toHaveTextContent('Clinicians no longer see or open them');
    const rows = within(panel).getAllByTestId(/app-row-/);
    expect(rows).toHaveLength(2);
    const register = within(panel).getByTestId('app-row-app_hypertension_register');
    expect(register).toHaveTextContent('0.9.0');
    expect(within(register).getByTestId('deprecated-why')).toHaveTextContent('Superseded by 1.0.0');
    const ward = within(panel).getByTestId('app-row-app_ward_board');
    expect(within(ward).getByTestId('deprecated-why')).toHaveTextContent('Retired — no published version');
    // Staff may still open a deprecated version for reference.
    expect(within(ward).getByRole('link', { name: 'Open' })).not.toHaveAttribute('data-disabled');
  });

  it('a clinician sees neither the tabs nor a deprecated version — the registry API would not have sent one', async () => {
    const registry = registryWithDeprecated();
    const clinician = { ...testConfig, auth: { ...testConfig.auth, mode: 'cognito' as const } };
    renderLauncher(['medapp-viewers'], registry, clinician);
    await screen.findAllByTestId(/app-card-/); // clinicians browse cards, not a table
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByTestId('app-card-app_ward_board')).toBeNull();
    expect(screen.getAllByTestId('app-card-app_hypertension_register')).toHaveLength(1);
  });
});

describe('narrowing the registry and knowing whose app it is', () => {
  it('filters by name across the tabs, and "Only my apps" keeps what the signed-in person made', async () => {
    renderLauncher(['medapp-authors'], registryWithAuthors());
    await screen.findAllByTestId(/app-row-/);
    expect(screen.getByRole('tab', { name: /Published apps/ })).toHaveTextContent('13');
    fireEvent.change(screen.getByTestId('registry-filter'), { target: { value: 'HYPERTENSION' } });
    expect(screen.getByTestId('registry-narrowed')).toHaveTextContent('3 of 13 entries shown');
    expect(screen.getByRole('tab', { name: /Published apps/ })).toHaveTextContent('3');
    expect(screen.getAllByTestId(/app-row-/).map((r) => r.getAttribute('data-testid'))).toEqual(['app-row-app_htn_assessment_due', 'app-row-app_hypertension_follow_up', 'app-row-app_hypertension_register']); // the due list says "hypertension" in its description
    fireEvent.change(screen.getByTestId('registry-filter'), { target: { value: 'imaging in MPR' } }); // the description counts too
    expect(screen.getAllByTestId(/app-row-/).map((r) => r.getAttribute('data-testid'))).toEqual(['app-row-app_tumour_board']);
    fireEvent.change(screen.getByTestId('registry-filter'), { target: { value: '' } });
    expect(screen.queryByTestId('registry-narrowed')).toBeNull();

    fireEvent.click(screen.getByTestId('registry-only-mine'));
    expect(screen.getByTestId('registry-narrowed')).toHaveTextContent('1 of 13 entries shown');
    expect(screen.getAllByTestId(/app-row-/).map((r) => r.getAttribute('data-testid'))).toEqual(['app-row-app_tumour_board']);
  });

  it('a manifest refused only for keys this page does not know is named as the newer platform\'s work, with the reload as the way out', async () => {
    // A colleague's screenshot (2026-10-12): a tab open across a deploy, four apps with designed forms each "Unrecognized key: artifacts".
    const stale: RegistryEntry[] = [
      ...loadRegistry(),
      { file: 'app_physio_akte@0.1.0', ok: false, name: 'Physiotherapie Patientenakte', issues: [{ path: '(root)', message: 'Unrecognized key: "artifacts"' }] },
      { file: 'app_broken@0.1.0', ok: false, name: 'Broken', issues: [{ path: 'auth.roles', message: 'Too small: expected array to have >=1 items' }] },
    ];
    renderLauncher(['medapp-authors'], stale);
    await screen.findAllByTestId(/app-row-/);
    expect(screen.getByText('Rejected by the registry')).toBeInTheDocument();
    expect(screen.getByTestId('rejected-newer-app_physio_akte@0.1.0')).toHaveTextContent('newer version of the platform than this page was loaded with. Reload the page');
    expect(screen.queryByTestId('rejected-newer-app_broken@0.1.0')).toBeNull(); // a real problem stays a real problem
  });

  it('a clinician gets the name filter but not the ownership toggle', async () => {
    const clinician = { ...testConfig, auth: { ...testConfig.auth, mode: 'cognito' as const } };
    renderLauncher(['medapp-viewers'], registryWithAuthors(), clinician);
    await screen.findAllByTestId(/app-card-/);
    expect(screen.getByTestId('registry-filter')).toBeInTheDocument();
    expect(screen.queryByTestId('registry-only-mine')).toBeNull();
  });

  it('says who made a version — a name, or the email when that is all the token had — and nothing for versions without an author', async () => {
    renderLauncher(['medapp-authors'], registryWithAuthors());
    await screen.findAllByTestId(/app-row-/);
    expect(within(screen.getByTestId('app-row-app_hypertension_register')).getByTestId('author-line')).toHaveTextContent('By: Lukas Hoffmann');
    expect(within(screen.getByTestId('app-row-app_patient_360')).getByTestId('author-line')).toHaveTextContent('By: m.schulz@klinikum-musterstadt.example');
    expect(within(screen.getByTestId('app-row-app_cardio_renal')).queryByTestId('author-line')).toBeNull();
  });

  it('a disabled Open says why: no patient chosen, no role, not published', async () => {
    // Against a hospital record no patient is chosen until one is picked: single-patient apps wait, population apps open.
    const dispatcher = loadRuntimeConfig({ VITE_HOSPITAL_ID: 'hsp-test', VITE_AUTH_MODE: 'cognito', VITE_DATA_MODE: 'dispatcher', VITE_API_BASE_URL: 'https://api.example' });
    renderLauncher(['medapp-approvers'], registryWithAuthors(), dispatcher, async () => []);
    await screen.findAllByTestId(/app-row-/);
    const single = screen.getByTestId('app-row-app_patient_360');
    const population = screen.getByTestId('app-row-app_hypertension_register');
    expect(within(single).getByRole('link', { name: 'Open' })).toHaveAttribute('data-disabled', 'true');
    expect(within(single).getByTestId('open-disabled')).toHaveAttribute('aria-label', 'This app is about one patient. Choose a patient above to open it.');
    expect(within(population).getByRole('link', { name: 'Open' })).not.toHaveAttribute('data-disabled');
    expect(within(population).queryByTestId('open-disabled')).toBeNull();
    // The tooltip itself appears on hover.
    fireEvent.mouseEnter(within(single).getByTestId('open-disabled'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Choose a patient above'));

    const m = registryWithAuthors().find((e) => e.ok && e.manifest.metadata.app_id === 'app_patient_360')!;
    if (!m.ok) throw new Error('fixture');
    expect(cannotOpenBecause({ canOpen: false, reason: 'no_role', manifest: m.manifest }, true)).toMatch(/no role for this app/);
    expect(cannotOpenBecause({ canOpen: false, reason: 'not_published', manifest: m.manifest }, true)).toMatch(/Not published yet/);
    expect(cannotOpenBecause({ canOpen: true, manifest: m.manifest }, true)).toBeUndefined();
  });

  it("the opened app says who made it, under its description", async () => {
    const medplum = await testMedplum();
    render(
      <Providers medplum={medplum}>
        <AuthProviderBoundary provider={providerFor(sessionFor(['medapp-viewers']))}>
          <MemoryRouter initialEntries={['/apps/app_hypertension_register']}>
            <Routes>
              <Route path="/apps/:appId/:version?" element={<AppRuntime registry={registryWithAuthors()} config={testConfig} executor={testExecutor} />} />
            </Routes>
          </MemoryRouter>
        </AuthProviderBoundary>
      </Providers>
    );
    const line = await screen.findByTestId('author-line', {}, { timeout: 4000 });
    expect(line).toHaveTextContent('By: Lukas Hoffmann');
    expect(screen.getByText('Patients with a hypertension diagnosis and their most recent blood pressure, flagged from 140 mmHg systolic.')).toBeInTheDocument();
  });
});
