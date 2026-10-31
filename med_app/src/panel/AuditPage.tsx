import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ActionIcon, Alert, Badge, Button, Code, Container, Drawer, Group, Loader, Paper, Select, SegmentedControl, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconRefresh, IconX } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import type { RuntimeConfig } from '../config/env';
import type { RegistryEntry } from '../manifest/registry';
import { isAdmin } from '../manifest/roles';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';
import { actorOf, AuditApiError, daysAround, KIND_GROUPS, kindGroupOf, type AuditClient, type AuditEntry, type AuditOutcome, type AuditQuery, type KindGroup } from '../audit';
import { displayNameOfUser, type ManagedUser, type UsersClient } from '../users';
import { PanelShell } from './PanelShell';

/* ── the time range ─────────────────────────────────────────────────────────────────────────── */

type RangePreset = 'today' | '7d' | '30d' | '90d' | 'custom';

interface RangeState {
  readonly preset: RangePreset;
  /** Dates (YYYY-MM-DD), for the custom preset; a bare date is the start (`from`) or the end (`to`) of that day. */
  readonly from: string;
  readonly to: string;
}

const RANGE_PRESETS: readonly { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'custom', label: 'Custom' },
];

/** The `from`/`to` of the query for a preset — the API's own default (the last seven days) when nothing is said. */
export function rangeOf(range: RangeState, now: Date): { from?: string; to?: string } {
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  switch (range.preset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString() };
    }
    case '7d':
      return {};
    case '30d':
      return { from: daysAgo(30) };
    case '90d':
      return { from: daysAgo(90) };
    case 'custom':
      return {
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      };
  }
}

function describeRange(range: RangeState): string {
  switch (range.preset) {
    case 'today':
      return 'today';
    case '7d':
      return 'in the last 7 days';
    case '30d':
      return 'in the last 30 days';
    case '90d':
      return 'in the last 90 days';
    case 'custom':
      return range.from && range.to ? `from ${range.from} to ${range.to}` : range.from ? `since ${range.from}` : range.to ? `up to ${range.to}` : 'in the last 7 days';
  }
}

/* ── presentation ───────────────────────────────────────────────────────────────────────────── */

