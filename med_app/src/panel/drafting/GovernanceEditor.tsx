import { Select, Stack, TagsInput, Text } from '@mantine/core';
import type { DraftOp } from '../../authoring/types';
import { CommitTextInput } from './OverviewEditor';
import type { SpecReading } from './specView';

const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '');

/**
 * What an approver signs: where the app is used, by whom, for what — and what it is not for. The
 * purpose is the one free-text field of the spec that reaches the manifest verbatim.
 */
export function GovernanceEditor({ reading, readOnly, onPatch }: { reading: SpecReading; readOnly: boolean; onPatch: (ops: DraftOp[]) => Promise<boolean> }) {
  const g = reading.governance;
  const patch = (fields: Record<string, unknown>) => onPatch([{ op: 'set_governance', args: { patch: fields } }]);

  return (
    <Stack gap="md">
      <CommitTextInput
        label="Clinical context"
        required
        description="Where the app is used, as a slug — e.g. outpatient_bp_monitoring, diabetes_clinic."
        value={g.clinical_context ?? ''}
        placeholder="diabetes_clinic"
        readOnly={readOnly}
        onCommit={(v) => patch({ clinical_context: slug(v) })}
        mono
      />
      <TagsInput
        label="Intended users"
        withAsterisk
        description="Who uses it, as slugs. Type and press Enter."
        value={[...(g.intended_users ?? [])]}
        onChange={(v) => void patch({ intended_users: v.map(slug).filter(Boolean) })}
        placeholder={g.intended_users?.length ? '' : 'general_practitioner, cardiologist'}
        disabled={readOnly}
        splitChars={[',', ' ']}
      />
      <CommitTextInput
        label="Intended purpose"
        required
        description="What the app is for and what it is not for — the sentence the approver signs."
        value={g.intended_purpose ?? ''}
        placeholder="Display of the patient's HbA1c course for the diabetes consultation. Display only; not a diagnostic or dosing aid."
        readOnly={readOnly}
        onCommit={(v) => patch({ intended_purpose: v })}
        multiline
      />
      <Select
        label="MDR classification"
        description="Optional, 'none' unless set. Medical-device class under the EU MDR; 'none' for display-only apps that do not inform a clinical decision by themselves."
        data={['none', 'I', 'IIa', 'IIb', 'III']}
        value={g.mdr_classification ?? 'none'}
        onChange={(v) => v && void patch({ mdr_classification: v })}
        disabled={readOnly}
        allowDeselect={false}
        styles={{ wrapper: { maxWidth: 260 } }}
      />
      {g.data_categories && (
        <Text size="xs" c="dimmed">
          Data categories: {g.data_categories.join(', ')} (derived from the archetype unless set).
        </Text>
      )}
    </Stack>
  );
}
