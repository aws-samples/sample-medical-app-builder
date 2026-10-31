# Describing an app to the builder — example prompts

The app builder is the conversation on the drafting page (**New app** in the panel, or `python -m
app_creator.harness` from `infra/`). You describe the app in plain language; the builder fills a typed
draft, asks about what is still open, shows a preview rendered on synthetic patients, and you save the
result to the registry. This page collects English requests that reliably produce each kind of app the
platform can build, requests that refine a draft, and requests the builder declines and what it offers
instead. German works the same way; the German twins of most of these are in
[application-catalog.yaml](application-catalog.yaml) (`example_requests.de`) and in the agent's evaluation
corpus (`infra/app_creator/eval/corpus.yaml`).

The kinds of app, their data plans and limits are described in [application-catalog.md](application-catalog.md);
the draft the conversation produces is described in [app-spec.md](app-spec.md).

## 1. What a request needs to say

Before the builder can compile anything it needs four things: what the page shows and for whom; the roles
that may open it and which identity fields each may see; the setting (clinical context and intended
users); and the one-sentence intended purpose an approver signs — what the app is for and what it is not
for. You can give all of it in the first message or let the builder ask; it asks at most three questions at
a time, each with a default it takes if you answer "fine" or "your defaults".

Name clinical things the way you would say them — blood pressure, HbA1c, eGFR, ramipril, hypertension,
CT and MRI. The builder looks up the codes — LOINC, SNOMED, ATC, and the German hospital codings
ICD-10-GM and OPS; you never type codes. In this deployment its terminology is the catalog's hint list,
not a terminology server, so the concepts it resolves on its own are: blood pressure (systolic and
diastolic), heart rate, oxygen saturation, body weight, HbA1c, eGFR, glucose, the common blood count and
chemistry values (haemoglobin, leukocytes, platelets, sodium, potassium, calcium, CRP, ALT, AST,
bilirubin) and smoking status; hypertension, type 2 diabetes, CKD stage 3, migraine and knee
osteoarthritis, and on the hospital's record their ICD-10-GM forms plus lung cancer, diffuse large B-cell
lymphoma, prostate cancer, anaemia in neoplastic disease and hypokalaemia; radiotherapy, gastroscopy,
central venous catheter, haemodialysis and red-cell transfusion (OPS); ramipril, amlodipine, metformin,
torasemide and sumatriptan; and the DICOM modalities. Beyond that list, a deployment connected to a
hospital's record also searches the **record's own vocabulary** — every code actually present on the FHIR
server, by the display text the hospital uses (German or English) and by code — so "Ferritin", "Kalium" or
"Gonarthrose" resolve to the record's codes and the builder tells you how many patients carry them. For
anything neither knows it asks you for the exact concept or the code rather than guessing — so a prompt
that stays within this list goes through without that
detour, which is why the ones below do. The builder also knows how the connected record is coded (the
catalog's `record_notes`): on a German hospital's server, diagnoses are ICD-10-GM and procedures OPS, there is no
medication, encounter or allergy data yet, and patients have no MRN — see section 8. Roles are bound either to a group created for
the app when it is published, or to an existing hospital group the builder lists on request — it never
invents a group name.

Do not paste a patient's details. An app is designed once for all patients; the patient comes from the
launch context when the app is opened. If details are pasted anyway, the builder says in one sentence that
it has not recorded them and carries on.

A complete request has this shape:

> *What it shows, for which situation.* *Roles and the identity fields each may see.* *Where it is used and
> by whom; display only, or documentation without interpretation.* Your defaults for the rest.

The prompts below follow it. Where a prompt is split into two turns, the first is the request as a
clinician would open the conversation and the second is the answer to what the builder then asks.

## 2. Which kind of app a request produces

| You want… | The builder picks | Section |
|---|---|---|
| an overview of one patient — problems, medication, vitals, the record | APP-01 Patient summary | 3.1 |
| one or more values over time, with guideline lines | APP-02 Longitudinal observation trend | 3.2 |
| many values as a table, newest first | APP-03 Observation flowsheet | 3.3 |
| the problem list and/or the medication, filtered by status | APP-04 Problem list and medication review | 3.4 |
| the imaging studies with a viewer | APP-05 Imaging study review | 3.5 |
| the consultation view for a named chronic disease | APP-06 Disease-specific follow-up dashboard | 3.6 |
| everything relevant on one dense screen before seeing the patient | APP-07 Pre-consultation snapshot | 3.7 |
| one FHIR resource in full, field by field | APP-08 FHIR resource inspector | 3.8 |
| every patient with a condition, each with a latest value flagged — optionally only those with imaging on record | APP-09 Condition-defined cohort register | 3.9 |
| only the headline numbers of such a cohort | APP-10 Cohort KPI tiles | 3.10 |
| a form saved to the record, earlier submissions alongside | APP-11 Structured assessment | 3.11 |
| a page assembled from several of the above, plus allergies, visits, reports, letters, procedures, immunizations, or a table of any record type; recording a measurement; marking a problem resolved; stopping a prescription | APP-12 Composed page | 3.12 and 4 |

Named kinds come first when they fit — they carry tuned defaults. A request that mixes the parts of
several kinds ("the trend, with the medication beside it and the problems underneath") is a composed
page, not the nearest template.

## 3. One request per kind

### 3.1 Patient summary (APP-01)

> Give me an overview of the patient: active problems, current medication and the recent vitals, with the
> FHIR record on its own tab.

> For the general medicine clinic I need a patient overview — active problems, current medication, blood
> pressure, heart rate, weight and HbA1c from the last two years, and the whole FHIR record on a separate
> tab. One role, the treating clinicians, who may see the full identity. Chart review before and during the
> consultation, display only, not for diagnosis. Your defaults for the rest.

What you get: tabs for problems, medication, vitals and the record; the stock patient header with the
role's identity fields; a two-year window on the vitals. Say "stack the sections down the page instead of
tabs" for one long page, and "mask the identity to name, date of birth and MRN" to swap the header for the
masking banner.

### 3.2 Longitudinal observation trend (APP-02)

> I'd like to see a patient's blood pressure over the last two years against the Stage 1 thresholds, 140
> systolic and 90 diastolic.
>
> Two roles please. A viewer who only sees name, date of birth and MRN. A reviewer who also sees sex,
> address and phone, and gets the problem list underneath. Viewer is the default. It is for GPs and
> cardiologists in outpatient blood pressure monitoring. Display only, not for diagnosis. Take your defaults
> for anything else.

> Plot HbA1c for the last five years with a target line at 7 percent. One role, the physicians of the
> diabetes clinic; they may see name, date of birth, sex and MRN. Display only. Your defaults otherwise.

> The patient's eGFR over three years with lines at 60 and 45, and the latest values in a table beside the
> chart.

What you get: a line per series (a blood pressure panel becomes a systolic and a diastolic series), the
threshold lines with their labels, the readings table beside the chart, and — in the two-role version — a
problem list only the reviewer sees and only the reviewer's scope requests. One point per day per series;
coded results appear in the table only.

### 3.3 Observation flowsheet (APP-03)

> All of the patient's vitals and lab results from the last six months as a table, newest first — blood
> pressure, heart rate and weight in one tab, eGFR in a second. One role, the ward nurses, who see name,
> date of birth and MRN. Ward monitoring, display only.

What you get: one table per group, newest first, quantity, coded, text and component values each rendered
correctly; a six-month window. Ask for "at most twenty rows" or "roomier rows" to tune the tables.

### 3.4 Problem list and medication review (APP-04)

> Active problems and current medication for this patient, side by side. One role, the treating
> clinicians, with name, date of birth, sex and MRN. Outpatient consultation, display only — no interaction
> checking.

What you get: the problem list beside the medication list, active entries only. "Show the full medication
history, not only active prescriptions" switches the medication filter; "stacked, not side by side" stacks
them.

### 3.5 Imaging study review (APP-05)

> Show me the patient's CT and MRI studies and let me open them in the viewer. One role, the radiologists;
> the full identity except contact details. Display of existing studies only. Your defaults for the rest.

> The patient's CT studies, opening in the viewer as a 3D reconstruction — it is for surgery planning.

What you get: the study list filtered to the modalities beside the viewer; selecting a study opens it, as a
2-D stack by default or, when asked for, in MPR (the three reconstructed planes) or MPR with a 3-D volume
rendering — the header of the viewer lets the user switch anyway, and expand it over the page. No upload;
the viewer's own tools only. Without a configured viewer URL the study metadata is shown instead.

### 3.6 Disease-specific follow-up dashboard (APP-06)

> A hypertension follow-up view for the GPs: blood pressure over the last year against the guideline lines,
> the antihypertensives and the related problems. One role, GPs, with name, date of birth and MRN. Display
> only.

> A diabetes clinic view with the HbA1c trend against 7 percent, the weight, the antidiabetic medication
> and the problem list.

> A CKD monitoring view: eGFR over three years with lines at 60 and 45, the ACE inhibitors and diuretics,
> and the problem list.

What you get: the builder fills the whole disease from a template — series, thresholds, observation
codes, medication classes and condition codes — for hypertension, type 2 diabetes and CKD; anything you
name explicitly overrides the template. Threshold lines are visual only.

### 3.7 Pre-consultation snapshot (APP-07)

> A one-screen snapshot before I see the patient: how many active problems and current medications, the
> latest blood pressure, weight and HbA1c from the last 90 days, and the two lists underneath, compact.
> One role, the treating clinicians; name, date of birth, sex and MRN. Outpatient consultation, display only.

What you get: a compact banner, count tiles that are list lengths (not computations), the latest
readings and the two lists on one screen; a short window.

### 3.8 FHIR resource inspector (APP-08)

> Show me the patient's full record, field by field, and the most recent assessment response underneath.
> One role, the clinical data stewards, with the full identity. Data-quality review, read-only.

> Show me the patient's latest report in full, with the references resolved.

What you get: schema-driven rendering of a single resource with references resolved — the patient
record, or the most recent resource of a type (report, encounter, assessment response) for the patient.
One resource per panel; for lists of visits or reports see the composed page.

### 3.9 Condition-defined cohort register (APP-09)

> Give me a list of all patients with active hypertension and their latest blood pressure, and flag anyone
> with systolic at or above 140. One role, the hypertension nurses; they see name, date of birth and MRN to
> identify a patient, but no contact details. Population overview, listing only, no scoring. Defaults
> otherwise.

> All patients with active type 2 diabetes and their latest HbA1c, flagged at or above 8 percent.

> All diabetics with their latest HbA1c, and a slider so I can narrow the list to a range — say 7 to 9
> percent to start with, steps of half a percent.

> Build me a cohort by diagnosis and imaging: all patients with lung cancer, C34.1, who have had a CT scan
> in the last two years, with a link to open the images. One role, the thoracic oncology board; name, date
> of birth and MRN. Display only.

> Alle Patientinnen und Patienten mit C34.1, die ein CT hatten.

What you get: a headline count, the count above the threshold, and a table with one row per patient and
the latest value flagged. With a range: a two-handle slider under the tiles, a tile counting the members in
the selected range, and the table reduced to them — all live, in the browser, over the members and values
the app fetched once (the range is a view, not a criterion: the audit trail shows one cohort read however
often the handles move). The slider's bounds come from the request or from the data. With imaging: the
cohort is narrowed, before any value is read, to the members with studies of the asked modalities (within a
window and above a minimum count when asked), a tile counts them, and each row carries the number of studies
and the latest one — date, modality, description — with an "Open imaging" link to a published imaging app on
that patient when the request names one. Studies are asked of the PACS where one is connected (by MRN) and
of the record's ImagingStudy otherwise; the register lists them, it does not display them. A register may be
by diagnosis and imaging alone, without a value column. Membership is by condition code (and imaging) only;
the threshold is "at or above" only; no sorting, paging or export. Cohorts by age, sex, medication, encounter
or a value are declined (section 6).

### 3.10 Cohort KPI tiles (APP-10)

> How many patients have active hypertension, and how many of them are at or above 140 systolic? Just
> the numbers, no patient list — it is for a wall display. One role for the department lead, name and MRN
> only. Display only.

What you get: the register reduced to its tiles.

### 3.11 Structured assessment (APP-11)

> The hypertension nurses need to document the follow-up assessment for a patient and see what was
> recorded before.
>
> Yes, the follow-up form you have. One role, the hypertension nurses, who see name, date of birth, sex and
> MRN and may record assessments. Documentation only, no scores.

What you get: the questionnaire rendered for the patient in context, the completed response validated
against it and written to the record through the dispatcher, earlier submissions listed alongside. A form
the record holds is used by its URL (in this deployment the hypertension follow-up assessment); a form it
lacks is designed in the conversation, never invented as a URL:

> Build me an assessment app for our new falls-risk screen. The nurse records whether the patient fell in
> the last twelve months — and if so, how many times (0 to 20) and the worst injury —, the walking aid in
> use, the timed up-and-go in seconds, and which risk factors are present.

The builder proposes the items in plain words — question, type, required, when it is asked — and changes
them on your word. The questions about the fall are a section asked only after a fall (`show_when` on the
heading), the count's range is refused on submission (`min`/`max`, the problem named by the question), and
an option can carry a code the builder looked up (`system` + `code`) so the answer lands on the record as
that concept. The form becomes a FHIR Questionnaire the app carries, reviewed and signed
with the app and written to the record when it is published. A form never asks for identity and never scores.

### 3.12 Composed page (APP-12)

> For the hypertension consultation I want the blood pressure trend over two years with the current
> medication beside it, and underneath the kidney values as a table next to the problem list.
>
> One role, the treating cardiologists; they see name, date of birth and MRN. Outpatient hypertension
> consultation, display only. Your defaults for the rest.

What you get: four sections in two rows — trend and medication sharing the first, readings table and
problems the second — with one window for the page. More compositions are in section 4.

## 4. Composed pages — more shapes

**Tabs, with a section only one role sees.**

> For the nurse visit, one page with tabs: first the counts at a glance — active problems, current
> medication and the blood pressure readings of the last year — then the hypertension follow-up form to
> fill in, and a third tab with the patient record itself that only the lead nurse can see. Two roles: the
> nurses see name, date of birth and MRN; the lead nurse inherits that and also sees sex, address, phone and
> email. Hypertension follow-up clinic, documentation without scoring.

The record tab is absent from the strip for nurses. A gated section that needs data the other roles do not
— a problem list for reviewers only, say — puts that read in the gated role's scope alone; here the record
is the Patient resource every role already reads for the banner, so only the tab and the lead nurse's wider
identity fields differ. Because the page contains a form that writes, it is a workflow app.

**The rest of the record for the ward round.**

> For the ward round I need, per patient, the allergies first, then the visits and the reports side by
> side, underneath the letters and notes, and at the end the latest lab results as a table with date, test,
> result and status. One role, the ward physicians; name, date of birth, sex and MRN. Display only, no
> interpretation.

Allergies, encounters, reports with their conclusions, notes (plain-text attachments are shown inline;
PDFs and images are named), and a generic table of Observations with the columns you named. An empty
allergy list reads "none recorded", which is not "no known allergies".

**A table of any record type, with the columns you name.**

> A page with the patient's procedures — date, procedure and status — beside the immunizations with
> date, vaccine and status, and the allergies above them.

**Recording a reading, resolving a problem, stopping a prescription.**

> For the ward I need a page where the nurse records the patient's blood pressure — systolic and
> diastolic — and sees the trend beside it, and can mark a problem as resolved and stop a prescription
> when the doctor says so.
>
> One role, the ward nurses; name, date of birth and MRN. Ward round, nurses, documentation only — no
> interpretation. Your defaults otherwise.

The entry form records one coded value or panel in a declared unit and plausibility range, dated within a
window (an implausible entry is refused with the reason, not silently corrected); the problem list gains
"Mark resolved", the medication list "Stop", each asking for a remark. Every write is attributed,
versioned (a record changed by someone else in the meantime is not overwritten) and leaves a Provenance
on the record. The nurse's scope shows `create` on Observation, `update` on Condition and
MedicationRequest, and `create` on Provenance.

> A page where the diabetes nurse records the patient's weight in kilograms and the HbA1c in percent, each
> with its trend over the last three years beside it. Refuse anything outside 20 to 300 kg or 3 to 20
> percent.

Two entry forms, two trends. The ranges are data-quality rules — an impossible entry is refused — not
clinical thresholds; leave them out and any number is accepted.

## 5. Refining a draft — follow-up requests

Everything in the draft can be changed in the same conversation; the panel on the right shows the effect
immediately, and the *Preview* compiles and renders the current draft.

> Put the sections in tabs instead. · Stack them, not side by side. · Make the chart wider than the table.

> Look back five years instead of two. · Only the last 90 days.

> Add a line at 130 labelled "target". · Drop the diastolic line.

> Two roles: a viewer with name, date of birth and MRN, and a reviewer who also sees address and phone.
> The reviewer gets the problem list; the viewer does not. · Which existing groups could the reviewer be
> bound to? · Bind the reviewer to that group. · Make the viewer the default role.

> Only the lead nurse should see the record tab.

> Show the full medication history, not only active prescriptions. · Include resolved problems too.

> Call it "Hypertension consult". · The purpose is: display of recorded readings and therapy for the
> follow-up consultation; not for diagnosis.

> Fine. · Your defaults for the rest. · Show me the preview.

## 6. Requests the builder declines, and what it offers instead

The builder refuses these plainly, records the refusal, and offers the closest thing it can build. The
reasons are in the catalog's `refusals`; the short version:

| Request | Why it is declined | What it offers |
|---|---|---|
| "Build a cardiovascular risk score that tells me if the patient is high risk." | No computation — the expression language is lookup-only, and scores are clinical decisions. | The inputs side by side: the trends and lists the score would use. |
| "Summarise the record with AI before the consultation." | No AI summaries, extraction or interpretation yet. | A snapshot (APP-07) or a composed page of the record's parts. |
| "Let me find a patient by name." | Patient context comes from the SMART launch or the panel's patient selection; there is no search. | The same app, opened with the patient already in context. |
| "All patients older than 65 on ramipril." | Cohorts are defined by condition code, optionally narrowed by imaging on record — not by age or medication. | A register of patients with the related condition. |
| "Flag anyone below 90 systolic." | Cohort thresholds are "at or above" only. | The at-or-above flag, or the value column unflagged. |
| "A bar chart of blood pressure by month." | Only the single-patient line chart exists. | The trend as a line chart. |
| "A worklist of patients due for follow-up, and remind me." | No tasks, scheduling or notifications. | A register with the latest value and its date. |
| "Export the list as PDF." · "Print the letter." | No export or printing; reports are an unrealised intent class. | The list on screen. |
| "Let me measure the lesion in the CT." | The viewer is embedded read-only. | Opening the study in the viewer. |
| "Make the header red and add our logo." | Layout carries only catalog components and props — by design. | Nothing; the design system is fixed. |
| "Include the patients of the other hospital in our network." | One deployment per hospital — by design. | Nothing. |
| "Let the doctor prescribe from the medication list." · "Order a CT." · "Upload the images." · "Delete the wrong entry." | Writes are confined to what the record can validate. | Stopping a prescription with a reason, resolving a problem, recording a measurement, documenting through a form. |

Two more requests get an answer rather than an app: a page no kind covers ("a triage queue where nurses
drag patients between columns as they are seen") is told so plainly rather than approximated with the
nearest template; and a request for a form that is not on the record is answered with the forms that are.

## 7. From preview to published app

When the readiness check is satisfied the builder compiles the draft, describes the app in plain language —
who may open it, what they see, which identity fields are visible, what it records if anything — and asks
you to confirm. *Save to registry* writes a draft version; *Submit for review* hands it to an approver,
who approves and publishes it from the **Pending sign-off** tab. Publishing creates the app's groups (unless
the roles were bound to existing ones) and makes it available to the clinicians in them. A later
conversation on the same app produces a new version; the published one stays until the new one is
published in its place.

## 8. On the hospital's record

Connected to a hospital's own servers (`infra/docs/hospital-servers.md`), the same requests work, with the record's
own vocabulary. Patients are found by name in the launcher — there is no MRN to type — and the builder picks
the hospital's codes when you name a diagnosis or a procedure. Three requests that showed data on the first record connected (a German hospital's HAPI facade
with research-cohort patients), and two that did not:

> Give me an oncology overview for the patient: the active diagnoses, the procedures, the radiology reports
> and the imaging studies on one page. One role, the tumour board, full identity. Display only, for case
> discussion.

What you get: a composed page whose problem list shows the ICD-10-GM diagnoses (lymphoma, anaemia in
neoplastic disease, hypertension …), the OPS procedures (radiotherapy, gastroscopy, transfusions), the RAD
reports as cards and the CT/MR/DX studies beside the viewer.

> The patient's haemoglobin over the last five years against the lower reference values, with the readings
> beside the chart. One role, the haematology ward; name, date of birth and sex. Display only.

What you get: a trend on one of the German lab panel's LOINC codes (718-7) — that record had about 60 000
observations, most of them laboratory values spanning many years per patient, which is why five years rather
than two — newest readings in the table.

> All patients with essential hypertension (I10.00 or I10.90), each with their latest blood pressure,
> flagged above 140 systolic. The hypertension clinic, name and date of birth only. Display only.

What you get: the cohort register on ICD-10-GM codes; blood pressure panels (85354-9) existed on that record,
so the latest-value column filled.

Two things showed empty on that record, and the builder says so when asked: **medication** (no
MedicationRequest resources — a medication review app builds, but lists nothing) and **visits,
allergies, letters and immunizations** (no Encounter, AllergyIntolerance, DocumentReference or Immunization
resources). The hypertension follow-up form is written to the hospital's server by the deployment, so the structured
assessment app works; its submissions land there as QuestionnaireResponses with Provenance.

