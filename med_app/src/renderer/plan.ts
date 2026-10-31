import type { AppManifest } from '../manifest/schema';
import { isWriteKind } from '../manifest/schema';

/**
 * How the data plan is scheduled, and what a write touches.
 *
 * Two facts drive both: a primitive may read another's output through `$bindings.<name>` (so it must run after it), and
 * every primitive is about a few FHIR resource types (so a write of one type stales exactly the reads of that type, and
 * whatever reads *their* outputs). From the first the plan is run in waves — independent primitives together, dependents
 * after — instead of one after the other, which is what made a thirteen-primitive page take thirteen round trips. From the
 * second a successful write refreshes only the bindings it can have changed, and the page shows the saved entry beside
 * the "Saved" notice rather than seconds later.
 */

type Primitive = AppManifest['primitives'][number];

const BINDING_REF = /\$bindings\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** The bindings a primitive's config reads (`$bindings.x…`). */
export function bindingRefs(decl: Pick<Primitive, 'config'>): Set<string> {
  const out = new Set<string>();
  for (const m of JSON.stringify(decl.config ?? {}).matchAll(BINDING_REF)) out.add(m[1]!);
  return out;
}

/**
 * The plan in waves: each wave holds primitives whose referenced bindings are all produced by earlier waves, so a wave
 * runs in parallel and waves run in order. A reference to a binding nothing produces (or a cycle) does not block: the
 * primitive runs in the first wave it can, and the expression resolver reports the missing binding as it always did.
 */
export function waves(plan: readonly Primitive[]): Primitive[][] {
  const produced = new Set(plan.map((p) => p.output_binding));
  const remaining = [...plan];
  const done = new Set<string>();
  const out: Primitive[][] = [];
  while (remaining.length) {
    const wave = remaining.filter((p) => [...bindingRefs(p)].every((b) => !produced.has(b) || done.has(b)));
    const ready = wave.length ? wave : [remaining[0]!]; // a cycle: break it in declaration order rather than hang
    out.push(ready);
    for (const p of ready) {
      done.add(p.output_binding);
      remaining.splice(remaining.indexOf(p), 1);
    }
  }
  return out;
}

/** The FHIR resource types a data primitive reads — what a write of that type stales. */
export function resourcesRead(decl: Pick<Primitive, 'kind' | 'config'>): Set<string> {
  switch (decl.kind) {
    case 'data.fhir.patient.read':
      return new Set(['Patient']);
    case 'data.fhir.query': {
      const resource = (decl.config as { resource?: unknown }).resource;
      return new Set(typeof resource === 'string' ? [resource] : []);
    }
    case 'data.fhir.observation.by_code':
    case 'data.cohort.latest_observation':
      return new Set(['Observation']);
    case 'data.fhir.questionnaire.read':
      return new Set(['Questionnaire']);
    case 'data.fhir.questionnaire_response.answers':
    case 'data.cohort.assessment_due':
      return new Set(['QuestionnaireResponse']);
    case 'data.dicom.studies.for_patient':
    case 'data.cohort.with_imaging':
      return new Set(['ImagingStudy']);
    case 'data.cohort.by_condition':
      return new Set(['Condition']);
    case 'data.task.worklist':
      return new Set(['Task']);
    default:
      return new Set();
  }
}

/** The FHIR resource type a write primitive creates or updates; undefined for a kind this table does not know. */
export function resourceWritten(decl: Pick<Primitive, 'kind'> & { config?: unknown }): string | undefined {
  switch (decl.kind) {
    case 'write.fhir.record.create': {
      const resource = (decl.config as { resource?: unknown } | undefined)?.resource;
      return typeof resource === 'string' ? resource : undefined;
    }
    case 'write.fhir.questionnaire_response.submit':
      return 'QuestionnaireResponse';
    case 'write.fhir.observation.create':
      return 'Observation';
    case 'write.fhir.condition.create':
    case 'write.fhir.condition.update_status':
      return 'Condition';
    case 'write.fhir.allergy_intolerance.create':
      return 'AllergyIntolerance';
    case 'write.fhir.procedure.create':
      return 'Procedure';
    case 'write.fhir.task.create':
    case 'write.fhir.task.update_status':
      return 'Task';
    case 'write.fhir.media.create':
      return 'Media';
    case 'write.fhir.medication_request.update_status':
      return 'MedicationRequest';
    default:
      return undefined;
  }
}

/**
 * The output bindings a successful write can have changed: every data primitive reading the written resource type, and —
 * transitively — every primitive reading one of those bindings. `undefined` when the write kind is unknown here, which
 * callers take as "refresh everything" (the safe answer for a primitive this table has not learned yet).
 */
export function affectedBindings(primitives: readonly Primitive[], write: Pick<Primitive, 'kind'> & { config?: unknown }): Set<string> | undefined {
  const written = resourceWritten(write);
  if (!written) return undefined;
  // A form whose answers are also extracted writes Observations beside the response.
  const writes = new Set([written]);
  const extract = (write.config as { extract?: unknown } | undefined)?.extract;
  if (write.kind === 'write.fhir.questionnaire_response.submit' && Array.isArray(extract) && extract.length) writes.add('Observation');
  const plan = primitives.filter((p) => !isWriteKind(p.kind));
  const affected = new Set(plan.filter((p) => [...resourcesRead(p)].some((r) => writes.has(r))).map((p) => p.output_binding));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of plan) {
      if (affected.has(p.output_binding)) continue;
      if ([...bindingRefs(p)].some((b) => affected.has(b))) {
        affected.add(p.output_binding);
        grew = true;
      }
    }
  }
  return affected;
}
