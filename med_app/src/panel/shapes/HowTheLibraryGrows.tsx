import { Badge, Code, Grid, Group, Paper, Stack, Text, ThemeIcon, Timeline, Title } from '@mantine/core';
import { IconCode, IconPencil } from '@tabler/icons-react';
import { CLOSED_KINDS, OPEN_KINDS, PATIENT_SCOPED_KINDS, RECORD_RESOURCES } from '../../fhir/kinds';
import { tokens } from '../../theme';

/**
 * The two ways the library grows, side by side. A *shape* is an author's work in this section — minutes, no release:
 * the forms the builder can make for the resource types the engine admits. A *resource type* is the platform's work —
 * a platform release that teaches the engine what the platform stamps on that type, how it is read back, how it is
 * audited and what the assistant may say about it. The admitted types are read from the engine itself, so this never
 * drifts from what a shape may declare.
 */

interface Step {
  readonly title: string;
  readonly text: string;
  readonly where?: string;
}

const AUTHOR_STEPS: readonly Step[] = [
  { title: 'Write the shape', text: 'Pick one of the admitted kinds, then: an id apps will refer to, a name, the status the platform stamps, and the fields — each with the element path it is written to. Every path is checked against the FHIR definitions as you type. An administrator may pick an open kind instead and declare its stamps.' },
  { title: 'Preview it as a form', text: 'The page beside the document renders the shape on the synthetic record, next to what the patient already has of that type; entries saved there stay in the preview.' },
  { title: 'Save the draft', text: 'A draft is revised in place as often as needed. Once a version is published, the next save starts a new draft after it; the published one stays as it is.' },
  { title: 'Publish', text: 'Approvers and admins publish. One version is published at a time; publishing a newer one deprecates the previous, and apps built with it keep it.' },
  { title: 'Use it in apps', text: 'A composed page says shape: <id> in a record section; the assistant offers published shapes before designing fields by hand; "Open as an app" starts a draft around it. Every record written carries the shape and its version as a tag.' },
];

const PLATFORM_STEPS: readonly Step[] = [
  { title: 'Admit the type', text: 'Add the resource to the list the engine accepts and say which statuses a shape may choose and which one is the default. For the kinds open below, an administrator skips this track entirely: the shape declares the stamps itself. Refusing a kind is the opposite line — a name and a reason in the policy file.', where: 'src/fhir/kinds.ts · RECORD_RESOURCES · src/fhir/closed-kinds.json · src/spec/record.ts STATUS_CHOICES' },
  { title: 'Decide what the platform stamps', text: 'Which element is the status, which names the patient, which the author, which dates are "when" — the elements a form never writes. The required elements that remain are what a shape must cover.', where: 'src/spec/record.ts · recordStamps, requiredCoreElements' },
  { title: 'Ship its definition', text: 'Every patient-scoped kind already ships its element paths; admitting one moves its full definition into the base set so the tailored sections can use it, and the Python validator mirrors the encodings.', where: 'scripts/extract-fhir-definitions.mjs → src/fhir/base-definitions.json · dispatcher/record_shape.py' },
  { title: 'Let it be read back', text: 'Open kinds are already queryable on both sides (one generated list, npm run export:kinds). Admitting one adds its audit category and facet, says which date orders its entries, and seeds an example in the synthetic record.', where: 'queryResources.ts → infra data/record-kinds.json · composed.ts RECORD_CATEGORY, LIST_CATEGORY · fhir_source.py · mock/seed.ts' },
  { title: 'Tell the assistant', text: 'Name the type in the catalog text the assistant reads for record sections; the prompt budget decides what gets trimmed.', where: 'docs/application-catalog.yaml · docs/app-spec.md' },
  { title: 'Prove it, then release', text: 'Shared write cases run by both validators, a dispatcher test, a bundled shape with a fixture and its golden; deploy the API, authoring and hosting stacks and seed the shape.', where: 'writeCases.json · recordShape.test.tsx · test_dispatcher.py · shapes/*.yaml · specs/expected/' },
];

