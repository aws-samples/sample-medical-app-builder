import { z } from 'zod';
import type { ArchetypeDef, BuildOutput } from '../archetype';
import type { SpecIssue } from '../common';
import { dicomStudies, node, patientContextInput, patientIdentity, patientRead } from '../blocks';

/**
 * APP-05 · Imaging study review — the patient's studies as a selectable list, the selected one in
 * the OHIF viewer (viewer URL is deployment configuration). Access is a DICOM scope (QIDO + WADO for
 * the listed modalities, the patient in context only) next to the Patient read. Reference manifest:
 * manifests/dicom-study-review.yaml.
 */

export const MODALITY = z.string().regex(/^[A-Z]{2,4}$/, 'a DICOM modality code such as CT, MR, DX, US');

export const ImagingKnobsSchema = z.strictObject({
  modalities: z.array(MODALITY).min(1).default(['CT', 'MR', 'DX', 'US']).describe('DICOM modalities to list (CT, MR, DX, US, CR, NM, PT, …); the role may retrieve only these'),
  list_title: z.string().min(1).default('Available studies').describe('Heading of the study list'),
  viewer_height_px: z.number().int().min(240).max(1200).default(560).describe('Height of the viewer'),
  column_ratio: z.tuple([z.number().int().min(1).max(11), z.number().int().min(1).max(11)]).default([5, 7]).describe('List vs viewer width, out of 12'),
  viewer_layout: z.enum(['stack', 'mpr', 'volume']).default('stack').describe('How a study opens: the 2-D stack, the three reconstructed planes (mpr), or those plus a 3-D volume rendering (volume); the user can switch in the viewer'),
});

export type ImagingKnobs = z.infer<typeof ImagingKnobsSchema>;

export const imaging: ArchetypeDef<ImagingKnobs> = {
  id: 'APP-05',
  name: 'Imaging study review',
  knobs: ImagingKnobsSchema,

  check(_ctx, k): SpecIssue[] {
    const issues: SpecIssue[] = [];
    if (k.column_ratio[0] + k.column_ratio[1] !== 12) issues.push({ path: 'knobs.column_ratio', message: 'the two widths must add up to 12' });
    if (new Set(k.modalities).size !== k.modalities.length) issues.push({ path: 'knobs.modalities', message: 'each modality at most once' });
    return issues;
  },

  build(_ctx, k): BuildOutput {
    const list = node('ImagingStudyList', { studies: '$bindings.studies', title: k.list_title, selection_key: 'selected_study' });
    const viewer = node('DicomViewer', { study_uid: '$ui.selected_study', studies: '$bindings.studies', height_px: k.viewer_height_px, ...(k.viewer_layout !== 'stack' ? { layout: k.viewer_layout } : {}) });
    return {
      intent_class: 'viewer',
      patient_scope: 'individual',
      primitives: [patientRead(), dicomStudies({ modalities: k.modalities })],
      children: [patientIdentity('banner', { compact: true }), node('TwoColumn', { ratio: [...k.column_ratio] }, [list, viewer])],
      context_inputs: [patientContextInput()],
      data_categories: ['imaging'],
    };
  },
};
