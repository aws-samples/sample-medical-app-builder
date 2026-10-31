import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Anchor, Badge, Box, Button, Center, Code, Group, Loader, ScrollArea, Stack, Tabs, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconDeviceFloppy, IconExternalLink, IconSend } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import { displayNameOf } from '../auth/types';
import { AuthoringApiError, editableDraft, type AppRef, type AuthoringClient, type GroupInfo, type LifecycleState, type PlainSpec } from '../authoring/types';
import type { RuntimeConfig } from '../config/env';
import { findEntry, type RegistryEntry } from '../manifest/registry';
import { sentBack } from '../manifest/history';
import type { ShapesClient } from '../shapes';
import { draftSpecForShape } from './shapes/openAsApp';
import { HistoryEvent } from './VersionHistory';
import { tokens } from '../theme';
import { ChatPane } from './drafting/ChatPane';
import { GovernanceEditor } from './drafting/GovernanceEditor';
import { RolesEditor } from './drafting/RolesEditor';
import { KnobsPanel } from './drafting/KnobsPanel';
import { OverviewEditor } from './drafting/OverviewEditor';
import { PreviewPane } from './drafting/PreviewPane';
import { openSectionCount, SectionStanding, SectionTabs, sectionStandings } from './drafting/ReadinessList';
import { readSpec, specsEqual, type SectionId } from './drafting/specView';
import { useDraft } from './drafting/useDraft';
import { TopBar } from './TopBar';

type Tab = SectionId | 'preview';

export interface DraftingPageProps {
  client: AuthoringClient;
  registry: RegistryEntry[];
  config: RuntimeConfig;
  /** The registry changed (an app was saved or moved through its lifecycle) — reload it; resolves when the fresh list is in. */
  onRegistryChanged: () => void | Promise<void>;
}

/**
 * Where an app is drafted: the conversation on the left, the draft it produces on the right. Both
 * change the same server-side draft through validated operations — the chat via the agent's tools,
 * the panel via PATCH — so what the person sees is always what will be compiled. Saving compiles the
 * spec into a manifest in the registry (a draft version); submitting it for review is a separate,
 * explicit step.
 */
