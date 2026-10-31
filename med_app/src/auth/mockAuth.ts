import { PLATFORM_GROUPS } from '../manifest/roles';
import { AuthError, type AuthProvider, type Session } from './types';

const STORAGE_KEY = 'med_app.mock_session';
const PLATFORM_GROUP_NAMES: readonly string[] = Object.values(PLATFORM_GROUPS);

/**
 * DEV ONLY. Accepts any non-empty credentials so the manifest renderer can be exercised
 * before the hospital's Cognito user pool exists. Never enable outside local development.
 *
 * Convention: a username of the form `name+viewer,reviewer` grants those Cognito-style
 * groups for every app, so role resolution can be exercised without a real pool. A platform
 * group named as is — `name+medapp-admins` — is held as that group, so the staff and
 * administrator views can be exercised too.
 */
export function createMockAuthProvider(): AuthProvider {
  const build = (username: string): Session => {
    const [name = username, groupSpec = ''] = username.split('+');
    const roleIds = groupSpec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      idToken: 'mock.id.token',
      accessToken: 'mock.access.token',
      expiresAt: Math.floor(Date.now() / 1000) + 8 * 3600,
      claims: {
        sub: `mock-${name.toLowerCase()}`,
        username: name,
        name,
        email: `${name.toLowerCase()}@example.invalid`,
        // Wildcard groups: `app-*-{role}` is expanded by the role resolver for any app; platform groups pass through.
        groups: roleIds.map((r) => (PLATFORM_GROUP_NAMES.includes(r) ? r : `app-*-${r}`)),
      },
    };
  };

  return {
    kind: 'mock',
    restoreSession: async () => {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    },
    signIn: async (username, password) => {
      if (!username.trim() || !password) {
        throw new AuthError('Enter a username and a password.', 'MissingCredentials');
      }
      const session = build(username.trim());
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      return { status: 'signed_in', session };
    },
    signOut: async () => {
      sessionStorage.removeItem(STORAGE_KEY);
    },
    // Recovery in mock mode exercises the screen, nothing else: the "code" is any six digits, the new password is not kept.
    forgotPassword: async (username) => {
      if (!username.trim()) throw new AuthError('Enter the email address of the account.', 'MissingUsername');
      const [name = username] = username.trim().split('+');
      return { destination: `${name.slice(0, 1).toLowerCase()}***@example.invalid` };
    },
    confirmForgotPassword: async (_username, code, newPassword) => {
      if (!/^\d{6}$/.test(code.trim())) throw new AuthError('That code is not right. In mock mode any six digits will do.', 'CodeMismatchException');
      if (newPassword.length < 12) throw new AuthError('The new password does not meet the rules: at least 12 characters with upper and lower case, a digit and a symbol.', 'InvalidPasswordException');
    },
  };
}
