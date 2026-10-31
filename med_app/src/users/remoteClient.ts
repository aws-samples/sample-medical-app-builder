import { UsersApiError, type GroupInfo, type ManagedUser, type UserListing, type UsersClient } from './types';

/**
 * The deployed user administration API (ApiStack `/users` routes) with the caller's Cognito ID token. Every
 * rule — who may call, the lock-out guards, which groups exist — lives server-side; this maps HTTP to outcomes.
 */
export function remoteUsersClient(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): UsersClient {
  const base = apiBaseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getIdToken();
    if (!token) throw new UsersApiError(401, 'Not signed in.');
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
    }
    if (!res.ok) throw new UsersApiError(res.status, typeof parsed.message === 'string' ? parsed.message : `The user administration API returned HTTP ${res.status}.`);
    return parsed as T;
  }

  return {
    kind: 'remote',
    list: (search) => call<UserListing>('GET', `/users${search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`),
    groups: async () => (await call<{ groups: GroupInfo[] }>('GET', '/users/groups')).groups,
    register: (input) => call<ManagedUser>('POST', '/users', input),
    update: (username, patch) => call<ManagedUser>('PATCH', `/users/${encodeURIComponent(username)}`, patch),
    resendInvitation: (username) => call<ManagedUser>('POST', `/users/${encodeURIComponent(username)}/invitation`),
  };
}
