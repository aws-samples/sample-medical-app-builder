import type { Condition, MedicationRequest, Observation } from '@medplum/fhirtypes';
import { formatDate, formatDateTime } from '@medplum/core';
import { CodeableConceptDisplay, QuantityDisplay, StatusBadge } from '@medplum/react';
import { BADGE_CELL, KEEP_WHOLE } from './badgeStyles';
import { RowAction, RowActionOutcome } from './RowAction';
import { Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { flattenObservationValue, lateralityOf, SIDE_WORD } from '../data/fhirHelpers';

function Frame({ title, count, children }: { title?: string; count?: number; children: React.ReactNode }) {
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        {title && (
          <Group justify="space-between" align="baseline">
            <Title order={4}>{title}</Title>
            {count !== undefined && (
              <Text size="sm" c="dimmed">
                {count} {count === 1 ? 'entry' : 'entries'}
              </Text>
            )}
          </Group>
        )}
        {children}
      </Stack>
    </Paper>
  );
}

function Empty({ what }: { what: string }) {
  return (
    <Text size="sm" c="dimmed">
      No {what} in the selected window.
    </Text>
  );
}

/* ───────────────────────────── Observations ───────────────────────────── */

export interface VitalsTableProps {
  readonly observations?: Observation[];
  readonly title?: string;
  readonly max_rows?: number;
  /** Narrow-column mode: date only, no status column, values on one line (e.g. "135/83 mmHg"). */
  readonly compact?: boolean;
}

/** Renders value[x] correctly whatever shape it takes: Quantity, CodeableConcept, string, or component[]. */
function ObservationValue({ observation, dense }: { observation: Observation; dense: boolean }) {
  const flat = flattenObservationValue(observation);
  switch (flat.kind) {
    case 'quantity':
      return <QuantityDisplay value={flat.quantity} />;
    case 'concept':
      return <CodeableConceptDisplay value={flat.concept} />;
    case 'string':
      return <>{flat.text}</>;
    case 'components': {
      const quantities = flat.parts.map((p) => p.quantity);
      const sameUnit = quantities.every((q) => q?.value !== undefined && q.unit === quantities[0]?.unit);
      if (dense && sameUnit && quantities.length === 2) {
        // Paired readings (systolic/diastolic) read naturally as "135/83 mmHg".
        return (
          <span style={{ whiteSpace: 'nowrap' }}>
            {quantities.map((q) => q?.value).join('/')} {quantities[0]?.unit}
          </span>
        );
      }
      return (
        <Group gap={dense ? 'xs' : 'md'} wrap="nowrap">
          {flat.parts.map((part) => (
            <span key={part.label} style={{ whiteSpace: 'nowrap' }}>
              <Text span size="xs" c="dimmed">
                {part.label.replace(' blood pressure', '')}{' '}
              </Text>
              {part.quantity ? <QuantityDisplay value={part.quantity} /> : part.concept ? <CodeableConceptDisplay value={part.concept} /> : '—'}
            </span>
          ))}
        </Group>
      );
    }
    default:
      return <Text c="dimmed">—</Text>;
  }
}

