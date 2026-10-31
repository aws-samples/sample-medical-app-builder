import { useState } from 'react';
import { ActionIcon, Badge, Button, Checkbox, Group, Paper, Radio, Select, Stack, TagsInput, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { DraftOp, GroupInfo } from '../../authoring/types';
import { PHI_FIELDS, type PhiField } from '../../manifest/schema';
import type { RoleDraft, SpecReading } from './specView';

const PHI_LABELS: Record<PhiField, string> = {
  name: 'Name',
  dob: 'Date of birth',
  gender: 'Sex',
  mrn: 'MRN',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
};

/**
 * Who may open the app and what each role sees of the patient's identity. Form-first on purpose:
 * access is where a slip costs most, so it is spelled out as checkboxes and pickers rather than
 * left to a sentence in the chat. Every change is one PATCH operation; the API applies the same
 * rules as the assistant's tools (an "existing" group must exist in the hospital's user pool).
 */
export function RolesEditor({
  reading,
  groups,
  readOnly,
  onPatch,
}: {
  reading: SpecReading;
  /** Existing hospital groups a role may bind to; null while loading. */
  groups: readonly GroupInfo[] | null;
  readOnly: boolean;
  onPatch: (ops: DraftOp[]) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        A role is a group of people and what they may see. Each role gets its own group (<code>app-&lt;app id&gt;-&lt;role&gt;</code>) when the app is
        published, or is granted to an existing hospital group. Identity fields not ticked are masked for that role.
      </Text>

      {reading.roles.length === 0 && !adding && (
        <Paper withBorder p="md">
          <Text size="sm" c="dimmed">
            No roles yet. Add the people who will use the app — start with the least privileged.
          </Text>
        </Paper>
      )}

      {reading.roles.map((role) => (
        <RoleCard key={role.id} role={role} roles={reading.roles} isDefault={reading.default_role === role.id} groups={groups} readOnly={readOnly} onPatch={onPatch} />
      ))}

      {adding ? (
        <NewRoleForm
          existingIds={reading.roles.map((r) => r.id)}
          onCancel={() => setAdding(false)}
          onAdd={async (role) => {
            const ok = await onPatch([{ op: 'add_role', args: { role } }]);
            if (ok) setAdding(false);
            return ok;
          }}
        />
      ) : (
        !readOnly && (
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} w="fit-content" data-testid="add-role">
            Add a role
          </Button>
        )
      )}
    </Stack>
  );
}

