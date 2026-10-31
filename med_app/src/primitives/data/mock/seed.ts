import type {
  AllergyIntolerance,
  Condition,
  Consent,
  DiagnosticReport,
  DocumentReference,
  Encounter,
  ImagingStudy,
  Immunization,
  MedicationRequest,
  Observation,
  Organization,
  Patient,
  Practitioner,
  Procedure,
  Questionnaire,
  QuestionnaireResponse,
  Media,
  Resource,
  Task,
  Goal,
  CarePlan,
} from '@medplum/fhirtypes';

/**
 * Synthetic patients for the Klinikum Musterstadt deployment. No real persons.
 * Everything is deterministic (seeded PRNG, fixed anchor date) so renders and tests are stable.
 */

export const SEED_ANCHOR = new Date('2026-09-10T08:00:00Z');
export const MRN_SYSTEM = 'https://klinikum-musterstadt.example/fhir/sid/mrn';
export const LOINC = 'http://loinc.org';
export const SNOMED = 'http://snomed.info/sct';
export const ICD10GM = 'http://fhir.de/CodeSystem/bfarm/icd-10-gm';

/**
 * The German hospital coding for the seeded diagnoses, as a second coding on each Condition: the hospital's record
 * codes conditions in ICD-10-GM, so an app written for that record (an I10.90 cohort) finds the same synthetic
 * patients in the preview as it will on the hospital's data.
 */
export const ICD10GM_CODES: Readonly<Record<string, { code: string; display: string }>> = {
  '38341003': { code: 'I10.90', display: 'Essentielle Hypertonie, nicht näher bezeichnet' },
  '44054006': { code: 'E11.90', display: 'Typ-2-Diabetes mellitus: Ohne Komplikationen' },
  '433144002': { code: 'N18.3', display: 'Chronische Nierenkrankheit, Stadium 3' },
  '37796009': { code: 'G43.9', display: 'Migräne, nicht näher bezeichnet' },
  '239873007': { code: 'M17.9', display: 'Gonarthrose, nicht näher bezeichnet' },
};
export const ATC = 'http://www.whocc.no/atc';
export const UCUM = 'http://unitsofmeasure.org';
export const DCM = 'http://dicom.nema.org/resources/ontology/DCM';

export const CODES = {
  bpPanel: '85354-9',
  systolic: '8480-6',
  diastolic: '8462-4',
  heartRate: '8867-4',
  bodyWeight: '29463-7',
  smokingStatus: '72166-2',
  hba1c: '4548-4',
  egfr: '33914-3',
  hypertension: '38341003',
  type2Diabetes: '44054006',
  ckdStage3: '433144002',
  migraine: '37796009',
  kneeOsteoarthritis: '239873007',
} as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function monthsAgo(months: number, dayOffset = 0): string {
  const d = new Date(SEED_ANCHOR);
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString();
}

export const practitioner: Practitioner = {
  resourceType: 'Practitioner',
  id: 'prac-kms-0001',
  name: [{ use: 'official', prefix: ['Dr. med.'], given: ['Lukas'], family: 'Hoffmann' }],
  qualification: [{ code: { text: 'Facharzt für Innere Medizin und Kardiologie' } }],
};

export const organization: Organization = {
  resourceType: 'Organization',
  id: 'org-musterstadt',
  name: 'Klinikum Musterstadt',
  address: [{ line: ['Musterallee 1'], city: 'Musterstadt', postalCode: '12345', country: 'DE' }],
};

const performerRef = { reference: `Practitioner/${practitioner.id}`, display: 'Dr. med. Lukas Hoffmann' };
const performer = [performerRef];

interface PatientProfile {
  readonly patient: Patient;
  readonly bp: { readonly start: [number, number]; readonly end: [number, number]; readonly noise: number; readonly changeAtMonth?: number };
  readonly heartRate: number;
  readonly weightKg: number;
  readonly smoking: { code: string; display: string };
  readonly conditions: Condition[];
  readonly medications: MedicationRequest[];
  readonly imaging: ImagingStudy[];
  readonly extraObservations: (rand: () => number) => Observation[];
}

const subject = (p: Patient) => ({ reference: `Patient/${p.id}`, display: `${p.name?.[0]?.given?.[0]} ${p.name?.[0]?.family}` });

const vitalCategory = [
  { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] },
];
const labCategory = [
  { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory', display: 'Laboratory' }] },
];
const socialCategory = [
  { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'social-history', display: 'Social History' }] },
];

const mmHg = (value: number) => ({ value, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' });

function bloodPressure(p: Patient, index: number, when: string, sys: number, dia: number): Observation {
  return {
    resourceType: 'Observation',
    id: `obs-bp-${p.id}-${String(index).padStart(3, '0')}`,
    status: 'final',
    category: vitalCategory,
    code: { coding: [{ system: LOINC, code: CODES.bpPanel, display: 'Blood pressure panel with all children optional' }], text: 'Blood pressure' },
    subject: subject(p),
    effectiveDateTime: when,
    performer,
    component: [
      { code: { coding: [{ system: LOINC, code: CODES.systolic, display: 'Systolic blood pressure' }] }, valueQuantity: mmHg(sys) },
      { code: { coding: [{ system: LOINC, code: CODES.diastolic, display: 'Diastolic blood pressure' }] }, valueQuantity: mmHg(dia) },
    ],
  };
}

function quantityObs(p: Patient, id: string, when: string, code: string, display: string, value: number, unit: string, ucum: string, category = vitalCategory): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category,
    code: { coding: [{ system: LOINC, code, display }], text: display },
    subject: subject(p),
    effectiveDateTime: when,
    performer,
    valueQuantity: { value, unit, system: UCUM, code: ucum },
  };
}

function condition(p: Patient, id: string, code: string, display: string, onset: string, status: 'active' | 'resolved' = 'active'): Condition {
  return {
    resourceType: 'Condition',
    id,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] },
    verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }],
    code: { coding: [{ system: SNOMED, code, display }, ...(ICD10GM_CODES[code] ? [{ system: ICD10GM, ...ICD10GM_CODES[code] }] : [])], text: display },
    subject: subject(p),
    onsetDateTime: onset,
    recordedDate: onset,
    recorder: performer[0],
  };
}

function medication(p: Patient, id: string, atc: string, display: string, dosage: string, authoredOn: string, status: MedicationRequest['status'] = 'active'): MedicationRequest {
  return {
    resourceType: 'MedicationRequest',
    id,
    status,
    intent: 'order',
    medicationCodeableConcept: { coding: [{ system: ATC, code: atc, display }], text: display },
    subject: subject(p),
    authoredOn,
    requester: performer[0],
    dosageInstruction: [{ text: dosage }],
  };
}

