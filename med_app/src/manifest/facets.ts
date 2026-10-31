import type { RegistryEntry } from './registry';
import { resolveEffectiveScope } from './roles';
import type { AppManifest, LayoutNode } from './schema';

/**
 * What an app is about, derived from its manifest — nothing is tagged by hand, so browsing stays true as the catalog
 * grows. One set of facets per app: the kind of app, who it is about (one patient, a cohort, the population), what it
 * shows (the clinical domains behind the FHIR resources its roles may read), what it records, its imaging, its forms,
 * who it is intended for and in which clinical context (from the governance the approver signed). The same facets feed
 * the filter chips and the search box. Pure functions; a hand-authored manifest without a spec gets the same facets as
 * a compiled one, because none of this needs the spec.
 */

export type FacetKey = 'kind' | 'scope' | 'shows' | 'records' | 'intended';

export interface AppFacets {
  /** Trend · Patient view · Cohort register · Worklist · Assessment · Imaging review · Documentation · … */
  readonly kind: string;
  readonly scope: 'One patient' | 'Cohort' | 'Population';
  /** Clinical domains read: Diagnoses, Observations, Medication, Imaging, Visits, Reports, … */
  readonly shows: readonly string[];
  /** What the app writes to the record, in words; empty for a read-only app. */
  readonly records: readonly string[];
  readonly imaging: readonly string[];
  /** Titles of the forms the app carries or fills. */
  readonly forms: readonly string[];
  /** From governance: "Cardiologist", "Hypertension nurse", … */
  readonly intended: readonly string[];
  readonly context?: string;
  /** Every `system|code` any role may read — for the search box, not for chips. */
  readonly codes: readonly string[];
  /** Lower-cased name, description and every facet, for one `includes` per app. */
  readonly search: string;
}

export const FACET_LABELS: Record<FacetKey, string> = { kind: 'Kind', scope: 'About', shows: 'Shows', records: 'Records', intended: 'Intended for' };

const RESOURCE_DOMAIN: Record<string, string> = {
  Condition: 'Diagnoses',
  Observation: 'Observations',
  MedicationRequest: 'Medication',
  MedicationStatement: 'Medication',
  MedicationAdministration: 'Medication',
  ImagingStudy: 'Imaging',
  DiagnosticReport: 'Reports',
  DocumentReference: 'Documents',
  Encounter: 'Visits',
  AllergyIntolerance: 'Allergies',
  Procedure: 'Procedures',
  Immunization: 'Immunizations',
  Questionnaire: 'Forms',
  QuestionnaireResponse: 'Forms',
  CarePlan: 'Care plans',
  Goal: 'Care plans',
  Consent: 'Consent',
  ServiceRequest: 'Orders',
  Specimen: 'Specimens',
  FamilyMemberHistory: 'Family history',
  Task: 'Tasks',
  Media: 'Photos',
};

const WRITE_LABELS: Record<string, string> = {
  'write.fhir.observation.create': 'Observations',
  'write.fhir.task.create': 'Tasks',
  'write.fhir.task.update_status': 'Task status',
  'write.fhir.media.create': 'Photos',
  'write.fhir.condition.create': 'Diagnoses',
  'write.fhir.allergy_intolerance.create': 'Allergies',
  'write.fhir.procedure.create': 'Procedures',
  'write.fhir.questionnaire_response.submit': 'Form answers',
  'write.fhir.condition.update_status': 'Diagnosis status',
  'write.fhir.medication_request.update_status': 'Prescription status',
};

const SCOPE_RANK = { individual: 0, cohort: 1, population: 2 } as const;

function hasComponent(node: LayoutNode, ...names: string[]): boolean {
  return names.includes(node.component) || (node.children ?? []).some((c) => hasComponent(c, ...names));
}