## 9. The showcase apps, as requests

The thirteen apps the registry ships (`manifests/`, see the README) are what these requests produce; each is a
published example of how far one request can go, and together they cover every capability once.

> Everything about the patient on one page: headline counts, active problems and current medication side by
> side, the blood pressure trend against 140 and 90 with the latest vitals beside it, then allergies and
> visits, reports and letters, procedures and immunizations, the laboratory results, and the FHIR record
> itself. Two roles: treating clinicians see name, date of birth, sex and MRN; senior clinicians also see
> address, phone and email, and only they get the record. Chart review, display only. — *Patient 360*

> For the cardio-renal clinic: blood pressure over three years against 140/90 with the readings beside it,
> eGFR against 60 and 45, body weight, and the heart rate readings. The ward nurses record blood pressure
> readings; the physicians may mark problems resolved and stop prescriptions. — *Cardio-renal follow-up*

> A diabetes follow-up dashboard for the diabetes clinic, the last two years. — *Diabetes follow-up* (the
> template fills HbA1c against the ADA goal, the antidiabetics by class and the related conditions)

> A tumour board page: diagnoses and procedures, the radiology reports, haemoglobin, CRP and leukocytes over
> five years, the imaging studies opening in MPR, and the letters. One role, the tumour board, full identity
> except contact details. — *Tumour board*