function study(p: Patient, id: string, uidSuffix: string, modality: string, description: string, started: string, series: { description: string; instances: number; bodySite?: string }[]): ImagingStudy {
  const studyUid = `1.2.276.0.7230010.3.1.2.8323329.${uidSuffix}`;
  return {
    resourceType: 'ImagingStudy',
    id,
    identifier: [{ system: 'urn:dicom:uid', value: `urn:oid:${studyUid}` }],
    status: 'available',
    modality: [{ system: DCM, code: modality }],
    subject: subject(p),
    started,
    numberOfSeries: series.length,
    numberOfInstances: series.reduce((n, s) => n + s.instances, 0),
    description,
    referrer: performer[0],
    series: series.map((s, i) => ({
      uid: `${studyUid}.${i + 1}`,
      number: i + 1,
      modality: { system: DCM, code: modality },
      description: s.description,
      numberOfInstances: s.instances,
      bodySite: s.bodySite ? { system: SNOMED, display: s.bodySite } : undefined,
    })),
  };
}

const anneliese: Patient = {
  resourceType: 'Patient',
  id: 'pat-kms-0001',
  identifier: [{ system: MRN_SYSTEM, value: 'KMS-0048213', type: { text: 'MRN' } }],
  active: true,
  name: [{ use: 'official', family: 'Krüger', given: ['Anneliese'] }],
  gender: 'female',
  birthDate: '1958-03-14',
  telecom: [
    { system: 'phone', value: '+49 123 555 0143', use: 'home' },
    { system: 'email', value: 'a.krueger@example.invalid' },
  ],
  address: [{ use: 'home', line: ['Lindenweg 12'], city: 'Musterstadt', postalCode: '12345', country: 'DE' }],
  managingOrganization: { reference: `Organization/${organization.id}`, display: organization.name },
  generalPractitioner: performer,
};

const jonas: Patient = {
  resourceType: 'Patient',
  id: 'pat-kms-0002',
  identifier: [{ system: MRN_SYSTEM, value: 'KMS-0102377', type: { text: 'MRN' } }],
  active: true,
  name: [{ use: 'official', family: 'Bergmann', given: ['Jonas'] }],
  gender: 'male',
  birthDate: '1979-11-02',
  telecom: [{ system: 'phone', value: '+49 123 555 0882', use: 'mobile' }],
  address: [{ use: 'home', line: ['Bahnhofstraße 45'], city: 'Musterstadt', postalCode: '12345', country: 'DE' }],
  managingOrganization: { reference: `Organization/${organization.id}`, display: organization.name },
};

const fatma: Patient = {
  resourceType: 'Patient',
  id: 'pat-kms-0003',
  identifier: [{ system: MRN_SYSTEM, value: 'KMS-0077501', type: { text: 'MRN' } }],
  active: true,
  name: [{ use: 'official', family: 'Yıldız', given: ['Fatma'] }],
  gender: 'female',
  birthDate: '1966-07-23',
  telecom: [{ system: 'phone', value: '+49 123 555 0417', use: 'home' }],
  address: [{ use: 'home', line: ['Gartenstraße 210'], city: 'Musterstadt', postalCode: '12345', country: 'DE' }],
  managingOrganization: { reference: `Organization/${organization.id}`, display: organization.name },
  generalPractitioner: performer,
};

const profiles: PatientProfile[] = [
  {
    patient: anneliese,
    bp: { start: [152, 94], end: [136, 84], noise: 6, changeAtMonth: 8 },
    heartRate: 74,
    weightKg: 78.5,
    smoking: { code: '8517006', display: 'Former smoker' },
    conditions: [
      condition(anneliese, 'cond-kms-0001', CODES.hypertension, 'Hypertensive disorder', '2019-05-02'),
      condition(anneliese, 'cond-kms-0002', CODES.type2Diabetes, 'Type 2 diabetes mellitus', '2021-11-18'),
      condition(anneliese, 'cond-kms-0003', CODES.kneeOsteoarthritis, 'Osteoarthritis of knee', '2023-08-30'),
    ],
    medications: [
      medication(anneliese, 'medrx-kms-0001', 'C09AA05', 'Ramipril 5 mg', '1 Tablette morgens', '2019-05-20'),
      medication(anneliese, 'medrx-kms-0002', 'A10BA02', 'Metformin 1000 mg', '1 Tablette morgens und abends', '2021-12-01'),
      medication(anneliese, 'medrx-kms-0003', 'C08CA01', 'Amlodipin 5 mg', '1 Tablette morgens', monthsAgo(8, 3)),
    ],
    imaging: [
      study(anneliese, 'img-kms-0001', '1001', 'CT', 'CT Thorax mit Kontrastmittel', '2025-11-03T09:12:00+01:00', [
        { description: 'Topogram', instances: 2 },
        { description: 'Thorax axial 1 mm', instances: 350, bodySite: 'Thorax' },
        { description: 'Coronale MPR', instances: 60, bodySite: 'Thorax' },
      ]),
      study(anneliese, 'img-kms-0002', '1002', 'DX', 'Röntgen Knie rechts in 2 Ebenen', '2024-06-12T14:40:00+02:00', [
        { description: 'Knie a.p.', instances: 1, bodySite: 'Knee' },
        { description: 'Knie seitlich', instances: 1, bodySite: 'Knee' },
      ]),
    ],
    extraObservations: (rand) =>
      [7.4, 7.1, 6.9, 6.8].map((v, i) =>
        quantityObs(anneliese, `obs-hba1c-${anneliese.id}-${i}`, monthsAgo(18 - i * 6, -Math.floor(rand() * 5)), CODES.hba1c, 'Hemoglobin A1c/Hemoglobin.total in Blood', v, '%', '%', labCategory)
      ),
  },
  {
    patient: jonas,
    bp: { start: [121, 78], end: [119, 77], noise: 4 },
    heartRate: 62,
    weightKg: 84,
    smoking: { code: '266919005', display: 'Never smoked tobacco' },
    conditions: [condition(jonas, 'cond-kms-0004', CODES.migraine, 'Migraine', '2022-03-11')],
    medications: [medication(jonas, 'medrx-kms-0004', 'N02CC01', 'Sumatriptan 50 mg', 'Bei Bedarf, max. 2 Tabletten/Tag', '2022-03-11')],
    imaging: [
      study(jonas, 'img-kms-0003', '2001', 'MR', 'MRT Schädel nativ', '2026-02-19T11:05:00+01:00', [
        { description: 'T1 sagittal', instances: 176, bodySite: 'Head' },
        { description: 'T2 FLAIR axial', instances: 30, bodySite: 'Head' },
        { description: 'DWI', instances: 60, bodySite: 'Head' },
        { description: 'SWI', instances: 96, bodySite: 'Head' },
      ]),
    ],
    extraObservations: () => [],
  },
  {
    patient: fatma,
    bp: { start: [149, 91], end: [146, 89], noise: 11 },
    heartRate: 81,
    weightKg: 69,
    smoking: { code: '266919005', display: 'Never smoked tobacco' },
    conditions: [
      condition(fatma, 'cond-kms-0005', CODES.hypertension, 'Hypertensive disorder', '2015-09-21'),
      condition(fatma, 'cond-kms-0006', CODES.ckdStage3, 'Chronic kidney disease stage 3', '2022-06-14'),
    ],
    medications: [
      medication(fatma, 'medrx-kms-0005', 'C09AA05', 'Ramipril 10 mg', '1 Tablette morgens', '2022-06-20'),
      medication(fatma, 'medrx-kms-0006', 'C03CA04', 'Torasemid 5 mg', '1 Tablette morgens', '2024-01-09'),
    ],
    imaging: [
      study(fatma, 'img-kms-0004', '3001', 'CT', 'CT Abdomen nativ', '2026-04-08T08:30:00+02:00', [
        { description: 'Topogram', instances: 2 },
        { description: 'Abdomen axial 3 mm', instances: 210, bodySite: 'Abdomen' },
      ]),
      study(fatma, 'img-kms-0005', '3002', 'US', 'Sonographie Nieren beidseits', '2025-09-15T13:15:00+02:00', [
        { description: 'Niere rechts', instances: 8, bodySite: 'Kidney' },
        { description: 'Niere links', instances: 9, bodySite: 'Kidney' },
      ]),
    ],
    extraObservations: (rand) =>
      [52, 50, 47, 44].map((v, i) =>
        quantityObs(fatma, `obs-egfr-${fatma.id}-${i}`, monthsAgo(18 - i * 6, -Math.floor(rand() * 5)), CODES.egfr, 'Glomerular filtration rate/1.73 sq M.predicted', v, 'mL/min/1.73m2', 'mL/min/{1.73_m2}', labCategory)
      ),
  },
];

