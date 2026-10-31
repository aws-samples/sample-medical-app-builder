import { Badge } from '@mantine/core';
import type { ShapeState } from '../../shapes';

const COLOR: Record<ShapeState, string> = { draft: 'yellow', published: 'clinical', deprecated: 'gray' };
const WORD: Record<ShapeState, string> = { draft: 'draft', published: 'published', deprecated: 'deprecated' };

export function ShapeStateBadge({ state, version }: { state: ShapeState; version?: string }) {
  return (
    <Badge size="sm" variant="light" color={COLOR[state]} tt="none" data-testid={`shape-state-${state}`}>
      {version ? `${version} · ` : ''}
      {WORD[state]}
    </Badge>
  );
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "12 Oct 2026, 10:14 · Sabine Weber" — the moment and the person, whichever parts are known. */
export function whenBy(iso: string | null | undefined, who: { readonly name?: string; readonly email?: string } | null | undefined): string {
  const when = formatWhen(iso);
  const by = who?.name || who?.email || '';
  return [when, by].filter(Boolean).join(' · ');
}
