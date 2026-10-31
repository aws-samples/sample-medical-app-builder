import { useMemo } from 'react';
import type { Observation } from '@medplum/fhirtypes';
import { formatDate } from '@medplum/core';
import { Paper, Stack, Table, Text, Title } from '@mantine/core';
import { componentQuantity, conceptMatches, lateralityOf, observationDate, SIDE_WORD, type Side } from '../data/fhirHelpers';
import type { TimelineSeries } from './ObservationTimeline';

export interface ObservationComparisonProps {
  readonly observations?: Observation[];
  /** The same series the chart plots: a code, or a component code inside a panel. */
  readonly series: readonly TimelineSeries[];
  /** One row per series and side of the body (bodySite laterality), as the chart splits its lines. */
  readonly split_by_side?: boolean;
  readonly unit?: string;
  readonly title?: string;
}

interface Row {
  readonly label: string;
  readonly first?: { date: string; value: number };
  readonly latest?: { date: string; value: number };
  readonly count: number;
  readonly unit?: string;
}

/**
 * The first and the latest value of each series, side by side, with their dates and the difference between them —
 * "progress check: first finding against today". The two numbers and their arithmetic difference are shown as recorded;
 * nothing is coloured, graded or judged, and a series with a single value shows no difference.
 */
export function ObservationComparison({ observations = [], series, split_by_side = false, unit, title = 'First against latest' }: ObservationComparisonProps) {
  const rows = useMemo<Row[]>(() => {
    const points = new Map<string, { date: string; value: number; unit?: string; index: number; side?: Side }[]>();
    for (const obs of observations) {
      const date = observationDate(obs);
      if (!date) continue;
      const side = split_by_side ? lateralityOf(obs) : undefined;
      for (const [index, s] of series.entries()) {
        const q = s.component_code ? componentQuantity(obs, s.component_code) : conceptMatches(obs.code, [s.code ?? '']) ? obs.valueQuantity : undefined;
        if (q?.value === undefined) continue;
        const key = side ? `${s.label} · ${SIDE_WORD[side]}` : s.label;
        const list = points.get(key) ?? [];
        list.push({ date, value: q.value, unit: q.unit, index, side });
        points.set(key, list);
      }
    }
    const order: Side[] = ['left', 'right', 'both'];
    return [...points.entries()]
      .map(([label, list]) => {
        const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
        const first = sorted[0]!;
        const latest = sorted[sorted.length - 1]!;
        return { label, first: { date: first.date, value: first.value }, latest: { date: latest.date, value: latest.value }, count: sorted.length, unit: unit ?? first.unit, index: first.index, side: first.side };
      })
      .sort((a, b) => a.index - b.index || order.indexOf(a.side ?? 'left') - order.indexOf(b.side ?? 'left'))
      .map(({ index: _i, side: _s, ...row }) => row);
  }, [observations, series, split_by_side, unit]);

  const num = (v: number, u?: string) => `${Number.isInteger(v) ? v : Math.round(v * 100) / 100}${u ? ` ${u}` : ''}`;
  const delta = (row: Row) => {
    if (!row.first || !row.latest || row.count < 2) return '—';
    const d = Math.round((row.latest.value - row.first.value) * 100) / 100;
    return `${d > 0 ? '+' : ''}${num(d, row.unit)}`;
  };

  return (
    <Paper withBorder p="md" data-testid="observation-comparison">
      <Stack gap="xs">
        <Title order={4}>{title}</Title>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            No values to compare for the selected window.
          </Text>
        ) : (
          <Table withRowBorders verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Series</Table.Th>
                <Table.Th>First</Table.Th>
                <Table.Th>Latest</Table.Th>
                <Table.Th>Difference</Table.Th>
                <Table.Th>Values</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.label} data-testid="comparison-row">
                  <Table.Td>{row.label}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <span className="ds-tabular">{row.first ? num(row.first.value, row.unit) : '—'}</span>
                    {row.first && (
                      <Text component="span" size="xs" c="dimmed" ml={6}>
                        {formatDate(row.first.date)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <span className="ds-tabular">{row.latest ? num(row.latest.value, row.unit) : '—'}</span>
                    {row.latest && (
                      <Text component="span" size="xs" c="dimmed" ml={6}>
                        {formatDate(row.latest.date)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td className="ds-tabular" style={{ whiteSpace: 'nowrap' }} data-testid="comparison-delta">
                    {delta(row)}
                  </Table.Td>
                  <Table.Td className="ds-tabular">{row.count}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Text size="xs" c="dimmed">
          The first and the latest recorded value of each series and the arithmetic difference between them, as recorded; nothing is graded.
        </Text>
      </Stack>
    </Paper>
  );
}
