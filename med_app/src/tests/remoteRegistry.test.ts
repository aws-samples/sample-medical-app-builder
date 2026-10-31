import { describe, expect, it } from 'vitest';
import { remoteRegistrySource, RegistryApiError } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';

const published = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_patient_summary');
if (!published?.ok) throw new Error('example manifest missing');

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('remote registry source', () => {
  it('sends the bearer token and turns the API response into validated registry entries', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const apiBody = {
      apps: [
        { app_id: 'app_patient_summary', version: '0.1.0', state: 'published', roles: ['clinician'], manifest: published.manifest },
        { app_id: 'app_broken', version: '0.0.1', state: 'draft', roles: [], manifest: { apiVersion: 'medapp.eu/v1', kind: 'AppManifest', metadata: { name: 'Broken' } } },
      ],
    };
    const source = remoteRegistrySource('https://api.example.test', () => 'id-token-123', fakeFetch(200, apiBody, seen));
    const entries = await source.load();

    expect(seen.url).toBe('https://api.example.test/registry/apps');
    expect(seen.headers?.authorization).toBe('Bearer id-token-123');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ ok: true, file: 'app_patient_summary@0.1.0' });
    expect(entries[1]).toMatchObject({ ok: false, file: 'app_broken@0.0.1', name: 'Broken' });
    if (entries[1] && !entries[1].ok) expect(entries[1].issues.length).toBeGreaterThan(0);
  });

  it('fails loudly on HTTP errors and when not signed in', async () => {
    await expect(remoteRegistrySource('https://api.example.test', () => 'tok', fakeFetch(403, { message: 'nope' })).load()).rejects.toBeInstanceOf(RegistryApiError);
    await expect(remoteRegistrySource('https://api.example.test', () => undefined, fakeFetch(200, { apps: [] })).load()).rejects.toMatchObject({ status: 401 });
  });
});
