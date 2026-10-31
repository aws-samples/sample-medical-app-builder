import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Container, Divider, Group, Loader, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useAuth } from '../../auth/AuthContext';
import type { RuntimeConfig } from '../../config/env';
import { canAuthor } from '../../manifest/roles';
import type { ShapeSummary, ShapesClient } from '../../shapes';
import { PanelShell } from '../PanelShell';
import { HowTheLibraryGrows } from './HowTheLibraryGrows';
import { ShapeStateBadge, whenBy } from './ShapeStateBadge';

/**
 * The record-shape library: what a composed page's `record` section may write with. One row per shape — what it
 * writes, how many fields, which version is published and what the latest version is — and the way in to its editor.
 * Authors start a new shape here; publishing is for approvers and admins, on the shape's page.
 */
export function ShapesPage({ client, config }: { client: ShapesClient; config: RuntimeConfig }) {
  const { session } = useAuth();
  const isMock = config.auth.mode === 'mock';
  const author = isMock || (session ? canAuthor(session.claims) : false);
  const navigate = useNavigate();
  const [shapes, setShapes] = useState<ShapeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .list()
      .then((list) => !cancelled && setShapes(list))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <PanelShell crumbs={[{ label: 'Record shapes' }]} isMock={isMock}>
      <Container size="lg" py="lg">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={2}>Record shapes</Title>
              <Text size="sm" c="dimmed" mt={2} maw={760}>
                A shape is a form template for one kind of record — a goal, a care plan, a visit, a note — naming exactly the fields the form has. Make as many as the hospital
                needs: the physiotherapy goal and the dietetics goal are two shapes of the same kind. A shape is reviewed once and published; every app that says{' '}
                <code>shape: &lt;id&gt;</code> writes the same thing, and keeps the version it was built with. Which kinds of record exist is the platform's side — see below.
              </Text>
            </div>
            {author && (
              <Button component={Link} to="/shapes/new" size="sm" leftSection={<IconPlus size={16} />} data-testid="new-shape">
                New shape
              </Button>
            )}
          </Group>

          {error && (
            <Alert color="red" variant="light" title="The library could not be loaded">
              <Text size="sm">{error}</Text>
            </Alert>
          )}
          {!shapes && !error && (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                Loading the library…
              </Text>
            </Group>
          )}
          {shapes && shapes.length === 0 && (
            <Paper withBorder p="md">
              <Text size="sm" c="dimmed" ta="center" py="md">
                No shape yet. {author ? 'Start one — a form template for a goal, a care plan, a visit or a note; a record section of a composed page can then write with it.' : 'Authors create shapes; approvers and admins publish them.'}
              </Text>
            </Paper>
          )}
          {shapes && shapes.length > 0 && (
            <Paper withBorder data-testid="shape-list">
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Shape</Table.Th>
                    <Table.Th>Writes</Table.Th>
                    <Table.Th>Fields</Table.Th>
                    <Table.Th>Published</Table.Th>
                    <Table.Th>Latest</Table.Th>
                    <Table.Th>Updated</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shapes.map((s) => (
                    <Table.Tr key={s.shape_id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/shapes/${encodeURIComponent(s.shape_id)}`)} data-testid={`shape-row-${s.shape_id}`}>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {s.name}
                        </Text>
                        <Text size="xs" c="dimmed" className="ds-mono">
                          {s.shape_id}
                        </Text>
                        {s.description && (
                          <Text size="xs" c="dimmed" lineClamp={1} maw={420}>
                            {s.description}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="outline" color="ink" tt="none">
                          {s.resource}
                        </Badge>
                      </Table.Td>
                      <Table.Td className="ds-tabular">{(s.published?.artifact ?? s.latest?.artifact)?.fields.length ?? '—'}</Table.Td>
                      <Table.Td>{s.published ? <ShapeStateBadge state="published" version={s.published.version} /> : <Text size="xs" c="dimmed">—</Text>}</Table.Td>
                      <Table.Td>{s.latest && (!s.published || s.latest.version !== s.published.version) ? <ShapeStateBadge state={s.latest.state} version={s.latest.version} /> : <Text size="xs" c="dimmed">same</Text>}</Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {whenBy(s.updated_at, s.updated_by)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
          )}

          <Divider my="sm" />
          <HowTheLibraryGrows />
        </Stack>
      </Container>
    </PanelShell>
  );
}
