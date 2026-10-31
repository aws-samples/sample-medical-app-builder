import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec, readiness } from '../spec';
import type { AppSpec } from '../spec';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { applyStamps, encodeValue, getPath, leafPaths, setPath, validateRecordEntry, type RecordFieldRule } from '../primitives/data/recordShape';
import { CLOSED_KINDS, OPEN_KINDS, encodingFor, kindIssue, requiredCoreElements, recordStamps, resolveElement } from '../spec/record';
import { compileShape } from '../spec/shapes';
import { renderManifest } from './testUtils';

/**
 * Declared-shape records end to end: the compiler resolves each field's path against the FHIR definitions and refuses
 * what does not fit; the runtime writes values at paths, validates the payload against the declared fields and refuses
 * anything outside them; the form on the therapy-plan page sets a Goal and writes a note, and the lists read them back.
 */

// A variable, not a literal: Vite would otherwise rewrite the URL into an asset import.
const therapyPlan = '../../specs/composed-therapy-plan.yaml';
const spec = () => parseYaml(readFileSync(new URL(therapyPlan, import.meta.url), 'utf8')) as AppSpec & { knobs: { sections: Record<string, unknown>[] } };

/** Mantine's Select in jsdom: the dropdown never leaves display:none, so pick the option inside the listbox the input points at. */
function pick(select: HTMLElement, text: string) {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  if (!listbox) throw new Error('no listbox');
  fireEvent.click(within(listbox).getByText(text));
}

describe('resolving paths against the FHIR definitions', () => {
  it('walks into complex types, through choice elements by their typed name, and stops at what does not exist', () => {
    expect(resolveElement('Goal', 'description')).toMatchObject({ type: 'CodeableConcept', min: 1 });
    expect(resolveElement('Goal', 'target[0].detailQuantity')).toMatchObject({ type: 'Quantity' });
    expect(resolveElement('Goal', 'target[0].dueDate')).toMatchObject({ type: 'date' });
    expect(resolveElement('Goal', 'note[0].text')).toMatchObject({ type: 'markdown' });
    expect(resolveElement('Goal', 'priority')).toMatchObject({ type: 'CodeableConcept' });
    expect(resolveElement('DocumentReference', 'content[0].attachment')).toMatchObject({ type: 'Attachment' });
    expect(resolveElement('Encounter', 'class')).toMatchObject({ type: 'Coding', min: 1 });
    expect(resolveElement('Encounter', 'period.start')).toMatchObject({ type: 'dateTime' });
    expect(resolveElement('Goal', 'nowhere')).toBeUndefined();
    expect(resolveElement('Goal', 'target[0].detailRange.low.nope')).toBeUndefined();
    expect(resolveElement('Goal', 'description[0]')).toBeUndefined(); // an index on a single-valued element
  });

  it('pairs field types with element types, and knows which required elements the stamps leave to the form', () => {
    expect(encodingFor('text', 'CodeableConcept')).toBe('concept_text');
    expect(encodingFor('text', 'Attachment')).toBe('attachment_text');
    expect(encodingFor('number', 'Quantity')).toBe('quantity');
    expect(encodingFor('number', 'CodeableConcept')).toBeUndefined();
    expect(encodingFor('choice', 'code')).toBe('code');
    expect(encodingFor('code', 'Coding')).toBe('coding');
    expect(requiredCoreElements('Goal', recordStamps('Goal', 'active'))).toEqual(['description']);
    expect(requiredCoreElements('Encounter', recordStamps('Encounter', 'finished'))).toEqual(['class']);
    expect(requiredCoreElements('DocumentReference', recordStamps('DocumentReference', 'current'))).toEqual(['content']);
    expect(requiredCoreElements('CarePlan', recordStamps('CarePlan', 'active'))).toEqual([]);
    expect(requiredCoreElements('Consent', recordStamps('Consent', 'active'))).toEqual(['scope', 'category']); // the kind and the document type are the form's; status, patient and the moment are stamped
    expect(resolveElement('Consent', 'provision.type')).toMatchObject({ type: 'code' });
    expect(resolveElement('Consent', 'provision.purpose[0]')).toMatchObject({ type: 'Coding' });
    expect(resolveElement('Consent', 'provision.period.end')).toMatchObject({ type: 'dateTime' });
  });

  it('the readiness check names a path that is nothing, a type that does not fit, a missing unit, an uncovered required element', () => {
    const base = spec();
    const goal = base.knobs.sections.find((s) => s.id === 'new_goal') as Record<string, unknown> & { fields: Record<string, unknown>[] };
    const withFields = (fields: unknown[], patch: Record<string, unknown> = {}) => ({ ...base, knobs: { ...base.knobs, sections: base.knobs.sections.map((s) => (s === goal ? { ...goal, ...patch, fields } : s)) } });
    const messages = (s: unknown) => readiness(s).missing.map((i) => i.message);
    const description = goal.fields[0]!;
    expect(messages(withFields([description, { id: 'x', label: 'X', type: 'text', path: 'target[0].nowhere' }]))).toContain('Goal has no element target[0].nowhere');
    expect(messages(withFields([description, { id: 'x', label: 'X', type: 'number', path: 'priority' }]))).toContain('a number field cannot be written into priority (CodeableConcept)');
    expect(messages(withFields([description, { id: 'x', label: 'X', type: 'number', path: 'target[0].detailQuantity' }]))).toContain('target[0].detailQuantity is a Quantity: give the unit');
    expect(messages(withFields([{ id: 'n', label: 'Remark', type: 'long_text', path: 'note[0].text' }]))).toContain('a Goal needs description: add a required field for it');
    expect(messages(withFields([{ ...description, required: false }]))).toContain('description is required on a Goal: mark the field required');
    expect(messages(withFields([description, { id: 's', label: 'S', type: 'choice', path: 'lifecycleStatus', options: [{ code: 'active', display: 'Active' }, { code: 'proposed', display: 'Proposed' }] }]))).toContain('lifecycleStatus is set by the platform (active); a form does not write it');
    expect(messages(withFields([description], { status: 'cancelled' }))).toContain('a Goal is written as one of proposed, planned, accepted, active');
    expect(readiness(base)).toEqual({ ready: true, missing: [] });
  });
});

