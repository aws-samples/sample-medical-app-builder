import { describe, expect, test } from 'vitest';
import { remoteAuthoringClient } from '../authoring/remoteClient';
import { AuthoringApiError } from '../authoring/types';

/** The remote client against a recording fetch: routes, methods, bodies and status handling as the deployed API expects them. */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(responses: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.replace('https://api.test', '')}`;
    const res = responses[key] ?? { status: 404, body: { message: `no route ${key}` } };
    if (res.status === 204) return new Response(null, { status: 204 }); // a 204 has no body, as the real API's DELETE
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('remote authoring client', () => {
  test('maps the drafting, compile and registry-write routes and carries the ID token', async () => {
    const { calls, fetchImpl } = fakeFetch({
      'POST /drafts': { status: 201, body: { session_id: 's1', turn: { id: 't1', status: 'queued', message: 'hi', progress: [] } } },
      'GET /drafts': { status: 200, body: { drafts: [{ session_id: 's1', title: 'X' }] } },
      'GET /drafts/s1': { status: 200, body: { session_id: 's1', spec: {}, open: [], transcript: [], turn: null } },
      'PATCH /drafts/s1': { status: 422, body: { rejected: [{ path: 'knobs.window', message: 'bad' }] } },
      'POST /drafts/s1/turns': { status: 202, body: { turn: { id: 't2', status: 'queued', message: 'more', progress: [] } } },
      'DELETE /drafts/s1': { status: 204, body: '' },
      'POST /manifest/compile': { status: 422, body: { ok: false, issues: [{ path: 'roles', message: 'is required' }] } },
      'GET /groups': { status: 200, body: { groups: [{ name: 'kardiologie', description: '' }] } },
      'POST /registry/apps': { status: 409, body: { message: 'An app with id app_x already exists; iterate on it or choose another id.', app_id: 'app_x' } },
      'POST /registry/apps/app_x/versions': { status: 201, body: { app_id: 'app_x', version: '0.2.0', parent_version: '0.1.0', state: 'draft' } },
      'POST /registry/apps/app_x/versions/0.2.0/transitions': { status: 200, body: { app_id: 'app_x', version: '0.2.0', state: 'in_review' } },
    });
    const client = remoteAuthoringClient('https://api.test/', () => 'tok', fetchImpl);

    expect((await client.createDraft({ message: 'hi', spec: { archetype: 'APP-02' }, iterates: { app_id: 'app_x', version: '0.1.0' } })).session_id).toBe('s1');
    expect(calls[0]).toMatchObject({ url: 'https://api.test/drafts', method: 'POST', body: { message: 'hi', spec: { archetype: 'APP-02' }, iterates: { app_id: 'app_x', version: '0.1.0' } } });
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');

    expect(await client.listDrafts()).toEqual([{ session_id: 's1', title: 'X' }]);
    expect((await client.getDraft('s1')).session_id).toBe('s1');

    const rejected = await client.patchDraft('s1', [{ op: 'set_knobs', args: { patch: { window: 'x' } } }]).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(AuthoringApiError);
    expect((rejected as AuthoringApiError).status).toBe(422);
    expect((rejected as AuthoringApiError).rejected).toEqual([{ path: 'knobs.window', message: 'bad' }]);
    expect(calls.at(-1)?.body).toEqual({ ops: [{ op: 'set_knobs', args: { patch: { window: 'x' } } }] });

    expect((await client.sendTurn('s1', 'more')).id).toBe('t2');
    await client.deleteDraft('s1');
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.test/drafts/s1', method: 'DELETE' });
    expect(await client.compile({ archetype: 'APP-02' })).toEqual({ ok: false, issues: [{ path: 'roles', message: 'is required' }] });
    expect(await client.listGroups()).toEqual([{ name: 'kardiologie', description: '' }]);

    const conflict = await client.saveApp('s1').catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(AuthoringApiError);
    expect((conflict as AuthoringApiError).status).toBe(409);
    expect((conflict as AuthoringApiError).body.app_id).toBe('app_x');
    expect(calls.at(-1)?.body).toEqual({ session_id: 's1' });

    expect(await client.saveVersion('app_x', 's1')).toMatchObject({ version: '0.2.0', parent_version: '0.1.0' });
    expect((await client.transition('app_x', '0.2.0', 'in_review', 'ready')).state).toBe('in_review');
    expect(calls.at(-1)?.body).toEqual({ to: 'in_review', notes: 'ready' });

    const signedOut = remoteAuthoringClient('https://api.test', () => undefined, fetchImpl);
    await expect(signedOut.listDrafts()).rejects.toMatchObject({ status: 401 });
  });
});
