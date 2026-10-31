import { useMemo, useState } from 'react';
import type { Task } from '@medplum/fhirtypes';
import { formatDate, getIdentifier } from '@medplum/core';
import { HumanNameDisplay, StatusBadge } from '@medplum/react';
import { Alert, Anchor, Badge, Button, Group, List, Paper, SegmentedControl, Select, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { Link, useInRouterContext } from 'react-router-dom';
import { useRenderContext } from '../../renderer/RenderContext';
import type { AssessmentDueRow, WorklistRow } from '../data/mock/mockExecutor';
import { MRN_SYSTEM, TASK_SYSTEM } from '../data/mock/seed';
import { validateTaskEntry } from '../data/writes';
import { ActionForm } from './ActionForm';
import { BADGE_CELL, KEEP_WHOLE } from './badgeStyles';
import { RowAction, RowActionOutcome } from './RowAction';

/**
 * Tasks: what is to be done for a patient, by when, how urgent, who has taken it — FHIR Task resources with the
 * author's own task vocabulary as their code. Three faces: the patient's own list (a composed-page section), the
 * form that puts a task on it, and the worklist across patients (APP-13). Moving a task on is a status change the
 * record keeps, attributed to whoever did it; the dispatcher decides, the lists only ask.
 */

const PRIORITY_COLOR: Record<string, string> = { routine: 'gray', urgent: 'orange', asap: 'red', stat: 'red' };
const PRIORITY_LABEL: Record<string, string> = { routine: 'Routine', urgent: 'Urgent', asap: 'ASAP', stat: 'STAT' };

const dueOf = (t: Task): string | undefined => t.restriction?.period?.end?.slice(0, 10);
const today = (): string => new Date().toISOString().slice(0, 10);
const isOpen = (t: Task): boolean => t.status === 'requested' || t.status === 'in-progress' || t.status === 'on-hold' || t.status === 'ready' || t.status === 'accepted';

function Due({ task }: { task: Task }) {
  const due = dueOf(task);
  if (!due) return <Text c="dimmed">—</Text>;
  const overdue = isOpen(task) && due < today();
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" c={overdue ? 'red' : undefined} fw={overdue ? 600 : 400} className="ds-tabular">
        {formatDate(due)}
      </Text>
      {overdue && (
        <Badge size="xs" color="red" variant="filled" tt="none" styles={KEEP_WHOLE} data-testid="task-overdue">
          overdue
        </Badge>
      )}
    </Group>
  );
}

function Priority({ task }: { task: Task }) {
  const p = task.priority ?? 'routine';
  return (
    <Badge size="sm" color={PRIORITY_COLOR[p] ?? 'gray'} variant={p === 'routine' ? 'light' : 'filled'} tt="none" styles={KEEP_WHOLE}>
      {PRIORITY_LABEL[p] ?? p}
    </Badge>
  );
}

/** Who has the task: the owner's display, their email, or "—" when nobody has taken it. */
function Owner({ task }: { task: Task }) {
  const who = task.owner?.display ?? task.owner?.identifier?.value;
  return <Text size="sm" c={who ? undefined : 'dimmed'}>{who ?? '—'}</Text>;
}

/** The row actions a task offers, by its status: Start and Complete while requested, Complete while in progress, Cancel when allowed. */
function TaskActions({ task, actionId, stateKey, cancel }: { task: Task; actionId: string; stateKey: string; cancel: boolean }) {
  if (!task.id || !isOpen(task)) return null;
  const target = { id: task.id, versionId: task.meta?.versionId };
  const what = task.code?.text ?? task.code?.coding?.[0]?.display ?? 'this task';
  return (
    <Group gap={2} justify="flex-end" wrap="nowrap">
      {task.status === 'requested' && <RowAction actionId={actionId} stateKey={stateKey} target={target} status="in-progress" label="Start" question={`Take on "${what}"? It is marked in progress, with you as its owner.`} remark="note" />}
      <RowAction actionId={actionId} stateKey={stateKey} target={target} status="completed" label="Complete" question={`Mark "${what}" as completed? The task stays on the record with who did it and when.`} remark="note" />
      {cancel && <RowAction actionId={actionId} stateKey={stateKey} target={target} status="cancelled" label="Cancel" question={`Cancel "${what}"? It leaves the open list; the record keeps it as cancelled.`} remark="note" remarkLabel="Why (optional)" />}
    </Group>
  );
}