describe('a kind the platform has not admitted', () => {
  const alertFile = '../../shapes/patient-alert.yaml'; // a variable, as above: Vite would rewrite a literal URL into an asset import
  const alert = parseYaml(readFileSync(new URL(alertFile, import.meta.url), 'utf8')) as { shape: Record<string, unknown> };
  const withShape = (patch: Record<string, unknown>) => ({ apiVersion: 'medapp.eu/v1', kind: 'RecordShape', shape: { ...alert.shape, ...patch } });
  const issues = (doc: unknown) => {
    const r = compileShape(doc);
    return r.ok ? [] : r.issues.map((i) => i.message);
  };

  it('resolves its paths from the lean definitions, compiles with the declared stamps, and is marked open', () => {
    expect(resolveElement('Flag', 'code')).toMatchObject({ type: 'CodeableConcept', min: 1 });
    expect(resolveElement('Flag', 'period.end')).toMatchObject({ type: 'dateTime' });
    expect(resolveElement('FamilyMemberHistory', 'relationship')).toMatchObject({ type: 'CodeableConcept', min: 1 });
    expect(resolveElement('Flag', 'nowhere')).toBeUndefined();
    const r = compileShape(withShape({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact.open_kind).toBe(true);
    expect(r.artifact.rules.stamps).toEqual([{ path: 'status', value: 'active' }, { path: 'subject', value: '$patient' }, { path: 'author', value: '$author' }, { path: 'period.start', value: '$today' }]);
    expect(requiredCoreElements('Flag', r.artifact.rules.stamps!)).toEqual(['code']); // the shape's required field
    for (const kind of OPEN_KINDS) expect(kindIssue(kind)).toBeUndefined();
    for (const kind of Object.keys(CLOSED_KINDS)) expect(kindIssue(kind)).toContain('is not a kind a shape may write');
    expect(kindIssue('Basic')).toContain('is not a kind the platform knows');
  });

  it('must name the patient, stamp elements of the right type, and leave the platform\'s own kinds alone', () => {
    expect(issues(withShape({ stamps: [{ path: 'status', value: 'active' }] }))).toContain('a Flag must name the patient: a stamp with value $patient on its patient or subject element');
    expect(issues(withShape({ stamps: [{ path: 'status', value: 'active' }, { path: 'subject', value: '$patient' }, { path: 'encounter', value: '$now' }] }))).toContain('$now needs dateTime or instant; encounter is Reference');
    expect(issues(withShape({ stamps: [{ path: 'status', value: 'active' }, { path: 'subject', value: '$patient' }, { path: 'code', value: 'x' }] }))).toContain('a literal stamp sets a primitive element; code is CodeableConcept');
    expect(issues(withShape({ status: 'active' }))).toContain('Flag is not a kind the platform admits: set its status as a stamp (e.g. { path: status, value: active })');
    expect(issues(withShape({ resource: 'MedicationRequest' }))[0]).toMatch(/^MedicationRequest is not a kind a shape may write: prescribing is an order/);
    expect(issues(withShape({ resource: 'Appointment' }))[0]).toContain('scheduling is the appointment extension');
    expect(issues(withShape({ resource: 'Observation' }))[0]).toContain('record_observation');
    expect(issues(withShape({ resource: 'Goal', stamps: [{ path: 'subject', value: '$patient' }] }))).toContain('the platform stamps a Goal itself (lifecycleStatus, subject, expressedBy, statusDate); stamps are declared only for a kind it has not admitted');
    // Without a status stamp the resource's required status is uncovered — said as any uncovered required element is.
    expect(issues(withShape({ stamps: [{ path: 'subject', value: '$patient' }] }))).toContain('a Flag needs status: add a required field for it');
  });
});

describe('the runtime: paths, encodings, the shape', () => {
  const fields: RecordFieldRule[] = [
    { id: 'goal', label: 'Goal', type: 'text', path: 'description', as: 'concept_text', required: true, max_length: 20 },
    { id: 'target', label: 'Target value', type: 'number', path: 'target[0].detailQuantity', as: 'quantity', unit: 's', range: { min: 0, max: 600 } },
    { id: 'due', label: 'Due', type: 'date', path: 'target[0].dueDate', as: 'date', future_days: 365 },
    { id: 'priority', label: 'Priority', type: 'choice', path: 'priority', as: 'codeable_concept', options: [{ code: 'high-priority', display: 'High' }], system: 'http://terminology.hl7.org/CodeSystem/goal-priority' },
  ];
  const rules = { resource: 'Goal', fields, stamps: recordStamps('Goal', 'active') };
  const now = new Date('2026-09-11T12:00:00Z');

  it('writes and reads values at paths, creating arrays and objects on the way', () => {
    const r: Record<string, unknown> = { resourceType: 'Goal' };
    setPath(r, 'target[0].detailQuantity', encodeValue(fields[1]!, 11.5));
    setPath(r, 'target[0].dueDate', encodeValue(fields[2]!, '2026-12-01'));
    setPath(r, 'description', encodeValue(fields[0]!, 'Walk unaided'));
    setPath(r, 'priority', encodeValue(fields[3]!, 'high-priority'));
    expect(r).toEqual({
      resourceType: 'Goal',
      target: [{ detailQuantity: { value: 11.5, unit: 's' }, dueDate: '2026-12-01' }],
      description: { text: 'Walk unaided' },
      priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/goal-priority', code: 'high-priority', display: 'High' }], text: 'High' },
    });
    expect(getPath(r, 'target[0].detailQuantity.value')).toBe(11.5);
    expect(leafPaths(r).sort()).toEqual(['description.text', 'priority.coding[0].code', 'priority.coding[0].display', 'priority.coding[0].system', 'priority.text', 'resourceType', 'target[0].detailQuantity.unit', 'target[0].detailQuantity.value', 'target[0].dueDate']);
    expect(encodeValue(fields[0]!, '')).toBeUndefined();
  });

  it('accepts the declared shape, refuses what is wrong, and refuses anything undeclared by name', () => {
    const good = { resourceType: 'Goal', description: { text: 'Walk unaided' }, target: [{ detailQuantity: { value: 11.5, unit: 's' }, dueDate: '2026-12-01' }] };
    expect(validateRecordEntry(rules, good, 'pat-kms-0001', now)).toEqual([]);
    expect(validateRecordEntry(rules, { resourceType: 'Condition' }, 'pat-kms-0001', now)).toEqual(['payload must be a Goal']);
    expect(validateRecordEntry(rules, { resourceType: 'Goal' }, 'pat-kms-0001', now)).toEqual(['"Goal" is required']);
    expect(validateRecordEntry(rules, { ...good, description: { text: 'A goal far longer than twenty' } }, 'pat-kms-0001', now)).toEqual(['"Goal": 29 characters is more than the 20 allowed']);
    expect(validateRecordEntry(rules, { ...good, target: [{ detailQuantity: { value: 900, unit: 's' } }] }, 'pat-kms-0001', now)).toEqual(['"Target value": 900 s is outside the accepted range 0–600']);
    expect(validateRecordEntry(rules, { ...good, target: [{ detailQuantity: { value: 11, unit: 'min' } }] }, 'pat-kms-0001', now)).toEqual(['"Target value": the value must be in s, not min']);
    expect(validateRecordEntry(rules, { ...good, target: [{ dueDate: '2028-01-01' }] }, 'pat-kms-0001', now)).toEqual(['"Due" must not be more than 365 days ahead']);
    expect(validateRecordEntry(rules, { ...good, priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/goal-priority', code: 'urgent' }] } }, 'pat-kms-0001', now)).toEqual(['"Priority": http://terminology.hl7.org/CodeSystem/goal-priority|urgent is not one of the offered options (http://terminology.hl7.org/CodeSystem/goal-priority|high-priority)']);
    // The shape is the whole form: an element the author did not declare does not get through, however valid FHIR it is.
    expect(validateRecordEntry(rules, { ...good, outcomeCode: [{ text: 'achieved' }], target: [{ ...good.target[0], measure: { text: 'TUG' } }] }, 'pat-kms-0001', now).sort()).toEqual(['element outcomeCode[0].text is not part of this form', 'element target[0].measure.text is not part of this form']);
    // What the platform stamps may be sent (it is overwritten) — a subject that is another patient may not.
    expect(validateRecordEntry(rules, { ...good, lifecycleStatus: 'completed', subject: { reference: 'Patient/pat-kms-0001' } }, 'pat-kms-0001', now)).toEqual([]);
    expect(validateRecordEntry(rules, { ...good, subject: { reference: 'Patient/pat-kms-0002' } }, 'pat-kms-0001', now)).toEqual(['subject Patient/pat-kms-0002 is not the patient in context']);
  });

  it('stamps fill in who, when and for whom', () => {
    const r: Record<string, unknown> = { resourceType: 'Goal', lifecycleStatus: 'completed' };
    applyStamps(r, rules.stamps, { patientId: 'pat-kms-0001', author: { identifier: { system: 'urn:medapp:cognito-sub', value: 'u1' } }, now: '2026-09-11T12:00:00.000Z' });
    expect(r).toEqual({ resourceType: 'Goal', lifecycleStatus: 'active', subject: { reference: 'Patient/pat-kms-0001' }, expressedBy: { identifier: { system: 'urn:medapp:cognito-sub', value: 'u1' } }, statusDate: '2026-09-11' });
  });
});

describe('the therapy-plan page', () => {
  it('lists the goal on record, refuses a goal outside its rules, saves one and shows it; writes a note the notes list shows', async () => {
    const result = compileSpec(spec(), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.manifest.metadata.intent_class).toBe('workflow');
    const audit: AuditRecord[] = [];
    await renderManifest(result.manifest, { role: 'physiotherapist', context: { patient_id: 'pat-kms-0001' }, executor: new MockPrimitiveExecutor(undefined, new Date(), 0), onAudit: (r) => audit.push(r) });
    const goals = await screen.findByTestId('resource-list');
    await waitFor(() => expect(goals).toHaveTextContent('Timed up-and-go under 12 seconds'));
    expect(goals).toHaveTextContent('12 s');

    const form = screen.getByTestId('record-entry-goal');
    fireEvent.click(within(form).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('"Goal" is required');
    expect(screen.getByTestId('entry-problems')).toHaveTextContent('"Measured by" is required');
    fireEvent.change(within(form).getByTestId('field-goal'), { target: { value: 'Climb a flight of stairs without the rail' } });
    pick(within(form).getByTestId('field-measure'), 'Walking distance');
    fireEvent.change(within(form).getByTestId('field-target'), { target: { value: '900' } });
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await waitFor(() => expect(screen.getByTestId('entry-problems')).toHaveTextContent('"Target value": 900 s is outside the accepted range 0–600'));
    expect(audit.filter((a) => a.primitive_id === 'p_new_goal')).toHaveLength(0);
    fireEvent.change(within(form).getByTestId('field-target'), { target: { value: '150' } });
    fireEvent.change(within(form).getByTestId('field-due'), { target: { value: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10) } });
    pick(within(form).getByTestId('field-priority'), 'Medium');
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('The goal is on the patient record.');
    await waitFor(() => expect(goals).toHaveTextContent('Climb a flight of stairs'), { timeout: 4000 });
    expect(goals).toHaveTextContent('Walking distance');
    expect(goals).toHaveTextContent('150 s');
    const write = audit.find((a) => a.primitive_id === 'p_new_goal');
    expect(write?.outcome).toBe('ok');
    expect(write?.detail).toMatch(/^Goal\/goal-mock-/);

    // The note: a DocumentReference carrying the text as a text/plain attachment, listed with the other notes.
    const noteForm = screen.getByTestId('record-entry-documentreference');
    pick(within(noteForm).getByTestId('field-type'), 'Progress note');
    fireEvent.change(within(noteForm).getByTestId('field-title'), { target: { value: 'Week 3' } });
    fireEvent.change(within(noteForm).getByTestId('field-text'), { target: { value: 'TUG 14 s today, down from 16.5. Stairs with the rail, no pain.' } });
    fireEvent.click(within(noteForm).getByTestId('entry-submit'));
    await waitFor(() => expect(screen.getAllByTestId('action-saved')).toHaveLength(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId('document-list')).toHaveTextContent('Week 3'), { timeout: 4000 });
    expect(screen.getByTestId('document-list')).toHaveTextContent('TUG 14 s today');
    expect(audit.find((a) => a.primitive_id === 'p_new_note')?.detail).toMatch(/^DocumentReference\/documentreference-mock-/);
  });
});
