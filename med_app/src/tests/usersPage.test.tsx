import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProviderBoundary } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { loadRegistry } from '../manifest/registry';
import { panelSections, PanelShell } from '../panel/PanelShell';
import { UsersPage } from '../panel/UsersPage';
import { theme } from '../theme';
import { describeAppRoleGroups, localUsersClient, partitionGroups, UsersApiError, type UsersClient } from '../users';
import { testConfig } from './testUtils';

/**
 * User management — the administrator's section. The accounts of the pool with their groups, registering a person
 * (account + invitation), the drawer that changes groups and access, the two lock-out guards, and who gets the
 * section at all. Over the local client, which keeps the Lambda's rules.
 */

const registry = loadRegistry();

function sessionFor(groups: string[], sub = 'sub-ada'): Session {
  return {
    idToken: 'mock.id.token',
    accessToken: 'mock.access.token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    claims: { sub, username: 'ada', name: 'Ada Admin', email: 'ada@klinikum-musterstadt.example', groups },
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

function clientFor(session: Session): UsersClient {
  return localUsersClient({ registry: () => registry, caller: () => ({ sub: session.claims.sub, email: session.claims.email, name: session.claims.name }), delayMs: 0 });
}

function renderUsers(session: Session, client = clientFor(session), path = '/users') {
  return render(
    <MantineProvider theme={theme}>
      <AuthProviderBoundary provider={providerFor(session)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/users" element={<UsersPage client={client} registry={registry} config={testConfig} />} />
            <Route path="/" element={<div data-testid="home">home</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProviderBoundary>
    </MantineProvider>
  );
}

const admin = sessionFor(['medapp-admins', 'medapp-authors']);

describe('user management', () => {
  it('lists the accounts with their platform badges and app roles named after the apps, and narrows by email', async () => {
    renderUsers(admin);
    const rows = await screen.findAllByTestId('user-row');
    expect(rows).toHaveLength(6); // five seeded accounts and the signed-in administrator
    expect(screen.getByText('(you)')).toBeInTheDocument();
    const me = rows.find((r) => within(r).queryByText('(you)'))!;
    expect(within(me).getByText('Admin')).toBeInTheDocument();
    expect(within(me).getByText('Author')).toBeInTheDocument();
    const karin = rows.find((r) => within(r).queryByText('Karin Neumann'))!;
    expect(karin).toHaveTextContent('Hypertension follow-up visit · Hypertension nurse, Hypertension register · Hypertension clinic');
    expect(within(karin).getByTestId('account-state')).toHaveTextContent('Active');
    const schulz = rows.find((r) => within(r).queryByText('m.schulz@klinikum-musterstadt.example'))!;
    expect(within(schulz).getByTestId('account-state')).toHaveTextContent('Disabled');
    const brandt = rows.find((r) => within(r).queryByText('Tobias Brandt'))!;
    expect(within(brandt).getByTestId('account-state')).toHaveTextContent('Invited');

    fireEvent.change(screen.getByTestId('users-search'), { target: { value: 'karin' } });
    await waitFor(() => expect(screen.getAllByTestId('user-row')).toHaveLength(1));
    expect(screen.getByTestId('users-count')).toHaveTextContent('1 account');
  });

  it('registers a person: the account appears as invited with the chosen groups, a duplicate is refused in the form', async () => {
    renderUsers(admin);
    await screen.findAllByTestId('user-row');
    fireEvent.click(screen.getByTestId('register-user'));
    fireEvent.change(await screen.findByTestId('register-email'), { target: { value: 'Nina.Vogel@klinikum-musterstadt.example' } });
    fireEvent.change(screen.getByTestId('register-given'), { target: { value: 'Nina' } });
    fireEvent.change(screen.getByTestId('register-family'), { target: { value: 'Vogel' } });
    fireEvent.click(screen.getByTestId('register-group-medapp-viewers'));
    fireEvent.click(screen.getByTestId('register-group-app-app_hypertension_register-hypertension_clinic'));
    fireEvent.click(screen.getByTestId('register-submit'));
    await screen.findByTestId('users-notice');
    expect(screen.getByTestId('users-notice')).toHaveTextContent('nina.vogel@klinikum-musterstadt.example is registered. The invitation email carries a temporary password');
    const row = screen.getAllByTestId('user-row').find((r) => within(r).queryByText('Nina Vogel'))!;
    expect(row).toHaveTextContent('nina.vogel@klinikum-musterstadt.example');
    expect(within(row).getByText('Viewer')).toBeInTheDocument();
    expect(row).toHaveTextContent('Hypertension register · Hypertension clinic');
    expect(within(row).getByTestId('account-state')).toHaveTextContent('Invited');

    fireEvent.click(screen.getByTestId('register-user'));
    fireEvent.change(await screen.findByTestId('register-email'), { target: { value: 'nina.vogel@klinikum-musterstadt.example' } });
    fireEvent.click(screen.getByTestId('register-submit'));
    expect(await screen.findByTestId('register-error')).toHaveTextContent('already exists');
  });

  it('the drawer collects group changes and saves them in one request; access changes at once; an administrator cannot lock themselves out', async () => {
    const calls: { username: string; patch: unknown }[] = [];
    const inner = clientFor(admin);
    const client: UsersClient = { ...inner, update: (username, patch) => (calls.push({ username, patch }), inner.update(username, patch)) };
    renderUsers(admin, client);
    const rows = await screen.findAllByTestId('user-row');
    const karin = rows.find((r) => within(r).queryByText('Karin Neumann'))!;
    fireEvent.click(within(karin).getByTestId('manage-user'));
    const drawer = await screen.findByTestId('manage-drawer');
    expect(drawer).toHaveTextContent('karin.neumann@klinikum-musterstadt.example');
    expect(within(drawer).getByTestId('group-app-app_hypertension_register-hypertension_clinic')).toBeChecked();
    expect(within(drawer).getByTestId('group-medapp-approvers')).not.toBeChecked();
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('No unsaved changes');
    expect(screen.getByTestId('groups-save')).toBeDisabled();

    // Ticking changes the form, not the account: the pending count moves, the table does not, nothing is sent.
    fireEvent.click(within(drawer).getByTestId('group-medapp-approvers'));
    fireEvent.click(within(drawer).getByTestId('group-medapp-viewers'));
    fireEvent.click(within(drawer).getByTestId('group-app-app_hypertension_register-hypertension_clinic'));
    expect(within(drawer).getByTestId('group-medapp-approvers')).toBeChecked();
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('3 unsaved changes');
    expect(calls).toEqual([]);
    expect(within(screen.getAllByTestId('user-row').find((r) => within(r).queryByText('Karin Neumann'))!).queryByText('Approver')).toBeNull();

    // Ticking one back is no change at all; discarding returns to what is held.
    fireEvent.click(within(drawer).getByTestId('group-medapp-viewers'));
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('2 unsaved changes');
    fireEvent.click(screen.getByTestId('groups-discard'));
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('No unsaved changes');
    expect(within(drawer).getByTestId('group-medapp-approvers')).not.toBeChecked();
    expect(within(drawer).getByTestId('group-app-app_hypertension_register-hypertension_clinic')).toBeChecked();

    // Save: one request with every addition and removal; the row and the form follow.
    fireEvent.click(within(drawer).getByTestId('group-medapp-approvers'));
    fireEvent.click(within(drawer).getByTestId('group-app-app_hypertension_register-hypertension_clinic'));
    fireEvent.click(screen.getByTestId('groups-save'));
    await waitFor(() => expect(screen.getByTestId('users-notice')).toHaveTextContent('Groups saved for Karin Neumann: 2 changes.'));
    expect(calls).toEqual([{ username: 'u-neumann', patch: { add_groups: ['medapp-approvers'], remove_groups: ['app-app_hypertension_register-hypertension_clinic'] } }]);
    expect(within(screen.getAllByTestId('user-row').find((r) => within(r).queryByText('Karin Neumann'))!).getByText('Approver')).toBeInTheDocument();
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('No unsaved changes');
    expect(within(drawer).getByTestId('group-medapp-approvers')).toBeChecked();

    // Access is a single deliberate action, done at once.
    expect(within(drawer).getByTestId('toggle-enabled')).toHaveTextContent('Disable access');
    fireEvent.click(within(drawer).getByTestId('toggle-enabled'));
    await waitFor(() => expect(within(drawer).getByTestId('toggle-enabled')).toHaveTextContent('Enable access'));
    expect(within(drawer).getByTestId('account-state')).toHaveTextContent('Disabled');
    expect(screen.getByTestId('users-notice')).toHaveTextContent("Karin Neumann's access is disabled.");
    expect(within(drawer).queryByTestId('resend-invitation')).toBeNull(); // confirmed accounts recover their password themselves
    expect(calls).toHaveLength(2);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    const me = screen.getAllByTestId('user-row').find((r) => within(r).queryByText('(you)'))!;
    fireEvent.click(within(me).getByTestId('manage-user'));
    const mine = await screen.findByTestId('manage-drawer');
    await waitFor(() => expect(mine).toHaveTextContent('ada@klinikum-musterstadt.example'));
    expect(within(mine).getByTestId('group-medapp-admins')).toBeChecked();
    expect(within(mine).getByTestId('group-medapp-admins')).toBeDisabled();
    expect(within(mine).getByTestId('toggle-enabled')).toBeDisabled();
    expect(mine).toHaveTextContent('You cannot disable your own account.');
    // Other groups of one's own are fair game.
    fireEvent.click(within(mine).getByTestId('group-medapp-authors'));
    fireEvent.click(screen.getByTestId('groups-save'));
    await waitFor(() => expect(within(screen.getAllByTestId('user-row').find((r) => within(r).queryByText('(you)'))!).queryByText('Author')).toBeNull());
    expect(calls.at(-1)).toEqual({ username: 'u-sub-ada', patch: { add_groups: [], remove_groups: ['medapp-authors'] } });
  });

  it('a refused save keeps the form as it was, with the reason', async () => {
    const inner = clientFor(admin);
    const client: UsersClient = { ...inner, update: async () => { throw new UsersApiError(400, "Not a group in this hospital's user pool: medapp-approvers."); } };
    renderUsers(admin, client);
    const rows = await screen.findAllByTestId('user-row');
    fireEvent.click(within(rows.find((r) => within(r).queryByText('Karin Neumann'))!).getByTestId('manage-user'));
    const drawer = await screen.findByTestId('manage-drawer');
    fireEvent.click(within(drawer).getByTestId('group-medapp-approvers'));
    fireEvent.click(screen.getByTestId('groups-save'));
    expect(await within(drawer).findByTestId('manage-error')).toHaveTextContent('Not a group in this hospital');
    expect(within(drawer).getByTestId('group-medapp-approvers')).toBeChecked(); // still ticked: fix and save again, or discard
    expect(screen.getByTestId('groups-pending')).toHaveTextContent('1 unsaved change');
  });

  it('an invited account can have its invitation re-sent from the drawer', async () => {
    renderUsers(admin);
    const rows = await screen.findAllByTestId('user-row');
    const brandt = rows.find((r) => within(r).queryByText('Tobias Brandt'))!;
    fireEvent.click(within(brandt).getByTestId('manage-user'));
    const drawer = await screen.findByTestId('manage-drawer');
    fireEvent.click(within(drawer).getByTestId('resend-invitation'));
    await waitFor(() => expect(screen.getByTestId('users-notice')).toHaveTextContent('A new invitation is on its way to tobias.brandt@klinikum-musterstadt.example.'));
  });

  it('is for administrators: others are sent home, and the sidebar names the section for admins only', async () => {
    renderUsers(sessionFor(['medapp-authors']));
    expect(await screen.findByTestId('home')).toBeInTheDocument();

    expect(panelSections(sessionFor(['medapp-admins']).claims, false).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives', 'User management', 'Audit trail']);
    expect(panelSections(sessionFor(['medapp-authors']).claims, false).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives']);
    expect(panelSections(sessionFor(['medapp-approvers']).claims, false).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives']);
    expect(panelSections(sessionFor(['app-app_patient_360-clinician']).claims, false)).toEqual([]); // a clinician: the registry alone, no sidebar
    expect(panelSections(sessionFor([]).claims, true).map((s) => s.label)).toEqual(['App registry', 'Record shapes', 'Components and data primitives']); // mock mode: everyone is staff, admin still needs the group

    render(
      <MantineProvider theme={theme}>
        <AuthProviderBoundary provider={providerFor(sessionFor(['app-app_patient_360-clinician']))}>
          <MemoryRouter>
            <PanelShell isMock={false}>
              <div>page</div>
            </PanelShell>
          </MemoryRouter>
        </AuthProviderBoundary>
      </MantineProvider>
    );
    await screen.findByText('page');
    expect(screen.queryByTestId('panel-nav')).toBeNull();
  });
});

describe('the local users client keeps the API rules', () => {
  const session = sessionFor(['medapp-admins']);

  it('refuses the lock-out moves, unknown groups and a re-sent invitation after the first sign-in', async () => {
    const client = clientFor(session);
    const { users } = await client.list();
    const me = users.find((u) => u.sub === session.claims.sub)!;
    await expect(client.update(me.username, { enabled: false })).rejects.toMatchObject({ status: 400, message: 'You cannot disable your own account.' } satisfies Partial<UsersApiError>);
    await expect(client.update(me.username, { remove_groups: ['medapp-admins'] })).rejects.toMatchObject({ status: 400 });
    await expect(client.update('u-neumann', { add_groups: ['medapp-root'] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('medapp-root') });
    await expect(client.update('u-neumann', { add_groups: ['x'], remove_groups: ['x'] })).rejects.toMatchObject({ status: 400 });
    await expect(client.update('ghost', { enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(client.resendInvitation('u-neumann')).rejects.toMatchObject({ status: 409 });
    await expect(client.register({ email: 'nope' })).rejects.toMatchObject({ status: 400 });
    const nurse = await client.update('u-neumann', { add_groups: ['medapp-viewers', 'medapp-viewers'], remove_groups: ['app-app_hypertension_register-hypertension_clinic'] });
    expect(nurse.groups).toEqual(['app-app_hypertension_follow_up-hypertension_nurse', 'medapp-viewers']);
  });

  it("the pool's groups are the four platform groups and the published apps' role groups, named after the manifests", async () => {
    const client = clientFor(session);
    const groups = await client.groups();
    expect(groups.slice(0, 4).map((g) => g.name)).toEqual(['medapp-admins', 'medapp-approvers', 'medapp-authors', 'medapp-viewers']);
    expect(groups.filter((g) => g.kind === 'app').map((g) => g.name)).toContain('app-app_hypertension_register-hypertension_clinic');
    const roles = describeAppRoleGroups(groups, registry);
    expect(roles.find((r) => r.group === 'app-app_hypertension_register-hypertension_clinic')).toMatchObject({ app_name: 'Hypertension register', role_name: 'Hypertension clinic', app_id: 'app_hypertension_register', role_id: 'hypertension_clinic' });
    // A group whose app the registry does not list keeps its parsed parts; the hospital's own groups are neither.
    const foreign = describeAppRoleGroups([{ name: 'app-app_gone-reader', description: '', kind: 'app' }], registry);
    expect(foreign[0]).toMatchObject({ app_name: 'app_gone', role_name: 'reader' });
    expect(partitionGroups(['cardiology', 'medapp-viewers', 'app-app_gone-reader', 'medapp-admins'], roles)).toEqual({
      platform: ['medapp-admins', 'medapp-viewers'],
      apps: [{ group: 'app-app_gone-reader', app_id: 'app_gone', app_name: 'app_gone', role_id: 'reader', role_name: 'reader' }],
      other: ['cardiology'],
    });
  });
});
