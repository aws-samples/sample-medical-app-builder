import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ActionIcon, Alert, Anchor, Badge, Button, Code, Container, Divider, Drawer, Group, List, Loader, Paper, ScrollArea, SegmentedControl, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconAdjustments, IconHistory } from '@tabler/icons-react';
import type { RegistryEntry } from '../manifest/registry';
import { authorLabel, findEntry } from '../manifest/registry';
import { appAccess, isAdmin, isPlatformStaff, selectInitialRole } from '../manifest/roles';
import { useAuth } from '../auth/AuthContext';
import { displayNameOf } from '../auth/types';
import type { AuthoringClient } from '../authoring/types';
import type { RuntimeConfig } from '../config/env';
import { LifecycleActions } from './drafting/LifecycleActions';
import { lifecycleColor } from './AppLauncher';
import { deepLinkTo } from '../audit';
import { PatientPicker, rememberedPatient, seedPatientOptions } from './PatientPicker';
import { noteOpened } from './personal';
import type { AuditRecord, PrimitiveExecutor } from '../primitives/data/types';
import { ManifestApp } from '../renderer/ManifestApp';
import type { Diagnostic } from '../renderer/expressions';
import { TopBar } from './TopBar';

/** How often, and how patiently, the page re-reads the registry for an app that is not in the list yet. */
export const LOOK_AGAIN = { attempts: 3, spacingMs: 700 };

/**
 * Runs one app for the signed-in person.
 *
 * Clinicians see the app and nothing else: their role is whatever their groups grant, resolved
 * silently (most capable wins). Platform staff — authors, approvers, admins, or anyone in mock
 * mode — additionally get an inspector drawer to preview the app as another role, see why they
 * hold the role they do, and read the audit trail. A person with no role for the app is told so;
 * the manifest's default role is only ever used in mock mode.
 */
