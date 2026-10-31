import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, List, NumberInput, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';
import { encodeValue, setPath, validateRecordEntry, type RecordEntryRules, type RecordFieldRule } from '../data/recordShape';
import { ActionForm } from './ActionForm';

/**
 * The form of a declared-shape record: one input per declared field, by type — text, a number with its unit, a date,
 * yes/no, a code or an option from a fixed list — and nothing the shape did not declare. On submit the values are
 * written at their element paths into a resource of the declared type (the encoding the compiler resolved), the payload
 * is checked against the same rules the dispatcher applies, and the action carries it. Status, subject, author and
 * dates are the platform's to stamp; the form never sets them.
 */

const RESOURCE_WORDS: Record<string, string> = { Goal: 'goal', CarePlan: 'care plan', Encounter: 'visit', DocumentReference: 'note', Consent: 'consent' };

export interface RecordEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  readonly resource: string;
  readonly fields: readonly RecordFieldRule[];
}

export function RecordEntryForm({ action, state_key = 'record_entry', title, submit_label = 'Save', resource, fields }: RecordEntryFormProps) {
  const word = RESOURCE_WORDS[resource] ?? resource;
  return (
    <ActionForm action={action} title={title ?? `New ${word}`} subtitle={`Saved to the patient record as a ${resource}; the platform records who and when.`} another_label="Add another" testid={`record-entry-${resource.toLowerCase()}`}>
      {({ formKey, running, submit }) => <RecordFields key={formKey} resource={resource} fields={fields} running={running} submitLabel={submit_label} onSubmit={(r) => submit({ [state_key]: r })} />}
    </ActionForm>
  );
}

type Values = Record<string, unknown>;

function RecordFields({ resource, fields, running, submitLabel, onSubmit }: { resource: string; fields: readonly RecordFieldRule[]; running: boolean; submitLabel: string; onSubmit: (r: Record<string, unknown>) => void }) {
  const { context } = useRenderContext();
  const patientId = typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;
  const [values, setValues] = useState<Values>({});
  const [problems, setProblems] = useState<string[]>([]);
  const rules = useMemo<RecordEntryRules>(() => ({ resource, fields }), [resource, fields]);

  function build(): Record<string, unknown> {
    const r: Record<string, unknown> = { resourceType: resource, identifier: [{ system: 'urn:medapp:submission', value: crypto.randomUUID() }] };
    for (const f of fields) {
      const encoded = encodeValue(f, values[f.id]);
      if (encoded !== undefined) setPath(r, f.path, encoded);
    }
    return r;
  }

  function trySubmit() {
    const r = build();
    const found = validateRecordEntry(rules, r, patientId ?? '', new Date());
    setProblems(found);
    if (found.length === 0) onSubmit(r);
  }

  const set = (id: string, v: unknown) => setValues((prev) => ({ ...prev, [id]: v }));

  return (
    <Stack gap="sm">
      {fields.map((f) => (
        <Field key={f.id} field={f} value={values[f.id]} onChange={(v) => set(f.id, v)} disabled={running} />
      ))}
      {problems.length > 0 && (
        <Alert color="red" variant="light" title="Please check the entry" data-testid="entry-problems">
          <List size="sm">
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          The platform records who saved it and when.
        </Text>
        <Button onClick={trySubmit} loading={running} style={{ flex: 'none' }} data-testid="entry-submit">
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}

function Field({ field, value, onChange, disabled }: { field: RecordFieldRule; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const testid = `field-${field.id}`;
  const label = field.label;
  switch (field.type) {
    case 'text':
      return <TextInput label={label} required={field.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value)} maxLength={field.max_length} disabled={disabled} data-testid={testid} />;
    case 'long_text':
      return <Textarea label={label} required={field.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value)} autosize minRows={2} maxRows={8} maxLength={field.max_length} disabled={disabled} data-testid={testid} />;
    case 'number':
    case 'integer':
      return (
        <NumberInput
          label={label}
          required={field.required}
          description={field.range ? `${field.range.min ?? '…'}–${field.range.max ?? '…'}${field.unit ? ` ${field.unit}` : ''}` : undefined}
          suffix={field.unit ? ` ${field.unit}` : undefined}
          value={(value as number | string) ?? ''}
          onChange={(v) => onChange(v === '' ? undefined : v)}
          allowDecimal={field.type === 'number'}
          clampBehavior="none"
          w={240}
          disabled={disabled}
          data-testid={testid}
        />
      );
    case 'date':
      return <TextInput type="date" label={label} required={field.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value)} w={200} disabled={disabled} data-testid={testid} />;
    case 'datetime':
      return <TextInput type="datetime-local" label={label} required={field.required} value={(value as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value ? new Date(e.currentTarget.value).toISOString() : '')} w={240} disabled={disabled} data-testid={testid} />;
    case 'boolean':
      return <Checkbox label={label} checked={Boolean(value)} onChange={(e) => onChange(e.currentTarget.checked)} disabled={disabled} data-testid={testid} />;
    case 'code':
      return <Select label={label} required={field.required} placeholder="Choose…" data={(field.codes ?? []).map((c) => ({ value: c.code, label: c.display }))} value={(value as string) ?? null} onChange={(v) => onChange(v ?? undefined)} searchable disabled={disabled} data-testid={testid} />;
    case 'choice':
      return <Select label={label} required={field.required} placeholder="Choose…" data={(field.options ?? []).map((o) => ({ value: o.code, label: o.display }))} value={(value as string) ?? null} onChange={(v) => onChange(v ?? undefined)} disabled={disabled} data-testid={testid} />;
  }
}
