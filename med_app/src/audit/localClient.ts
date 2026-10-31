import type { AuditRecord } from '../primitives/data/types';
import { kindGroupOf, type AuditClient, type AuditEntry, type AuditOutcome, type AuditPage, type AuditQuery } from './types';

const STORAGE_KEY = 'med_app.local_audit';
const MAX_RANGE_DAYS = 92;

/**
 * The trail in mock mode: a few seeded records, plus every record the apps running in this browser produce (the
 * runtime hands them over as it hands them to the inspector), kept in sessionStorage. Same query rules as the API —
 * newest first, the default window, the filters, a cursor — so the page behaves the same against either.
 */
export class LocalAuditStore {
  private entries: AuditEntry[] | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly now: () => Date = () => new Date()
  ) {}

  all(): AuditEntry[] {
    if (this.entries) return this.entries;
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this.entries = JSON.parse(raw) as AuditEntry[];
      } catch {
        this.entries = null;
      }
    }
    this.entries ??= seedEntries(this.now());
    return this.entries;
  }

  /**
   * A record from a running app (the renderer's shape), attributed to the signed-in person. Under the id the executor
   * minted, so the inspector's row and the trail's are the same record — as in a deployment, where the dispatcher's.
   */
  record(r: AuditRecord, who: { sub: string; name?: string; email?: string }): void {
    const entry: AuditEntry = {
      audit_id: r.audit_id ?? `local-${Math.random().toString(36).slice(2, 12)}`,
      timestamp: r.timestamp,
      kind: r.kind,
      user_sub: who.sub,
      ...(who.name ? { user_name: who.name } : {}),
      ...(who.email ? { user_email: who.email } : {}),
      outcome: r.outcome,
      ...(r.detail ? { detail: r.detail } : {}),
      source: 'mock',
      app_id: r.app_id,
      manifest_version: r.manifest_version,
      primitive_id: r.primitive_id,
      role: r.role,
      ...(r.patient_context ? { patient_context: r.patient_context } : {}),
      duration_ms: r.duration_ms,
    };
    this.all().push(entry);
    this.save();
  }

  add(entry: AuditEntry): void {
    this.all().push(entry);
    this.save();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(): void {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.all()));
    this.listeners.forEach((l) => l());
  }
}

