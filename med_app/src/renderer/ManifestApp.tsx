import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Text } from '@mantine/core';
import type { AppManifest, LayoutNode } from '../manifest/schema';
import { isWriteKind } from '../manifest/schema';
import { resolveEffectiveScope } from '../manifest/roles';
import type { RuntimeConfig } from '../config/env';
import { CatalogViolation } from '../primitives/CatalogViolation';
import { isDataPrimitiveKind } from '../primitives/data/dataCatalog';
import type { AuditRecord, PrimitiveExecutor } from '../primitives/data/types';
import { DispatcherRequestError, PrimitiveConfigError, ScopeViolationError, UnknownPrimitiveError, WriteRejectedError } from '../primitives/data/types';
import { resolveRecord, type Diagnostic, type ExpressionEnv } from './expressions';
import { affectedBindings, waves } from './plan';
import { RenderContext, type ActionStatus, type RenderContextValue } from './RenderContext';
import { RenderNode } from './RenderNode';

export interface ManifestAppProps {
  readonly manifest: AppManifest;
  readonly role: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly executor: PrimitiveExecutor;
  readonly config: RuntimeConfig;
  readonly identity: { readonly sub: string; readonly idToken: string; readonly displayName?: string };
  /** Who made this version, for the page shell's "By: …" line; from the registry, never from the manifest. */
  readonly byline?: string;
  readonly onAudit?: (record: AuditRecord) => void;
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Confirmation hook for actions that declare `confirm`; defaults to window.confirm. */
  readonly confirm?: (message: string) => boolean;
}

type Phase =
  | { readonly status: 'running'; readonly step: number; readonly total: number }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly kind: 'scope' | 'data_primitive' | 'config' | 'runtime'; readonly name: string; readonly detail: string };

/** Fill declared defaults; report which required inputs are missing. */
export function prepareContext(manifest: AppManifest, provided: Readonly<Record<string, unknown>>): { context: Record<string, unknown>; missing: string[] } {
  const context: Record<string, unknown> = { ...provided };
  const missing: string[] = [];
  for (const input of manifest.context_inputs) {
    if (context[input.name] === undefined || context[input.name] === '') {
      if (input.default !== undefined) context[input.name] = input.default;
      else if (input.required) missing.push(input.name);
    }
  }
  return { context, missing };
}

