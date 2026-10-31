import type { AllergyIntolerance, Condition, ImagingStudy, Media, MedicationRequest, Observation, Patient, Procedure, Questionnaire, QuestionnaireItem, QuestionnaireResponse, QuestionnaireResponseItem, Resource, Task } from '@medplum/fhirtypes';
import { findArtifactQuestionnaire, type Artifacts } from '../../../manifest/artifacts';
import { assertScopeAllows, isDataPrimitiveKind, parsePrimitiveConfig, resolveDateExpression } from '../dataCatalog';
import { componentQuantity, conceptMatches, newestFirst, observationDate, patientIdOf, resourceDate, subjectIs, tokenInConcepts } from '../fhirHelpers';
import { extractAnswers, validateQuestionnaireResponse } from '../questionnaire';
import { decodedImageSize, validateAllergyEntry, validateConditionEntry, validateMediaEntry, validateObservationEntry, validateProcedureEntry, validateStatusChange, validateTaskEntry } from '../writes';
import { applyStamps, validateRecordEntry, type RecordEntryRules } from '../recordShape';
import type { ExecutionRequest, ExecutionResult, PatientHit, PrimitiveExecutor } from '../types';
import { UnknownPrimitiveError, WriteRejectedError } from '../types';
import { SEED, type SeedData } from './seed';

/** The dispatcher's answer to a stale `versionId`: the same words the panel shows in mock mode. */
export const VERSION_CONFLICT_MESSAGE = 'The record was changed by someone else in the meantime; nothing was written. Reload and try again.';

export interface CohortObservationRow {
  readonly patient: Patient;
  readonly observation?: Observation;
  readonly date?: string;
  readonly systolic?: number;
  readonly diastolic?: number;
  readonly value?: number;
  readonly unit?: string;
  /** The value the threshold and a range filter look at: the configured panel component, else the observation's value (or systolic). */
  readonly compared?: number;
  readonly above_threshold: boolean;
}

/** What a cohort row says about a study: enough to name it and to open it in the viewer, never the pixels. */
export interface StudySummary {
  readonly uid?: string;
  readonly started?: string;
  readonly modalities: string[];
  readonly description?: string;
  readonly series?: number;
  readonly instances?: number;
}

export interface CohortImagingRow {
  readonly patient: Patient;
  readonly study_count: number;
  readonly latest_study: StudySummary;
  /** Every modality across the member's matching studies, sorted. */
  readonly modalities: string[];
}

/** One line of a worklist: the task and the patient it is for. */
export interface WorklistRow {
  readonly task: Task;
  readonly patient: Patient;
  /** The due date (`restriction.period.end`) lies before the day the list was made. */
  readonly overdue: boolean;
}

/** One line of an assessment-due list: the patient, their latest answer to the questionnaire (if any), and where they stand. */
export interface AssessmentDueRow {
  readonly patient: Patient;
  readonly last_authored?: string;
  /** The day the next assessment is due: last + every_days. Absent when never assessed. */
  readonly due_on?: string;
  readonly status: 'never' | 'overdue' | 'due' | 'upcoming';
  /** Days past the due day (0 on the day itself); absent for never / upcoming. */
  readonly overdue_days?: number;
}

const DAY_MS = 86_400_000;

/** The due status of one patient from the day of their latest answer, as of `today` (day strings) — shared by the row makers. */
export function dueStatus(lastAuthored: string | undefined, everyDays: number, today: string, upcomingDays: number): Omit<AssessmentDueRow, 'patient'> | undefined {
  if (!lastAuthored) return { status: 'never' };
  const last = lastAuthored.slice(0, 10);
  const dueOn = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)) + everyDays)).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) / DAY_MS);
  if (days > 0) return { last_authored: lastAuthored, due_on: dueOn, status: 'overdue', overdue_days: days };
  if (days === 0) return { last_authored: lastAuthored, due_on: dueOn, status: 'due', overdue_days: 0 };
  if (-days <= upcomingDays) return { last_authored: lastAuthored, due_on: dueOn, status: 'upcoming' };
  return undefined; // assessed recently enough: not on the list
}

/** Never assessed first, then the longest overdue, then due, then upcoming by due day — the order every due list shows. */
export function orderDue(rows: AssessmentDueRow[]): AssessmentDueRow[] {
  const rank = { never: 0, overdue: 1, due: 2, upcoming: 3 } as const;
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || (b.overdue_days ?? 0) - (a.overdue_days ?? 0) || (a.due_on ?? '').localeCompare(b.due_on ?? ''));
}

/** Due date of a task as a day string, or undefined. */
export function taskDue(task: Task): string | undefined {
  return task.restriction?.period?.end?.slice(0, 10);
}

/** Overdue first, then by due date (tasks without one last), then newest request first — the order every worklist shows. */
export function orderWorklist(rows: WorklistRow[]): WorklistRow[] {
  return [...rows].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const da = taskDue(a.task) ?? '9999';
    const db = taskDue(b.task) ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    return (b.task.authoredOn ?? '') < (a.task.authoredOn ?? '') ? -1 : 1;
  });
}

