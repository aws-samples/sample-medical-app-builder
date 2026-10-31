import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Group, List, Loader, Paper, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import type { AuthoringClient, PlainSpec, SpecIssue } from '../../authoring/types';
import { SYNTHETIC_VIEWER_SOURCE, type RuntimeConfig } from '../../config/env';
import { validateManifest, type AppManifest } from '../../manifest/schema';
import { MockPrimitiveExecutor } from '../../primitives/data/mock/mockExecutor';
import { SEED } from '../../primitives/data/mock/seed';
import { ManifestApp } from '../../renderer/ManifestApp';
import type { Diagnostic } from '../../renderer/expressions';
import { tokens } from '../../theme';

type CompileState = { status: 'idle' } | { status: 'compiling' } | { status: 'ok'; manifest: AppManifest } | { status: 'issues'; issues: readonly SpecIssue[] } | { status: 'error'; message: string };

/**
 * The draft, compiled and rendered by the real renderer against synthetic data — the same
 * renderer, same manifest validation, same masking by role. Nothing here touches the hospital
 * record: a draft is not an approved app, so the preview never runs on real patients.
 */
export function PreviewPane({
  client,
  spec,
  ready,
  config,
  identity,
}: {
  client: AuthoringClient;
  spec: PlainSpec;
  /** No open items: the spec is expected to compile. */
  ready: boolean;
  config: RuntimeConfig;
  identity: { readonly sub: string; readonly idToken: string; readonly displayName?: string };
}) {
  const [state, setState] = useState<CompileState>({ status: 'idle' });
  const [role, setRole] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const specKey = JSON.stringify(spec);
  const executor = useMemo(() => new MockPrimitiveExecutor(), []);
  // A preview renders the synthetic record, whatever the deployment's data mode: its studies are on the reference PACS.
  const previewConfig = useMemo<RuntimeConfig>(() => ({ ...config, imaging: { ...config.imaging, viewerDataSource: SYNTHETIC_VIEWER_SOURCE } }), [config]);

  const patients = useMemo(
    () => SEED.patients.map((p) => ({ value: p.id ?? '', label: `${p.name?.[0]?.given?.join(' ')} ${p.name?.[0]?.family} · ${p.identifier?.[0]?.value ?? p.id}` })),
    []
  );
  const [patientId, setPatientId] = useState(patients[0]?.value ?? '');

  useEffect(() => {
    if (!ready) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'compiling' });
    setDiagnostics([]);
    client
      .compile(spec)
      .then((outcome) => {
        if (cancelled) return;
        if (!outcome.ok) return setState({ status: 'issues', issues: outcome.issues });
        // Defence in depth: the manifest the service returned must pass this build's schema too.
        const validated = validateManifest(outcome.manifest);
        if (!validated.ok) return setState({ status: 'issues', issues: validated.issues });
        setState({ status: 'ok', manifest: validated.manifest });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // specKey stands in for spec: recompile only when the content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, specKey, ready]);

  const onDiagnostic = useCallback((d: Diagnostic) => setDiagnostics((prev) => (prev.some((p) => p.message === d.message) ? prev : [...prev, d])), []);

  if (!ready) {
    return (
      <Text size="sm" c="dimmed">
        The preview appears once nothing is open in the checklist.
      </Text>
    );
  }
  if (state.status === 'idle' || state.status === 'compiling') {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Compiling…
        </Text>
      </Group>
    );
  }
  if (state.status === 'error') {
    return (
      <Alert color="red" variant="light" title="The compiler service could not be reached">
        <Text size="sm">{state.message}</Text>
      </Alert>
    );
  }
  if (state.status === 'issues') {
    return (
      <Alert color="yellow" variant="light" title="The draft does not compile yet">
        <List size="sm">
          {state.issues.map((i, n) => (
            <List.Item key={n}>
              <code>{i.path}</code> — {i.message}
            </List.Item>
          ))}
        </List>
      </Alert>
    );
  }

  const manifest = state.manifest;
  const roles = manifest.auth.roles;
  const activeRole = role && roles.some((r) => r.id === role) ? role : manifest.auth.default_role;
  const needsPatient = manifest.context_inputs.some((c) => c.name === 'patient_id' && c.required);
  const context = needsPatient ? { patient_id: patientId } : {};

  return (
    <Stack gap="sm" data-testid="preview">
      <Group gap="md" align="flex-end" wrap="wrap">
        <div>
          <Text size="xs" c="dimmed" mb={4}>
            Preview as
          </Text>
          <SegmentedControl size="xs" value={activeRole} onChange={setRole} data={roles.map((r) => ({ value: r.id, label: r.display_name }))} />
        </div>
        {needsPatient && <Select size="xs" label="Synthetic patient" data={patients} value={patientId} onChange={(v) => v && setPatientId(v)} w={360} allowDeselect={false} />}
        <Group gap="xs" pb={4}>
          <Badge variant="outline" color="ink" tt="none">
            {manifest.metadata.app_id}
          </Badge>
          <Badge variant="outline" color="ink" tt="none">
            {manifest.primitives.length} data primitives
          </Badge>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        Rendered by the same renderer clinicians use, on synthetic data. Real patients are only reachable once the app is approved and published.
      </Text>
      <Paper withBorder p="md" style={{ background: tokens.page, minWidth: 0, overflow: 'hidden' }}>
        <ManifestApp
          key={`${manifest.metadata.app_id}:${activeRole}:${patientId}:${specKey.length}`}
          manifest={manifest}
          role={activeRole}
          context={context}
          executor={executor}
          config={previewConfig}
          identity={identity}
          onDiagnostic={onDiagnostic}
        />
      </Paper>
      {diagnostics.length > 0 && (
        <Alert color="yellow" variant="light" title="Renderer diagnostics" py="xs">
          <Stack gap={2}>
            {diagnostics.map((d, i) => (
              <Text key={i} size="xs">
                {d.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
