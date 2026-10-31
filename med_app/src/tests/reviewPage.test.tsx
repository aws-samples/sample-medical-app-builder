import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { localAuthoringClient, LocalRegistryStore, type AuthoringClient } from '../authoring';
import { loadRegistry, reviewPath, type RegistryEntry } from '../manifest/registry';
import { AppLauncher } from '../panel/AppLauncher';
import { ReviewPage } from '../panel/ReviewPage';
import { compileSpec } from '../spec';
import { theme } from '../theme';
import { loadRuntimeConfig } from '../config/env';
import { testConfig } from './testUtils';

/**
 * The approver's review page: the version in front of them against the published one — the verdict on access first,
 * then each section of changes — with the sign-off on the same page, under its own rules (never the author). Reached
 * from the Pending sign-off tab and from the inspector; staff only.
 */

type OkEntry = Extract<RegistryEntry, { ok: true }>;

const showcase = loadRegistry();
const register = showcase.find((e): e is OkEntry => e.ok && e.manifest.metadata.app_id === 'app_hypertension_register')!;

function compiled(spec: Record<string, unknown>, state: 'in_review' | 'draft' | 'approved' = 'in_review', author = 'sub-author'): OkEntry {
  const result = compileSpec(spec, { hospital_id: 'hsp-test', created_at: '2026-10-10T09:00:00.000Z', created_by_sub: author });
  if (!result.ok) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return { file: `${spec.app && (spec.app as { app_id: string }).app_id}.yaml`, ok: true, manifest: { ...result.manifest, lifecycle: { ...result.manifest.lifecycle, state } }, meta: { spec, owner_sub: author, created_by_sub: author, author: { name: 'Lukas Hoffmann' } } };
}

/** v1.1.0 of the register, in review: a research role added (a widening) and the threshold moved. */
function nextRegister(): OkEntry {
  const spec = JSON.parse(JSON.stringify(register.meta!.spec)) as Record<string, unknown>;
  (spec.app as Record<string, unknown>).version = '1.1.0';
  (spec.app as Record<string, unknown>).parent_version = '1.0.0';
  ((spec.knobs as Record<string, unknown>).value as Record<string, unknown>).threshold = 130;
  (spec.roles as Record<string, unknown>[]).push({ id: 'research', display_name: 'Research office', phi_fields_visible: ['name', 'dob', 'mrn', 'address'], capabilities: ['view', 'export_csv'] });
  return compiled(spec);
}

/** A brand-new app, first version, in review. */
function firstVersion(): OkEntry {
  const spec = JSON.parse(JSON.stringify(register.meta!.spec)) as Record<string, unknown>;
  (spec.app as Record<string, unknown>).app_id = 'app_diabetes_register';
  (spec.app as Record<string, unknown>).name = 'Diabetes register';
  return compiled(spec);
}

function sessionFor(groups: string[], sub = 'sub-ada'): Session {
  return { idToken: 't', accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600, claims: { sub, username: sub, name: sub === 'sub-ada' ? 'Ada Approver' : 'Lukas Hoffmann', groups } };
}

function providerFor(session: Session): AuthProvider {
  return { kind: 'mock', restoreSession: async () => session, signIn: async () => ({ status: 'signed_in', session }), signOut: async () => {}, forgotPassword: async () => ({}), confirmForgotPassword: async () => {} };
}

/** The sign-off buttons only need a client to exist; what they would do is the lifecycle tests' business. */
function authoringFor(session: Session): AuthoringClient {
  return localAuthoringClient({ hospitalId: 'hsp-test', getCallerSub: () => session.claims.sub, registry: new LocalRegistryStore(), knownVersions: () => undefined });
}

/** A deployment's rules (separation of duties enforced); mock mode lets one person play every part. */
const deployedConfig = loadRuntimeConfig({ VITE_HOSPITAL_ID: 'hsp-test', VITE_AUTH_MODE: 'cognito', VITE_COGNITO_USER_POOL_ID: 'eu-central-1_test', VITE_COGNITO_CLIENT_ID: 'client', VITE_COGNITO_REGION: 'eu-central-1', VITE_DATA_MODE: 'mock' });

