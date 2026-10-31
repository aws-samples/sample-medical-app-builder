import { useState } from 'react';
import type { AllergyIntolerance, CodeableConcept, Condition, Procedure } from '@medplum/fhirtypes';
import { Alert, Button, Group, List, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';
import { SEVERITY_CODES, validateAllergyEntry, validateConditionEntry, validateProcedureEntry } from '../data/writes';
import { ActionForm } from './ActionForm';
import type { EntryCode } from './ObservationEntry';

/**
 * The coded entries: add a problem, record an allergy, record a procedure — each a short form over a fixed list
 * of codes the app's author chose (and the reviewer signed), with the few fields that belong to the entry. The
 * form only produces the payload; the dispatcher validates it against the same rules shown here, stamps who
 * recorded it, when and through which app, and refuses anything the manifest did not allow. Like the measurement
 * entry (ObservationEntry.tsx), saving / saved / error / "record another" come from ActionForm.
 */

const qualified = (c: EntryCode): string => `${c.system}|${c.code}`;
const SNOMED = 'http://snomed.info/sct';
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');

/** The list the clinician picks from: display text first, the code under it, searchable by either. */
function CodeSelect({ codes, value, onChange, label, disabled, testid }: { codes: readonly EntryCode[]; value: string | null; onChange: (v: string | null) => void; label: string; disabled: boolean; testid: string }) {
  return (
    <Select
      label={label}
      placeholder="Choose…"
      data={codes.map((c) => ({ value: qualified(c), label: c.display ? `${c.display} (${c.code})` : c.code }))}
      value={value}
      onChange={onChange}
      searchable
      nothingFoundMessage="Not one this form may record"
      required
      disabled={disabled}
      style={{ flex: 1, minWidth: 260 }}
      data-testid={testid}
    />
  );
}

function conceptOf(codes: readonly EntryCode[], value: string | null): CodeableConcept | undefined {
  const c = codes.find((x) => qualified(x) === value);
  return c ? { coding: [{ system: c.system, code: c.code, ...(c.display ? { display: c.display } : {}) }], ...(c.display ? { text: c.display } : {}) } : undefined;
}

function submissionIdentifier(): { system: string; value: string }[] {
  return [{ system: 'urn:medapp:submission', value: crypto.randomUUID() }];
}

function Problems({ problems }: { problems: readonly string[] }) {
  if (!problems.length) return null;
  return (
    <Alert color="red" variant="light" title="Please check the entry" data-testid="entry-problems">
      <List size="sm">
        {problems.map((p) => (
          <List.Item key={p}>{p}</List.Item>
        ))}
      </List>
    </Alert>
  );
}

function Footer({ running, label, onSubmit, hint }: { running: boolean; label: string; onSubmit: () => void; hint: string }) {
  return (
    <Group justify="space-between" align="center" wrap="nowrap">
      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
        {hint}
      </Text>
      <Button onClick={onSubmit} loading={running} style={{ flex: 'none' }} data-testid="entry-submit">
        {label}
      </Button>
    </Group>
  );
}

function usePatientId(): string | undefined {
  const { context } = useRenderContext();
  return typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;
}

const noteOf = (remark: string) => (remark.trim() ? { note: [{ text: remark.trim() }] } : {});

// ── a problem ────────────────────────────────────────────────────────────────────────────────

export interface ProblemEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  /** The diagnoses the form may add. */
  readonly codes: readonly EntryCode[];
  /** Verification statuses offered; the first is preselected. */
  readonly verification?: readonly string[];
  readonly onset?: boolean;
  readonly severity?: boolean;
  readonly note?: boolean;
}

export function ProblemEntryForm({ action, state_key = 'problem_entry', title, submit_label = 'Add problem', codes, verification = ['confirmed', 'provisional'], onset = true, severity = false, note = true }: ProblemEntryFormProps) {
  return (
    <ActionForm action={action} title={title ?? 'Add a problem'} subtitle="Added to the problem list as an active diagnosis; its status is changed from the list later." another_label="Add another" testid="problem-entry">
      {({ formKey, running, submit }) => <ProblemFields key={formKey} codes={codes} verification={verification} onset={onset} severity={severity} note={note} running={running} submitLabel={submit_label} onSubmit={(c) => submit({ [state_key]: c })} />}
    </ActionForm>
  );
}

