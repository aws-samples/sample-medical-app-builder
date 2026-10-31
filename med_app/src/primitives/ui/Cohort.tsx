import { formatDate, getIdentifier } from '@medplum/core';
import { HumanNameDisplay } from '@medplum/react';
import { Anchor, Badge, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { Link, useInRouterContext } from 'react-router-dom';
import type { CohortImagingRow, CohortObservationRow } from '../data/mock/mockExecutor';
import { MRN_SYSTEM } from '../data/mock/seed';
import { tokens } from '../../theme';
import { formatRange, isValueRange, rowsInRange } from './cohortRange';

export interface StatCardProps {
  readonly label: string;
  readonly value?: number | string;
  readonly hint?: string;
  readonly tone?: 'neutral' | 'accent' | 'alert';
}

export function StatCard({ label, value, hint, tone = 'neutral' }: StatCardProps) {
  const color = tone === 'accent' ? tokens.accent : tone === 'alert' ? tokens.alert : tokens.ink;
  return (
    <Paper withBorder p="md" data-testid="stat-card">
      <Stack gap={4}>
        <Text size="sm" c="dimmed" fw={500}>
          {label}
        </Text>
        {/* The number is the content: large, tight, lining tabular figures so tiles in a row align. */}
        <Text fw={600} style={{ fontSize: 30, lineHeight: 1.05, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color }}>
          {value ?? '–'}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

export interface CohortTableProps {
  /** `data.cohort.latest_observation` rows: one per member with their latest value. */
  readonly rows?: CohortObservationRow[];
  /** `data.cohort.with_imaging` rows: the members with imaging, their study count and latest study. Alone, they are the member list; with `rows`, joined by patient. */
  readonly imaging?: CohortImagingRow[];
  readonly title?: string;
  readonly value_label?: string;
  readonly mrn_system?: string;
  /** `$ui.<key>` written by a RangeFilter: only members whose compared value lies in it are listed. */
  readonly range?: unknown;
  readonly unit?: string;
  /** app_id of an imaging app in this registry: each member row links to it, opened on that patient. */
  readonly open_in?: string;
}

/** One line per member: the value row (when the app reads a value) and the imaging row (when it narrows by imaging), by patient. */
interface MemberLine {
  readonly key: string;
  readonly patientId: string;
  readonly value?: CohortObservationRow;
  readonly imaging?: CohortImagingRow;
}

function memberLines(rows: CohortObservationRow[] | undefined, imaging: CohortImagingRow[] | undefined, range: unknown): { lines: MemberLine[]; total: number } {
  const byPatient = new Map((imaging ?? []).map((r) => [r.patient.id ?? '', r]));
  if (rows) {
    const selected = isValueRange(range) ? range : undefined;
    const shown = selected ? rowsInRange(rows, selected) : rows;
    return { lines: shown.map((r) => ({ key: r.patient.id ?? '', patientId: r.patient.id ?? '', value: r, imaging: byPatient.get(r.patient.id ?? '') })), total: rows.length };
  }
  const all = imaging ?? [];
  return { lines: all.map((r) => ({ key: r.patient.id ?? '', patientId: r.patient.id ?? '', imaging: r })), total: all.length };
}

/** "3 Nov 2025 · CT · CT Thorax mit Kontrastmittel" — the latest study named, never rendered. */
export function describeStudy(row: CohortImagingRow): string {
  const s = row.latest_study;
  return [s.started ? formatDate(s.started) : undefined, s.modalities.length ? s.modalities.join('/') : undefined, s.description].filter(Boolean).join(' · ') || '—';
}

/** Typed to the `data.cohort.latest_observation` and `data.cohort.with_imaging` primitive outputs. */
export function CohortTable({ rows, imaging, title = 'Cohort', value_label = 'Latest value', mrn_system = MRN_SYSTEM, range, unit, open_in }: CohortTableProps) {
  const selected = rows && isValueRange(range) ? range : undefined;
  const { lines, total } = memberLines(rows, imaging, range);
  // Rendered inside the panel's router normally; a plain anchor when a manifest is rendered on its own (tests, embeds).
  const inRouter = useInRouterContext();
  const imagingHref = (patientId: string) => `/apps/${encodeURIComponent(open_in ?? '')}?patient_id=${encodeURIComponent(patientId)}`;
  const patientOf = (l: MemberLine) => (l.value ?? l.imaging)!.patient;
  const withValue = rows !== undefined;
  const withImaging = imaging !== undefined;
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed" className="ds-tabular" data-testid="cohort-table-count">
            {selected ? `${lines.length} of ${total} patients · ${formatRange(selected, unit)}` : `${total} patients`}
          </Text>
        </Group>
        {total === 0 ? (
          <Text size="sm" c="dimmed">
            No patients match the cohort criteria.
          </Text>
        ) : lines.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="cohort-table-empty-range">
            No patients in this range.
          </Text>
        ) : (
          <Table withRowBorders highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Patient</Table.Th>
                <Table.Th>MRN</Table.Th>
                <Table.Th>Birth date</Table.Th>
                {withValue && <Table.Th>{value_label}</Table.Th>}
                {withValue && <Table.Th>Measured</Table.Th>}
                {withImaging && <Table.Th className="ds-tabular">Studies</Table.Th>}
                {withImaging && <Table.Th>Latest study</Table.Th>}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.map((l) => {
                const patient = patientOf(l);
                const r = l.value;
                return (
                  <Table.Tr key={l.key} data-testid="cohort-member">
                    <Table.Td>
                      <HumanNameDisplay value={patient.name?.[0]} />
                    </Table.Td>
                    <Table.Td>{getIdentifier(patient, mrn_system) ?? '—'}</Table.Td>
                    <Table.Td>{patient.birthDate ? formatDate(patient.birthDate) : '—'}</Table.Td>
                    {withValue && (
                      <Table.Td>
                        {r && r.systolic !== undefined && r.diastolic !== undefined
                          ? `${r.systolic}/${r.diastolic} mmHg`
                          : r && r.value !== undefined
                            ? `${r.value}${r.unit ? ` ${r.unit}` : ''}`
                            : '—'}
                      </Table.Td>
                    )}
                    {withValue && <Table.Td>{r?.date ? formatDate(r.date) : '—'}</Table.Td>}
                    {withImaging && (
                      <Table.Td className="ds-tabular" data-testid="cohort-study-count">
                        {l.imaging ? l.imaging.study_count : '—'}
                      </Table.Td>
                    )}
                    {withImaging && <Table.Td data-testid="cohort-latest-study">{l.imaging ? describeStudy(l.imaging) : '—'}</Table.Td>}
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap" justify="flex-end">
                        {r?.above_threshold && (
                          <Badge color="red" variant="light" tt="none">
                            above threshold
                          </Badge>
                        )}
                        {open_in && l.imaging && (
                          // The register names the studies; the imaging app shows them — on this patient, in its own scope and audit.
                          inRouter ? (
                            <Anchor component={Link} to={imagingHref(l.patientId)} size="sm" data-testid="cohort-open-imaging">
                              Open imaging
                            </Anchor>
                          ) : (
                            <Anchor href={imagingHref(l.patientId)} size="sm" data-testid="cohort-open-imaging">
                              Open imaging
                            </Anchor>
                          )
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Paper>
  );
}
