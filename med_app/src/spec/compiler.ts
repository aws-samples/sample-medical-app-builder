import type { AppManifest, DataScope, FhirScopeEntry, RoleDecl } from '../manifest/schema';
import { validateManifest } from '../manifest/schema';
import { DESIGN_SYSTEM_VERSION } from '../primitives/versions';
import type { ArchetypeDef, BlockPrimitive, BuildOutput } from './archetype';
import { ARCHETYPES } from './archetypes';
import { buildContext, validateSpec, type AppSpec } from './appSpec';
import type { ShapeLookup } from './shapes';
import { clean, mergeScopeEntries, orderPhi, pageShell } from './blocks';
import type { RoleSpec, SpecIssue } from './common';

/**
 * spec → manifest, deterministically. The archetype supplies the data plan and layout; this file
 * adds what is the same for every app: identity and access (auth, derived data scopes),
 * governance (audit), metadata and a draft lifecycle. The result is validated against the same
 * schema the renderer and the registry use before it is returned.
 */

export const COMPILER_VERSION = '0.1.0';

export interface CompileOptions {
  readonly hospital_id: string;
  /** ISO timestamp; supplied by the caller so compilation is reproducible. */
  readonly created_at: string;
  readonly created_by_sub?: string;
  readonly provenance?: { readonly llm_trace_id?: string; readonly prompt_hash?: string };
  /** Canonical namespace of app-authored forms (`<base>/<app_id>-<form_id>`); defaults to `https://<hospital_id>.medapp.eu/Questionnaire`. */
  readonly questionnaire_base?: string;
  /** The published record shapes a `record` section may refer to by id. */
  readonly shapes?: ShapeLookup;
}

export type CompileResult = { ok: true; manifest: AppManifest } | { ok: false; issues: SpecIssue[] };

function buildFor(spec: AppSpec, options: CompileOptions): BuildOutput {
  // The union guarantees `knobs` is the archetype's own type; the registry lookup erases that, hence the cast.
  const def = ARCHETYPES[spec.archetype] as ArchetypeDef<unknown>;
  return def.build(buildContext(spec, options), spec.knobs);
}

export function groupNameFor(appId: string, role: RoleSpec): string {
  return role.group.kind === 'existing' ? role.group.name : `app-${appId}-${role.id}`;
}

export const scopeIdFor = (roleId: string): string => `scope_${roleId}`;

/** The primitives a role's app run actually issues: everything ungated plus what is gated to it. */
function runnableBy(primitives: readonly BlockPrimitive[], roleId: string): BlockPrimitive[] {
  return primitives.filter((p) => !p.decl.only_for_roles || p.decl.only_for_roles.includes(roleId));
}

function fullScope(primitives: readonly BlockPrimitive[], roleId: string): FhirScopeEntry[] {
  return mergeScopeEntries(runnableBy(primitives, roleId).flatMap((p) => p.fhir));
}

/**
 * A role's data scope is what its primitives need — and for a role that inherits another, only the
 * additions: resources the parent already grants are not repeated, so the manifest reads as the
 * hand-authored ones do ("reviewer = viewer + Conditions + more PHI").
 */
function deriveScopes(spec: AppSpec, built: BuildOutput): Record<string, DataScope> {
  const scopes: Record<string, DataScope> = {};
  for (const role of spec.roles) {
    const own = fullScope(built.primitives, role.id);
    const parent = role.inherits ? spec.roles.find((r) => r.id === role.inherits) : undefined;
    const parentResources = new Set(parent ? fullScope(built.primitives, parent.id).map((e) => e.resource) : []);
    const fhir = own.filter((e) => !parentResources.has(e.resource));
    const dicom = mergeDicom(runnableBy(built.primitives, role.id).flatMap((p) => p.dicom ?? []));
    scopes[scopeIdFor(role.id)] = clean({
      inherits: parent ? scopeIdFor(parent.id) : undefined,
      patient_scope: parent ? undefined : built.patient_scope,
      phi_fields_visible: orderPhi(role.phi_fields_visible),
      fhir: fhir.length ? fhir : undefined,
      dicom: dicom.length ? dicom : undefined,
    });
  }
  return scopes;
}

/** One DICOM entry per role: operations and modalities are unioned (an unrestricted entry makes the union unrestricted). */
function mergeDicom(entries: readonly NonNullable<DataScope['dicom']>[number][]): NonNullable<DataScope['dicom']> {
  const out: NonNullable<DataScope['dicom']> = [];
  for (const e of entries) {
    const existing = out[0];
    if (!existing) {
      out.push(clean({ ...e, operations: [...e.operations], modalities: e.modalities ? [...e.modalities] : undefined }));
      continue;
    }
    for (const op of e.operations) if (!existing.operations.includes(op)) existing.operations.push(op);
    if (!e.modalities || !existing.modalities) delete existing.modalities;
    else for (const m of e.modalities) if (!existing.modalities.includes(m)) existing.modalities.push(m);
  }
  return out;
}

export function compileSpec(input: unknown, options: CompileOptions): CompileResult {
  const validated = validateSpec(input, options);
  if (!validated.ok) return validated;
  const spec = validated.spec;
  const built = buildFor(spec, options);

  const roles: RoleDecl[] = spec.roles.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    cognito_group: groupNameFor(spec.app.app_id, r),
    data_scope_ref: scopeIdFor(r.id),
    ui_capabilities: [...r.capabilities],
  }));

  const manifest = clean({
    apiVersion: 'medapp.eu/v1' as const,
    kind: 'AppManifest' as const,
    metadata: clean({
      app_id: spec.app.app_id,
      version: spec.app.version,
      parent_version: spec.app.parent_version,
      name: spec.app.name,
      description: spec.app.description,
      intent_class: built.intent_class,
      hospital_id: options.hospital_id,
      created_by_sub: options.created_by_sub,
      created_at: options.created_at,
    }),
    lifecycle: {
      state: 'draft' as const,
      signoff: null,
      provenance: clean({ generated_by_pipeline_version: COMPILER_VERSION, llm_trace_id: options.provenance?.llm_trace_id, prompt_hash: options.provenance?.prompt_hash }),
    },
    auth: { roles, default_role: spec.default_role },
    data_scopes: deriveScopes(spec, built),
    primitives: built.primitives.map((p) => p.decl),
    layout: { design_system_version: DESIGN_SYSTEM_VERSION, root: pageShell(built.children) },
    context_inputs: [...built.context_inputs],
    actions: built.actions ? [...built.actions] : undefined,
    // The forms designed in the conversation travel with the app: reviewed, hashed and signed with it.
    artifacts: built.questionnaires?.length ? { questionnaires: [...built.questionnaires] } : undefined,
    audit: clean({
      clinical_context: spec.governance.clinical_context,
      intended_users: [...spec.governance.intended_users],
      intended_purpose: spec.governance.intended_purpose,
      mdr_classification: spec.governance.mdr_classification,
      data_categories: spec.governance.data_categories ?? ['phi', ...built.data_categories],
    }),
  });

  // The compiler's own output goes through the renderer's gate; a failure here is a compiler bug.
  const result = validateManifest(manifest);
  if (!result.ok) return { ok: false, issues: result.issues.map((i) => ({ path: `manifest.${i.path}`, message: `compiler produced an invalid manifest: ${i.message}` })) };
  return { ok: true, manifest: result.manifest };
}
