import type { Patient, Resource } from '@medplum/fhirtypes';
import { PatientHeader as MedplumPatientHeader, ResourceTable } from '@medplum/react';
import { Paper, Stack, Text, Title } from '@mantine/core';

/**
 * Thin catalog adapters over Medplum React components that already render FHIR correctly.
 * The adapter's job is to translate manifest props → Medplum props and pin the behaviour
 * we rely on (e.g. `forceUseInput` so the component never re-fetches around the dispatcher).
 */

export function PatientHeader({ patient }: { patient?: Patient }) {
  if (!patient) return null;
  return (
    <Paper withBorder p="xs" data-testid="medplum-patient-header">
      <MedplumPatientHeader patient={patient} />
    </Paper>
  );
}

export interface ResourceDetailsProps {
  readonly resource?: Resource;
  readonly title?: string;
  readonly ignore_missing?: boolean;
}

/** Generic, schema-driven FHIR resource view (Medplum ResourceTable). */
export function ResourceDetails({ resource, title, ignore_missing = true }: ResourceDetailsProps) {
  if (!resource) {
    return (
      <Text c="dimmed" size="sm">
        Nothing to show.
      </Text>
    );
  }
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        {title && <Title order={4}>{title}</Title>}
        <ResourceTable value={resource} ignoreMissingValues={ignore_missing} forceUseInput />
      </Stack>
    </Paper>
  );
}
