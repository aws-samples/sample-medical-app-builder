import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AuthProviderBoundary, useAuth } from '../auth/AuthContext';
import type { AuthProvider, Session } from '../auth/types';
import { DispatcherPrimitiveExecutor } from '../primitives/data/dispatcherExecutor';
import { remoteAuthoringClient } from '../authoring/remoteClient';

/**
 * ID tokens expire (60 minutes on the hospital pool) while a drafting session easily lasts longer.
 * `getIdToken()` must hand out a fresh token — refreshed through the provider — instead of letting every
 * API call fail with 401 Unauthorized, and sign the person out only when even the refresh fails.
 */

const now = () => Math.floor(Date.now() / 1000);

function sessionWith(token: string, expiresAt: number): Session {
  return { idToken: token, accessToken: 'a', expiresAt, claims: { sub: 'u1', username: 'u1', groups: ['medapp-authors'] } };
}

function provider(sessions: (Session | null)[]): AuthProvider & { restores: number } {
  const p = {
    kind: 'mock' as const,
    restores: 0,
    restoreSession: async () => {
      p.restores += 1;
      return sessions.shift() ?? null;
    },
    signIn: async () => ({ status: 'signed_in' as const, session: sessions[0]! }),
    signOut: async () => {},
    forgotPassword: async () => ({}),
    confirmForgotPassword: async () => {},
  };
  return p;
}

let captured: (() => Promise<string | undefined>) | null = null;
let statusSeen = '';
function Probe() {
  const { getIdToken, status, session } = useAuth();
  captured = getIdToken;
  statusSeen = status;
  return <div data-testid="probe">{status}:{session?.idToken ?? '-'}</div>;
}

describe('ID token refresh', () => {
  test('an expiring token is refreshed through the provider and the new one is used by the API clients', async () => {
    // Restored at startup with 30 s left (inside the refresh margin); the provider then has a fresh hour-long session.
    const p = provider([sessionWith('old-token', now() + 30), sessionWith('new-token', now() + 3600)]);
    render(
      <AuthProviderBoundary provider={p}>
        <Probe />
      </AuthProviderBoundary>
    );
    await screen.findByText('signed_in:old-token');

    let token: string | undefined;
    await act(async () => {
      token = await captured!();
    });
    expect(token).toBe('new-token');
    expect(p.restores).toBe(2); // startup + one refresh
    await screen.findByText('signed_in:new-token'); // the session state follows, so claims and identity stay current

    // Not expiring: no further refresh, same token.
    await act(async () => {
      token = await captured!();
    });
    expect(token).toBe('new-token');
    expect(p.restores).toBe(2);

    // The clients built on the getter send the refreshed token.
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(String((init?.headers as Record<string, string>).authorization));
      return new Response(JSON.stringify({ drafts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await remoteAuthoringClient('https://api.test', captured!, fetchImpl).listDrafts();
    const executor = new DispatcherPrimitiveExecutor('https://api.test', async () => new Response(JSON.stringify({ output: [] }), { status: 200 }), captured!);
    expect(seen).toEqual(['Bearer new-token']);
    expect(executor.kind).toBe('dispatcher');
  });

  test('when the refresh fails too, the person is signed out rather than left with a dead token', async () => {
    const p = provider([sessionWith('old-token', now() + 10), null]);
    render(
      <AuthProviderBoundary provider={p}>
        <Probe />
      </AuthProviderBoundary>
    );
    await screen.findByText('signed_in:old-token');
    let token: string | undefined = 'x';
    await act(async () => {
      token = await captured!();
    });
    expect(token).toBeUndefined();
    await waitFor(() => expect(statusSeen).toBe('signed_out'));
  });
});
