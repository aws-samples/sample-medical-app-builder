import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SEED } from '../primitives/data/mock/seed';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { AllergyList, DocumentList, EncounterList, ReportList, ResourceList, attachmentText, formatField, getPath } from '../primitives/ui/RecordLists';
import { QUERY_RESOURCES } from '../primitives/data/dataCatalog';
import { Providers, testMedplum } from './testUtils';

/**
 * The rest of the record — allergies, visits, reports, notes, and the generic table — rendered from the
 * synthetic patients. These lists are deterministic renderings of FHIR fields; the tests pin what a
 * clinician sees for each field shape and that "nothing recorded" is said, not implied.
 */

const ANNELIESE = 'pat-kms-0001';
const JONAS = 'pat-kms-0002';

const scope = (resource: string) => ({ patient_scope: 'individual' as const, phi_fields_visible: [], fhir: [{ resource, operations: ['search' as const] }] });

async function query(resource: string, patient: string, params: Record<string, string> = {}) {
  const executor = new MockPrimitiveExecutor(undefined, new Date('2026-09-10T08:00:00Z'), 0);
  return (await executor.execute({
    decl: { id: 'p', kind: 'data.fhir.query', catalog_version: '1.0.0', config: {}, output_binding: 'x' },
    config: { resource, params: { patient, ...params } },
    scope: scope(resource),
    idToken: 't',
    userSub: 'test',
    manifest: { metadata: { app_id: 'app_test', version: '0.1.0' } },
    role: 'viewer',
    context: {},
  } as never)) as unknown[];
}

describe('the query primitive reaches the new resource types', () => {
  it('allow-lists the same resource types on both sides of the dispatcher', () => {
    expect([...QUERY_RESOURCES]).toEqual(expect.arrayContaining(['AllergyIntolerance', 'Procedure', 'Immunization', 'DocumentReference', 'Encounter', 'DiagnosticReport']));
  });

  it('finds a patient’s allergies, visits, reports and notes — by `patient` whatever the field is called', async () => {
    expect((await query('AllergyIntolerance', ANNELIESE)).length).toBe(2); // AllergyIntolerance.patient
    expect((await query('Encounter', ANNELIESE)).length).toBe(4); // Encounter.subject
    expect((await query('Immunization', JONAS)).length).toBe(1);
    expect((await query('AllergyIntolerance', JONAS)).length).toBe(0);
    const reports = (await query('DiagnosticReport', ANNELIESE)) as { id: string }[];
    expect(reports.map((r) => r.id)).toEqual(['rep-kms-0002', 'rep-kms-0001']); // newest first
  });

  it('filters by category, type, status and date like the dispatcher', async () => {
    expect((await query('DiagnosticReport', ANNELIESE, { category: 'RAD' })).length).toBe(1);
    expect((await query('DiagnosticReport', ANNELIESE, { category: 'http://terminology.hl7.org/CodeSystem/v2-0074|LAB' })).length).toBe(1);
    expect((await query('DocumentReference', ANNELIESE, { type: '11488-4' })).length).toBe(1);
    expect((await query('Encounter', ANNELIESE, { status: 'finished', date: 'ge2026-01-01' })).length).toBe(3);
    expect((await query('AllergyIntolerance', ANNELIESE, { 'clinical-status': 'active' })).length).toBe(2);
  });
});

describe('field formatting for the generic list', () => {
  it('follows paths with indexes and renders each FHIR datatype by what it is', async () => {
    const allergy = SEED.allergies[0]!;
    expect(getPath(allergy, 'reaction[0].manifestation[0].coding[0].display')).toBe('Urticaria');
    expect(getPath(allergy, 'reaction[5].severity')).toBeUndefined();
    expect(getPath(allergy, 'nope.deeper')).toBeUndefined();
    const medplum = await testMedplum();
    const { container } = render(
      <Providers medplum={medplum}>
        <span data-testid="date">{formatField('2024-02-15')}</span>
        <span data-testid="period">{formatField({ start: '2024-02-14T07:30:00+01:00', end: '2024-02-16T11:00:00+01:00' })}</span>
        <span data-testid="ref">{formatField({ reference: 'Practitioner/x', display: 'Dr. med. Lukas Hoffmann' })}</span>
        <span data-testid="empty">{formatField(undefined)}</span>
        <span data-testid="list">{formatField(['a', 'b', 'c', 'd', 'e'])}</span>
        <span data-testid="bool">{formatField(true)}</span>
      </Providers>
    );
    expect(within(container).getByTestId('date')).toHaveTextContent(/2024/);
    expect(within(container).getByTestId('period')).toHaveTextContent('–');
    expect(within(container).getByTestId('ref')).toHaveTextContent('Dr. med. Lukas Hoffmann');
    expect(within(container).getByTestId('empty')).toHaveTextContent('—');
    expect(within(container).getByTestId('list')).toHaveTextContent('a, b, c +2 more');
    expect(within(container).getByTestId('bool')).toHaveTextContent('Yes');
  });

  it('decodes an inline plain-text note (UTF-8, umlauts intact) and leaves other attachments alone', () => {
    const letter = SEED.documents[0]!;
    expect(attachmentText(letter)).toContain('Entlassungsbrief');
    expect(attachmentText(letter)).toContain('komplikationslos');
    expect(attachmentText({ resourceType: 'DocumentReference', status: 'current', content: [{ attachment: { contentType: 'application/pdf', data: 'JVBERi0=' } }] })).toBeUndefined();
  });
});