export function DraftingPage({ client, registry, config, onRegistryChanged }: DraftingPageProps) {
  const { draftId = '' } = useParams();
  const { session } = useAuth();
  const draft = useDraft(client, draftId);
  const [tab, setTab] = useState<Tab>('overview');
  const [groups, setGroups] = useState<readonly GroupInfo[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .listGroups()
      .then((g) => !cancelled && setGroups(g))
      .catch(() => !cancelled && setGroups([]));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const view = draft.view;
  const reading = useMemo(() => (view ? readSpec(view.spec) : null), [view]);
  const staff = config.auth.mode === 'mock' || Boolean(session && session.claims.groups.some((g) => g.startsWith('medapp-')));
  const iteratesEntry = view?.iterates ? findEntry(registry, view.iterates.app_id) : undefined;

  if (draft.loading && !view) {
    return (
      <>
        <TopBar crumbs={[{ label: 'Draft' }]} />
        <Center mih="50vh">
          <Loader size="sm" />
        </Center>
      </>
    );
  }
  if (!view || !reading || !session) {
    return (
      <>
        <TopBar crumbs={[{ label: 'Draft' }]} />
        <Center mih="50vh">
          <Alert color="red" title="This draft could not be opened" variant="light" maw={520}>
            <Stack gap="xs">
              <Text size="sm">{draft.error ?? 'No such draft.'}</Text>
              <Group gap="xs">
                <Button size="xs" variant="light" onClick={() => void draft.refresh()}>
                  Try again
                </Button>
                <Anchor component={Link} to="/" size="sm">
                  Back to the app registry
                </Anchor>
              </Group>
            </Stack>
          </Alert>
        </Center>
      </>
    );
  }

  const saved = view.saved_as;
  const ready = view.open.length === 0;
  // The checklist by tab: what each section still needs. Counted in sections for the badge — fields read as a different
  // number than the panel showed, which confused the first reviewers.
  const standings = sectionStandings(view.open, Boolean(reading.archetype));
  const openSections = openSectionCount(standings);
  // The state of the version this conversation was saved as: stamped on the draft by the registry writer, else read from
  // the registry itself (a conversation saved before the stamp existed). A draft version is still the author's to change
  // here — "Save changes" revises it in place; from submission on the conversation is frozen and changes go through "Iterate".
  const savedEntry = saved ? findEntry(registry, saved.app_id, saved.version) : undefined;
  const savedState: LifecycleState | null = saved ? (saved.state ?? savedEntry?.manifest.lifecycle.state ?? null) : null;
  const editable = editableDraft({ saved_as: saved ? { ...saved, state: savedState ?? undefined } : null });
  const readOnly = !editable || draft.busy;
  const chatDisabled = !editable && saved ? `Saved as ${saved.app_id} v${saved.version} and submitted for review — iterate on the app to change it.` : undefined;
  // Saving something identical to the version it came from would only make noise: the button waits for a change.
  const baseline = saved ? savedEntry?.meta?.spec : view.iterates ? findEntry(registry, view.iterates.app_id, view.iterates.version)?.meta?.spec : undefined;
  const unchanged = baseline !== undefined && specsEqual(view.spec, baseline);
  const saveLabel = saved ? 'Save changes' : view.iterates ? 'Save as new version' : 'Save to registry';
  const unchangedNote = saved ? `No changes since the saved v${saved.version}.` : view.iterates ? `No changes compared to v${view.iterates.version}.` : undefined;

  async function save() {
    setSaveError(null);
    setSaving(true);
    try {
      if (saved) {
        await client.replaceVersion(saved.app_id, saved.version, view!.session_id);
      } else if (view!.iterates) {
        await client.saveVersion(view!.iterates.app_id, view!.session_id);
      } else {
        await client.saveApp(view!.session_id);
      }
      // The registry first, so the "Open the app" link that appears with the saved draft already resolves.
      await onRegistryChanged();
      await draft.refresh();
    } catch (err) {
      if (err instanceof AuthoringApiError && err.status === 409 && err.body.app_id) {
        setSaveError(`${err.message} You can change the app id under App.`);
      } else if (err instanceof AuthoringApiError && Array.isArray(err.body.issues)) {
        setSaveError(`The draft does not compile: ${(err.body.issues as { path: string; message: string }[]).map((i) => `${i.path} — ${i.message}`).join('; ')}`);
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function submitForReview() {
    if (!saved) return;
    setSaveError(null);
    setSubmitting(true);
    try {
      await client.transition(saved.app_id, saved.version, 'in_review');
      await onRegistryChanged();
      await draft.refresh(); // the conversation is frozen from here: the draft carries the new state
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = saved ? (
    <Badge color={savedState === 'in_review' ? 'yellow' : 'ink'} tt="none">
      saved · {savedState === 'in_review' ? 'in review' : savedState ?? 'draft'}
      {saved && editable && !unchanged ? ' · unsaved changes' : ''}
    </Badge>
  ) : ready ? (
    <Badge color="clinical" tt="none">
      ready to save
    </Badge>
  ) : (
    <Badge color="orange" variant="light" tt="none" data-testid="open-sections">
      {openSections} {openSections === 1 ? 'section' : 'sections'} missing required information
    </Badge>
  );

  return (
    <>
      <TopBar crumbs={[{ label: view.title }]} right={statusBadge} />
      <Group align="stretch" gap={0} wrap="nowrap" style={{ height: 'calc(100vh - 57px)', overflow: 'hidden' }}>
        {/* Left: the conversation */}
        <Box style={{ flex: '0 0 42%', minWidth: 360, borderRight: `1px solid ${tokens.line}`, display: 'flex', flexDirection: 'column', minHeight: 0, background: tokens.surface }}>
          <Box px="md" py="sm" style={{ borderBottom: `1px solid ${tokens.line}` }}>
            <Title order={5}>Drafting assistant</Title>
            <Text size="xs" c="dimmed">
              Describe, answer, refine. The draft on the right follows the conversation.
            </Text>
          </Box>
          <ChatPane
            view={view}
            busy={draft.busy}
            disabledReason={chatDisabled}
            onSend={draft.send}
            iterating={view.iterates ? { app_id: view.iterates.app_id, version: view.iterates.version, name: iteratesEntry?.manifest.metadata.name } : undefined}
            handoff={
              ready && editable && !unchanged
                ? {
                    label: saveLabel,
                    saving,
                    onSave: () => void save(),
                    note: saved
                      ? `You changed the draft since it was saved as v${saved.version}. Save the changes to that version — it is still a draft; submit it for review when you are happy with it.`
                      : 'The draft is complete. Saving it creates a draft version in the registry that only staff can open. Then submit it for review; an approver — not you — approves and publishes it, and only then do clinicians see it in their launcher.',
                  }
                : undefined
            }
          />
        </Box>

        {/* Right: the draft */}
        {/* `content: 'scroll-fill'` keeps the scroll content at viewport width (Mantine's default is a table that may grow), so the preview cannot overflow. */}
        <ScrollArea style={{ flex: 1, minWidth: 0 }} type="auto" scrollbars="y" classNames={{ content: 'scroll-fill' }}>
          <Stack gap="md" p="lg">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Title order={3} lineClamp={1}>
                  {view.title}
                </Title>
                <Text size="sm" c="dimmed">
                  {reading.archetype ? `${reading.archetype} · ` : ''}
                  {view.iterates ? `new version of ${view.iterates.app_id}${iteratesEntry ? ` (${iteratesEntry.manifest.metadata.name}, currently v${iteratesEntry.manifest.metadata.version})` : ''}` : 'new app'}
                </Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                {editable && (
                  <Tooltip label={unchangedNote} disabled={!unchanged || !unchangedNote}>
                    <Button
                      size="xs"
                      leftSection={<IconDeviceFloppy size={14} />}
                      onClick={() => void save()}
                      disabled={!ready || draft.busy || saving || unchanged}
                      loading={saving}
                      data-testid="save"
                      data-unchanged={unchanged ? 'true' : undefined}
                    >
                      {saveLabel}
                    </Button>
                  </Tooltip>
                )}
                {saved && savedState === 'draft' && (
                  <Tooltip label="Save your changes first: what is reviewed is what is saved." disabled={unchanged}>
                    <Button size="xs" leftSection={<IconSend size={14} />} onClick={() => void submitForReview()} loading={submitting} disabled={!unchanged} data-testid="submit-review">
                      Submit for review
                    </Button>
                  </Tooltip>
                )}
              </Group>
            </Group>

            {draft.error && (
              <Alert color="red" variant="light" py="xs" withCloseButton onClose={() => void draft.refresh()}>
                <Text size="sm">{draft.error}</Text>
              </Alert>
            )}
            {saveError && (
              <Alert color="red" variant="light" py="xs" withCloseButton onClose={() => setSaveError(null)} data-testid="save-error">
                <Text size="sm">{saveError}</Text>
              </Alert>
            )}
            {draft.rejected && (
              <Alert color="yellow" variant="light" title="That change was not accepted" py="xs" data-testid="rejected">
                <Stack gap={2}>
                  {draft.rejected.map((i, n) => (
                    <Text key={n} size="xs">
                      <Code>{i.path}</Code> — {i.message}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}
            {saved && (
              <Alert color={savedEntry && sentBack(savedEntry) ? 'yellow' : 'clinical'} variant="light" title={savedEntry && sentBack(savedEntry) ? `Saved as ${saved.app_id} v${saved.version} — sent back to you` : `Saved as ${saved.app_id} v${saved.version}`} data-testid="saved">
                {savedEntry && sentBack(savedEntry) && (
                  <div style={{ marginBottom: 8 }} data-testid="saved-sent-back">
                    <HistoryEvent item={sentBack(savedEntry)!} />
                  </div>
                )}
                <Text size="sm">
                  {savedState === 'in_review'
                    ? 'Submitted for review. An approver (not you) can now approve and publish it from the app page.'
                    : savedEntry && sentBack(savedEntry)
                      ? 'Change what the reviewer asked for here, save the changes to the same version, and submit it again.'
                      : 'It is a draft version in the registry: only staff can open it. You can keep changing it here and save the changes to the same version; submit it for review when you are happy with it, and an approver signs it off and publishes it.'}
                </Text>
                {/* The next steps as buttons, apart from the text — inline links at the end of a paragraph were overlooked. */}
                <Group gap="xs" mt="sm">
                  <Button component={Link} to={`/apps/${encodeURIComponent(saved.app_id)}/${encodeURIComponent(saved.version)}`} size="xs" variant="filled" leftSection={<IconExternalLink size={14} />} data-testid="saved-open-app">
                    Open the app
                  </Button>
                  <Button component={Link} to={savedState === 'in_review' ? '/?tab=review' : '/?tab=drafts'} size="xs" variant="default" leftSection={<IconArrowLeft size={14} />} data-testid="saved-back">
                    Back to the registry
                  </Button>
                </Group>
              </Alert>
            )}
            {view.refusals.length > 0 && (
              <Alert color="gray" variant="light" title="Outside what can be built" py="xs">
                <Stack gap={2}>
                  {view.refusals.map((r, n) => (
                    <Text key={n} size="xs">
                      <b>{r.refusal.replace(/_/g, ' ')}</b> — {r.detail}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)} keepMounted={false}>
              <SectionTabs standings={standings} ready={ready} />
              <Box pt="sm">
                <SectionStanding section={tab} standing={tab === 'preview' ? undefined : standings[tab]} ready={ready} openCount={openSections} busy={draft.busy} />
              </Box>
              <Box pt="md">
                {tab === 'overview' && <OverviewEditor reading={reading} readOnly={readOnly} iterating={Boolean(view.iterates)} onPatch={draft.patch} />}
                {tab === 'roles' && <RolesEditor reading={reading} groups={groups} readOnly={readOnly} onPatch={draft.patch} />}
                {tab === 'governance' && <GovernanceEditor reading={reading} readOnly={readOnly} onPatch={draft.patch} />}
                {tab === 'knobs' && <KnobsPanel reading={reading} readOnly={readOnly} staff={staff} onPatch={draft.patch} />}
                {tab === 'preview' && (
                  <PreviewPane client={client} spec={view.spec as PlainSpec} ready={ready} config={config} identity={{ sub: session.claims.sub, idToken: session.idToken, displayName: displayNameOf(session.claims) }} />
                )}
              </Box>
            </Tabs>
          </Stack>
        </ScrollArea>
      </Group>
    </>
  );
}

/**
 * `/drafts/new`: opens a draft and lands on it. `?message=` starts the conversation; `?from=<app_id>`
 * (optionally `&version=`) iterates on that app version: when the caller's own saved draft produced it, the new
 * draft continues that conversation (messages, spec, refusals — the author picks up where they left off); otherwise —
 * someone else's app, whose conversation is not theirs to read — it starts from the version's stored spec alone.
 */
/** The caller's saved draft that became this version, if any — only its author has it in their list — and the state it carries. */
async function sourceSessionFor(client: AuthoringClient, app_id: string, version: string): Promise<{ session_id: string; state?: LifecycleState } | undefined> {
  try {
    const found = (await client.listDrafts()).find((d) => d.saved_as?.app_id === app_id && d.saved_as?.version === version);
    return found ? { session_id: found.session_id, state: found.saved_as?.state } : undefined;
  } catch {
    return undefined; // the list is a convenience here; without it the draft still opens from the spec
  }
}

/**
 * Iterating on an app version: the caller's own conversation that produced it is reopened as it is while the version is
 * still a draft (it is revised in place — no second draft, no second version); once the version has been submitted, the
 * conversation continues in a new draft that becomes the next version; without a conversation of the caller's, the
 * version's stored spec seeds a fresh draft. The version's state comes from the conversation's own stamp (fresh, kept by
 * the registry writer at every transition — a recall just happened a moment ago) and from the registry list otherwise.
 */
async function continueOrSeed(client: AuthoringClient, input: { spec: PlainSpec; iterates: AppRef; message?: string }, state: LifecycleState | undefined): Promise<{ session_id: string }> {
  const source = await sourceSessionFor(client, input.iterates.app_id, input.iterates.version);
  const from_session = source?.session_id;
  if (from_session && (source?.state ?? state) === 'draft') return { session_id: from_session };
  if (from_session) {
    try {
      return await client.createDraft({ from_session, iterates: input.iterates, message: input.message });
    } catch (err) {
      // The conversation could not be continued (the agent still busy on it, or it is gone): the spec is still there.
      if (!(err instanceof AuthoringApiError && (err.status === 404 || err.status === 409))) throw err;
    }
  }
  return client.createDraft(input);
}

export function NewDraft({ client, registry, shapes }: { client: AuthoringClient; registry: RegistryEntry[]; shapes?: ShapesClient }) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const message = search.get('message') ?? undefined;
  const from = search.get('from') ?? undefined;
  const fromVersion = search.get('version') ?? undefined;
  // `?shape=<id>`: a draft seeded from a published record shape — the resource on record beside the shape's form.
  const fromShape = search.get('shape') ?? undefined;

  // Creating a draft is a side effect with a cost (a row in the drafts table), so it happens exactly
  // once per visit to this page — not once per effect run. React's StrictMode runs effects twice in
  // development and a registry reload would change the props; neither may open a second draft.
  const creation = useRef<Promise<{ session_id: string }> | null>(null);
  const mounted = useRef(false);
  const navigated = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!creation.current && fromShape) {
      creation.current = (shapes ? shapes.get(fromShape) : Promise.reject(new Error('The record-shape library is not available here.'))).then((shape) => {
        if (!shape.published) throw new Error(`${shape.name} has no published version yet: publish the shape, then open it as an app.`);
        return client.createDraft(draftSpecForShape(shape, message));
      });
    }
    if (!creation.current) {
      const entry = from ? findEntry(registry, from, fromVersion) : undefined;
      const input = entry?.meta?.spec
        ? { spec: entry.meta.spec, iterates: { app_id: entry.manifest.metadata.app_id, version: entry.manifest.metadata.version }, message }
        : from
          ? undefined
          : { message };
      if (!input) {
        setError(`${from} has no stored spec to iterate on (it was authored by hand).`);
        return;
      }
      creation.current = input.iterates ? continueOrSeed(client, input, entry?.manifest.lifecycle.state as LifecycleState | undefined) : client.createDraft(input);
    }
    creation.current
      .then((r) => {
        if (mounted.current && !navigated.current) {
          navigated.current = true;
          navigate(`/drafts/${encodeURIComponent(r.session_id)}`, { replace: true });
        }
      })
      .catch((err: unknown) => mounted.current && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      mounted.current = false;
    };
    // Intentionally once: the inputs are read when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <TopBar crumbs={[{ label: 'New draft' }]} />
      <Center mih="50vh">
        {error ? (
          <Alert color="red" title="Could not open a draft" variant="light" maw={520}>
            <Text size="sm">{error}</Text>
            <Anchor component={Link} to="/" size="sm">
              Back to the app registry
            </Anchor>
          </Alert>
        ) : (
          <Stack align="center" gap="xs">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Opening a draft…
            </Text>
          </Stack>
        )}
      </Center>
    </>
  );
}
