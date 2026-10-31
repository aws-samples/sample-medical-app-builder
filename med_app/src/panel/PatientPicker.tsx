import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Select, Text, TextInput } from '@mantine/core';
import type { RuntimeConfig } from '../config/env';
import type { PatientHit } from '../primitives/data/types';
import { SEED } from '../primitives/data/mock/seed';

/** The synthetic patients, as Select options. */
export function seedPatientOptions(): { value: string; label: string }[] {
  return SEED.patients.map((p) => ({
    value: p.id ?? '',
    label: `${p.name?.[0]?.given?.join(' ')} ${p.name?.[0]?.family} · ${p.identifier?.[0]?.value ?? p.id}`,
  }));
}

/** One line per hit: name, birth date and sex, and an identifier if the record has one with a value. */
export function hitLabel(hit: PatientHit): string {
  const facts = [hit.birthDate, hit.gender].filter(Boolean).join(', ');
  const ident = hit.identifiers.find((i) => i.value && i.system !== 'urn:study-name')?.value;
  return [hit.name, facts, ident].filter(Boolean).join(' · ');
}

/** The patient chosen for this tab, so navigating to an app and back does not lose it (and disable every Open button). */
const REMEMBERED_KEY = 'medapp.launch.patient';

export interface RememberedPatient {
  readonly id: string;
  readonly label: string;
}

export function rememberedPatient(): RememberedPatient | null {
  try {
    const raw = sessionStorage.getItem(REMEMBERED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<RememberedPatient>) : null;
    return parsed && typeof parsed.id === 'string' && parsed.id && typeof parsed.label === 'string' ? { id: parsed.id, label: parsed.label } : null;
  } catch {
    return null;
  }
}

export function rememberPatient(patient: RememberedPatient | null): void {
  try {
    if (patient) sessionStorage.setItem(REMEMBERED_KEY, JSON.stringify(patient));
    else sessionStorage.removeItem(REMEMBERED_KEY);
  } catch {
    // storage unavailable: the selection simply lives as long as the component
  }
}

/**
 * Who a single-patient app is about. In mock mode the synthetic patients are a list. In dispatcher mode the record
 * is the hospital's and holds patients the panel has never heard of, so the picker lists the first page of the
 * record (by family name) and searches it by name through the dispatcher (`GET /patients`, audited) — type two
 * letters, pick a hit; a typed id still wins, for a patient known by id. The choice is remembered for the tab
 * (`sessionStorage`), so opening an app and coming back keeps the patient and the Open buttons enabled. A hospital
 * launch (the EHR's context) replaces this. Used by the launcher and by the runtime when an app is opened without
 * a patient.
 */
/** What the choice does, said once: it is the patient an app opens for — it does not narrow the list of apps. */
export const PICKER_PURPOSE = 'Whose record a single-patient app shows when you open it. The list of apps is not filtered by this; population apps ignore it.';
/** The same, once someone is chosen — with the way back to no one. */
export const pickerChosen = (name: string) => `Single-patient apps open for ${name}. The list of apps is not filtered by this; population apps ignore it. Clear (×) to choose no one.`;

export function PatientPicker({
  value,
  onChange,
  config,
  search,
  purpose = PICKER_PURPOSE,
  hint = null,
}: {
  value: string;
  /** The chosen patient id, or '' when the choice is cleared. */
  onChange: (patientId: string) => void;
  config: RuntimeConfig;
  /** The lookup by name; without it (mock mode) the seed list is shown. */
  search?: (name: string) => Promise<PatientHit[]>;
  /** The sentence under the control that says what choosing does, until a patient is chosen. */
  purpose?: string;
  hint?: string | null;
}) {
  const dispatcherMode = config.data.mode === 'dispatcher';
  const [freeId, setFreeId] = useState('');

  return (
    <Group align="flex-end" gap="md">
      {dispatcherMode && search ? <PatientSearch value={value} onChange={onChange} search={search} purpose={purpose} disabled={Boolean(freeId.trim())} /> : <SeedList value={value} onChange={onChange} purpose={purpose} disabled={Boolean(freeId.trim())} />}
      {dispatcherMode && (
        <TextInput
          label="Or enter a patient id"
          description="Used instead of the selected patient"
          placeholder="Patient id"
          value={freeId}
          onChange={(e) => {
            const typed = e.currentTarget.value;
            setFreeId(typed);
            if (typed.trim()) onChange(typed.trim());
          }}
          w={260}
        />
      )}
      {hint && (
        <Text size="sm" c="dimmed" pb={6}>
          {hint}
        </Text>
      )}
    </Group>
  );
}

