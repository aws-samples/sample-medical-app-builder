import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Group, Paper, Stack, Text, Textarea, TextInput, ThemeIcon, Title } from '@mantine/core';
import { IconFolders, IconPlus, IconTrash } from '@tabler/icons-react';
import { CollectionsApiError, type Collection, type CollectionsClient } from '../collections';
import type { AppManifest } from '../manifest/schema';

/**
 * Curating the hospital's collections — approvers and admins. One list; a collection opens as a form: name, a line of
 * description, and the published apps as check boxes. Changes gather in the form and leave in one request when
 * "Save" is pressed; nothing is written per tick. Deleting asks in place.
 */

export interface CollectableApp {
  readonly app_id: string;
  readonly name: string;
  readonly description?: string;
}

export function collectableApps(manifests: readonly AppManifest[]): CollectableApp[] {
  return manifests.map((m) => ({ app_id: m.metadata.app_id, name: m.metadata.name, ...(m.metadata.description ? { description: m.metadata.description } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
}

function errorMessage(e: unknown): string {
  if (e instanceof CollectionsApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

type Mode = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; collection: Collection };

export function CollectionsDrawer({
  opened,
  onClose,
  client,
  collections,
  apps,
  onChanged,
}: {
  opened: boolean;
  onClose: () => void;
  client: CollectionsClient;
  collections: readonly Collection[];
  /** The published apps a collection may name. */
  apps: readonly CollectableApp[];
  onChanged: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      setMode({ kind: 'list' });
      setConfirmDelete(null);
      setError(null);
      setNotice(null);
    }
  }, [opened]);

  async function remove(c: Collection) {
    setBusy(c.collection_id);
    setError(null);
    try {
      await client.remove(c.collection_id);
      setConfirmDelete(null);
      setNotice(`“${c.name}” is gone. Its apps are untouched.`);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title={mode.kind === 'list' ? 'Collections' : mode.kind === 'new' ? 'New collection' : `Edit “${mode.collection.name}”`}>
      <Stack gap="md" data-testid="collections-drawer">
        {mode.kind === 'list' && (
          <>
            {collections.length > 0 && (
              <Text size="sm" c="dimmed">
                A collection groups published apps for a clinic, a ward or a team, and shows up in everyone's launcher — each person seeing the apps of it they
                may open. Organisation only: no version moves, nothing is reviewed again.
              </Text>
            )}
            {notice && (
              <Alert color="clinical" variant="light" withCloseButton onClose={() => setNotice(null)} data-testid="collections-notice">
                {notice}
              </Alert>
            )}
            {error && (
              <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} data-testid="collections-error">
                {error}
              </Alert>
            )}
            {collections.length > 0 && (
              <Button size="sm" leftSection={<IconPlus size={16} />} w="fit-content" onClick={() => setMode({ kind: 'new' })} data-testid="collection-new">
                New collection
              </Button>
            )}
            {collections.length === 0 ? (
              <Paper p="xl" radius="md" style={{ border: '1px dashed var(--ds-hairline)', background: 'var(--mantine-color-gray-0)' }} data-testid="collections-drawer-empty">
                <Stack align="center" gap="sm" ta="center">
                  <ThemeIcon size={44} radius="xl" variant="light" color="clinical">
                    <IconFolders size={22} stroke={1.6} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600}>No collections yet</Text>
                    <Text size="sm" c="dimmed" maw={380} mx="auto" mt={4}>
                      A collection groups published apps for a clinic, a ward or a team — “Hypertonie-Sprechstunde”, “Station 3 · Pflege” — and shows up in
                      everyone's launcher, each person seeing the apps of it they may open. Organisation only: no version moves, nothing is reviewed again.
                    </Text>
                  </div>
                  <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setMode({ kind: 'new' })} data-testid="collection-new">
                    Make the first one
                  </Button>
                </Stack>
              </Paper>
            ) : (
              <Stack gap="xs">
                {collections.map((c) => (
                  <Paper key={c.collection_id} withBorder p="sm" radius="md" data-testid={`collection-row-${c.collection_id}`}>
                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                      <div style={{ minWidth: 0 }}>
                        <Text fw={500}>{c.name}</Text>
                        <Text size="xs" c="dimmed">
                          {c.app_ids.length} {c.app_ids.length === 1 ? 'app' : 'apps'}
                          {c.description ? ` · ${c.description}` : ''}
                          {c.updated_by?.name || c.updated_by?.email ? ` · by ${c.updated_by.name ?? c.updated_by.email}` : ''}
                        </Text>
                      </div>
                      <Group gap="xs" wrap="nowrap">
                        <Button size="xs" variant="default" onClick={() => setMode({ kind: 'edit', collection: c })} data-testid={`collection-edit-${c.collection_id}`}>
                          Edit
                        </Button>
                        <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => setConfirmDelete(c.collection_id)} disabled={confirmDelete === c.collection_id} data-testid={`collection-delete-${c.collection_id}`}>
                          Delete
                        </Button>
                      </Group>
                    </Group>
                    {confirmDelete === c.collection_id && (
                      <Group gap="xs" mt="sm" data-testid="collection-delete-confirm">
                        <Text size="sm">Remove “{c.name}” from everyone's launcher? The apps stay published.</Text>
                        <Button size="xs" color="red" loading={busy === c.collection_id} onClick={() => void remove(c)} data-testid="collection-delete-yes">
                          Remove
                        </Button>
                        <Button size="xs" variant="default" onClick={() => setConfirmDelete(null)} data-testid="collection-delete-no">
                          Keep it
                        </Button>
                      </Group>
                    )}
                  </Paper>
                ))}
              </Stack>
            )}
          </>
        )}
        {mode.kind !== 'list' && (
          <CollectionForm
            client={client}
            apps={apps}
            existing={mode.kind === 'edit' ? mode.collection : undefined}
            onCancel={() => setMode({ kind: 'list' })}
            onSaved={async (c, created) => {
              setNotice(created ? `“${c.name}” is in everyone's launcher now.` : `“${c.name}” saved.`);
              setMode({ kind: 'list' });
              await onChanged();
            }}
          />
        )}
      </Stack>
    </Drawer>
  );
}

