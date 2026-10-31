import { z } from 'zod';
import { ArtifactsSchema } from './artifacts';

/**
 * AppManifest v0 — the artifact the agent pipeline produces and the renderer consumes.
 *
 * Design rules encoded here:
 *  - Sections are `strictObject`: an unknown key is a validation error, not a silent no-op.
 *    The LLM cannot smuggle behavior in through fields the renderer never reads.
 *  - `primitives[].config` and `layout.*.props` are free-form records: that is where the
 *    pipeline composes. Every value is still checked against the catalog at render time.
 *  - Fields the LLM must never set (hashes, sign-off, renderer output) are nullable and
 *    are filled by deterministic steps.
 */

export const INTENT_CLASSES = ['viewer', 'cohort_dashboard', 'workflow', 'report', 'search'] as const;
export const LIFECYCLE_STATES = ['draft', 'in_review', 'approved', 'published', 'deprecated'] as const;
export const PHI_FIELDS = ['name', 'dob', 'gender', 'mrn', 'address', 'phone', 'email'] as const;

export type IntentClass = (typeof INTENT_CLASSES)[number];
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type PhiField = (typeof PHI_FIELDS)[number];

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be an exact semver (e.g. 1.2.0) — manifests pin catalog versions');
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase identifier (a-z, 0-9, _)');

export const MetadataSchema = z.strictObject({
  app_id: z.string().min(1),
  version: semver,
  parent_version: semver.nullable().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  intent_class: z.enum(INTENT_CLASSES),
  hospital_id: z.string().min(1),
  created_by_sub: z.string().optional(),
  created_at: z.string().optional(),
  manifest_hash: z.string().nullable().optional(),
});

export const SignoffSchema = z.strictObject({
  approver_sub: z.string().nullable(),
  approved_at: z.string().nullable(),
  signature: z.string().nullable(),
  clinical_notes: z.string().nullable(),
});

export const LifecycleSchema = z.strictObject({
  state: z.enum(LIFECYCLE_STATES),
  signoff: SignoffSchema.nullable().optional(),
  provenance: z
    .strictObject({
      generated_by_pipeline_version: z.string().optional(),
      llm_trace_id: z.string().optional(),
      prompt_hash: z.string().optional(),
    })
    .optional(),
});

export const RoleSchema = z.strictObject({
  id: identifier,
  display_name: z.string().min(1),
  cognito_group: z.string().min(1),
  data_scope_ref: identifier,
  ui_capabilities: z.array(z.string()).default([]),
});

export const AuthSchema = z.strictObject({
  roles: z.array(RoleSchema).min(1),
  default_role: identifier,
});

export const FhirScopeEntrySchema = z.strictObject({
  resource: z.string().min(1),
  // `create`/`update` are what write primitives need; a role without them cannot author records.
  operations: z.array(z.enum(['read', 'search', 'create', 'update'])).min(1),
  codes: z.array(z.string()).optional(),
  filter: z.string().optional(),
});

export const DicomScopeEntrySchema = z.strictObject({
  operations: z.array(z.enum(['qido', 'wado', 'stow'])).min(1),
  modalities: z.array(z.string()).optional(),
  study_filter: z.string().optional(),
});

export const DataScopeSchema = z.strictObject({
  inherits: identifier.optional(),
  fhir: z.array(FhirScopeEntrySchema).optional(),
  dicom: z.array(DicomScopeEntrySchema).optional(),
  patient_scope: z.enum(['individual', 'cohort', 'population']).optional(),
  phi_fields_visible: z.array(z.enum(PHI_FIELDS)).optional(),
});

export const PrimitiveDeclSchema = z.strictObject({
  id: identifier,
  // data.* primitives run when the app loads; write.* primitives run only through an action.
  kind: z.string().regex(/^(data|write)\.[a-z0-9_.]+$/, 'primitive kinds look like data.fhir.observation.by_code or write.fhir.questionnaire_response.submit'),
  catalog_version: semver,
  config: z.record(z.string(), z.unknown()).default({}),
  output_binding: identifier,
  /** Execute only for these roles; other roles get an undefined binding. Keeps a role's data plan inside its scope. */
  only_for_roles: z.array(identifier).optional(),
});