function RoleCard({
  role,
  roles,
  isDefault,
  groups,
  readOnly,
  onPatch,
}: {
  role: RoleDraft;
  roles: readonly RoleDraft[];
  isDefault: boolean;
  groups: readonly GroupInfo[] | null;
  readOnly: boolean;
  onPatch: (ops: DraftOp[]) => Promise<boolean>;
}) {
  const update = (patch: Record<string, unknown>) => onPatch([{ op: 'update_role', args: { id: role.id, patch } }]);
  const others = roles.filter((r) => r.id !== role.id);
  const groupOptions = (groups ?? []).map((g) => ({ value: g.name, label: g.description ? `${g.name} — ${g.description}` : g.name }));
  const boundName = role.group.kind === 'existing' ? role.group.name : null;
  if (boundName && !groupOptions.some((o) => o.value === boundName)) groupOptions.push({ value: boundName, label: boundName });

  return (
    <Paper withBorder p="md" data-testid={`role-${role.id}`}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <div>
            <Group gap="xs" align="baseline">
              <Text fw={600}>{role.display_name || role.id}</Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {role.id}
              </Text>
              {isDefault && (
                <Badge size="xs" color="ink" tt="none">
                  default role
                </Badge>
              )}
            </Group>
            {role.inherits && (
              <Text size="xs" c="dimmed">
                extends {role.inherits}
              </Text>
            )}
          </div>
          {!readOnly && (
            <Tooltip label="Remove this role">
              <ActionIcon variant="subtle" color="red" aria-label={`Remove role ${role.id}`} onClick={() => void onPatch([{ op: 'remove_role', args: { id: role.id } }])}>
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>

        <TextInput
          label="Display name"
          withAsterisk
          size="xs"
          defaultValue={role.display_name}
          disabled={readOnly}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== role.display_name) void update({ display_name: v });
          }}
        />

        <Checkbox.Group
          label="Patient identity this role may see"
          description="Everything not ticked is masked."
          value={[...role.phi_fields_visible]}
          onChange={(v) => void update({ phi_fields_visible: v })}
        >
          <Group gap="sm" mt={6}>
            {PHI_FIELDS.map((f) => (
              <Checkbox key={f} value={f} label={PHI_LABELS[f]} size="xs" disabled={readOnly} />
            ))}
          </Group>
        </Checkbox.Group>

        <Radio.Group
          label="Who is in this role"
          value={role.group.kind}
          onChange={(v) => {
            if (v === 'app_group') void update({ group: { kind: 'app_group' } });
            else if (groupOptions[0]) void update({ group: { kind: 'existing', name: groupOptions[0].value } });
          }}
        >
          <Stack gap={6} mt={6}>
            <Radio value="app_group" label="A group created for this app when it is published" size="xs" disabled={readOnly} />
            <Radio value="existing" label="An existing hospital group" size="xs" disabled={readOnly || (groups !== null && groupOptions.length === 0)} />
          </Stack>
        </Radio.Group>
        {role.group.kind === 'existing' && (
          <Select
            size="xs"
            label="Hospital group"
            data={groupOptions}
            value={boundName}
            onChange={(v) => v && void update({ group: { kind: 'existing', name: v } })}
            disabled={readOnly}
            searchable
            allowDeselect={false}
            w={360}
          />
        )}
        {groups !== null && groups.length === 0 && (
          <Text size="xs" c="dimmed">
            This hospital has no other groups to bind to yet; roles get their own app group.
          </Text>
        )}

        <TagsInput
          size="xs"
          label="Capabilities"
          description="Declarative labels the app may use (view, record_assessment, export_pdf, …); the most capable role wins when a person holds several. Data access is the scope, not these."
          value={[...role.capabilities]}
          onChange={(v) => void update({ capabilities: v.map((c) => c.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')).filter(Boolean) })}
          disabled={readOnly}
          splitChars={[',', ' ']}
        />

        <Group gap="md" align="flex-end">
          <Select
            size="xs"
            label="Extends"
            description="Another role whose data access this one includes"
            data={others.map((r) => ({ value: r.id, label: r.display_name || r.id }))}
            value={role.inherits ?? null}
            placeholder="none"
            onChange={(v) => void update({ inherits: v ?? null })}
            disabled={readOnly || others.length === 0}
            clearable
            w={260}
          />
          {!isDefault && !readOnly && (
            <Button size="xs" variant="default" onClick={() => void onPatch([{ op: 'set_default_role', args: { id: role.id } }])}>
              Make default role
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

function NewRoleForm({ existingIds, onAdd, onCancel }: { existingIds: readonly string[]; onAdd: (role: Record<string, unknown>) => Promise<boolean>; onCancel: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [phi, setPhi] = useState<string[]>(['name', 'dob', 'mrn']);
  const [problem, setProblem] = useState<string | null>(null);

  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '');
  const effectiveId = idTouched ? id : slug(displayName);

  async function submit() {
    if (!displayName.trim()) return setProblem('A display name is needed.');
    if (!/^[a-z][a-z0-9_]*$/.test(effectiveId)) return setProblem('The id must be a lowercase identifier (a-z, 0-9, _).');
    if (existingIds.includes(effectiveId)) return setProblem(`There is already a role "${effectiveId}".`);
    setProblem(null);
    await onAdd({ id: effectiveId, display_name: displayName.trim(), phi_fields_visible: phi });
  }

  return (
    <Paper withBorder p="md" style={{ borderStyle: 'dashed' }} data-testid="new-role">
      <Stack gap="sm">
        <Text fw={600} size="sm">
          New role
        </Text>
        <Group gap="md" grow>
          <TextInput label="Display name" withAsterisk size="xs" placeholder="e.g. Diabetes clinician" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} data-autofocus />
          <TextInput
            label="Id"
            withAsterisk
            size="xs"
            value={effectiveId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.currentTarget.value);
            }}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
        </Group>
        <Checkbox.Group label="Patient identity this role may see" value={phi} onChange={setPhi}>
          <Group gap="sm" mt={6}>
            {PHI_FIELDS.map((f) => (
              <Checkbox key={f} value={f} label={PHI_LABELS[f]} size="xs" />
            ))}
          </Group>
        </Checkbox.Group>
        {problem && (
          <Text size="xs" c="red">
            {problem}
          </Text>
        )}
        <Group gap="xs">
          <Button size="xs" onClick={() => void submit()}>
            Add role
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