export function ManifestApp(props: ManifestAppProps) {
  const { manifest, role, executor, config, identity, byline, onAudit, onDiagnostic } = props;
  const scope = useMemo(() => resolveEffectiveScope(manifest, role), [manifest, role]);
  // The launch context by content, not by object: a parent that re-renders with an equal `{ patient_id }` (the drafting
  // page while it polls, a shell that refreshed its session) must not re-run the data plan — that reset the bindings and
  // remounted every data-bound component, and a half-filled form lost its answers.
  const contextKey = JSON.stringify(props.context);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prepared = useMemo(() => prepareContext(manifest, props.context), [manifest, contextKey]);

  const [bindings, setBindings] = useState<Record<string, unknown>>({});
  // Everything the data plan will produce is pending until it arrives, so the very first paint shows
  // placeholders rather than components fed `undefined`.
  const [pendingBindings, setPendingBindings] = useState<ReadonlySet<string>>(() => new Set(manifest.primitives.filter((p) => !isWriteKind(p.kind)).map((p) => p.output_binding)));
  const [ui, setUi] = useState<Record<string, unknown>>({});
  const [phase, setPhase] = useState<Phase>({ status: 'running', step: 0, total: manifest.primitives.length });
  // A reload after a write: `only` names the bindings the write can have changed (plan.ts); absent = every binding.
  const [reload, setReload] = useState<{ tick: number; only?: ReadonlySet<string> }>({ tick: 0 });
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>({});

  // Live copies for runAction, which resolves its payload at click time.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const uiRef = useRef(ui);
  uiRef.current = ui;

  const patientContext = typeof prepared.context['patient_id'] === 'string' ? (prepared.context['patient_id'] as string) : undefined;

  // The browser's record of a call. `audit_id` is the trail's id for it when the data source wrote one; the outcome
  // is the data source's verdict whenever the call reached it (a DispatcherRequestError carries both).
  const makeAudit = useCallback(
    (decl: AppManifest['primitives'][number], started: number) =>
      (outcome: AuditRecord['outcome'], detail?: string, auditId?: string): AuditRecord => ({
        ...(auditId ? { audit_id: auditId } : {}),
        timestamp: new Date().toISOString(),
        app_id: manifest.metadata.app_id,
        manifest_version: manifest.metadata.version,
        primitive_id: decl.id,
        kind: decl.kind,
        role,
        user_sub: identity.sub,
        patient_context: patientContext,
        duration_ms: Math.round(performance.now() - started),
        outcome,
        detail,
      }),
    [manifest.metadata.app_id, manifest.metadata.version, role, identity.sub, patientContext]
  );

  // Execute the data plan (data.* primitives): in waves — primitives that reference nothing still to come run together,
  // dependents after (plan.ts). write.* primitives never run here — only through an action. A primitive may reference an
  // earlier output via $bindings.<name>.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (prepared.missing.length) return;
      const isReload = reload.tick > 0;
      const full = manifest.primitives.filter((p) => !isWriteKind(p.kind));
      // After a write only the bindings it can have changed are fetched again; the rest stay as they are on screen.
      const plan = isReload && reload.only ? full.filter((p) => reload.only!.has(p.output_binding)) : full;
      // First load streams bindings in as they arrive — nodes bound to data still on its way show a placeholder. A
      // reload keeps the app on screen with its current data (which also resolves `$bindings.x` of untouched
      // primitives) and swaps each binding in as its wave completes, so the saved entry shows beside the notice.
      const acc: Record<string, unknown> = isReload ? { ...bindingsRef.current } : {};
      const pending = new Set(plan.map((p) => p.output_binding));
      const publishPending = () => setPendingBindings(isReload ? new Set() : new Set(pending));
      if (!isReload) setBindings({});
      publishPending();
      const total = plan.length;
      let step = 0;
      for (const wave of waves(plan)) {
        if (cancelled) return;
        step += wave.length;
        setPhase({ status: 'running', step, total });
        const runnable = wave.filter((decl) => {
          if (decl.only_for_roles && !decl.only_for_roles.includes(role)) {
            // Not part of this role's data plan: its binding will never arrive, and a visible node that still
            // references it is an authoring mistake worth a diagnostic — so it is not "pending".
            pending.delete(decl.output_binding);
            return false;
          }
          return true;
        });
        publishPending();
        const env: ExpressionEnv = { bindings: acc, context: prepared.context, metadata: manifest.metadata, auth: { role, effective: scope }, ui: {} };
        const settled = await Promise.all(
          runnable.map(async (decl) => {
            const diagnostics: Diagnostic[] = [];
            const resolvedConfig = resolveRecord(decl.config, env, diagnostics);
            diagnostics.forEach((d) => onDiagnostic?.(d));
            const audit = makeAudit(decl, performance.now());
            try {
              if (!isDataPrimitiveKind(decl.kind)) throw new UnknownPrimitiveError(decl.kind);
              const result = await executor.run({ manifest, role, scope, decl, config: resolvedConfig, context: prepared.context, idToken: identity.idToken, userSub: identity.sub, userDisplay: identity.displayName });
              return { decl, audit, output: result.output, auditId: result.audit_id };
            } catch (err) {
              return { decl, audit, err };
            }
          })
        );
        if (cancelled) return;
        const arrived: Record<string, unknown> = {};
        for (const r of settled) {
          if ('err' in r) continue;
          acc[r.decl.output_binding] = r.output;
          arrived[r.decl.output_binding] = r.output;
          pending.delete(r.decl.output_binding);
          onAudit?.(r.audit('ok', summarize(r.output), r.auditId));
        }
        if (Object.keys(arrived).length) setBindings((prev) => ({ ...prev, ...arrived }));
        publishPending();
        const failed = settled.find((r): r is typeof r & { err: unknown } => 'err' in r);
        if (failed) {
          const { decl, audit, err } = failed;
          setPendingBindings(new Set());
          if (err instanceof ScopeViolationError) {
            onAudit?.(audit('refused', err.requirement));
            setPhase({ status: 'failed', kind: 'scope', name: decl.id, detail: err.message });
          } else if (err instanceof UnknownPrimitiveError) {
            onAudit?.(audit('refused', 'unknown primitive'));
            setPhase({ status: 'failed', kind: 'data_primitive', name: decl.kind, detail: err.message });
          } else if (err instanceof PrimitiveConfigError) {
            onAudit?.(audit('error', err.message));
            setPhase({ status: 'failed', kind: 'config', name: decl.id, detail: err.message });
          } else if (err instanceof DispatcherRequestError) {
            // The dispatcher's verdict, under the dispatcher's record id.
            onAudit?.(audit(err.outcome ?? 'error', err.requirement ?? err.message, err.audit_id));
            setPhase({ status: 'failed', kind: 'runtime', name: decl.id, detail: err.message });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            onAudit?.(audit('error', message));
            setPhase({ status: 'failed', kind: 'runtime', name: decl.id, detail: message });
          }
          return;
        }
      }
      if (!cancelled) {
        setPendingBindings(new Set());
        setPhase({ status: 'ready' });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // identity.idToken intentionally excluded: token refresh must not re-run the data plan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, role, scope, prepared, executor, reload]);

  const setUiState = useCallback((key: string, value: unknown) => {
    setUi((prev) => (Object.is(prev[key], value) ? prev : { ...prev, [key]: value }));
  }, []);

  const report = useCallback((d: Diagnostic) => onDiagnostic?.(d), [onDiagnostic]);

  const renderNode = useCallback((node: LayoutNode, key?: string | number): ReactNode => <RenderNode key={key} node={node} />, []);

  const actions = useMemo(() => Object.fromEntries(manifest.actions.map((a) => [a.id, a])), [manifest.actions]);

  const confirm = props.confirm ?? ((message: string) => (typeof window !== 'undefined' ? window.confirm(message) : true));

  const runAction = useCallback(
    async (actionId: string, uiOverrides: Readonly<Record<string, unknown>> = {}) => {
      const action = actions[actionId];
      if (!action) {
        setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message: `Action "${actionId}" is not declared by this app.` } }));
        return;
      }
      const decl = manifest.primitives.find((p) => p.id === action.primitive);
      if (!decl) {
        setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message: `Action "${actionId}" points at an unknown primitive.` } }));
        return;
      }
      if (action.confirm && !confirm(action.confirm)) return;

      setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'running' } }));
      const env: ExpressionEnv = {
        bindings: bindingsRef.current,
        context: prepared.context,
        metadata: manifest.metadata,
        auth: { role, effective: scope },
        ui: { ...uiRef.current, ...uiOverrides },
      };
      const diagnostics: Diagnostic[] = [];
      const resolvedConfig = resolveRecord(decl.config, env, diagnostics);
      diagnostics.forEach((d) => onDiagnostic?.(d));
      const audit = makeAudit(decl, performance.now());
      try {
        if (!isDataPrimitiveKind(decl.kind)) throw new UnknownPrimitiveError(decl.kind);
        const result = await executor.run({ manifest, role, scope, decl, config: resolvedConfig, context: prepared.context, idToken: identity.idToken, userSub: identity.sub, userDisplay: identity.displayName });
        const output = result.output;
        onAudit?.(audit('ok', summarize(output), result.audit_id));
        setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'success', message: action.success_message ?? `${action.label}: done.`, output } }));
        // Refresh what the write can have changed — the reads of the same resource type and whatever reads them — right
        // away; an unknown write kind refreshes everything.
        if (action.on_success === 'reload') setReload((r) => ({ tick: r.tick + 1, only: affectedBindings(manifest.primitives, decl) }));
      } catch (err) {
        if (err instanceof WriteRejectedError) {
          // Declined by validation, not a failure: the same outcome class as a scope refusal.
          onAudit?.(audit('refused', `invalid payload: ${err.problems.join('; ')}`, err.audit_id));
          setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message: 'The record was not saved.', problems: err.problems } }));
        } else if (err instanceof ScopeViolationError) {
          onAudit?.(audit('refused', err.requirement));
          setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message: err.message } }));
        } else if (err instanceof DispatcherRequestError) {
          onAudit?.(audit(err.outcome ?? 'error', err.requirement ?? err.message, err.audit_id));
          setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message: err.message } }));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          onAudit?.(audit('error', message));
          setActionStatus((prev) => ({ ...prev, [actionId]: { status: 'error', message } }));
        }
      }
    },
    [actions, manifest, prepared.context, role, scope, executor, identity.idToken, identity.sub, identity.displayName, onAudit, onDiagnostic, makeAudit, confirm]
  );

  const resetAction = useCallback((actionId: string) => {
    setActionStatus((prev) => (prev[actionId]?.status === 'running' ? prev : { ...prev, [actionId]: { status: 'idle' } }));
  }, []);

  const value = useMemo<RenderContextValue>(
    () => ({ manifest, role, scope, context: prepared.context, bindings, pendingBindings, ui, config, identity, byline, setUiState, report, renderNode, actions, actionStatus, runAction, resetAction }),
    [manifest, role, scope, prepared.context, bindings, pendingBindings, ui, config, identity, byline, setUiState, report, renderNode, actions, actionStatus, runAction, resetAction]
  );

  if (prepared.missing.length) {
    return (
      <Alert color="yellow" title="This app needs a launch context" variant="light">
        <Text size="sm">Missing: {prepared.missing.join(', ')}. Select a patient in the panel, or launch from a SMART context.</Text>
      </Alert>
    );
  }

  // The layout renders from the first paint: static parts (titles, sections) appear at once and each
  // data-bound node shows a placeholder until its binding arrives (see RenderNode).
  if (phase.status === 'failed') {
    if (phase.kind === 'scope') return <CatalogViolation kind="scope" name={phase.name} detail={phase.detail} />;
    if (phase.kind === 'data_primitive') return <CatalogViolation kind="data_primitive" name={phase.name} detail={phase.detail} />;
    return (
      <Alert color="red" title={phase.kind === 'config' ? 'Primitive configuration rejected' : 'Data primitive failed'} variant="light">
        <Text size="sm">{phase.detail}</Text>
      </Alert>
    );
  }

  return (
    <RenderContext.Provider value={value}>
      <RenderNode node={manifest.layout.root} />
    </RenderContext.Provider>
  );
}

function summarize(output: unknown): string {
  if (Array.isArray(output)) return `${output.length} resources`;
  if (output && typeof output === 'object') {
    const o = output as { resourceType?: string; id?: string; count?: number; rows?: unknown[] };
    if (o.resourceType) return o.id ? `${o.resourceType}/${o.id}` : o.resourceType;
    if (typeof o.count === 'number') return `${o.count} patients`;
    if (Array.isArray(o.rows)) return `${o.rows.length} rows`;
  }
  return typeof output;
}