function buildObservations(profile: PatientProfile, seed: number): Observation[] {
  const rand = mulberry32(seed);
  const out: Observation[] = [];
  const p = profile.patient;
  const months = 24;
  for (let i = 0; i < months; i++) {
    const monthsBack = months - 1 - i;
    const t = i / (months - 1);
    const changeAt = profile.bp.changeAtMonth;
    // Linear drift from start to end; if a medication change is declared, hold the start
    // values until that month, then converge — the timeline should show a visible inflection.
    const progress = changeAt === undefined ? t : i < changeAt ? 0 : (i - changeAt) / (months - 1 - changeAt);
    const sys = Math.round(profile.bp.start[0] + (profile.bp.end[0] - profile.bp.start[0]) * progress + (rand() - 0.5) * 2 * profile.bp.noise);
    const dia = Math.round(profile.bp.start[1] + (profile.bp.end[1] - profile.bp.start[1]) * progress + (rand() - 0.5) * 2 * (profile.bp.noise * 0.6));
    // Day offsets are always negative so nothing is dated after the anchor.
    out.push(bloodPressure(p, i, monthsAgo(monthsBack, -1 - Math.floor(rand() * 6)), sys, dia));
  }
  for (let i = 0; i < 4; i++) {
    const when = monthsAgo(18 - i * 6, -Math.floor(rand() * 5));
    out.push(quantityObs(p, `obs-hr-${p.id}-${i}`, when, CODES.heartRate, 'Heart rate', Math.round(profile.heartRate + (rand() - 0.5) * 10), '/min', '/min'));
    out.push(quantityObs(p, `obs-wt-${p.id}-${i}`, when, CODES.bodyWeight, 'Body weight', Math.round((profile.weightKg + (rand() - 0.5) * 2) * 10) / 10, 'kg', 'kg'));
  }
  // Polymorphism on purpose: a value[x] that is a CodeableConcept, not a Quantity.
  out.push({
    resourceType: 'Observation',
    id: `obs-smoking-${p.id}`,
    status: 'final',
    category: socialCategory,
    code: { coding: [{ system: LOINC, code: CODES.smokingStatus, display: 'Tobacco smoking status' }], text: 'Smoking status' },
    subject: subject(p),
    effectiveDateTime: monthsAgo(3),
    performer,
    valueCodeableConcept: { coding: [{ system: SNOMED, code: profile.smoking.code, display: profile.smoking.display }], text: profile.smoking.display },
  });
  out.push(...profile.extraObservations(rand));
  return out;
}

/**
 * A structured assessment as a FHIR Questionnaire: the form definition lives on the FHIR server
 * like any other resource, and submissions are QuestionnaireResponses written back through the
 * dispatcher. Inline answerOptions only — no ValueSet expansion needed at render time.
 */
export const HTN_ASSESSMENT_URL = 'https://klinikum-musterstadt.example/fhir/Questionnaire/htn-followup';

export const htnAssessment: Questionnaire = {
  resourceType: 'Questionnaire',
  id: 'q-htn-followup',
  url: HTN_ASSESSMENT_URL,
  version: '1.0.0',
  name: 'HypertensionFollowUp',
  title: 'Hypertension follow-up assessment',
  status: 'active',
  subjectType: ['Patient'],
  date: '2026-09-01',
  publisher: 'Klinikum Musterstadt · Kardiologie',
  item: [
    {
      linkId: 'home_bp',
      text: 'How often does the patient measure blood pressure at home?',
      type: 'choice',
      required: true,
      answerOption: [
        { valueCoding: { code: 'daily', display: 'Daily' } },
        { valueCoding: { code: 'weekly', display: 'Weekly' } },
        { valueCoding: { code: 'rarely', display: 'Rarely or never' } },
      ],
    },
    {
      linkId: 'adherence',
      text: 'Medication adherence over the last four weeks',
      type: 'choice',
      required: true,
      answerOption: [
        { valueCoding: { code: 'full', display: 'All doses taken' } },
        { valueCoding: { code: 'partial', display: 'Some doses missed' } },
        { valueCoding: { code: 'poor', display: 'Frequently missed' } },
      ],
    },
    {
      linkId: 'symptoms',
      text: 'Symptoms since the last visit',
      type: 'choice',
      repeats: true,
      // Standard item-control extension; without it renderers show a repeating choice as single-select radios.
      extension: [
        {
          url: 'http://hl7.org/fhir/StructureDefinition/questionnaire-itemControl',
          valueCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/questionnaire-item-control', code: 'check-box' }] },
        },
      ],
      answerOption: [
        { valueCoding: { code: 'dizziness', display: 'Dizziness' } },
        { valueCoding: { code: 'headache', display: 'Headache' } },
        { valueCoding: { code: 'ankle_swelling', display: 'Ankle swelling' } },
        { valueCoding: { code: 'none', display: 'None' } },
      ],
    },
    {
      // A yes/no question that MUST be answered is a choice, not a boolean: a required boolean renders as a
      // checkbox that has to be ticked, so "No" could never be submitted — and "No" is a real clinical answer.
      linkId: 'side_effects',
      text: 'Side effects of current medication reported',
      type: 'choice',
      required: true,
      answerOption: [
        { valueCoding: { code: 'yes', display: 'Yes' } },
        { valueCoding: { code: 'no', display: 'No' } },
      ],
    },
    { linkId: 'notes', text: 'Notes for the next visit', type: 'text' },
  ],
};