function Track({ icon, label, who, steps, color }: { icon: typeof IconPencil; label: string; who: string; steps: readonly Step[]; color: string }) {
  const Icon = icon;
  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon variant="light" color={color} size={34} radius="md">
          <Icon size={18} stroke={1.75} />
        </ThemeIcon>
        <div>
          <Text size="sm" fw={600}>
            {label}
          </Text>
          <Text size="xs" c="dimmed">
            {who}
          </Text>
        </div>
      </Group>
      <Timeline active={steps.length} bulletSize={24} lineWidth={2} color={color}>
        {steps.map((s, i) => (
          <Timeline.Item
            key={s.title}
            bullet={
              <Text size="xs" fw={700} lh={1}>
                {i + 1}
              </Text>
            }
            title={
              <Text size="sm" fw={600}>
                {s.title}
              </Text>
            }
          >
            <Text size="xs" c="dimmed" mt={2}>
              {s.text}
            </Text>
            {s.where && (
              <Text size="xs" mt={4} className="ds-mono" style={{ color: tokens.muted }}>
                {s.where}
              </Text>
            )}
          </Timeline.Item>
        ))}
      </Timeline>
    </Stack>
  );
}

export function HowTheLibraryGrows() {
  return (
    <Stack gap="md" data-testid="how-the-library-grows">
      <div>
        <Title order={4}>How the library grows</Title>
        <Text size="sm" c="dimmed" mt={2} maw={820}>
          Two different things grow. A <strong>shape</strong> is a template: one of the kinds of record the engine admits, with the fields a particular form for it has — there can be any number of
          shapes of the same kind, and an author makes one here in minutes. A <strong>kind of record</strong> (a FHIR resource type) is the platform's: admitting one is a release, because the engine
          has to learn what it stamps on that kind, how it is read back and audited, and what the assistant may say about it — decided once, then open to every shape. In between, a rule rather than a
          list: every kind of FHIR R4 that is <strong>about a patient</strong> (its subject or patient is a Patient — {PATIENT_SCOPED_KINDS.length} of them) and that the platform neither admits nor
          refuses by name is <strong>open to administrators</strong>, who may define a shape for it without a release, declaring the stamps the platform would otherwise know.
        </Text>
      </div>
      <Grid gutter="xl">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Track icon={IconPencil} label="A new shape" who="An author, in this section — no release; as many as needed per kind." steps={AUTHOR_STEPS} color="clinical" />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Track icon={IconCode} label="A new kind of record" who="The platform team — a platform release, reviewed once." steps={PLATFORM_STEPS} color="ink" />
        </Grid.Col>
      </Grid>
      <Paper withBorder p="md" style={{ background: tokens.page }}>
        <Group gap="sm" align="flex-start" wrap="wrap">
          <Text size="xs" fw={600} style={{ flex: 'none', paddingTop: 2 }}>
            Kinds of record admitted today
          </Text>
          <Group gap={6} data-testid="admitted-types">
            {RECORD_RESOURCES.map((r) => (
              <Badge key={r} variant="outline" color="ink" tt="none">
                {r}
              </Badge>
            ))}
          </Group>
        </Group>
        <Group gap="sm" align="flex-start" wrap="wrap" mt="sm">
          <Text size="xs" fw={600} style={{ flex: 'none', paddingTop: 2 }}>
            Open to administrators, by rule
          </Text>
          <Group gap={6} data-testid="open-kinds">
            {OPEN_KINDS.map((r) => (
              <Badge key={r} variant="outline" color="gray" tt="none">
                {r}
              </Badge>
            ))}
          </Group>
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          Any number of shapes may be made for each. A shape for an open kind declares its stamps (which element names the patient, the status, the dates) and is an administrator's to define. The
          platform refuses {Object.keys(CLOSED_KINDS).length} kinds by name, each with its reason — prescriptions and orders, scheduling, identity, billing, anything computed, the kinds that have a
          tailored section of their own, and what the platform writes itself (<Code>src/fhir/closed-kinds.json</Code>). What a shape cannot say, whatever the kind: a reference to another resource, an
          update or deletion of what is on record, a value the platform would compute. Those are the engine's limits, kept so that every record an app writes is self-contained, about the patient in
          context, and attributable — <Code>meta.tag</Code> names the shape and version that produced it.
        </Text>
      </Paper>
    </Stack>
  );
}
