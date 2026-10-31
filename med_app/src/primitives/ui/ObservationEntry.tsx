import { useMemo, useState } from 'react';
import type { Observation } from '@medplum/fhirtypes';
import { Alert, Button, Group, List, NumberInput, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';
import { LATERALITY_CODE, SIDE_WORD, SNOMED_SYSTEM, type Side } from '../data/fhirHelpers';
import { validateObservationEntry, type ObservationEntryRules } from '../data/writes';
import { ActionForm } from './ActionForm';

export interface EntryCode {
  readonly system: string;
  readonly code: string;
  readonly display?: string;
}

export interface EntryComponent {
  readonly code: EntryCode;
  readonly label: string;
  readonly range?: { readonly min?: number; readonly max?: number };
}

export interface ObservationEntryFormProps {
  /** The manifest action that records the value (must run write.fhir.observation.create). */
  readonly action: string;
  /** `$ui` key under which the produced Observation is handed to the action. */
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  /** What is recorded: the Observation code (a panel code when `components` are given). */
  readonly code: EntryCode;
  readonly label?: string;
  /** For a panel such as blood pressure: one input per component. */
  readonly components?: readonly EntryComponent[];
  readonly unit: string;
  /** Plausibility range of a single value (components carry their own). */
  readonly range?: { readonly min?: number; readonly max?: number };
  /** Relations between a panel's components (qualified codes): `component` must be above `above` — systolic above diastolic. */
  readonly rules?: readonly { readonly component: string; readonly above: string; readonly message?: string }[];
  readonly max_backdate_days?: number;
  /** Offer a free-text remark stored as Observation.note. */
  readonly note?: boolean;
  /** Ask which side of the body — left, right, both — written to bodySite as the SNOMED laterality qualifier; `required` must be answered. */
  readonly side?: 'optional' | 'required';
  /** The structure measured, stamped into bodySite beside the side. */
  readonly body_site?: EntryCode;
  /** Test conditions the clinician picks one of (→ Observation.method). */
  readonly conditions?: readonly EntryCode[];
}

const qualified = (c: EntryCode): string => `${c.system}|${c.code}`;

/** Local wall-clock `YYYY-MM-DDTHH:mm` for a datetime-local input. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Record one measurement — a blood pressure, a weight, an HbA1c — as an Observation the rest of the
 * record can see. The form only produces the payload: code, value(s), date and an optional remark;
 * the dispatcher validates it against the same rules shown here, stamps who, when and through which
 * app, and refuses anything outside the form's declared code, unit, range and date window.
 */
export function ObservationEntryForm({ action, state_key = 'observation_entry', title, submit_label = 'Record', code, label, components, unit, range, rules: relations, max_backdate_days = 7, note = true, side, body_site, conditions }: ObservationEntryFormProps) {
  const rules = useMemo<ObservationEntryRules>(() => {
    const ranges: Record<string, { min?: number; max?: number }> = {};
    if (components?.length) {
      for (const c of components) if (c.range) ranges[qualified(c.code)] = c.range;
    } else if (range) {
      ranges[qualified(code)] = range;
    }
    return { codes: [qualified(code)], components: components?.length ? components.map((c) => qualified(c.code)) : undefined, unit, ranges, rules: relations, max_backdate_days, side, body_site: body_site ? qualified(body_site) : undefined, conditions: conditions?.length ? conditions.map(qualified) : undefined };
  }, [code, components, unit, range, relations, max_backdate_days, side, body_site, conditions]);

  return (
    <ActionForm action={action} title={title ?? label ?? code.display ?? 'Record a measurement'} subtitle={`Saved to the patient record as ${code.display ?? code.code}${unit ? ` (${unit})` : ''}`} another_label="Record another" testid="observation-entry">
      {({ formKey, running, submit }) => <EntryFields key={formKey} rules={rules} code={code} components={components} unit={unit} range={range} note={note} side={side} bodySite={body_site} conditions={conditions} running={running} submitLabel={submit_label} onSubmit={(obs) => submit({ [state_key]: obs })} />}
    </ActionForm>
  );
}

function EntryFields({
  rules,
  code,
  components,
  unit,
  range,
  note,
  side,
  bodySite,
  conditions,
  running,
  submitLabel,
  onSubmit,
}: {
  rules: ObservationEntryRules;
  code: EntryCode;
  components?: readonly EntryComponent[];
  unit: string;
  range?: { min?: number; max?: number };
  note: boolean;
  side?: 'optional' | 'required';
  bodySite?: EntryCode;
  conditions?: readonly EntryCode[];
  running: boolean;
  submitLabel: string;
  onSubmit: (observation: Observation) => void;
}) {
  const { context } = useRenderContext();
  const patientId = typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;
  const [values, setValues] = useState<Record<string, number | string>>({});
  const [when, setWhen] = useState(() => localInputValue(new Date()));
  const [remark, setRemark] = useState('');
  const [chosenSide, setChosenSide] = useState<Side | null>(null);
  const [condition, setCondition] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const quantity = (v: number | string | undefined) => (typeof v === 'number' ? { value: v, unit } : v === '' || v === undefined ? undefined : { value: Number(v), unit });

  function build(): Observation {
    const effective = when ? new Date(when).toISOString() : new Date().toISOString();
    const obs: Observation = {
      resourceType: 'Observation',
      status: 'final',
      identifier: [{ system: 'urn:medapp:submission', value: crypto.randomUUID() }],
      code: { coding: [{ system: code.system, code: code.code, display: code.display }], text: code.display },
      subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
      effectiveDateTime: effective,
      ...(remark.trim() ? { note: [{ text: remark.trim() }] } : {}),
    };
    // The structure and the side as bodySite codings; the side is the SNOMED laterality qualifier the whole platform reads.
    const siteCodings = [
      ...(bodySite ? [{ system: bodySite.system, code: bodySite.code, display: bodySite.display }] : []),
      ...(chosenSide ? [{ system: SNOMED_SYSTEM, code: LATERALITY_CODE[chosenSide], display: SIDE_WORD[chosenSide].replace(/^\w/, (c) => c.toUpperCase()) }] : []),
    ];
    if (siteCodings.length) obs.bodySite = { coding: siteCodings, text: [bodySite?.display ?? bodySite?.code, chosenSide ? SIDE_WORD[chosenSide] : undefined].filter(Boolean).join(' · ') };
    const picked = condition ? conditions?.find((c) => qualified(c) === condition) : undefined;
    if (picked) obs.method = { coding: [{ system: picked.system, code: picked.code, display: picked.display }], text: picked.display ?? picked.code };
    if (components?.length) {
      obs.component = components.map((c) => ({ code: { coding: [{ system: c.code.system, code: c.code.code, display: c.code.display }] }, valueQuantity: quantity(values[qualified(c.code)]) }));
    } else {
      obs.valueQuantity = quantity(values['value']);
    }
    return obs;
  }

  function trySubmit() {
    const obs = build();
    const found = validateObservationEntry(rules, obs, patientId ?? '', new Date());
    setProblems(found);
    if (found.length === 0) onSubmit(obs);
  }

  const hint = (r?: { min?: number; max?: number }) => (r && (r.min !== undefined || r.max !== undefined) ? `${r.min ?? '…'}–${r.max ?? '…'} ${unit}` : unit);

  return (
    <Stack gap="sm">
      {components?.length ? (
        <Group gap="md" align="flex-end" wrap="wrap">
          {components.map((c) => (
            <NumberInput
              key={c.code.code}
              label={c.label}
              description={hint(c.range)}
              suffix={` ${unit}`}
              value={values[qualified(c.code)] ?? ''}
              onChange={(v) => setValues((prev) => ({ ...prev, [qualified(c.code)]: v }))}
              clampBehavior="none" // an implausible entry is refused with a reason, never silently clamped
              w={180}
              disabled={running}
              data-testid={`entry-${c.code.code}`}
            />
          ))}
        </Group>
      ) : (
        <NumberInput label={code.display ?? code.code} description={hint(range)} suffix={` ${unit}`} value={values['value'] ?? ''} onChange={(v) => setValues({ value: v })} clampBehavior="none" w={220} disabled={running} data-testid="entry-value" />
      )}
      {(side || conditions?.length) && (
        <Group gap="md" align="flex-end" wrap="wrap">
          {side && (
            <Select
              label={bodySite?.display ? `Side (${bodySite.display})` : 'Side'}
              required={side === 'required'}
              placeholder="Left, right or both"
              data={(['left', 'right', 'both'] as Side[]).map((v) => ({ value: v, label: SIDE_WORD[v].replace(/^\w/, (c) => c.toUpperCase()) }))}
              value={chosenSide}
              onChange={(v) => setChosenSide((v as Side | null) ?? null)}
              clearable={side === 'optional'}
              w={200}
              disabled={running}
              data-testid="entry-side"
            />
          )}
          {conditions?.length ? <Select label="Test conditions" placeholder="As measured…" data={conditions.map((c) => ({ value: qualified(c), label: c.display ?? c.code }))} value={condition} onChange={setCondition} clearable w={260} disabled={running} data-testid="entry-conditions" /> : null}
        </Group>
      )}
      <Group gap="md" align="flex-end" wrap="wrap">
        <TextInput type="datetime-local" label="Measured at" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={240} disabled={running} data-testid="entry-when" />
        {note && <Textarea label="Remark (optional)" value={remark} onChange={(e) => setRemark(e.currentTarget.value)} autosize minRows={1} maxRows={3} style={{ flex: 1, minWidth: 240 }} disabled={running} data-testid="entry-note" />}
      </Group>
      {problems.length > 0 && (
        <Alert color="red" variant="light" title="Please check the entry" data-testid="entry-problems">
          <List size="sm">
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          The platform records who entered it and when; the time above is the time of the measurement.
        </Text>
        <Button onClick={trySubmit} loading={running} data-testid="entry-submit">
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}
