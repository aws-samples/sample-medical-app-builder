import { useMemo, useState } from 'react';
import type { Media } from '@medplum/fhirtypes';
import { formatDate, formatDateTime } from '@medplum/core';
import { Alert, Badge, Button, FileButton, Group, Image, List, Modal, Paper, Select, SimpleGrid, Stack, Text, TextInput, Textarea, Title, UnstyledButton } from '@mantine/core';
import { useRenderContext } from '../../renderer/RenderContext';
import { PHOTO_SYSTEM } from '../data/mock/seed';
import { decodedImageSize, humanSize, IMAGE_TYPES, validateMediaEntry } from '../data/writes';
import { ActionForm } from './ActionForm';
import { KEEP_WHOLE } from './badgeStyles';

/**
 * Photo documentation: a wound today, the same wound in two weeks. A photo is a FHIR Media — who took it, when, what it
 * documents (the ward's own kinds, `urn:medapp:photo`), the body site, a remark — whose bytes the platform keeps in its
 * media bucket; the record points at them and the dispatcher hands the panel a short-lived URL to load. Two faces: the
 * gallery (thumbnails, newest first; one opens full size with its details) and the form that takes a photo with the
 * device's camera or picks one, downscales it in the browser, and records it through an action.
 */

const MEDIA_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/media-type';
/** Longest edge after downscaling — plenty for a wound on a phone screen, well within the form's size limit as JPEG. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

/** What the browser can load for a Media: the URL the dispatcher presented, or the inline bytes of a mock/seed photo. */
export function photoSrc(m: Media): string | undefined {
  const c = m.content;
  if (!c) return undefined;
  if (c.url && /^(https?:|data:|blob:)/.test(c.url)) return c.url;
  if (c.data) return `data:${c.contentType ?? 'image/jpeg'};base64,${c.data}`;
  return undefined;
}

const kindOf = (m: Media): string => m.reasonCode?.[0]?.text ?? m.reasonCode?.[0]?.coding?.[0]?.display ?? 'Photo';
const takenAt = (m: Media): string | undefined => m.createdDateTime ?? m.content?.creation ?? m.issued;

export interface PhotoGalleryProps {
  readonly media?: readonly Media[];
  readonly title?: string;
  readonly max_rows?: number;
}

