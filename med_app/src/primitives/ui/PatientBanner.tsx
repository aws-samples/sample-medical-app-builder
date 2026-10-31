import { useContext, useMemo, type ReactNode } from 'react';
import type { Patient } from '@medplum/fhirtypes';
import { calculateAgeString, formatDate, getIdentifier } from '@medplum/core';
import { AddressDisplay, ContactPointDisplay, HumanNameDisplay, ResourceAvatar } from '@medplum/react';
import { Badge, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import type { PhiField } from '../../manifest/schema';
import { phiFieldsVisibleToOtherRoles } from '../../manifest/roles';
import { RenderContext } from '../../renderer/RenderContext';
import { MRN_SYSTEM } from '../data/mock/seed';

export interface PatientBannerProps {
  readonly patient?: Patient;
  /** Allow-list from the role's effective data scope. Anything not listed is not shown. */
  readonly visible_fields?: readonly PhiField[];
  /** Identity row only (no address / phone / email). */
  readonly compact?: boolean;
  readonly mrn_system?: string;
}

const LABELS: Record<PhiField, string> = {
  name: 'Name',
  dob: 'Date of birth',
  gender: 'Gender',
  mrn: 'MRN',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
};

function Masked({ field }: { field: PhiField }) {
  return (
    <Tooltip label={`${LABELS[field]} is hidden for this role`}>
      <Badge color="gray" variant="outline" leftSection={<IconEyeOff size={12} />} tt="none">
        {LABELS[field]} hidden
      </Badge>
    </Tooltip>
  );
}

/**
 * Patient identification strip with PHI masking driven by the manifest's data scope.
 * Wraps Medplum display components for correct HumanName / Address / ContactPoint rendering.
 *
 * One rule for every field: shown when the role's scope allows it and the patient has it; announced
 * as "hidden" when the role's scope lacks it but another role of the same app may see it (a real
 * access difference, so the clinician knows it is policy, not missing data); otherwise omitted —
 * a field no role of the app can see is simply not part of the app.
 */
export function PatientBanner({ patient, visible_fields = [], compact = false, mrn_system = MRN_SYSTEM }: PatientBannerProps) {
  const ctx = useContext(RenderContext);
  const manifest = ctx?.manifest;
  const role = ctx?.role;
  const visibleToOthers = useMemo(() => (manifest && role ? phiFieldsVisibleToOtherRoles(manifest, role) : []), [manifest, role]);

  if (!patient) {
    return (
      <Paper withBorder p="md">
        <Text c="dimmed" size="sm">
          No patient in context.
        </Text>
      </Paper>
    );
  }

  const can = (f: PhiField) => visible_fields.includes(f);
  /** Shown / announced / omitted — see the component note. */
  const field = (f: PhiField, value: ReactNode): ReactNode => (can(f) ? value : visibleToOthers.includes(f) ? <Masked key={f} field={f} /> : null);

  const officialName = patient.name?.find((n) => n.use === 'official') ?? patient.name?.[0];
  const mrn = getIdentifier(patient, mrn_system);
  const phone = patient.telecom?.find((t) => t.system === 'phone');
  const email = patient.telecom?.find((t) => t.system === 'email');
  const age = patient.birthDate ? calculateAgeString(patient.birthDate) : undefined;

  const identity: ReactNode[] = [
    field(
      'name',
      <Text key="name" fw={600} size={compact ? 'md' : 'lg'}>
        <HumanNameDisplay value={officialName} />
      </Text>
    ),
    field(
      'gender',
      patient.gender && (
        <Text key="gender" size="sm" c="dimmed">
          {patient.gender}
        </Text>
      )
    ),
    field(
      'dob',
      <Text key="dob" size="sm" c="dimmed">
        {patient.birthDate ? `${formatDate(patient.birthDate)}${age ? ` (${age})` : ''}` : 'Date of birth unknown'}
      </Text>
    ),
    field(
      'mrn',
      mrn && (
        <Badge key="mrn" variant="light" color="ink" tt="none" className="ds-mono" fw={500}>
          MRN {mrn}
        </Badge>
      )
    ),
  ];

  const contact: ReactNode[] = compact
    ? []
    : [
        field(
          'address',
          patient.address?.[0] && (
            <Text key="address" size="sm">
              <AddressDisplay value={patient.address[0]} />
            </Text>
          )
        ),
        field(
          'phone',
          phone && (
            <Text key="phone" size="sm">
              <ContactPointDisplay value={phone} />
            </Text>
          )
        ),
        field(
          'email',
          email && (
            <Text key="email" size="sm">
              <ContactPointDisplay value={email} />
            </Text>
          )
        ),
      ];
  const hasContact = contact.some(Boolean);

  return (
    <Paper withBorder p={compact ? 'sm' : 'md'} data-testid="patient-banner">
      <Group align="flex-start" gap="md" wrap="nowrap">
        <ResourceAvatar value={patient} size={compact ? 'md' : 'lg'} radius="sm" />
        <Stack gap={4} style={{ flex: 1 }}>
          <Group gap="sm" align="baseline">
            {identity}
          </Group>
          {hasContact && <Group gap="lg">{contact}</Group>}
        </Stack>
      </Group>
    </Paper>
  );
}
