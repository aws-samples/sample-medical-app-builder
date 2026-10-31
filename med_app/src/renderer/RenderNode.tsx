import { useEffect, useMemo, useRef } from 'react';
import { Skeleton } from '@mantine/core';
import type { LayoutNode } from '../manifest/schema';
import { UI_CATALOG } from '../primitives/catalog';
import { CatalogViolation } from '../primitives/CatalogViolation';
import { referencedBindings, resolveRecord, type Diagnostic, type ExpressionEnv } from './expressions';
import { useRenderContext } from './RenderContext';

const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

/**
 * Deterministic: manifest node → catalog component. There is no third path.
 * Unknown component names render a visible refusal instead of being guessed at.
 *
 * A node hidden from the active role is not resolved at all (its references may legitimately point
 * at data this role never loads). A node whose bindings are still on their way during the first load
 * renders a placeholder rather than the component with `undefined` props, and a `$ui` key no component
 * has written yet resolves silently (expressions.ts) — so a diagnostic about an unresolved reference
 * always means an authoring problem, never "not loaded yet" or "nothing selected yet".
 */
export function RenderNode({ node }: { node: LayoutNode }) {
  const ctx = useRenderContext();

  const roleGate = node.show_only_if_role_in;
  const visible = !roleGate || roleGate.includes(ctx.role);

  const entry = UI_CATALOG[node.component];

  const waitingFor = useMemo(() => [...referencedBindings(node.props)].filter((name) => ctx.pendingBindings.has(name)), [node.props, ctx.pendingBindings]);
  const pending = waitingFor.length > 0;

  const env = useMemo<ExpressionEnv>(
    () => ({
      bindings: ctx.bindings,
      context: ctx.context,
      metadata: ctx.manifest.metadata,
      auth: { role: ctx.role, effective: ctx.scope },
      ui: ctx.ui,
    }),
    [ctx.bindings, ctx.context, ctx.manifest.metadata, ctx.role, ctx.scope, ctx.ui]
  );

  const resolved = useMemo(() => {
    if (!visible || !entry || pending) return { props: {}, diagnostics: NO_DIAGNOSTICS };
    const diagnostics: Diagnostic[] = [];
    const props = resolveRecord(node.props, env, diagnostics);
    return { props, diagnostics };
  }, [visible, entry, pending, node.props, env]);

  // Each distinct problem is reported once per node, not once per re-render.
  const reported = useRef(new Set<string>());
  const { report } = ctx;
  useEffect(() => {
    for (const d of resolved.diagnostics) {
      if (reported.current.has(d.message)) continue;
      reported.current.add(d.message);
      report(d);
    }
  }, [resolved, report]);

  // A node that showed a placeholder fades its content up when the data arrives (once; static parts never animate).
  const waited = useRef(false);
  if (pending) waited.current = true;

  if (!visible) return null;
  if (!entry) {
    return <CatalogViolation kind="component" name={node.component} />;
  }
  if (pending) {
    return <Skeleton height={entry.kind === 'layout' ? 48 : 112} radius={12} data-testid="pending-node" data-waiting-for={waitingFor.join(' ')} aria-busy="true" />;
  }

  const Component = entry.component;
  const content = entry.wantsChildNodes ? (
    <Component {...resolved.props} childNodes={node.children ?? []} />
  ) : (
    <Component {...resolved.props}>{node.children?.map((child, i) => ctx.renderNode(child, i))}</Component>
  );
  return waited.current ? <div className="ds-reveal">{content}</div> : content;
}