export interface LayoutNode {
  component: string;
  props?: Record<string, unknown>;
  children?: LayoutNode[];
  show_only_if_role_in?: string[];
}

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.strictObject({
    component: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'component names are PascalCase catalog entries'),
    props: z.record(z.string(), z.unknown()).optional(),
    children: z.array(LayoutNodeSchema).optional(),
    show_only_if_role_in: z.array(identifier).optional(),
  })
);

export const LayoutSchema = z.strictObject({
  design_system_version: semver,
  root: LayoutNodeSchema,
});

export const ContextInputSchema = z.strictObject({
  name: identifier,
  type: z.enum(['fhir.reference', 'iso8601', 'string', 'number']),
  required: z.boolean().default(false),
  source: z.array(z.enum(['smart_launch', 'panel_selection', 'query'])).default(['panel_selection']),
  default: z.unknown().optional(),
});

/**
 * An action runs a write primitive on user intent (a form submission, a button). Its payload is
 * resolved from the same lookup language at the moment it runs — typically `$ui.<form state>`.
 */
export const ActionSchema = z.strictObject({
  id: identifier,
  label: z.string().min(1),
  /** Id of a `write.*` primitive declared in `primitives`. */
  primitive: identifier,
  /** What to do after success: re-run the app's data plan so new records show, or nothing. */
  on_success: z.enum(['reload', 'none']).default('reload'),
  /** Optional confirmation shown before the write. */
  confirm: z.string().optional(),
  success_message: z.string().optional(),
});

export const SharedArtifactsSchema = z.strictObject({
  cohorts: z.array(z.string()).default([]),
  report_templates: z.array(z.string()).default([]),
  prompt_templates: z.array(z.string()).default([]),
});

