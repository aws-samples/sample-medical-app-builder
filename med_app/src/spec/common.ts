import { z } from 'zod';
import { PHI_FIELDS } from '../manifest/schema';
import { SYSTEM_ALIASES } from './terminology';

/**
 * The parts of an AppSpec every archetype shares. An AppSpec is what a drafting conversation
 * produces: small, typed, and edited only through tools — the agent never writes a manifest.
 * The compiler turns a complete spec into an AppManifest deterministically.
 */

export const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase identifier (a-z, 0-9, _)');
export const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'exact semver, e.g. 0.1.0');

export const WindowSchema = z
  .string()
  .regex(/^(now(-\d+[dmy])?|\d{4}-\d{2}-\d{2})$/, 'a window like now-2y or now-90d, or an ISO date')
  .describe('How far back to look: now-<n>[d|m|y], or an ISO date');

const SYSTEM_ALIAS_NAMES = Object.keys(SYSTEM_ALIASES) as [string, ...string[]];

export const CodeSchema = z.strictObject({
  // A union rather than a refine so the constraint survives into the JSON Schema the agent validates against.
  system: z
    .union([z.enum(SYSTEM_ALIAS_NAMES), z.string().regex(/^(https?:\/\/|urn:)\S+$/, 'a system URL')])
    .describe(`Code system: one of ${SYSTEM_ALIAS_NAMES.join(', ')}, or a system URL`),
  code: z.string().min(1),
  display: z.string().optional(),
});

export const GroupBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('app_group') }).describe('A group created for this app at publish time: app-<app_id>-<role>'),
  z.strictObject({ kind: z.literal('existing'), name: z.string().min(1) }).describe('An existing hospital group (Cognito or federated IdP) that grants this role'),
]);

export const RoleSpecSchema = z.strictObject({
  id: identifier.describe('Role id used inside the app, e.g. viewer, reviewer, nurse'),
  display_name: z.string().min(1),
  group: GroupBindingSchema.default({ kind: 'app_group' }),
  inherits: identifier.optional().describe('Another role of this app whose data access this role extends'),
  phi_fields_visible: z.array(z.enum(PHI_FIELDS)).describe('Patient identity fields this role may see; everything else is masked'),
  capabilities: z.array(z.string().min(1)).default(['view']).describe('Declarative labels (view, export_pdf, …); the most capable role wins when a person holds several'),
});

export const GovernanceSchema = z.strictObject({
  clinical_context: identifier.describe('Where the app is used, as a slug: outpatient_bp_monitoring'),
  intended_users: z.array(identifier).min(1).describe('Who uses it, as slugs: general_practitioner, cardiologist'),
  intended_purpose: z.string().min(1).describe('What the app is for and what it is not for — the sentence an approver signs'),
  mdr_classification: z.enum(['none', 'I', 'IIa', 'IIb', 'III']).default('none'),
  data_categories: z.array(z.string().min(1)).optional().describe('Derived from the archetype unless given'),
});

export const AppInfoSchema = z.strictObject({
  app_id: z.string().regex(/^app_[a-z0-9_]+$/, 'app_<slug>'),
  version: semver.default('0.1.0'),
  parent_version: semver.optional().describe('The version this one iterates on'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  language: z.enum(['en', 'de']).default('en').describe('Language of the generated display texts'),
});

export const CommonSpecSchema = z.strictObject({
  apiVersion: z.literal('medapp.eu/v1'),
  kind: z.literal('AppSpec'),
  app: AppInfoSchema,
  roles: z.array(RoleSpecSchema).min(1),
  default_role: identifier.describe('The role blanket-access users get; by convention the least privileged'),
  governance: GovernanceSchema,
});

export type Code = z.infer<typeof CodeSchema>;
export type RoleSpec = z.infer<typeof RoleSpecSchema>;
export type Governance = z.infer<typeof GovernanceSchema>;
export type AppInfo = z.infer<typeof AppInfoSchema>;
export type CommonSpec = z.infer<typeof CommonSpecSchema>;

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}
