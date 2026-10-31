import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { daysAround, deepLinkTo, LocalAuditStore, localAuditClient, type AuditClient, type AuditEntry } from '../audit';
import { loadRegistry } from '../manifest/registry';
import { AuditPage, rangeOf } from '../panel/AuditPage';
import { panelSections } from '../panel/PanelShell';
import { theme } from '../theme';
import { localUsersClient, type UsersClient } from '../users';
import { testConfig } from './testUtils';

/**
 * The audit trail — the administrator's view of what happened: the records newest first within the time range, each
 * filter narrowing (kind, outcome, patient, app, person), a record opened in full, the pivots from a record to a
 * person's, an app's or a patient's trail, the cursor, the API's refusals shown as they are, and who gets the section.
 * Over the local client, which keeps the API's rules (default window, 92-day cap, newest first).
 */

const registry = loadRegistry();
const NOW = new Date('2026-10-09T12:00:00.000Z');

function sessionFor(groups: string[], sub = 'sub-ada'): Session {
  return {
    idToken: 'mock.id.token',
    accessToken: 'mock.access.token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    claims: {
      sub,
      username: 'ada',
      name: 'Ada Admin',
      email: 'ada@klinikum-musterstadt.example',
      groups,
    },
  };
}

function providerFor(session: Session): AuthProvider {
  return {
    kind: 'mock',
    restoreSession: async () => session,
    signIn: async () => ({ status: 'signed_in', session }),
    signOut: async () => {},
    forgotPassword: async () => ({}),
    confirmForgotPassword: async () => {},
  };
}

const admin = sessionFor(['medapp-admins', 'medapp-authors']);

function usersFor(session: Session): UsersClient {
  return localUsersClient({
    registry: () => registry,
    caller: () => ({
      sub: session.claims.sub,
      email: session.claims.email,
      name: session.claims.name,
    }),
    delayMs: 0,
  });
}