// ── the patient's tasks ─────────────────────────────────────────────────────────────────────

export interface TaskListProps {
  readonly tasks?: Task[];
  readonly title?: string;
  /** When set, each open task offers Start / Complete: this manifest action runs write.fhir.task.update_status. */
  readonly status_action?: string;
  readonly state_key?: string;
  readonly cancel?: boolean;
}

export function TaskList({ tasks = [], title = 'Tasks', status_action, state_key = 'task_status', cancel = false }: TaskListProps) {
  return (
    <Paper withBorder p="md" data-testid="task-list">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </Text>
        </Group>
        {tasks.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing open.
          </Text>
        ) : (
          <Table withRowBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Task</Table.Th>
                <Table.Th>Due</Table.Th>
                <Table.Th>Priority</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Owner</Table.Th>
                {status_action && <Table.Th />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {tasks.map((t) => (
                <Table.Tr key={t.id} data-testid={`task-row-${t.id}`}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {t.code?.text ?? t.code?.coding?.[0]?.display ?? t.code?.coding?.[0]?.code}
                    </Text>
                    {t.description && (
                      <Text size="xs" c="dimmed">
                        {t.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Due task={t} />
                  </Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <Priority task={t} />
                  </Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <StatusBadge status={t.status} styles={KEEP_WHOLE} />
                  </Table.Td>
                  <Table.Td>
                    <Owner task={t} />
                  </Table.Td>
                  {status_action && (
                    <Table.Td style={{ textAlign: 'right', ...BADGE_CELL }}>
                      <TaskActions task={t} actionId={status_action} stateKey={state_key} cancel={cancel} />
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <RowActionOutcome actionId={status_action} />
      </Stack>
    </Paper>
  );
}

// ── a new task ───────────────────────────────────────────────────────────────────────────────

export interface TaskEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  /** The task kinds the form may create. */
  readonly codes: readonly { code: string; display: string }[];
  readonly priorities?: readonly string[];
  readonly due?: boolean;
  readonly description?: boolean;
}

export function TaskEntryForm({ action, state_key = 'task_entry', title, submit_label = 'Create task', codes, priorities = ['routine', 'urgent'], due = true, description = true }: TaskEntryFormProps) {
  return (
    <ActionForm action={action} title={title ?? 'New task'} subtitle="Put on the patient's list as requested; whoever takes it becomes its owner." another_label="Create another" testid="task-entry">
      {({ formKey, running, submit }) => <TaskFields key={formKey} codes={codes} priorities={priorities} due={due} description={description} running={running} submitLabel={submit_label} onSubmit={(t) => submit({ [state_key]: t })} />}
    </ActionForm>
  );
}

function TaskFields({ codes, priorities, due, description, running, submitLabel, onSubmit }: { codes: readonly { code: string; display: string }[]; priorities: readonly string[]; due: boolean; description: boolean; running: boolean; submitLabel: string; onSubmit: (t: Task) => void }) {
  const { context } = useRenderContext();
  const patientId = typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;
  const [code, setCode] = useState<string | null>(codes.length === 1 ? codes[0]!.code : null);
  const [priority, setPriority] = useState<string>(priorities[0] ?? 'routine');
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const rules = useMemo(() => ({ codes: codes.map((c) => `${TASK_SYSTEM}|${c.code}`), priorities, due }), [codes, priorities, due]);

  function build(): Task {
    const chosen = codes.find((c) => c.code === code);
    return {
      resourceType: 'Task',
      identifier: [{ system: 'urn:medapp:submission', value: crypto.randomUUID() }],
      status: 'requested',
      intent: 'order',
      priority: priority as Task['priority'],
      code: chosen ? { coding: [{ system: TASK_SYSTEM, code: chosen.code, display: chosen.display }], text: chosen.display } : { text: '' },
      for: patientId ? { reference: `Patient/${patientId}` } : {},
      ...(when ? { restriction: { period: { end: when } } } : {}),
      ...(text.trim() ? { description: text.trim() } : {}),
    };
  }

  function trySubmit() {
    const found = code ? validateTaskEntry(rules, build(), patientId ?? '', new Date()) : ['choose what is to be done'];
    setProblems(found);
    if (found.length === 0) onSubmit(build());
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-end" wrap="wrap">
        <Select label="Task" placeholder="Choose…" data={codes.map((c) => ({ value: c.code, label: c.display }))} value={code} onChange={setCode} searchable required disabled={running} style={{ flex: 1, minWidth: 220 }} data-testid="entry-code" />
        {priorities.length > 1 && <Select label="Priority" data={priorities.map((p) => ({ value: p, label: PRIORITY_LABEL[p] ?? p }))} value={priority} onChange={(v) => v && setPriority(v)} allowDeselect={false} w={150} disabled={running} data-testid="entry-priority" />}
        {due && <TextInput type="date" label="Due (optional)" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={180} disabled={running} data-testid="entry-due" />}
      </Group>
      {description && <Textarea label="What exactly (optional)" value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={1} maxRows={3} maxLength={500} disabled={running} data-testid="entry-description" />}
      {problems.length > 0 && (
        <Alert color="red" variant="light" title="Please check the entry" data-testid="entry-problems">
          <List size="sm">
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          The platform records who requested it and when.
        </Text>
        <Button onClick={trySubmit} loading={running} style={{ flex: 'none' }} data-testid="entry-submit">
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}

// ── the worklist across patients ─────────────────────────────────────────────────────────────

export interface WorklistProps {
  /** `data.task.worklist` rows: each open task with the patient it is for, already ordered (overdue first). */
  readonly rows?: WorklistRow[];
  readonly title?: string;
  readonly status_action?: string;
  readonly state_key?: string;
  readonly cancel?: boolean;
  /** Offer the "Mine / Everyone" switch (mine = tasks whose owner is the signed-in person). */
  readonly mine?: boolean;
  /** app_id of an app in this registry each row links to, opened on that patient. */
  readonly open_in?: string;
  readonly mrn_system?: string;
}

export function Worklist({ rows = [], title = 'Open tasks', status_action, state_key = 'worklist_status', cancel = false, mine = true, open_in, mrn_system = MRN_SYSTEM }: WorklistProps) {
  const { identity } = useRenderContext();
  const [who, setWho] = useState<'everyone' | 'mine'>('everyone');
  const inRouter = useInRouterContext();
  const me = identity.sub;
  const shown = who === 'mine' ? rows.filter((r) => r.task.owner?.identifier?.value === me) : rows;
  const href = (patientId: string) => `/apps/${encodeURIComponent(open_in ?? '')}?patient_id=${encodeURIComponent(patientId)}`;
  return (
    <Paper withBorder p="md" data-testid="worklist">
      <Stack gap="sm">
        <Group justify="space-between" align="center">
          <Title order={4}>{title}</Title>
          <Group gap="md">
            {mine && (
              <SegmentedControl
                size="xs"
                value={who}
                onChange={(v) => setWho(v as 'everyone' | 'mine')}
                data={[
                  { label: 'Everyone', value: 'everyone' },
                  { label: 'Mine', value: 'mine' },
                ]}
                data-testid="worklist-who"
              />
            )}
            <Text size="sm" c="dimmed" className="ds-tabular" data-testid="worklist-count">
              {who === 'mine' ? `${shown.length} of ${rows.length}` : `${rows.length}`} {rows.length === 1 && who !== 'mine' ? 'task' : 'tasks'}
            </Text>
          </Group>
        </Group>
        {shown.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="worklist-empty">
            {who === 'mine' ? 'Nothing taken on by you.' : 'Nothing open.'}
          </Text>
        ) : (
          <Table withRowBorders highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Patient</Table.Th>
                <Table.Th>MRN</Table.Th>
                <Table.Th>Task</Table.Th>
                <Table.Th>Due</Table.Th>
                <Table.Th>Priority</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Owner</Table.Th>
                {(status_action || open_in) && <Table.Th />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((r) => (
                <Table.Tr key={r.task.id} data-testid={`worklist-row-${r.task.id}`} data-overdue={r.overdue ? 'true' : undefined}>
                  <Table.Td>
                    <HumanNameDisplay value={r.patient.name?.[0]} />
                  </Table.Td>
                  <Table.Td className="ds-tabular">{getIdentifier(r.patient, mrn_system) ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {r.task.code?.text ?? r.task.code?.coding?.[0]?.display ?? r.task.code?.coding?.[0]?.code}
                    </Text>
                    {r.task.description && (
                      <Text size="xs" c="dimmed">
                        {r.task.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Due task={r.task} />
                  </Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <Priority task={r.task} />
                  </Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <StatusBadge status={r.task.status} styles={KEEP_WHOLE} />
                  </Table.Td>
                  <Table.Td>
                    <Owner task={r.task} />
                  </Table.Td>
                  {(status_action || open_in) && (
                    <Table.Td style={{ textAlign: 'right', ...BADGE_CELL }}>
                      <Group gap="xs" justify="flex-end" wrap="nowrap">
                        {open_in &&
                          r.patient.id &&
                          (inRouter ? (
                            <Anchor component={Link} to={href(r.patient.id)} size="sm" data-testid="worklist-open">
                              Open
                            </Anchor>
                          ) : (
                            <Anchor href={href(r.patient.id)} size="sm" data-testid="worklist-open">
                              Open
                            </Anchor>
                          ))}
                        {status_action && <TaskActions task={r.task} actionId={status_action} stateKey={state_key} cancel={cancel} />}
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <RowActionOutcome actionId={status_action} />
      </Stack>
    </Paper>
  );
}

// ── who is due an assessment ─────────────────────────────────────────────────────────────────

export interface AssessmentDueListProps {
  /** `data.cohort.assessment_due` rows, already ordered: never assessed, then the longest overdue, then due, then upcoming. */
  readonly rows?: AssessmentDueRow[];
  readonly title?: string;
  /** The assessment in words, e.g. "falls risk screen". */
  readonly label?: string;
  readonly every_days?: number;
  /** app_id of an app in this registry each row links to, opened on that patient — the assessment app, typically. */
  readonly open_in?: string;
  readonly mrn_system?: string;
}

const STANDING: Record<AssessmentDueRow['status'], { color: string; text: (r: AssessmentDueRow) => string }> = {
  never: { color: 'red', text: () => 'never assessed' },
  overdue: { color: 'red', text: (r) => `overdue ${r.overdue_days} ${r.overdue_days === 1 ? 'day' : 'days'}` },
  due: { color: 'orange', text: () => 'due today' },
  upcoming: { color: 'gray', text: (r) => `due ${formatDate(r.due_on ?? '')}` },
};

export function AssessmentDueList({ rows = [], title, label = 'assessment', every_days, open_in, mrn_system = MRN_SYSTEM }: AssessmentDueListProps) {
  const inRouter = useInRouterContext();
  const href = (patientId: string) => `/apps/${encodeURIComponent(open_in ?? '')}?patient_id=${encodeURIComponent(patientId)}`;
  return (
    <Paper withBorder p="md" data-testid="assessment-due-list">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title ?? `Due a ${label}`}</Title>
          <Text size="sm" c="dimmed" className="ds-tabular" data-testid="assessment-due-count">
            {rows.length} {rows.length === 1 ? 'patient' : 'patients'}
            {every_days ? ` · every ${every_days} days` : ''}
          </Text>
        </Group>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="assessment-due-empty">
            Nobody is due a {label}.
          </Text>
        ) : (
          <Table withRowBorders highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Patient</Table.Th>
                <Table.Th>MRN</Table.Th>
                <Table.Th>Last {label}</Table.Th>
                <Table.Th>Standing</Table.Th>
                {open_in && <Table.Th />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.patient.id} data-testid={`due-row-${r.patient.id}`} data-standing={r.status}>
                  <Table.Td>
                    <HumanNameDisplay value={r.patient.name?.[0]} />
                  </Table.Td>
                  <Table.Td className="ds-tabular">{getIdentifier(r.patient, mrn_system) ?? '—'}</Table.Td>
                  <Table.Td className="ds-tabular">{r.last_authored ? formatDate(r.last_authored) : <Text span c="dimmed">—</Text>}</Table.Td>
                  <Table.Td style={BADGE_CELL}>
                    <Badge size="sm" color={STANDING[r.status].color} variant={r.status === 'upcoming' ? 'light' : 'filled'} tt="none" styles={KEEP_WHOLE}>
                      {STANDING[r.status].text(r)}
                    </Badge>
                  </Table.Td>
                  {open_in && r.patient.id && (
                    <Table.Td style={{ textAlign: 'right', ...BADGE_CELL }}>
                      {inRouter ? (
                        <Anchor component={Link} to={href(r.patient.id)} size="sm" data-testid="due-open">
                          Open
                        </Anchor>
                      ) : (
                        <Anchor href={href(r.patient.id)} size="sm" data-testid="due-open">
                          Open
                        </Anchor>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Paper>
  );
}