/** The study's UID from its `urn:oid:` identifier (what the PACS gave it), falling back to the resource id. */
export function studySummary(study: ImagingStudy): StudySummary {
  const oid = study.identifier?.find((i) => (i.value ?? '').startsWith('urn:oid:'))?.value;
  return {
    uid: oid ? oid.slice('urn:oid:'.length) : study.id,
    started: study.started,
    modalities: [...new Set((study.modality ?? []).map((m) => m.code ?? '').filter(Boolean))].sort(),
    description: study.description,
    series: study.numberOfSeries,
    instances: study.numberOfInstances,
  };
}

/**
 * Runs data primitives against in-memory synthetic FHIR. This is the reference behaviour
 * the Lambda implementations must match; the manifests are identical in both modes.
 * Writes land in an in-memory store on the executor instance, so a reload shows them.
 */
export class MockPrimitiveExecutor implements PrimitiveExecutor {
  readonly kind = 'mock' as const;
  private readonly created: QuestionnaireResponse[] = [];
  private readonly recorded: Observation[] = [];
  /** The coded entries added in this session: problems, allergies, procedures — listed with the seed's. */
  private readonly addedConditions: Condition[] = [];
  private readonly addedAllergies: AllergyIntolerance[] = [];
  private readonly addedProcedures: Procedure[] = [];
  private readonly addedTasks: Task[] = [];
  private readonly addedMedia: Media[] = [];
  /** Records of declared shapes, by resource type — what `write.fhir.record.create` stored, read back by `list`. */
  private readonly addedRecords = new Map<string, Resource[]>();
  /** Updated copies by `Type/id`, laid over the seed so later reads see the change without mutating shared data. */
  private readonly updated = new Map<string, Resource>();
  private sequence = 0;
  private auditSequence = 0;

  constructor(
    private readonly data: SeedData = SEED,
    private readonly now: Date = new Date(),
    private readonly latencyMs = 120
  ) {}

  /** The seed's patients by name — the same contract as the dispatcher's lookup, over the mock data. */
  async searchPatients(name: string): Promise<PatientHit[]> {
    const needle = name.trim().toLocaleLowerCase();
    if (!needle) {
      // No name: the first page of the record by family name — what the dispatcher answers to GET /patients without one.
      return [...this.data.patients]
        .sort((a, b) => (a.name?.[0]?.family ?? '').localeCompare(b.name?.[0]?.family ?? ''))
        .slice(0, 20)
        .map((p) => patientHit(p));
    }
    if (needle.length < 2) throw new Error("Type at least two characters of the patient's name.");
    return this.data.patients
      .filter((p) => (p.name ?? []).some((n) => [n.text ?? '', n.family ?? '', ...(n.given ?? [])].some((part) => part.toLocaleLowerCase().includes(needle))))
      .slice(0, 20)
      .map((p) => patientHit(p));
  }

