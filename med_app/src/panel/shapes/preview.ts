import { parse as parseYaml } from 'yaml';
import type { SpecIssue } from '../../spec/common';
import { resolveElement } from '../../spec/record';
import { RecordShapeSchema, shapeIssues, type RecordShapeDoc } from '../../spec/shapes';

/**
 * What the shape editor works on: the YAML text of a RecordShape document, parsed and checked as it is typed, and a
 * synthetic composed page around the shape — what the patient has on record of that resource type beside the form the
 * shape describes — compiled and rendered on the synthetic record, so a shape is seen as a form before it is published.
 * The preview declares the shape inline (resource, fields, status) rather than by reference: a draft has no published
 * version to refer to, and that is the point of previewing it.
 */

export type ParsedShape = { readonly ok: true; readonly doc: RecordShapeDoc; readonly raw: unknown } | { readonly ok: false; readonly raw: unknown; readonly issues: readonly SpecIssue[] };

export function parseShapeYaml(text: string): ParsedShape {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { ok: false, raw: undefined, issues: [{ path: '(yaml)', message: err instanceof Error ? err.message.split('\n')[0] ?? 'does not parse' : 'does not parse' }] };
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') return { ok: false, raw, issues: [{ path: '(root)', message: 'a RecordShape document: apiVersion, kind, shape' }] };
  const issues = shapeIssues(raw);
  if (issues.length) return { ok: false, raw, issues };
  return { ok: true, doc: RecordShapeSchema.parse(raw), raw };
}

const ON_RECORD: Record<string, Record<string, unknown>> = {
  Goal: { kind: 'list', id: 'on_record', resource: 'Goal', title: 'Goals on record', columns: [{ label: 'Goal', path: 'description' }, { label: 'Target', path: 'target[0].detailQuantity' }, { label: 'Due', path: 'target[0].dueDate' }, { label: 'Status', path: 'lifecycleStatus', status: true }], rows: 10 },
  CarePlan: { kind: 'list', id: 'on_record', resource: 'CarePlan', title: 'Care plans on record', columns: [{ label: 'Plan', path: 'title' }, { label: 'From', path: 'period.start' }, { label: 'Status', path: 'status', status: true }], rows: 10 },
  Encounter: { kind: 'encounters', id: 'on_record', title: 'Visits on record', rows: 10 },
  DocumentReference: { kind: 'notes', id: 'on_record', title: 'Notes on record', rows: 8 },
  Consent: { kind: 'list', id: 'on_record', resource: 'Consent', title: 'Consent decisions on record', columns: [{ label: 'Purpose', path: 'scope' }, { label: 'Decision', path: 'provision.type', status: true }, { label: 'Given on', path: 'dateTime' }, { label: 'Status', path: 'status', status: true }], rows: 10 },
};

/**
 * The composed page the preview compiles: the resource on record (left) and the shape's form (right), one viewing role.
 * The form refers to the shape by id — the caller compiles with the document's own artifact in the library — so a draft
 * previews exactly as an app referencing it would, and a kind the platform has not admitted previews too (only a
 * published shape may carry one; inline fields are for admitted kinds).
 */
export function previewSpecFor(doc: RecordShapeDoc): Record<string, unknown> {
  const s = doc.shape;
  // A kind without a tailored list: what the resource says of itself (code, when it has one) and its status.
  const generic = { kind: 'list', id: 'on_record', resource: s.resource, title: `${s.resource} on record`, columns: [...(resolveElement(s.resource, 'code') ? [{ label: 'What', path: 'code' }] : []), ...(resolveElement(s.resource, 'status') ? [{ label: 'Status', path: 'status', status: true }] : [])], rows: 10 };
  const onRecord = ON_RECORD[s.resource] ?? generic;
  return {
    apiVersion: 'medapp.eu/v1',
    kind: 'AppSpec',
    archetype: 'APP-12',
    app: { app_id: `app_shape_preview_${s.id}`.slice(0, 64), version: '0.1.0', name: s.name, description: s.description ?? `Preview of the record shape ${s.id}.` },
    knobs: {
      identity: 'compact_banner',
      arrangement: 'stack',
      sections: [
        { ...onRecord, span: 6 },
        { kind: 'record', id: `new_${s.id}`.slice(0, 64), span: 6, shape: s.id },
      ],
    },
    roles: [{ id: 'clinician', display_name: 'Clinician', phi_fields_visible: ['name', 'dob'], capabilities: ['view', 'record_entry'] }],
    default_role: 'clinician',
    governance: { clinical_context: 'preview', intended_users: ['clinician'], intended_purpose: `Preview of the record shape ${s.name}: what is on record and the form it writes with. Not an app.`, mdr_classification: 'none' },
  };
}

/** What a new shape starts from: a worked example the author replaces — every field type, the comments say what each line does. */
export const NEW_SHAPE_TEMPLATE = `# A record shape: one FHIR resource type and the fields a form for it has.
# Apps say \`shape: <id>\` in a record section and write exactly this.
apiVersion: medapp.eu/v1
kind: RecordShape
shape:
  id: ward_goal            # stable — apps refer to it; never changes
  name: Ward goal
  description: A short-term goal the ward sets with the patient, as a FHIR Goal.
  resource: Goal           # Goal | CarePlan | Encounter | DocumentReference | Consent — or an open kind (admins), with stamps:
  status: active           # stamped by the platform, never a field
  fields:                  # id, label, type, and the element path written to
    - { id: goal, label: Goal, type: text, path: description, required: true, max_length: 200 }
    - { id: target, label: Target value, type: number, path: "target[0].detailQuantity", unit: m, range: { min: 0, max: 1000 } }
    - { id: due, label: Due, type: date, path: "target[0].dueDate", future_days: 180 }
    - id: priority
      label: Priority
      type: choice         # one of a fixed list
      path: priority
      system: http://terminology.hl7.org/CodeSystem/goal-priority
      options:
        - { code: high-priority, display: High }
        - { code: medium-priority, display: Medium }
        - { code: low-priority, display: Low }
    - { id: note, label: Remark, type: long_text, path: "note[0].text" }
`;
