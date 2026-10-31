import { AuditApiError, type AuditClient, type AuditPage, type AuditQuery } from './types';

/** The deployed audit API (`GET /audit`) with the caller's Cognito ID token; administrators only, decided server-side. */
export function remoteAuditClient(
  apiBaseUrl: string,
  getIdToken: () => Promise<string | undefined> | string | undefined,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
): AuditClient {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return {
    kind: 'remote',
    async query(q: AuditQuery): Promise<AuditPage> {
      const token = await getIdToken();
      if (!token) throw new AuditApiError(401, 'Not signed in.');
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(q)) {
        if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
      }
      const res = await fetchImpl(`${base}/audit${params.size ? `?${params}` : ''}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
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
      if (!res.ok) throw new AuditApiError(res.status, typeof parsed.message === 'string' ? parsed.message : `The audit API returned HTTP ${res.status}.`);
      return parsed as unknown as AuditPage;
    },
  };
}
