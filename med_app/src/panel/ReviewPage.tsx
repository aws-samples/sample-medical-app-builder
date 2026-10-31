import { useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Badge, Button, Code, Container, Group, Loader, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowRight, IconChevronDown, IconChevronRight, IconExternalLink } from '@tabler/icons-react';
import { useAuth } from '../auth/AuthContext';
import type { AuthoringClient } from '../authoring/types';
import type { RuntimeConfig } from '../config/env';
import { actorName, approvalOf } from '../manifest/history';
import { appPath, authorLabel, findEntry, type RegistryEntry } from '../manifest/registry';
import { isPlatformStaff } from '../manifest/roles';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';
import { baselineFor, countChanges, hunks, lineDiff, reviewDiff, type Change, type ReviewDiff, type ReviewSection, type SectionId, type Severity } from '../review';
import { AuthorLine } from './AuthorLine';
import { formatEventTime } from './VersionHistory';
import { lifecycleColor } from './AppLauncher';
import { LifecycleActions } from './drafting/LifecycleActions';
import { TopBar } from './TopBar';

const SEVERITY: Record<Severity, { label: string; color: string } | null> = {
  widening: { label: 'wider access', color: 'red' },
  narrowing: { label: 'narrower access', color: 'ink' },
  neutral: null,
};

const KIND: Record<Change['kind'], { label: string; color: string }> = {
  added: { label: 'added', color: 'clinical' },
  removed: { label: 'removed', color: 'gray' },
  changed: { label: 'changed', color: 'yellow' },
};

/**
 * The approver's review of one version: what changes against the version clinicians use today — access first, then
 * the data read and written, the actions, the forms, the purpose, the author's settings — and the sign-off itself,
 * on the same page. For a first version everything is new and the page says so. Staff only; the approve and publish
 * buttons keep their own rule (never the version's author).
 */
export function ReviewPage({
  registry,
  registryLoading = false,
  config,
  authoring,
  onRegistryChanged,
}: {
  registry: RegistryEntry[];
  registryLoading?: boolean;
  config: RuntimeConfig;
  authoring?: AuthoringClient;
  onRegistryChanged?: () => void | Promise<void>;
}) {
  const { appId = '', version = '' } = useParams();
  const { session, status } = useAuth();
  const isMock = config.auth.mode === 'mock';
  const entry = useMemo(() => findEntry(registry, appId, version), [registry, appId, version]);
  const baseline = useMemo(() => (entry ? baselineFor(registry, entry) : null), [registry, entry]);
  const diff = useMemo(() => (entry ? reviewDiff(entry, baseline) : null), [entry, baseline]);

  if (status === 'restoring') return null;
  if (!session) return null;
  if (!(isMock || isPlatformStaff(session.claims))) return <Navigate to="/" replace />;

  if (!entry || !diff) {
    return (
      <>
        <TopBar crumbs={[{ label: appId }, { label: 'Review' }]} />
        <Container py="lg">
          {registryLoading ? (
            <Group gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Loading the version…
              </Text>
            </Group>
          ) : (
            <Alert color="red" title="No such version">
              <Text size="sm">
                <Code>
                  {appId} v{version}
                </Code>{' '}
                is not in the registry.{' '}
                <Anchor component={Link} to="/?tab=review">
                  Back to the versions pending sign-off
                </Anchor>
                .
              </Text>
            </Alert>
          )}
        </Container>
      </>
    );
  }

  const m = entry.manifest;
  const changed = diff.sections.filter((s) => s.changes.length > 0);
  const unchanged = diff.sections.filter((s) => s.changes.length === 0);

  return (
    <>
      <TopBar crumbs={[{ label: m.metadata.name, to: appPath(entry) }, { label: `Review v${m.metadata.version}` }]} />
      <Container size="xl" py="lg">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div style={{ maxWidth: 820 }}>
              <Group gap="sm" align="baseline">
                <Title order={2}>
                  {m.metadata.name} <span style={{ fontWeight: 400 }}>v{m.metadata.version}</span>
                </Title>
                <Badge color={lifecycleColor(m.lifecycle.state)} tt="none" styles={KEEP_WHOLE} data-testid="review-state">
                  {m.lifecycle.state.replace('_', ' ')}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed" mt={4} data-testid="review-baseline">
                {diff.baseline
                  ? `Compared with v${diff.baseline.version}, the published version — what changes for the clinicians using it when this one is published.`
                  : 'A first version: nothing is published yet, so everything below is new.'}
              </Text>
              {baseline && approvalOf(baseline) && (
                <Text size="sm" c="dimmed" mt={2} data-testid="review-baseline-approval">
                  v{baseline.manifest.metadata.version} was approved by {actorName(approvalOf(baseline)!.event, session.claims.sub)} on {formatEventTime(approvalOf(baseline)!.event.ts)}
                  {approvalOf(baseline)!.notes ? <> — “{approvalOf(baseline)!.notes}”</> : '.'}
                </Text>
              )}
              <AuthorLine label={authorLabel(entry.meta)} />
            </div>
            <Group gap="xs">
              <Button component={Link} to={appPath(entry)} variant="default" size="xs" rightSection={<IconExternalLink size={14} />} data-testid="review-open">
                Open this version
              </Button>
              {baseline && (
                <Button component={Link} to={appPath(baseline)} variant="subtle" color="gray" size="xs" rightSection={<IconExternalLink size={14} />} data-testid="review-open-baseline">
                  Open v{baseline.manifest.metadata.version}
                </Button>
              )}
            </Group>
          </Group>

          <Verdict diff={diff} />

          {diff.archetype && (
            <Alert color="yellow" variant="light" title="Rebuilt on a different archetype" data-testid="review-archetype">
              <Text size="sm">
                v{diff.baseline?.version} was {diff.archetype.before}; this version is {diff.archetype.after}. The settings cannot be compared one by one — read the
                sections below as the whole of what the new version does.
              </Text>
            </Alert>
          )}

          {changed.map((section) => (
            <Section key={section.id} section={section} />
          ))}

          {diff.baseline && unchanged.length > 0 && (
            <Text size="sm" c="dimmed" data-testid="review-unchanged">
              Unchanged: {unchanged.map((s) => s.title.toLowerCase()).join(', ')}.
            </Text>
          )}

          <TextDiffPanel diff={diff} />

          {authoring && (
            <Paper withBorder p="md" data-testid="review-signoff">
              <Title order={4} mb={6}>
                Sign-off
              </Title>
              <LifecycleActions entry={entry} claims={session.claims} isMock={isMock} client={authoring} onChanged={() => onRegistryChanged?.()} reviewLink={false} />
            </Paper>
          )}
        </Stack>
      </Container>
    </>
  );
}