function ProblemFields({ codes, verification, onset, severity, note, running, submitLabel, onSubmit }: { codes: readonly EntryCode[]; verification: readonly string[]; onset: boolean; severity: boolean; note: boolean; running: boolean; submitLabel: string; onSubmit: (c: Condition) => void }) {
  const patientId = usePatientId();
  const [code, setCode] = useState<string | null>(codes.length === 1 ? qualified(codes[0]!) : null);
  const [verified, setVerified] = useState<string>(verification[0] ?? 'confirmed');
  const [sev, setSev] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  function build(): Condition {
    return {
      resourceType: 'Condition',
      identifier: submissionIdentifier(),
      code: conceptOf(codes, code) ?? { text: '' },
      ...(patientId ? { subject: { reference: `Patient/${patientId}` } } : { subject: {} }),
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: verified }] },
      ...(sev ? { severity: { coding: [{ system: SNOMED, code: sev, display: titleCase(SEVERITY_CODES[sev] ?? sev) }] } } : {}),
      ...(when ? { onsetDateTime: when } : {}),
      ...noteOf(remark),
    };
  }

  function trySubmit() {
    const found = code ? validateConditionEntry({ codes: codes.map(qualified), verification, severity }, build(), patientId ?? '', new Date()) : ['choose the diagnosis to add'];
    setProblems(found);
    if (found.length === 0) onSubmit(build());
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-end" wrap="wrap">
        <CodeSelect codes={codes} value={code} onChange={setCode} label="Diagnosis" disabled={running} testid="entry-code" />
        {verification.length > 1 && <Select label="Verification" data={verification.map((v) => ({ value: v, label: titleCase(v) }))} value={verified} onChange={(v) => v && setVerified(v)} allowDeselect={false} w={180} disabled={running} data-testid="entry-verification" />}
      </Group>
      <Group gap="md" align="flex-end" wrap="wrap">
        {onset && <TextInput type="date" label="Onset (optional)" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={200} disabled={running} data-testid="entry-onset" />}
        {severity && <Select label="Severity (optional)" placeholder="—" data={Object.entries(SEVERITY_CODES).map(([value, label]) => ({ value, label: titleCase(label) }))} value={sev} onChange={setSev} clearable w={200} disabled={running} data-testid="entry-severity" />}
        {note && <Textarea label="Remark (optional)" value={remark} onChange={(e) => setRemark(e.currentTarget.value)} autosize minRows={1} maxRows={3} style={{ flex: 1, minWidth: 240 }} disabled={running} data-testid="entry-note" />}
      </Group>
      <Problems problems={problems} />
      <Footer running={running} label={submitLabel} onSubmit={trySubmit} hint="The platform records who added it and when." />
    </Stack>
  );
}

// ── an allergy or intolerance ────────────────────────────────────────────────────────────────

export interface AllergyEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  /** The substances or agents the form may record. */
  readonly codes: readonly EntryCode[];
  readonly types?: readonly string[];
  readonly categories?: readonly string[];
  readonly verification?: readonly string[];
  readonly criticality?: boolean;
  readonly reaction?: boolean;
  readonly onset?: boolean;
  readonly note?: boolean;
}

const CRITICALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'unable-to-assess', label: 'Unable to assess' },
];
const REACTION_SEVERITY_OPTIONS = ['mild', 'moderate', 'severe'].map((v) => ({ value: v, label: titleCase(v) }));

export function AllergyEntryForm({
  action,
  state_key = 'allergy_entry',
  title,
  submit_label = 'Record allergy',
  codes,
  types = ['allergy', 'intolerance'],
  categories = ['medication', 'food', 'environment'],
  verification = ['confirmed', 'unconfirmed'],
  criticality = true,
  reaction = true,
  onset = true,
  note = true,
}: AllergyEntryFormProps) {
  return (
    <ActionForm action={action} title={title ?? 'Record an allergy or intolerance'} subtitle="Recorded on the allergy list as active." another_label="Record another" testid="allergy-entry">
      {({ formKey, running, submit }) => (
        <AllergyFields key={formKey} codes={codes} types={types} categories={categories} verification={verification} criticality={criticality} reaction={reaction} onset={onset} note={note} running={running} submitLabel={submit_label} onSubmit={(a) => submit({ [state_key]: a })} />
      )}
    </ActionForm>
  );
}

