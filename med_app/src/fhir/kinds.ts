import closed from './closed-kinds.json';
import openKinds from './open-kind-definitions.json';
import { BASE_QUERY_RESOURCES } from '../primitives/data/queryResources';

/**
 * Which kinds of record an app may write, as a rule rather than a list.
 *
 * - The platform ADMITS five kinds (RECORD_RESOURCES): it knows their stamps — status, patient, author, dates — and a
 *   `record` section may declare their fields inline.
 * - It REFUSES the kinds with teeth by name (CLOSED_KINDS, src/fhir/closed-kinds.json — the policy, reviewed in a pull
 *   request): prescriptions and orders, scheduling, identity, billing, anything computed, the kinds with a tailored
 *   section of their own, and what the platform writes itself.
 * - Everything else that is PATIENT-SCOPED in FHIR R4 — a resource whose `subject` or `patient` is a Reference to Patient,
 *   computed from the definitions at extraction time (scripts/extract-fhir-definitions.mjs) — it OPENS to administrators:
 *   a shape for such a kind declares the stamps itself, and only an administrator may define it. Opening a kind is
 *   therefore nobody's code change; refusing one is.
 */
export const RECORD_RESOURCES = ['Goal', 'CarePlan', 'Encounter', 'DocumentReference', 'Consent'] as const;
export type RecordResource = (typeof RECORD_RESOURCES)[number];

/** Kinds no shape may write, and why — said to the author instead of "unknown". */
export const CLOSED_KINDS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(closed as Record<string, string>).filter(([k]) => !k.startsWith('_')));

/** Every patient-scoped resource type of R4, from the definitions. */
export const PATIENT_SCOPED_KINDS: readonly string[] = (openKinds as { patient_scoped: string[] }).patient_scoped;

/** The kinds administrators may define shapes for: patient-scoped, not admitted, not refused. */
export const OPEN_KINDS: readonly string[] = PATIENT_SCOPED_KINDS.filter((k) => !(RECORD_RESOURCES as readonly string[]).includes(k) && !(k in CLOSED_KINDS));

/** The element paths (path, cardinality, types) of the open kinds the base definitions do not carry. */
export const OPEN_KIND_PATHS = (openKinds as { paths: Record<string, { path: string; min?: number; max?: string; type?: { code: string }[] }[]> }).paths;

export function isAdmittedKind(resource: string): resource is RecordResource {
  return (RECORD_RESOURCES as readonly string[]).includes(resource);
}
export function isOpenKind(resource: string): boolean {
  return OPEN_KINDS.includes(resource);
}

/** What is wrong with a kind, or nothing: admitted and open kinds pass; closed kinds say why; anything else is not patient-scoped or unknown. */
export function kindIssue(resource: string): string | undefined {
  if (isAdmittedKind(resource) || isOpenKind(resource)) return undefined;
  const why = CLOSED_KINDS[resource];
  if (why) return `${resource} is not a kind a shape may write: ${why}`;
  if (PATIENT_SCOPED_KINDS.includes(resource)) return `${resource} is not a kind a shape may write`; // closed without a reason: cannot happen, every refusal names its reason
  return `${resource} is not a kind the platform knows as a patient's record — admitted: ${RECORD_RESOURCES.join(', ')}; open to administrators: ${OPEN_KINDS.join(', ')}`;
}

/**
 * What the dispatcher needs of this module, as data (infra/lambdas/dispatcher/data/record-kinds.json, written by
 * `npm run export:kinds`): the kinds and the query allow-list. Both sides' tests fail when the file lags the rule.
 */
export function recordKinds(): { admitted: string[]; open: string[]; closed: Record<string, string>; query_resources: string[] } {
  return { admitted: [...RECORD_RESOURCES], open: [...OPEN_KINDS], closed: { ...CLOSED_KINDS }, query_resources: [...BASE_QUERY_RESOURCES, ...OPEN_KINDS.filter((k) => !(BASE_QUERY_RESOURCES as readonly string[]).includes(k))] };
}
