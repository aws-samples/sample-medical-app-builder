import { useState } from 'react';
import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { actorName, historyOf, type DescribedEvent, type EventTone } from '../manifest/history';
import type { RegistryEntry } from '../manifest/registry';
import { KEEP_WHOLE } from '../primitives/ui/badgeStyles';

type OkEntry = Extract<RegistryEntry, { ok: true }>;

const TONE: Record<EventTone, { border: string; color?: string }> = {
  neutral: { border: 'var(--ds-hairline)' },
  attention: { border: 'var(--mantine-color-yellow-6)', color: 'yellow' },
  approval: { border: 'var(--mantine-color-clinical-6)', color: 'clinical' },
};

export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One line: what happened · who · when; the notes underneath as a quote, where there are any. */
export function HistoryEvent({ item, selfSub, compact = false }: { item: DescribedEvent; selfSub?: string; compact?: boolean }) {
  const tone = TONE[item.tone];
  return (
    <div style={{ borderLeft: `3px solid ${tone.border}`, paddingLeft: 10 }} data-testid="history-event" data-tone={item.tone}>
      <Group gap={6} align="baseline" wrap="wrap">
        <Text size={compact ? 'xs' : 'sm'} fw={500} c={tone.color}>
          {item.label}
        </Text>
        {item.event.signed && item.event.to_state === 'approved' && (
          <Badge size="xs" variant="light" color="clinical" tt="none" styles={KEEP_WHOLE}>
            signed
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {actorName(item.event, selfSub)} · {formatEventTime(item.event.ts)}
          {item.inferred ? ' · from the sign-off' : ''}
        </Text>
      </Group>
      {item.notes && (
        <Text size={compact ? 'xs' : 'sm'} mt={2} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-testid="history-notes">
          “{item.notes}”
        </Text>
      )}
    </div>
  );
}

/**
 * The version's lifecycle so far, newest first: submitted, sent back and why, recalled, approved and with what notes,
 * published, superseded. The last few by default; the rest on request. Nothing when there is nothing to tell.
 */
export function VersionHistory({ entry, selfSub, limit = 4, compact = false }: { entry: OkEntry; selfSub?: string; limit?: number; compact?: boolean }) {
  const [all, setAll] = useState(false);
  const items = historyOf(entry);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, limit);
  return (
    <Stack gap={8} data-testid="version-history">
      {shown.map((item, i) => (
        <HistoryEvent key={`${item.event.ts}-${i}`} item={item} selfSub={selfSub} compact={compact} />
      ))}
      {items.length > limit && (
        <Button variant="subtle" color="gray" size="compact-xs" w="fit-content" leftSection={all ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />} onClick={() => setAll((a) => !a)} data-testid="history-toggle">
          {all ? 'Fewer' : `All ${items.length} steps`}
        </Button>
      )}
    </Stack>
  );
}
