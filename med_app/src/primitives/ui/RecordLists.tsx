import type { ReactNode } from 'react';
import type { AllergyIntolerance, CodeableConcept, DiagnosticReport, DocumentReference, Encounter, Quantity, Resource } from '@medplum/fhirtypes';
import { formatDate } from '@medplum/core';
import { CodeableConceptDisplay, QuantityDisplay, StatusBadge } from '@medplum/react';
import { Badge, Group, Paper, Spoiler, Stack, Table, Text, Title } from '@mantine/core';
import { BADGE_CELL, KEEP_WHOLE } from './badgeStyles';

/**
 * The rest of the record, as lists: allergies, visits, reports, notes — and a generic table for any
 * allow-listed resource type. All of them are deterministic renderings of FHIR fields; none computes,
 * scores or interprets. Where a field is missing the cell shows "—", never a guess.
 */

function Frame({ title, count, testId, children }: { title?: string; count?: number; testId: string; children: ReactNode }) {
  return (
    <Paper withBorder p="md" data-testid={testId}>
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

// Plain booleans rather than type guards: every FHIR datatype is all-optional, so a guard's false branch
// would narrow a record to `never`.
function looksLikeConcept(o: Record<string, unknown>): boolean {
  return 'coding' in o || ('text' in o && Object.keys(o).length <= 2);
}

function looksLikeQuantity(o: Record<string, unknown>): boolean {
  return 'value' in o && ('unit' in o || 'code' in o);
}

/** One FHIR field, rendered by what it is: dates, concepts, quantities, periods, references, attachments, lists. */
export function formatField(value: unknown, options: { status?: boolean } = {}): ReactNode {
  if (value === undefined || value === null || value === '') return <Text span c="dimmed">—</Text>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (options.status) return <StatusBadge status={value} styles={KEEP_WHOLE} />;
    if (ISO_DATE.test(value)) return formatDate(value); // a table wants the day; the time is rarely the point
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text span c="dimmed">—</Text>;
    const shown = value.slice(0, 3);
    return (
      <>
        {shown.map((v, i) => (
          <span key={i}>
            {i > 0 && ', '}
            {formatField(v, options)}
          </span>
        ))}
        {value.length > 3 && (
          <Text span size="xs" c="dimmed">
            {' '}
            +{value.length - 3} more
          </Text>
        )}
      </>
    );
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (looksLikeQuantity(o)) return <QuantityDisplay value={o as Quantity} />;
    if ('start' in o || 'end' in o) {
      const start = typeof o.start === 'string' ? formatField(o.start) : '—';
      const end = typeof o.end === 'string' ? formatField(o.end) : '';
      return end ? (
        <>
          {start} – {end}
        </>
      ) : (
        start
      );
    }
    if ('reference' in o || ('display' in o && !('code' in o))) return String(o.display ?? o.reference ?? '—');
    if ('code' in o && !('coding' in o)) return String(o.display ?? o.code);
    if (looksLikeConcept(o)) return <CodeableConceptDisplay value={o as CodeableConcept} />;
    if ('contentType' in o || 'title' in o) return String(o.title ?? o.contentType ?? '—');
    if ('text' in o) return String(o.text);
  }
  return String(value);
}

/** `reaction[0].manifestation[0]`, `period.start`, `type` — dotted paths with optional indexes; arrays pass through. */
export function getPath(resource: unknown, path: string): unknown {
  let current: unknown = resource;
  for (const raw of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(raw);
    if (!m) return undefined;
    current = (current as Record<string, unknown>)[m[1] as string];
    if (m[2] !== undefined) current = Array.isArray(current) ? current[Number(m[2])] : undefined;
  }
  return current;
}

/* ───────────────────────────── Generic list ───────────────────────────── */

export interface ResourceListColumn {
  readonly label: string;
  /** A field path on the resource, e.g. `code`, `performedDateTime`, `reaction[0].manifestation`. */
  readonly path: string;
  /** Render as a status badge (for `status`-like codes). */
  readonly status?: boolean;
}

export interface ResourceListProps {
  readonly resources?: Resource[];
  readonly title?: string;
  readonly columns: readonly ResourceListColumn[];
  readonly max_rows?: number;
  readonly empty_text?: string;
}

/** Any allow-listed resource type as a table: the long tail the dedicated lists do not cover. */
export function ResourceList({ resources = [], title, columns, max_rows = 50, empty_text = 'Nothing recorded.' }: ResourceListProps) {
  const rows = resources.slice(0, max_rows);
  return (
    <Frame title={title} count={resources.length} testId="resource-list">
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {empty_text}
        </Text>
      ) : (
        <Table withRowBorders>
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => (
                <Table.Th key={c.label}>{c.label}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => (
              <Table.Tr key={r.id ?? i}>
                {columns.map((c) => (
                  <Table.Td key={c.label} style={c.status ? BADGE_CELL : undefined}>
                    {formatField(getPath(r, c.path), { status: c.status })}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Frame>
  );
}

/* ───────────────────────────── Allergies ───────────────────────────── */

function criticalityColor(c: AllergyIntolerance['criticality']): string {
  return c === 'high' ? 'red' : c === 'low' ? 'gray' : 'yellow';
}

/**
 * Allergies and intolerances — the safety list. A high criticality is shown in red; "none recorded" is
 * stated as such, because an empty list and "no known allergies" are different clinical facts.
 */
export function AllergyList({ allergies = [], title = 'Allergies and intolerances' }: { allergies?: AllergyIntolerance[]; title?: string }) {
  return (
    <Frame title={title} count={allergies.length} testId="allergy-list">
      {allergies.length === 0 ? (
        <Text size="sm" c="dimmed">
          No allergies or intolerances recorded.
        </Text>
      ) : (
        <Table withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Substance</Table.Th>
              <Table.Th>Category</Table.Th>
              <Table.Th>Criticality</Table.Th>
              <Table.Th>Reaction</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Recorded</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {allergies.map((a) => (
              <Table.Tr key={a.id} data-criticality={a.criticality ?? 'unknown'}>
                <Table.Td>
                  <Text fw={a.criticality === 'high' ? 600 : 400} span>
                    <CodeableConceptDisplay value={a.code} />
                  </Text>
                </Table.Td>
                <Table.Td>{a.category?.join(', ') ?? '—'}</Table.Td>
                <Table.Td style={BADGE_CELL}>
                  {a.criticality ? (
                    <Badge size="sm" color={criticalityColor(a.criticality)} variant={a.criticality === 'high' ? 'filled' : 'light'} tt="none" styles={KEEP_WHOLE}>
                      {a.criticality === 'high' ? 'high' : a.criticality === 'low' ? 'low' : 'unable to assess'}
                    </Badge>
                  ) : (
                    <Text span c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {a.reaction?.length
                    ? a.reaction.map((r, i) => (
                        <span key={i}>
                          {i > 0 && '; '}
                          {r.manifestation?.map((m, j) => (
                            <span key={j}>
                              {j > 0 && ', '}
                              <CodeableConceptDisplay value={m} />
                            </span>
                          ))}
                          {r.severity && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              ({r.severity})
                            </Text>
                          )}
                        </span>
                      ))
                    : '—'}
                </Table.Td>
                <Table.Td style={BADGE_CELL}>
                  <StatusBadge status={a.clinicalStatus?.coding?.[0]?.code ?? 'unknown'} styles={KEEP_WHOLE} />
                </Table.Td>
                <Table.Td>{a.recordedDate ? formatDate(a.recordedDate) : '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Frame>
  );
}

/* ───────────────────────────── Encounters ───────────────────────────── */

export function EncounterList({ encounters = [], title = 'Visits', max_rows = 50 }: { encounters?: Encounter[]; title?: string; max_rows?: number }) {
  const rows = encounters.slice(0, max_rows);
  return (
    <Frame title={title} count={encounters.length} testId="encounter-list">
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No visits recorded.
        </Text>
      ) : (
        <Table withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Visit</Table.Th>
              <Table.Th>Setting</Table.Th>
              <Table.Th>Reason</Table.Th>
              <Table.Th>Clinician</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{e.period?.start ? formatDate(e.period.start) : '—'}</Table.Td>
                <Table.Td>{e.type?.[0]?.text ?? (e.type?.[0] ? <CodeableConceptDisplay value={e.type[0]} /> : '—')}</Table.Td>
                <Table.Td>{e.class?.display ?? e.class?.code ?? '—'}</Table.Td>
                <Table.Td>{e.reasonCode?.[0] ? <CodeableConceptDisplay value={e.reasonCode[0]} /> : '—'}</Table.Td>
                <Table.Td>{e.participant?.[0]?.individual?.display ?? '—'}</Table.Td>
                <Table.Td style={BADGE_CELL}>
                  <StatusBadge status={e.status ?? 'unknown'} styles={KEEP_WHOLE} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Frame>
  );
}

/* ───────────────────────────── Reports ───────────────────────────── */

/** Diagnostic reports with their conclusion: one card per report, newest first as delivered. */
export function ReportList({ reports = [], title = 'Reports', max_rows = 20 }: { reports?: DiagnosticReport[]; title?: string; max_rows?: number }) {
  const rows = reports.slice(0, max_rows);
  return (
    <Frame title={title} count={reports.length} testId="report-list">
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No reports recorded.
        </Text>
      ) : (
        <Stack gap="sm">
          {rows.map((r) => (
            <Paper key={r.id} withBorder p="sm" radius="sm" data-testid="report-card">
              <Group justify="space-between" align="baseline" wrap="nowrap">
                <Text fw={600} size="sm">
                  {r.code?.text ?? <CodeableConceptDisplay value={r.code} />}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  {r.category?.[0] && (
                    <Badge size="xs" variant="light" color="ink" tt="none" styles={KEEP_WHOLE}>
                      {r.category[0].coding?.[0]?.display ?? r.category[0].text ?? r.category[0].coding?.[0]?.code}
                    </Badge>
                  )}
                  <StatusBadge status={r.status ?? 'unknown'} styles={KEEP_WHOLE} />
                </Group>
              </Group>
              <Text size="xs" c="dimmed">
                {r.effectiveDateTime ? formatDate(r.effectiveDateTime) : r.issued ? formatDate(r.issued) : '—'}
                {r.performer?.[0]?.display ? ` · ${r.performer[0].display}` : ''}
                {r.result?.length ? ` · ${r.result.length} ${r.result.length === 1 ? 'result' : 'results'}` : ''}
              </Text>
              {r.conclusion ? (
                <Text size="sm" mt={6} style={{ whiteSpace: 'pre-wrap' }}>
                  {r.conclusion}
                </Text>
              ) : (
                <Text size="sm" mt={6} c="dimmed">
                  No conclusion text.
                </Text>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </Frame>
  );
}

/* ───────────────────────────── Documents / notes ───────────────────────────── */

/** The note text when the attachment is inline plain text; otherwise nothing (no fetching, no guessing). */
export function attachmentText(doc: DocumentReference): string | undefined {
  const att = doc.content?.find((c) => c.attachment?.data && (c.attachment.contentType ?? '').startsWith('text/'))?.attachment;
  if (!att?.data) return undefined;
  try {
    const binary = atob(att.data);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

/** Clinical notes and letters: title, date, author, and the text itself when it is inline; long notes fold. */
export function DocumentList({ documents = [], title = 'Notes and letters', max_rows = 20 }: { documents?: DocumentReference[]; title?: string; max_rows?: number }) {
  const rows = documents.slice(0, max_rows);
  return (
    <Frame title={title} count={documents.length} testId="document-list">
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No notes recorded.
        </Text>
      ) : (
        <Stack gap="sm">
          {rows.map((d) => {
            const text = attachmentText(d);
            const other = d.content?.find((c) => !(c.attachment?.contentType ?? '').startsWith('text/'))?.attachment;
            return (
              <Paper key={d.id} withBorder p="sm" radius="sm" data-testid="document-card">
                <Group justify="space-between" align="baseline" wrap="nowrap">
                  <Text fw={600} size="sm">
                    {d.description ?? d.type?.text ?? <CodeableConceptDisplay value={d.type} />}
                  </Text>
                  <StatusBadge status={d.docStatus ?? d.status ?? 'unknown'} styles={KEEP_WHOLE} />
                </Group>
                <Text size="xs" c="dimmed">
                  {d.date ? formatDate(d.date) : '—'}
                  {d.author?.[0]?.display ? ` · ${d.author[0].display}` : ''}
                  {d.type?.coding?.[0]?.display && d.description ? ` · ${d.type.coding[0].display}` : ''}
                </Text>
                {text ? (
                  <Spoiler maxHeight={96} showLabel="Show the whole note" hideLabel="Show less" mt={6}>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {text}
                    </Text>
                  </Spoiler>
                ) : (
                  <Text size="sm" mt={6} c="dimmed">
                    {other ? `${other.contentType ?? 'Document'}${other.title ? ` · ${other.title}` : ''} — not shown inline.` : 'No inline text.'}
                  </Text>
                )}
              </Paper>
            );
          })}
        </Stack>
      )}
    </Frame>
  );
}
