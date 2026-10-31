import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthoringApiError, type AuthoringClient, type DraftOp, type DraftView, type SpecIssue } from '../../authoring/types';

/**
 * One draft, live: loads it, polls while the agent is working on a turn, and funnels every change
 * (a chat message, a structured edit from the panel) through the API so the page never holds a
 * version of the draft the server does not have.
 */

export interface DraftController {
  readonly view: DraftView | null;
  readonly loading: boolean;
  /** A failure loading or refreshing — the page shows it and offers to retry. */
  readonly error: string | null;
  /** The agent is working on a message; edits and further messages wait. */
  readonly busy: boolean;
  /** The last rejected edit, until the next successful one. */
  readonly rejected: readonly SpecIssue[] | null;
  /** In-flight structured edit. */
  readonly saving: boolean;
  send(message: string): Promise<void>;
  /** Apply structured edits; resolves false (and sets `rejected`) when the API refused them. */
  patch(ops: readonly DraftOp[]): Promise<boolean>;
  refresh(): Promise<void>;
  /** Replace the view after an operation elsewhere changed the draft (e.g. saving it to the registry). */
  replace(view: DraftView): void;
}

function isBusy(view: DraftView | null): boolean {
  return view?.turn?.status === 'queued' || view?.turn?.status === 'running';
}

export function useDraft(client: AuthoringClient, sessionId: string): DraftController {
  const [view, setView] = useState<DraftView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<readonly SpecIssue[] | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await client.getDraft(sessionId);
      if (!alive.current) return;
      // While the agent works the page polls every couple of seconds; a poll that brings the same draft back must not
      // re-render everything under it (the preview's app would re-run its data plan). Same content, same object.
      setView((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [client, sessionId]);

  // Initial load (and when the draft id changes).
  useEffect(() => {
    setLoading(true);
    setView(null);
    setRejected(null);
    void refresh();
  }, [refresh]);

  // Poll while a turn is in flight.
  const busy = isBusy(view);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), client.pollIntervalMs);
    return () => clearInterval(timer);
  }, [busy, client.pollIntervalMs, refresh]);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text) return;
      try {
        const turn = await client.sendTurn(sessionId, text);
        if (!alive.current) return;
        setView((prev) => (prev ? { ...prev, turn } : prev));
        setError(null);
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
        if (err instanceof AuthoringApiError && err.status === 409) void refresh();
      }
    },
    [client, sessionId, refresh]
  );

  const patch = useCallback(
    async (ops: readonly DraftOp[]) => {
      if (!ops.length) return true;
      setSaving(true);
      try {
        const result = await client.patchDraft(sessionId, ops);
        if (!alive.current) return true;
        setView((prev) => (prev ? { ...prev, spec: result.spec, open: result.open, title: titleOf(result.spec) ?? prev.title } : prev));
        setRejected(null);
        setError(null);
        return true;
      } catch (err) {
        if (!alive.current) return false;
        if (err instanceof AuthoringApiError && err.status === 422) {
          setRejected(err.rejected.length ? err.rejected : [{ path: '(root)', message: err.message }]);
        } else {
          setError(err instanceof Error ? err.message : String(err));
          if (err instanceof AuthoringApiError && err.status === 409) void refresh();
        }
        return false;
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [client, sessionId, refresh]
  );

  const replace = useCallback((next: DraftView) => setView(next), []);

  return { view, loading, error, busy, rejected, saving, send, patch, refresh, replace };
}

function titleOf(spec: Record<string, unknown>): string | undefined {
  const app = spec.app as { name?: string } | undefined;
  return app?.name || undefined;
}
