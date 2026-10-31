/** Identity claims the runtime relies on. Derived from the Cognito ID token. */
export interface IdentityClaims {
  readonly sub: string;
  /** Cognito username. On email-as-username pools this is an opaque id — never show it. */
  readonly username: string;
  readonly email?: string;
  readonly name?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  /** Cognito groups. Manifest roles are granted through `app-{app_id}-{role}` groups. */
  readonly groups: readonly string[];
}

/** What to call the signed-in person in the UI: full name if known, else email, else the username. */
export function displayNameOf(claims: IdentityClaims): string {
  const full = [claims.givenName, claims.familyName].filter(Boolean).join(' ').trim();
  return claims.name || full || claims.email || claims.username;
}

export interface Session {
  readonly idToken: string;
  readonly accessToken: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
  readonly claims: IdentityClaims;
}

export interface NewPasswordChallenge {
  readonly username: string;
  /**
   * Attributes Cognito requires and the user has not provided yet (e.g. `given_name`).
   * Usually empty for admin-created users; the screen collects them when present.
   */
  readonly requiredAttributes: readonly string[];
  complete(newPassword: string, attributes?: Readonly<Record<string, string>>): Promise<Session>;
}

export type SignInResult =
  | { readonly status: 'signed_in'; readonly session: Session }
  | { readonly status: 'new_password_required'; readonly challenge: NewPasswordChallenge };

/** Where the recovery code went, as the identity provider describes it (`b***@klinikum-musterstadt.example`). */
export interface RecoveryCodeSent {
  readonly destination?: string;
}

export interface AuthProvider {
  readonly kind: 'cognito' | 'mock';
  restoreSession(): Promise<Session | null>;
  signIn(username: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** Password recovery, step one: the provider emails a code to the account's verified address. */
  forgotPassword(username: string): Promise<RecoveryCodeSent>;
  /** Step two: the code and the new password. Resolves once the password is set; the caller then signs in. */
  confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string = 'AuthError'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