function renderAudit(session: Session, client: AuditClient, users = usersFor(session), path = '/audit') {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={providerFor(session)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/audit" element={<AuditPage client={client} users={users} registry={registry} config={testConfig} now={() => NOW} />} />
            <Route path="/" element={<div data-testid="home">home</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

function freshClient(store = new LocalAuditStore(undefined, () => NOW)): AuditClient {
  return localAuditClient(store, () => NOW, 0);
}

/** Choose an option of a Mantine Select: the click opens it (jsdom never finishes the transition, so look inside its own list, not for what is visible). */
function pick(testId: string, option: string) {
  const input = screen.getByTestId(testId);
  fireEvent.click(input);
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
  if (!list) throw new Error(`${testId} did not open`);
  fireEvent.click(within(list).getByText(option));
}

const rows = () => screen.getAllByTestId('audit-row');

describe('audit trail', () => {
  it('lists the last seven days newest first — who, what, patient, outcome — and says how many', async () => {
    renderAudit(admin, freshClient());
    await waitFor(() => expect(rows()).toHaveLength(9)); // the ten seeded records minus the one from 26 days ago
    expect(screen.getByTestId('audit-count')).toHaveTextContent('9 records in the last 7 days');
    const first = rows()[0]!;
    expect(first).toHaveTextContent('Lukas Hoffmann');
    expect(first).toHaveTextContent('lukas.hoffmann@klinikum-musterstadt.example');
    expect(first).toHaveTextContent('data.fhir.patient.read');
    expect(first).toHaveTextContent('Patient 360 v1.0.0 · clinician'); // the app named after the registry, the role beside it
    expect(first).toHaveTextContent('pat-kms-0001');
    expect(within(first).getByTestId('audit-outcome')).toHaveTextContent('ok');
    const last = rows()[8]!;
    expect(last).toHaveTextContent('lifecycle.in_review');
    expect(last).toHaveTextContent('Falls risk screen v1.0.0 · draft → in review');
    const refused = rows().find((r) => within(r).getByTestId('audit-outcome').textContent === 'refused')!;
    expect(refused).toHaveTextContent('Karin Neumann');
    expect(refused).toHaveTextContent('patient_scope: cohort');
    const account = rows().find((r) => r.textContent?.includes('platform.user.create'))!;
    expect(account).toHaveTextContent('tobias.brandt@klinikum-musterstadt.example +1');
  });

  it('each filter narrows: kind, outcome, patient, app, person; a wider range brings older records; clearing restores the list', async () => {
    renderAudit(admin, freshClient());
    await waitFor(() => expect(rows()).toHaveLength(9));

    pick('audit-kind', 'Lifecycle');
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().every((r) => r.textContent?.includes('lifecycle.'))).toBe(true);

    pick('audit-outcome-filter', 'refused');
    await waitFor(() => expect(screen.getByTestId('audit-empty')).toHaveTextContent('No records in the last 7 days match these filters.'));

    fireEvent.click(screen.getByTestId('audit-clear'));
    await waitFor(() => expect(rows()).toHaveLength(9));

    fireEvent.change(screen.getByTestId('audit-patient'), {
      target: { value: 'pat-kms-0003' },
    });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent('write.fhir.questionnaire_response.submit');
    expect(rows()[0]).toHaveTextContent('QuestionnaireResponse/qr-1042');
    fireEvent.change(screen.getByTestId('audit-patient'), {
      target: { value: '' },
    });
    await waitFor(() => expect(rows()).toHaveLength(9));

    pick('audit-app', 'Falls risk screen');
    await waitFor(() => expect(rows()).toHaveLength(3));

    pick('audit-user', 'Sabine Weber'); // the accounts of the pool, by name
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().every((r) => r.textContent?.includes('Sabine Weber'))).toBe(true);
    fireEvent.click(screen.getByTestId('audit-clear'));
    await waitFor(() => expect(rows()).toHaveLength(9));

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(screen.getByTestId('audit-count')).toHaveTextContent('10 records in the last 30 days');
    const error = rows()[9]!;
    expect(within(error).getByTestId('audit-outcome')).toHaveTextContent('error');
    expect(error).toHaveTextContent('upstream timeout after 15 s');

    fireEvent.click(screen.getByRole('radio', { name: 'Today' }));
    await waitFor(() => expect(rows()).toHaveLength(4)); // 2 h, 2 h, 5 h and 7 h ago; 26 h ago was yesterday
  });

  it('opens a record in full and pivots from it to the patient trail, the person trail, the app trail', async () => {
    renderAudit(admin, freshClient());
    await waitFor(() => expect(rows()).toHaveLength(9));
    fireEvent.click(rows()[0]!);
    const record = await screen.findByTestId('audit-record');
    expect(record).toHaveTextContent('data.fhir.patient.read');
    expect(record).toHaveTextContent('Lukas Hoffmann · lukas.hoffmann@klinikum-musterstadt.example sub-u-hoffmann');
    expect(record).toHaveTextContent('Recorded bydispatcher');
    expect(record).toHaveTextContent('Patient 360 app_patient_360@1.0.0');
    expect(record).toHaveTextContent('Primitivep_patient');
    expect(record).toHaveTextContent('Roleclinician (granted by group)');
    expect(record).toHaveTextContent('Patientpat-kms-0001');
    expect(record).toHaveTextContent('ResultPatient/pat-kms-0001');
    expect(record).toHaveTextContent('Duration41 ms');
    expect(record).toHaveTextContent('Record idseed-001');
    expect(record).toHaveTextContent('"audit_id": "seed-001"'); // as stored

    fireEvent.click(within(record).getByTestId('audit-filter-patient'));
    await waitFor(() => expect(screen.queryByTestId('audit-record')).not.toBeInTheDocument());
    expect(screen.getByTestId('audit-patient')).toHaveValue('pat-kms-0001');
    await waitFor(() => expect(rows()).toHaveLength(2)); // the read and the query, both for this patient, within the window

    fireEvent.click(rows()[1]!);
    fireEvent.click(within(await screen.findByTestId('audit-record')).getByTestId('audit-filter-person'));
    await waitFor(() => expect(screen.queryByTestId('audit-record')).not.toBeInTheDocument());
    expect(screen.getByTestId('audit-user')).toHaveValue('Lukas Hoffmann');
    fireEvent.change(screen.getByTestId('audit-patient'), {
      target: { value: '' },
    });
    await waitFor(() => expect(rows()).toHaveLength(4)); // Lukas: two reads, a patient search, a lifecycle step

    fireEvent.click(rows()[3]!);
    fireEvent.click(within(await screen.findByTestId('audit-record')).getByTestId('audit-filter-app'));
    await waitFor(() => expect(screen.getByTestId('audit-app')).toHaveValue('Falls risk screen'));
    await waitFor(() => expect(rows()).toHaveLength(1)); // Lukas's one step on that app
  });

  it('follows the cursor with "Load more" until the trail is exhausted', async () => {
    const inner = freshClient();
    const paged: AuditClient = {
      kind: 'local',
      query: (q) => inner.query({ ...q, limit: 4 }),
    };
    renderAudit(admin, paged);
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(screen.getByTestId('audit-count')).toHaveTextContent('4 records in the last 7 days — more follow');
    fireEvent.click(screen.getByTestId('audit-more'));
    await waitFor(() => expect(rows()).toHaveLength(8));
    fireEvent.click(screen.getByTestId('audit-more'));
    await waitFor(() => expect(rows()).toHaveLength(9));
    expect(screen.queryByTestId('audit-more')).not.toBeInTheDocument();
    expect(screen.getByTestId('audit-count')).toHaveTextContent('9 records in the last 7 days');
    expect(new Set(rows().map((r) => r.textContent)).size).toBe(9); // no page repeats a record
  });

  it('shows the API refusal for a range it will not serve, and recovers when the range is fixed', async () => {
    renderAudit(admin, freshClient());
    await waitFor(() => expect(rows()).toHaveLength(9));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByTestId('audit-from'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.change(screen.getByTestId('audit-to'), {
      target: { value: '2026-10-01' },
    });
    expect(await screen.findByTestId('audit-error')).toHaveTextContent('`from` is after `to`');
    fireEvent.change(screen.getByTestId('audit-from'), {
      target: { value: '2026-09-01' },
    });
    await waitFor(() => expect(screen.queryByTestId('audit-error')).not.toBeInTheDocument());
    await waitFor(() => expect(rows()).toHaveLength(1)); // only the 26-day-old error falls between 1 Sep and 1 Oct
    expect(screen.getByTestId('audit-count')).toHaveTextContent('1 record from 2026-09-01 to 2026-10-01');
    fireEvent.change(screen.getByTestId('audit-from'), {
      target: { value: '2026-01-01' },
    });
    expect(await screen.findByTestId('audit-error')).toHaveTextContent('at most 92 days');
  });

  it('keeps what the apps opened in this browser do, attributed to the signed-in person', async () => {
    const store = new LocalAuditStore(undefined, () => NOW);
    store.record(
      {
        timestamp: '2026-10-09T11:59:00.000Z',
        app_id: 'app_patient_360',
        manifest_version: '1.0.0',
        primitive_id: 'p_patient',
        kind: 'data.fhir.patient.read',
        role: 'clinician',
        user_sub: 'sub-ada',
        patient_context: 'pat-kms-0002',
        duration_ms: 3,
        outcome: 'ok',
      },
      { sub: 'sub-ada', name: 'Ada Admin', email: 'ada@klinikum-musterstadt.example' }
    );
    renderAudit(admin, freshClient(store));
    await waitFor(() => expect(rows()).toHaveLength(10));
    const mine = rows()[0]!;
    expect(mine).toHaveTextContent('Ada Admin');
    expect(mine).toHaveTextContent('pat-kms-0002');
    fireEvent.click(mine);
    expect(await screen.findByTestId('audit-record')).toHaveTextContent('Recorded bymock');
  });

  it("opens one record from an app's inspector link, in the days around it, and widens to the whole range on request", async () => {
    const store = new LocalAuditStore(undefined, () => NOW);
    const target = store.all().find((e) => e.audit_id === 'seed-010')!; // the 26-day-old error — outside the default window
    renderAudit(admin, freshClient(store), usersFor(admin), deepLinkTo({ audit_id: target.audit_id, timestamp: target.timestamp }));
    const record = await screen.findByTestId('audit-record'); // opened by itself
    expect(record).toHaveTextContent('Record idseed-010');
    expect(record).toHaveTextContent('upstream timeout after 15 s');
    expect(screen.getByTestId('audit-id-filter')).toHaveTextContent('Record seed-010');
    const days = daysAround(target.timestamp);
    expect(screen.getByTestId('audit-from')).toHaveValue(days.from);
    expect(screen.getByTestId('audit-to')).toHaveValue(days.to);
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId('audit-count')).toHaveTextContent(`1 record from ${days.from} to ${days.to}`);

    fireEvent.click(screen.getByTestId('audit-id-clear'));
    await waitFor(() => expect(screen.queryByTestId('audit-id-filter')).not.toBeInTheDocument());
    await waitFor(() => expect(rows()).toHaveLength(1)); // the same days, every record in them — here still the one
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(rows()).toHaveLength(10));
  });

  it('says so when the record a link names is not in the trail', async () => {
    renderAudit(admin, freshClient(), usersFor(admin), '/audit?id=srv-missing-1&at=2026-10-09T10:00:00.000Z');
    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('No record srv-missing-1 from 2026-10-08 to 2026-10-10');
    expect(screen.queryByTestId('audit-record')).not.toBeInTheDocument();
  });

  it('is for administrators alone; the sidebar names it for them only', async () => {
    renderAudit(sessionFor(['medapp-authors', 'medapp-approvers']), freshClient());
    expect(await screen.findByTestId('home')).toBeInTheDocument();
    expect(panelSections(admin.claims, false).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives', 'User management', 'Audit trail']);
    expect(panelSections(sessionFor(['medapp-approvers']).claims, false).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives']);
  });

  it('names a record and the days around it for the inspector link', () => {
    expect(deepLinkTo({ audit_id: 'a b', timestamp: '2026-10-09T23:30:00.000Z' })).toBe('/audit?id=a+b&at=2026-10-09T23%3A30%3A00.000Z');
    expect(daysAround('2026-10-09T23:30:00.000Z')).toEqual({ from: '2026-10-08', to: '2026-10-10' });
    expect(daysAround('nonsense')).toEqual({ from: '', to: '' });
  });

  it('turns the presets into the query the API expects', () => {
    expect(rangeOf({ preset: '7d', from: '', to: '' }, NOW)).toEqual({}); // the API's own default
    expect(rangeOf({ preset: '30d', from: '', to: '' }, NOW)).toEqual({
      from: '2026-09-09T12:00:00.000Z',
    });
    expect(rangeOf({ preset: 'custom', from: '2026-09-01', to: '' }, NOW)).toEqual({ from: '2026-09-01' });
    expect(rangeOf({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' }, NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const today = rangeOf({ preset: 'today', from: '', to: '' }, NOW).from!;
    expect(new Date(today).getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(NOW.getTime() - new Date(today).getTime()).toBeLessThan(86_400_000);
  });
});

describe('local audit store', () => {
  it('survives a reload through storage and tells its listeners when a record lands', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
    };
    const store = new LocalAuditStore(storage, () => NOW);
    let pings = 0;
    store.subscribe(() => pings++);
    const entry: AuditEntry = {
      audit_id: 'x1',
      timestamp: NOW.toISOString(),
      kind: 'lifecycle.created',
      user_sub: 'sub-ada',
      source: 'mock',
    };
    store.add(entry);
    expect(pings).toBe(1);
    expect(new LocalAuditStore(storage, () => NOW).all().some((e) => e.audit_id === 'x1')).toBe(true);
    expect(new LocalAuditStore(undefined, () => NOW).all()).toHaveLength(10); // without storage: the samples alone
  });
});
