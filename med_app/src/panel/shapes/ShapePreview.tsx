import { useCallback, useMemo, useState } from 'react';
import { Alert, Group, List, Paper, Select, Stack, Text } from '@mantine/core';
import type { RuntimeConfig } from '../../config/env';
import { MockPrimitiveExecutor } from '../../primitives/data/mock/mockExecutor';
import { SEED } from '../../primitives/data/mock/seed';
import { ManifestApp } from '../../renderer/ManifestApp';
import type { Diagnostic } from '../../renderer/expressions';
import { compileSpec } from '../../spec/compiler';
import { compileShape, shapeLookup, type RecordShapeDoc } from '../../spec/shapes';
import { tokens } from '../../theme';
import { previewSpecFor } from './preview';

/**
 * The shape as a form, on the synthetic record: a composed page with what the patient has of that resource type and
 * the form the shape describes, compiled here (the shape inline — a draft has nothing published to refer to) and
 * rendered by the renderer clinicians use. Saving in the preview writes to the mock executor and shows up in the list
 * beside it; nothing reaches the hospital's record.
 */
export function ShapePreview({ doc, config, identity }: { doc: RecordShapeDoc; config: RuntimeConfig; identity: { readonly sub: string; readonly idToken: string; readonly displayName?: string } }) {
  const executor = useMemo(() => new MockPrimitiveExecutor(), []);
  const patients = useMemo(() => SEED.patients.map((p) => ({ value: p.id ?? '', label: `${p.name?.[0]?.given?.join(' ')} ${p.name?.[0]?.family} · ${p.identifier?.[0]?.value ?? p.id}` })), []);
  const [patientId, setPatientId] = useState(patients[0]?.value ?? '');
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const onDiagnostic = useCallback((d: Diagnostic) => setDiagnostics((prev) => (prev.some((p) => p.message === d.message) ? prev : [...prev, d])), []);
  const docKey = JSON.stringify(doc);
  // The compile is pure and fast; keyed on the document so typing recompiles, and the renderer remounts with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compiled = useMemo(() => {
    // The document's own artifact is the library the preview compiles against: the form refers to the shape by id.
    const own = compileShape(doc);
    return compileSpec(previewSpecFor(doc), { hospital_id: config.hospitalId, created_at: '2026-01-01T00:00:00Z', created_by_sub: 'preview', ...(own.ok ? { shapes: shapeLookup([own.artifact]) } : {}) });
  }, [docKey, config.hospitalId]);

  if (!compiled.ok) {
    return (
      <Alert color="yellow" variant="light" title="The preview page does not compile" data-testid="shape-preview-issues">
        <List size="sm">
          {compiled.issues.map((i, n) => (
            <List.Item key={n}>
              <code>{i.path}</code> — {i.message}
            </List.Item>
          ))}
        </List>
      </Alert>
    );
  }
  return (
    <Stack gap="sm" data-testid="shape-preview">
      <Group gap="md" align="flex-end" wrap="wrap">
        <Select size="xs" label="Synthetic patient" data={patients} value={patientId} onChange={(v) => v && setPatientId(v)} w={360} allowDeselect={false} />
        <Text size="xs" c="dimmed" pb={6}>
          What is on record, and the form the shape describes. Entries saved here stay in this preview.
        </Text>
      </Group>
      <Paper withBorder p="md" style={{ background: tokens.page, minWidth: 0, overflow: 'hidden' }}>
        <ManifestApp key={`${docKey.length}:${patientId}`} manifest={compiled.manifest} role="clinician" context={{ patient_id: patientId }} executor={executor} config={config} identity={identity} onDiagnostic={onDiagnostic} />
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
