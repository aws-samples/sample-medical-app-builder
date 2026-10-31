import { useEffect, useRef, useState } from 'react';
import { Badge, Group, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import type { DraftOp } from '../../authoring/types';
import { ARCHETYPES } from '../../spec/archetypes';
import type { ArchetypeId } from '../../spec/archetype';
import type { SpecReading } from './specView';

/**
 * The kind of app and its name. Text fields commit a moment after typing stops and when focus leaves (a handful of
 * PATCHes per field, not one per keystroke, and the title follows while typing); the archetype commits at once —
 * changing it drops the archetype's settings, which the tabs then show as open. Required fields carry an asterisk; the
 * legend under the tabs says what it means.
 */
export function OverviewEditor({ reading, readOnly, iterating, onPatch }: { reading: SpecReading; readOnly: boolean; /** A new version of an existing app: the id is fixed. */ iterating: boolean; onPatch: (ops: DraftOp[]) => Promise<boolean> }) {
  const archetypes = (Object.keys(ARCHETYPES) as ArchetypeId[]).map((id) => ({ value: id, label: `${id} · ${ARCHETYPES[id].name}` }));

  return (
    <Stack gap="md">
      <Select
        label="Kind of app"
        withAsterisk
        description="An archetype from the catalog. The assistant proposes one from your description; you can change it here."
        data={archetypes}
        value={reading.archetype ?? null}
        placeholder="Not chosen yet"
        onChange={(v) => v && v !== reading.archetype && void onPatch([{ op: 'choose_archetype', args: { archetype: v, reason: 'chosen in the panel' } }])}
        disabled={readOnly}
        allowDeselect={false}
      />
      <CommitTextInput
        label="App name"
        required
        description="What clinicians see in their app list."
        value={reading.app.name ?? ''}
        placeholder="e.g. HbA1c over time"
        readOnly={readOnly}
        onCommit={(name) => onPatch([{ op: 'set_app', args: { name } }])}
      />
      <CommitTextInput
        label="App id"
        required
        description="Technical id, app_<slug>; it names the app's groups and cannot change after saving."
        value={reading.app.app_id ?? ''}
        placeholder="app_hba1c_trend"
        readOnly={readOnly || iterating || Boolean(reading.app.parent_version)}
        onCommit={(app_id) => onPatch([{ op: 'set_app', args: { app_id } }])}
        mono
      />
      <CommitTextInput
        label="Description"
        description="Optional. One or two sentences under the name in the app list."
        value={reading.app.description ?? ''}
        readOnly={readOnly}
        onCommit={(description) => onPatch([{ op: 'set_app', args: { description } }])}
        multiline
      />
      <Select
        label="Language of the display texts"
        description="Optional; English unless set."
        data={[
          { value: 'en', label: 'English' },
          { value: 'de', label: 'Deutsch' },
        ]}
        value={reading.app.language ?? 'en'}
        onChange={(v) => v && void onPatch([{ op: 'set_app', args: { language: v } }])}
        disabled={readOnly}
        allowDeselect={false}
        styles={{ wrapper: { maxWidth: 260 } }}
      />
      {(reading.app.version || reading.app.parent_version) && (
        <Group gap="xs">
          {reading.app.version && (
            <Badge variant="outline" color="ink" tt="none">
              v{reading.app.version}
            </Badge>
          )}
          {reading.app.parent_version && (
            <Text size="xs" c="dimmed">
              iterates on v{reading.app.parent_version}
            </Text>
          )}
        </Group>
      )}
    </Stack>
  );
}

/** How long typing may pause before the field commits what is there; focus leaving or Enter commits at once. */
const COMMIT_AFTER_MS = 700;

/**
 * A text field that keeps local state while typing and commits a moment after typing stops, when focus leaves, or on
 * Enter — so the title and the checklist follow what is typed without a request per keystroke. While the person is
 * typing, what comes back from the server does not overwrite the field (the first version did, and a slow answer could
 * swallow keystrokes). A required field emptied and left is kept at its previous value and says so: the spec has no
 * "unset", and a blank required field would only reappear as an open item.
 */
export function CommitTextInput({
  label,
  description,
  value,
  placeholder,
  readOnly,
  required,
  onCommit,
  multiline,
  mono,
}: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  readOnly: boolean;
  /** Marks the field with an asterisk; an emptied required field keeps its previous value. */
  required?: boolean;
  onCommit: (value: string) => Promise<boolean>;
  multiline?: boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [kept, setKept] = useState<string | null>(null);
  // What the person typed since the last commit; the server's value only replaces the field when nothing is pending.
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function commit(leaving: boolean) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { draft: typed, value: current, onCommit: send } = latest.current;
    const next = typed.trim();
    if (next === current.trim()) {
      dirty.current = false;
      return;
    }
    if (!next) {
      // Nothing to send for an empty field; when the person leaves it, the previous value comes back and the field says so.
      if (leaving && current) {
        dirty.current = false;
        setDraft(current);
        setKept(current);
      }
      return;
    }
    const ok = await send(next);
    if (latest.current.draft.trim() === next) dirty.current = false; // nothing typed meanwhile: the field is in sync again
    if (!ok && latest.current.draft.trim() === next) setDraft(latest.current.value);
  }

  function change(next: string) {
    dirty.current = true;
    setKept(null);
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(false), COMMIT_AFTER_MS);
  }

  const common = {
    label,
    description,
    value: draft,
    placeholder,
    disabled: readOnly,
    required,
    error: kept !== null ? `${required ? 'Required — ' : ''}kept “${kept}”; type a new value to replace it.` : undefined,
    onBlur: () => void commit(true),
    styles: mono ? { input: { fontFamily: 'var(--mantine-font-family-monospace)' } } : undefined,
  };
  return multiline ? (
    <Textarea {...common} autosize minRows={2} maxRows={5} onChange={(e) => change(e.currentTarget.value)} />
  ) : (
    <TextInput
      {...common}
      onChange={(e) => change(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}