function seedEntries(now: Date): AuditEntry[] {
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  const id = (n: number) => `seed-${String(n).padStart(3, '0')}`;
  const lukas = {
    user_sub: 'sub-u-hoffmann',
    user_name: 'Lukas Hoffmann',
    user_email: 'lukas.hoffmann@klinikum-musterstadt.example',
  };
  const karin = {
    user_sub: 'sub-u-neumann',
    user_name: 'Karin Neumann',
    user_email: 'karin.neumann@klinikum-musterstadt.example',
  };
  const sabine = {
    user_sub: 'sub-u-weber',
    user_name: 'Sabine Weber',
    user_email: 'sabine.weber@klinikum-musterstadt.example',
  };
  const ada = {
    user_sub: 'sub-u-admin',
    user_name: 'Ada Admin',
    user_email: 'admin@klinikum-musterstadt.example',
  };
  return [
    {
      audit_id: id(1),
      timestamp: at(2),
      kind: 'data.fhir.patient.read',
      ...lukas,
      outcome: 'ok',
      source: 'dispatcher',
      app_id: 'app_patient_360',
      manifest_version: '1.0.0',
      primitive_id: 'p_patient',
      role: 'clinician',
      role_source: 'group',
      patient_context: 'pat-kms-0001',
      duration_ms: 41,
      result_summary: 'Patient/pat-kms-0001',
    },
    {
      audit_id: id(2),
      timestamp: at(2),
      kind: 'data.fhir.query',
      ...lukas,
      outcome: 'ok',
      source: 'dispatcher',
      app_id: 'app_patient_360',
      manifest_version: '1.0.0',
      primitive_id: 'p_conditions',
      role: 'clinician',
      role_source: 'group',
      patient_context: 'pat-kms-0001',
      duration_ms: 88,
      result_summary: '3 resources',
    },
    {
      audit_id: id(3),
      timestamp: at(5),
      kind: 'write.fhir.questionnaire_response.submit',
      ...karin,
      outcome: 'ok',
      source: 'dispatcher',
      app_id: 'app_hypertension_follow_up',
      manifest_version: '1.0.0',
      primitive_id: 'p_submit',
      role: 'hypertension_nurse',
      role_source: 'group',
      patient_context: 'pat-kms-0003',
      duration_ms: 212,
      resource_ref: 'QuestionnaireResponse/qr-1042',
      provenance: 'recorded',
    },
    {
      audit_id: id(4),
      timestamp: at(7),
      kind: 'data.cohort.by_condition',
      ...karin,
      outcome: 'refused',
      source: 'dispatcher',
      app_id: 'app_hypertension_register',
      manifest_version: '1.0.0',
      primitive_id: 'p_cohort',
      role: 'hypertension_clinic',
      duration_ms: 3,
      detail: 'patient_scope: cohort',
    },
    {
      audit_id: id(5),
      timestamp: at(26),
      kind: 'platform.patient.search',
      ...lukas,
      outcome: 'ok',
      source: 'dispatcher',
      query: 'krü',
      result_summary: '1 patients',
      duration_ms: 35,
    },
    {
      audit_id: id(6),
      timestamp: at(30),
      kind: 'platform.user.create',
      ...ada,
      outcome: 'ok',
      source: 'user_admin',
      target_username: 'u-brandt',
      email: 'tobias.brandt@klinikum-musterstadt.example',
      groups_added: ['app-app_imaging_3d-radiologist'],
      detail: 'account created; tobias.brandt@klinikum-musterstadt.example; added app-app_imaging_3d-radiologist',
    },
    {
      audit_id: id(7),
      timestamp: at(52),
      kind: 'lifecycle.published',
      ...sabine,
      outcome: 'ok',
      source: 'registry',
      app_id: 'app_falls_risk',
      manifest_version: '1.0.0',
      from_state: 'approved',
      to_state: 'published',
      detail: 'approved → published',
    },
    {
      audit_id: id(8),
      timestamp: at(53),
      kind: 'lifecycle.approved',
      ...sabine,
      outcome: 'ok',
      source: 'registry',
      app_id: 'app_falls_risk',
      manifest_version: '1.0.0',
      from_state: 'in_review',
      to_state: 'approved',
      detail: 'in_review → approved: Form reviewed with the geriatric wards.',
    },
    {
      audit_id: id(9),
      timestamp: at(75),
      kind: 'lifecycle.in_review',
      ...lukas,
      outcome: 'ok',
      source: 'registry',
      app_id: 'app_falls_risk',
      manifest_version: '1.0.0',
      from_state: 'draft',
      to_state: 'in_review',
      detail: 'draft → in_review',
    },
    {
      audit_id: id(10),
      timestamp: at(26 * 24),
      kind: 'data.fhir.observation.by_code',
      ...lukas,
      outcome: 'error',
      source: 'dispatcher',
      app_id: 'app_cardio_renal',
      manifest_version: '1.0.0',
      primitive_id: 'p_series',
      role: 'physician',
      role_source: 'group',
      patient_context: 'pat-kms-0001',
      duration_ms: 15_004,
      detail: 'upstream timeout after 15 s',
    },
  ];
}

function matches(entry: AuditEntry, q: AuditQuery, from: string, to: string): boolean {
  if (entry.timestamp < from || entry.timestamp > to) return false;
  if (q.id && entry.audit_id !== q.id) return false;
  if (q.user && entry.user_sub !== q.user) return false;
  if (q.app && entry.app_id !== q.app) return false;
  if (q.patient && entry.patient_context !== q.patient) return false;
  if (q.outcome && (entry.outcome ?? 'ok') !== q.outcome) return false;
  if (q.kind && kindGroupOf(entry.kind) !== q.kind && !entry.kind.startsWith(q.kind)) return false;
  return true;
}

function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

export function localAuditClient(store: LocalAuditStore, now: () => Date = () => new Date(), delayMs = 60): AuditClient {
  return {
    kind: 'local',
    async query(q: AuditQuery): Promise<AuditPage> {
      await new Promise((r) => setTimeout(r, delayMs));
      const to = q.to ? (q.to.length === 10 ? endOfDay(q.to) : q.to) : now().toISOString();
      const from = q.from ? (q.from.length === 10 ? `${q.from}T00:00:00.000Z` : q.from) : new Date(new Date(to).getTime() - 7 * 86_400_000).toISOString();
      if (from > to) throw new Error('`from` is after `to`');
      if ((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw new Error(`a query covers at most ${MAX_RANGE_DAYS} days; narrow the range`);
      const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
      const offset = q.cursor ? Number(q.cursor) || 0 : 0;
      const all = store
        .all()
        .filter((e) => matches(e, q, from, to))
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      const records = all.slice(offset, offset + limit);
      return {
        records,
        cursor: offset + limit < all.length ? String(offset + limit) : null,
        range: { from, to },
      };
    },
  };
}

export type { AuditOutcome };
