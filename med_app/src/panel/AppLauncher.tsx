import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Anchor, Badge, Button, Code, Container, Group, List, Paper, Stack, Switch, Table, Tabs, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconAlertTriangle, IconFilter, IconGitCompare, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { appPath, authorLabel, isMine, reviewPath, type RegistryEntry } from '../manifest/registry';
import { AuthorLine } from './AuthorLine';
import { sentBack } from '../manifest/history';
import { HistoryEvent } from './VersionHistory';
import type { AppManifest } from '../manifest/schema';
import { appAccess, canAuthor, canCurate, isPlatformStaff, type AppAccess } from '../manifest/roles';
import { facetsOf, matchesSearch, matchesSelection, type AppFacets, type FacetSelection } from '../manifest/facets';
import type { Collection, CollectionsClient } from '../collections';
import { AppCard, CardGrid, CollectionsSection, FacetBar, YourApps, type BrowseRow } from './browse';
import { collectableApps, CollectionsDrawer } from './CollectionsDrawer';
import { readPersonal, togglePin } from './personal';
import { useAuth } from '../auth/AuthContext';
import type { AuthoringClient, DraftSummary } from '../authoring/types';
import type { RuntimeConfig } from '../config/env';
import type { PatientHit } from '../primitives/data/types';
import { PatientPicker, rememberedPatient, seedPatientOptions } from './PatientPicker';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';
import { PanelShell } from './PanelShell';
import { tokens } from '../theme';

type ValidEntry = Extract<RegistryEntry, { ok: true }>;
type TabId = 'apps' | 'drafts' | 'review' | 'deprecated';

interface Row {
  readonly entry: ValidEntry;
  readonly manifest: AppManifest;
  readonly facets: AppFacets;
  readonly roles: AppAccess['roles'];
  readonly canOpen: boolean;
  /** Why it cannot be opened, when it cannot. */
  readonly reason?: AppAccess['reason'];
}

/** Why the Open button is disabled, in words — shown as its tooltip. */
export function cannotOpenBecause(row: Pick<Row, 'canOpen' | 'reason' | 'manifest'>, patientChosen: boolean): string | undefined {
  if (!row.canOpen) {
    if (row.reason === 'not_published') return 'Not published yet: it can be opened once it has been reviewed and published.';
    return 'Your groups grant you no role for this app. Access comes with your hospital groups; ask your administrator.';
  }
  if (scopeLabel(row.manifest) === 'Single patient' && !patientChosen) return 'This app is about one patient. Choose a patient above to open it.';
  return undefined;
}