> The patient's imaging studies, the viewer opening them in 3D. Radiologists and surgeons. — *Imaging review (3D)*

> All patients with a hypertension diagnosis and their latest blood pressure, flagged from 140 systolic, with a
> slider over the systolic value. The hypertension clinic; name, date of birth and MRN. — *Hypertension register*

> All patients with chronic kidney disease who have had a CT or an ultrasound, with the number of studies and
> the latest one per patient, their latest eGFR, and a link to open them in the imaging review. — *CKD register
> with renal imaging*

> The hypertension follow-up form for the clinic nurses, with earlier assessments, the blood pressure trend
> and readings, and the problems and medication alongside. — *Hypertension follow-up visit*

> Which hypertension patients are due that follow-up assessment — never assessed first, then overdue — every
> 90 days, opening the follow-up app from the row. — *Follow-up assessments due*

> The falls-risk screen for the geriatric ward (fell in the last year, how many times and the worst injury
> when so, walking aid, unsteady, timed up-and-go in seconds, risk factors, measures, next review), with the
> earlier screens, the timed up-and-go across them as a chart against 13.5 s, the last screen in full, and the
> problem list. — *Falls risk screen*

> Ward documentation: the problem list with a form to add one of our common diagnoses, the allergies with a
> form to record a drug allergy, the procedures with a form to document a gastroscopy, a central line, a
> transfusion or a urinary catheter, and the patient's open tasks with a form for a new one. The ward team,
> physicians and nurses. — *Ward documentation*

> A worklist for the ward: every open falls screen, discharge letter, follow-up call, physiotherapy referral
> and wound check across our patients, overdue first; take one on, complete it, open the patient in the ward
> documentation app. — *Ward worklist*

> Wound documentation: the wound photos so far, newest first, and a form to take a new one on the ward tablet
> — wound, pressure ulcer or skin finding — with the body site and a remark, over the problem list. — *Wound
> documentation*
