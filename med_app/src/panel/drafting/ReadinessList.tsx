import type { ReactNode } from 'react';
import { Badge, Group, Tabs, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCircle, IconCircleCheck, IconCircleDashed, IconLock, IconLockOpen } from '@tabler/icons-react';
import type { SpecIssue } from '../../authoring/types';
import { describeIssue, SECTION_LABELS, sectionOf, type SectionId } from './specView';

export const SECTION_ORDER: SectionId[] = ['overview', 'roles', 'governance', 'knobs'];

export type SectionStanding = { readonly state: 'open'; readonly items: readonly SpecIssue[] } | { readonly state: 'pending' } | { readonly state: 'complete' };

/**
 * The deterministic checklist behind "is this clear enough?" — what the schema still needs before the draft compiles,
 * by the tab where it is filled in. Empty everywhere means ready to save. The settings only become checkable once
 * there is an archetype to have settings for.
 */
export function sectionStandings(open: readonly SpecIssue[], archetypeChosen: boolean): Record<SectionId, SectionStanding> {
  const bySection = new Map<SectionId, SpecIssue[]>();
  for (const issue of open) {
    const s = sectionOf(issue.path);
    bySection.set(s, [...(bySection.get(s) ?? []), issue]);
  }
  const out = {} as Record<SectionId, SectionStanding>;
  for (const s of SECTION_ORDER) {
    const items = bySection.get(s) ?? [];
    out[s] = items.length ? { state: 'open', items } : s === 'knobs' && !archetypeChosen ? { state: 'pending' } : { state: 'complete' };
  }
  return out;
}

/** How many sections still need something — what the page's badge counts (the panel used to count fields, which read as a different number). */
export function openSectionCount(standings: Record<SectionId, SectionStanding>): number {
  return SECTION_ORDER.filter((s) => standings[s].state === 'open').length;
}

function StatusIcon({ standing, size = 14 }: { standing: SectionStanding; size?: number }) {
  if (standing.state === 'complete')
    return (
      <ThemeIcon size="xs" variant="transparent" color="clinical">
        <IconCircleCheck size={size} />
      </ThemeIcon>
    );
  if (standing.state === 'pending')
    return (
      <ThemeIcon size="xs" variant="transparent" color="gray">
        <IconCircle size={size} />
      </ThemeIcon>
    );
  return (
    <ThemeIcon size="xs" variant="transparent" color="orange">
      <IconCircleDashed size={size} />
    </ThemeIcon>
  );
}

/**
 * The section tabs with their standing on them: a check when complete, a dashed circle and the number of fields still
 * needed when not, a plain circle while the settings wait for an archetype. The Preview tab says what unlocks it.
 */
export function SectionTabs({ standings, ready }: { standings: Record<SectionId, SectionStanding>; ready: boolean }) {
  const openSections = SECTION_ORDER.filter((s) => standings[s].state === 'open');
  const previewHint = ready ? 'The compiled app on synthetic data, as each role sees it' : `Opens once every section has its required information — missing in: ${openSections.map((s) => `${SECTION_LABELS[s]} (${(standings[s] as { items: readonly SpecIssue[] }).items.length})`).join(', ')}`;
  return (
    <Tabs.List>
      {SECTION_ORDER.map((s) => {
        const standing = standings[s];
        return (
          <Tabs.Tab
            key={s}
            value={s}
            leftSection={<StatusIcon standing={standing} />}
            rightSection={
              standing.state === 'open' ? (
                <Badge size="xs" color="orange" variant="light" circle data-testid={`tab-open-${s}`}>
                  {standing.items.length}
                </Badge>
              ) : undefined
            }
            data-standing={standing.state}
          >
            {SECTION_LABELS[s]}
          </Tabs.Tab>
        );
      })}
      <Tooltip label={previewHint} multiline w={320} withArrow position="bottom">
        <Tabs.Tab value="preview" disabled={!ready} leftSection={ready ? <IconLockOpen size={14} /> : <IconLock size={14} />} data-testid="tab-preview" data-locked={ready ? undefined : 'true'} style={{ pointerEvents: 'auto' }}>
          Preview
        </Tabs.Tab>
      </Tooltip>
    </Tabs.List>
  );
}

/**
 * One line under the tabs about the section on screen: the required information it still lacks, or that it is complete —
 * the checklist next to the fields it is about rather than in a panel of its own above them. While the assistant is
 * answering, the fields are locked and the line says so.
 */
export function SectionStanding({ section, standing, ready, openCount, busy }: { section: string; standing: SectionStanding | undefined; ready: boolean; openCount: number; busy?: boolean }) {
  let text: ReactNode;
  let tone: string | undefined = 'dimmed';
  const others = (n: number) => `${n} other ${n === 1 ? 'section is' : 'sections are'} missing required information — marked above.`;
  if (section === 'preview') {
    text = ready ? 'Everything is in place — this is the app as it would run.' : null;
  } else if (!standing) {
    text = null;
  } else if (standing.state === 'open') {
    tone = undefined;
    text = (
      <>
        <Text span fw={500}>
          Still needed here:
        </Text>{' '}
        {standing.items.map(describeIssue).join(' · ')}
        {openCount > 1 ? ` — and ${others(openCount - 1)}` : ready ? '' : ' — the last section missing anything.'}
      </>
    );
  } else if (standing.state === 'pending') {
    text = 'The settings become available once the kind of app is chosen on the App tab.';
  } else {
    text = ready ? 'Complete. Every section is — the draft compiles and can be saved.' : `Complete. ${others(openCount)}`;
  }
  if (!text && !busy) return null;
  return (
    <Group justify="space-between" align="baseline" wrap="nowrap" gap="md" data-testid="readiness" data-section={section}>
      <Text size="sm" c={tone} style={{ minWidth: 0 }}>
        {text}
      </Text>
      {busy && section !== 'preview' && (
        <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
          Fields unlock when the assistant has answered.
        </Text>
      )}
    </Group>
  );
}
