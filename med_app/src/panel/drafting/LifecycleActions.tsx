import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { IconArchive, IconArrowBackUp, IconGitBranch, IconGitCompare, IconPencil } from '@tabler/icons-react';
import type { IdentityClaims } from '../../auth/types';
import type { AuthoringClient, LifecycleState } from '../../authoring/types';
import { reviewPath, type RegistryEntry } from '../../manifest/registry';
import { canApprove, canIterate, isAdmin } from '../../manifest/roles';
import { PLATFORM_GROUPS } from '../../manifest/roles';
import { VersionHistory } from '../VersionHistory';

/**
 * The lifecycle of a registry version, from the app page: submit → approve → publish, send back,
 * deprecate, and the way back into the editor, which depends on where the version stands. A draft is
 * continued as it is (revised in place); a version under review or approved is *recalled* first — taken
 * off the reviewers' desk, its sign-off removed — and then continued, because changing an app while
 * someone reviews a stale copy of it helps nobody; a published or deprecated version is iterated on as
 * a new version, since what clinicians use must not move. Who may do what mirrors the API's rules
 * (identity_model): owners submit, recall and iterate, approvers approve and publish — never their
 * own version — admins may do either. The API enforces; this only hides what would be refused.
 */
export function LifecycleActions({
  entry,
  claims,
  isMock,
  client,
  onChanged,
  reviewLink = true,
}: {
  entry: Extract<RegistryEntry, { ok: true }>;
  claims: IdentityClaims;
  /** Mock mode has one person playing every part; separation of duties is shown, not enforced. */
  isMock: boolean;
  client: AuthoringClient;
  onChanged: () => void | Promise<void>;
  /** Offer "What changed" — the review page — for versions on their way to publication; off on that page itself. */
  reviewLink?: boolean;
}) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<LifecycleState | 'recall' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRecall, setConfirmRecall] = useState(false);
  const [confirmDeprecate, setConfirmDeprecate] = useState(false);

  const manifest = entry.manifest;
  const state = manifest.lifecycle.state;
  const { app_id, version } = manifest.metadata;
  const owner = entry.meta?.owner_sub;
  const author = entry.meta?.created_by_sub ?? owner;

  const owns = isMock || canIterate(claims, owner);
  const approves = isMock || canApprove(claims, author);
  const reviewer = isMock || claims.groups.includes(PLATFORM_GROUPS.approvers) || isAdmin(claims);
  const ownAuthor = Boolean(author && claims.sub === author);

  async function go(to: LifecycleState) {
    setBusy(to);
    setError(null);
    setDone(null);
    try {
      const r = await client.transition(app_id, version, to, notes.trim() || undefined);
      setDone(`${app_id} v${version} is now ${r.state.replace('_', ' ')}.`);
      setNotes('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // The step forward is the one filled button; everything else — the step back, the way into the editor, deprecating —
  // shares the quiet outlined style, so the row reads as one decision and its alternatives. Deprecate sits apart, at the
  // right end, and asks before it acts.
  const actions: { to: LifecycleState; label: string; allowed: boolean; variant?: string }[] = [];
  if (state === 'draft') actions.push({ to: 'in_review', label: 'Submit for review', allowed: owns });
  if (state === 'in_review') {
    actions.push({ to: 'approved', label: 'Approve', allowed: approves });
    actions.push({ to: 'draft', label: 'Send back to draft', allowed: reviewer || owns, variant: 'default' });
  }
  if (state === 'approved') {
    actions.push({ to: 'published', label: 'Publish', allowed: approves });
    actions.push({ to: 'draft', label: 'Send back to draft', allowed: reviewer || owns, variant: 'default' });
  }
  const canDeprecate = state !== 'deprecated' && (owns || reviewer);

  const canIterateHere = owns && Boolean(entry.meta?.spec);
  const editorPath = `/drafts/new?from=${encodeURIComponent(app_id)}&version=${encodeURIComponent(version)}`;
  // What "back to the editor" means here: continue the draft; recall then continue; or a new version.
  const editorMode: 'continue' | 'recall' | 'iterate' = state === 'draft' ? 'continue' : state === 'in_review' || state === 'approved' ? 'recall' : 'iterate';

  async function recallAndEdit() {
    setBusy('recall');
    setError(null);
    try {
      await client.transition(app_id, version, 'draft', 'recalled by the author to make changes');
      await onChanged();
      navigate(editorPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <Stack gap="sm" data-testid="lifecycle">
      <Text size="xs" c="dimmed">
        {state === 'draft' && 'A draft version: only staff can open it. Submitting it for review hands it to an approver.'}
        {state === 'in_review' && 'Under review. An approver signs the manifest off (never the author of the version) and can then publish it.'}
        {state === 'approved' && 'Approved and signed. Publishing creates the app’s groups and makes it available to clinicians in those groups.'}
        {state === 'published' && 'Published: clinicians in its groups can open it. A newer version replaces it when that one is published.'}
        {state === 'deprecated' && 'Deprecated: no longer offered to clinicians.'}
      </Text>
      <VersionHistory entry={entry} selfSub={claims.sub} compact />
      {(state === 'in_review' || state === 'approved') && approves && (
        <Textarea size="xs" label="Clinical notes for the sign-off" placeholder="What was checked, any conditions of use" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} autosize minRows={2} />
      )}
      <Group gap="xs" justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="xs">
          {actions
            .filter((a) => a.allowed)
            .map((a) => (
              <Button key={a.to} size="xs" variant={a.variant} loading={busy === a.to} disabled={busy !== null} onClick={() => void go(a.to)} data-testid={`transition-${a.to}`}>
                {a.label}
              </Button>
            ))}
          {canIterateHere && editorMode === 'continue' && (
            <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => navigate(editorPath)} disabled={busy !== null} data-testid="iterate">
              Continue editing
            </Button>
          )}
          {canIterateHere && editorMode === 'recall' && (
            <Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} onClick={() => setConfirmRecall(true)} disabled={busy !== null || confirmRecall} data-testid="iterate">
              Recall and edit
            </Button>
          )}
          {canIterateHere && editorMode === 'iterate' && (
            <Button size="xs" variant="default" leftSection={<IconGitBranch size={14} />} onClick={() => navigate(editorPath)} disabled={busy !== null} data-testid="iterate">
              Iterate on this app
            </Button>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {reviewLink && state !== 'published' && state !== 'deprecated' && (
            <Button component={Link} to={reviewPath(entry)} size="xs" variant="subtle" color="gray" leftSection={<IconGitCompare size={14} />} data-testid="what-changed">
              What changed
            </Button>
          )}
          {canDeprecate && (
            <Button size="xs" variant="default" leftSection={<IconArchive size={14} />} onClick={() => setConfirmDeprecate(true)} disabled={busy !== null || confirmDeprecate} data-testid="transition-deprecated" style={{ flexShrink: 0 }}>
              Deprecate
            </Button>
          )}
        </Group>
      </Group>
      {confirmDeprecate && (
        <Paper withBorder p="sm" radius="md" data-testid="deprecate-confirm">
          <Stack gap="xs">
            <Text size="sm">
              {state === 'published'
                ? `Deprecating withdraws v${version} from clinicians: it leaves their launcher and open sessions end at their next load. The version and its history stay in the registry.`
                : `Deprecating closes v${version} for good: it cannot be submitted, approved or published afterwards. The version and its history stay in the registry.`}
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                color="red"
                leftSection={<IconArchive size={14} />}
                loading={busy === 'deprecated'}
                onClick={() => {
                  setConfirmDeprecate(false);
                  void go('deprecated');
                }}
                data-testid="deprecate-confirm-yes"
              >
                Deprecate v{version}
              </Button>
              <Button size="xs" variant="default" disabled={busy === 'deprecated'} onClick={() => setConfirmDeprecate(false)} data-testid="deprecate-confirm-no">
                Keep it
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {confirmRecall && (
        <Paper withBorder p="sm" radius="md" data-testid="recall-confirm">
          <Stack gap="xs">
            <Text size="sm">
              Recalling takes v{version} {state === 'approved' ? 'out of the approved state and removes its sign-off' : 'out of review'}; reviewers see it leave their queue. You continue in
              the same conversation and submit it again when you are ready.
            </Text>
            <Group gap="xs">
              <Button size="xs" color="orange" leftSection={<IconArrowBackUp size={14} />} loading={busy === 'recall'} onClick={() => void recallAndEdit()} data-testid="recall-confirm-yes">
                Recall and edit
              </Button>
              <Button size="xs" variant="default" disabled={busy === 'recall'} onClick={() => setConfirmRecall(false)} data-testid="recall-confirm-no">
                Keep it {state === 'approved' ? 'approved' : 'in review'}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {(state === 'in_review' || state === 'approved') && !approves && !isMock && (
        <Text size="xs" c="dimmed">
          {ownAuthor ? 'You compiled this version, so you cannot approve or publish it (separation of duties).' : 'Approving and publishing is for approvers and admins.'}
        </Text>
      )}
      {isMock && (state === 'in_review' || state === 'approved') && (
        <Text size="xs" c="dimmed">
          Mock mode: one person plays every part here. A real deployment refuses the author of a version as its approver.
        </Text>
      )}
      {!entry.meta?.spec && owns && (
        <Text size="xs" c="dimmed">
          This version was authored by hand (no stored spec), so it cannot be iterated on from a draft.
        </Text>
      )}
      {error && (
        <Alert color="red" variant="light" py="xs">
          <Text size="xs">{error}</Text>
        </Alert>
      )}
      {done && (
        <Alert color="clinical" variant="light" py="xs">
          <Text size="xs">{done}</Text>
        </Alert>
      )}
    </Stack>
  );
}