/** One earlier submission for Anneliese Krüger so the submissions list is not empty on first open. */
export const priorAssessment: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse',
  id: 'qr-kms-0001',
  identifier: { system: 'urn:medapp:submission', value: 'seed-qr-kms-0001' },
  questionnaire: HTN_ASSESSMENT_URL,
  status: 'completed',
  subject: subject(anneliese),
  authored: monthsAgo(3, -2),
  author: { reference: `Practitioner/${practitioner.id}`, display: 'Dr. med. Lukas Hoffmann' },
  item: [
    { linkId: 'home_bp', text: 'How often does the patient measure blood pressure at home?', answer: [{ valueCoding: { code: 'weekly', display: 'Weekly' } }] },
    { linkId: 'adherence', text: 'Medication adherence over the last four weeks', answer: [{ valueCoding: { code: 'partial', display: 'Some doses missed' } }] },
    { linkId: 'symptoms', text: 'Symptoms since the last visit', answer: [{ valueCoding: { code: 'headache', display: 'Headache' } }] },
    { linkId: 'side_effects', text: 'Side effects of current medication reported', answer: [{ valueCoding: { code: 'no', display: 'No' } }] },
    { linkId: 'notes', text: 'Notes for the next visit', answer: [{ valueString: 'Amlodipin neu angesetzt; Verlauf in 3 Monaten prüfen.' }] },
  ],
};

/**
 * The canonical URL of the showcase falls-risk screen — an app-authored form (specs/falls-risk-assessment.yaml compiled for
 * hsp-musterstadt), so the record can hold earlier screens for it and a chart can show the course of a form's answers.
 */
export const FALLS_SCREEN_URL = 'https://hsp-musterstadt.medapp.eu/Questionnaire/app-falls-risk.falls-risk';

/** Three earlier falls screens for Anneliese Krüger: the timed up-and-go lengthening, one fall last winter. */
function fallsScreen(id: string, authored: string, fell: boolean, falls: number | undefined, aid: string, tug: number, factors: string[]): QuestionnaireResponse {
  return {
    resourceType: 'QuestionnaireResponse',
    id,
    identifier: { system: 'urn:medapp:submission', value: `seed-${id}` },
    questionnaire: FALLS_SCREEN_URL,
    status: 'completed',
    subject: subject(anneliese),
    authored,
    author: { reference: `Practitioner/${practitioner.id}`, display: 'Dr. med. Lukas Hoffmann' },
    item: [
      {
        linkId: 'history',
        text: 'History',
        item: [{ linkId: 'fell_last_year', text: 'Has the patient fallen in the last 12 months?', answer: [{ valueCoding: { code: fell ? 'yes' : 'no', display: fell ? 'Yes' : 'No' } }] }],
      },
      ...(fell ? [{ linkId: 'fall_details', text: 'About the falls', item: [{ linkId: 'falls_count', text: 'How many falls? (0–20)', answer: [{ valueInteger: falls ?? 1 }] }, { linkId: 'injury', text: 'Worst injury from a fall', answer: [{ valueCoding: { code: 'minor', display: 'Bruising or abrasion' } }] }] }] : []),
      {
        linkId: 'mobility',
        text: 'Mobility',
        item: [
          { linkId: 'walking_aid', text: 'Walking aid in use', answer: [{ valueCoding: { code: aid, display: aid.charAt(0).toUpperCase() + aid.slice(1) } }] },
          { linkId: 'timed_up_and_go', text: 'Timed up-and-go (s, 0–300)', answer: [{ valueDecimal: tug }] },
        ],
      },
      { linkId: 'risk_factors', text: 'Risk factors', item: [{ linkId: 'factors', text: 'Present', answer: factors.map((f) => ({ valueCoding: { code: f, display: f.replace(/_/g, ' ') } })) }] },
    ],
  };
}

const fallsScreens: QuestionnaireResponse[] = [
  fallsScreen('qr-kms-0002', monthsAgo(12, 4), false, undefined, 'none', 11.5, ['polypharmacy']),
  fallsScreen('qr-kms-0003', monthsAgo(6, 1), true, 1, 'stick', 14, ['polypharmacy', 'dizziness']),
  fallsScreen('qr-kms-0004', monthsAgo(1, -3), false, undefined, 'stick', 16.5, ['polypharmacy', 'dizziness', 'vision']),
];


// ── The rest of the record: allergies, procedures, immunizations, visits, reports, notes ──────────────
// What a clinician expects to find beside problems, medication and readings. Deliberately small and
// varied: one patient has a critical allergy, one has none recorded, reports carry a conclusion text,
// notes are plain-text attachments (base64, as DocumentReference wants them).

const TERMINOLOGY_HL7 = 'http://terminology.hl7.org/CodeSystem';

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function allergy(p: Patient, id: string, code: string, display: string, text: string, opts: { criticality: AllergyIntolerance['criticality']; category: NonNullable<AllergyIntolerance['category']>[number]; recorded: string; reaction?: { code: string; display: string; severity: 'mild' | 'moderate' | 'severe' } }): AllergyIntolerance {
  return {
    resourceType: 'AllergyIntolerance',
    id,
    clinicalStatus: { coding: [{ system: `${TERMINOLOGY_HL7}/allergyintolerance-clinical`, code: 'active', display: 'Active' }] },
    verificationStatus: { coding: [{ system: `${TERMINOLOGY_HL7}/allergyintolerance-verification`, code: 'confirmed', display: 'Confirmed' }] },
    type: 'allergy',
    category: [opts.category],
    criticality: opts.criticality,
    code: { coding: [{ system: SNOMED, code, display }], text },
    patient: subject(p),
    recordedDate: opts.recorded,
    recorder: performerRef,
    reaction: opts.reaction ? [{ manifestation: [{ coding: [{ system: SNOMED, code: opts.reaction.code, display: opts.reaction.display }], text: opts.reaction.display }], severity: opts.reaction.severity }] : undefined,
  };
}

function procedure(p: Patient, id: string, code: string, display: string, text: string, performed: string, opts: { bodySite?: { code: string; display: string }; encounter?: string; outcome?: string } = {}): Procedure {
  return {
    resourceType: 'Procedure',
    id,
    status: 'completed',
    code: { coding: [{ system: SNOMED, code, display }], text },
    subject: subject(p),
    encounter: opts.encounter ? { reference: `Encounter/${opts.encounter}` } : undefined,
    performedDateTime: performed,
    performer: [{ actor: performerRef }],
    bodySite: opts.bodySite ? [{ coding: [{ system: SNOMED, code: opts.bodySite.code, display: opts.bodySite.display }] }] : undefined,
    outcome: opts.outcome ? { text: opts.outcome } : undefined,
  };
}

function immunization(p: Patient, id: string, code: string, display: string, text: string, when: string, lot: string): Immunization {
  return {
    resourceType: 'Immunization',
    id,
    status: 'completed',
    vaccineCode: { coding: [{ system: SNOMED, code, display }], text },
    patient: subject(p),
    occurrenceDateTime: when,
    lotNumber: lot,
    performer: [{ actor: performerRef }],
    site: { coding: [{ system: `${TERMINOLOGY_HL7}/v3-ActSite`, code: 'LA', display: 'left arm' }] },
    route: { coding: [{ system: `${TERMINOLOGY_HL7}/v3-RouteOfAdministration`, code: 'IM', display: 'Injection, intramuscular' }] },
  };
}