export function lifecycleColor(state: AppManifest['lifecycle']['state']): string {
  switch (state) {
    case 'published':
      return 'clinical';
    case 'approved':
      return 'teal';
    case 'in_review':
      return 'yellow';
    case 'deprecated':
      return 'gray';
    default:
      return 'ink';
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Single patient vs population — the one thing about an app's shape a clinician needs to know. */
function scopeLabel(m: AppManifest): 'Single patient' | 'Population' {
  return m.context_inputs.some((c) => c.name === 'patient_id' && c.required) ? 'Single patient' : 'Population';
}

/**
 * The home page. Clinicians see the apps they can open — name, what it is for, whether it is
 * about one patient or a population — and an Open button. Platform staff (authors, approvers,
 * admins — or anyone in mock mode) get four tabs: the published apps, what is being drafted (their
 * own drafting conversations and versions saved as drafts), the versions pending sign-off, and the
 * deprecated ones — out of service, superseded or retired, which clinicians no longer see or open and
 * staff may still open for reference; plus manifests the registry rejected. A published app and its
 * newer draft or in-review version are two rows in two tabs — the registry lists both for staff.
 */
/**
 * A manifest refused only for keys this bundle does not know was written by a newer platform than the page is running:
 * the registry's compiler and this page agree on everything else. A stale tab — open across a deploy — is the usual way
 * to see it (a colleague's screenshot, 2026-10-12: four apps with designed forms, each "Unrecognized key: artifacts").
 */
function onlyUnknownKeys(issues: readonly { message: string }[]): boolean {
  return issues.length > 0 && issues.every((i) => /^Unrecognized key/.test(i.message));
}

export function AppLauncher({
  registry,
  config,
  authoring,
  onRegistryChanged,
  searchPatients,
  collections,
}: {
  registry: RegistryEntry[];
  config: RuntimeConfig;
  authoring?: AuthoringClient;
  /** The registry changed from here (a draft was submitted) — reload it; resolves when the fresh list is in. */
  onRegistryChanged?: () => void | Promise<void>;
  /** The patient lookup by name for the launch context (the executor's, in dispatcher mode). */
  searchPatients?: (name: string) => Promise<PatientHit[]>;
  /** The hospital's collections — read by everyone, curated by approvers and admins; absent = no collections section. */
  collections?: CollectionsClient;
}) {
  const { session } = useAuth();
  const isMock = config.auth.mode === 'mock';
  const staff = isMock || (session ? isPlatformStaff(session.claims) : false);
  // Authors (and admins) draft apps; in mock mode anyone can, so the loop can be tried without a pool.
  const author = Boolean(authoring) && (isMock || (session ? canAuthor(session.claims) : false));
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  useEffect(() => {
    if (!author || !authoring) return;
    let cancelled = false;
    authoring
      .listDrafts()
      .then((d) => !cancelled && setDrafts(d))
      .catch(() => !cancelled && setDrafts([]));
    return () => {
      cancelled = true;
    };
  }, [author, authoring]);

  // The hospital's collections, as this person may see them; reloaded after a curator saves.
  const [collectionList, setCollectionList] = useState<Collection[]>([]);
  const loadCollections = useCallback(async () => {
    if (!collections) return;
    try {
      setCollectionList(await collections.list());
    } catch {
      setCollectionList([]); // the launcher works without them
    }
  }, [collections]);
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);
  const curator = Boolean(collections) && (isMock || (session ? canCurate(session.claims) : false));
  const [curating, setCurating] = useState(false);

  // The person's own corner: pinned and recently opened apps, kept in this browser.
  const sub = session?.claims.sub ?? '';
  const [personal, setPersonal] = useState(() => readPersonal(config.hospitalId, sub));
  useEffect(() => setPersonal(readPersonal(config.hospitalId, sub)), [config.hospitalId, sub]);
  // togglePin writes localStorage: call it once, outside the state updater (React may invoke an updater twice in development
  // to flag impurity — which here pinned and unpinned in the same click, leaving the UI pinned and the storage empty).
  const onTogglePin = (appId: string) => {
    const pins = togglePin(config.hospitalId, sub, appId);
    setPersonal((p) => ({ ...p, pins }));
  };

  // The tab lives in the URL so "back to the registry" from a draft lands on the right one.
  const [search, setSearch] = useSearchParams();
  const tabParam = search.get('tab');
  const tab: TabId = (tabParam === 'drafts' && author) || ((tabParam === 'review' || tabParam === 'deprecated') && staff) ? tabParam : 'apps';
  const selectTab = (t: string | null) => {
    const next = new URLSearchParams(search);
    if (!t || t === 'apps') next.delete('tab');
    else next.set('tab', t);
    setSearch(next, { replace: true });
  };

  // Who single-patient apps open for (see PatientPicker for where the list comes from): the first synthetic patient
  // in mock mode; against a hospital's record the patient this tab chose before, else nobody until one is picked.
  const [effectivePatient, setEffectivePatient] = useState<string>(() => (config.data.mode === 'dispatcher' && searchPatients ? (rememberedPatient()?.id ?? '') : (seedPatientOptions()[0]?.value ?? '')));

  const valid = registry.filter((e): e is ValidEntry => e.ok);
  const rejected = registry.filter((e): e is Extract<RegistryEntry, { ok: false }> => !e.ok);

  // Narrowing the list: a search over what the apps are about (name, description, domains, codes, roles, purpose), the
  // facet chips, and — for staff — the apps and versions one made oneself.
  const [filter, setFilter] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [selection, setSelection] = useState<FacetSelection>({});
  // The chips take room: clinicians get them open (their list is the whole page), staff open them when they want them.
  const [chipsOpen, setChipsOpen] = useState(!staff);
  const chosenChips = Object.values(selection).reduce((n, v) => n + (v?.length ?? 0), 0);
  const needle = filter.trim();
  const facetsByFile = useMemo(() => new Map(valid.map((e) => [e.file, facetsOf(e)])), [valid]);

  // What this person may open: a role for the app, and — unless they are staff — a published
  // version. Staff also see the apps they cannot open, greyed out.
  const allRows: Row[] = valid
    .filter((e) => !onlyMine || isMine(e.meta, session?.claims.sub))
    .map((entry) => {
      const access = session ? appAccess(entry.manifest, session.claims, { isMock }) : { roles: [], canOpen: false as const, reason: 'no_role' as const };
      return { entry, manifest: entry.manifest, facets: facetsByFile.get(entry.file)!, roles: access.roles, canOpen: access.canOpen, reason: access.canOpen ? undefined : access.reason };
    })
    .filter((r) => r.canOpen || staff);
  const rows = allRows.filter((r) => matchesSearch(r.facets, needle) && matchesSelection(r.facets, selection));
  // The chips count among the published apps this person sees (every state for staff, so a chip narrows every tab alike).
  const facetPool = (staff ? allRows : allRows.filter((r) => r.manifest.lifecycle.state === 'published')).map((r) => r.facets);

  const byName = (a: Row, b: Row) => a.manifest.metadata.name.localeCompare(b.manifest.metadata.name);
  const appRows = rows.filter((r) => r.manifest.lifecycle.state === 'published').sort(byName);
  const draftRows = rows.filter((r) => r.manifest.lifecycle.state === 'draft').sort(byName);
  const reviewRows = rows.filter((r) => r.manifest.lifecycle.state === 'in_review' || r.manifest.lifecycle.state === 'approved').sort(byName);
  // Out of service: superseded when a newer version of the app is published, retired otherwise. Clinicians never
  // receive these from the registry API (and the dispatcher refuses them); staff may open one for reference.
  const deprecatedRows = rows.filter((r) => r.manifest.lifecycle.state === 'deprecated').sort(byName);
  const supersededBy = (row: Row): string | undefined => appRows.find((r) => r.manifest.metadata.app_id === row.manifest.metadata.app_id)?.manifest.metadata.version;
  // Drafting conversations still in progress; the ones already saved appear as their registry version,
  // with a link back to the conversation.
  const inProgress = (drafts ?? []).filter((d) => !d.saved_as);
  const conversationFor = new Map((drafts ?? []).filter((d) => d.saved_as).map((d) => [`${d.saved_as!.app_id}@${d.saved_as!.version}`, d.session_id]));

  const openHref = (row: Row) => {
    const needsPatient = scopeLabel(row.manifest) === 'Single patient';
    return `${appPath(row.entry)}${needsPatient && effectivePatient ? `?patient_id=${encodeURIComponent(effectivePatient)}` : ''}`;
  };
  const canOpenNow = (row: Row) => row.canOpen && !(scopeLabel(row.manifest) === 'Single patient' && !effectivePatient);
  const whyNot = (row: Row) => cannotOpenBecause(row, Boolean(effectivePatient));

  const narrowing = (
    <Group gap="md" align="center" wrap="wrap" data-testid="registry-filters">
      <TextInput
        placeholder="Search apps — a name, a diagnosis, a code, a role"
        leftSection={<IconSearch size={14} />}
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        size="sm"
        w={340}
        aria-label="Search apps"
        data-testid="registry-filter"
      />
      <Button size="xs" variant={chipsOpen || chosenChips ? 'light' : 'subtle'} color={chosenChips ? 'clinical' : 'gray'} leftSection={<IconFilter size={14} />} onClick={() => setChipsOpen((o) => !o)} data-testid="facets-toggle">
        {chosenChips ? `Narrowed by ${chosenChips} ${chosenChips === 1 ? 'chip' : 'chips'}` : 'Narrow by kind, domain, audience'}
      </Button>
      {staff && (
        <Switch
          checked={onlyMine}
          onChange={(e) => setOnlyMine(e.currentTarget.checked)}
          label="Only my apps"
          description={undefined}
          size="sm"
          color="clinical"
          data-testid="registry-only-mine"
        />
      )}
      {(needle || onlyMine || Object.values(selection).some((v) => v?.length)) && (
        <Text size="xs" c="dimmed" className="ds-tabular" data-testid="registry-narrowed">
          {rows.length} of {valid.length} {valid.length === 1 ? 'entry' : 'entries'} shown
        </Text>
      )}
    </Group>
  );
  const facetBar = chipsOpen ? <FacetBar all={facetPool} selection={selection} search={needle} onChange={setSelection} /> : null;

  // An app as a card, for the browse view, the collections and "your apps".
  const browseRow = (row: Row): BrowseRow => ({ entry: row.entry, manifest: row.manifest, facets: row.facets, canOpen: row.canOpen });
  const card = (row: Row, compact = false) => (
    <AppCard key={row.manifest.metadata.app_id} row={browseRow(row)} pinned={personal.pins.includes(row.manifest.metadata.app_id)} onTogglePin={onTogglePin} compact={compact} open={<OpenButton href={openHref(row)} enabled={canOpenNow(row)} reason={whyNot(row)} testId={`open-${row.manifest.metadata.app_id}`} />} />
  );
  const byAppId = new Map(appRows.map((r) => [r.manifest.metadata.app_id, r]));
  // The person's own corner. Clinicians always see it (its empty state says how to fill it); staff get the pin on every card
  // too, so their corner appears in the Published tab as soon as something is pinned or opened — a pin that did nothing was a bug.
  const publishedRows = allRows.filter((r) => r.manifest.lifecycle.state === 'published');
  const hasPersonal = [...personal.pins, ...personal.recent].some((id) => publishedRows.some((r) => r.manifest.metadata.app_id === id));
  const yourApps = <YourApps rows={publishedRows.map(browseRow)} pins={personal.pins} recent={personal.recent} renderCard={(r) => card(byAppId.get(r.manifest.metadata.app_id) ?? allRows.find((x) => x.manifest.metadata.app_id === r.manifest.metadata.app_id)!, true)} />;

  const collectionsBlock = collections ? (
    <CollectionsSection
      collections={collectionList}
      rows={appRows.map(browseRow)}
      renderCard={(r) => card(byAppId.get(r.manifest.metadata.app_id)!, true)}
      actions={
        curator ? (
          <Button size="xs" variant="default" leftSection={<IconAdjustmentsHorizontal size={14} />} onClick={() => setCurating(true)} data-testid="manage-collections">
            Manage collections
          </Button>
        ) : undefined
      }
    />
  ) : null;

  const appsTable = (
    <AppsTable
      rows={appRows}
      columns={{ version: staff, roles: staff, state: false }}
      isMock={isMock}
      openHref={openHref}
      canOpenNow={canOpenNow}
      whyNot={whyNot}
      empty={
        staff
          ? 'No published apps yet. Published apps appear here once an approver has signed a version off and published it.'
          : 'No published apps are available to you yet. Access comes with your hospital groups: a role group of an app (app-<id>-<role>), or medapp-viewers, which opens every published app in its default role. Ask your administrator.'
      }
    />
  );

  return (
    <PanelShell isMock={isMock}>
      <Container size="lg" py="lg">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={2}>App registry</Title>
              <Text size="sm" c="dimmed" mt={2}>
                {staff
                  ? 'The clinical apps of this hospital: what clinicians can open today, what is being drafted, and what is waiting to be signed off.'
                  : 'The clinical apps you can open. Choose a patient, then open an app.'}
              </Text>
            </div>
            {author && (
              <Button component={Link} to="/drafts/new" size="sm" leftSection={<IconPlus size={16} />} data-testid="new-app">
                New app
              </Button>
            )}
          </Group>

          <Paper withBorder p="md">
            <PatientPicker value={effectivePatient} onChange={setEffectivePatient} config={config} search={searchPatients} />
          </Paper>

          {!staff ? (
            <>
              {yourApps}
              {collectionsBlock}
              <Stack gap="sm" data-testid="all-apps">
                <Group justify="space-between" align="baseline">
                  <Title order={4}>All apps</Title>
                  <Text size="xs" c="dimmed" className="ds-tabular">
                    {appRows.length} of {allRows.filter((r) => r.manifest.lifecycle.state === 'published').length}
                  </Text>
                </Group>
                {narrowing}
                {facetBar}
                {appRows.length === 0 ? (
                  <Paper withBorder p="md">
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      {allRows.length === 0
                        ? 'No published apps are available to you yet. Access comes with your hospital groups: a role group of an app (app-<id>-<role>), or medapp-viewers, which opens every published app in its default role. Ask your administrator.'
                        : 'No app matches. Clear a chip or shorten the search.'}
                    </Text>
                  </Paper>
                ) : (
                  <CardGrid>{appRows.map((r) => card(r))}</CardGrid>
                )}
              </Stack>
            </>
          ) : (
            <Stack gap="lg">
            {narrowing}
            {facetBar}
            <Tabs value={tab} onChange={selectTab} keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="apps" rightSection={<Count n={appRows.length} />}>
                  Published apps
                </Tabs.Tab>
                {author && (
                  <Tabs.Tab value="drafts" rightSection={<Count n={inProgress.length + draftRows.length} />} data-testid="tab-drafts">
                    Drafts
                  </Tabs.Tab>
                )}
                <Tabs.Tab value="review" rightSection={<Count n={reviewRows.length} />} data-testid="tab-review">
                  Pending sign-off
                </Tabs.Tab>
                <Tabs.Tab value="deprecated" rightSection={<Count n={deprecatedRows.length} />} data-testid="tab-deprecated">
                  Deprecated
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="apps" pt="md">
                <Stack gap="lg">
                  {hasPersonal && yourApps}
                  {collectionsBlock}
                  <Paper withBorder p="md">{appsTable}</Paper>
                </Stack>
              </Tabs.Panel>

              {author && (
                <Tabs.Panel value="drafts" pt="md">
                  <Paper withBorder p="md" data-testid="drafts-list">
                    <Text size="xs" c="dimmed" mb="xs">
                      A draft starts as a conversation with the assistant, kept in your drafts as you go. Saving compiles it into a version in the registry, which
                      you can open like any app to check it for real; submitting hands that version to an approver. Drafts are yours until they are submitted.
                    </Text>
                    <DraftsTable
                      sessions={inProgress}
                      versions={draftRows}
                      conversationFor={conversationFor}
                      openHref={openHref}
                      canOpenNow={canOpenNow}
                      whyNot={whyNot}
                      onDelete={
                        authoring
                          ? async (sessionId) => {
                              await authoring.deleteDraft(sessionId);
                              setDrafts((prev) => (prev ? prev.filter((d) => d.session_id !== sessionId) : prev));
                            }
                          : undefined
                      }
                      onSubmit={
                        authoring
                          ? async (row) => {
                              await authoring.transition(row.manifest.metadata.app_id, row.manifest.metadata.version, 'in_review');
                              await onRegistryChanged?.(); // the row moves tabs only once the list knows its new state
                              selectTab('review');
                            }
                          : undefined
                      }
                    />
                  </Paper>
                </Tabs.Panel>
              )}

              <Tabs.Panel value="review" pt="md">
                <Paper withBorder p="md" data-testid="review-versions">
                  <Text size="xs" c="dimmed" mb="xs">
                    Versions submitted for review, and approved versions waiting to be published. Review one to see what changes against the published version and
                    to approve, send back or publish it — never your own version. Open runs it as a clinician would.
                  </Text>
                  <AppsTable
                    rows={reviewRows}
                    columns={{ version: true, roles: false, state: true }}
                    isMock={isMock}
                    openHref={openHref}
                    canOpenNow={canOpenNow}
                    whyNot={whyNot}
                    extra={(row) => (
                      <Button component={Link} to={reviewPath(row.entry)} size="xs" leftSection={<IconGitCompare size={14} />} data-testid="review-version">
                        Review
                      </Button>
                    )}
                    empty="Nothing is waiting for sign-off."
                  />
                </Paper>
              </Tabs.Panel>

              <Tabs.Panel value="deprecated" pt="md">
                <Paper withBorder p="md" data-testid="deprecated-versions">
                  <Text size="xs" c="dimmed" mb="xs">
                    Versions taken out of service — superseded when a newer version was published, or retired. Clinicians no longer see or open them and the
                    dispatcher refuses them; staff may open one for reference. Their role groups are kept so past sign-offs and audit records stay attributable.
                  </Text>
                  <AppsTable
                    rows={deprecatedRows}
                    columns={{
                      version: true,
                      roles: false,
                      state: false,
                      note: {
                        header: 'Why',
                        render: (row) => {
                          const successor = supersededBy(row);
                          return (
                            <Text size="sm" c="dimmed" data-testid="deprecated-why">
                              {successor ? `Superseded by ${successor}` : 'Retired — no published version'}
                            </Text>
                          );
                        },
                      },
                    }}
                    isMock={isMock}
                    openHref={openHref}
                    canOpenNow={canOpenNow}
                    whyNot={whyNot}
                    empty="No deprecated versions."
                  />
                </Paper>
              </Tabs.Panel>
            </Tabs>
            </Stack>
          )}

          {staff && rejected.length > 0 && (
            <Paper withBorder p="md" style={{ borderColor: tokens.alertTint }}>
              <Group gap="xs" mb="xs">
                <IconAlertTriangle size={18} color={tokens.alert} />
                <Title order={4}>Rejected by the registry</Title>
              </Group>
              <Stack gap="md">
                {rejected.map((e) => (
                  <div key={e.file}>
                    <Text fw={500}>
                      {e.name ?? e.file} <Code>{e.file}</Code>
                    </Text>
                    <List size="sm" mt={4}>
                      {e.issues.map((i, idx) => (
                        <List.Item key={idx}>
                          <Code>{i.path}</Code> — {i.message}
                        </List.Item>
                      ))}
                    </List>
                    {onlyUnknownKeys(e.issues) && (
                      <Text size="sm" c="dimmed" mt={4} data-testid={`rejected-newer-${e.file}`}>
                        The registry's compiler wrote this app with a newer version of the platform than this page was loaded with. Reload the page to see it.
                      </Text>
                    )}
                  </div>
                ))}
              </Stack>
            </Paper>
          )}

        </Stack>
      </Container>
      {collections && curator && (
        <CollectionsDrawer opened={curating} onClose={() => setCurating(false)} client={collections} collections={collectionList} apps={collectableApps(allRows.filter((r) => r.manifest.lifecycle.state === 'published').map((r) => r.manifest))} onChanged={loadCollections} />
      )}
    </PanelShell>
  );
}

/** The Open button; when it cannot open, a tooltip says why (a disabled element gets no hover of its own, hence the span). */
function OpenButton({ href, enabled, reason, testId }: { href: string; enabled: boolean; reason: string | undefined; testId?: string }) {
  const button = (
    <Button component={Link} to={href} size="xs" variant="light" disabled={!enabled} data-testid={testId}>
      Open
    </Button>
  );
  if (enabled || !reason) return button;
  return (
    <Tooltip label={reason} multiline w={260} position="left" withArrow>
      <span style={{ display: 'inline-block' }} data-testid="open-disabled" aria-label={reason}>
        {button}
      </span>
    </Tooltip>
  );
}

function Count({ n }: { n: number }) {
  return (
    <Badge size="xs" variant="light" color="clinical" circle={n < 10}>
      {n}
    </Badge>
  );
}

/**
 * One list of drafts, whatever their stage: conversations not yet saved (Continue), and versions saved
 * to the registry but not yet submitted (Open to check, Submit for review, or back to the conversation).
 */
function DraftsTable({
  sessions,
  versions,
  conversationFor,
  openHref,
  canOpenNow,
  whyNot,
  onSubmit,
  onDelete,
}: {
  sessions: readonly DraftSummary[];
  versions: readonly Row[];
  conversationFor: Map<string, string>;
  openHref: (row: Row) => string;
  canOpenNow: (row: Row) => boolean;
  /** Why a version cannot be opened right now — the disabled button's tooltip. */
  whyNot?: (row: Row) => string | undefined;
  onSubmit?: (row: Row) => Promise<void>;
  /** Remove an unsaved conversation for good. */
  onDelete?: (sessionId: string) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Deleting is two clicks: the row asks for confirmation in place, no modal.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const byRecent = (a: Row, b: Row) => (b.manifest.metadata.created_at ?? '').localeCompare(a.manifest.metadata.created_at ?? '');

  async function remove(sessionId: string) {
    if (!onDelete) return;
    setDeleting(sessionId);
    setProblem(null);
    try {
      await onDelete(sessionId);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }

  async function submit(row: Row) {
    if (!onSubmit) return;
    const key = `${row.manifest.metadata.app_id}@${row.manifest.metadata.version}`;
    setSubmitting(key);
    setProblem(null);
    try {
      await onSubmit(row);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(null);
    }
  }

  if (sessions.length === 0 && versions.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="md">
        No drafts.{' '}
        <Anchor component={Link} to="/drafts/new" size="sm">
          Start a new app
        </Anchor>{' '}
        — describe it in your own words and the assistant drafts it with you.
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      {problem && (
        <Text size="xs" c="red">
          {problem}
        </Text>
      )}
      <Table withRowBorders verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App name</Table.Th>
            <Table.Th>Stage</Table.Th>
            <Table.Th>Last change</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sessions.map((d) => (
            <Table.Tr key={d.session_id} data-testid={`draft-session-${d.session_id}`}>
              <Table.Td>
                <Text fw={500}>{d.title}</Text>
              </Table.Td>
              <Table.Td>
                <div style={{ whiteSpace: 'nowrap' }}>
                  {d.turn_status === 'queued' || d.turn_status === 'running' ? (
                    <Badge size="xs" color="yellow" tt="none" styles={KEEP_WHOLE}>
                      assistant working
                    </Badge>
                  ) : (
                    <Badge size="xs" color="orange" variant="light" tt="none" styles={KEEP_WHOLE}>
                      in conversation
                    </Badge>
                  )}
                </div>
                <Text size="xs" c="dimmed" mt={2}>
                  Kept in your drafts; no version in the registry yet.
                </Text>
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatWhen(d.updated_at)}</Table.Td>
              <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                {confirmDelete === d.session_id ? (
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      Delete this draft for good?
                    </Text>
                    <Button size="xs" color="red" onClick={() => void remove(d.session_id)} loading={deleting === d.session_id} data-testid={`confirm-delete-${d.session_id}`}>
                      Delete
                    </Button>
                    <Button size="xs" variant="subtle" color="gray" onClick={() => setConfirmDelete(null)} disabled={deleting !== null}>
                      Keep
                    </Button>
                  </Group>
                ) : (
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <Button component={Link} to={`/drafts/${encodeURIComponent(d.session_id)}`} size="xs" variant="light">
                      Continue
                    </Button>
                    {onDelete && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => setConfirmDelete(d.session_id)}
                        disabled={d.turn_status === 'queued' || d.turn_status === 'running'}
                        title={d.turn_status === 'queued' || d.turn_status === 'running' ? 'The assistant is working on this draft' : undefined}
                        data-testid={`delete-${d.session_id}`}
                      >
                        Delete
                      </Button>
                    )}
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
          {[...versions].sort(byRecent).map((row) => {
            const m = row.manifest;
            const key = `${m.metadata.app_id}@${m.metadata.version}`;
            const sid = conversationFor.get(key);
            return (
              <Table.Tr key={key} data-testid={`app-row-${m.metadata.app_id}`}>
                <Table.Td>
                  <Text fw={500}>{m.metadata.name}</Text>
                  <AuthorLine label={authorLabel(row.entry.meta)} />
                </Table.Td>
                <Table.Td>
                  <div style={{ whiteSpace: 'nowrap' }}>
                    <Badge size="xs" color={sentBack(row.entry) ? 'yellow' : 'ink'} tt="none" styles={KEEP_WHOLE}>
                      saved v{m.metadata.version} · {sentBack(row.entry) ? 'sent back' : 'not submitted'}
                    </Badge>
                  </div>
                  {sentBack(row.entry) ? (
                    <div style={{ marginTop: 6 }} data-testid={`sent-back-${m.metadata.app_id}`}>
                      <HistoryEvent item={sentBack(row.entry)!} compact />
                    </div>
                  ) : (
                    <Text size="xs" c="dimmed" mt={2}>
                      A version in the registry; open it to check it, then submit it for review.
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{m.metadata.created_at ? formatWhen(m.metadata.created_at) : '—'}</Table.Td>
                <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                  <Group gap="sm" justify="flex-end" wrap="nowrap">
                    {sid && (
                      <Anchor component={Link} to={`/drafts/${encodeURIComponent(sid)}`} size="xs">
                        Conversation
                      </Anchor>
                    )}
                    <OpenButton href={openHref(row)} enabled={canOpenNow(row)} reason={whyNot?.(row)} />
                    {onSubmit && (
                      <Button size="xs" onClick={() => void submit(row)} loading={submitting === key} disabled={submitting !== null} data-testid={`submit-${m.metadata.app_id}`}>
                        Submit for review
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

/** One table shape for all three tabs; the columns differ. */
function AppsTable({
  rows,
  columns,
  isMock,
  openHref,
  canOpenNow,
  whyNot,
  extra,
  empty,
}: {
  rows: readonly Row[];
  columns: { version: boolean; roles: boolean; state: boolean; note?: { header: string; render: (row: Row) => ReactNode } };
  isMock: boolean;
  openHref: (row: Row) => string;
  canOpenNow: (row: Row) => boolean;
  /** Why a row cannot be opened right now — the disabled button's tooltip. */
  whyNot?: (row: Row) => string | undefined;
  /** An extra action next to Open (e.g. the drafting conversation). */
  extra?: (row: Row) => ReactNode;
  empty: string;
}) {
  const colSpan = 3 + (columns.version ? 1 : 0) + (columns.roles ? 1 : 0) + (columns.state ? 1 : 0) + (columns.note ? 1 : 0);
  return (
    <Table withRowBorders verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>App name</Table.Th>
          <Table.Th>Scope</Table.Th>
          {columns.version && <Table.Th>Version</Table.Th>}
          {columns.state && <Table.Th>State</Table.Th>}
          {columns.note && <Table.Th>{columns.note.header}</Table.Th>}
          {columns.roles && <Table.Th>Your roles</Table.Th>}
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => {
          const m = row.manifest;
          return (
            <Table.Tr key={`${m.metadata.app_id}@${m.metadata.version}`} style={{ opacity: row.canOpen ? 1 : 0.55 }} data-testid={`app-row-${m.metadata.app_id}`}>
              <Table.Td>
                <Group gap="xs" align="baseline">
                  <Text fw={500}>{m.metadata.name}</Text>
                  {!columns.state && m.lifecycle.state !== 'published' && (
                    <Badge size="xs" color={lifecycleColor(m.lifecycle.state)} tt="none">
                      {m.lifecycle.state.replace('_', ' ')}
                    </Badge>
                  )}
                </Group>
                {m.metadata.description && (
                  <Text size="sm" c="dimmed" lineClamp={2}>
                    {m.metadata.description}
                  </Text>
                )}
                <AuthorLine label={authorLabel(row.entry.meta)} />
              </Table.Td>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{scopeLabel(m)}</Table.Td>
              {columns.version && <Table.Td style={{ whiteSpace: 'nowrap' }}>{m.metadata.version}</Table.Td>}
              {columns.state && (
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  <Badge size="xs" color={lifecycleColor(m.lifecycle.state)} tt="none" styles={KEEP_WHOLE}>
                    {m.lifecycle.state.replace('_', ' ')}
                  </Badge>
                </Table.Td>
              )}
              {columns.note && <Table.Td style={{ whiteSpace: 'nowrap' }}>{columns.note.render(row)}</Table.Td>}
              {columns.roles && (
                <Table.Td>
                  {row.roles.length ? (
                    row.roles.map((r) => r.display_name).join(', ')
                  ) : (
                    <Text size="sm" c="dimmed">
                      {isMock ? `none (mock falls back to ${m.auth.default_role})` : 'no access'}
                    </Text>
                  )}
                </Table.Td>
              )}
              <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                <Group gap="sm" justify="flex-end" wrap="nowrap">
                  {extra?.(row)}
                  <OpenButton href={openHref(row)} enabled={canOpenNow(row)} reason={whyNot?.(row)} />
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        })}
        {rows.length === 0 && (
          <Table.Tr>
            <Table.Td colSpan={colSpan}>
              <Text size="sm" c="dimmed" ta="center" py="md">
                {empty}
              </Text>
            </Table.Td>
          </Table.Tr>
        )}
      </Table.Tbody>
    </Table>
  );
}
