import { useMemo } from 'react';
import type { Observation } from '@medplum/fhirtypes';
import { formatDate } from '@medplum/core';
import { Group, Paper, Stack, Text, Title } from '@mantine/core';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { componentQuantity, conceptMatches, lateralityOf, observationDate, SIDE_WORD, type Side } from '../data/fhirHelpers';
import { tokens } from '../../theme';

export interface TimelineSeries {
  readonly label: string;
  /** Match Observation.code (single-value observations) … */
  readonly code?: string;
  /** … or a component code inside a panel (e.g. 8480-6 within a BP panel). */
  readonly component_code?: string;
  readonly color?: string;
}

export interface TimelineThreshold {
  readonly value: number;
  readonly label: string;
  readonly color?: string;
}

export interface ObservationTimelineProps {
  readonly observations?: Observation[];
  readonly series: readonly TimelineSeries[];
  readonly thresholds?: readonly TimelineThreshold[];
  readonly unit?: string;
  readonly title?: string;
  readonly height_px?: number;
  /** A line under the chart — where the reference lines come from (the guideline), as the template states it. */
  readonly caption?: string;
  /** Plot each series once per side of the body found in the data (bodySite laterality): "Knee flexion · left" against "· right". */
  readonly split_by_side?: boolean;
}

/** Left solid, right dashed, both dotted — the side told apart by the stroke, the measurement by the colour. */
const SIDE_DASH: Readonly<Record<Side, string | undefined>> = { left: undefined, right: '6 3', both: '2 3' };
const SIDE_ORDER: readonly Side[] = ['left', 'right', 'both'];

const PALETTE = [tokens.data, tokens.data2, tokens.accent, tokens.data3];

/**
 * Longitudinal chart typed to Observation. Extraction is deterministic and identical for
 * every app: a series either matches the observation's own code (valueQuantity) or a
 * component code (component[].valueQuantity). Nothing else is ever plotted.
 */
export function ObservationTimeline({ observations = [], series, thresholds = [], unit, title, height_px = 360, caption, split_by_side = false }: ObservationTimelineProps) {
  const { data, resolvedUnit, lines } = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    let resolvedUnit = unit;
    // The lines actually plotted: one per series, or — split by side — one per series and side present in the data, in
    // the series' order and then left, right, both; a side nobody recorded gets no empty legend entry.
    const seen = new Map<string, { label: string; color?: string; side?: Side; index: number }>();
    for (const obs of observations) {
      const date = observationDate(obs);
      if (!date) continue;
      const day = date.slice(0, 10);
      const row = byDate.get(day) ?? { day, ts: new Date(date).getTime() };
      const side = split_by_side ? lateralityOf(obs) : undefined;
      for (const [index, s] of series.entries()) {
        const q = s.component_code ? componentQuantity(obs, s.component_code) : conceptMatches(obs.code, [s.code ?? '']) ? obs.valueQuantity : undefined;
        if (q?.value !== undefined) {
          const key = side ? `${s.label} · ${SIDE_WORD[side]}` : s.label;
          row[key] = q.value;
          resolvedUnit ??= q.unit;
          if (!seen.has(key)) seen.set(key, { label: key, color: s.color, side, index });
        }
      }
      byDate.set(day, row);
    }
    const lines = [...seen.values()].sort((a, b) => a.index - b.index || SIDE_ORDER.indexOf(a.side ?? 'left') - SIDE_ORDER.indexOf(b.side ?? 'left'));
    const data = [...byDate.values()].filter((r) => lines.some((l) => r[l.label] !== undefined)).sort((a, b) => Number(a.ts) - Number(b.ts));
    return { data, resolvedUnit, lines };
  }, [observations, series, unit, split_by_side]);

  return (
    // The card is a column: when it shares a row with a taller card (a readings table), the plot grows to the row's
    // height instead of leaving blank space under a fixed-height chart; alone, it is exactly `height_px` tall.
    <Paper withBorder p="md" data-testid="observation-timeline" data-lines={lines.map((l) => l.label).join(' | ')} style={{ display: 'flex', flexDirection: 'column' }}>
      <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
        <Group justify="space-between" align="baseline">
          {title && <Title order={4}>{title}</Title>}
          <Text size="sm" c="dimmed">
            {data.length} data {data.length === 1 ? 'point' : 'points'}{resolvedUnit ? ` · ${resolvedUnit}` : ''}
          </Text>
        </Group>
        {data.length === 0 ? (
          <Text size="sm" c="dimmed">
            No values to plot for the selected window.
          </Text>
        ) : (
          <div style={{ width: '100%', flex: 1, minHeight: height_px }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                {/* Grid lighter than the table rules; no vertical lines; axes without their own strokes: the data is the darkest ink in the plot. */}
                <CartesianGrid stroke={tokens.grid} vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d: string) => formatDate(d)} tick={{ fontSize: 11, fill: tokens.muted }} tickLine={false} axisLine={{ stroke: tokens.line }} minTickGap={36} tickMargin={8} />
                <YAxis tick={{ fontSize: 11, fill: tokens.muted }} tickLine={false} axisLine={false} width={40} domain={['auto', 'auto']} />
                <Tooltip
                  labelFormatter={(d) => formatDate(String(d))}
                  formatter={(v) => [`${String(v)}${resolvedUnit ? ` ${resolvedUnit}` : ''}`]}
                  contentStyle={{ borderRadius: 8, border: `1px solid ${tokens.line}`, boxShadow: '0 8px 24px -16px rgba(21, 32, 43, 0.35)', fontSize: 12, padding: '6px 10px' }}
                  labelStyle={{ color: tokens.muted, marginBottom: 2 }}
                  cursor={{ stroke: tokens.line }}
                />
                <Legend iconType="plainline" iconSize={14} wrapperStyle={{ fontSize: 12, color: tokens.muted, paddingTop: 6 }} />
                {/* Reference lines are labelled at the left end, where no recent reading sits; the newest points are on the right. */}
                {thresholds.map((t) => (
                  <ReferenceLine key={t.label} y={t.value} stroke={t.color ?? tokens.alert} strokeOpacity={0.8} strokeDasharray="3 5" label={{ value: t.label, position: 'insideBottomLeft', fontSize: 11, fill: t.color ?? tokens.alert, dy: -2 }} />
                ))}
                {lines.map((l) => {
                  const color = l.color ?? PALETTE[l.index % PALETTE.length];
                  return <Line key={l.label} type="monotone" dataKey={l.label} stroke={color} strokeWidth={1.75} strokeDasharray={l.side ? SIDE_DASH[l.side] : undefined} dot={{ r: 2, strokeWidth: 1.5, fill: tokens.surface }} activeDot={{ r: 4, strokeWidth: 0 }} connectNulls isAnimationActive={false} />;
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {caption && (
          <Text size="xs" c="dimmed" data-testid="timeline-caption">
            {caption}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
