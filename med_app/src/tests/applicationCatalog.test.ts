import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import catalogYaml from '../../docs/application-catalog.yaml?raw';
import catalogMarkdown from '../../docs/application-catalog.md?raw';
import baseDefinitions from '../fhir/base-definitions.json';
import { DESIGN_SYSTEM_VERSION, UI_CATALOG } from '../primitives/catalog';
import { DATA_CATALOG, PRIMITIVE_CONFIG_SCHEMAS, isDataPrimitiveKind } from '../primitives/data/dataCatalog';
import { INTENT_CLASSES, PHI_FIELDS, type LayoutNode } from '../manifest/schema';
import { loadRegistry } from '../manifest/registry';
import { loadFixtureRegistry } from './fixtures';

/**
 * docs/application-catalog.yaml is what the planning pipeline treats as "possible".
 * These tests make sure it can never name a component, prop, primitive, config key,
 * manifest or route that the renderer does not actually have.
 */

const BindsTo = z.union([
  z.strictObject({ component: z.string(), prop: z.string().optional() }),
  z.strictObject({ primitive: z.string(), config: z.string().optional() }),
  z.strictObject({ context: z.string() }),
]);

const Archetype = z.object({
  id: z.string().regex(/^APP-\d{2}$/),
  name: z.string(),
  intent_class: z.enum(INTENT_CLASSES),
  patient_scope: z.enum(['individual', 'cohort', 'population']),
  summary: z.string(),
  example_requests: z.object({ en: z.array(z.string()).min(1), de: z.array(z.string()).min(1) }),
  triage_signals: z.array(z.string()).min(1),
  requires_context: z.array(z.string()),
  optional_context: z.array(z.string()),
  data_plan: z.array(z.object({ kind: z.string(), resource: z.string().optional(), purpose: z.string() }).passthrough()).min(1),
  components: z.object({ layout: z.array(z.string()), display: z.array(z.string()).min(1) }),
  interaction: z.array(z.object({ writer: z.string(), prop: z.string(), reader: z.string(), reads: z.string() }).passthrough()).optional(),
  templates: z
    .array(
      z.object({
        id: z.string(),
        series: z.array(z.object({ label: z.string(), code: z.string().optional(), component_code: z.string().optional() })),
        observation_codes: z.array(z.string()),
        thresholds: z.array(z.object({ value: z.number(), label: z.string() })),
        source: z.string().min(1),
        medication_codes: z.array(z.string()),
        condition_codes: z.array(z.string()),
      })
    )
    .optional(),
  indexed_resource_types: z.array(z.string()).optional(),
  knobs: z.array(z.object({ id: z.string(), description: z.string(), binds_to: BindsTo })),
  role_pattern: z.string(),
  reference_manifest: z.string().nullable(),
  limits: z.array(z.string()),
});

const Catalog = z.object({
  apiVersion: z.literal('medapp.eu/v1'),
  kind: z.literal('ApplicationCatalog'),
  metadata: z.object({ version: z.string(), design_system_version: z.string(), data_catalog_version: z.string() }).passthrough(),
  intent_classes: z.object({ supported: z.array(z.string()), unrealised: z.array(z.string()) }),
  context_inputs: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
  terminology: z.object({
    common_codes: z.object({
      observations: z.record(z.string(), z.object({ code: z.string() }).passthrough()),
      conditions: z.record(z.string(), z.object({ code: z.string() })),
      medications: z.record(z.string(), z.object({ code: z.string() })),
      medication_classes: z.record(z.string(), z.object({ code: z.string() })).optional(),
      modalities: z.array(z.string()),
    }).passthrough(),
  }).passthrough(),
  role_patterns: z.record(z.string(), z.object({ phi_default: z.array(z.string()).optional(), roles: z.array(z.object({ id: z.string(), phi: z.array(z.string()) })).optional() }).passthrough()),
  archetypes: z.array(Archetype).min(1),
  patterns: z.array(z.object({ id: z.string(), description: z.string(), mechanics: z.array(z.string()) })),
  parameters: z.array(z.object({ id: z.string(), range: z.string() })),
  refusals: z.array(z.object({ id: z.string(), description: z.string(), triggers: z.array(z.string()).min(1), reason: z.string(), unlock: z.string() })),
  triage: z.object({
    order: z.string(),
    rules: z.array(
      z.object({
        when: z.object({ scope: z.string().optional(), signals: z.array(z.string()).optional(), refusal_trigger: z.array(z.string()).optional(), intent_class: z.array(z.string()).optional() }),
        route: z.string(),
        refusal: z.string().optional(),
        alternative: z.object({ if: z.string(), route: z.string() }).optional(),
      })
    ),
  }),
});

