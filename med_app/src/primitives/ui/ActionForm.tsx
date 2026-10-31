import { useCallback, useState, type ReactNode } from 'react';
import { Alert, Button, List, Paper, Stack, Text, Title } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useRenderContext, type ActionStatus } from '../../renderer/RenderContext';

/**
 * The lifecycle every action-driven form shares, in one place:
 *
 *   idle ──submit──▶ running ──▶ success ──"record another"──▶ idle (form remounted empty)
 *                        └─────▶ error (message + problems; the form stays, with its answers)
 *
 * Catalog components that write to the record compose this instead of handling action status
 * themselves, so the behaviour — and its tests — exist once. A component only decides what the
 * form looks like and how it turns the user's input into the action payload.
 */

const IDLE: ActionStatus = { status: 'idle' };

export interface ActionFormState {
  /** False when the manifest declares no such action — the shell shows a refusal, nothing can be submitted. */
  readonly declared: boolean;
  readonly status: ActionStatus;
  readonly running: boolean;
  /** Changes on every reset: use it as the `key` of the inner form so it remounts with no answers. */
  readonly formKey: number;
  /** Hand the payload to the action; keys are `$ui` names the write primitive's config reads. */
  readonly submit: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Back to idle with a fresh form. */
  readonly reset: () => void;
}

export function useActionForm(actionId: string): ActionFormState {
  const { actions, actionStatus, runAction, resetAction } = useRenderContext();
  const [formKey, setFormKey] = useState(0);
  const status = actionStatus[actionId] ?? IDLE;
  const running = status.status === 'running';
  const submit = useCallback((payload: Readonly<Record<string, unknown>>) => runAction(actionId, payload), [runAction, actionId]);
  const reset = useCallback(() => {
    if (running) return; // never drop a form whose save is still in flight
    resetAction(actionId);
    setFormKey((k) => k + 1);
  }, [running, resetAction, actionId]);
  return { declared: Boolean(actions[actionId]), status, running, formKey, submit, reset };
}

export interface ActionFormRenderProps {
  readonly formKey: number;
  readonly running: boolean;
  readonly submit: ActionFormState['submit'];
}

export interface ActionFormProps {
  readonly action: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** Heading of the success panel. */
  readonly success_title?: string;
  /** Label of the button that starts a new entry. */
  readonly another_label?: string;
  readonly testid?: string;
  /** The form itself; `formKey` must be the inner form's `key`. */
  readonly children: (form: ActionFormRenderProps) => ReactNode;
}

export function ActionForm({ action, title, subtitle, success_title = 'Saved to the patient record', another_label = 'Record another', testid = 'action-form', children }: ActionFormProps) {
  const { declared, status, running, formKey, submit, reset } = useActionForm(action);

  return (
    <Paper withBorder p="md" data-testid={testid}>
      <Stack gap="sm">
        <div>
          <Title order={4}>{title}</Title>
          {subtitle && (
            <Text size="xs" c="dimmed">
              {subtitle}
            </Text>
          )}
        </div>

        {!declared && <Alert color="red">This form&apos;s action &quot;{action}&quot; is not declared by the app.</Alert>}

        {status.status === 'success' ? (
          <Alert color="clinical" icon={<IconCheck size={18} />} title={success_title} variant="light" data-testid="action-saved">
            <Text size="sm">{status.message}</Text>
            <Button mt="sm" size="xs" variant="light" color="clinical" onClick={reset}>
              {another_label}
            </Button>
          </Alert>
        ) : (
          <>
            {status.status === 'error' && (
              <Alert color="red" title={status.message} variant="light" data-testid="action-error">
                {status.problems && (
                  <List size="sm">
                    {status.problems.map((p) => (
                      <List.Item key={p}>{p}</List.Item>
                    ))}
                  </List>
                )}
              </Alert>
            )}
            <div style={{ opacity: running ? 0.6 : 1, pointerEvents: running ? 'none' : undefined }} aria-busy={running || undefined}>
              {declared && children({ formKey, running, submit })}
            </div>
          </>
        )}
      </Stack>
    </Paper>
  );
}