/** Name, description, the apps as check boxes — kept as pending changes until Save sends them in one request. */
function CollectionForm({ client, apps, existing, onCancel, onSaved }: { client: CollectionsClient; apps: readonly CollectableApp[]; existing?: Collection; onCancel: () => void; onSaved: (c: Collection, created: boolean) => void | Promise<void> }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [chosen, setChosen] = useState<string[]>(() => [...(existing?.app_ids ?? [])]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!existing) return true;
    return name.trim() !== existing.name || (description ?? '').trim() !== (existing.description ?? '') || JSON.stringify(chosen) !== JSON.stringify(existing.app_ids);
  }, [existing, name, description, chosen]);
  const pending = existing ? chosen.filter((a) => !existing.app_ids.includes(a)).length + existing.app_ids.filter((a) => !chosen.includes(a)).length : chosen.length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.update(existing.collection_id, { name: name.trim(), description: description.trim(), app_ids: chosen })
        : await client.create({ name: name.trim(), description: description.trim() || undefined, app_ids: chosen });
      await onSaved(saved, !existing);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="sm" data-testid="collection-form">
      <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Hypertonie-Sprechstunde" data-testid="collection-name" />
      <Textarea label="Description" description="One line: who this is for." value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={1} data-testid="collection-description" />
      <div>
        <Title order={6} mb={6}>
          Apps
        </Title>
        <Stack gap={6}>
          {apps.map((a) => (
            <Checkbox
              key={a.app_id}
              size="sm"
              color="clinical"
              checked={chosen.includes(a.app_id)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setChosen((prev) => (on ? [...prev, a.app_id] : prev.filter((x) => x !== a.app_id)));
              }}
              label={a.name}
              description={a.description}
              data-testid={`collection-app-${a.app_id}`}
            />
          ))}
          {apps.length === 0 && (
            <Text size="sm" c="dimmed">
              No published apps to choose from yet.
            </Text>
          )}
        </Stack>
      </div>
      {error && (
        <Alert color="red" variant="light" data-testid="collection-form-error">
          {error}
        </Alert>
      )}
      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed" data-testid="collection-pending">
          {existing ? (pending ? `${pending} app ${pending === 1 ? 'change' : 'changes'} pending` : dirty ? 'Unsaved changes' : 'No changes') : `${chosen.length} ${chosen.length === 1 ? 'app' : 'apps'}`}
        </Text>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={onCancel} disabled={saving} data-testid="collection-cancel">
            Cancel
          </Button>
          <Button size="xs" loading={saving} disabled={!name.trim() || !dirty} onClick={() => void save()} data-testid="collection-save">
            {existing ? 'Save changes' : 'Create collection'}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
