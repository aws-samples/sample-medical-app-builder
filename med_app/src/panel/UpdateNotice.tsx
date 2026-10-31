import { useEffect, useState } from 'react';
import { Button, Group, Paper, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { tokens } from '../theme';

/**
 * A panel left open across a deploy keeps running the bundle it loaded while it polls a registry that moves on —
 * and a manifest written by a newer platform can carry keys the older bundle's schema refuses ("Unrecognized key:
 * artifacts", seen by a colleague on 2026-10-12). So the page asks, when it comes back into view and every so
 * often, which build is being served (`/version.json`, written at build time next to the bundle) and, when it is
 * not this one, offers the reload.
 */

const CHECK_EVERY_MS = 10 * 60 * 1000;

/** The build being served, or undefined when it cannot be told (no file — the dev server without the plugin —, offline, odd answer). */
export async function servedBuild(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<string | undefined> {
  try {
    const res = await fetchImpl('/version.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    const body: unknown = await res.json();
    const build = typeof body === 'object' && body !== null ? (body as { build?: unknown }).build : undefined;
    return typeof build === 'string' && build ? build : undefined;
  } catch {
    return undefined;
  }
}

/** This bundle's build id — `__BUILD_ID__` from vite.config.ts; undefined where the define did not run. */
export function thisBuild(): string | undefined {
  return typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : undefined;
}

export function useNewerBuild(fetchImpl?: typeof fetch, intervalMs = CHECK_EVERY_MS): boolean {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const mine = thisBuild();
    if (!mine) return;
    let cancelled = false;
    const check = async () => {
      const served = await servedBuild(fetchImpl);
      if (!cancelled && served && served !== mine) setNewer(true);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const timer = setInterval(() => void check(), intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [fetchImpl, intervalMs]);
  return newer;
}

export function UpdateNotice({ fetchImpl, intervalMs, onReload = () => window.location.reload() }: { fetchImpl?: typeof fetch; intervalMs?: number; onReload?: () => void }) {
  const newer = useNewerBuild(fetchImpl, intervalMs);
  if (!newer) return null;
  return (
    <Paper
      role="status"
      shadow="md"
      radius="md"
      px="md"
      py="xs"
      style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100vw - 32px)', zIndex: 30, background: tokens.ink, color: '#fff', border: `1px solid ${tokens.ink}` }}
      data-testid="update-notice"
    >
      <Group gap="md" wrap="nowrap">
        <Text size="sm" c="#fff">
          A newer version of the panel has been deployed. Reload to pick it up — newer apps may not show until you do.
        </Text>
        <Button size="compact-sm" variant="white" color="dark" leftSection={<IconRefresh size={14} />} onClick={onReload} style={{ flex: 'none' }} data-testid="update-reload">
          Reload
        </Button>
      </Group>
    </Paper>
  );
}