describe('the record lists', () => {
  it('AllergyList: substance, criticality in red for high, reactions, and an explicit "none recorded"', async () => {
    const medplum = await testMedplum();
    const view = render(
      <Providers medplum={medplum}>
        <AllergyList allergies={SEED.allergies.filter((a) => a.patient?.reference === `Patient/${ANNELIESE}`)} />
      </Providers>
    );
    const list = screen.getByTestId('allergy-list');
    expect(list).toHaveTextContent('Allergies and intolerances');
    expect(list).toHaveTextContent('2 entries');
    expect(list).toHaveTextContent('Penicillin');
    expect(list).toHaveTextContent('Urticaria');
    expect(list).toHaveTextContent('(moderate)');
    expect(list.querySelectorAll('[data-criticality="high"]').length).toBe(1);
    view.unmount();
    render(
      <Providers medplum={medplum}>
        <AllergyList allergies={[]} title="Allergien" />
      </Providers>
    );
    expect(screen.getByTestId('allergy-list')).toHaveTextContent('No allergies or intolerances recorded.');
  });

  it('EncounterList and ReportList: visits with setting and reason; reports with category and conclusion', async () => {
    const medplum = await testMedplum();
    render(
      <Providers medplum={medplum}>
        <EncounterList encounters={SEED.encounters.filter((e) => e.subject?.reference === `Patient/${ANNELIESE}`)} title="Visits" />
        <ReportList reports={SEED.diagnosticReports.filter((r) => r.subject?.reference === `Patient/${ANNELIESE}`)} title="Reports" />
      </Providers>
    );
    const visits = screen.getByTestId('encounter-list');
    expect(visits).toHaveTextContent('4 entries');
    expect(visits).toHaveTextContent('Stationärer Aufenthalt Orthopädie');
    expect(visits).toHaveTextContent('inpatient encounter');
    expect(visits).toHaveTextContent('Dr. med. Lukas Hoffmann');
    const reports = screen.getByTestId('report-list');
    expect(screen.getAllByTestId('report-card').length).toBe(2);
    expect(reports).toHaveTextContent('CT Thorax mit Kontrastmittel');
    expect(reports).toHaveTextContent('Radiology');
    expect(reports).toHaveTextContent('Kein Nachweis eines Infiltrats');
    expect(reports).toHaveTextContent('1 result');
  });

  it('DocumentList shows the note text inline; ResourceList renders arbitrary columns', async () => {
    const medplum = await testMedplum();
    render(
      <Providers medplum={medplum}>
        <DocumentList documents={SEED.documents.filter((d) => d.subject?.reference === `Patient/${ANNELIESE}`)} />
        <ResourceList
          resources={SEED.procedures}
          title="Procedures"
          columns={[
            { label: 'Date', path: 'performedDateTime' },
            { label: 'Procedure', path: 'code' },
            { label: 'Body site', path: 'bodySite[0]' },
            { label: 'Status', path: 'status', status: true },
          ]}
        />
      </Providers>
    );
    const docs = screen.getByTestId('document-list');
    expect(screen.getAllByTestId('document-card').length).toBe(2);
    expect(docs).toHaveTextContent('Entlassungsbrief Orthopädie');
    expect(docs).toHaveTextContent('Teilresektion des Innenmeniskus');
    const table = screen.getByTestId('resource-list');
    expect(table).toHaveTextContent('3 entries');
    expect(table).toHaveTextContent('Arthroskopie Knie rechts');
    expect(table).toHaveTextContent('Structure of right knee');
    expect(table.querySelectorAll('tbody tr').length).toBe(3);
  });
});
