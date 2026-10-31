import type { ReactNode } from 'react';
import { ActionIcon, Badge, Button, Chip, Group, Paper, ScrollArea, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconPin, IconPinFilled } from '@tabler/icons-react';
import type { Collection } from '../collections';
import { FACET_LABELS, facetCounts, matchesSearch, matchesSelection, type AppFacets, type FacetKey, type FacetSelection } from '../manifest/facets';
import { authorLabel, type RegistryEntry } from '../manifest/registry';
import type { AppManifest } from '../manifest/schema';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';
import { AuthorLine } from './AuthorLine';

/**
 * Browsing the catalog: the chips that narrow it by what the apps are about, the cards an app is shown as, the
 * person's own apps (pinned, recently opened) and the hospital's collections. The launcher composes these; nothing
 * here knows about tabs or lifecycle.
 */

export interface BrowseRow {
  readonly entry: Extract<RegistryEntry, { ok: true }>;
  readonly manifest: AppManifest;
  readonly facets: AppFacets;
  readonly canOpen: boolean;
}

const FACET_ORDER: readonly FacetKey[] = ['kind', 'scope', 'shows', 'records', 'intended'];

/**
 * The chips that narrow the list: one row per facet — the label at the left, the values as chips in a single row that
 * scrolls sideways when there are more than fit — each chip with the count of what choosing it would leave. No box
 * around it: it sits in the page like the search it belongs to. A facet whose chips would not narrow anything is not offered.
 */