  /** The output with a minted record id — the mock stands in for the data source, which names the record it writes. */
  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const output = await this.execute(req);
    return { output, audit_id: `mock-${String(++this.auditSequence).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}` };
  }

  async execute(req: ExecutionRequest): Promise<unknown> {
    const { decl, config, scope } = req;
    if (!isDataPrimitiveKind(decl.kind)) throw new UnknownPrimitiveError(decl.kind);
    assertScopeAllows(decl.kind, decl.id, config as Record<string, unknown>, scope);
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    switch (decl.kind) {
      case 'data.fhir.patient.read': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const id = patientIdOf(c.patient);
        const patient = this.data.patients.find((p) => p.id === id);
        if (!patient) throw new Error(`Patient ${id} was not found.`);
        return patient;
      }

      case 'data.fhir.observation.by_code': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const id = patientIdOf(c.patient);
        const since = resolveDateExpression(c.since, this.now);
        const matches = this.observations().filter(
          (o) =>
            subjectIs(o, id) &&
            (conceptMatches(o.code, c.codes) || o.component?.some((cmp) => conceptMatches(cmp.code, c.codes))) &&
            (!since || observationDate(o) >= since)
        );
        return newestFirst(matches, observationDate).slice(0, c.count);
      }

      case 'data.fhir.query': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        return this.query(c.resource, c.params, c.count);
      }

      case 'data.dicom.studies.for_patient': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const id = patientIdOf(c.patient);
        const studies = this.data.imagingStudies.filter(
          (s) => subjectIs(s, id) && (!c.modalities?.length || s.modality?.some((m) => c.modalities?.includes(m.code ?? '')))
        );
        return newestFirst(studies, (s) => s.started ?? '');
      }

      case 'data.cohort.by_condition': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const conditions = this.data.conditions.filter(
          (cond) =>
            conceptMatches(cond.code, c.condition_codes) &&
            (!c.clinical_status || cond.clinicalStatus?.coding?.some((k) => k.code === c.clinical_status))
        );
        const ids = new Set(conditions.map((cond) => patientIdOf(cond.subject?.reference ?? '')));
        const patients = this.data.patients.filter((p) => ids.has(p.id ?? ''));
        return { patients, conditions, count: patients.length };
      }

      case 'data.cohort.latest_observation': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const rows: CohortObservationRow[] = c.patients.map((p) => {
          const latest = newestFirst(
            this.observations().filter(
              (o) => subjectIs(o, p.id ?? '') && (conceptMatches(o.code, c.codes) || o.component?.some((cmp) => conceptMatches(cmp.code, c.codes)))
            ),
            observationDate
          )[0];
          const systolic = latest ? componentQuantity(latest, '8480-6')?.value : undefined;
          const diastolic = latest ? componentQuantity(latest, '8462-4')?.value : undefined;
          const value = latest?.valueQuantity?.value;
          const componentCode = c.threshold?.component_code ?? c.component_code;
          const compared = componentCode ? (latest ? componentQuantity(latest, componentCode)?.value : undefined) : value ?? systolic;
          return {
            patient: p as Patient,
            observation: latest,
            date: latest ? observationDate(latest) : undefined,
            systolic,
            diastolic,
            value,
            unit: latest?.valueQuantity?.unit ?? (componentCode && latest ? componentQuantity(latest, componentCode)?.unit : undefined),
            compared,
            above_threshold: c.threshold !== undefined && compared !== undefined && compared >= c.threshold.value,
          };
        });
        const compared = rows.map((r) => r.compared).filter((v): v is number => typeof v === 'number');
        return {
          rows,
          above_threshold_count: rows.filter((r) => r.above_threshold).length,
          // The range the cohort's compared values span — what a range filter's slider is bounded by when the app sets no bounds.
          ...(compared.length ? { compared_min: Math.min(...compared), compared_max: Math.max(...compared) } : {}),
        };
      }

      case 'data.cohort.with_imaging': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const since = resolveDateExpression(c.since, this.now);
        const rows: CohortImagingRow[] = [];
        let studiesTotal = 0;
        for (const p of c.patients) {
          const studies = newestFirst(
            this.data.imagingStudies.filter(
              (s) =>
                subjectIs(s, p.id ?? '') &&
                (!c.modalities?.length || s.modality?.some((m) => c.modalities?.includes(m.code ?? ''))) &&
                (!since || (s.started ?? '') >= since)
            ),
            (s) => s.started ?? ''
          );
          const latest = studies[0];
          if (!latest || studies.length < c.min_studies) continue;
          studiesTotal += studies.length;
          rows.push({
            patient: p as Patient,
            study_count: studies.length,
            latest_study: studySummary(latest),
            modalities: [...new Set(studies.flatMap((s) => studySummary(s).modalities))].sort(),
          });
        }
        return { rows, patients: rows.map((r) => r.patient), count: rows.length, studies_total: studiesTotal };
      }

      case 'data.fhir.questionnaire.read': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const q = this.findQuestionnaire(c.questionnaire, req.manifest.artifacts);
        if (!q) throw new Error(`Questionnaire ${c.questionnaire} was not found.`);
        return q;
      }

      case 'write.fhir.questionnaire_response.submit': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const questionnaire = this.findQuestionnaire(c.questionnaire, req.manifest.artifacts);
        if (!questionnaire) throw new Error(`Questionnaire ${c.questionnaire} was not found.`);
        const response = c.response as QuestionnaireResponse;
        const subjectId = patientIdOf(c.subject);
        const problems = validateQuestionnaireResponse(questionnaire, response);
        const claimedSubject = response.subject?.reference;
        if (claimedSubject && claimedSubject !== `Patient/${subjectId}`) problems.push(`response subject ${claimedSubject} is not the patient in context`);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);

        // Idempotent on the client-generated submission identifier: a retried submit is not a second record.
        const existing = response.identifier?.value ? this.created.find((r) => r.identifier?.value === response.identifier?.value) : undefined;
        if (existing) return existing;

        // Only the answers (and the submission id) come from the client. Provenance is stamped here,
        // never trusted from the payload: who (authenticated subject), when (server clock), through
        // which app version. Mirrors infra/lambdas/dispatcher/primitives.py.
        const stamp = this.now.toISOString();
        const stored: QuestionnaireResponse = {
          resourceType: 'QuestionnaireResponse',
          ...(response.identifier ? { identifier: response.identifier } : {}),
          ...(response.item ? { item: response.item } : {}),
          ...(response.encounter ? { encounter: response.encounter } : {}),
          ...(response.language ? { language: response.language } : {}),
          id: `qr-mock-${String(++this.sequence).padStart(4, '0')}`,
          questionnaire: questionnaire.url,
          status: 'completed',
          subject: { reference: `Patient/${subjectId}` },
          authored: stamp,
          author: { identifier: { system: 'urn:medapp:cognito-sub', value: req.userSub }, ...(req.userDisplay ? { display: req.userDisplay } : {}) },
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.created.push(stored);
        // The answers the manifest flags as measurements, written as Observations beside the response (category survey,
        // derived from it) — so a pain score from a form and one typed into an entry form share a trend. Mirrors
        // primitives.py::extract_answers.
        for (const hit of extractAnswers(c.extract, response)) {
          const [system, code] = hit.code.includes('|') ? hit.code.split('|', 2) : [undefined, hit.code];
          this.recorded.push({
            resourceType: 'Observation',
            id: `obs-mock-${String(++this.sequence).padStart(4, '0')}`,
            identifier: [{ system: 'urn:medapp:submission', value: `${response.identifier?.value ?? stored.id}-${hit.link_id}` }],
            status: 'final',
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }],
            code: { coding: [{ ...(system ? { system } : {}), code: code ?? '', ...(hit.display ? { display: hit.display } : {}) }], ...(hit.display ? { text: hit.display } : {}) },
            subject: { reference: `Patient/${subjectId}` },
            effectiveDateTime: stamp,
            issued: stamp,
            performer: [{ identifier: { system: 'urn:medapp:cognito-sub', value: req.userSub }, ...(req.userDisplay ? { display: req.userDisplay } : {}) }],
            valueQuantity: { value: hit.value, ...(hit.unit ? { unit: hit.unit } : {}) },
            derivedFrom: [{ reference: `QuestionnaireResponse/${stored.id}` }],
            meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
          });
        }
        return stored;
      }

      case 'write.fhir.observation.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateObservationEntry(c, c.observation, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.observation as Observation;
        const submissionId = entry.identifier?.[0]?.value;
        const existing = submissionId ? this.recorded.find((o) => o.identifier?.some((i) => i.value === submissionId)) : undefined;
        if (existing) return existing;
        const stamp = this.now.toISOString();
        const author = { identifier: { system: 'urn:medapp:cognito-sub', value: req.userSub }, ...(req.userDisplay ? { display: req.userDisplay } : {}) };
        // Only code, value(s), date, note, the body site (structure and side) and the method come from the client; status,
        // subject, performer, time and provenance are stamped here. Mirrors infra/lambdas/dispatcher/primitives.py::observation_create.
        const stored: Observation = {
          resourceType: 'Observation',
          id: `obs-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          status: 'final',
          ...(c.category ? { category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: c.category }] }] } : {}),
          code: entry.code,
          subject: { reference: `Patient/${subjectId}` },
          effectiveDateTime: entry.effectiveDateTime ?? stamp,
          issued: stamp,
          performer: [author],
          ...(entry.valueQuantity ? { valueQuantity: entry.valueQuantity } : {}),
          ...(entry.component ? { component: entry.component } : {}),
          ...(entry.note?.length ? { note: entry.note.filter((n) => n.text).map((n) => ({ authorString: req.userDisplay ?? req.userSub, time: stamp, text: n.text })) } : {}),
          ...(entry.bodySite ? { bodySite: entry.bodySite } : {}),
          ...(entry.method ? { method: entry.method } : {}),
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.recorded.push(stored);
        return stored;
      }

      case 'write.fhir.condition.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateConditionEntry(c, c.condition, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.condition as Condition;
        const replay = this.replayOf(this.addedConditions, entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        const author = this.author(req);
        // Code, verification, onset, severity and note come from the client; the rest is stamped. Mirrors primitives.py::condition_create.
        const stored: Condition = {
          resourceType: 'Condition',
          id: `cond-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
          verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: codeIn(entry.verificationStatus) ?? c.verification[0] ?? 'confirmed' }] },
          category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: c.category }] }],
          ...(entry.severity ? { severity: entry.severity } : {}),
          code: entry.code,
          subject: { reference: `Patient/${subjectId}` },
          ...(entry.onsetDateTime ? { onsetDateTime: entry.onsetDateTime } : {}),
          recordedDate: stamp,
          recorder: author,
          asserter: author,
          ...(entry.note?.length ? { note: entry.note.filter((n) => n.text).map((n) => ({ authorString: req.userDisplay ?? req.userSub, time: stamp, text: n.text })) } : {}),
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.addedConditions.push(stored);
        return stored;
      }

      case 'write.fhir.allergy_intolerance.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateAllergyEntry(c, c.allergy, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.allergy as AllergyIntolerance;
        const replay = this.replayOf(this.addedAllergies, entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        const author = this.author(req);
        const stored: AllergyIntolerance = {
          resourceType: 'AllergyIntolerance',
          id: `allergy-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active', display: 'Active' }] },
          verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: codeIn(entry.verificationStatus) ?? c.verification[0] ?? 'confirmed' }] },
          ...(entry.type ? { type: entry.type } : {}),
          category: entry.category,
          ...(entry.criticality ? { criticality: entry.criticality } : {}),
          code: entry.code,
          patient: { reference: `Patient/${subjectId}` },
          ...(entry.onsetDateTime ? { onsetDateTime: entry.onsetDateTime } : {}),
          recordedDate: stamp,
          recorder: author,
          asserter: author,
          ...(entry.reaction?.length ? { reaction: entry.reaction } : {}),
          ...(entry.note?.length ? { note: entry.note.filter((n) => n.text).map((n) => ({ authorString: req.userDisplay ?? req.userSub, time: stamp, text: n.text })) } : {}),
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.addedAllergies.push(stored);
        return stored;
      }

      case 'write.fhir.procedure.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateProcedureEntry(c, c.procedure, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.procedure as Procedure;
        const replay = this.replayOf(this.addedProcedures, entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        const author = this.author(req);
        const stored: Procedure = {
          resourceType: 'Procedure',
          id: `proc-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          status: entry.status,
          code: entry.code,
          subject: { reference: `Patient/${subjectId}` },
          performedDateTime: entry.performedDateTime,
          recorder: author,
          asserter: author,
          performer: [{ actor: author }],
          ...(entry.bodySite?.length ? { bodySite: entry.bodySite } : {}),
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
          ...(entry.note?.length ? { note: entry.note.filter((n) => n.text).map((n) => ({ authorString: req.userDisplay ?? req.userSub, time: stamp, text: n.text })) } : {}),
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.addedProcedures.push(stored);
        return stored;
      }

      case 'data.fhir.questionnaire_response.answers': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.patient);
        const questionnaire = this.findQuestionnaire(c.questionnaire, req.manifest.artifacts as Artifacts | undefined);
        const responses = newestFirst(
          (this.collection('QuestionnaireResponse') as QuestionnaireResponse[]).filter((r) => r.questionnaire === c.questionnaire && subjectIs(r, subjectId) && r.status !== 'entered-in-error'),
          resourceDate
        );
        return answersAsObservations(responses, questionnaire, c.questionnaire, c.link_ids).slice(0, c.count);
      }

      case 'data.cohort.assessment_due': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const today = this.now.toISOString().slice(0, 10);
        const responses = (this.collection('QuestionnaireResponse') as QuestionnaireResponse[]).filter((r) => r.questionnaire === c.questionnaire && r.status !== 'entered-in-error');
        const latestBy = new Map<string, string>();
        for (const r of responses) {
          const pid = patientIdOf(r.subject?.reference ?? '');
          if (pid && r.authored && (latestBy.get(pid) ?? '') < r.authored) latestBy.set(pid, r.authored);
        }
        // The population: the cohort handed in, or — without one — everyone assessed before (a repeat-screening list).
        const population = c.patients ? c.patients.map((p) => this.data.patients.find((x) => x.id === p.id) ?? (p as Patient)) : this.data.patients.filter((p) => latestBy.has(p.id ?? ''));
        const rows: AssessmentDueRow[] = [];
        for (const patient of population) {
          const standing = dueStatus(latestBy.get(patient.id ?? ''), c.every_days, today, c.upcoming_days);
          if (standing) rows.push({ patient, ...standing });
        }
        const ordered = orderDue(rows).slice(0, c.count);
        return { rows: ordered, count: ordered.length, never_count: ordered.filter((r) => r.status === 'never').length, overdue_count: ordered.filter((r) => r.status === 'overdue').length };
      }

      case 'data.task.worklist': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const today = this.now.toISOString().slice(0, 10);
        const tasks = (this.collection('Task') as Task[]).filter((t) => c.statuses.includes(t.status as (typeof c.statuses)[number]) && (!c.codes?.length || conceptMatches(t.code, c.codes)));
        const rows: WorklistRow[] = [];
        for (const task of tasks) {
          const patient = this.data.patients.find((p) => `Patient/${p.id}` === task.for?.reference);
          if (!patient) continue;
          const due = taskDue(task);
          rows.push({ task, patient, overdue: Boolean(due && due < today && task.status !== 'completed' && task.status !== 'cancelled') });
        }
        const ordered = orderWorklist(rows).slice(0, c.count);
        return { rows: ordered, count: ordered.length, overdue_count: ordered.filter((r) => r.overdue).length };
      }

      case 'write.fhir.record.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const rules: RecordEntryRules = { resource: c.resource, fields: c.fields, stamps: c.stamps };
        const problems = validateRecordEntry(rules, c.record, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.record as Resource & { identifier?: { value?: string }[] };
        const added = this.addedRecords.get(c.resource) ?? [];
        const replay = this.replayOf(added as (Resource & { identifier?: { value?: string }[] })[], entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        // Mirrors primitives.py::record_create: the payload as sent, the stamps over it, the platform's meta.
        const stored = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
        delete stored['meta'];
        applyStamps(stored, c.stamps, { patientId: subjectId, author: this.author(req), now: stamp });
        stored['resourceType'] = c.resource;
        stored['id'] = `${c.resource.toLowerCase()}-mock-${String(++this.sequence).padStart(4, '0')}`;
        // A record written with a library shape says so on itself: the shape and its version as a tag, searchable with `_tag`.
        stored['meta'] = { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}`, ...(c.shape ? { tag: [{ ...c.shape.tag }] } : {}) };
        added.push(stored as unknown as Resource);
        this.addedRecords.set(c.resource, added);
        return stored;
      }
      case 'write.fhir.media.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateMediaEntry(c, c.media, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.media as Media;
        const replay = this.replayOf(this.addedMedia, entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        const data = String(entry.content.data);
        // In the browser the image stays inline (there is no store); the dispatcher keeps the bytes in the media bucket and
        // the record a storage URL. Mirrors primitives.py::media_create.
        const stored: Media = {
          resourceType: 'Media',
          id: `media-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          status: 'completed',
          type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/media-type', code: 'photo', display: 'Photo' }] },
          ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
          ...(entry.bodySite ? { bodySite: entry.bodySite } : {}),
          subject: { reference: `Patient/${subjectId}` },
          createdDateTime: entry.createdDateTime ?? stamp,
          issued: stamp,
          operator: this.author(req),
          ...(entry.note?.length ? { note: entry.note.filter((n) => n.text).map((n) => ({ authorString: req.userDisplay ?? req.userSub, time: stamp, text: n.text })) } : {}),
          content: { contentType: entry.content.contentType, data, size: decodedImageSize(data) ?? 0, ...(entry.content.title ? { title: entry.content.title } : {}), creation: entry.createdDateTime ?? stamp },
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.addedMedia.push(stored);
        return stored;
      }

      case 'write.fhir.task.create': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        const subjectId = patientIdOf(c.subject);
        const problems = validateTaskEntry(c, c.task, subjectId, this.now);
        if (problems.length) throw new WriteRejectedError(decl.id, problems);
        const entry = c.task as Task;
        const replay = this.replayOf(this.addedTasks, entry.identifier);
        if (replay) return replay;
        const stamp = this.now.toISOString();
        const author = this.author(req);
        // Code, priority, due date and description come from the client; status, intent, patient, requester and times are stamped.
        const stored: Task = {
          resourceType: 'Task',
          id: `task-mock-${String(++this.sequence).padStart(4, '0')}`,
          ...(entry.identifier?.length ? { identifier: entry.identifier } : {}),
          status: 'requested',
          intent: 'order',
          priority: entry.priority ?? c.priorities[0] ?? 'routine',
          code: entry.code,
          ...(entry.description ? { description: entry.description } : {}),
          for: { reference: `Patient/${subjectId}` },
          authoredOn: stamp,
          lastModified: stamp,
          requester: author,
          ...(entry.restriction?.period?.end ? { restriction: { period: { end: entry.restriction.period.end } } } : {}),
          meta: { versionId: '1', lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` },
        };
        this.addedTasks.push(stored);
        return stored;
      }

      case 'write.fhir.task.update_status': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        return this.updateStatus(decl.id, req, 'Task', 'status', c.subject, c.allowed, c.change, (resource, status, change, stamp) => {
          const task = resource as Task;
          task.status = status as Task['status'];
          task.lastModified = stamp;
          // Whoever moves a task on owns it; completion is timed. Mirrors primitives.py::_apply_task_status.
          if (status === 'in-progress' || status === 'completed') task.owner ??= this.author(req);
          if (status === 'in-progress') task.executionPeriod = { ...(task.executionPeriod ?? {}), start: task.executionPeriod?.start ?? stamp };
          if (status === 'completed') task.executionPeriod = { ...(task.executionPeriod ?? {}), end: stamp };
          appendNote(task, change, req, stamp);
        });
      }

      case 'write.fhir.condition.update_status': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        return this.updateStatus(decl.id, req, 'Condition', 'clinicalStatus', c.subject, c.allowed, c.change, (resource, status, change, stamp) => {
          const cond = resource as Condition;
          cond.clinicalStatus = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status, display: status.charAt(0).toUpperCase() + status.slice(1) }] };
          if (['resolved', 'inactive', 'remission'].includes(status)) cond.abatementDateTime ??= stamp;
          else delete cond.abatementDateTime;
          appendNote(cond, change, req, stamp);
        });
      }

      case 'write.fhir.medication_request.update_status': {
        const c = parsePrimitiveConfig(decl.kind, decl.id, config);
        return this.updateStatus(decl.id, req, 'MedicationRequest', 'status', c.subject, c.allowed, c.change, (resource, status, change, stamp) => {
          const mr = resource as MedicationRequest;
          mr.status = status as MedicationRequest['status'];
          if (typeof change['reason'] === 'string' && change['reason'].trim()) mr.statusReason = { text: change['reason'].trim() };
          appendNote(mr, change, req, stamp);
        });
      }
    }
  }

  /** Every observation the record holds: the seed plus what entry forms recorded in this session. */
  private observations(): Observation[] {
    return [...this.data.observations, ...this.recorded];
  }

  /** The signed-in person as the FHIR reference every write names (performer, recorder, asserter). */
  private author(req: ExecutionRequest): { identifier: { system: string; value: string }; display?: string } {
    return { identifier: { system: 'urn:medapp:cognito-sub', value: req.userSub }, ...(req.userDisplay ? { display: req.userDisplay } : {}) };
  }

  /** A retried submission (same client-generated identifier) is the earlier record, not a second one. */
  private replayOf<T extends { identifier?: { value?: string }[] }>(added: readonly T[], identifier: { value?: string }[] | undefined): T | undefined {
    const value = identifier?.[0]?.value;
    return value ? added.find((r) => r.identifier?.some((i) => i.value === value)) : undefined;
  }

  /** A version-aware status change on the patient's own record — the mock twin of the dispatcher's `_status_update`. */
  private updateStatus(
    primitiveId: string,
    req: ExecutionRequest,
    resourceType: 'Condition' | 'MedicationRequest' | 'Task',
    statusField: string,
    subject: string | undefined,
    allowed: readonly string[],
    change: Record<string, unknown>,
    apply: (resource: Resource, status: string, change: Record<string, unknown>, stamp: string) => void
  ): Resource {
    const targetId = typeof change['id'] === 'string' ? change['id'] : undefined;
    const current = targetId ? this.collection(resourceType).find((r) => r.id === targetId) : undefined;
    // On a worklist there is no patient in context: the task's own patient is the one the change is about.
    const subjectId = subject ? patientIdOf(subject) : patientIdOf((current as Task | undefined)?.for?.reference ?? '');
    const problems = validateStatusChange({ allowed }, change, current, resourceType, statusField, subjectId);
    if (problems.length) throw new WriteRejectedError(primitiveId, problems);
    const currentVersion = current?.meta?.versionId ?? '1';
    if (change['versionId'] !== undefined && change['versionId'] !== null && String(change['versionId']) !== currentVersion) throw new Error(VERSION_CONFLICT_MESSAGE);
    const stamp = this.now.toISOString();
    const updated = JSON.parse(JSON.stringify(current)) as Resource;
    apply(updated, String(change['status']), change, stamp);
    updated.meta = { ...(updated.meta ?? {}), versionId: String(Number(currentVersion) + 1), lastUpdated: stamp, source: `urn:medapp:${req.manifest.metadata.app_id}@${req.manifest.metadata.version}` };
    this.updated.set(`${resourceType}/${targetId}`, updated);
    return updated;
  }

  /** The app's own form (carried in its manifest) first, then the record's questionnaires — the dispatcher resolves the same way. */
  private findQuestionnaire(ref: string, artifacts: Artifacts | undefined): Questionnaire | undefined {
    const own = findArtifactQuestionnaire(artifacts, ref);
    if (own) return own as unknown as Questionnaire;
    return this.data.questionnaires.find((q) => q.url === ref || q.id === ref);
  }

  private collection(resource: string): Resource[] {
    const overlay = (items: Resource[]): Resource[] => (this.updated.size ? items.map((r) => this.updated.get(`${r.resourceType}/${r.id}`) ?? r) : items);
    switch (resource) {
      case 'Condition':
        return overlay([...this.data.conditions, ...this.addedConditions]);
      case 'MedicationRequest':
        return overlay(this.data.medicationRequests);
      case 'Observation':
        return this.observations();
      case 'ImagingStudy':
        return this.data.imagingStudies;
      case 'Questionnaire':
        return this.data.questionnaires;
      case 'QuestionnaireResponse':
        return [...this.data.questionnaireResponses, ...this.created];
      case 'AllergyIntolerance':
        return [...this.data.allergies, ...this.addedAllergies];
      case 'Procedure':
        return [...this.data.procedures, ...this.addedProcedures];
      case 'Task':
        return overlay([...this.data.tasks, ...this.addedTasks]);
      case 'Media':
        return [...this.data.media, ...this.addedMedia];
      case 'Immunization':
        return this.data.immunizations;
      case 'Encounter':
        return [...this.data.encounters, ...(this.addedRecords.get('Encounter') ?? [])];
      case 'DiagnosticReport':
        return this.data.diagnosticReports;
      case 'DocumentReference':
        return [...this.data.documents, ...(this.addedRecords.get('DocumentReference') ?? [])];
      case 'Goal':
        return [...this.data.goals, ...(this.addedRecords.get('Goal') ?? [])];
      case 'CarePlan':
        return [...this.data.carePlans, ...(this.addedRecords.get('CarePlan') ?? [])];
      case 'Consent':
        return [...this.data.consents, ...(this.addedRecords.get('Consent') ?? [])];
      default:
        return this.addedRecords.get(resource) ?? [];
    }
  }

  /** The same search-parameter subset the dispatcher's in-memory source honours (fhir_source.py). */
  private query(resource: string, params: Record<string, string>, count: number): Resource[] {
    const patient = params['patient'] ?? params['subject'];
    const codes = params['code']?.split(',').map((s) => s.trim());
    const clinicalStatus = params['clinical-status'];
    const status = params['status'];
    const questionnaire = params['questionnaire'];
    const url = params['url'];
    const category = params['category'];
    const type = params['type'];
    const since = params['date']?.startsWith('ge') ? params['date'].slice(2) : undefined;

    const filtered = this.collection(resource).filter((r) => {
      const rec = r as Resource & {
        subject?: { reference?: string };
        patient?: { reference?: string };
        status?: string;
        questionnaire?: string;
        url?: string;
        category?: Condition['category'];
        type?: Condition['code'] | Condition['category'];
        clinicalStatus?: Condition['clinicalStatus'];
      };
      if (patient && !subjectIs(rec, patientIdOf(patient))) return false;
      if (status && !status.split(',').map((t) => t.trim()).includes(rec.status ?? '')) return false; // a token list is an OR, as on a server
      if (questionnaire && rec.questionnaire !== questionnaire) return false;
      if (url && rec.url !== url) return false;
      if (codes && r.resourceType === 'Media') {
        if (!(r as Media).reasonCode?.some((c) => conceptMatches(c, codes))) return false; // what the photo documents; no `code` search parameter on a server either
      } else if (codes) {
        const concept =
          r.resourceType === 'MedicationRequest'
            ? (r as { medicationCodeableConcept?: Condition['code'] }).medicationCodeableConcept
            : r.resourceType === 'Immunization'
              ? (r as { vaccineCode?: Condition['code'] }).vaccineCode
              : (r as Condition | Observation).code;
        if (!conceptMatches(concept, codes)) return false;
      }
      // Condition and AllergyIntolerance both carry a clinicalStatus.
      if (clinicalStatus && !rec.clinicalStatus?.coding?.some((k) => k.code === clinicalStatus)) return false;
      if (category && !tokenInConcepts(rec.category, category)) return false;
      if (type && !tokenInConcepts(rec.type, type)) return false;
      if (since && resourceDate(r) < since) return false;
      return true;
    });

    const sorted = params['_sort'] === 'date' ? newestFirst(filtered, resourceDate).reverse() : newestFirst(filtered, resourceDate);
    return sorted.slice(0, count);
  }
}

/**
 * A form's numeric answers as derived Observations — one per answer to a named question, coded `questionnaire URL | linkId`,
 * dated when the response was authored, the unit from the Questionnaire's item (its unit extension) when it is known. Not
 * stored: a view the trend chart and the readings table draw like any measurement. Mirrors primitives.py `_answers_as_observations`.
 */
export function answersAsObservations(responses: readonly QuestionnaireResponse[], questionnaire: Questionnaire | undefined, url: string, linkIds: readonly string[]): Observation[] {
  const items = new Map<string, QuestionnaireItem>();
  const index = (list: QuestionnaireItem[] | undefined) => list?.forEach((i) => (items.set(i.linkId, i), index(i.item)));
  index(questionnaire?.item);
  const unitOf = (linkId: string) => items.get(linkId)?.extension?.find((e) => e.url === 'http://hl7.org/fhir/StructureDefinition/questionnaire-unit')?.valueCoding?.display;
  const textOf = (linkId: string, fallback?: string) => items.get(linkId)?.text ?? fallback ?? linkId;
  const out: Observation[] = [];
  const walk = (response: QuestionnaireResponse, list: QuestionnaireResponseItem[] | undefined) => {
    for (const item of list ?? []) {
      if (linkIds.includes(item.linkId)) {
        for (const a of item.answer ?? []) {
          const value = a.valueDecimal ?? a.valueInteger;
          if (value === undefined) continue;
          const unit = unitOf(item.linkId);
          out.push({
            resourceType: 'Observation',
            id: `qr-${response.id}-${item.linkId}`,
            status: 'final',
            code: { coding: [{ system: url, code: item.linkId, display: textOf(item.linkId, item.text) }], text: textOf(item.linkId, item.text) },
            ...(response.subject?.reference ? { subject: { reference: response.subject.reference } } : {}),
            effectiveDateTime: response.authored,
            valueQuantity: { value, ...(unit ? { unit } : {}) },
            derivedFrom: [{ reference: `QuestionnaireResponse/${response.id}` }],
          });
        }
      }
      walk(response, item.item);
      for (const a of item.answer ?? []) walk(response, a.item);
    }
  };
  for (const r of responses) walk(r, r.item);
  return out;
}

/** The first coding's code of a CodeableConcept, if any. */
function codeIn(concept: { coding?: { code?: string }[] } | undefined): string | undefined {
  return concept?.coding?.find((c) => c.code)?.code;
}

/** A free-text remark on a status change, attributed and timed by the platform, never by the client. */
function appendNote(resource: Resource & { note?: { authorString?: string; time?: string; text: string }[] }, change: Record<string, unknown>, req: ExecutionRequest, stamp: string): void {
  const text = typeof change['note'] === 'string' ? change['note'].trim() : '';
  if (text) resource.note = [...(resource.note ?? []), { authorString: req.userDisplay ?? req.userSub, time: stamp, text }];
}

/** The few fields the picker shows (mirror of the dispatcher's `patient_summary`). */
export function patientHit(p: Patient): PatientHit {
  const name = p.name?.[0];
  const display = name?.text ?? [name?.given?.join(' '), name?.family].filter(Boolean).join(' ') ?? p.id ?? '';
  return {
    id: p.id ?? '',
    name: display || (p.id ?? ''),
    birthDate: p.birthDate,
    gender: p.gender,
    identifiers: (p.identifier ?? []).filter((i) => i.value).map((i) => ({ system: i.system, value: i.value })),
  };
}