/* ── the verdict ──────────────────────────────────────────────────────────────────────────────── */

function Verdict({ diff }: { diff: ReviewDiff }) {
  const { access, widenings, narrowings, total } = diff.summary;
  const tone = access === 'widened' || access === 'mixed' ? 'red' : access === 'narrowed' ? 'ink' : access === 'new' ? 'yellow' : 'clinical';
  const headline =
    access === 'new'
      ? 'A first version — review the whole of it'
      : access === 'unchanged'
        ? total === 0
          ? 'Identical to the published version in what it does and may access'
          : 'Access unchanged'
        : access === 'widened'
          ? `Access widened — ${widenings.length} ${widenings.length === 1 ? 'way' : 'ways'}`
          : access === 'narrowed'
            ? `Access narrowed — ${narrowings.length} ${narrowings.length === 1 ? 'way' : 'ways'}`
            : `Access widened in ${widenings.length} ${widenings.length === 1 ? 'way' : 'ways'}, narrowed in ${narrowings.length}`;
  return (
    <Paper withBorder p="md" data-testid="review-verdict" style={{ borderLeft: `4px solid var(--mantine-color-${tone}-6)` }}>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Text fw={600}>{headline}</Text>
          <Text size="sm" c="dimmed" mt={2}>
            {access === 'new' && 'Roles, the data each may reach, what the app reads and writes, its forms and its purpose are all listed below as new.'}
            {access === 'unchanged' && total > 0 && `${total} change${total === 1 ? '' : 's'} to what the app shows or how it behaves; no role reaches more or less than before.`}
            {access === 'unchanged' && total === 0 && 'Only the version number differs. Nothing to review in the app itself.'}
            {(access === 'widened' || access === 'mixed') && 'Some role reaches data, patients or identity fields it did not before. Each such step is listed first in its section.'}
            {access === 'narrowed' && 'Some role reaches less than before; nothing is reached that was not reachable already.'}
          </Text>
        </div>
        {total > 0 && (
          <Text size="sm" c="dimmed" className="ds-tabular">
            {total} change{total === 1 ? '' : 's'}
          </Text>
        )}
      </Group>
      {widenings.length > 0 && (
        <Stack gap={4} mt="sm" data-testid="review-widenings">
          {widenings.map((c, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="baseline">
              <Badge size="xs" color="red" variant="filled" tt="none" styles={KEEP_WHOLE}>
                wider
              </Badge>
              <Text size="sm">
                <b>{c.subject}</b>
                {c.detail ? ` — ${c.detail}` : ''}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/* ── one section ──────────────────────────────────────────────────────────────────────────────── */

/** Sections whose before/after are identifiers and values, not prose. */
const MONO_SECTIONS: readonly SectionId[] = ['roles', 'primitives', 'settings', 'layout', 'context'];

function Section({ section }: { section: ReviewSection }) {
  // Widenings first, then narrowings, then the rest — the order a reviewer wants.
  const rank: Record<Severity, number> = { widening: 0, narrowing: 1, neutral: 2 };
  const rows = [...section.changes].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const mono = MONO_SECTIONS.includes(section.id) ? 'ds-mono' : undefined;
  return (
    <Paper withBorder p="md" data-testid={`review-section-${section.id}`}>
      <Group justify="space-between" align="baseline" mb="xs">
        <Title order={4}>{section.title}</Title>
        <Text size="xs" c="dimmed" className="ds-tabular">
          {rows.length} change{rows.length === 1 ? '' : 's'}
        </Text>
      </Group>
      <Table withRowBorders verticalSpacing="xs" style={{ tableLayout: 'fixed' }}>
        <Table.Tbody>
          {rows.map((c, i) => (
            <Table.Tr key={i} data-testid="review-change">
              <Table.Td style={{ width: 92, verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                <Badge size="xs" color={KIND[c.kind].color} variant="light" tt="none" styles={KEEP_WHOLE}>
                  {KIND[c.kind].label}
                </Badge>
              </Table.Td>
              <Table.Td style={{ verticalAlign: 'top' }}>
                <Group gap={6} align="baseline" wrap="wrap">
                  <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                    {c.subject}
                  </Text>
                  {SEVERITY[c.severity] && (
                    <Badge size="xs" color={SEVERITY[c.severity]!.color} variant="filled" tt="none" styles={KEEP_WHOLE}>
                      {SEVERITY[c.severity]!.label}
                    </Badge>
                  )}
                </Group>
                {c.detail && (
                  <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {c.detail}
                  </Text>
                )}
                {(c.before !== undefined || c.after !== undefined) && (
                  <Group gap={6} wrap="nowrap" align="baseline" mt={2}>
                    {c.before !== undefined && (
                      <Text size="xs" className={mono} c={c.kind === 'removed' ? 'red' : 'dimmed'} style={{ textDecoration: c.kind === 'changed' ? 'line-through' : undefined, overflowWrap: 'anywhere' }}>
                        {c.before}
                      </Text>
                    )}
                    {c.before !== undefined && c.after !== undefined && <IconArrowRight size={12} style={{ flex: 'none', color: 'var(--ds-muted)' }} aria-label="to" />}
                    {c.after !== undefined && (
                      <Text size="xs" className={mono} style={{ overflowWrap: 'anywhere' }}>
                        {c.after}
                      </Text>
                    )}
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

/* ── the raw text ─────────────────────────────────────────────────────────────────────────────── */

function TextDiffPanel({ diff }: { diff: ReviewDiff }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => lineDiff(diff.text.before, diff.text.after), [diff.text]);
  const counts = useMemo(() => countChanges(lines), [lines]);
  const folded = useMemo(() => hunks(lines, 3), [lines]);
  const label = diff.text.of === 'spec' ? 'the specs' : 'the manifests';
  return (
    <Paper withBorder p="md" data-testid="review-text">
      <Group justify="space-between" align="center">
        <Button variant="subtle" color="gray" size="xs" leftSection={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />} onClick={() => setOpen((o) => !o)} data-testid="review-text-toggle">
          {open ? 'Hide' : 'Show'} the full text of {label}
        </Button>
        <Text size="xs" c="dimmed" className="ds-tabular">
          {diff.baseline ? `+${counts.added} −${counts.removed} lines` : `${lines.length} lines`}
        </Text>
      </Group>
      {open && (
        <pre className="ds-mono" style={{ fontSize: 11.5, lineHeight: 1.45, margin: '8px 0 0', padding: 12, background: 'var(--mantine-color-gray-0)', borderRadius: 8, overflowX: 'auto' }} data-testid="review-text-body">
          {folded.map((hunk, h) => (
            <div key={h}>
              {hunk.skipped > 0 && <div style={{ color: 'var(--ds-muted)', padding: '2px 0' }}>… {hunk.skipped} unchanged lines</div>}
              {hunk.lines.map((l, i) => (
                <div key={i} style={{ background: l.type === 'add' ? 'rgba(46, 125, 50, 0.10)' : l.type === 'del' ? 'rgba(198, 40, 40, 0.10)' : undefined, color: l.type === 'del' ? 'var(--mantine-color-red-8)' : l.type === 'add' ? 'var(--mantine-color-clinical-8)' : undefined }}>
                  <span style={{ display: 'inline-block', width: 16, color: 'var(--ds-muted)' }}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                  {l.text}
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </Paper>
  );
}