/** `general_practitioner` → "General practitioner"; `ckd_monitoring` → "CKD monitoring" stays simple: first letter up, underscores to spaces. */
export function humanise(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/**
 * The kind of app, read off its shape: a form makes it an assessment, a cohort a register, a viewer with nothing but
 * imaging around it an imaging review, a chart over observations alone a trend; the rest is a patient view. What an
 * app records is its own facet, not its kind — a patient view with an entry form is still a patient view.
 */
function kindOf(m: AppManifest, writes: readonly string[], shows: readonly string[], cohort: boolean): string {
  if (m.artifacts?.questionnaires?.length || hasComponent(m.layout.root, 'AssessmentForm') || writes.some((w) => w.includes('questionnaire_response'))) return 'Assessment';
  if (hasComponent(m.layout.root, 'Worklist', 'AssessmentDueList')) return 'Worklist';
  if (cohort) return hasComponent(m.layout.root, 'CohortTable') ? 'Cohort register' : 'Cohort figures';
  if (hasComponent(m.layout.root, 'DicomViewer') && shows.every((d) => d === 'Imaging' || d === 'Reports')) return 'Imaging review';
  switch (m.metadata.intent_class) {
    case 'cohort_dashboard':
      return 'Cohort figures';
    case 'workflow':
      return 'Documentation';
    case 'report':
      return 'Report';
    case 'search':
      return 'Search';
    default: {
      const charts = hasComponent(m.layout.root, 'ObservationTimeline');
      const only = m.primitives.filter((p) => p.kind !== 'data.fhir.patient.read');
      return charts && only.every((p) => p.kind === 'data.fhir.observation.by_code') ? 'Trend' : 'Patient view';
    }
  }
}

export function facetsOf(entry: Extract<RegistryEntry, { ok: true }>): AppFacets {
  const m = entry.manifest;
  const resources = new Set<string>();
  const codes = new Set<string>();
  const modalities = new Set<string>();
  let dicom = false;
  let widest: keyof typeof SCOPE_RANK = 'individual';
  for (const role of m.auth.roles) {
    const scope = resolveEffectiveScope(m, role.id);
    for (const f of scope.fhir) {
      resources.add(f.resource);
      f.codes?.forEach((c) => codes.add(c));
    }
    for (const d of scope.dicom) {
      dicom = true;
      d.modalities?.forEach((mod) => modalities.add(mod));
    }
    if (SCOPE_RANK[scope.patient_scope] > SCOPE_RANK[widest]) widest = scope.patient_scope;
  }
  for (const p of m.primitives) {
    const mods = (p.config as { modalities?: unknown }).modalities;
    if (Array.isArray(mods)) mods.forEach((mod) => typeof mod === 'string' && modalities.add(mod));
  }
  const shows = [...new Set([...resources].map((r) => RESOURCE_DOMAIN[r]).filter((d): d is string => Boolean(d)))];
  if (dicom && !shows.includes('Imaging')) shows.push('Imaging');
  const writePrimitives = m.primitives.filter((p) => p.kind.startsWith('write.'));
  // A declared-shape record is labelled by what it writes (its resource type), not by the primitive's name.
  const recordLabel = (p: AppManifest['primitives'][number]): string => {
    if (p.kind === 'write.fhir.record.create') {
      const resource = String((p.config as { resource?: unknown }).resource ?? '');
      return RESOURCE_DOMAIN[resource] ?? humanise(resource);
    }
    return WRITE_LABELS[p.kind] ?? humanise(p.kind.split('.').slice(2).join(' '));
  };
  const records = [...new Set(writePrimitives.map(recordLabel))];
  const forms = [...new Set([...(m.artifacts?.questionnaires ?? []).map((q) => q.title), ...m.primitives.filter((p) => p.kind === 'data.fhir.questionnaire.read').map((p) => String((p.config as { questionnaire?: unknown }).questionnaire ?? '')).filter((u) => u && !m.artifacts?.questionnaires?.some((q) => q.url === u || q.id === u)).map((u) => u.split('/').pop() ?? u)])];
  const imaging = [...modalities].sort();
  const cohort = widest !== 'individual';
  const kind = kindOf(m, writePrimitives.map((p) => p.kind), shows, cohort);
  const intended = (m.audit?.intended_users ?? []).map(humanise);
  const context = m.audit?.clinical_context ? humanise(m.audit.clinical_context) : undefined;
  const scope: AppFacets['scope'] = widest === 'population' ? 'Population' : widest === 'cohort' ? 'Cohort' : 'One patient';
  const search = [m.metadata.name, m.metadata.description ?? '', kind, scope, ...shows, ...records, ...imaging, ...forms, ...intended, context ?? '', m.audit?.intended_purpose ?? '', ...codes, ...m.auth.roles.map((r) => r.display_name)]
    .join(' ')
    .toLocaleLowerCase();
  return { kind, scope, shows: shows.sort(), records, imaging, forms, intended, ...(context ? { context } : {}), codes: [...codes], search };
}

export type FacetSelection = Partial<Record<FacetKey, readonly string[]>>;

function valuesOf(f: AppFacets, key: FacetKey): readonly string[] {
  switch (key) {
    case 'kind':
      return [f.kind];
    case 'scope':
      return [f.scope];
    case 'shows':
      return f.shows;
    case 'records':
      return f.records;
    case 'intended':
      return f.intended;
  }
}

/** Within a facet any selected value matches (OR); across facets every selected facet must match (AND). */
export function matchesSelection(f: AppFacets, selection: FacetSelection): boolean {
  return (Object.entries(selection) as [FacetKey, readonly string[] | undefined][]).every(([key, chosen]) => !chosen?.length || valuesOf(f, key).some((v) => chosen.includes(v)));
}

/** A free-text search over the facets: every word must appear somewhere. */
export function matchesSearch(f: AppFacets, needle: string): boolean {
  const words = needle.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => f.search.includes(w));
}

export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

/**
 * The values offered for one facet and how many apps carry each, counted among the apps that pass every *other*
 * facet and the search — so a chip says what choosing it would leave, and a chosen chip keeps its siblings visible.
 */
export function facetCounts(all: readonly AppFacets[], key: FacetKey, selection: FacetSelection, needle: string): FacetCount[] {
  const others: FacetSelection = { ...selection, [key]: [] };
  const pool = all.filter((f) => matchesSelection(f, others) && matchesSearch(f, needle));
  const counts = new Map<string, number>();
  for (const f of pool) for (const v of valuesOf(f, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of selection[key] ?? []) if (!counts.has(v)) counts.set(v, 0); // a chosen value stays visible even when nothing else matches it now
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
