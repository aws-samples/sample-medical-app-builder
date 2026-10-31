import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegistryEntry, RegistrySource } from './registry';

export type RegistryState =
  | { readonly status: 'loading'; readonly entries: RegistryEntry[] }
  | { readonly status: 'ready'; readonly entries: RegistryEntry[] }
  | { readonly status: 'error'; readonly entries: RegistryEntry[]; readonly error: string };

/**
 * Loads the registry from whichever source is configured. `reload()` re-fetches (after a save, a
 * publish) and resolves once the fresh list is in state — so a caller can wait for it before offering
 * a link to the app it just created. While a reload runs, the previous entries stay on screen; a
 * superseded load (a newer one started, or the source changed) never writes its result.
 */
export function useRegistry(source: RegistrySource): RegistryState & { reload(): Promise<void> } {
  const [state, setState] = useState<RegistryState>({ status: 'loading', entries: [] });
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const gen = ++generation.current;
    setState((prev) => ({ status: 'loading', entries: prev.entries }));
    try {
      const entries = await source.load();
      if (gen === generation.current) setState({ status: 'ready', entries });
    } catch (err: unknown) {
      if (gen === generation.current) setState((prev) => ({ status: 'error', entries: prev.entries, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [source]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1; // whatever was in flight is stale now
    };
  }, [load]);

  return { ...state, reload: load };
}
