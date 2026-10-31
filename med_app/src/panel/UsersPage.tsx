import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Alert, Badge, Button, Checkbox, Container, Divider, Drawer, Group, Loader, Modal, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconMailForward, IconSearch, IconUserPlus } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import type { RuntimeConfig } from '../config/env';
import type { RegistryEntry } from '../manifest/registry';
import { isAdmin, PLATFORM_GROUPS } from '../manifest/roles';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';
import { PanelShell } from './PanelShell';
import {
  accountState,
  describeAppRoleGroups,
  displayNameOfUser,
  groupByApp,
  partitionGroups,
  PLATFORM_LABELS,
  PLATFORM_ORDER,
  UsersApiError,
  type AppRoleGroup,
  type GroupInfo,
  type ManagedUser,
  type UsersClient,
} from '../users';

function errorMessage(e: unknown): string {
  if (e instanceof UsersApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const STATE_LABEL: Record<ReturnType<typeof accountState>, { label: string; color: string }> = {
  active: { label: 'Active', color: 'clinical' },
  invited: { label: 'Invited', color: 'yellow' },
  disabled: { label: 'Disabled', color: 'gray' },
  reset: { label: 'Password reset', color: 'yellow' },
};

function StateBadge({ user }: { user: ManagedUser }) {
  const s = STATE_LABEL[accountState(user)];
  return (
    <Badge color={s.color} variant="light" tt="none" styles={KEEP_WHOLE} data-testid="account-state">
      {s.label}
    </Badge>
  );
}

/**
 * User management — administrators only. The accounts in the hospital's user pool, what each may open, and the
 * three things an administrator does: register a person (the account is created and the invitation email carries
 * a temporary password), decide their groups (the four platform groups, the role groups of published apps, the
 * hospital's own), and end or restore their access. Nothing here deletes an account: history stays attributable.
 */
export function UsersPage({ client, registry, config }: { client: UsersClient; registry: readonly RegistryEntry[]; config: RuntimeConfig }) {
  const { session, status } = useAuth();
  const admin = session ? isAdmin(session.claims) : false;
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const reload = useCallback(
    async (needle: string) => {
      try {
        const listing = await client.list(needle);
        setUsers(listing.users);
        setTruncated(listing.truncated);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [client]
  );

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    client
      .groups()
      .then((g) => !cancelled && setGroups(g))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [admin, client]);

  // The list follows the search box, a moment after typing stops.
  useEffect(() => {
    if (!admin) return;
    const handle = setTimeout(() => void reload(search), search ? 250 : 0);
    return () => clearTimeout(handle);
  }, [admin, search, reload]);

  const appRoles = useMemo(() => describeAppRoleGroups(groups ?? [], registry), [groups, registry]);

  const replaceUser = (next: ManagedUser) => setUsers((prev) => (prev ? prev.map((u) => (u.username === next.username ? next : u)) : prev));
  const selectedUser = users?.find((u) => u.username === selected) ?? null;

  if (status === 'restoring') return null; // RequireAuth shows the loader; nobody is sent anywhere before the session is known
  if (!admin) return <Navigate to="/" replace />;

  return (
    <PanelShell crumbs={[{ label: 'User management' }]} isMock={config.auth.mode === 'mock'}>
      <Container size="lg" py="lg">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={2}>User management</Title>
              <Text size="sm" c="dimmed" mt={2} maw={760}>
                The accounts in {config.hospitalName}'s user pool and what each may open. Access is a matter of groups: the platform groups decide who
                builds, signs off and administers; an app's role groups decide who opens it, in which role. Disabling an account ends its access;
                nothing is deleted.
              </Text>
            </div>
            <Button size="sm" leftSection={<IconUserPlus size={16} />} onClick={() => setRegistering(true)} data-testid="register-user">
              Register user
            </Button>
          </Group>

          {notice && (
            <Alert color="clinical" variant="light" withCloseButton onClose={() => setNotice(null)} data-testid="users-notice">
              {notice}
            </Alert>
          )}
          {error && (
            <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} data-testid="users-error">
              {error}
            </Alert>
          )}

          <Paper withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <TextInput
                  placeholder="Search by email"
                  leftSection={<IconSearch size={14} />}
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  size="sm"
                  w={320}
                  aria-label="Search by email"
                  data-testid="users-search"
                />
                <Text size="sm" c="dimmed" className="ds-tabular" data-testid="users-count">
                  {users ? `${users.length} account${users.length === 1 ? '' : 's'}${truncated ? ' shown — search to narrow' : ''}` : ''}
                </Text>
              </Group>
              {users === null ? (
                <Group gap="xs" py="md">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    Loading accounts…
                  </Text>
                </Group>
              ) : users.length === 0 ? (
                <Text size="sm" c="dimmed" py="sm">
                  {search ? `No account's email starts with "${search}".` : 'No accounts yet.'}
                </Text>
              ) : (
                <Table withRowBorders highlightOnHover verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: '26%' }}>Person</Table.Th>
                      <Table.Th style={{ width: '16%' }}>Platform</Table.Th>
                      <Table.Th>App roles</Table.Th>
                      <Table.Th style={{ whiteSpace: 'nowrap' }}>Status</Table.Th>
                      <Table.Th style={{ whiteSpace: 'nowrap' }}>Last change</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {users.map((u) => {
                      const parts = partitionGroups(u.groups, appRoles);
                      const self = !!session && u.sub === session.claims.sub;
                      return (
                        <Table.Tr key={u.username} data-testid="user-row" style={{ opacity: u.enabled ? 1 : 0.6 }}>
                          <Table.Td>
                            <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                              {displayNameOfUser(u)}
                              {self && (
                                <Text span size="xs" c="dimmed" ml={6}>
                                  (you)
                                </Text>
                              )}
                            </Text>
                            {u.name && u.email && (
                              <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                                {u.email}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4} wrap="wrap">
                              {parts.platform.length === 0 && (
                                <Text size="sm" c="dimmed">
                                  —
                                </Text>
                              )}
                              {parts.platform.map((g) => (
                                <Badge key={g} variant="light" color={g === PLATFORM_GROUPS.admins ? 'ink' : 'clinical'} tt="none" styles={KEEP_WHOLE}>
                                  {PLATFORM_LABELS[g]?.short ?? g}
                                </Badge>
                              ))}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            {parts.apps.length === 0 && parts.other.length === 0 ? (
                              <Text size="sm" c="dimmed">
                                —
                              </Text>
                            ) : (
                              <Text size="sm">
                                {parts.apps.map((r) => `${r.app_name} · ${r.role_name}`).concat(parts.other).join(', ')}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>
                            <StateBadge user={u} />
                          </Table.Td>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>
                            <Text size="sm" c="dimmed">
                              {formatWhen(u.updated_at)}
                            </Text>
                          </Table.Td>
                          <Table.Td style={{ textAlign: 'right' }}>
                            <Button variant="default" size="xs" onClick={() => setSelected(u.username)} data-testid="manage-user">
                              Manage
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Container>

      <RegisterUserModal
        opened={registering}
        onClose={() => setRegistering(false)}
        client={client}
        groups={groups ?? []}
        appRoles={appRoles}
        onRegistered={(user) => {
          setRegistering(false);
          setUsers((prev) => (prev ? [...prev.filter((u) => u.username !== user.username), user].sort((a, b) => (a.email ?? '').localeCompare(b.email ?? '')) : [user]));
          setNotice(`${user.email} is registered. The invitation email carries a temporary password; they will choose their own at first sign-in.`);
        }}
      />

      <ManageUserDrawer
        user={selectedUser}
        onClose={() => setSelected(null)}
        client={client}
        groups={groups ?? []}
        appRoles={appRoles}
        self={!!selectedUser && !!session && selectedUser.sub === session.claims.sub}
        onChanged={replaceUser}
        onNotice={setNotice}
      />
    </PanelShell>
  );
}

/* ── group chooser ───────────────────────────────────────────────────────────────────────────── */

/** The groups of the pool as a form: what is ticked is what the person will hold once the form is submitted. */
function GroupChooser({
  value,
  onChange,
  groups,
  appRoles,
  disabledFor,
  testIdPrefix,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  groups: readonly GroupInfo[];
  appRoles: readonly AppRoleGroup[];
  /** A reason a group cannot be changed here (shown instead of its description), or nothing. */
  disabledFor?: (group: string) => string | undefined;
  testIdPrefix: string;
}) {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const apps = groupByApp(appRoles);
  const hospital = groups.filter((g) => g.kind === 'hospital');
  const toggle = (group: string, on: boolean) => onChange(on ? [...new Set([...value, group])] : value.filter((g) => g !== group));
  const box = (group: string, label: ReactNode, description: string | undefined) => {
    const why = disabledFor?.(group);
    return (
      <Checkbox
        key={group}
        checked={value.includes(group)}
        onChange={(e) => toggle(group, e.currentTarget.checked)}
        disabled={!!why}
        label={label}
        description={why ?? description}
        size="sm"
        color="clinical"
        data-testid={`${testIdPrefix}-${group}`}
      />
    );
  };
  return (
    <Stack gap="lg">
      <div>
        <Title order={5} mb={8}>
          Platform groups
        </Title>
        <Stack gap={8}>
          {PLATFORM_ORDER.filter((g) => byName.has(g)).map((g) =>
            box(
              g,
              <span>
                {PLATFORM_LABELS[g]?.title ?? g}{' '}
                <Text span size="xs" c="dimmed" className="ds-mono">
                  {g}
                </Text>
              </span>,
              byName.get(g)?.description
            )
          )}
        </Stack>
      </div>
      <div>
        <Title order={5} mb={8}>
          App roles
        </Title>
        {apps.length === 0 ? (
          <Text size="sm" c="dimmed">
            No app role groups yet — they come into being when an app is published.
          </Text>
        ) : (
          <Stack gap="sm">
            {apps.map((app) => (
              <div key={app.app_id}>
                <Text size="sm" fw={500} mb={4}>
                  {app.app_name}
                </Text>
                <Stack gap={6} pl={2}>
                  {app.roles.map((r) => box(r.group, r.role_name, r.group))}
                </Stack>
              </div>
            ))}
          </Stack>
        )}
      </div>
      {hospital.length > 0 && (
        <div>
          <Title order={5} mb={8}>
            Hospital groups
          </Title>
          <Stack gap={8}>{hospital.map((g) => box(g.name, g.name, g.description || undefined))}</Stack>
        </div>
      )}
    </Stack>
  );
}

/** What a submit would send: the groups ticked that the person does not hold, and the ones unticked that they do. */
export function groupDelta(current: readonly string[], next: readonly string[]): { add: string[]; remove: string[] } {
  return { add: next.filter((g) => !current.includes(g)), remove: current.filter((g) => !next.includes(g)) };
}

/* ── register ────────────────────────────────────────────────────────────────────────────────── */

function RegisterUserModal({ opened, onClose, client, groups, appRoles, onRegistered }: { opened: boolean; onClose: () => void; client: UsersClient; groups: readonly GroupInfo[]; appRoles: readonly AppRoleGroup[]; onRegistered: (user: ManagedUser) => void }) {
  const [email, setEmail] = useState('');
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setEmail('');
    setGiven('');
    setFamily('');
    setChosen([]);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const user = await client.register({ email, given_name: given || undefined, family_name: family || undefined, groups: chosen });
      reset();
      onRegistered(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Register a user"
      size="lg"
    >
      <form onSubmit={(e) => void submit(e)} data-testid="register-form">
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            The account is created in the hospital's user pool and an invitation is emailed with a temporary password; the person chooses their own
            password at first sign-in. Access comes from the groups you choose here — none means an account that can sign in and sees nothing.
          </Text>
          <TextInput label="Email" description="The account's username" type="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} data-testid="register-email" />
          <Group grow>
            <TextInput label="Given name" value={given} onChange={(e) => setGiven(e.currentTarget.value)} data-testid="register-given" />
            <TextInput label="Family name" value={family} onChange={(e) => setFamily(e.currentTarget.value)} data-testid="register-family" />
          </Group>
          <GroupChooser value={chosen} onChange={setChosen} groups={groups} appRoles={appRoles} testIdPrefix="register-group" />
          {error && (
            <Alert color="red" variant="light" data-testid="register-error">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saving} data-testid="register-submit">
              Register and invite
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/* ── manage ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * One account: its facts, the two account actions (access, invitation — each one call, done at once), and the groups
 * as a form. Ticking boxes changes nothing until "Save changes": one request carries every addition and removal, so
 * the form answers at once and the pool is asked once — a dozen toggles used to be a dozen round trips.
 */
function ManageUserDrawer({ user, onClose, client, groups, appRoles, self, onChanged, onNotice }: { user: ManagedUser | null; onClose: () => void; client: UsersClient; groups: readonly GroupInfo[]; appRoles: readonly AppRoleGroup[]; self: boolean; onChanged: (user: ManagedUser) => void; onNotice: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  // The form starts from what the person holds — again whenever another account is opened or a save lands.
  const held = user ? [...user.groups].sort().join(' ') : '';
  const username = user?.username;
  useEffect(() => {
    setPending(held ? held.split(' ') : []);
    setError(null);
  }, [username, held]);

  const delta = groupDelta(user?.groups ?? [], pending);
  const changes = delta.add.length + delta.remove.length;

  const run = async (key: string, action: () => Promise<ManagedUser>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      onChanged(await action());
      if (done) onNotice(done);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!user || !changes) return;
    void run('groups', () => client.update(user.username, { add_groups: delta.add, remove_groups: delta.remove }), `Groups saved for ${displayNameOfUser(user)}: ${changes} change${changes === 1 ? '' : 's'}.`);
  };

  const state = user ? accountState(user) : 'active';
  return (
    <Drawer
      opened={!!user}
      onClose={onClose}
      position="right"
      size="md"
      title={user ? displayNameOfUser(user) : ''}
      // A column: the content scrolls, the save bar stays at the bottom.
      styles={{ content: { display: 'flex', flexDirection: 'column' }, body: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, paddingBottom: 0 } }}
    >
      {user && (
        <>
          <Stack gap="lg" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 16 }} data-testid="manage-drawer">
            <dl className="ds-facts">
              <dt>Email</dt>
              <dd>{user.email ?? '—'}</dd>
              <dt>Status</dt>
              <dd>
                <StateBadge user={user} />
              </dd>
              <dt>Registered</dt>
              <dd>{formatWhen(user.created_at)}</dd>
              <dt>Last change</dt>
              <dd>{formatWhen(user.updated_at)}</dd>
            </dl>

            {error && (
              <Alert color="red" variant="light" data-testid="manage-error">
                {error}
              </Alert>
            )}

            <div>
              <Title order={5} mb={6}>
                Account
              </Title>
              <Group justify="space-between" align="center">
                <Text size="sm" c="dimmed" maw={300}>
                  {self
                    ? 'You cannot disable your own account.'
                    : user.enabled
                      ? 'Disabling ends access at the next sign-in or token refresh; the account and its history remain.'
                      : 'This account cannot sign in. Enabling restores the access its groups grant.'}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  {state === 'invited' && (
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={<IconMailForward size={14} />}
                      loading={busy === 'invite'}
                      onClick={() => void run('invite', () => client.resendInvitation(user.username), `A new invitation is on its way to ${user.email}.`)}
                      data-testid="resend-invitation"
                    >
                      Resend invitation
                    </Button>
                  )}
                  <Button
                    variant="default"
                    size="xs"
                    disabled={self}
                    loading={busy === 'enabled'}
                    onClick={() => void run('enabled', () => client.update(user.username, { enabled: !user.enabled }), user.enabled ? `${displayNameOfUser(user)}'s access is disabled.` : `${displayNameOfUser(user)}'s access is restored.`)}
                    data-testid="toggle-enabled"
                  >
                    {user.enabled ? 'Disable access' : 'Enable access'}
                  </Button>
                </Group>
              </Group>
            </div>
            <Divider />

            <GroupChooser
              value={pending}
              onChange={setPending}
              groups={groups}
              appRoles={appRoles}
              disabledFor={(g) => (self && g === PLATFORM_GROUPS.admins ? 'Your own administrator membership — another administrator can change it.' : undefined)}
              testIdPrefix="group"
            />
          </Stack>

          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            py="md"
            style={{ borderTop: '1px solid var(--ds-hairline)', background: '#fff', position: 'sticky', bottom: 0 }}
            data-testid="groups-save-bar"
          >
            <Text size="sm" c={changes ? undefined : 'dimmed'} className="ds-tabular" data-testid="groups-pending">
              {changes === 0 ? 'No unsaved changes' : `${changes} unsaved change${changes === 1 ? '' : 's'}`}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Button variant="default" size="xs" disabled={!changes || busy === 'groups'} onClick={() => setPending([...user.groups])} data-testid="groups-discard">
                Discard
              </Button>
              <Button size="xs" disabled={!changes} loading={busy === 'groups'} onClick={save} data-testid="groups-save">
                Save changes
              </Button>
            </Group>
          </Group>
        </>
      )}
    </Drawer>
  );
}
