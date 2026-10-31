import { useEffect, useMemo, useRef } from 'react';
import { Group, Paper, RangeSlider, Stack, Text, Title } from '@mantine/core';
import type { CohortObservationRow } from '../data/mock/mockExecutor';
import { useRenderContext } from '../../renderer/RenderContext';
import { tokens } from '../../theme';
import { formatRange, isValueRange, rowsInRange, spanOf, type ValueRange } from './cohortRange';

export interface RangeFilterProps {
  /** Writes `{min, max}` to `$ui.<selection_key>`; the cohort table and the range card read it. */
  readonly selection_key?: string;
  readonly label?: string;
  readonly unit?: string;
  /** Bounds of the slider; absent → the span of the rows' compared values, rounded outwards to the step. */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** The range selected when the app opens; absent → the whole span. */
  readonly initial?: readonly [number, number] | ValueRange;
  /** The cohort rows (`$bindings.<latest>.rows`), for the derived bounds and the "N of M" line. */
  readonly rows?: CohortObservationRow[];
  readonly hint?: string;
}

function asRange(value: RangeFilterProps['initial']): ValueRange | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return typeof value[0] === 'number' && typeof value[1] === 'number' ? { min: value[0], max: value[1] } : undefined;
  return isValueRange(value) ? value : undefined;
}

/**
 * A two-handle slider over the cohort's compared values. Moving it filters the member table and the range card live:
 * nothing is fetched again — the cohort and every member's latest value are already here, as the role's scope allows —
 * so the view answers at once and the audit trail records one cohort read, not one per slider stop.
 */
export function RangeFilter({ selection_key = 'cohort_range', label = 'Value range', unit, min, max, step = 1, initial, rows = [], hint }: RangeFilterProps) {
  const { ui, setUiState } = useRenderContext();
  const span = useMemo(() => spanOf(rows, step), [rows, step]);
  const bounds: ValueRange | undefined = typeof min === 'number' && typeof max === 'number' ? { min, max } : span;
  const current = isValueRange(ui[selection_key]) ? (ui[selection_key] as ValueRange) : undefined;

  // Once the bounds are known, the app opens on the requested range (or the whole span), so the table and the card
  // have a range to go by from the first paint; after that the handles are the only thing that changes it.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || !bounds) return;
    const wanted = asRange(initial);
    const start: ValueRange = wanted ? { min: Math.max(bounds.min, wanted.min), max: Math.min(bounds.max, wanted.max) } : bounds;
    initialised.current = true;
    if (!current || current.min !== start.min || current.max !== start.max) setUiState(selection_key, start);
  }, [bounds, current, initial, selection_key, setUiState]);

  const shown = current ? rowsInRange(rows, current).length : rows.length;

  return (
    <Paper withBorder p="md" data-testid="range-filter">
      <Stack gap="xs">
        <Group justify="space-between" align="baseline" wrap="nowrap">
          <Title order={5}>{label}</Title>
          <Text size="sm" className="ds-tabular" style={{ color: tokens.ink }} data-testid="range-filter-value">
            {current && bounds ? formatRange(current, unit) : bounds ? formatRange(bounds, unit) : '—'}
          </Text>
        </Group>
        {bounds ? (
          <RangeSlider
            min={bounds.min}
            max={bounds.max}
            step={step}
            minRange={0}
            value={current ? [current.min, current.max] : [bounds.min, bounds.max]}
            onChange={([lo, hi]) => setUiState(selection_key, { min: lo, max: hi })}
            label={(v) => `${v}${unit ? ` ${unit}` : ''}`}
            marks={[
              { value: bounds.min, label: `${bounds.min}` },
              { value: bounds.max, label: `${bounds.max}` },
            ]}
            color="clinical"
            size="sm"
            thumbSize={16}
            mb={18} // room for the bound marks under the track
            aria-label={label}
            data-testid="range-slider"
          />
        ) : (
          <Text size="sm" c="dimmed">
            No values to range over yet.
          </Text>
        )}
        <Text size="xs" c="dimmed" mt={4} data-testid="range-filter-count">
          {rows.length ? `${shown} of ${rows.length} patients in range` : ''}
          {hint ? `${rows.length ? ' · ' : ''}${hint}` : ''}
        </Text>
      </Stack>
    </Paper>
  );
}

export interface CohortRangeCardProps {
  readonly label?: string;
  readonly rows?: CohortObservationRow[];
  /** `$ui.<selection_key>` of the RangeFilter; without it the card counts every member with a value. */
  readonly range?: unknown;
  readonly unit?: string;
  readonly hint?: string;
}

/** Headline count of the members whose compared value lies in the selected range — follows the slider live. */
export function CohortRangeCard({ label = 'In range', rows = [], range, unit, hint }: CohortRangeCardProps) {
  const selected = isValueRange(range) ? range : undefined;
  const count = selected ? rowsInRange(rows, selected).length : rows.filter((r) => typeof r.compared === 'number').length;
  return (
    <Paper withBorder p="md" data-testid="cohort-range-card">
      <Stack gap={4}>
        <Text size="sm" c="dimmed" fw={500}>
          {label}
        </Text>
        <Text fw={600} style={{ fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: tokens.data }}>
          {count}
        </Text>
        <Text size="xs" c="dimmed">
          {selected ? `${formatRange(selected, unit)} · of ${rows.length}` : hint ?? `of ${rows.length} members`}
        </Text>
      </Stack>
    </Paper>
  );
}
