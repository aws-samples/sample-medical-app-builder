import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { stringify as toYaml } from 'yaml';
import { Alert, Badge, Button, Container, Grid, Group, List, Loader, Modal, Paper, Stack, Table, Text, Textarea, Title, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext';
import { displayNameOf } from '../../auth/types';
import type { RuntimeConfig } from '../../config/env';
import { canAuthor, canCurate, isAdmin } from '../../manifest/roles';
import { isOpenKind, type RecordField } from '../../spec/record';
import { ShapesApiError, type ShapeDetail, type ShapeEvent, type ShapeState, type ShapesClient } from '../../shapes';
import { PanelShell } from '../PanelShell';
import { NEW_SHAPE_TEMPLATE, parseShapeYaml } from './preview';
import { ShapePreview } from './ShapePreview';
import { ShapeStateBadge, whenBy } from './ShapeStateBadge';

/**
 * One shape: its document as YAML, checked as it is typed (the schema, then every field's path against the FHIR
 * definitions — the same check the compiler runs), the fields it declares in a table, a preview of the form on the
 * synthetic record, and the lifecycle — save (a draft revised in place, or a new draft after a publication), publish,
 * deprecate — with the shape's history. `/shapes/new` starts from a worked example.
 */
export function ShapeEditorPage({ client, config }: { client: ShapesClient; config: RuntimeConfig }) {
  const { shapeId } = useParams();
  const isNew = !shapeId;
  const navigate = useNavigate();
  const { session } = useAuth();
  const isMock = config.auth.mode === 'mock';
  const claims = session?.claims;
  const author = isMock || (claims ? canAuthor(claims) : false);
  const curator = isMock || (claims ? canCurate(claims) : false);

  const [detail, setDetail] = useState<ShapeDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState(isNew ? NEW_SHAPE_TEMPLATE : '');
  const [savedText, setSavedText] = useState('');
  // The text the registry holds, to tell an edit from a reload.
  const savedTextRef = useRef('');
  const [busy, setBusy] = useState<'save' | 'publish' | 'deprecate' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string; issues?: readonly { path: string; message: string }[] } | null>(null);
  const [confirm, setConfirm] = useState<{ to: ShapeState; notes: string } | null>(null);

  const load = useCallback(async () => {
    if (!shapeId) return;
    try {
      const d = await client.get(shapeId);
      setDetail(d);
      const yaml = d.latest ? toYaml(d.latest.document, { lineWidth: 0 }) : '';
      setText((current) => (current === '' || current === savedTextRef.current ? yaml : current));
      setSavedText(yaml);
      savedTextRef.current = yaml;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [client, shapeId]);
  useEffect(() => {
    void load();
  }, [load]);

  const parsed = useMemo(() => parseShapeYaml(text), [text]);
  const dirty = isNew || text !== savedText;
  const latest = detail?.latest ?? null;
  const admin = isMock || (claims ? isAdmin(claims) : false);
  // A kind the platform has not admitted — the document declares the platform's own stamps — is an administrator's to define.
  const openKind = parsed.ok ? isOpenKind(parsed.doc.shape.resource) : Boolean(detail?.latest?.artifact.open_kind);
  const mayEdit = author && (isNew || !detail || curator || admin || detail.owner_sub === claims?.sub || isMock) && (!openKind || admin);
  const idMismatch = !isNew && parsed.ok && detail && parsed.doc.shape.id !== detail.shape_id;

  async function save() {
    if (!parsed.ok) return;
    setBusy('save');
    setNotice(null);
    try {
      if (isNew) {
        const made = await client.create(parsed.raw);
        navigate(`/shapes/${encodeURIComponent(made.shape_id)}`, { replace: true });
        return;
      }
      const after = await client.revise(shapeId!, parsed.raw);
      const revisedInPlace = latest && after.latest_version === latest.version;
      await load(); // the page shows the saved state before it says so
      setNotice({ kind: 'ok', text: revisedInPlace ? `Draft ${after.latest_version} revised.` : `Saved as draft ${after.latest_version}${latest ? ` after ${latest.version}` : ''}.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err), issues: err instanceof ShapesApiError && Array.isArray(err.details.issues) ? (err.details.issues as { path: string; message: string }[]) : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function transition(to: ShapeState, notes: string) {
    if (!detail || !latest) return;
    const version = to === 'deprecated' && detail.published ? detail.published.version : latest.version;
    setBusy(to === 'published' ? 'publish' : 'deprecate');
    setNotice(null);
    setConfirm(null);
    try {
      const after = await client.transition(detail.shape_id, version, to, notes.trim() || undefined);
      await load();
      setNotice({ kind: 'ok', text: to === 'published' ? `${after.name} ${version} is published: apps can write with \`shape: ${after.shape_id}\`.` : `${after.name} ${version} is deprecated${after.published ? '' : ' — the library offers no published version of it now'}.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const crumbs = [{ label: 'Record shapes', to: '/shapes' }, { label: isNew ? 'New shape' : (detail?.name ?? shapeId ?? '') }];
  if (!isNew && loadError) {
    return (
      <PanelShell crumbs={crumbs} isMock={isMock}>
        <Container size="lg" py="lg">
          <Alert color="red" variant="light" title="The shape could not be loaded">
            <Text size="sm">{loadError}</Text>
          </Alert>
        </Container>
      </PanelShell>
    );
  }
  if (!isNew && !detail) {
    return (
      <PanelShell crumbs={crumbs} isMock={isMock}>
        <Container size="lg" py="lg">
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Loading the shape…
            </Text>
          </Group>
        </Container>
      </PanelShell>
    );
  }

  const canPublish = curator && latest?.state === 'draft';
  const canDeprecate = curator && (latest?.state === 'published' || detail?.published != null);
  const openAsApp = detail?.published ? `/drafts/new?shape=${encodeURIComponent(detail.shape_id)}` : undefined;

  return (
    <PanelShell crumbs={crumbs} isMock={isMock}>
      <Container size="xl" py="lg">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div style={{ minWidth: 0 }}>
              <Group gap="sm" align="baseline" wrap="wrap">
                <Title order={2}>{isNew ? 'New shape' : detail?.name}</Title>
                {detail && (
                  <Text size="sm" c="dimmed" className="ds-mono">
                    {detail.shape_id}
                  </Text>
                )}
              </Group>
              <Group gap="xs" mt={6} wrap="wrap">
                {detail && (
                  <Badge variant="outline" color="ink" tt="none">
                    writes a {detail.resource}
                  </Badge>
                )}
                {detail?.published && <ShapeStateBadge state="published" version={detail.published.version} />}
                {latest && (!detail?.published || latest.version !== detail.published.version) && <ShapeStateBadge state={latest.state} version={latest.version} />}
                {detail?.published && latest && latest.version !== detail.published.version && latest.state === 'draft' && (
                  <Text size="xs" c="dimmed">
                    apps keep writing with {detail.published.version} until {latest.version} is published
                  </Text>
                )}
              </Group>
            </div>
            <Group gap="xs" wrap="wrap">
              <Button component={Link} to="/shapes" variant="subtle" size="xs" leftSection={<IconArrowLeft size={14} />}>
                All shapes
              </Button>
              {openAsApp ? (
                <Button component={Link} to={openAsApp} variant="light" size="xs" leftSection={<IconExternalLink size={14} />} data-testid="open-as-app">
                  Open as an app
                </Button>
              ) : (
                !isNew && (
                  <Tooltip label="Publish the shape first: an app refers to a published version." withArrow>
                    <Button variant="light" size="xs" leftSection={<IconExternalLink size={14} />} disabled data-testid="open-as-app">
                      Open as an app
                    </Button>
                  </Tooltip>
                )
              )}
              {canDeprecate && (
                <Button variant="default" size="xs" color="gray" onClick={() => setConfirm({ to: 'deprecated', notes: '' })} loading={busy === 'deprecate'} disabled={busy !== null} data-testid="deprecate-shape">
                  Deprecate {detail?.published?.version ?? latest?.version}
                </Button>
              )}
              {canPublish && (
                <Button size="xs" onClick={() => setConfirm({ to: 'published', notes: '' })} loading={busy === 'publish'} disabled={busy !== null || dirty} data-testid="publish-shape">
                  Publish {latest?.version}
                </Button>
              )}
              {mayEdit && (
                <Button size="xs" variant={canPublish ? 'light' : 'filled'} onClick={() => void save()} loading={busy === 'save'} disabled={busy !== null || !parsed.ok || !dirty || Boolean(idMismatch)} data-testid="save-shape">
                  {isNew ? 'Create' : latest?.state === 'draft' ? 'Save draft' : 'Save as new draft'}
                </Button>
              )}
            </Group>
          </Group>

          {notice && (
            <Alert color={notice.kind === 'ok' ? 'green' : 'red'} variant="light" withCloseButton onClose={() => setNotice(null)} data-testid="shape-notice">
              <Text size="sm">{notice.text}</Text>
              {notice.issues && (
                <List size="sm" mt={4}>
                  {notice.issues.map((i, n) => (
                    <List.Item key={n}>
                      <code>{i.path}</code> — {i.message}
                    </List.Item>
                  ))}
                </List>
              )}
            </Alert>
          )}
          {canPublish && dirty && (
            <Text size="xs" c="dimmed">
              Save the draft before publishing it: what is published is what the registry holds.
            </Text>
          )}
          {openKind && parsed.ok && (
            <Alert color="ink" variant="light" title={`${parsed.doc.shape.resource} is a kind the platform has not admitted`} data-testid="open-kind-notice">
              <Text size="sm">
                The platform knows its element paths but not its meaning, so this shape declares the stamps itself — which element names the patient, the status and its value, the dates — and an
                administrator vouches for them. {admin ? 'You can define and revise it; approvers publish it like any other shape.' : 'Only an administrator can define or revise it; it reads here as it is.'}{' '}
                Apps that write with it carry the mark, and the review page shows it.
              </Text>
            </Alert>
          )}

          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, lg: 6 }}>
              <Stack gap="sm">
                <Textarea
                  label="Shape document"
                  description={mayEdit ? 'A RecordShape in YAML: the kind of record (Goal, CarePlan, Encounter, DocumentReference or Consent), the status the platform stamps, and the fields with the element paths they write to.' : 'Read-only: shapes are revised by their owner, approvers and admins.'}
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                  readOnly={!mayEdit}
                  autosize
                  minRows={18}
                  maxRows={40}
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12.5, lineHeight: 1.5 } }}
                  spellCheck={false}
                  data-testid="shape-yaml"
                />
                {!parsed.ok && (
                  <Alert color="yellow" variant="light" title="Not a shape yet" py="xs" data-testid="shape-issues">
                    <List size="sm">
                      {parsed.issues.map((i, n) => (
                        <List.Item key={n}>
                          <code>{i.path}</code> — {i.message}
                        </List.Item>
                      ))}
                    </List>
                  </Alert>
                )}
                {idMismatch && (
                  <Alert color="yellow" variant="light" py="xs">
                    <Text size="sm">
                      The id is the shape's name across apps and does not change: keep <code>{detail?.shape_id}</code>, or create a new shape for <code>{parsed.ok ? parsed.doc.shape.id : ''}</code>.
                    </Text>
                  </Alert>
                )}
                {parsed.ok && <FieldsTable fields={parsed.doc.shape.fields} />}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 6 }}>
              <Stack gap="sm">
                <div>
                  <Text size="sm" fw={600}>
                    Preview
                  </Text>
                  <Text size="xs" c="dimmed">
                    The form this shape describes, on the synthetic record — as a composed page would show it next to what is already recorded.
                  </Text>
                </div>
                {parsed.ok && session ? (
                  <ShapePreview doc={parsed.doc} config={config} identity={{ sub: session.claims.sub, idToken: session.idToken, displayName: displayNameOf(session.claims) }} />
                ) : (
                  <Text size="sm" c="dimmed">
                    The preview appears once the document is a shape.
                  </Text>
                )}
              </Stack>
            </Grid.Col>
          </Grid>

          {detail && detail.history.length > 0 && <History events={detail.history} />}
        </Stack>
      </Container>

      <Modal opened={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.to === 'published' ? `Publish ${detail?.name} ${latest?.version}` : `Deprecate ${detail?.name} ${detail?.published?.version ?? latest?.version}`} centered>
        {confirm && (
          <Stack gap="sm">
            <Text size="sm">
              {confirm.to === 'published'
                ? detail?.published
                  ? `Apps compiled from now on write with ${latest?.version}; ${detail.published.version} is deprecated and the apps built with it keep it.`
                  : `From now on an app may say shape: ${detail?.shape_id} and write with this version.`
                : 'The library stops offering this shape to new apps; apps already built with it keep writing as they do.'}
            </Text>
            <Textarea label="Notes (optional)" placeholder={confirm.to === 'published' ? 'Reviewed with …' : 'Why it is retired'} value={confirm.notes} onChange={(e) => setConfirm({ ...confirm, notes: e.currentTarget.value })} autosize minRows={2} data-testid="transition-notes" />
            <Group justify="flex-end">
              <Button variant="default" size="xs" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button size="xs" color={confirm.to === 'published' ? undefined : 'gray'} onClick={() => void transition(confirm.to, confirm.notes)} data-testid="confirm-transition">
                {confirm.to === 'published' ? 'Publish' : 'Deprecate'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </PanelShell>
  );
}

function FieldsTable({ fields }: { fields: readonly RecordField[] }) {
  return (
    <Paper withBorder data-testid="shape-fields">
      <Table verticalSpacing={6} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Field</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Written to</Table.Th>
            <Table.Th>Rules</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {fields.map((f) => (
            <Table.Tr key={f.id}>
              <Table.Td>
                <Text size="xs" fw={600}>
                  {f.label}
                  {f.required ? ' *' : ''}
                </Text>
                <Text size="xs" c="dimmed" className="ds-mono">
                  {f.id}
                </Text>
              </Table.Td>
              <Table.Td>{f.type}</Table.Td>
              <Table.Td className="ds-mono">{f.path}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {ruleText(f)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

function ruleText(f: RecordField): string {
  const parts: string[] = [];
  if (f.unit) parts.push(`in ${f.unit}`);
  if (f.range) parts.push(`${f.range.min ?? '…'}–${f.range.max ?? '…'}`);
  if (f.past_days !== undefined) parts.push(`up to ${f.past_days} days back`);
  if (f.future_days !== undefined) parts.push(`up to ${f.future_days} days ahead`);
  if (f.max_length !== undefined) parts.push(`≤ ${f.max_length} characters`);
  if (f.codes?.length) parts.push(`${f.codes.length} code${f.codes.length === 1 ? '' : 's'}`);
  if (f.options?.length) parts.push(`${f.options.length} option${f.options.length === 1 ? '' : 's'}`);
  return parts.join(' · ') || '—';
}

function History({ events }: { events: readonly ShapeEvent[] }) {
  return (
    <Stack gap={6} data-testid="shape-history">
      <Text size="sm" fw={600}>
        History
      </Text>
      {events.map((e, i) => (
        <Group key={`${e.ts}-${i}`} gap="sm" wrap="nowrap" align="baseline">
          <Text size="xs" c="dimmed" style={{ flex: 'none', minWidth: 150 }}>
            {whenBy(e.ts, null)}
          </Text>
          <Text size="xs">
            {e.version ? `${e.version}: ` : ''}
            {e.from_state === null ? 'created as draft' : e.from_state === 'draft' && e.to_state === 'draft' ? 'revised' : `${e.from_state} → ${e.to_state}`}
            {e.actor?.name || e.actor?.email ? ` · ${e.actor.name ?? e.actor.email}` : ''}
            {e.notes ? ` — ${e.notes}` : ''}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