const OUTCOME_COLOR: Record<AuditOutcome, string> = {
  ok: 'clinical',
  refused: 'red',
  error: 'orange',
};
const GROUP_COLOR: Record<KindGroup, string> = {
  reads: 'clinical',
  writes: 'ink',
  platform: 'yellow',
  lifecycle: 'gray',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function errorMessage(e: unknown): string {
  if (e instanceof AuditApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Who or what the record is about, under the kind: the app and role, the account changed, the step taken. */
function subjectOf(entry: AuditEntry, appName: (id: string) => string): string {
  const app = entry.app_id ? `${appName(entry.app_id)}${entry.manifest_version ? ` v${entry.manifest_version}` : ''}` : '';
  const group = kindGroupOf(entry.kind);
  if (group === 'lifecycle') return [app, entry.from_state && entry.to_state ? `${entry.from_state.replace('_', ' ')} → ${entry.to_state.replace('_', ' ')}` : ''].filter(Boolean).join(' · ');
  if (entry.kind.startsWith('platform.user.'))
    return [entry.email ?? entry.target_username, entry.groups_added?.length ? `+${entry.groups_added.length}` : '', entry.groups_removed?.length ? `−${entry.groups_removed.length}` : '']
      .filter(Boolean)
      .join(' ');
  if (entry.kind.startsWith('platform.patient.')) return entry.query ? `"${entry.query}"` : '';
  return [app, entry.role].filter(Boolean).join(' · ');
}

/** The kind in the mono face, allowed to wrap only between its segments — never inside a word. */
function Kind({ kind, size = 'xs', fw }: { kind: string; size?: 'xs' | 'sm'; fw?: number }) {
  const segments = kind.split('.');
  return (
    <Text size={size} fw={fw} className="ds-mono" style={{ wordBreak: 'keep-all', overflowWrap: 'normal' }}>
      {segments.map((s, i) => (
        <span key={i}>
          {i > 0 && (
            <>
              .<wbr />
            </>
          )}
          {s}
        </span>
      ))}
    </Text>
  );
}

function OutcomeBadge({ outcome }: { outcome: AuditOutcome | undefined }) {
  const o = outcome ?? 'ok';
  return (
    <Badge size="sm" color={OUTCOME_COLOR[o]} variant={o === 'ok' ? 'light' : 'filled'} tt="none" styles={KEEP_WHOLE} data-testid="audit-outcome">
      {o}
    </Badge>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────────────────────── */

interface Listing {
  readonly records: AuditEntry[];
  readonly cursor: string | null;
  readonly range: { from: string; to: string } | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY: Listing = {
  records: [],
  cursor: null,
  range: null,
  loading: true,
  error: null,
};

/**
 * Audit trail — administrators only. Every data access and write an app made through the dispatcher, every account
 * change, every lifecycle step of an app: who, what, for which patient, when, with what outcome. Newest first, one
 * page at a time; each filter narrows and the time range is capped at 92 days per query. Records are kept
 * indefinitely and cannot be edited — the page reads, nothing more.
 */
export function AuditPage({
  client,
  users,
  registry,
  config,
  now = () => new Date(),
}: {
  client: AuditClient;
  /** For the people filter: the accounts of the pool, by name. */
  users: UsersClient;
  registry: readonly RegistryEntry[];
  config: RuntimeConfig;
  now?: () => Date;
}) {
  const { session, status } = useAuth();
  const admin = session ? isAdmin(session.claims) : false;

  // Opened from an app's inspector: `?id=<audit_id>&at=<iso>` names one record and roughly when it was written.
  const [search, setSearch] = useSearchParams();
  const [recordId, setRecordId] = useState<string | null>(() => search.get('id'));
  const [range, setRange] = useState<RangeState>(() => {
    const at = search.get('at');
    return search.get('id') && at ? { preset: 'custom', ...daysAround(at) } : { preset: search.get('id') ? '90d' : '7d', from: '', to: '' };
  });
  const [app, setApp] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [patientDraft, setPatientDraft] = useState('');
  const [patient, setPatient] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing>(EMPTY);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [accounts, setAccounts] = useState<ManagedUser[]>([]);

  // The patient box follows typing a moment later; ids are typed, not picked.
  useEffect(() => {
    const handle = setTimeout(() => setPatient(patientDraft.trim()), patientDraft ? 300 : 0);
    return () => clearTimeout(handle);
  }, [patientDraft]);

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    users
      .list()
      .then((l) => !cancelled && setAccounts(l.users))
      .catch(() => {}); // the filter is a convenience; the trail loads without it
    return () => {
      cancelled = true;
    };
  }, [admin, users]);

  const apps = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of registry) if (e.ok && !seen.has(e.manifest.metadata.app_id)) seen.set(e.manifest.metadata.app_id, e.manifest.metadata.name);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [registry]);
  const appName = useCallback((id: string) => apps.find((a) => a.value === id)?.label ?? id, [apps]);
  const people = useMemo(() => {
    const options = accounts.filter((u) => u.sub).map((u) => ({ value: u.sub as string, label: displayNameOfUser(u) }));
    if (user && !options.some((o) => o.value === user)) options.push({ value: user, label: user }); // chosen from a record, not in the first page of accounts
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [accounts, user]);

  const query = useMemo<AuditQuery>(
    () => ({
      ...rangeOf(range, now()),
      ...(app ? { app } : {}),
      ...(user ? { user } : {}),
      ...(patient ? { patient } : {}),
      ...(kind ? { kind } : {}),
      ...(outcome ? { outcome: outcome as AuditOutcome } : {}),
      ...(recordId ? { id: recordId } : {}),
    }),
    // `now` moves; the query is rebuilt when a filter changes, which is when the time range should be re-anchored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, app, user, patient, kind, outcome, recordId]
  );
  const queryKey = JSON.stringify(query);

  const seq = useRef(0);
  const run = useCallback(
    async (q: AuditQuery, append: boolean) => {
      const id = ++seq.current;
      setListing((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const page = await client.query(q);
        if (id !== seq.current) return;
        setListing((prev) => ({
          records: append ? [...prev.records, ...page.records] : page.records,
          cursor: page.cursor,
          range: page.range,
          loading: false,
          error: null,
        }));
      } catch (e) {
        if (id !== seq.current) return;
        setListing((prev) => ({
          ...prev,
          records: append ? prev.records : [],
          cursor: append ? prev.cursor : null,
          loading: false,
          error: errorMessage(e),
        }));
      }
    },
    [client]
  );

  useEffect(() => {
    if (!admin) return;
    void run(JSON.parse(queryKey) as AuditQuery, false);
  }, [admin, queryKey, run]);

  // The record a link named opens by itself, once; the rest of the page stays as it is for looking around it.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !recordId || listing.loading) return;
    const match = listing.records.find((r) => r.audit_id === recordId);
    if (match) {
      opened.current = true;
      setSelected(match);
    }
  }, [recordId, listing]);

  const clearRecord = () => {
    setRecordId(null);
    if (search.has('id')) setSearch({}, { replace: true });
  };

  if (status === 'restoring') return null; // RequireAuth shows the loader; nobody is sent anywhere before the session is known
  if (!admin) return <Navigate to="/" replace />;

  const isMock = config.auth.mode === 'mock';
  const customInvalid = range.preset === 'custom' && range.from && range.to && range.from > range.to;
  const filtered = Boolean(app || user || patient || kind || outcome || recordId);

  return (
    <PanelShell crumbs={[{ label: 'Audit trail' }]} isMock={isMock}>
      <Container size="xl" py="lg">
        <Stack gap="lg">
          <div>
            <Title order={2}>Audit trail</Title>
            <Text size="sm" c="dimmed" mt={2} maw={820}>
              Every data access and write an app made, every account change, every lifecycle step of an app — who, what, for which patient, when, and whether it went through. Records are written as
              the work happens and kept indefinitely; nothing here edits them.
              {client.kind === 'local' && ' In mock mode the trail holds a few sample records plus whatever the apps you open in this browser do.'}
            </Text>
          </div>

          <Paper withBorder p="md" data-testid="audit-filters">
            <Stack gap="sm">
              <Group gap="md" align="flex-end" wrap="wrap">
                <div>
                  <Text size="xs" fw={500} mb={4}>
                    Time range
                  </Text>
                  <SegmentedControl
                    size="xs"
                    value={range.preset}
                    onChange={(v) => setRange((r) => ({ ...r, preset: v as RangePreset }))}
                    data={RANGE_PRESETS.map((p) => ({
                      value: p.value,
                      label: p.label,
                    }))}
                    data-testid="audit-range"
                  />
                </div>
                {range.preset === 'custom' && (
                  <>
                    <TextInput
                      type="date"
                      size="xs"
                      label="From"
                      value={range.from}
                      onChange={(e) => setRange((r) => ({ ...r, from: e.currentTarget.value }))}
                      error={customInvalid ? 'after “to”' : undefined}
                      data-testid="audit-from"
                      w={150}
                    />
                    <TextInput type="date" size="xs" label="To" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.currentTarget.value }))} data-testid="audit-to" w={150} />
                  </>
                )}
              </Group>
              <Group gap="md" align="flex-end" wrap="wrap">
                <Select size="xs" label="App" placeholder="Any app" data={apps} value={app} onChange={setApp} searchable clearable w={240} data-testid="audit-app" />
                <Select
                  size="xs"
                  label="Person"
                  placeholder="Anyone"
                  data={people}
                  value={user}
                  onChange={setUser}
                  searchable
                  clearable
                  w={220}
                  data-testid="audit-user"
                  nothingFoundMessage="No such account"
                />
                <TextInput size="xs" label="Patient" placeholder="Patient id" value={patientDraft} onChange={(e) => setPatientDraft(e.currentTarget.value)} w={180} data-testid="audit-patient" />
                <Select
                  size="xs"
                  label="Kind"
                  placeholder="Any kind"
                  data={KIND_GROUPS.map((g) => ({
                    value: g.value,
                    label: g.label,
                  }))}
                  value={kind}
                  onChange={setKind}
                  clearable
                  w={140}
                  data-testid="audit-kind"
                />
                <Select
                  size="xs"
                  label="Outcome"
                  placeholder="Any outcome"
                  data={[
                    { value: 'ok', label: 'ok' },
                    { value: 'refused', label: 'refused' },
                    { value: 'error', label: 'error' },
                  ]}
                  value={outcome}
                  onChange={setOutcome}
                  clearable
                  w={140}
                  data-testid="audit-outcome-filter"
                />
                {recordId && (
                  <Badge size="lg" variant="light" color="ink" tt="none" radius="sm" styles={KEEP_WHOLE} data-testid="audit-id-filter" rightSection={<ActionIcon size="xs" variant="transparent" color="ink" aria-label="Show the whole range" onClick={clearRecord} data-testid="audit-id-clear"><IconX size={12} /></ActionIcon>}>
                    Record <span className="ds-mono">{recordId}</span>
                  </Badge>
                )}
                {filtered && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => {
                      setApp(null);
                      setUser(null);
                      setPatientDraft('');
                      setKind(null);
                      setOutcome(null);
                      clearRecord();
                    }}
                    data-testid="audit-clear"
                  >
                    Clear filters
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>

          {listing.error && (
            <Alert color="red" variant="light" data-testid="audit-error">
              {listing.error}
            </Alert>
          )}

          <Paper withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  <Text size="sm" c="dimmed" className="ds-tabular" data-testid="audit-count">
                    {listing.loading && listing.records.length === 0
                      ? 'Loading the trail…'
                      : `${listing.records.length} record${listing.records.length === 1 ? '' : 's'} ${describeRange(range)}${listing.cursor ? ' — more follow' : ''}`}
                  </Text>
                  {listing.loading && <Loader size="xs" />}
                </Group>
                <Tooltip label="Read again — records written since">
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => void run(query, false)} aria-label="Refresh" data-testid="audit-refresh">
                    <IconRefresh size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>

              {!listing.loading && listing.records.length === 0 && !listing.error ? (
                <Text size="sm" c="dimmed" py="sm" data-testid="audit-empty">
                  {recordId ? (
                    <>
                      No record <span className="ds-mono">{recordId}</span> {describeRange(range)}
                      {filtered && (app || user || patient || kind || outcome) ? ' with these filters' : ''}. The browser saw the call; if the store was unreachable at that moment the record is in the function's log alone.
                    </>
                  ) : (
                    <>
                      No records {describeRange(range)}
                      {filtered ? ' match these filters' : ''}.
                    </>
                  )}
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={1040} type="native">
                  <Table withRowBorders highlightOnHover verticalSpacing="xs" className="ds-audit" data-testid="audit-table" style={{ tableLayout: 'fixed' }}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th style={{ width: 168 }}>Time</Table.Th>
                        <Table.Th style={{ width: '16%' }}>Who</Table.Th>
                        <Table.Th>Action</Table.Th>
                        <Table.Th style={{ width: 136 }}>Patient</Table.Th>
                        <Table.Th style={{ width: 84 }}>Outcome</Table.Th>
                        <Table.Th style={{ width: '20%' }}>Detail</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {listing.records.map((r) => (
                        <Table.Tr key={r.audit_id} onClick={() => setSelected(r)} style={{ cursor: 'pointer' }} data-testid="audit-row">
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Text size="xs" className="ds-tabular" style={{ whiteSpace: 'nowrap' }}>
                              {formatWhen(r.timestamp)}
                            </Text>
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Text size="sm" fw={500} truncate>
                              {actorOf(r)}
                            </Text>
                            {r.user_name && r.user_email && (
                              <Text size="xs" c="dimmed" truncate>
                                {r.user_email}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Group gap={6} wrap="nowrap" align="flex-start">
                              {kindGroupOf(r.kind) && (
                                <Badge size="xs" variant="dot" color={GROUP_COLOR[kindGroupOf(r.kind)!]} tt="none" styles={KEEP_WHOLE} mt={1}>
                                  {kindGroupOf(r.kind)}
                                </Badge>
                              )}
                              <Kind kind={r.kind} />
                            </Group>
                            <Text size="xs" c="dimmed" truncate>
                              {subjectOf(r, appName)}
                            </Text>
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            {r.patient_context ? (
                              <Text size="xs" className="ds-mono" truncate>
                                {r.patient_context}
                              </Text>
                            ) : (
                              <Text size="xs" c="dimmed">
                                —
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td
                            style={{
                              verticalAlign: 'top',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <OutcomeBadge outcome={r.outcome} />
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
                              {r.detail ?? r.result_summary ?? r.resource_ref ?? ''}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}

              {listing.cursor && (
                <Button variant="default" size="xs" w="fit-content" loading={listing.loading} onClick={() => void run({ ...query, cursor: listing.cursor }, true)} data-testid="audit-more">
                  Load more
                </Button>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Container>

      <RecordDrawer
        entry={selected}
        appName={appName}
        onClose={() => setSelected(null)}
        onFilter={(f) => {
          if (f.user) setUser(f.user);
          if (f.app) setApp(f.app);
          if (f.patient) setPatientDraft(f.patient);
          setSelected(null);
        }}
      />
    </PanelShell>
  );
}

/* ── one record ─────────────────────────────────────────────────────────────────────────────── */

const SHOWN_IN_FACTS = new Set([
  'audit_id',
  'timestamp',
  'kind',
  'user_sub',
  'user_name',
  'user_email',
  'outcome',
  'detail',
  'source',
  'app_id',
  'manifest_version',
  'primitive_id',
  'role',
  'role_source',
  'patient_context',
  'duration_ms',
  'result_summary',
  'resource_ref',
  'provenance',
  'config_mismatch',
  'config_dropped',
  'query',
  'target_username',
  'email',
  'groups_added',
  'groups_removed',
  'from_state',
  'to_state',
  'parent_version',
]);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function RecordDrawer({
  entry,
  appName,
  onClose,
  onFilter,
}: {
  entry: AuditEntry | null;
  appName: (id: string) => string;
  onClose: () => void;
  onFilter: (f: { user?: string; app?: string; patient?: string }) => void;
}) {
  const extra = entry ? Object.entries(entry).filter(([k, v]) => !SHOWN_IN_FACTS.has(k) && v !== undefined && v !== null) : [];
  return (
    <Drawer opened={!!entry} onClose={onClose} position="right" size="lg" title="Audit record">
      {entry && (
        <Stack gap="md" data-testid="audit-record">
          <Group gap="xs">
            <OutcomeBadge outcome={entry.outcome} />
            <Kind kind={entry.kind} size="sm" fw={500} />
          </Group>
          <dl className="ds-facts">
            <Fact label="When">
              <span>
                {formatWhen(entry.timestamp)}{' '}
                <Text span size="xs" c="dimmed" className="ds-mono">
                  {entry.timestamp}
                </Text>
              </span>
            </Fact>
            <Fact label="Who">
              <span>
                {actorOf(entry)}
                {entry.user_name && entry.user_email ? ` · ${entry.user_email}` : ''}{' '}
                <Text span size="xs" c="dimmed" className="ds-mono">
                  {entry.user_sub}
                </Text>
              </span>
            </Fact>
            {entry.source && <Fact label="Recorded by">{entry.source}</Fact>}
            {entry.app_id && (
              <Fact label="App">
                <span>
                  {appName(entry.app_id)}{' '}
                  <Text span size="xs" c="dimmed" className="ds-mono">
                    {entry.app_id}
                    {entry.manifest_version ? `@${entry.manifest_version}` : ''}
                  </Text>
                </span>
              </Fact>
            )}
            {entry.primitive_id && (
              <Fact label="Primitive">
                <span className="ds-mono">{entry.primitive_id}</span>
              </Fact>
            )}
            {entry.role && (
              <Fact label="Role">
                {entry.role}
                {entry.role_source ? ` (${entry.role_source === 'group' ? 'granted by group' : entry.role_source})` : ''}
              </Fact>
            )}
            {entry.patient_context && (
              <Fact label="Patient">
                <span className="ds-mono">{entry.patient_context}</span>
              </Fact>
            )}
            {entry.query !== undefined && (
              <Fact label="Query">
                <span className="ds-mono">{String(entry.query)}</span>
              </Fact>
            )}
            {entry.result_summary && <Fact label="Result">{entry.result_summary}</Fact>}
            {entry.resource_ref && (
              <Fact label="Resource">
                <span className="ds-mono">{entry.resource_ref}</span>
              </Fact>
            )}
            {entry.provenance && <Fact label="Provenance">{entry.provenance}</Fact>}
            {entry.config_mismatch && entry.config_mismatch.length > 0 && (
              <Fact label="Config differs from the manifest at">
                <span className="ds-mono">{entry.config_mismatch.join(', ')}</span>
              </Fact>
            )}
            {entry.config_dropped && entry.config_dropped.length > 0 && (
              <Fact label="Undeclared config keys dropped">
                <span className="ds-mono">{entry.config_dropped.join(', ')}</span>
              </Fact>
            )}
            {entry.duration_ms !== undefined && <Fact label="Duration">{`${entry.duration_ms} ms`}</Fact>}
            {(entry.email || entry.target_username) && (
              <Fact label="Account">
                <span>
                  {entry.email ?? ''}{' '}
                  {entry.target_username && (
                    <Text span size="xs" c="dimmed" className="ds-mono">
                      {entry.target_username}
                    </Text>
                  )}
                </span>
              </Fact>
            )}
            {entry.groups_added && entry.groups_added.length > 0 && (
              <Fact label="Groups added">
                <span className="ds-mono">{entry.groups_added.join(', ')}</span>
              </Fact>
            )}
            {entry.groups_removed && entry.groups_removed.length > 0 && (
              <Fact label="Groups removed">
                <span className="ds-mono">{entry.groups_removed.join(', ')}</span>
              </Fact>
            )}
            {entry.from_state && entry.to_state && <Fact label="Step">{`${entry.from_state.replace('_', ' ')} → ${entry.to_state.replace('_', ' ')}`}</Fact>}
            {entry.parent_version && <Fact label="Based on">{`v${entry.parent_version}`}</Fact>}
            {entry.detail && <Fact label="Detail">{entry.detail}</Fact>}
            {extra.map(([k, v]) => (
              <Fact key={k} label={k}>
                <span className="ds-mono">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </Fact>
            ))}
            <Fact label="Record id">
              <span className="ds-mono">{entry.audit_id}</span>
            </Fact>
          </dl>
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={() => onFilter({ user: entry.user_sub })} data-testid="audit-filter-person">
              This person's trail
            </Button>
            {entry.app_id && (
              <Button size="xs" variant="default" onClick={() => onFilter({ app: entry.app_id })} data-testid="audit-filter-app">
                This app's trail
              </Button>
            )}
            {entry.patient_context && (
              <Button size="xs" variant="default" onClick={() => onFilter({ patient: entry.patient_context })} data-testid="audit-filter-patient">
                This patient's trail
              </Button>
            )}
          </Group>
          <div>
            <Text size="xs" c="dimmed" mb={4}>
              As stored
            </Text>
            <Code block style={{ fontSize: 11, maxHeight: 280, overflow: 'auto' }}>
              {JSON.stringify(entry, null, 2)}
            </Code>
          </div>
        </Stack>
      )}
    </Drawer>
  );
}