function AllergyFields({
  codes,
  types,
  categories,
  verification,
  criticality,
  reaction,
  onset,
  note,
  running,
  submitLabel,
  onSubmit,
}: {
  codes: readonly EntryCode[];
  types: readonly string[];
  categories: readonly string[];
  verification: readonly string[];
  criticality: boolean;
  reaction: boolean;
  onset: boolean;
  note: boolean;
  running: boolean;
  submitLabel: string;
  onSubmit: (a: AllergyIntolerance) => void;
}) {
  const patientId = usePatientId();
  const [code, setCode] = useState<string | null>(codes.length === 1 ? qualified(codes[0]!) : null);
  const [type, setType] = useState<string>(types[0] ?? 'allergy');
  const [category, setCategory] = useState<string>(categories[0] ?? 'medication');
  const [verified, setVerified] = useState<string>(verification[0] ?? 'confirmed');
  const [crit, setCrit] = useState<string | null>(null);
  const [manifestation, setManifestation] = useState('');
  const [reactionSeverity, setReactionSeverity] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  function build(): AllergyIntolerance {
    const reactions = reaction && manifestation.trim() ? { reaction: [{ manifestation: [{ text: manifestation.trim() }], ...(reactionSeverity ? { severity: reactionSeverity as 'mild' | 'moderate' | 'severe' } : {}) }] } : {};
    return {
      resourceType: 'AllergyIntolerance',
      identifier: submissionIdentifier(),
      code: conceptOf(codes, code) ?? { text: '' },
      patient: patientId ? { reference: `Patient/${patientId}` } : {},
      type: type as 'allergy' | 'intolerance',
      category: [category as 'food' | 'medication' | 'environment' | 'biologic'],
      verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: verified }] },
      ...(crit ? { criticality: crit as 'low' | 'high' | 'unable-to-assess' } : {}),
      ...(when ? { onsetDateTime: when } : {}),
      ...reactions,
      ...noteOf(remark),
    };
  }

  function trySubmit() {
    const found = code ? validateAllergyEntry({ codes: codes.map(qualified), types, categories, verification, criticality, reaction }, build(), patientId ?? '', new Date()) : ['choose the substance or agent'];
    setProblems(found);
    if (found.length === 0) onSubmit(build());
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-end" wrap="wrap">
        <CodeSelect codes={codes} value={code} onChange={setCode} label="Substance or agent" disabled={running} testid="entry-code" />
        {types.length > 1 && <Select label="Type" data={types.map((t) => ({ value: t, label: titleCase(t) }))} value={type} onChange={(v) => v && setType(v)} allowDeselect={false} w={160} disabled={running} data-testid="entry-type" />}
        {categories.length > 1 && <Select label="Category" data={categories.map((c) => ({ value: c, label: titleCase(c) }))} value={category} onChange={(v) => v && setCategory(v)} allowDeselect={false} w={170} disabled={running} data-testid="entry-category" />}
      </Group>
      <Group gap="md" align="flex-end" wrap="wrap">
        {criticality && <Select label="Criticality (optional)" placeholder="—" data={CRITICALITY_OPTIONS} value={crit} onChange={setCrit} clearable w={200} disabled={running} data-testid="entry-criticality" />}
        {verification.length > 1 && <Select label="Verification" data={verification.map((v) => ({ value: v, label: titleCase(v) }))} value={verified} onChange={(v) => v && setVerified(v)} allowDeselect={false} w={180} disabled={running} data-testid="entry-verification" />}
        {onset && <TextInput type="date" label="First noticed (optional)" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={200} disabled={running} data-testid="entry-onset" />}
      </Group>
      {reaction && (
        <Group gap="md" align="flex-end" wrap="wrap">
          <TextInput label="Reaction (optional)" placeholder="What happened, e.g. rash, angio-oedema" value={manifestation} onChange={(e) => setManifestation(e.currentTarget.value)} style={{ flex: 1, minWidth: 260 }} disabled={running} data-testid="entry-reaction" />
          <Select label="Reaction severity" placeholder="—" data={REACTION_SEVERITY_OPTIONS} value={reactionSeverity} onChange={setReactionSeverity} clearable w={180} disabled={running || !manifestation.trim()} data-testid="entry-reaction-severity" />
        </Group>
      )}
      {note && <Textarea label="Remark (optional)" value={remark} onChange={(e) => setRemark(e.currentTarget.value)} autosize minRows={1} maxRows={3} disabled={running} data-testid="entry-note" />}
      <Problems problems={problems} />
      <Footer running={running} label={submitLabel} onSubmit={trySubmit} hint="The platform records who recorded it and when." />
    </Stack>
  );
}

// ── a procedure ──────────────────────────────────────────────────────────────────────────────