function encounter(p: Patient, id: string, cls: 'AMB' | 'IMP', typeText: string, start: string, end: string, reason: { code: string; display: string }): Encounter {
  return {
    resourceType: 'Encounter',
    id,
    status: 'finished',
    class: { system: `${TERMINOLOGY_HL7}/v3-ActCode`, code: cls, display: cls === 'AMB' ? 'ambulatory' : 'inpatient encounter' },
    type: [{ coding: [{ system: SNOMED, code: cls === 'AMB' ? '390906007' : '32485007', display: cls === 'AMB' ? 'Follow-up encounter' : 'Hospital admission' }], text: typeText }],
    subject: subject(p),
    participant: [{ individual: performerRef }],
    period: { start, end },
    reasonCode: [{ coding: [{ system: SNOMED, code: reason.code, display: reason.display }] }],
    serviceProvider: { reference: `Organization/${organization.id}`, display: organization.name },
  };
}

function report(p: Patient, id: string, category: 'RAD' | 'LAB', code: string, display: string, text: string, when: string, conclusion: string, opts: { study?: string; results?: string[]; encounter?: string } = {}): DiagnosticReport {
  return {
    resourceType: 'DiagnosticReport',
    id,
    status: 'final',
    category: [{ coding: [{ system: `${TERMINOLOGY_HL7}/v2-0074`, code: category, display: category === 'RAD' ? 'Radiology' : 'Laboratory' }] }],
    code: { coding: [{ system: LOINC, code, display }], text },
    subject: subject(p),
    encounter: opts.encounter ? { reference: `Encounter/${opts.encounter}` } : undefined,
    effectiveDateTime: when,
    issued: when,
    performer: [{ reference: `Organization/${organization.id}`, display: organization.name }],
    resultsInterpreter: performer,
    result: opts.results?.map((r) => ({ reference: `Observation/${r}` })),
    imagingStudy: opts.study ? [{ reference: `ImagingStudy/${opts.study}` }] : undefined,
    conclusion,
  };
}

function note(p: Patient, id: string, code: string, display: string, title: string, when: string, text: string, encounterId?: string): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    docStatus: 'final',
    type: { coding: [{ system: LOINC, code, display }], text: title },
    category: [{ coding: [{ system: 'http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', code: 'clinical-note', display: 'Clinical Note' }] }],
    subject: subject(p),
    date: when,
    author: performer,
    description: title,
    content: [{ attachment: { contentType: 'text/plain', language: 'de', data: b64(text), title, creation: when } }],
    context: encounterId ? { encounter: [{ reference: `Encounter/${encounterId}` }] } : undefined,
  };
}

const encounters: Encounter[] = [
  encounter(anneliese, 'enc-kms-0001', 'IMP', 'Stationärer Aufenthalt Orthopädie', '2024-02-14T07:30:00+01:00', '2024-02-16T11:00:00+01:00', { code: CODES.kneeOsteoarthritis, display: 'Osteoarthritis of knee' }),
  encounter(anneliese, 'enc-kms-0002', 'AMB', 'Hypertonie-Sprechstunde', monthsAgo(7, 2).replace('T08:00', 'T09:20'), monthsAgo(7, 2).replace('T08:00', 'T09:45'), { code: CODES.hypertension, display: 'Hypertensive disorder' }),
  encounter(anneliese, 'enc-kms-0003', 'AMB', 'Diabetes-Sprechstunde', monthsAgo(4, 5).replace('T08:00', 'T10:00'), monthsAgo(4, 5).replace('T08:00', 'T10:30'), { code: CODES.type2Diabetes, display: 'Type 2 diabetes mellitus' }),
  encounter(anneliese, 'enc-kms-0004', 'AMB', 'Hypertonie-Sprechstunde', monthsAgo(1, 3).replace('T08:00', 'T08:40'), monthsAgo(1, 3).replace('T08:00', 'T09:05'), { code: CODES.hypertension, display: 'Hypertensive disorder' }),
  encounter(jonas, 'enc-kms-0005', 'AMB', 'Neurologische Sprechstunde', '2026-02-19T10:15:00+01:00', '2026-02-19T10:50:00+01:00', { code: CODES.migraine, display: 'Migraine' }),
  encounter(fatma, 'enc-kms-0006', 'AMB', 'Nephrologische Sprechstunde', monthsAgo(3, 1).replace('T08:00', 'T11:30'), monthsAgo(3, 1).replace('T08:00', 'T12:00'), { code: CODES.ckdStage3, display: 'Chronic kidney disease stage 3' }),
  encounter(fatma, 'enc-kms-0007', 'AMB', 'Hypertonie-Sprechstunde', monthsAgo(0, -2).replace('T08:00', 'T14:00'), monthsAgo(0, -2).replace('T08:00', 'T14:25'), { code: CODES.hypertension, display: 'Hypertensive disorder' }),
];

const allergies: AllergyIntolerance[] = [
  allergy(anneliese, 'alg-kms-0001', '373270004', 'Penicillin -class of antibiotic-', 'Penicillin', { criticality: 'high', category: 'medication', recorded: '2010-06-02', reaction: { code: '126485001', display: 'Urticaria', severity: 'moderate' } }),
  allergy(anneliese, 'alg-kms-0002', '256259004', 'Pollen', 'Gräserpollen', { criticality: 'low', category: 'environment', recorded: '2016-04-19', reaction: { code: '267036007', display: 'Dyspnea', severity: 'mild' } }),
  allergy(fatma, 'alg-kms-0003', '293637006', 'Contrast media allergy', 'Jodhaltiges Kontrastmittel', { criticality: 'high', category: 'medication', recorded: '2022-06-15', reaction: { code: '39579001', display: 'Anaphylaxis', severity: 'severe' } }),
];

const procedures: Procedure[] = [
  procedure(anneliese, 'prc-kms-0001', '179344006', 'Arthroscopy of knee', 'Arthroskopie Knie rechts', '2024-02-15T09:10:00+01:00', { bodySite: { code: '6757004', display: 'Structure of right knee' }, encounter: 'enc-kms-0001', outcome: 'Komplikationslos; Teilresektion Innenmeniskus.' }),
  procedure(anneliese, 'prc-kms-0002', '410451008', 'Diabetic retinopathy screening', 'Augenhintergrund-Screening', monthsAgo(4, 5).replace('T08:00', 'T10:40'), { encounter: 'enc-kms-0003', outcome: 'Keine Retinopathie.' }),
  procedure(fatma, 'prc-kms-0003', '22778000', 'Renal biopsy', 'Nierenbiopsie', '2022-07-04T08:00:00+02:00', { bodySite: { code: '64033007', display: 'Kidney structure' }, outcome: 'Interstitielle Fibrose, IgA-Ablagerungen.' }),
];

const immunizations: Immunization[] = [
  immunization(anneliese, 'imm-kms-0001', '46233009', 'Influenza virus vaccine', 'Influenza-Impfung 2025/26', '2025-10-08T10:00:00+02:00', 'FLU-25-0931'),
  immunization(anneliese, 'imm-kms-0002', '1119349007', 'SARS-CoV-2 mRNA vaccine', 'COVID-19-Auffrischung', '2025-11-12T09:30:00+01:00', 'COV-25-1187'),
  immunization(jonas, 'imm-kms-0003', '333620004', 'Tetanus vaccine', 'Tetanus-Auffrischung', '2023-05-22T11:00:00+02:00', 'TET-23-0044'),
  immunization(fatma, 'imm-kms-0004', '46233009', 'Influenza virus vaccine', 'Influenza-Impfung 2025/26', '2025-10-15T09:00:00+02:00', 'FLU-25-1042'),
  immunization(fatma, 'imm-kms-0005', '333598008', 'Pneumococcal vaccine', 'Pneumokokken-Impfung', '2024-03-06T10:30:00+01:00', 'PNE-24-0217'),
];