export function VitalsTable({ observations = [], title, max_rows = 50, compact = false }: VitalsTableProps) {
  const rows = observations.slice(0, max_rows);
  // A side column only when a measurement carries one (bodySite laterality): paired tests read left against right.
  const sided = rows.some((o) => lateralityOf(o));
  return (
    <Frame title={title} count={observations.length}>
      {rows.length === 0 ? (
        <Empty what="observations" />
      ) : (
        <Table striped highlightOnHover withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Observation</Table.Th>
              {sided && <Table.Th>Side</Table.Th>}
              <Table.Th>Value</Table.Th>
              {!compact && <Table.Th>Status</Table.Th>}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((o) => (
              <Table.Tr key={o.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{compact ? formatDate(o.effectiveDateTime) : formatDateTime(o.effectiveDateTime)}</Table.Td>
                <Table.Td>
                  <CodeableConceptDisplay value={o.code} />
                </Table.Td>
                {sided && (
                  <Table.Td style={{ whiteSpace: 'nowrap' }} data-testid="reading-side">
                    {lateralityOf(o) ? SIDE_WORD[lateralityOf(o)!] : '—'}
                  </Table.Td>
                )}
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  <ObservationValue observation={o} dense={compact} />
                </Table.Td>
                {!compact && (
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    <StatusBadge status={o.status ?? 'unknown'} styles={KEEP_WHOLE} />
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Frame>
  );
}

/* ───────────────────────────── Conditions ───────────────────────────── */

export interface ProblemListProps {
  readonly conditions?: Condition[];
  readonly title?: string;
  /** When set, each active problem offers "Mark resolved": this manifest action runs write.fhir.condition.update_status. */
  readonly resolve_action?: string;
  /** `$ui` key the write primitive's `change` config reads. */
  readonly state_key?: string;
  readonly resolve_label?: string;
}

export function ProblemList({ conditions = [], title = 'Problem list', resolve_action, state_key = 'resolve', resolve_label = 'Mark resolved' }: ProblemListProps) {
  return (
    <Frame title={title} count={conditions.length}>
      {conditions.length === 0 ? (
        <Empty what="conditions" />
      ) : (
        <Table withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Condition</Table.Th>
              <Table.Th>Onset</Table.Th>
              <Table.Th>Clinical status</Table.Th>
              <Table.Th>Verification</Table.Th>
              {resolve_action && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {conditions.map((c) => {
              const status = c.clinicalStatus?.coding?.[0]?.code ?? 'unknown';
              return (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <CodeableConceptDisplay value={c.code} />
                  </Table.Td>
                  <Table.Td>{c.onsetDateTime ? formatDate(c.onsetDateTime) : '—'}</Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <StatusBadge status={status} styles={KEEP_WHOLE} />
                  </Table.Td>
                  <Table.Td>
                    <CodeableConceptDisplay value={c.verificationStatus} />
                  </Table.Td>
                  {resolve_action && (
                    <Table.Td style={{ textAlign: 'right', ...BADGE_CELL }}>
                      {['active', 'recurrence', 'relapse'].includes(status) && c.id && (
                        <RowAction actionId={resolve_action} stateKey={state_key} target={{ id: c.id, versionId: c.meta?.versionId }} status="resolved" label={resolve_label} question="Mark this problem as resolved? The entry stays on the record with its history." remark="note" />
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
      <RowActionOutcome actionId={resolve_action} />
    </Frame>
  );
}

/* ───────────────────────────── Medications ───────────────────────────── */

export interface MedicationListProps {
  readonly medications?: MedicationRequest[];
  readonly title?: string;
  /** When set, each active prescription offers "Stop": this manifest action runs write.fhir.medication_request.update_status. */
  readonly stop_action?: string;
  readonly state_key?: string;
  readonly stop_label?: string;
}

export function MedicationList({ medications = [], title = 'Medication', stop_action, state_key = 'stop', stop_label = 'Stop' }: MedicationListProps) {
  return (
    <Frame title={title} count={medications.length}>
      {medications.length === 0 ? (
        <Empty what="medication requests" />
      ) : (
        <Table withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Medication</Table.Th>
              <Table.Th>Dosage</Table.Th>
              <Table.Th>Since</Table.Th>
              <Table.Th>Status</Table.Th>
              {stop_action && <Table.Th />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {medications.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td>
                  <CodeableConceptDisplay value={m.medicationCodeableConcept} />
                </Table.Td>
                <Table.Td>{m.dosageInstruction?.map((d) => d.text).filter(Boolean).join('; ') || '—'}</Table.Td>
                <Table.Td>{m.authoredOn ? formatDate(m.authoredOn) : '—'}</Table.Td>
                <Table.Td style={BADGE_CELL}>
                  <StatusBadge status={m.status ?? 'unknown'} styles={KEEP_WHOLE} />
                  {m.statusReason?.text && (
                    <Text size="xs" c="dimmed">
                      {m.statusReason.text}
                    </Text>
                  )}
                </Table.Td>
                {stop_action && (
                  <Table.Td style={{ textAlign: 'right', ...BADGE_CELL }}>
                    {['active', 'on-hold'].includes(m.status ?? '') && m.id && (
                      <RowAction actionId={stop_action} stateKey={state_key} target={{ id: m.id, versionId: m.meta?.versionId }} status="stopped" label={stop_label} question="Stop this prescription? It stays on the record as stopped; nothing is prescribed." remark="reason" />
                    )}
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <RowActionOutcome actionId={stop_action} />
    </Frame>
  );
}