function renderReview(session: Session, registry: RegistryEntry[], entry: OkEntry, authoring?: AuthoringClient, config = deployedConfig) {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={providerFor(session)}>
        <MemoryRouter initialEntries={[reviewPath(entry)]}>
          <Routes>
            <Route path="/apps/:appId/:version/review" element={<ReviewPage registry={registry} config={config} authoring={authoring} />} />
            <Route path="/" element={<div data-testid="home">home</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

const approver = sessionFor(['medapp-approvers']);
const author = sessionFor(['medapp-authors'], 'sub-author');

describe('the review page', () => {
  it('names the published version it compares with, gives the verdict on access first, then the sections, and offers the sign-off', async () => {
    const next = nextRegister();
    const registry = [...showcase, next];
    renderReview(approver, registry, next, authoringFor(approver));
    expect(await screen.findByTestId('review-baseline')).toHaveTextContent('Compared with v1.0.0, the published version');
    expect(screen.getByTestId('review-state')).toHaveTextContent('in review');
    expect(screen.getByText('By: Lukas Hoffmann')).toBeInTheDocument();
    // how the version in use was approved — from its sign-off, since the showcase manifests carry no events
    expect(screen.getByTestId('review-baseline-approval')).toHaveTextContent('v1.0.0 was approved by example-approver-sub on');
    expect(screen.getByTestId('review-baseline-approval')).toHaveTextContent('Listing of patients by a coded diagnosis');

    const verdict = screen.getByTestId('review-verdict');
    expect(verdict).toHaveTextContent('Access widened — 1 way');
    expect(within(verdict).getByTestId('review-widenings')).toHaveTextContent('Role Research office — granted by app-app_hypertension_register-research');

    const roles = screen.getByTestId('review-section-roles');
    expect(within(roles).getAllByTestId('review-change')).toHaveLength(1);
    expect(roles).toHaveTextContent('wider access');
    expect(roles).toHaveTextContent('sees name, dob, mrn, address');
    const settings = screen.getByTestId('review-section-settings');
    expect(settings).toHaveTextContent('value.threshold');
    expect(settings).toHaveTextContent('140');
    expect(settings).toHaveTextContent('130');
    expect(screen.getByTestId('review-section-primitives')).toHaveTextContent('threshold.value: 140 → 130');
    expect(screen.queryByTestId('review-section-forms')).not.toBeInTheDocument(); // nothing changed there
    expect(screen.getByTestId('review-unchanged')).toHaveTextContent('Unchanged: purpose and governance, actions, forms, launch context.');

    expect(screen.getByTestId('review-open')).toHaveAttribute('href', '/apps/app_hypertension_register/1.1.0');
    expect(screen.getByTestId('review-open-baseline')).toHaveAttribute('href', '/apps/app_hypertension_register');

    const signoff = screen.getByTestId('review-signoff');
    expect(within(signoff).getByTestId('transition-approved')).toBeInTheDocument();
    expect(within(signoff).getByTestId('transition-draft')).toHaveTextContent('Send back to draft');
    expect(within(signoff).queryByTestId('what-changed')).not.toBeInTheDocument(); // this is that page

    fireEvent.click(screen.getByTestId('review-text-toggle'));
    const text = await screen.findByTestId('review-text-body');
    expect(text).toHaveTextContent('threshold: 140');
    expect(text).toHaveTextContent('threshold: 130');
    expect(text).toHaveTextContent('unchanged lines');
    expect(screen.getByTestId('review-text')).toHaveTextContent('the specs');
  });

  it("the author sees the same review but cannot approve their own version; a clinician is not let in", async () => {
    const next = nextRegister();
    const registry = [...showcase, next];
    renderReview(author, registry, next, authoringFor(author));
    await screen.findByTestId('review-verdict');
    const signoff = screen.getByTestId('review-signoff');
    expect(within(signoff).queryByTestId('transition-approved')).not.toBeInTheDocument();
    expect(within(signoff).getByTestId('transition-draft')).toBeInTheDocument(); // the author may take it back

    renderReview(sessionFor(['app-app_hypertension_register-hypertension_clinic'], 'sub-clinician'), registry, next);
    expect(await screen.findByTestId('home')).toBeInTheDocument();
  });

  it('in mock mode one person plays every part: the author gets the Approve button too, as the inspector does', async () => {
    const next = nextRegister();
    const registry = [...showcase, next];
    renderReview(author, registry, next, authoringFor(author), testConfig);
    await screen.findByTestId('review-verdict');
    expect(within(screen.getByTestId('review-signoff')).getByTestId('transition-approved')).toBeInTheDocument();
  });

  it('a first version is reviewed whole: everything is new, nothing to compare with', async () => {
    const first = firstVersion();
    const registry = [...showcase, first];
    renderReview(approver, registry, first);
    expect(await screen.findByTestId('review-baseline')).toHaveTextContent('A first version: nothing is published yet');
    expect(screen.getByTestId('review-verdict')).toHaveTextContent('A first version — review the whole of it');
    expect(screen.getByTestId('review-section-roles')).toHaveTextContent('Role Hypertension clinic');
    expect(screen.getByTestId('review-section-roles')).not.toHaveTextContent('wider access'); // new, not wider: there was nothing before
    expect(screen.getByTestId('review-section-purpose')).toHaveTextContent('Intended purpose');
    expect(screen.queryByTestId('review-open-baseline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-unchanged')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-signoff')).not.toBeInTheDocument(); // no authoring client given: read-only
  });

  it('a version that is not in the registry is said to be missing', async () => {
    const ghost: OkEntry = { ...register, manifest: { ...register.manifest, metadata: { ...register.manifest.metadata, version: '9.9.9' } } };
    renderReview(approver, showcase, ghost);
    expect(await screen.findByText('No such version')).toBeInTheDocument();
  });

  it('the Pending sign-off tab offers Review next to Open, leading to the page', async () => {
    const next = nextRegister();
    render(
      <MantineProvider theme={theme}>
        <AuthProviderBoundary provider={providerFor(approver)}>
          <MemoryRouter>
            <AppLauncher registry={[...showcase, next]} config={testConfig} />
          </MemoryRouter>
        </AuthProviderBoundary>
      </MantineProvider>
    );
    fireEvent.click(await screen.findByTestId('tab-review'));
    const pending = await screen.findByTestId('review-versions');
    await waitFor(() => expect(within(pending).getAllByTestId('review-version')).toHaveLength(1));
    expect(within(pending).getByTestId('review-version')).toHaveAttribute('href', '/apps/app_hypertension_register/1.1.0/review');
  });
});