export function FacetBar({ all, selection, search, onChange }: { all: readonly AppFacets[]; selection: FacetSelection; search: string; onChange: (next: FacetSelection) => void }) {
  const groups = FACET_ORDER.map((key) => {
    const counts = facetCounts(all, key, selection, search);
    const pool = all.filter((f) => matchesSelection(f, { ...selection, [key]: [] }) && matchesSearch(f, search)).length;
    const narrows = counts.some((c) => c.count > 0 && c.count < pool);
    return { key, counts, offered: narrows || (selection[key]?.length ?? 0) > 0 };
  }).filter((g) => g.offered);
  if (groups.length === 0) return null;
  const chosenCount = Object.values(selection).reduce((n, v) => n + (v?.length ?? 0), 0);
  return (
    <Stack gap={4} data-testid="facet-bar">
      {groups.map(({ key, counts }) => {
        const chosen = selection[key] ?? [];
        return (
          <Group key={key} gap="sm" align="center" wrap="nowrap" data-testid={`facet-${key}`}>
            <Text size="xs" c={chosen.length ? 'clinical' : 'dimmed'} fw={chosen.length ? 600 : 400} w={92} style={{ flex: 'none' }}>
              {FACET_LABELS[key]}
              {chosen.length > 0 && (
                <Text span size="xs" c="dimmed" fw={400}>
                  {' '}· {chosen.length}
                </Text>
              )}
            </Text>
            <ScrollArea type="hover" scrollbars="x" scrollbarSize={6} offsetScrollbars style={{ flex: 1, minWidth: 0 }}>
              <Chip.Group multiple value={[...chosen]} onChange={(values) => onChange({ ...selection, [key]: values })}>
                <Group gap={6} wrap="nowrap" style={{ width: 'max-content', paddingBottom: 2 }}>
                  {counts.map((c) => (
                    <Chip key={c.value} value={c.value} size="xs" variant="outline" color="clinical" radius="sm" disabled={c.count === 0 && !chosen.includes(c.value)} data-testid={`chip-${key}-${c.value}`}>
                      {c.value}
                      <Text span size="xs" c="dimmed" ml={5} className="ds-tabular">
                        {c.count}
                      </Text>
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
            </ScrollArea>
          </Group>
        );
      })}
      {chosenCount > 0 && (
        <Button size="compact-xs" variant="subtle" color="gray" w="fit-content" ml={92 + 12} onClick={() => onChange({})} data-testid="facets-clear">
          Clear {chosenCount === 1 ? 'the chip' : `all ${chosenCount}`}
        </Button>
      )}
    </Stack>
  );
}

/** One app as a card: name, what it is for, the kind and who it is about, what it records; pin and open. */
export function AppCard({
  row,
  pinned,
  onTogglePin,
  open,
  compact = false,
}: {
  row: BrowseRow;
  pinned: boolean;
  onTogglePin?: (appId: string) => void;
  /** The Open control, made by the launcher (it knows the patient in context and the reasons an app cannot open). */
  open: ReactNode;
  compact?: boolean;
}) {
  const m = row.manifest;
  const f = row.facets;
  return (
    <Paper withBorder p={compact ? 'sm' : 'md'} radius="md" style={{ opacity: row.canOpen ? 1 : 0.6, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={`app-card-${m.metadata.app_id}`}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Text fw={600} size={compact ? 'sm' : 'md'} style={{ overflowWrap: 'anywhere' }}>
            {m.metadata.name}
          </Text>
          {!compact && m.metadata.description && (
            <Text size="sm" c="dimmed" lineClamp={2} mt={2}>
              {m.metadata.description}
            </Text>
          )}
        </div>
        {onTogglePin && (
          <Tooltip label={pinned ? 'Unpin from your apps' : 'Pin to your apps'} withArrow>
            <ActionIcon variant={pinned ? 'light' : 'subtle'} color={pinned ? 'clinical' : 'gray'} size="sm" onClick={() => onTogglePin(m.metadata.app_id)} aria-label={pinned ? `Unpin ${m.metadata.name}` : `Pin ${m.metadata.name}`} aria-pressed={pinned} data-testid={`pin-${m.metadata.app_id}`}>
              {pinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Group gap={4} wrap="wrap">
        <Badge size="xs" variant="light" color="ink" tt="none" styles={KEEP_WHOLE}>
          {f.kind}
        </Badge>
        <Badge size="xs" variant="light" color="gray" tt="none" styles={KEEP_WHOLE}>
          {f.scope}
        </Badge>
        {f.records.length > 0 && (
          <Tooltip label={`Records ${f.records.join(', ').toLocaleLowerCase()}`} disabled={f.records.length === 1} withArrow>
            <Badge size="xs" variant="light" color="yellow" tt="none" styles={KEEP_WHOLE}>
              Records {f.records[0]!.toLocaleLowerCase()}
              {f.records.length > 1 ? ` +${f.records.length - 1}` : ''}
            </Badge>
          </Tooltip>
        )}
        {f.imaging.length > 0 && (
          <Badge size="xs" variant="light" color="gray" tt="none" styles={KEEP_WHOLE}>
            {f.imaging.join(' · ')}
          </Badge>
        )}
      </Group>
      {!compact && f.shows.length > 0 && (
        <Text size="xs" c="dimmed">
          Shows {f.shows.join(', ').toLocaleLowerCase()}
          {f.intended.length ? ` · for ${f.intended.map((i) => i.toLocaleLowerCase()).join(', ')}` : ''}
        </Text>
      )}
      <Group justify="space-between" align="center" mt="auto" wrap="nowrap">
        <AuthorLine label={authorLabel(row.entry.meta)} />
        {open}
      </Group>
    </Paper>
  );
}

export function CardGrid({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: compact ? 4 : 3 }} spacing="md">
      {children}
    </SimpleGrid>
  );
}

/** The person's own corner: pinned apps first, then the ones opened lately. Nothing to show says how it fills. */
export function YourApps({ rows, pins, recent, renderCard }: { rows: readonly BrowseRow[]; pins: readonly string[]; recent: readonly string[]; renderCard: (row: BrowseRow) => ReactNode }) {
  const byId = new Map(rows.map((r) => [r.manifest.metadata.app_id, r]));
  const ids = [...pins, ...recent.filter((r) => !pins.includes(r))].filter((id) => byId.has(id));
  return (
    <Paper withBorder p="md" data-testid="your-apps">
      <Group justify="space-between" align="baseline" mb="xs">
        <Title order={4}>Your apps</Title>
        <Text size="xs" c="dimmed">
          {ids.length ? `${pins.filter((p) => byId.has(p)).length} pinned · ${ids.length - pins.filter((p) => byId.has(p)).length} recent` : ''}
        </Text>
      </Group>
      {ids.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="your-apps-empty">
          Pin an app, or open one — it appears here, so what you use is one click away.
        </Text>
      ) : (
        <CardGrid compact>{ids.map((id) => renderCard(byId.get(id)!))}</CardGrid>
      )}
    </Paper>
  );
}

/** The hospital's collections, each with the apps of it this person may see; a collection with none of them is not shown. */
export function CollectionsSection({ collections, rows, renderCard, actions }: { collections: readonly Collection[]; rows: readonly BrowseRow[]; renderCard: (row: BrowseRow) => ReactNode; actions?: ReactNode }) {
  const byId = new Map(rows.map((r) => [r.manifest.metadata.app_id, r]));
  const shown = collections.map((c) => ({ c, apps: c.app_ids.map((id) => byId.get(id)).filter((r): r is BrowseRow => Boolean(r)) })).filter((x) => x.apps.length > 0);
  if (shown.length === 0 && !actions) return null;
  return (
    <Stack gap="md" data-testid="collections">
      <Group justify="space-between" align="baseline">
        <Title order={4}>Collections</Title>
        {actions}
      </Group>
      {shown.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="collections-empty">
          No collections yet. A collection groups published apps for a clinic, a ward or a team; approvers and admins make them.
        </Text>
      )}
      {shown.map(({ c, apps }) => (
        <Paper key={c.collection_id} withBorder p="md" data-testid={`collection-${c.collection_id}`}>
          <Group justify="space-between" align="baseline" mb={c.description ? 2 : 'xs'}>
            <Title order={5}>{c.name}</Title>
            <Text size="xs" c="dimmed" className="ds-tabular">
              {apps.length} {apps.length === 1 ? 'app' : 'apps'}
            </Text>
          </Group>
          {c.description && (
            <Text size="sm" c="dimmed" mb="xs">
              {c.description}
            </Text>
          )}
          <CardGrid compact>{apps.map((r) => renderCard(r))}</CardGrid>
        </Paper>
      ))}
    </Stack>
  );
}
