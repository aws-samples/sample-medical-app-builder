import type { ShapeSummary } from '../../shapes';

/**
 * "Open as an app": the draft a published shape starts — a composed page with what the patient has on record of the
 * shape's resource type beside the form (`shape: <id>`, so the app keeps the published version by checksum). Roles and
 * governance are left to the conversation; the first message tells the assistant where the draft comes from.
 */
export function draftSpecForShape(shape: ShapeSummary, message?: string): { spec: Record<string, unknown>; message: string } {
  const published = shape.published?.artifact;
  const resource = shape.resource;
  const onRecord: Record<string, Record<string, unknown>> = {
    Goal: { kind: 'list', id: 'goals', resource: 'Goal', title: 'Goals', columns: [{ label: 'Goal', path: 'description' }, { label: 'Target', path: 'target[0].detailQuantity' }, { label: 'Due', path: 'target[0].dueDate' }, { label: 'Status', path: 'lifecycleStatus', status: true }], rows: 10 },
    CarePlan: { kind: 'list', id: 'care_plans', resource: 'CarePlan', title: 'Care plans', columns: [{ label: 'Plan', path: 'title' }, { label: 'From', path: 'period.start' }, { label: 'Status', path: 'status', status: true }], rows: 10 },
    Encounter: { kind: 'encounters', id: 'visits', rows: 10 },
    DocumentReference: { kind: 'notes', id: 'notes', rows: 8 },
    Consent: { kind: 'list', id: 'consents', resource: 'Consent', title: 'Consent decisions', columns: [{ label: 'Purpose', path: 'scope' }, { label: 'Decision', path: 'provision.type', status: true }, { label: 'Given on', path: 'dateTime' }, { label: 'Status', path: 'status', status: true }], rows: 10 },
  };
  const spec = {
    archetype: 'APP-12',
    app: { name: shape.name, description: shape.description ?? `${shape.name}: what is on record, and the form to add one.` },
    knobs: {
      identity: 'compact_banner',
      arrangement: 'stack',
      sections: [
        { ...(onRecord[resource] ?? { kind: 'list', id: 'on_record', resource, columns: [{ label: 'Status', path: 'status', status: true }] }), span: 8 },
        { kind: 'record', id: `new_${shape.shape_id}`.slice(0, 64), span: 4, shape: shape.shape_id },
      ],
    },
  };
  const fields = published ? published.fields.map((f) => f.label).join(', ') : '';
  return {
    spec,
    message:
      message ??
      `Start from the record shape "${shape.name}" (${shape.shape_id}, version ${shape.published?.version ?? '?'}): a page that lists the patient's ${resource} entries and lets the clinician add one with the shape's form${fields ? ` (${fields})` : ''}. Propose the roles and governance for it.`,
  };
}
