import { createContext, useContext } from 'react';
import type { ActionDecl, AppManifest, LayoutNode } from '../manifest/schema';
import type { EffectiveScope } from '../manifest/roles';
import type { Diagnostic } from './expressions';
import type { RuntimeConfig } from '../config/env';

export type ActionStatus =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'success'; readonly message: string; readonly output: unknown }
  | { readonly status: 'error'; readonly message: string; readonly problems?: readonly string[] };

export interface RenderContextValue {
  readonly manifest: AppManifest;
  readonly role: string;
  readonly scope: EffectiveScope;
  readonly context: Readonly<Record<string, unknown>>;
  readonly bindings: Readonly<Record<string, unknown>>;
  /**
   * Output bindings of the data plan that have not arrived yet during the first load. A node that
   * references one renders a placeholder instead of running with `undefined`; the set is empty once
   * the plan completes and stays empty during a reload (the previous data remains on screen).
   */
  readonly pendingBindings: ReadonlySet<string>;
  readonly ui: Readonly<Record<string, unknown>>;
  readonly config: RuntimeConfig;
  /**
   * Who is signed in, from the verified session: the token a component may hand to another platform site the
   * user is entitled to (the imaging viewer), never something a manifest can read or a primitive config can carry.
   */
  readonly identity: { readonly sub: string; readonly idToken: string; readonly displayName?: string };
  /** Who made this version ("By: …"), set by the runtime shell from the registry — the page shell shows it under the description. */
  readonly byline?: string;
  setUiState(key: string, value: unknown): void;
  report(diagnostic: Diagnostic): void;
  renderNode(node: LayoutNode, key?: string | number): React.ReactNode;
  /** Actions declared by the manifest, by id. */
  readonly actions: Readonly<Record<string, ActionDecl>>;
  readonly actionStatus: Readonly<Record<string, ActionStatus>>;
  /**
   * Run a write action. `uiOverrides` are merged into `$ui` for this run only, so a form can hand
   * over the payload it just produced without a state round-trip.
   */
  runAction(actionId: string, uiOverrides?: Readonly<Record<string, unknown>>): Promise<void>;
  /** Put an action back to `idle` (e.g. "record another") — clears its success or error state; never interrupts a run. */
  resetAction(actionId: string): void;
}

export const RenderContext = createContext<RenderContextValue | null>(null);

export function useRenderContext(): RenderContextValue {
  const ctx = useContext(RenderContext);
  if (!ctx) throw new Error('Catalog components must be rendered inside <ManifestApp>.');
  return ctx;
}
