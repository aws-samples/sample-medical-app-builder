import type { AppManifest, DicomScopeEntry, FhirScopeEntry, PhiField, RoleDecl } from './schema';
import type { IdentityClaims } from '../auth/types';

/** The scope a role actually gets after following `inherits`. Computed, then frozen. */
export interface EffectiveScope {
  readonly role: string;
  readonly fhir: readonly FhirScopeEntry[];
  readonly dicom: readonly DicomScopeEntry[];
  readonly patient_scope: 'individual' | 'cohort' | 'population';
  readonly phi_fields_visible: readonly PhiField[];
  /** Scope ids that contributed, most specific last. Useful in audit records. */
  readonly lineage: readonly string[];
}

/**
 * Platform groups (mirrored from infra/medapp_shared/identity_model.py). They decide who may
 * author, approve and administer — and, in the UI, who gets the inspector tools that clinicians
 * never need to see.
 */
export const PLATFORM_GROUPS = {
  admins: 'medapp-admins',
  approvers: 'medapp-approvers',
  authors: 'medapp-authors',
  viewers: 'medapp-viewers',
} as const;

/** Staff tooling (inspector, preview-as) is for people who build or sign off apps — not for blanket viewers. */
const STAFF_GROUPS: readonly string[] = [PLATFORM_GROUPS.admins, PLATFORM_GROUPS.approvers, PLATFORM_GROUPS.authors];

/** Members open every app, running as the manifest's `default_role`. */
const BLANKET_ACCESS_GROUPS: readonly string[] = [PLATFORM_GROUPS.viewers, PLATFORM_GROUPS.approvers, PLATFORM_GROUPS.admins];

export function isPlatformStaff(claims: IdentityClaims): boolean {
  const groups = new Set(claims.groups);
  return STAFF_GROUPS.some((g) => groups.has(g));
}

export function hasBlanketAccess(claims: IdentityClaims): boolean {
  const groups = new Set(claims.groups);
  return BLANKET_ACCESS_GROUPS.some((g) => groups.has(g));
}

/* ── who may do what in the authoring loop (mirrors identity_model.can_author/can_iterate/can_approve) ── */

export function isAdmin(claims: IdentityClaims): boolean {
  return claims.groups.includes(PLATFORM_GROUPS.admins);
}

/** May open a draft and create a new app or version. */
export function canAuthor(claims: IdentityClaims): boolean {
  return claims.groups.includes(PLATFORM_GROUPS.authors) || isAdmin(claims);
}

/** Collections — how the hospital groups its apps for the launcher: approvers and admins, the governance people (mirrors `can_curate`). */
export function canCurate(claims: IdentityClaims): boolean {
  return claims.groups.includes(PLATFORM_GROUPS.approvers) || isAdmin(claims);
}

/** New versions of an existing app, and submitting it for review: its owner (if an author) or an admin. */
export function canIterate(claims: IdentityClaims, ownerSub: string | undefined): boolean {
  return isAdmin(claims) || (canAuthor(claims) && !!ownerSub && claims.sub === ownerSub);
}

/** Approve / publish: approvers and admins — never the version's own author (separation of duties). */
export function canApprove(claims: IdentityClaims, authorSub: string | undefined): boolean {
  if (authorSub && claims.sub === authorSub) return false;
  return claims.groups.includes(PLATFORM_GROUPS.approvers) || isAdmin(claims);
}

/**
 * The roles a person holds for an app. Two sources, mirrored by the dispatcher
 * (infra/medapp_shared/identity_model.py::effective_roles):
 *  - per-app groups `app-{app_id}-{role}` (the mock auth provider issues `app-*-{role}` wildcards)
 *  - blanket-access platform groups, which grant the manifest's `default_role`
 * Empty means the person may not open the app.
 */
export function entitledRoles(manifest: AppManifest, claims: IdentityClaims): RoleDecl[] {
  const direct = manifest.auth.roles.filter((role) =>
    claims.groups.some((g) => g === role.cognito_group || g === `app-*-${role.id}`)
  );
  if (hasBlanketAccess(claims) && !direct.some((r) => r.id === manifest.auth.default_role)) {
    const fallback = manifest.auth.roles.find((r) => r.id === manifest.auth.default_role);
    if (fallback) return [...direct, fallback];
  }
  return direct;
}

