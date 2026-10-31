import { useState } from 'react';
import { Alert, Button, Group, List, Popover, Stack, Text, Textarea } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';

/**
 * A status change offered on one row of a list — "Mark resolved", "Stop" — as a small confirmation
 * popover with an optional remark. It only assembles the action's payload ({ id, versionId, status,
 * note | reason }); the manifest's action runs the write primitive, the dispatcher decides. The
 * versionId travels along so a record changed by someone else in the meantime is not overwritten.
 */
export interface RowActionProps {
  readonly actionId: string;
  /** `$ui` key the write primitive's `change` config reads. */
  readonly stateKey: string;
  readonly target: { readonly id: string; readonly versionId?: string };
  readonly status: string;
  readonly label: string;
  readonly question: string;
  /** Which free-text field the change carries, if any. */
  readonly remark?: 'note' | 'reason';
  readonly remarkLabel?: string;
}

export function RowAction({ actionId, stateKey, target, status, label, question, remark, remarkLabel }: RowActionProps) {
  const { actions, actionStatus, runAction } = useRenderContext();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const state = actionStatus[actionId];
  const running = state?.status === 'running';
  if (!actions[actionId]) return null;

  async function go() {
    const payload: Record<string, unknown> = { id: target.id, status };
    if (target.versionId) payload['versionId'] = target.versionId;
    if (remark && text.trim()) payload[remark] = text.trim();
    setOpen(false);
    await runAction(actionId, { [stateKey]: payload });
  }

  return (
    <Popover opened={open} onChange={setOpen} position="bottom-end" withArrow shadow="md" width={320}>
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setOpen((o) => !o)} disabled={running} data-testid={`row-action-${target.id}`}>
          {label}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs" data-testid={`row-action-form-${target.id}`}>
          <Text size="sm">{question}</Text>
          {remark && <Textarea size="xs" label={remarkLabel ?? (remark === 'reason' ? 'Reason (optional)' : 'Remark (optional)')} value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={2} maxRows={4} />}
          <Group gap="xs" justify="flex-end">
            <Button size="xs" variant="subtle" color="gray" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="xs" color="red" variant="light" onClick={() => void go()} data-testid={`row-action-confirm-${target.id}`}>
              {label}
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** What the last run of a row action said, shown once under the list. */
export function RowActionOutcome({ actionId }: { actionId?: string }) {
  const { actionStatus } = useRenderContext();
  if (!actionId) return null;
  const state = actionStatus[actionId];
  if (!state || state.status === 'idle' || state.status === 'running') return null;
  if (state.status === 'success') {
    return (
      <Alert color="clinical" variant="light" py="xs" data-testid={`row-action-saved-${actionId}`}>
        <Text size="sm">{state.message}</Text>
      </Alert>
    );
  }
  return (
    <Alert color="red" variant="light" py="xs" title={state.message} data-testid={`row-action-error-${actionId}`}>
      {state.problems && (
        <List size="sm">
          {state.problems.map((p) => (
            <List.Item key={p}>{p}</List.Item>
          ))}
        </List>
      )}
    </Alert>
  );
}
