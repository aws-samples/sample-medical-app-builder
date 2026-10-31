import type { ArchetypeDef, ArchetypeId } from '../archetype';
import { assessment } from './assessment';
import { cohort } from './cohort';
import { composed } from './composed';
import { diseaseDashboard } from './diseaseDashboard';
import { flowsheet } from './flowsheet';
import { imaging } from './imaging';
import { inspector } from './inspector';
import { kpiTiles } from './kpiTiles';
import { patientSummary } from './patientSummary';
import { problemsMedication } from './problemsMedication';
import { snapshot } from './snapshot';
import { trend } from './trend';
import { worklist } from './worklist';

/**
 * Every archetype the compiler knows. Adding one is a platform release: a module here, a variant in
 * AppSpecSchema, an entry in docs/application-catalog.yaml, fixtures and a golden test.
 */
export const ARCHETYPES = Object.freeze({
  'APP-01': patientSummary,
  'APP-02': trend,
  'APP-03': flowsheet,
  'APP-04': problemsMedication,
  'APP-05': imaging,
  'APP-06': diseaseDashboard,
  'APP-07': snapshot,
  'APP-08': inspector,
  'APP-09': cohort,
  'APP-10': kpiTiles,
  'APP-11': assessment,
  'APP-12': composed,
  'APP-13': worklist,
}) satisfies Readonly<Record<ArchetypeId, ArchetypeDef<unknown>>>;

export { assessment, cohort, composed, diseaseDashboard, flowsheet, imaging, inspector, kpiTiles, patientSummary, problemsMedication, snapshot, trend, worklist };