const reports: DiagnosticReport[] = [
  report(anneliese, 'rep-kms-0001', 'RAD', '24627-2', 'CT Chest', 'CT Thorax mit Kontrastmittel', '2025-11-03T11:40:00+01:00', 'Kein Nachweis eines Infiltrats oder einer Raumforderung. Kein Pleuraerguss. Aortensklerose. Unauffällige mediastinale Lymphknoten.', { study: 'img-kms-0001' }),
  report(anneliese, 'rep-kms-0002', 'LAB', '24323-8', 'Comprehensive metabolic 2000 panel', 'Labor: Stoffwechsel und Nierenwerte', monthsAgo(4, 5).replace('T08:00', 'T07:10'), 'HbA1c 6,8 % — im individuellen Zielbereich. Nierenfunktion normal.', { results: ['obs-hba1c-pat-kms-0001-3'], encounter: 'enc-kms-0003' }),
  report(jonas, 'rep-kms-0003', 'RAD', '24590-2', 'MR Brain', 'MRT Schädel nativ', '2026-02-19T13:05:00+01:00', 'Altersentsprechend unauffälliges Neurokranium. Kein Nachweis einer Ischämie, Blutung oder Raumforderung.', { study: 'img-kms-0003', encounter: 'enc-kms-0005' }),
  report(fatma, 'rep-kms-0004', 'LAB', '24362-6', 'Renal function panel', 'Labor: Nierenfunktion', monthsAgo(3, 1).replace('T08:00', 'T07:30'), 'eGFR 44 mL/min/1,73 m² — CKD-Stadium 3b, weiter abnehmend gegenüber dem Vorbefund.', { results: ['obs-egfr-pat-kms-0003-3'], encounter: 'enc-kms-0006' }),
  report(fatma, 'rep-kms-0005', 'RAD', '28582-4', 'US Kidney', 'Sonographie Nieren beidseits', '2025-09-15T14:00:00+02:00', 'Beidseits verkleinerte Nieren mit verschmälertem Parenchymsaum, keine Harnstauung, keine Konkremente.', { study: 'img-kms-0005' }),
];

const notes: DocumentReference[] = [
  note(anneliese, 'doc-kms-0001', '18842-5', 'Discharge summary', 'Entlassungsbrief Orthopädie', '2024-02-16T12:00:00+01:00', 'Entlassungsbrief\n\nFrau K. wurde zur arthroskopischen Teilresektion des Innenmeniskus rechts aufgenommen. Der Eingriff verlief komplikationslos. Mobilisation ab dem ersten postoperativen Tag unter Vollbelastung.\n\nProzedere: Physiotherapie 2x/Woche für 6 Wochen, Wiedervorstellung bei Beschwerdepersistenz.', 'enc-kms-0001'),
  note(anneliese, 'doc-kms-0002', '11488-4', 'Consult note', 'Kardiologischer Konsilbericht', monthsAgo(1, 3).replace('T08:00', 'T09:10'), 'Konsilbericht Kardiologie\n\nBlutdruck in der Sprechstunde 136/84 mmHg, häusliche Messungen im Zielbereich. Therapie mit Ramipril und Amlodipin gut vertragen, keine Ödeme.\n\nEmpfehlung: Medikation unverändert fortführen, Kontrolle in 3 Monaten mit Nierenwerten.', 'enc-kms-0004'),
  note(jonas, 'doc-kms-0003', '11488-4', 'Consult note', 'Neurologischer Konsilbericht', '2026-02-19T11:00:00+01:00', 'Konsilbericht Neurologie\n\nMigräne ohne Aura, 2–3 Attacken pro Monat, gutes Ansprechen auf Sumatriptan. MRT Schädel ohne pathologischen Befund.\n\nEmpfehlung: Attackentherapie beibehalten, Kopfschmerztagebuch, Prophylaxe bei Zunahme der Frequenz erwägen.', 'enc-kms-0005'),
  note(fatma, 'doc-kms-0004', '11488-4', 'Consult note', 'Nephrologischer Konsilbericht', monthsAgo(3, 1).replace('T08:00', 'T12:10'), 'Konsilbericht Nephrologie\n\nCKD-Stadium 3b bei arterieller Hypertonie, eGFR 44 mL/min/1,73 m², leichte Progredienz. Blutdruck 146/89 mmHg, damit oberhalb des Zielbereichs.\n\nEmpfehlung: Ramipril ausdosieren, Torasemid beibehalten, Kontrolle der Nierenwerte in 3 Monaten; nephroprotektive Ernährungsberatung.', 'enc-kms-0006'),
];

/** The task vocabulary an app's author names — the code system every app-made Task carries. */
export const TASK_SYSTEM = 'urn:medapp:task';

function task(p: Patient, id: string, code: string, display: string, status: Task['status'], priority: Task['priority'], authored: string, opts: { due?: string; description?: string; owner?: boolean; completed?: string } = {}): Task {
  return {
    resourceType: 'Task',
    id,
    status,
    intent: 'order',
    priority,
    code: { coding: [{ system: TASK_SYSTEM, code, display }], text: display },
    ...(opts.description ? { description: opts.description } : {}),
    for: subject(p),
    authoredOn: authored,
    lastModified: opts.completed ?? authored,
    requester: performerRef,
    ...(opts.owner ? { owner: performerRef } : {}),
    ...(opts.due ? { restriction: { period: { end: opts.due } } } : {}),
    ...(opts.completed ? { executionPeriod: { end: opts.completed } } : {}),
  };
}

// The ward's open work as the record holds it: a screen that is due (and, by the time the panel runs, overdue), a letter
// someone has started, an urgent call, and a screen already done — which no open list shows.
const tasks: Task[] = [
  task(anneliese, 'task-kms-0001', 'falls_screen', 'Falls risk screen', 'requested', 'routine', monthsAgo(0, -1), { due: monthsAgo(0, 3).slice(0, 10), description: 'Jährliches Screening fällig.' }),
  task(anneliese, 'task-kms-0002', 'discharge_letter', 'Discharge letter', 'in-progress', 'routine', monthsAgo(0, 1), { due: monthsAgo(0, 20).slice(0, 10), owner: true }),
  task(fatma, 'task-kms-0003', 'follow_up_call', 'Follow-up call', 'requested', 'urgent', monthsAgo(0, 2), { due: monthsAgo(-2, 0).slice(0, 10), description: 'Nierenwerte besprechen.' }),
  task(jonas, 'task-kms-0004', 'falls_screen', 'Falls risk screen', 'completed', 'routine', monthsAgo(1, -5), { due: monthsAgo(1, 0).slice(0, 10), owner: true, completed: monthsAgo(1, -2) }),
];

/** What a photo documents — the ward's own words, like the task vocabulary. */
export const PHOTO_SYSTEM = 'urn:medapp:photo';