function SeedList({ value, onChange, purpose, disabled }: { value: string; onChange: (id: string) => void; purpose: string; disabled: boolean }) {
  const patients = useMemo(seedPatientOptions, []);
  const selected = patients.find((p) => p.value === value);
  return (
    <Select
      label="Patient"
      description={selected ? pickerChosen(selected.label.split(' · ')[0] ?? selected.label) : purpose}
      placeholder="No patient chosen"
      data={patients}
      value={selected?.value ?? null}
      onChange={(v) => onChange(v ?? '')}
      w={420}
      clearable
      clearButtonProps={{ 'aria-label': 'Clear the patient' }}
      disabled={disabled}
      data-testid="patient-seed"
    />
  );
}

const SEARCH_DELAY_MS = 300;

function PatientSearch({ value, onChange, search, purpose, disabled }: { value: string; onChange: (id: string) => void; search: (name: string) => Promise<PatientHit[]>; purpose: string; disabled: boolean }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [firstPage, setFirstPage] = useState<PatientHit[] | null>(null);
  const [state, setState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<RememberedPatient | null>(() => rememberedPatient());
  const latest = useRef(0);

  // The remembered choice is this tab's selection until something else is picked: restore it once, on mount.
  useEffect(() => {
    if (!value && remembered) onChange(remembered.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // The first page of the record (by family name), fetched once, so the list is not empty before anyone types.
  useEffect(() => {
    let cancelled = false;
    search('').then(
      (found) => {
        if (!cancelled) setFirstPage(found);
      },
      (err: unknown) => {
        if (cancelled) return;
        setFirstPage([]);
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [search]);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      if (state === 'searching') setState('idle');
      return undefined;
    }
    const call = ++latest.current;
    const timer = window.setTimeout(() => {
      setState('searching');
      search(text).then(
        (found) => {
          if (call !== latest.current) return; // a later keystroke owns the box now
          setHits(found);
          setState('idle');
          setError(null);
        },
        (err: unknown) => {
          if (call !== latest.current) return;
          setState('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      );
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` is read, not a trigger
  }, [query, search]);

  // What the list shows: search hits once there is a query, else the first page; the remembered patient is always an
  // option so the control can display the selection without a search.
  const shown = query.trim().length >= 2 ? hits : (firstPage ?? []);
  const options = shown.map((h) => ({ value: h.id, label: hitLabel(h) }));
  if (remembered && !options.some((o) => o.value === remembered.id)) options.unshift({ value: remembered.id, label: remembered.label });
  const chosenLabel = options.find((o) => o.value === value)?.label;
  const nothing =
    state === 'searching'
      ? 'Searching…'
      : state === 'error'
        ? error
        : query.trim().length >= 2
          ? 'No patient by that name'
          : firstPage === null
            ? 'Loading the record…'
            : 'Type two letters of the name';

  return (
    <Select
      label="Patient"
      description={chosenLabel ? pickerChosen(chosenLabel.split(' · ')[0] ?? chosenLabel) : `${purpose} ${firstPage && firstPage.length ? `The first ${firstPage.length} patients of the record by family name are listed; search by name for others.` : 'Search the record by name.'}`}
      placeholder="Name…"
      searchable
      searchValue={query}
      onSearchChange={setQuery}
      data={options}
      value={options.some((o) => o.value === value) ? value : null}
      onChange={(v) => {
        if (!v) {
          // Cleared (×): back to no patient, for this tab too — a reload must not bring the old choice back.
          setRemembered(null);
          rememberPatient(null);
          onChange('');
          return;
        }
        const label = options.find((o) => o.value === v)?.label ?? v;
        const choice = { id: v, label };
        setRemembered(choice);
        rememberPatient(choice);
        onChange(v);
      }}
      nothingFoundMessage={nothing}
      error={state === 'error' ? error : undefined}
      w={420}
      clearable
      clearButtonProps={{ 'aria-label': 'Clear the patient' }}
      disabled={disabled}
      data-testid="patient-search"
    />
  );
}
