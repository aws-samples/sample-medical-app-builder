import type { CohortObservationRow } from '../data/mock/mockExecutor';

/**
 * A range over the cohort's compared values — what a `RangeFilter` writes to `$ui.<key>` and what the cohort table and
 * the range card read. The range is a view decision: the cohort and every member's latest value were fetched once, as
 * the role's scope allows; moving the handles filters what is shown, never what is requested.
 */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export function isValueRange(value: unknown): value is ValueRange {
  return typeof value === 'object' && value !== null && typeof (value as ValueRange).min === 'number' && typeof (value as ValueRange).max === 'number';
}

/** Rows whose compared value lies within the range (inclusive); rows without a value are kept out of a filtered view. */
export function rowsInRange(rows: readonly CohortObservationRow[], range: unknown): CohortObservationRow[] {
  if (!isValueRange(range)) return [...rows];
  return rows.filter((r) => typeof r.compared === 'number' && r.compared >= range.min && r.compared <= range.max);
}

/** The span of the cohort's compared values, rounded outwards to the step — the slider's bounds when the app sets none. */
export function spanOf(rows: readonly CohortObservationRow[], step = 1): ValueRange | undefined {
  const values = rows.map((r) => r.compared).filter((v): v is number => typeof v === 'number');
  if (!values.length) return undefined;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step };
}

export function formatRange(range: ValueRange, unit?: string): string {
  const u = unit ? ` ${unit}` : '';
  return `${range.min}–${range.max}${u}`;
}