export function AppRuntime({
  registry,
  registryLoading = false,
  config,
  executor,
  authoring,
  onRegistryChanged,
  onAudit: forwardAudit,
}: {
  registry: RegistryEntry[];
  /** The registry is being (re)fetched — an app that is not in the list yet may simply not have arrived. */
  registryLoading?: boolean;
  config: RuntimeConfig;
  executor: PrimitiveExecutor;
  /** The authoring API, for the lifecycle actions in the inspector; absent = no actions. */
  authoring?: AuthoringClient;
  onRegistryChanged?: () => void | Promise<void>;
  /** Every audit record the app produces, besides the inspector: in mock mode the panel's own trail keeps them. */
  onAudit?: (record: AuditRecord) => void;
}) {
  const { appId = '', version } = useParams();
  const [search, setSearch] = useSearchParams();
  const [chosenPatient, setChosenPatient] = useState<string>(() => (executor.kind === 'dispatcher' ? (rememberedPatient()?.id ?? '') : (seedPatientOptions()[0]?.value ?? '')));
  const searchPatients = useMemo(() => (executor.kind === 'dispatcher' ? (name: string) => executor.searchPatients(name) : undefined), [executor]);
  const { session } = useAuth();
  // `/apps/:appId` is the published version; `/apps/:appId/:version` pins one (drafts, versions in review).
  const entry = useMemo(() => findEntry(registry, appId, version), [registry, appId, version]);
  const manifest = entry?.manifest;

  // Not in the list we have: look again before saying so — the app may have been saved a moment ago
  // (from the drafting page, or in another tab) and the list not refreshed since; and the registry's
  // list index is eventually consistent, so a brand-new app can take a moment to show up even after a
  // refresh. A few refreshes, briefly spaced; until they have come back, the page is loading, not failing.
  const missingKey = `${appId}@${version ?? ''}`;
  const [secondLook, setSecondLook] = useState<{ key: string; done: boolean } | null>(null);
  const found = useRef(false);
  found.current = Boolean(entry);
  useEffect(() => {
    if (entry || registryLoading || secondLook?.key === missingKey) return;
    setSecondLook({ key: missingKey, done: false });
    const lookAgain = async () => {
      for (let attempt = 0; attempt < LOOK_AGAIN.attempts && !found.current; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, LOOK_AGAIN.spacingMs));
        await onRegistryChanged?.();
        await new Promise((r) => setTimeout(r, 0)); // let the fresh list render before deciding
      }
    };
    void lookAgain().finally(() => setSecondLook((prev) => (prev?.key === missingKey ? { key: missingKey, done: true } : prev)));
  }, [entry, registryLoading, secondLook, missingKey, onRegistryChanged]);
  const stillLooking = registryLoading || !secondLook || (secondLook.key === missingKey && !secondLook.done);

  // Opened: the launcher's "your apps" remembers it (this browser only).
  const openedId = manifest && session ? manifest.metadata.app_id : undefined;
  useEffect(() => {
    if (openedId && session) noteOpened(config.hospitalId, session.claims.sub, openedId);
  }, [openedId, session, config.hospitalId]);

  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // One role and one patient across the trail (the usual single-patient app): said once above the table, not on every row.
  const auditUniform = new Set(audit.map((r) => r.role)).size <= 1 && new Set(audit.map((r) => r.patient_context ?? '')).size <= 1;
  const [previewRole, setPreviewRole] = useState<string | null>(null);
  const onAudit = useCallback(
    (r: AuditRecord) => {
      setAudit((prev) => [...prev, r]);
      forwardAudit?.(r);
    },
    [forwardAudit]
  );
  const onDiagnostic = useCallback((d: Diagnostic) => setDiagnostics((prev) => (prev.some((p) => p.message === d.message) ? prev : [...prev, d])), []);

  const context = useMemo(() => Object.fromEntries(search.entries()), [search]);
  // Opened without a patient (a link from the drafting page, a bookmark): ask for one here rather than
  // fail. The choice goes into the URL, so the app then loads exactly as from the launcher.
  const needsPatient = Boolean(manifest?.context_inputs.some((c) => c.name === 'patient_id' && c.required)) && !context.patient_id;

  if (!manifest && session && stillLooking) {
    return (
      <>
        <TopBar crumbs={[{ label: appId }]} />
        <Container py="lg">
          <Group gap="sm" data-testid="app-loading">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Loading the app…
            </Text>
          </Group>
        </Container>
      </>
    );
  }

  if (!manifest || !session) {
    return (
      <>
        <TopBar crumbs={[{ label: 'Unknown app' }]} />
        <Container py="lg">
          <Alert color="red" title="No such app">
            <Text size="sm">
              <Code>{version ? `${appId} v${version}` : appId}</Code> is not in the registry.{' '}
              <Anchor component={Link} to="/">
                Back to the app list
              </Anchor>
              .
            </Text>
          </Alert>
        </Container>
      </>
    );
  }

  const isMock = config.auth.mode === 'mock';
  const access = appAccess(manifest, session.claims, { isMock });
  const entitled = access.roles;
  const initial = selectInitialRole(manifest, session.claims);
  const canInspect = isMock || isPlatformStaff(session.claims);
  // The trail is the administrators' section; for them an inspector row opens there, as the record the data source wrote.
  const canOpenTrail = isAdmin(session.claims);

  // Real deployments never fall back to the manifest's default role: no group, no access.
  if (access.reason === 'no_role') {
    return (
      <>
        <TopBar crumbs={[{ label: manifest.metadata.name }]} />
        <Container size="sm" py="xl">
          <Alert color="yellow" title="You don't have access to this app" variant="light">
            <Text size="sm">
              Access is granted by your administrator, either for this app in one of its roles:
            </Text>
            <List size="sm" mt="xs">
              {manifest.auth.roles.map((r) => (
                <List.Item key={r.id}>
                  {r.display_name} <Code>{r.cognito_group}</Code>
                </List.Item>
              ))}
            </List>
            <Text size="sm" mt="xs">
              or for every app at once (<Code>medapp-viewers</Code>), which opens this app as{' '}
              {manifest.auth.roles.find((r) => r.id === manifest.auth.default_role)?.display_name ?? manifest.auth.default_role}.
            </Text>
            <Text size="sm" mt="sm">
              <Anchor component={Link} to="/">
                Back to the app list
              </Anchor>
            </Text>
          </Alert>
        </Container>
      </>
    );
  }

  // Only published versions reach clinicians. Staff (authors, approvers, admins) open drafts and
  // versions in review — that is how they are written and signed off.
  if (access.reason === 'not_published') {
    return (
      <>
        <TopBar crumbs={[{ label: manifest.metadata.name }]} />
        <Container size="sm" py="xl">
          <Alert color="yellow" title="This app is not available yet" variant="light">
            <Text size="sm">
              It is currently <b>{manifest.lifecycle.state.replace('_', ' ')}</b>. It will appear in your app list once it has been reviewed and published.{' '}
              <Anchor component={Link} to="/">
                Back to the app list
              </Anchor>
            </Text>
          </Alert>
        </Container>
      </>
    );
  }

  // Staff may preview any role the manifest declares; everyone else runs as their entitled role.
  const previewable = canInspect ? manifest.auth.roles : entitled;
  const role = previewRole && previewable.some((r) => r.id === previewRole) ? previewRole : initial.role.id;
  const roleDecl = manifest.auth.roles.find((r) => r.id === role);

  return (
    <>
      <TopBar
        crumbs={[{ label: manifest.metadata.name }]}
        right={
          canInspect ? (
            <Tooltip label="Inspect: preview as another role, entitlements, audit trail">
              <ActionIcon variant={role !== initial.role.id ? 'filled' : 'subtle'} color="ink" onClick={() => setInspectorOpen(true)} aria-label="Open inspector">
                <IconAdjustments size={16} />
              </ActionIcon>
            </Tooltip>
          ) : undefined
        }
      />
      <Container size="xl" py="lg">
        {role !== initial.role.id && (
          <Alert color="ink" variant="light" mb="md" py={6}>
            <Text size="sm">
              Previewing as <b>{roleDecl?.display_name ?? role}</b>. Your own role for this app is {initial.role.display_name}.
            </Text>
          </Alert>
        )}
        {needsPatient ? (
          <Paper withBorder p="md" maw={760} data-testid="choose-patient">
            <Stack gap="sm">
              <div>
                <Title order={4}>{manifest.metadata.name}</Title>
                <Text size="sm" c="dimmed">
                  This app is about one patient. Choose who to open it for.
                </Text>
              </div>
              <PatientPicker value={chosenPatient} onChange={setChosenPatient} config={config} purpose="Whose record this app shows." search={searchPatients} />
              <Button
                w="fit-content"
                disabled={!chosenPatient}
                onClick={() =>
                  setSearch((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('patient_id', chosenPatient);
                    return next;
                  })
                }
                data-testid="open-for-patient"
              >
                Open
              </Button>
            </Stack>
          </Paper>
        ) : (
          <ManifestApp
            key={`${manifest.metadata.app_id}@${manifest.metadata.version}:${role}`}
            manifest={manifest}
            role={role}
            context={context}
            executor={executor}
            config={config}
            identity={{ sub: session.claims.sub, idToken: session.idToken, displayName: displayNameOf(session.claims) }}
            byline={authorLabel(entry.meta)}
            onAudit={onAudit}
            onDiagnostic={onDiagnostic}
          />
        )}
      </Container>

      {canInspect && (
        <Drawer
          opened={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          position="right"
          size="lg"
          title="Inspector"
          // The drawer is a column: the sections above take their height, the audit trail takes the rest and scrolls.
          styles={{ content: { display: 'flex', flexDirection: 'column' }, body: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, paddingBottom: 0 } }}
        >
          <Stack gap="lg" style={{ flex: 1, minHeight: 0 }}>
            <div>
              <Group justify="space-between" align="baseline" mb={6}>
                <Title order={5}>Preview as</Title>
                <Text size="xs" c="dimmed">
                  {initial.source === 'group' ? `Your groups grant: ${entitled.map((r) => r.display_name).join(', ')}` : 'No group grants you a role for this app'}
                </Text>
              </Group>
              {previewable.length > 1 ? (
                <SegmentedControl size="sm" fullWidth value={role} onChange={setPreviewRole} data={previewable.map((r) => ({ value: r.id, label: r.display_name }))} />
              ) : (
                <Text size="sm">
                  <b>{previewable[0]?.display_name ?? initial.role.display_name}</b> — the app's only role.
                </Text>
              )}
              {initial.source !== 'group' && (
                <Text size="xs" c="dimmed" mt={6}>
                  {isMock
                    ? `Mock mode falls back to the manifest default (${initial.role.display_name}); a real deployment would refuse you.`
                    : 'In a real deployment you would be refused.'}
                </Text>
              )}
            </div>

            <Divider />

            <div>
              <Title order={5} mb={6}>
                App
              </Title>
              <dl className="ds-facts" data-testid="app-facts">
                <dt>App id</dt>
                <dd className="ds-mono">{manifest.metadata.app_id}</dd>
                <dt>Version</dt>
                <dd className="ds-mono">{manifest.metadata.version}</dd>
                <dt>State</dt>
                <dd>
                  <Badge size="sm" color={lifecycleColor(manifest.lifecycle.state)} tt="none">
                    {manifest.lifecycle.state.replace('_', ' ')}
                  </Badge>
                </dd>
                <dt>Kind</dt>
                <dd>{manifest.metadata.intent_class.replace(/_/g, ' ')}</dd>
              </dl>
            </div>

            {authoring && entry && (
              <>
                <Divider />
                <div>
                  <Title order={5} mb={6}>
                    Lifecycle
                  </Title>
                  <LifecycleActions entry={entry} claims={session.claims} isMock={isMock} client={authoring} onChanged={() => onRegistryChanged?.()} />
                </div>
              </>
            )}

            {diagnostics.length > 0 && (
              <Alert color="yellow" title="Renderer diagnostics" variant="light">
                <Stack gap={2}>
                  {diagnostics.map((d, i) => (
                    <Text key={i} size="xs">
                      {d.message}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            <Divider />

            <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
              <Group justify="space-between" align="baseline" mb={6}>
                <Title order={5}>Audit trail</Title>
                <Text size="xs" c="dimmed" className="ds-tabular">
                  {audit.length} {audit.length === 1 ? 'call' : 'calls'}
                </Text>
              </Group>
              <Text size="xs" c="dimmed" mb="xs">
                One record per data primitive call — what this app requested, as which role, for which patient — as this browser saw it. The data
                source writes the authoritative record to the audit trail and names it in its answer, so the outcome shown is its verdict
                {canOpenTrail ? '; the trail icon opens that record' : ''}. A call refused here before any request was made has no record there.
                {auditUniform && audit[0] && (
                  <>
                    {' '}
                    All calls as <b>{audit[0].role}</b>
                    {audit[0].patient_context ? (
                      <>
                        {' '}
                        for <span className="ds-mono">{audit[0].patient_context}</span>
                      </>
                    ) : null}
                    .
                  </>
                )}
              </Text>
              <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto" offsetScrollbars>
                <Table withRowBorders fz="xs" className="ds-audit" data-testid="audit-trail" style={{ tableLayout: 'fixed' }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 96 }}>Time</Table.Th>
                      <Table.Th>Call</Table.Th>
                      <Table.Th style={{ width: 200 }}>Outcome</Table.Th>
                      <Table.Th style={{ width: 52, textAlign: 'right' }}>ms</Table.Th>
                      {canOpenTrail && <Table.Th style={{ width: 36 }} aria-label="Audit trail" />}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {audit.map((r, i) => (
                      <Table.Tr key={i}>
                        <Table.Td className="ds-mono" style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                          {r.timestamp.slice(11, 23)}
                        </Table.Td>
                        <Table.Td style={{ verticalAlign: 'top' }}>
                          <Text size="xs" className="ds-mono" style={{ wordBreak: 'break-all' }}>
                            {r.primitive_id}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {r.kind}
                            {auditUniform ? '' : ` · ${r.role}${r.patient_context ? ` · ${r.patient_context}` : ''}`}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ verticalAlign: 'top' }}>
                          <Badge size="sm" color={r.outcome === 'ok' ? 'clinical' : r.outcome === 'refused' ? 'red' : 'orange'} tt="none">
                            {r.outcome}
                          </Badge>
                          {r.detail && (
                            <Text size="xs" c="dimmed" mt={2} style={{ overflowWrap: 'anywhere' }}>
                              {r.detail}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td className="ds-tabular" style={{ textAlign: 'right', verticalAlign: 'top' }}>
                          {r.duration_ms}
                        </Table.Td>
                        {canOpenTrail && (
                          <Table.Td style={{ verticalAlign: 'top', textAlign: 'right' }}>
                            {r.audit_id ? (
                              <Tooltip label={`Open in the audit trail — record ${r.audit_id}`} withinPortal>
                                <ActionIcon component={Link} to={deepLinkTo({ audit_id: r.audit_id, timestamp: r.timestamp })} variant="subtle" color="gray" size="sm" aria-label={`Open record ${r.audit_id} in the audit trail`} data-testid="audit-open-trail">
                                  <IconHistory size={14} />
                                </ActionIcon>
                              </Tooltip>
                            ) : (
                              <Tooltip label="Refused in the browser before any request — not in the trail" withinPortal>
                                <Text span size="xs" c="dimmed" aria-label="Not in the audit trail" data-testid="audit-browser-only">
                                  —
                                </Text>
                              </Tooltip>
                            )}
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </div>
          </Stack>
        </Drawer>
      )}
    </>
  );
}