export interface ProcedureEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  /** The procedures the form may record. */
  readonly codes: readonly EntryCode[];
  /** Statuses offered; one entry means it is fixed and not shown. */
  readonly statuses?: readonly string[];
  readonly max_backdate_days?: number;
  readonly body_site?: boolean;
  readonly outcome?: boolean;
  readonly note?: boolean;
}

/** Local wall-clock `YYYY-MM-DDTHH:mm` for a datetime-local input. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ProcedureEntryForm({ action, state_key = 'procedure_entry', title, submit_label = 'Record procedure', codes, statuses = ['completed'], max_backdate_days = 30, body_site = false, outcome = false, note = true }: ProcedureEntryFormProps) {
  return (
    <ActionForm action={action} title={title ?? 'Record a procedure'} subtitle="Added to the patient's procedures." another_label="Record another" testid="procedure-entry">
      {({ formKey, running, submit }) => (
        <ProcedureFields key={formKey} codes={codes} statuses={statuses} maxBackdateDays={max_backdate_days} bodySite={body_site} outcome={outcome} note={note} running={running} submitLabel={submit_label} onSubmit={(p) => submit({ [state_key]: p })} />
      )}
    </ActionForm>
  );
}

function ProcedureFields({ codes, statuses, maxBackdateDays, bodySite, outcome, note, running, submitLabel, onSubmit }: { codes: readonly EntryCode[]; statuses: readonly string[]; maxBackdateDays: number; bodySite: boolean; outcome: boolean; note: boolean; running: boolean; submitLabel: string; onSubmit: (p: Procedure) => void }) {
  const patientId = usePatientId();
  const [code, setCode] = useState<string | null>(codes.length === 1 ? qualified(codes[0]!) : null);
  const [status, setStatus] = useState<string>(statuses[0] ?? 'completed');
  const [when, setWhen] = useState(() => localInputValue(new Date()));
  const [site, setSite] = useState('');
  const [result, setResult] = useState('');
  const [remark, setRemark] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  function build(): Procedure {
    return {
      resourceType: 'Procedure',
      identifier: submissionIdentifier(),
      status: status as Procedure['status'],
      code: conceptOf(codes, code) ?? { text: '' },
      subject: patientId ? { reference: `Patient/${patientId}` } : {},
      ...(when ? { performedDateTime: new Date(when).toISOString() } : {}),
      ...(bodySite && site.trim() ? { bodySite: [{ text: site.trim() }] } : {}),
      ...(outcome && result.trim() ? { outcome: { text: result.trim() } } : {}),
      ...noteOf(remark),
    };
  }

  function trySubmit() {
    const found = code ? validateProcedureEntry({ codes: codes.map(qualified), statuses, max_backdate_days: maxBackdateDays, body_site: bodySite, outcome }, build(), patientId ?? '', new Date()) : ['choose the procedure'];
    setProblems(found);
    if (found.length === 0) onSubmit(build());
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-end" wrap="wrap">
        <CodeSelect codes={codes} value={code} onChange={setCode} label="Procedure" disabled={running} testid="entry-code" />
        {statuses.length > 1 && <Select label="Status" data={statuses.map((s) => ({ value: s, label: titleCase(s) }))} value={status} onChange={(v) => v && setStatus(v)} allowDeselect={false} w={170} disabled={running} data-testid="entry-status" />}
        <TextInput type="datetime-local" label="Performed at" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={240} disabled={running} data-testid="entry-when" />
      </Group>
      {(bodySite || outcome) && (
        <Group gap="md" align="flex-end" wrap="wrap">
          {bodySite && <TextInput label="Body site (optional)" value={site} onChange={(e) => setSite(e.currentTarget.value)} style={{ flex: 1, minWidth: 200 }} disabled={running} data-testid="entry-body-site" />}
          {outcome && <TextInput label="Outcome (optional)" value={result} onChange={(e) => setResult(e.currentTarget.value)} style={{ flex: 1, minWidth: 200 }} disabled={running} data-testid="entry-outcome" />}
        </Group>
      )}
      {note && <Textarea label="Remark (optional)" value={remark} onChange={(e) => setRemark(e.currentTarget.value)} autosize minRows={1} maxRows={3} disabled={running} data-testid="entry-note" />}
      <Problems problems={problems} />
      <Footer running={running} label={submitLabel} onSubmit={trySubmit} hint={`The platform records who recorded it and when; the time above is when it was performed (up to ${maxBackdateDays} days ago).`} />
    </Stack>
  );
}