export const AuditSchema = z.strictObject({
  clinical_context: z.string().optional(),
  intended_users: z.array(z.string()).optional(),
  intended_purpose: z.string().optional(),
  mdr_classification: z.enum(['none', 'I', 'IIa', 'IIb', 'III']).optional(),
  data_categories: z.array(z.string()).optional(),
  retention: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

export const RendererOutputSchema = z.strictObject({
  target_version: semver,
  bundle_hash: z.string().nullable().optional(),
  bundle_s3_key: z.string().nullable().optional(),
  cloudfront_path: z.string().nullable().optional(),
});

export const AppManifestSchema = z
  .strictObject({
    apiVersion: z.literal('medapp.eu/v1'),
    kind: z.literal('AppManifest'),
    metadata: MetadataSchema,
    lifecycle: LifecycleSchema,
    auth: AuthSchema,
    data_scopes: z.record(identifier, DataScopeSchema),
    primitives: z.array(PrimitiveDeclSchema),
    layout: LayoutSchema,
    context_inputs: z.array(ContextInputSchema).default([]),
    actions: z.array(ActionSchema).default([]),
    shared_artifacts: SharedArtifactsSchema.optional(),
    /** The FHIR definitions the app is made of — its own Questionnaires — reviewed and signed with it (artifacts.ts). */
    artifacts: ArtifactsSchema.optional(),
    audit: AuditSchema.optional(),
    renderer: RendererOutputSchema.optional(),
  })
  // Cross-field integrity: everything referenced must exist. These are the checks a
  // deterministic renderer runs before it agrees to build anything.
  .superRefine((m, ctx) => {
    const roleIds = new Set(m.auth.roles.map((r) => r.id));
    if (!roleIds.has(m.auth.default_role)) {
      ctx.addIssue({ code: 'custom', path: ['auth', 'default_role'], message: `default_role "${m.auth.default_role}" is not a declared role` });
    }
    for (const [i, role] of m.auth.roles.entries()) {
      if (!(role.data_scope_ref in m.data_scopes)) {
        ctx.addIssue({ code: 'custom', path: ['auth', 'roles', i, 'data_scope_ref'], message: `data scope "${role.data_scope_ref}" is not declared in data_scopes` });
      }
    }
    for (const [id, scope] of Object.entries(m.data_scopes)) {
      if (scope.inherits && !(scope.inherits in m.data_scopes)) {
        ctx.addIssue({ code: 'custom', path: ['data_scopes', id, 'inherits'], message: `inherits unknown scope "${scope.inherits}"` });
      }
      if (scope.inherits === id) {
        ctx.addIssue({ code: 'custom', path: ['data_scopes', id, 'inherits'], message: 'a scope cannot inherit itself' });
      }
    }
    const bindings = new Set<string>();
    for (const [i, p] of m.primitives.entries()) {
      if (bindings.has(p.output_binding)) {
        ctx.addIssue({ code: 'custom', path: ['primitives', i, 'output_binding'], message: `duplicate output_binding "${p.output_binding}"` });
      }
      bindings.add(p.output_binding);
      for (const r of p.only_for_roles ?? []) {
        if (!roleIds.has(r)) {
          ctx.addIssue({ code: 'custom', path: ['primitives', i, 'only_for_roles'], message: `unknown role "${r}"` });
        }
      }
    }
    const primitiveById = new Map(m.primitives.map((p) => [p.id, p]));
    const actionIds = new Set<string>();
    for (const [i, a] of m.actions.entries()) {
      if (actionIds.has(a.id)) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'id'], message: `duplicate action id "${a.id}"` });
      }
      actionIds.add(a.id);
      const p = primitiveById.get(a.primitive);
      if (!p) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'primitive'], message: `unknown primitive "${a.primitive}"` });
      } else if (!p.kind.startsWith('write.')) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'primitive'], message: `actions must run write.* primitives; "${a.primitive}" is ${p.kind}` });
      }
    }
    for (const [i, p] of m.primitives.entries()) {
      if (p.kind.startsWith('write.') && !m.actions.some((a) => a.primitive === p.id)) {
        ctx.addIssue({ code: 'custom', path: ['primitives', i], message: `write primitive "${p.id}" is not used by any action` });
      }
    }
    const walk = (node: LayoutNode, path: (string | number)[]) => {
      for (const r of node.show_only_if_role_in ?? []) {
        if (!roleIds.has(r)) {
          ctx.addIssue({ code: 'custom', path: [...path, 'show_only_if_role_in'], message: `unknown role "${r}"` });
        }
      }
      node.children?.forEach((c, i) => walk(c, [...path, 'children', i]));
    };
    walk(m.layout.root, ['layout', 'root']);
    const urls = new Set<string>();
    for (const [i, q] of (m.artifacts?.questionnaires ?? []).entries()) {
      if (urls.has(q.url)) ctx.addIssue({ code: 'custom', path: ['artifacts', 'questionnaires', i, 'url'], message: `duplicate questionnaire url "${q.url}"` });
      urls.add(q.url);
      // An app-owned form is there to be rendered: some primitive must read it.
      if (!m.primitives.some((p) => p.kind === 'data.fhir.questionnaire.read' && (p.config as { questionnaire?: unknown }).questionnaire === q.url)) {
        ctx.addIssue({ code: 'custom', path: ['artifacts', 'questionnaires', i], message: `questionnaire "${q.url}" is carried by the app but no primitive reads it` });
      }
    }
  });

export type AppManifest = z.infer<typeof AppManifestSchema>;
export type RoleDecl = z.infer<typeof RoleSchema>;
export type DataScope = z.infer<typeof DataScopeSchema>;
export type FhirScopeEntry = z.infer<typeof FhirScopeEntrySchema>;
export type DicomScopeEntry = z.infer<typeof DicomScopeEntrySchema>;
export type PrimitiveDecl = z.infer<typeof PrimitiveDeclSchema>;
export type ActionDecl = z.infer<typeof ActionSchema>;

export function isWriteKind(kind: string): boolean {
  return kind.startsWith('write.');
}
export type ContextInput = z.infer<typeof ContextInputSchema>;

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult = { ok: true; manifest: AppManifest } | { ok: false; issues: ManifestIssue[] };

export function validateManifest(input: unknown): ValidationResult {
  const result = AppManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message })),
  };
}