const parsed = Catalog.safeParse(parseYaml(catalogYaml));
if (!parsed.success) {
  throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
}
const catalog = parsed.data;
const archetypeIds = new Set(catalog.archetypes.map((a) => a.id));
const refusalIds = new Set(catalog.refusals.map((r) => r.id));
const queryResources = PRIMITIVE_CONFIG_SCHEMAS['data.fhir.query'].shape.resource.options as readonly string[];
// Reference manifests may be showcase apps (manifests/…) or hand-authored fixtures (fixtures/manifests/…).
const registry = [...loadRegistry().map((e) => ({ ...e, path: `manifests/${e.file}` })), ...loadFixtureRegistry().map((e) => ({ ...e, path: `fixtures/manifests/${e.file}` }))];

function walk(node: LayoutNode, acc: Set<string>): Set<string> {
  acc.add(node.component);
  node.children?.forEach((c) => walk(c, acc));
  return acc;
}

describe('application catalog ↔ renderer catalogs', () => {
  it('pins the same versions the renderer ships', () => {
    expect(catalog.metadata.design_system_version).toBe(DESIGN_SYSTEM_VERSION);
    for (const entry of Object.values(DATA_CATALOG)) expect(entry.version).toBe(catalog.metadata.data_catalog_version);
  });

  it('partitions intent classes into supported and unrealised exactly', () => {
    expect([...catalog.intent_classes.supported, ...catalog.intent_classes.unrealised].sort()).toEqual([...INTENT_CLASSES].sort());
    for (const a of catalog.archetypes) expect(catalog.intent_classes.supported).toContain(a.intent_class);
  });

  it('uses only PHI fields the schema knows', () => {
    for (const rp of Object.values(catalog.role_patterns)) {
      for (const f of rp.phi_default ?? []) expect(PHI_FIELDS).toContain(f);
      for (const r of rp.roles ?? []) for (const f of r.phi) expect(PHI_FIELDS).toContain(f);
    }
  });

  it.each(catalog.archetypes.map((a) => [a.id, a] as const))('%s references only real components, props, primitives and context', (_id, a) => {
    for (const name of a.components.layout) {
      expect(UI_CATALOG[name], `layout component ${name}`).toBeDefined();
      expect(UI_CATALOG[name]?.kind).toBe('layout');
    }
    for (const name of a.components.display) {
      expect(UI_CATALOG[name], `display component ${name}`).toBeDefined();
      expect(UI_CATALOG[name]?.kind).toBe('display');
    }
    for (const step of a.data_plan) {
      expect(isDataPrimitiveKind(step.kind), `primitive ${step.kind}`).toBe(true);
      if (step.resource) expect(queryResources).toContain(step.resource);
    }
    for (const c of [...a.requires_context, ...a.optional_context]) expect(catalog.context_inputs[c], `context ${c}`).toBeDefined();
    expect(catalog.role_patterns[a.role_pattern], `role pattern ${a.role_pattern}`).toBeDefined();
    for (const knob of a.knobs) {
      const b = knob.binds_to;
      if ('component' in b) {
        expect(UI_CATALOG[b.component], `knob ${knob.id} component`).toBeDefined();
        if (b.prop) expect(UI_CATALOG[b.component]?.props, `knob ${knob.id} prop`).toContain(b.prop);
      } else if ('primitive' in b) {
        expect(isDataPrimitiveKind(b.primitive), `knob ${knob.id} primitive`).toBe(true);
        if (b.config && isDataPrimitiveKind(b.primitive)) {
          expect(Object.keys(PRIMITIVE_CONFIG_SCHEMAS[b.primitive].shape), `knob ${knob.id} config key`).toContain(b.config);
        }
      } else {
        expect(catalog.context_inputs[b.context], `knob ${knob.id} context`).toBeDefined();
      }
    }
    for (const i of a.interaction ?? []) {
      expect(UI_CATALOG[i.writer]?.props).toContain(i.prop);
      expect(UI_CATALOG[i.reader]?.props).toContain(i.reads);
    }
    if (a.patient_scope !== 'individual') {
      expect(a.requires_context).not.toContain('patient_id');
    }
  });

  it('describes its reference manifests truthfully', () => {
    for (const a of catalog.archetypes) {
      if (!a.reference_manifest) continue;
      const entry = registry.find((e) => e.path === a.reference_manifest);
      expect(entry?.ok, `${a.id} manifest ${a.reference_manifest}`).toBe(true);
      if (!entry?.ok) continue;
      const m = entry.manifest;
      expect(m.metadata.intent_class).toBe(a.intent_class);
      const declaredKinds = new Set(a.data_plan.map((s) => s.kind));
      for (const p of m.primitives) expect(declaredKinds, `${a.id} primitive ${p.kind}`).toContain(p.kind);
      const declaredComponents = new Set([...a.components.layout, ...a.components.display]);
      for (const c of walk(m.layout.root, new Set())) expect(declaredComponents, `${a.id} component ${c}`).toContain(c);
      for (const c of m.context_inputs) expect([...a.requires_context, ...a.optional_context]).toContain(c.name);
    }
  });

  it('only indexes resource types that are really in base-definitions.json', () => {
    const indexed = new Set(
      (baseDefinitions as { entry: { resource: { kind: string; name: string } }[] }).entry
        .map((e) => e.resource)
        .filter((r) => r.kind === 'resource')
        .map((r) => r.name)
    );
    for (const a of catalog.archetypes) for (const t of a.indexed_resource_types ?? []) expect(indexed).toContain(t);
  });

  it('keeps disease templates consistent with the terminology section', () => {
    const conditionCodes = new Set(Object.values(catalog.terminology.common_codes.conditions).map((c) => c.code));
    const medicationCodes = new Set([...Object.values(catalog.terminology.common_codes.medications), ...Object.values(catalog.terminology.common_codes.medication_classes ?? {})].map((c) => c.code));
    const observationCodes = new Set(
      Object.values(catalog.terminology.common_codes.observations).flatMap((o) => [o.code, ...Object.values((o as { components?: Record<string, string> }).components ?? {})])
    );
    for (const a of catalog.archetypes) {
      for (const t of a.templates ?? []) {
        for (const c of t.condition_codes) expect(conditionCodes).toContain(c);
        for (const c of t.medication_codes) expect(medicationCodes).toContain(c);
        for (const c of t.observation_codes) expect(observationCodes).toContain(c);
        for (const s of t.series) {
          expect(Boolean(s.code) !== Boolean(s.component_code), `series ${s.label} needs exactly one of code/component_code`).toBe(true);
          expect(observationCodes).toContain(s.code ?? s.component_code);
        }
      }
    }
  });

  it('routes every triage rule to a real archetype or refusal, and reaches every archetype', () => {
    const reached = new Set<string>();
    for (const rule of catalog.triage.rules) {
      if (rule.route === 'refuse') {
        if (rule.refusal) expect(refusalIds).toContain(rule.refusal);
        for (const r of rule.when.refusal_trigger ?? []) expect(refusalIds).toContain(r);
      } else {
        expect(archetypeIds).toContain(rule.route);
        reached.add(rule.route);
      }
      if (rule.alternative) {
        expect(archetypeIds).toContain(rule.alternative.route);
        reached.add(rule.alternative.route);
      }
      for (const ic of rule.when.intent_class ?? []) expect(catalog.intent_classes.unrealised).toContain(ic);
    }
    expect([...reached].sort()).toEqual([...archetypeIds].sort());
    expect(new Set(catalog.refusals.map((r) => r.id)).size).toBe(catalog.refusals.length);
  });

  it('matches the archetype headings of the Markdown companion', () => {
    const headings = [...catalogMarkdown.matchAll(/^### (APP-\d{2}) · (.+)$/gm)].map((m) => ({ id: m[1], name: m[2]?.trim() }));
    expect(headings.map((h) => h.id)).toEqual(catalog.archetypes.map((a) => a.id));
    for (const h of headings) {
      const a = catalog.archetypes.find((x) => x.id === h.id);
      expect(h.name?.toLowerCase().startsWith(a?.name.toLowerCase() ?? ' '), `${h.id} name "${h.name}" vs "${a?.name}"`).toBe(true);
    }
  });
});
