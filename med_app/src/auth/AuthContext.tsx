import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthProvider, NewPasswordChallenge, RecoveryCodeSent, Session } from './types';

type AuthStatus = 'restoring' | 'signed_out' | 'signed_in';

/** Something that yields the current ID token — synchronously or after a refresh. */
export type TokenGetter = () => Promise<string | undefined> | string | undefined;

/** Refresh when the token has less than this left; Cognito ID tokens live 60 minutes, the refresh token hours. */
const REFRESH_MARGIN_S = 120;

interface AuthContextValue {
  readonly status: AuthStatus;
  readonly session: Session | null;
  readonly providerKind: AuthProvider['kind'];
  readonly pendingChallenge: NewPasswordChallenge | null;
  signIn(username: string, password: string): Promise<void>;
  completeNewPassword(newPassword: string, attributes?: Readonly<Record<string, string>>): Promise<void>;
  signOut(): Promise<void>;
  /** Password recovery: a code to the account's email, then the code with the new password. The screen signs in afterwards. */
  forgotPassword(username: string): Promise<RecoveryCodeSent>;
  confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void>;
  /**
   * The ID token to send with an API call. Refreshes it through the provider when it is about to expire
   * (Cognito uses the refresh token), and signs the person out when even that fails — so a page left open
   * for hours keeps working instead of every call returning 401 Unauthorized.
   */
  getIdToken(): Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProviderBoundary({ provider, children }: { provider: AuthProvider; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [session, setSession] = useState<Session | null>(null);
  const [pendingChallenge, setPendingChallenge] = useState<NewPasswordChallenge | null>(null);

  useEffect(() => {
    let cancelled = false;
    provider
      .restoreSession()
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setStatus(s ? 'signed_in' : 'signed_out');
      })
      .catch(() => {
        if (!cancelled) setStatus('signed_out');
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const result = await provider.signIn(username, password);
      if (result.status === 'new_password_required') {
        setPendingChallenge(result.challenge);
        return;
      }
      setPendingChallenge(null);
      setSession(result.session);
      setStatus('signed_in');
    },
    [provider]
  );

  const completeNewPassword = useCallback(
    async (newPassword: string, attributes?: Readonly<Record<string, string>>) => {
      if (!pendingChallenge) throw new Error('No password challenge is pending.');
      const s = await pendingChallenge.complete(newPassword, attributes);
      setPendingChallenge(null);
      setSession(s);
      setStatus('signed_in');
    },
    [pendingChallenge]
  );

  const signOut = useCallback(async () => {
    await provider.signOut();
    setSession(null);
    setPendingChallenge(null);
    setStatus('signed_out');
  }, [provider]);

  const forgotPassword = useCallback((username: string) => provider.forgotPassword(username), [provider]);
  const confirmForgotPassword = useCallback((username: string, code: string, newPassword: string) => provider.confirmForgotPassword(username, code, newPassword), [provider]);

  // The getter reads the latest session without re-creating the API clients that hold it.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const refreshing = useRef<Promise<Session | null> | null>(null);

  const getIdToken = useCallback(async (): Promise<string | undefined> => {
    const current = sessionRef.current;
    if (!current) return undefined;
    const secondsLeft = current.expiresAt - Math.floor(Date.now() / 1000);
    if (secondsLeft > REFRESH_MARGIN_S) return current.idToken;
    // One refresh at a time, shared by concurrent callers.
    refreshing.current ??= provider.restoreSession().finally(() => {
      refreshing.current = null;
    });
    const fresh = await refreshing.current;
    if (fresh) {
      sessionRef.current = fresh;
      setSession(fresh);
      return fresh.idToken;
    }
    // The refresh token is gone too: there is no valid identity left to act with.
    setSession(null);
    setPendingChallenge(null);
    setStatus('signed_out');
    return undefined;
  }, [provider]);

  // Keep the session fresh while a page sits open, so what components hold (the token in an app's
  // identity, the claims) does not go stale between clicks.
  useEffect(() => {
    if (status !== 'signed_in') return;
    const timer = setInterval(() => void getIdToken(), 30_000);
    return () => clearInterval(timer);
  }, [status, getIdToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, providerKind: provider.kind, pendingChallenge, signIn, completeNewPassword, signOut, getIdToken, forgotPassword, confirmForgotPassword }),
    [status, session, provider.kind, pendingChallenge, signIn, completeNewPassword, signOut, getIdToken, forgotPassword, confirmForgotPassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProviderBoundary>.');
  return ctx;
}
