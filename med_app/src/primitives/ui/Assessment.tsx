import { useMemo } from 'react';
import type { Questionnaire, QuestionnaireResponse, QuestionnaireResponseItem, QuestionnaireResponseItemAnswer } from '@medplum/fhirtypes';
import { formatDate, formatDateTime, formatQuantity } from '@medplum/core';
import { QuestionnaireForm, StatusBadge } from '@medplum/react';
import { Accordion, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';
import { ActionForm } from './ActionForm';

export interface AssessmentFormProps {
  /** The Questionnaire (form definition) fetched by a data primitive. */
  readonly questionnaire?: Questionnaire;
  /** The manifest action that submits the response (must run a write.* primitive). */
  readonly action: string;
  /** `$ui` key under which the produced QuestionnaireResponse is handed to the action. */
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
}

/**
 * A structured assessment: Medplum renders the Questionnaire and produces a QuestionnaireResponse;
 * the response goes to the manifest's action, which runs the write primitive through the dispatcher.
 * The component never talks to a FHIR server itself. Saving / saved / error / "record another" come
 * from ActionForm, shared by every action-driven form.
 */
export function AssessmentForm({ questionnaire, action, state_key = 'assessment_response', title, submit_label = 'Submit assessment' }: AssessmentFormProps) {
  const { context } = useRenderContext();
  // The card header already names the form; Medplum would otherwise add its own large heading.
  const rendered = useMemo(() => (questionnaire ? { ...questionnaire, title: undefined } : undefined), [questionnaire]);

  if (!questionnaire || !rendered) {
    return (
      <Paper withBorder p="md">
        <Text size="sm" c="dimmed">
          The form definition is not available.
        </Text>
      </Paper>
    );
  }

  const patientId = typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;

  /** What the action receives: the answers plus a submission id; nothing that claims authorship. */
  const toPayload = (response: QuestionnaireResponse): QuestionnaireResponse => {
    // Medplum fills `source` from its own client profile, which is a placeholder here: the dispatcher
    // stamps author and time from the authenticated identity, so nothing client-side claims authorship.
    const { source: _source, author: _author, ...answers } = response;
    void _source;
    void _author;
    return {
      ...answers,
      // A client-generated submission id makes a retried submit idempotent server-side.
      identifier: response.identifier ?? { system: 'urn:medapp:submission', value: crypto.randomUUID() },
      questionnaire: questionnaire.url ?? response.questionnaire,
      status: 'completed',
    };
  };

  return (
    <ActionForm
      action={action}
      title={title ?? questionnaire.title ?? 'Assessment'}
      subtitle={questionnaire.publisher ? `${questionnaire.publisher}${questionnaire.version ? ` · v${questionnaire.version}` : ''}` : undefined}
      another_label="Record another assessment"
      testid="assessment-form"
    >
      {({ formKey, running, submit }) => (
        <QuestionnaireForm
          key={formKey}
          questionnaire={rendered}
          subject={patientId ? { reference: `Patient/${patientId}` } : undefined}
          submitButtonText={running ? 'Saving…' : submit_label}
          onSubmit={(r) => void submit({ [state_key]: toPayload(r) })}
        />
      )}
    </ActionForm>
  );
}

export interface SubmissionListProps {
  readonly responses?: QuestionnaireResponse[];
  readonly title?: string;
}

function formatAnswer(a: QuestionnaireResponseItemAnswer): string | undefined {
  if (a.valueCoding) return a.valueCoding.display ?? a.valueCoding.code;
  if (a.valueBoolean !== undefined) return a.valueBoolean ? 'Yes' : 'No';
  if (a.valueString !== undefined) return a.valueString;
  if (a.valueInteger !== undefined) return String(a.valueInteger);
  if (a.valueDecimal !== undefined) return String(a.valueDecimal);
  if (a.valueDate) return formatDate(a.valueDate);
  if (a.valueDateTime) return formatDateTime(a.valueDateTime);
  if (a.valueTime) return a.valueTime;
  if (a.valueUri) return a.valueUri;
  if (a.valueQuantity) return formatQuantity(a.valueQuantity);
  if (a.valueReference) return a.valueReference.display ?? a.valueReference.reference;
  if (a.valueAttachment) return a.valueAttachment.title ?? 'Attachment';
  return undefined;
}

/** Question/answer pairs of a QuestionnaireResponse; multiple answers are listed comma-separated, groups nest. */
export function AnswerList({ items = [] }: { readonly items?: QuestionnaireResponseItem[] }) {
  return (
    <Stack gap="xs" data-testid="answer-list">
      {items.map((item) => {
        const values = (item.answer ?? []).map(formatAnswer).filter((v): v is string => v !== undefined);
        return (
          <div key={item.linkId}>
            <Text size="sm" fw={500}>
              {item.text ?? item.linkId}
            </Text>
            {values.length > 0 && <Text size="sm">{values.join(', ')}</Text>}
            {item.item && item.item.length > 0 && (
              <div style={{ paddingLeft: 12, marginTop: 4 }}>
                <AnswerList items={item.item} />
              </div>
            )}
            {values.length === 0 && (!item.item || item.item.length === 0) && (
              <Text size="sm" c="dimmed">
                No answer
              </Text>
            )}
          </div>
        );
      })}
    </Stack>
  );
}

/** Earlier submissions, newest first; each expands into its question/answer pairs. */
export function SubmissionList({ responses = [], title = 'Previous assessments' }: SubmissionListProps) {
  return (
    <Paper withBorder p="md" data-testid="submission-list">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed">
            {responses.length} {responses.length === 1 ? 'entry' : 'entries'}
          </Text>
        </Group>
        {responses.length === 0 ? (
          <Text size="sm" c="dimmed">
            No assessments recorded yet.
          </Text>
        ) : (
          <Accordion variant="separated" radius="sm">
            {responses.map((r) => (
              <Accordion.Item key={r.id} value={r.id ?? 'unknown'}>
                <Accordion.Control>
                  <Group gap="sm">
                    <Text size="sm" fw={500}>
                      {formatDateTime(r.authored)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {r.author?.display ?? (r.author?.identifier ? 'Signed-in clinician' : '')}
                    </Text>
                    <StatusBadge status={r.status ?? 'unknown'} />
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <AnswerList items={r.item} />
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </Stack>
    </Paper>
  );
}

export interface LatestAnswersProps {
  /** The patient's most recent response to the form (`$bindings.<x>[0]` of a QuestionnaireResponse query, newest first). */
  readonly response?: QuestionnaireResponse;
  readonly title?: string;
}

/** The last time the form was filled, question by question — the last falls screen on a patient overview. */
export function LatestAnswers({ response, title = 'Latest answers' }: LatestAnswersProps) {
  return (
    <Paper withBorder p="md" data-testid="latest-answers">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          {response && (
            <Group gap="sm">
              <Text size="sm" c="dimmed">
                {formatDateTime(response.authored)}
                {response.author?.display ? ` · ${response.author.display}` : ''}
              </Text>
              <StatusBadge status={response.status ?? 'unknown'} />
            </Group>
          )}
        </Group>
        {response ? (
          <AnswerList items={response.item} />
        ) : (
          <Text size="sm" c="dimmed" data-testid="latest-answers-empty">
            Not filled in yet for this patient.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
