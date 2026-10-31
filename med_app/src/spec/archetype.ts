import type { z } from 'zod';
import type { QuestionnaireArtifact } from '../manifest/artifacts';
import type { ShapeLookup } from './shapes';
import type { ActionDecl, ContextInput, DicomScopeEntry, FhirScopeEntry, IntentClass, LayoutNode, PrimitiveDecl } from '../manifest/schema';
import type { AppInfo, RoleSpec, SpecIssue } from './common';

/**
 * An archetype is one verified kind of app (APP-xx in docs/application-catalog.yaml). Its
 * function turns knob values into the app's data plan and layout; everything role- and
 * governance-related is added by the compiler, identically for every archetype.
 */

export type ArchetypeId = 'APP-01' | 'APP-02' | 'APP-03' | 'APP-04' | 'APP-05' | 'APP-06' | 'APP-07' | 'APP-08' | 'APP-09' | 'APP-10' | 'APP-11' | 'APP-12' | 'APP-13';

/** A primitive together with the data access it needs — the compiler derives role scopes from these. */
export interface BlockPrimitive {
  readonly decl: PrimitiveDecl;
  readonly fhir: readonly FhirScopeEntry[];
  readonly dicom?: readonly DicomScopeEntry[];
}

export interface BuildContext {
  readonly app: AppInfo;
  readonly roles: readonly RoleSpec[];
  readonly default_role: string;
  /** Canonical namespace of the forms this deployment's apps author (`<base>/<app_id>-<form_id>`). */
  readonly questionnaire_base: string;
  /** ISO timestamp of the compile, for the artifacts' `date`; absent in a readiness check. */
  readonly created_at?: string;
  /** The published record shapes a `record` section may refer to by id (`shape: measurable_goal`); absent = none known. */
  readonly shapes?: ShapeLookup;
  /** The deployment the compile is for — names the code system of the record-shape tag; absent in a bare readiness check. */
  readonly hospital_id?: string;
}

export interface BuildOutput {
  readonly intent_class: IntentClass;
  readonly patient_scope: 'individual' | 'cohort' | 'population';
  readonly primitives: readonly BlockPrimitive[];
  /** Children of the PageShell root, in order. */
  readonly children: readonly LayoutNode[];
  readonly context_inputs: readonly ContextInput[];
  readonly actions?: readonly ActionDecl[];
  /** Added to `phi`, which every app carries. */
  readonly data_categories: readonly string[];
  /** The FHIR definitions the app carries — the Questionnaires of forms designed in the conversation. */
  readonly questionnaires?: readonly QuestionnaireArtifact[];
}

export interface ArchetypeDef<K> {
  readonly id: ArchetypeId;
  readonly name: string;
  readonly knobs: z.ZodType<K>;
  /** Cross-checks between knobs and the rest of the spec (roles referenced by a gated section exist, …). */
  check(ctx: BuildContext, knobs: K): SpecIssue[];
  build(ctx: BuildContext, knobs: K): BuildOutput;
}
