import { useEffect, useState } from 'react';
import { Alert, Button, Group, Stack, Table, Text, Textarea } from '@mantine/core';
import { IconCode } from '@tabler/icons-react';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { DraftOp } from '../../authoring/types';
import { ARCHETYPES } from '../../spec/archetypes';
import { describeKnobs, type SpecReading } from './specView';

/**
 * The archetype's settings, as a readable summary — the natural way to change them is the chat
 * ("plot diastolic too", "two years, not one"). Staff who know the spec can edit the YAML directly;
 * it goes through the same validated operation, so a wrong value is refused with the schema's reason.
 */
export function KnobsPanel({ reading, readOnly, staff, onPatch }: { reading: SpecReading; readOnly: boolean; staff: boolean; onPatch: (ops: DraftOp[]) => Promise<boolean> }) {
  const [yamlOpen, setYamlOpen] = useState(false);
  if (!reading.archetype) {
    return (
      <Text size="sm" c="dimmed">
        Settings appear once the kind of app is chosen.
      </Text>
    );
  }
  const lines = describeKnobs(reading.archetype, reading.knobs);
  const def = ARCHETYPES[reading.archetype];

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {def.id} · {def.name}. To change a setting, tell the assistant — e.g. “show the last five years” or “add a 140 mmHg reference line”.
      </Text>
      <Table withRowBorders fz="sm" verticalSpacing={6} data-testid="knobs-summary">
        <Table.Tbody>
          {lines.map((line) => (
            <Table.Tr key={line.key}>
              <Table.Td w="34%" style={{ verticalAlign: 'top' }}>
                <Text size="sm" fw={500}>
                  {line.key.replace(/_/g, ' ')}
                </Text>
                {line.description && (
                  <Text size="xs" c="dimmed">
                    {line.description}
                  </Text>
                )}
              </Table.Td>
              <Table.Td style={{ verticalAlign: 'top', whiteSpace: 'pre-wrap' }}>
                {line.value !== undefined ? (
                  <Text size="sm">{line.value}</Text>
                ) : line.fallback !== undefined ? (
                  <Text size="sm" c="dimmed">
                    {line.fallback} <Text span size="xs">(default)</Text>
                  </Text>
                ) : (
                  <Text size="sm" c={line.required ? 'orange' : 'dimmed'}>
                    {line.required ? 'still open' : 'not set'}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {staff && !readOnly && !yamlOpen && (
        <Button size="xs" variant="subtle" color="gray" leftSection={<IconCode size={14} />} onClick={() => setYamlOpen(true)} w="fit-content">
          Advanced: edit the settings as YAML
        </Button>
      )}
      {staff && !readOnly && yamlOpen && <YamlEditor knobs={reading.knobs} onPatch={onPatch} onClose={() => setYamlOpen(false)} />}
    </Stack>
  );
}

function YamlEditor({ knobs, onPatch, onClose }: { knobs: Record<string, unknown>; onPatch: (ops: DraftOp[]) => Promise<boolean>; onClose: () => void }) {
  const current = Object.keys(knobs).length ? toYaml(knobs) : '';
  const [text, setText] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(current), [current]);

  async function apply() {
    let parsed: unknown;
    try {
      parsed = text.trim() ? parseYaml(text) : {};
    } catch (err) {
      setProblem(`Not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setProblem('The settings must be a mapping of knob → value.');
      return;
    }
    // set_knobs merges; a key that disappeared here is deleted with an explicit null.
    const next = parsed as Record<string, unknown>;
    const patch: Record<string, unknown> = { ...next };
    for (const key of Object.keys(knobs)) if (!(key in next)) patch[key] = null;
    setProblem(null);
    await onPatch([{ op: 'set_knobs', args: { patch } }]);
  }

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        The knobs of this archetype, as the spec stores them (see docs/app-spec.md). Apply runs the same validation as the assistant's tools.
      </Text>
      <Textarea value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={6} maxRows={24} styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }} aria-label="Settings as YAML" />
      {problem && (
        <Alert color="red" variant="light" py="xs">
          <Text size="xs">{problem}</Text>
        </Alert>
      )}
      <Group gap="xs">
        <Button size="xs" onClick={() => void apply()} disabled={text === current}>
          Apply
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={() => setText(current)} disabled={text === current}>
          Revert
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Stack>
  );
}