// Two synthetic PNG tiles (flat colour, a ring, a label) standing in for wound photos — not pictures of anyone. Inline
// data, as the mock serves it; the dispatcher's store would hold the bytes and the record a storage URL.
const WOUND_T0 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAACEklEQVR42u3bv0vDQBQH8NfQlGKTDoXioIgOFQo6dFJEdOrm4uqf4aaLuOjmn+Hq4OYkItKt0BYCFlEEXWo7NK1Dszi4tOkP2uTuXX5831ry433u3eVyuSZ+3hqEmB4aCAAEIAABCEAAAhCAEAACEIAABCAARSuSQbiJ54vTaT/tX96ovbeEwgWzGS7BkVIDtBCNWiZuIM80qphYgabpzEjYwyFhBZqY6px5+jk2HEDjGXpIT8hJggjkSsxnVmLPpn6iKDwf1xmEjPrKgCS1NqcR36uG2L7A9hTT2Mon+NMrlRUko8F5ikiLQPlIvaIW0vJhKyKsB6kAGq522Y08fH4ZvQwVBCAAAQhAAAIQgAAUoskb56QUFRQAIHlFxLBmIAuI/xOopCsydTEZTc2z5KSFrkmZr8U3SIttcLYVS42zYUVlxfntUGMufv9GzF9W8W0+GECE3R1+RlbsDxI8Tkd2h5l/pujvUfTMFK9drvNLxXqfNJY7ABSDGPmvRtuqf1eeiKj7+Z5d2yCi5dJO26o5v319KVM4Pkmm03EDmjwGVa7Pd8+uiOjj4V43sit7h18vj06/t14+QhcbiU7Tym+XiCi/Veq8WhiD3OH07JRhElHKzDp9G0CIBYF0wxz0bCIa2F09YwLIHblCsVWvElGrUc1tFuP+mB+P1YNy8+62bdX+H/MxBMKrBgZpAAFIZfwB1zHs3uZKu8gAAAAASUVORK5CYII=';
const WOUND_T14 = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAACTklEQVR42u2bO08CQRDH9zYWJsSKTqRRgdAJJMbGjoooxMpPIaHwY9Ddp7DRhAgVIQQLiUZjfBRyaiVoIZUkxhOMBYk5eQW529l7/KfjuN29+c3sMDc7KG+PtwwyXjgQABAAARAAARAAARAAQQAIgAAIgAAIgNwlc3Z4iPxRftxX+zv7cp9NkVgwm8DFPqTkAPoXGrmYqAHNjEYWJlJA4+hMUHiGIU4FNFLVKfU0M9YZgIY1nEE9SyaxI6ABxUxqZe1s8hNFy/UZmMGSqC8NkCBrUzKie9Wwdi+Q/YpxMvexf3ol04NEGJzGibgL3Efoityh7kPmRKgHyQBk9HbRRjbOL2KXwYMACIAACIAACIAACIAclLxRJqXwIBsAEudEBDUDUYDoj0AFrUi0xUSYmqbkxB1nUuK16IK0tQYnq1hySsNapRXl2SEndn7zjIhPVnE2bw9ADN0dZiIr+oMsjtOu7TAzj8n9PYozY/JWl+v0pDzdJ41yBwB5QP78V0NraZePl4yx5/bzkn+JMRZbjoUD4eFhn1+fleuK1tKy21nj9afXp8JZIZfOuRNQaDEUWgwxxtRjdXdzd8Kww9PDSCDy8PJgvKh39fp9nSvci1tMPVaNH9Pr6fhKfOCe2l0tsZpQFAUxiPnmfQNXmu1m56MTCUTcHINGSvmq3H5v61394OTAv+BPriWH7+l996o31cxGxuVBeqT0iUyOSo1mQ+/qxfNiPxKVLkqpRMorgKaRaDAaDUZ/o5Vr6PwjBu1t7XkzD8KrBjJpAAIgmfIDxRkKSrMkTy4AAAAASUVORK5CYII=';

function photo(p: Patient, id: string, kind: string, display: string, bodySite: string, created: string, data: string, note: string): Media {
  return {
    resourceType: 'Media',
    id,
    status: 'completed',
    type: { coding: [{ system: `${TERMINOLOGY_HL7}/media-type`, code: 'photo', display: 'Photo' }] },
    reasonCode: [{ coding: [{ system: PHOTO_SYSTEM, code: kind, display }], text: display }],
    subject: subject(p),
    createdDateTime: created,
    issued: created,
    operator: performerRef,
    bodySite: { text: bodySite },
    note: [{ authorString: 'Dr. med. Lukas Hoffmann', time: created, text: note }],
    content: { contentType: 'image/png', data, size: Math.floor((data.length * 3) / 4), title: `${display} · ${bodySite}`, creation: created },
  };
}

const photos: Media[] = [
  photo(anneliese, 'media-kms-0001', 'wound', 'Wound', 'Left heel', monthsAgo(0, -16), WOUND_T0, 'Synthetic tile — pressure area, day 0.'),
  photo(anneliese, 'media-kms-0002', 'wound', 'Wound', 'Left heel', monthsAgo(0, -2), WOUND_T14, 'Synthetic tile — day 14, granulating.'),
];

/** The physiotherapy code system the therapy-plan apps use for goals the record has no LOINC code for. */
export const PHYSIO_SYSTEM = 'https://hsp-musterstadt.medapp.eu/CodeSystem/physio';

/** Anneliese's therapy plan after the falls: one measurable goal and the plan it belongs to — what the declared-shape `record` section writes, read back. */
const goals: Goal[] = [
  {
    resourceType: 'Goal',
    id: 'goal-kms-0001',
    identifier: [{ system: 'urn:medapp:submission', value: 'goal-seed-0001' }],
    lifecycleStatus: 'active',
    description: { text: 'Timed up-and-go under 12 seconds without a walking aid' },
    subject: subject(anneliese),
    target: [{ measure: { coding: [{ system: PHYSIO_SYSTEM, code: 'tug', display: 'Timed up-and-go' }], text: 'Timed up-and-go' }, detailQuantity: { value: 12, unit: 's' }, dueDate: monthsAgo(-3).slice(0, 10) }],
    statusDate: monthsAgo(1).slice(0, 10),
    expressedBy: performerRef,
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/goal-priority', code: 'high-priority', display: 'High Priority' }], text: 'High' },
    note: [{ authorString: 'Dr. med. Lukas Hoffmann', time: monthsAgo(1), text: 'Agreed after the second fall; physiotherapy twice a week.' }],
  },
];

const carePlans: CarePlan[] = [
  {
    resourceType: 'CarePlan',
    id: 'careplan-kms-0001',
    identifier: [{ system: 'urn:medapp:submission', value: 'careplan-seed-0001' }],
    status: 'active',
    intent: 'plan',
    title: 'Falls prevention — physiotherapy',
    description: 'Strength and balance training twice a week for twelve weeks; home exercise plan; review of the walking aid at week six.',
    subject: subject(anneliese),
    period: { start: monthsAgo(1).slice(0, 10), end: monthsAgo(-2).slice(0, 10) },
    created: monthsAgo(1),
    author: performerRef,
    goal: [{ reference: 'Goal/goal-kms-0001' }],
    activity: [{ detail: { kind: 'ServiceRequest', status: 'in-progress', description: 'Strength and balance training', scheduledString: 'Twice a week' } }],
  },
];

