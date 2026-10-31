import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { AuthError, type AuthProvider, type IdentityClaims, type RecoveryCodeSent, type Session, type SignInResult } from './types';

export interface CognitoConfig {
  readonly userPoolId: string;
  readonly clientId: string;
}

function toClaims(session: CognitoUserSession): IdentityClaims {
  const payload = session.getIdToken().decodePayload() as Record<string, unknown>;
  const groups = Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : [];
  return {
    sub: String(payload['sub'] ?? ''),
    username: String(payload['cognito:username'] ?? payload['username'] ?? ''),
    email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
    name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
    givenName: typeof payload['given_name'] === 'string' ? payload['given_name'] : undefined,
    familyName: typeof payload['family_name'] === 'string' ? payload['family_name'] : undefined,
    groups,
  };
}

function toSession(session: CognitoUserSession): Session {
  return {
    idToken: session.getIdToken().getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    expiresAt: session.getIdToken().getExpiration(),
    claims: toClaims(session),
  };
}

/**
 * Sign-in against a Cognito user pool using SRP (the pool's default flow — no
 * USER_PASSWORD_AUTH toggle needed on the app client). Handles the
 * NEW_PASSWORD_REQUIRED challenge that admin-created users hit on first login.
 */
export function createCognitoAuthProvider(cfg: CognitoConfig): AuthProvider {
  const pool = new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.clientId });

  return {
    kind: 'cognito',

    restoreSession: () =>
      new Promise<Session | null>((resolve) => {
        const user = pool.getCurrentUser();
        if (!user) {
          resolve(null);
          return;
        }
        user.getSession((err: Error | null, session: CognitoUserSession | null) => {
          if (err || !session || !session.isValid()) {
            resolve(null);
            return;
          }
          resolve(toSession(session));
        });
      }),

    signIn: (username, password) =>
      new Promise<SignInResult>((resolve, reject) => {
        const user = new CognitoUser({ Username: username, Pool: pool });
        const details = new AuthenticationDetails({ Username: username, Password: password });
        user.authenticateUser(details, {
          onSuccess: (session) => resolve({ status: 'signed_in', session: toSession(session) }),
          onFailure: (err: { code?: string; message?: string }) =>
            reject(new AuthError(err.message ?? 'Sign-in failed.', err.code)),
          newPasswordRequired: (_userAttributes: Record<string, unknown>, requiredAttributes: string[] = []) => {
            // Only send what Cognito asks for. Echoing the existing attributes back (the pattern in
            // older examples) fails on email-as-username pools with "Cannot modify an already
            // provided email"; sending `{}` when nothing is required is the correct call.
            const required = requiredAttributes.map((a) => a.replace(/^userAttributes\./, ''));
            resolve({
              status: 'new_password_required',
              challenge: {
                username,
                requiredAttributes: required,
                complete: (newPassword, attributes = {}) =>
                  new Promise<Session>((res, rej) => {
                    const payload = Object.fromEntries(required.filter((a) => attributes[a] !== undefined).map((a) => [a, attributes[a] as string]));
                    user.completeNewPasswordChallenge(newPassword, payload, {
                      onSuccess: (session) => res(toSession(session)),
                      onFailure: (err: { code?: string; message?: string }) =>
                        rej(new AuthError(err.message ?? 'Could not set the new password.', err.code)),
                    });
                  }),
              },
            });
          },
        });
      }),

    signOut: () =>
      new Promise<void>((resolve) => {
        const user = pool.getCurrentUser();
        if (!user) {
          resolve();
          return;
        }
        user.signOut(() => resolve());
      }),

    // Recovery is the pool's own (`account_recovery: EMAIL_ONLY`): Cognito emails a code to the verified address.
    // `inputVerificationCode` is what the library calls once the code is on its way; `onSuccess` would only fire
    // without that callback. A user who never completed the first sign-in (FORCE_CHANGE_PASSWORD) cannot recover
    // this way — Cognito answers "User password cannot be reset in the current state" — an administrator resets them.
    forgotPassword: (username) =>
      new Promise<RecoveryCodeSent>((resolve, reject) => {
        const user = new CognitoUser({ Username: username, Pool: pool });
        user.forgotPassword({
          onSuccess: (data: { CodeDeliveryDetails?: { Destination?: string } } | undefined) => resolve({ destination: data?.CodeDeliveryDetails?.Destination }),
          onFailure: (err: { code?: string; message?: string }) => reject(recoveryError(err, 'Could not start the password recovery.')),
          inputVerificationCode: (data: { CodeDeliveryDetails?: { Destination?: string } } | undefined) => resolve({ destination: data?.CodeDeliveryDetails?.Destination }),
        });
      }),

    confirmForgotPassword: (username, code, newPassword) =>
      new Promise<void>((resolve, reject) => {
        const user = new CognitoUser({ Username: username, Pool: pool });
        user.confirmPassword(code.trim(), newPassword, {
          onSuccess: () => resolve(),
          onFailure: (err: { code?: string; message?: string }) => reject(recoveryError(err, 'Could not set the new password.')),
        });
      }),
  };
}

/** Cognito's recovery errors in words a clinician can act on; the original code is kept for the inspector. */
export function recoveryError(err: { code?: string; message?: string }, fallback: string): AuthError {
  const message = err.message ?? fallback;
  switch (err.code) {
    case 'CodeMismatchException':
      return new AuthError('That code is not right. Check the email and try again, or request a new code.', err.code);
    case 'ExpiredCodeException':
      return new AuthError('That code has expired. Request a new one.', err.code);
    case 'LimitExceededException':
      return new AuthError('Too many attempts for now. Wait a few minutes before trying again.', err.code);
    case 'InvalidPasswordException':
      return new AuthError('The new password does not meet the rules: at least 12 characters with upper and lower case, a digit and a symbol.', err.code);
    case 'InvalidParameterException':
      if (/verified email|registered\/verified/i.test(message)) return new AuthError('This account has no verified email address, so a code cannot be sent. Ask your administrator to reset the password.', err.code);
      return new AuthError(message, err.code);
    case 'NotAuthorizedException':
      if (/current state/i.test(message)) return new AuthError('This account has not been activated yet: sign in once with the temporary password from the invitation, or ask your administrator for a new one.', err.code);
      return new AuthError(message, err.code);
    case 'UserNotFoundException':
      // The pool hides whether an account exists; when it does not, say the same as for a sent code.
      return new AuthError('If an account exists for this address, a code has been sent to it.', err.code);
    default:
      return new AuthError(message, err.code);
  }
}