export function PhotoGallery({ media = [], title = 'Photos', max_rows }: PhotoGalleryProps) {
  const [open, setOpen] = useState<Media | null>(null);
  const shown = max_rows ? media.slice(0, max_rows) : media;
  return (
    <Paper withBorder p="md" data-testid="photo-gallery">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Title order={4}>{title}</Title>
          <Text size="sm" c="dimmed" data-testid="photo-count">
            {media.length} {media.length === 1 ? 'photo' : 'photos'}
          </Text>
        </Group>
        {shown.length === 0 ? (
          <Text size="sm" c="dimmed">
            No photos on record.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="sm">
            {shown.map((m) => (
              <UnstyledButton key={m.id} onClick={() => setOpen(m)} aria-label={`Open ${kindOf(m)}`} data-testid={`photo-thumb-${m.id}`} style={{ display: 'block' }}>
                <Stack gap={4}>
                  <Image src={photoSrc(m)} alt={m.content?.title ?? kindOf(m)} radius="sm" h={120} fit="cover" fallbackSrc="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='4' height='3'/>" />
                  <Text size="sm" fw={500} lineClamp={1}>
                    {kindOf(m)}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {[m.bodySite?.text, takenAt(m) ? formatDate(takenAt(m)) : undefined].filter(Boolean).join(' · ')}
                  </Text>
                </Stack>
              </UnstyledButton>
            ))}
          </SimpleGrid>
        )}
      </Stack>
      <Modal opened={open !== null} onClose={() => setOpen(null)} title={open ? kindOf(open) : ''} size="xl" centered>
        {open && (
          <Stack gap="sm" data-testid="photo-detail">
            <Image src={photoSrc(open)} alt={open.content?.title ?? kindOf(open)} radius="sm" fit="contain" mah="70vh" />
            <Group gap="md" wrap="wrap">
              {open.bodySite?.text && (
                <Badge variant="light" tt="none" styles={KEEP_WHOLE}>
                  {open.bodySite.text}
                </Badge>
              )}
              {takenAt(open) && (
                <Text size="sm" className="ds-tabular">
                  Taken {formatDateTime(takenAt(open))}
                </Text>
              )}
              {open.operator?.display && (
                <Text size="sm" c="dimmed">
                  by {open.operator.display}
                </Text>
              )}
              {open.content?.size !== undefined && (
                <Text size="sm" c="dimmed">
                  {humanSize(open.content.size)}
                </Text>
              )}
            </Group>
            {open.note?.map((n, i) => (
              <Text key={i} size="sm" data-testid="photo-note">
                {n.text}
              </Text>
            ))}
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

export interface PhotoEntryFormProps {
  readonly action: string;
  readonly state_key?: string;
  readonly title?: string;
  readonly submit_label?: string;
  readonly kinds: readonly { code: string; display: string }[];
  readonly body_site?: boolean;
  readonly note?: boolean;
  readonly max_bytes?: number;
  readonly max_backdate_days?: number;
}

export function PhotoEntryForm({ action, state_key = 'photo_entry', title, submit_label = 'Save photo', kinds, body_site = true, note = true, max_bytes = 1_500_000, max_backdate_days = 30 }: PhotoEntryFormProps) {
  return (
    <ActionForm action={action} title={title ?? 'Add a photo'} subtitle="Taken with this device or chosen from it; downscaled here, stored encrypted by the platform, kept in the patient record." another_label="Add another" testid="photo-entry">
      {({ formKey, running, submit }) => <PhotoFields key={formKey} kinds={kinds} bodySite={body_site} note={note} maxBytes={max_bytes} maxBackdateDays={max_backdate_days} running={running} submitLabel={submit_label} onSubmit={(m) => submit({ [state_key]: m })} />}
    </ActionForm>
  );
}

interface Picked {
  readonly contentType: string;
  readonly data: string;
  readonly size: number;
  readonly preview: string;
  readonly name: string;
}

/** The file as base64 after a best-effort downscale: longest edge ≤ MAX_EDGE as JPEG where the browser can draw it; the original bytes otherwise (jsdom, odd formats). */
export async function prepareImage(file: Blob & { name?: string }): Promise<Picked> {
  let blob: Blob = file;
  try {
    if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
        if (out && (scale < 1 || out.size < file.size)) blob = out;
      }
      bitmap.close();
    }
  } catch {
    blob = file; // not drawable here: send what was chosen, the size check still applies
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(',');
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
  const contentType = blob.type || file.type || 'image/jpeg';
  return { contentType, data, size: decodedImageSize(data) ?? blob.size, preview: dataUrl, name: file.name ?? 'photo' };
}

function PhotoFields({ kinds, bodySite, note, maxBytes, maxBackdateDays, running, submitLabel, onSubmit }: { kinds: readonly { code: string; display: string }[]; bodySite: boolean; note: boolean; maxBytes: number; maxBackdateDays: number; running: boolean; submitLabel: string; onSubmit: (m: Media) => void }) {
  const { context } = useRenderContext();
  const patientId = typeof context['patient_id'] === 'string' ? (context['patient_id'] as string) : undefined;
  const [kind, setKind] = useState<string | null>(kinds.length === 1 ? kinds[0]!.code : null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [site, setSite] = useState('');
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const rules = useMemo(() => ({ kinds: kinds.map((k) => `${PHOTO_SYSTEM}|${k.code}`), body_site: bodySite, max_bytes: maxBytes, max_backdate_days: maxBackdateDays }), [kinds, bodySite, maxBytes, maxBackdateDays]);

  async function choose(file: File | null) {
    if (!file) return;
    setPreparing(true);
    setProblems([]);
    try {
      setPicked(await prepareImage(file));
    } catch (e) {
      setProblems([`the file could not be read: ${(e as Error).message ?? e}`]);
    } finally {
      setPreparing(false);
    }
  }

  function build(): Media {
    const chosen = kinds.find((k) => k.code === kind);
    const taken = when ? new Date(when).toISOString() : undefined;
    return {
      resourceType: 'Media',
      identifier: [{ system: 'urn:medapp:submission', value: crypto.randomUUID() }],
      status: 'completed',
      type: { coding: [{ system: MEDIA_TYPE_SYSTEM, code: 'photo', display: 'Photo' }] },
      reasonCode: chosen ? [{ coding: [{ system: PHOTO_SYSTEM, code: chosen.code, display: chosen.display }], text: chosen.display }] : [],
      subject: patientId ? { reference: `Patient/${patientId}` } : {},
      ...(taken ? { createdDateTime: taken } : {}),
      ...(bodySite && site.trim() ? { bodySite: { text: site.trim() } } : {}),
      ...(note && text.trim() ? { note: [{ text: text.trim() }] } : {}),
      content: { contentType: picked?.contentType ?? '', data: picked?.data ?? '', title: [chosen?.display, site.trim() || undefined].filter(Boolean).join(' · ') || undefined },
    };
  }

  function trySubmit() {
    const found: string[] = [];
    if (!kind) found.push('choose what the photo documents');
    if (!picked) found.push('take or choose a photo');
    if (found.length === 0) found.push(...validateMediaEntry(rules, build(), patientId ?? '', new Date()));
    setProblems(found);
    if (found.length === 0) onSubmit(build());
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-start" wrap="wrap">
        <Stack gap={6} style={{ flex: 'none' }}>
          <FileButton onChange={choose} accept={IMAGE_TYPES.join(',')} capture="environment" disabled={running || preparing} inputProps={{ 'data-testid': 'photo-file' } as never}>
            {(props) => (
              <Button {...props} variant="light" loading={preparing} data-testid="photo-choose">
                {picked ? 'Replace photo' : 'Take or choose a photo'}
              </Button>
            )}
          </FileButton>
          {picked ? (
            <Stack gap={2} data-testid="photo-preview">
              <Image src={picked.preview} alt="Chosen photo" radius="sm" w={160} h={120} fit="cover" />
              <Text size="xs" c="dimmed">
                {humanSize(picked.size)} · {picked.contentType.replace('image/', '').toUpperCase()}
              </Text>
            </Stack>
          ) : (
            <Text size="xs" c="dimmed" maw={200}>
              Up to {humanSize(maxBytes)} after downscaling.
            </Text>
          )}
        </Stack>
        <Stack gap="sm" style={{ flex: 1, minWidth: 240 }}>
          <Select label="What it documents" placeholder="Choose…" data={kinds.map((k) => ({ value: k.code, label: k.display }))} value={kind} onChange={setKind} searchable required disabled={running} data-testid="photo-kind" />
          <Group gap="md" align="flex-end" wrap="wrap">
            {bodySite && <TextInput label="Body site" placeholder="e.g. left heel" value={site} onChange={(e) => setSite(e.currentTarget.value)} maxLength={120} disabled={running} style={{ flex: 1, minWidth: 180 }} data-testid="photo-site" />}
            <TextInput type="datetime-local" label="Taken (optional, now if empty)" value={when} onChange={(e) => setWhen(e.currentTarget.value)} w={230} disabled={running} data-testid="photo-taken" />
          </Group>
          {note && <Textarea label="Remark (optional)" value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={1} maxRows={3} maxLength={500} disabled={running} data-testid="photo-note-input" />}
        </Stack>
      </Group>
      {problems.length > 0 && (
        <Alert color="red" variant="light" title="Please check the entry" data-testid="entry-problems">
          <List size="sm">
            {problems.map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          The platform records who took it and when it was saved; the image never leaves the hospital's storage.
        </Text>
        <Button onClick={trySubmit} loading={running} disabled={preparing} style={{ flex: 'none' }} data-testid="entry-submit">
          {submitLabel}
        </Button>
      </Group>
    </Stack>
  );
}