export interface AppAccess {
  /** Roles the person holds for this app (per-app groups + blanket access). */
  readonly roles: RoleDecl[];
  /** May the person open this version? Requires a role and, unless staff, a published version. */
  readonly canOpen: boolean;
  /** Why not, when `canOpen` is false. */
  readonly reason?: 'no_role' | 'not_published';
}

/**
 * The single visibility rule the launcher and the runtime share. Staff (authors, approvers,
 * admins — and anyone in mock mode) may open drafts and versions in review; clinicians only
 * published versions. In mock mode a missing role falls back to the manifest default so the
 * renderer can be exercised without a user pool; a real deployment never does that.
 */
export function appAccess(manifest: AppManifest, claims: IdentityClaims, opts: { readonly isMock: boolean }): AppAccess {
  const roles = entitledRoles(manifest, claims);
  const staff = opts.isMock || isPlatformStaff(claims);
  const hasRole = opts.isMock || roles.length > 0;
  if (!hasRole) return { roles, canOpen: false, reason: 'no_role' };
  if (!staff && manifest.lifecycle.state !== 'published') return { roles, canOpen: false, reason: 'not_published' };
  return { roles, canOpen: true };
}

export interface RoleSelection {
  readonly role: RoleDecl;
  readonly source: 'group' | 'default';
}

export function selectInitialRole(manifest: AppManifest, claims: IdentityClaims): RoleSelection {
  const entitled = entitledRoles(manifest, claims);
  // Prefer the most capable entitled role; the panel lets the user step down explicitly.
  const best = [...entitled].sort((a, b) => b.ui_capabilities.length - a.ui_capabilities.length)[0];
  if (best) return { role: best, source: 'group' };
  const fallback = manifest.auth.roles.find((r) => r.id === manifest.auth.default_role) ?? manifest.auth.roles[0];
  if (!fallback) throw new Error('Manifest declares no roles.');
  return { role: fallback, source: 'default' };
}

export function resolveEffectiveScope(manifest: AppManifest, roleId: string): EffectiveScope {
  const role = manifest.auth.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`Role "${roleId}" is not declared in the manifest.`);

  // Walk the inherits chain base→leaf so later scopes override earlier ones.
  const chain: string[] = [];
  let cursor: string | undefined = role.data_scope_ref;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`Cyclic scope inheritance at "${cursor}".`);
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = manifest.data_scopes[cursor]?.inherits;
  }

  const fhir: FhirScopeEntry[] = [];
  const dicom: DicomScopeEntry[] = [];
  let patient_scope: EffectiveScope['patient_scope'] = 'individual';
  let phi: readonly PhiField[] = [];
  for (const id of chain) {
    const scope = manifest.data_scopes[id];
    if (!scope) throw new Error(`Scope "${id}" is not declared.`);
    fhir.push(...(scope.fhir ?? []));
    dicom.push(...(scope.dicom ?? []));
    if (scope.patient_scope) patient_scope = scope.patient_scope;
    if (scope.phi_fields_visible) phi = scope.phi_fields_visible;
  }

  return Object.freeze({ role: roleId, fhir, dicom, patient_scope, phi_fields_visible: phi, lineage: chain });
}

/**
 * PHI fields that at least one *other* role of the app may see. A field the current role lacks is
 * worth announcing as "hidden" only if it is in this set — then its absence is an access decision the
 * clinician should know about. A field no role of the app can see is simply not part of the app.
 */
export function phiFieldsVisibleToOtherRoles(manifest: AppManifest, roleId: string): PhiField[] {
  const out = new Set<PhiField>();
  for (const role of manifest.auth.roles) {
    if (role.id === roleId) continue;
    for (const field of resolveEffectiveScope(manifest, role.id).phi_fields_visible) out.add(field);
  }
  return [...out];
}

export function isFhirResourceInScope(scope: EffectiveScope, resourceType: string, operation: 'read' | 'search' | 'create' | 'update'): boolean {
  return scope.fhir.some((e) => e.resource === resourceType && e.operations.includes(operation));
}

export function isDicomOperationInScope(scope: EffectiveScope, operation: 'qido' | 'wado' | 'stow'): boolean {
  return scope.dicom.some((e) => e.operations.includes(operation));
}
