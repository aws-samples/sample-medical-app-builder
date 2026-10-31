import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { servedBuild, thisBuild, UpdateNotice } from '../panel/UpdateNotice';
import { theme } from '../theme';

/**
 * A tab open across a deploy: the page asks which build is being served when it comes back into view and, when it is
 * not its own, offers the reload — the registry it polls may carry manifests its older schema refuses.
 */

const json = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 404, headers: { 'content-type': 'application/json' } });

describe('the update notice', () => {
  it('knows its own build and reads the served one; an index.html answer (dev server, SPA fallback) is not a build', async () => {
    expect(thisBuild()).toBeTruthy(); // vite.config.ts defines __BUILD_ID__ for the tests as for the bundle
    expect(await servedBuild(async () => json({ build: 'b-2' }))).toBe('b-2');
    expect(await servedBuild(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }))).toBeUndefined();
    expect(await servedBuild(async () => json({ nope: 1 }))).toBeUndefined();
    expect(await servedBuild(async () => json({}, false))).toBeUndefined();
    expect(await servedBuild(async () => Promise.reject(new Error('offline')))).toBeUndefined();
  });

  it('stays silent while the served build is this one, appears when it is another, and reloads on request', async () => {
    let served = thisBuild()!;
    const fetchImpl = vi.fn(async () => json({ build: served }));
    const onReload = vi.fn();
    render(
      <MantineProvider theme={theme}>
        <UpdateNotice fetchImpl={fetchImpl} intervalMs={60_000} onReload={onReload} />
      </MantineProvider>
    );
    expect(screen.queryByTestId('update-notice')).toBeNull();
    await act(async () => {
      fireEvent(window, new Event('focus'));
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('update-notice')).toBeNull(); // same build: nothing to say

    served = 'a-newer-build';
    await act(async () => {
      fireEvent(window, new Event('focus'));
    });
    const notice = await screen.findByTestId('update-notice');
    expect(notice).toHaveTextContent('A newer version of the panel has been deployed');
    fireEvent.click(screen.getByTestId('update-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
