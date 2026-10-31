import { describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { theme } from '../theme';
import { ActionForm, useActionForm } from '../primitives/ui/ActionForm';
import { RenderContext, type ActionStatus, type RenderContextValue } from '../renderer/RenderContext';

/**
 * The action lifecycle as ManifestApp drives it, without a manifest, executor or Medplum: `runAction`
 * goes running → success or error (as scripted), `resetAction` goes back to idle. What is under test
 * is the shell every action-driven form composes.
 */
function Harness({ outcome, children }: { outcome: () => ActionStatus; children: ReactNode }) {
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>({});
  const value = {
    actions: { save: { id: 'save', label: 'Save', primitive: 'p_write', on_success: 'reload' } },
    actionStatus,
    runAction: async (id: string) => {
      setActionStatus((s) => ({ ...s, [id]: { status: 'running' } }));
      await new Promise((r) => setTimeout(r, 5));
      setActionStatus((s) => ({ ...s, [id]: outcome() }));
    },
    resetAction: (id: string) => setActionStatus((s) => (s[id]?.status === 'running' ? s : { ...s, [id]: { status: 'idle' } })),
  } as unknown as RenderContextValue;
  return (
    <MantineProvider theme={theme}>
      <RenderContext.Provider value={value}>{children}</RenderContext.Provider>
    </MantineProvider>
  );
}

/** A minimal "form": shows its mount key so a remount is observable, and submits a fixed payload. */
function InnerForm({ formKey, running, submit }: { formKey: number; running: boolean; submit: (p: Record<string, unknown>) => Promise<void> }) {
  return (
    <div>
      <span data-testid="mount">mount {formKey}</span>
      <button type="button" disabled={running} onClick={() => void submit({ payload: { answer: 42 } })}>
        {running ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

describe('ActionForm — the shared lifecycle of action-driven forms', () => {
  it('idle → saving → saved → "record another" → idle with a remounted, empty form', async () => {
    render(
      <Harness outcome={() => ({ status: 'success', message: 'On the record.', output: {} })}>
        <ActionForm action="save" title="Test form" another_label="Record another thing">
          {(f) => <InnerForm {...f} />}
        </ActionForm>
      </Harness>
    );
    expect(screen.getByTestId('mount')).toHaveTextContent('mount 0');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();

    const saved = await screen.findByTestId('action-saved');
    expect(saved).toHaveTextContent('Saved to the patient record');
    expect(saved).toHaveTextContent('On the record.');
    expect(screen.queryByTestId('mount')).toBeNull(); // the form is replaced by the confirmation

    fireEvent.click(screen.getByRole('button', { name: 'Record another thing' }));
    expect(screen.queryByTestId('action-saved')).toBeNull();
    expect(screen.getByTestId('mount')).toHaveTextContent('mount 1'); // a fresh instance, not the old one
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('error: message and problems are shown and the form stays with its state', async () => {
    render(
      <Harness outcome={() => ({ status: 'error', message: 'The record was not saved.', problems: ['"home_bp" is required', '"adherence" is required'] })}>
        <ActionForm action="save" title="Test form">
          {(f) => <InnerForm {...f} />}
        </ActionForm>
      </Harness>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const error = await screen.findByTestId('action-error');
    expect(error).toHaveTextContent('The record was not saved.');
    expect(error).toHaveTextContent('"home_bp" is required');
    expect(error).toHaveTextContent('"adherence" is required');
    expect(screen.getByTestId('mount')).toHaveTextContent('mount 0'); // same instance: the answers are kept for correction
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('an undeclared action shows a refusal and renders no form', () => {
    const inner = vi.fn(() => <span>form</span>);
    render(
      <Harness outcome={() => ({ status: 'idle' })}>
        <ActionForm action="nope" title="Test form">
          {inner}
        </ActionForm>
      </Harness>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('action "nope" is not declared by the app');
    expect(inner).not.toHaveBeenCalled();
  });

  it('useActionForm: reset is inert while a save is in flight, and takes effect afterwards', async () => {
    function Exposed() {
      const f = useActionForm('save');
      return (
        <>
          <span data-testid="status">{f.status.status}</span>
          <span data-testid="key">{f.formKey}</span>
          <button type="button" onClick={() => void f.submit({ payload: {} })}>
            go
          </button>
          <button type="button" onClick={f.reset}>
            reset
          </button>
        </>
      );
    }
    render(
      <Harness outcome={() => ({ status: 'success', message: 'ok', output: {} })}>
        <Exposed />
      </Harness>
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('running'));
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.getByTestId('status')).toHaveTextContent('running'); // not interrupted
    expect(screen.getByTestId('key')).toHaveTextContent('0'); // not remounted either

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('success'));
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('key')).toHaveTextContent('1');
  });
});
