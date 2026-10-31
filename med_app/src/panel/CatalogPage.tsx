import { Code, Container, Stack, Table, Text, Title } from '@mantine/core';
import type { RuntimeConfig } from '../config/env';
import { listCatalog } from '../primitives/catalog';
import { DATA_CATALOG, PRIMITIVE_CONFIG_SCHEMAS } from '../primitives/data/dataCatalog';
import { PanelShell } from './PanelShell';

/** What the planning agents are allowed to compose from. Generated from the catalogs, so it cannot drift. */
export function CatalogPage({ config }: { config: RuntimeConfig }) {
  const ui = listCatalog();
  return (
    <PanelShell crumbs={[{ label: 'Components and data primitives' }]} isMock={config.auth.mode === 'mock'}>
      <Container size="lg" py="lg">
        <Stack gap="xl">
          <div>
            <Title order={2}>Catalog v0</Title>
            <Text c="dimmed" size="sm" mt={2}>
              The complete vocabulary a manifest may use. Anything not listed here is refused by the renderer.
            </Text>
          </div>
          <div>
            <Title order={3} mb="sm">
              Data primitives
            </Title>
            <Table withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Config keys</Table.Th>
                  <Table.Th>Output</Table.Th>
                  <Table.Th>Description</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {Object.values(DATA_CATALOG).map((p) => (
                  <Table.Tr key={p.kind}>
                    <Table.Td>
                      <Code>{p.kind}</Code>
                      <Text size="xs" c="dimmed">
                        v{p.version}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Code>{Object.keys(PRIMITIVE_CONFIG_SCHEMAS[p.kind].shape).join(', ')}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Code>{p.output}</Code>
                    </Table.Td>
                    <Table.Td>{p.description}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          <div>
            <Title order={3} mb="sm">
              Components
            </Title>
            <Table withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Component</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Props</Table.Th>
                  <Table.Th>Description</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ui.map((c) => (
                  <Table.Tr key={c.name}>
                    <Table.Td>
                      <Code>{c.name}</Code>
                      <Text size="xs" c="dimmed">
                        v{c.version}
                      </Text>
                    </Table.Td>
                    <Table.Td>{c.kind}</Table.Td>
                    <Table.Td>
                      <Code>{c.props.join(', ') || '—'}</Code>
                    </Table.Td>
                    <Table.Td>{c.description}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        </Stack>
      </Container>
    </PanelShell>
  );
}