/**
 * The lab's own measurements for Anneliese, after the falls: knee flexion (range of motion) and grip strength, both
 * sides, weekly over the therapy so far — the operated left knee catching up with the right, the grip steady. Coded on
 * the lab's code system, with the structure and the side in bodySite (SNOMED laterality) and the test condition in
 * method, exactly as a `record_observation` form with `side` and `conditions` writes them.
 */
const examCategory = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'exam', display: 'Exam' }] }];
const KNEE = { system: SNOMED, code: '49076000', display: 'Knee joint structure' };
const HAND = { system: SNOMED, code: '85562004', display: 'Hand structure' };
const SIDE = { left: { system: SNOMED, code: '7771000', display: 'Left' }, right: { system: SNOMED, code: '24028007', display: 'Right' } } as const;
const ACTIVE = { system: PHYSIO_SYSTEM, code: 'active', display: 'Active movement' };

function physioObs(id: string, when: string, code: string, display: string, value: number, unit: string, ucum: string, site: { system: string; code: string; display: string }, side: keyof typeof SIDE, method?: { system: string; code: string; display: string }): Observation {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    category: examCategory,
    code: { coding: [{ system: PHYSIO_SYSTEM, code, display }], text: display },
    subject: subject(anneliese),
    effectiveDateTime: when,
    performer,
    valueQuantity: { value, unit, system: UCUM, code: ucum },
    bodySite: { coding: [site, SIDE[side]], text: `${site.display} · ${side}` },
    ...(method ? { method: { coding: [method], text: method.display } } : {}),
  };
}

const physioObservations: Observation[] = [
  // Knee flexion, degrees, weekly for six weeks: the left (operated) knee from 95° to 118°, the right steady around 135°.
  ...[95, 100, 104, 109, 113, 118].flatMap((left, i) => {
    const when = monthsAgo(0, -42 + i * 7);
    return [
      physioObs(`obs-physio-kf-l-${i}`, when, 'knee_flexion', 'Knee flexion (ROM)', left, '°', 'deg', KNEE, 'left', ACTIVE),
      physioObs(`obs-physio-kf-r-${i}`, when, 'knee_flexion', 'Knee flexion (ROM)', [134, 136, 135, 135, 137, 136][i]!, '°', 'deg', KNEE, 'right', ACTIVE),
    ];
  }),
  // Grip strength, kilograms, three times: left 22→24, right 26→27.
  ...[0, 1, 2].flatMap((i) => {
    const when = monthsAgo(0, -42 + i * 21);
    return [physioObs(`obs-physio-gs-l-${i}`, when, 'grip_strength', 'Grip strength', [22, 23, 24][i]!, 'kg', 'kg', HAND, 'left'), physioObs(`obs-physio-gs-r-${i}`, when, 'grip_strength', 'Grip strength', [26, 26.5, 27][i]!, 'kg', 'kg', HAND, 'right')];
  }),
];

/**
 * Anneliese's consent decisions, one per purpose — treatment permitted, research declined — as the MII consent module
 * frames them: scope and category say what kind of consent it is, `provision.type` whether it permits or denies, the
 * purpose on the provision. One purpose never implies another: two resources, read back side by side.
 */
const CONSENT_SCOPE = 'http://terminology.hl7.org/CodeSystem/consentscope';
const CONSENT_CATEGORY = 'http://loinc.org';
const ACT_REASON = 'http://terminology.hl7.org/CodeSystem/v3-ActReason';

function consentDecision(id: string, when: string, scope: { code: string; display: string }, decision: 'permit' | 'deny', purpose: { code: string; display: string }): Consent {
  return {
    resourceType: 'Consent',
    id,
    identifier: [{ system: 'urn:medapp:submission', value: `${id}-seed` }],
    status: 'active',
    scope: { coding: [{ system: CONSENT_SCOPE, code: scope.code, display: scope.display }], text: scope.display },
    category: [{ coding: [{ system: CONSENT_CATEGORY, code: '59284-0', display: 'Patient Consent' }] }],
    patient: subject(anneliese),
    dateTime: when,
    performer: [subject(anneliese)],
    organization: [{ reference: `Organization/${organization.id}`, display: organization.name }],
    provision: { type: decision, purpose: [{ system: ACT_REASON, code: purpose.code, display: purpose.display }] },
  };
}

const consents: Consent[] = [
  consentDecision('consent-kms-0001', monthsAgo(1, -3), { code: 'treatment', display: 'Treatment' }, 'permit', { code: 'TREAT', display: 'treatment' }),
  consentDecision('consent-kms-0002', monthsAgo(1, -3), { code: 'research', display: 'Research' }, 'deny', { code: 'HRESCH', display: 'healthcare research' }),
];

export interface SeedData {
  readonly patients: Patient[];
  readonly observations: Observation[];
  readonly conditions: Condition[];
  readonly medicationRequests: MedicationRequest[];
  readonly imagingStudies: ImagingStudy[];
  readonly practitioners: Practitioner[];
  readonly organizations: Organization[];
  readonly questionnaires: Questionnaire[];
  readonly questionnaireResponses: QuestionnaireResponse[];
  readonly allergies: AllergyIntolerance[];
  readonly procedures: Procedure[];
  readonly immunizations: Immunization[];
  readonly encounters: Encounter[];
  readonly diagnosticReports: DiagnosticReport[];
  readonly documents: DocumentReference[];
  readonly tasks: Task[];
  readonly media: Media[];
  readonly goals: Goal[];
  readonly carePlans: CarePlan[];
  readonly consents: Consent[];
}

export const SEED: SeedData = Object.freeze({
  patients: profiles.map((p) => p.patient),
  observations: [...profiles.flatMap((p, i) => buildObservations(p, 1000 + i)), ...physioObservations],
  conditions: profiles.flatMap((p) => p.conditions),
  medicationRequests: profiles.flatMap((p) => p.medications),
  imagingStudies: profiles.flatMap((p) => p.imaging),
  practitioners: [practitioner],
  organizations: [organization],
  questionnaires: [htnAssessment],
  questionnaireResponses: [priorAssessment, ...fallsScreens],
  allergies,
  procedures,
  immunizations,
  encounters,
  diagnosticReports: reports,
  documents: notes,
  tasks,
  media: photos,
  goals,
  carePlans,
  consents,
});

export function allSeedResources(): Resource[] {
  return [
    ...SEED.organizations,
    ...SEED.practitioners,
    ...SEED.patients,
    ...SEED.encounters,
    ...SEED.conditions,
    ...SEED.allergies,
    ...SEED.medicationRequests,
    ...SEED.observations,
    ...SEED.procedures,
    ...SEED.immunizations,
    ...SEED.imagingStudies,
    ...SEED.diagnosticReports,
    ...SEED.documents,
    ...SEED.questionnaires,
    ...SEED.questionnaireResponses,
    ...SEED.tasks,
    ...SEED.media,
    ...SEED.goals,
    ...SEED.carePlans,
    ...SEED.consents,
  ];
}
