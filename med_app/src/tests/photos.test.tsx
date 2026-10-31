import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { compileSpec } from '../spec';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import type { AuditRecord } from '../primitives/data/types';
import { prepareImage } from '../primitives/ui/Photos';
import { renderManifest } from './testUtils';

/**
 * Photo documentation end to end in the renderer: the gallery shows the patient's photos newest first and opens one
 * with its details; the form refuses a file that is not an image and a photo dated too far back, then records a
 * PNG through the action → write primitive → reload path, and the gallery shows it with its remark.
 */

// A variable, not a literal: Vite would otherwise rewrite the URL into an asset import.
const page = '../../specs/composed-wound-photos.yaml';

// The smallest valid PNG there is (1×1, transparent) — 70 bytes.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngFile = (name = 'heel.png') => new File([Uint8Array.from(atob(PNG_1X1), (c) => c.charCodeAt(0))], name, { type: 'image/png' });

async function mount(role: string, context: Record<string, unknown>) {
  const result = compileSpec(parseYaml(readFileSync(new URL(page, import.meta.url), 'utf8')), { hospital_id: 'hsp-test', created_at: '2026-09-15T09:00:00Z' });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const audit: AuditRecord[] = [];
  await renderManifest(result.manifest, { role, context, executor: new MockPrimitiveExecutor(undefined, new Date(), 0), onAudit: (r) => audit.push(r) });
  return { audit };
}

/** Mantine's Select in jsdom: the dropdown never leaves display:none, so pick the option inside the listbox the input points at. */
function pick(select: HTMLElement, text: string) {
  fireEvent.click(select);
  const listbox = document.getElementById(select.getAttribute('aria-controls') ?? '');
  if (!listbox) throw new Error('no listbox');
  fireEvent.click(within(listbox).getByText(text));
}

const localDaysAgo = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('prepareImage', () => {
  it('reads a file to base64 with its type and decoded size; without a drawable canvas (jsdom) the bytes are the original', async () => {
    const picked = await prepareImage(pngFile());
    expect(picked.contentType).toBe('image/png');
    expect(picked.data).toBe(PNG_1X1);
    expect(picked.size).toBe(70);
    expect(picked.preview.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('the photo gallery', () => {
  it('shows the wound photos newest first and opens one with body site, date, operator and remark', async () => {
    await mount('wound_nurse', { patient_id: 'pat-kms-0001' });
    const gallery = await screen.findByTestId('photo-gallery');
    expect(within(gallery).getByTestId('photo-count')).toHaveTextContent('2 photos');
    const thumbs = within(gallery).getAllByTestId(/^photo-thumb-/).map((t) => t.getAttribute('data-testid'));
    expect(thumbs).toEqual(['photo-thumb-media-kms-0002', 'photo-thumb-media-kms-0001']); // day 14 before day 0
    expect(within(gallery).getByTestId('photo-thumb-media-kms-0001')).toHaveTextContent('Left heel');
    expect(within(gallery).getByTestId('photo-thumb-media-kms-0001').querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/); // inline bytes: the seed has no store

    fireEvent.click(within(gallery).getByTestId('photo-thumb-media-kms-0002'));
    const detail = await screen.findByTestId('photo-detail');
    expect(detail).toHaveTextContent('Left heel');
    expect(detail).toHaveTextContent('Dr. med. Lukas Hoffmann');
    expect(within(detail).getByTestId('photo-note')).toHaveTextContent('day 14, granulating');
  });

  it('shows nothing of other patients: Jonas has no photos', async () => {
    await mount('wound_nurse', { patient_id: 'pat-kms-0002' });
    const gallery = await screen.findByTestId('photo-gallery');
    expect(within(gallery).getByTestId('photo-count')).toHaveTextContent('0 photos');
    expect(gallery).toHaveTextContent('No photos on record.');
  });
});

describe('recording a photo', () => {
  it('refuses a file that is not an image and a photo dated beyond the window, then records a PNG the gallery shows', async () => {
    const { audit } = await mount('wound_nurse', { patient_id: 'pat-kms-0001' });
    const gallery = await screen.findByTestId('photo-gallery');
    const form = screen.getByTestId('photo-entry');
    const fileInput = within(form).getByTestId('photo-file');

    // Nothing chosen yet: the form asks for both before it validates anything else.
    fireEvent.click(within(form).getByTestId('entry-submit'));
    expect(await screen.findByTestId('entry-problems')).toHaveTextContent('choose what the photo documents');
    expect(screen.getByTestId('entry-problems')).toHaveTextContent('take or choose a photo');

    // A text file dressed as a photo.
    fireEvent.change(fileInput, { target: { files: [new File(['not a picture'], 'notes.txt', { type: 'text/plain' })] } });
    await screen.findByTestId('photo-preview');
    pick(within(form).getByTestId('photo-kind'), 'Pressure ulcer');
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await waitFor(() => expect(screen.getByTestId('entry-problems')).toHaveTextContent("content type 'text/plain' is not one of image/jpeg, image/png, image/webp"));
    expect(audit.filter((a) => a.primitive_id === 'p_new_photo')).toHaveLength(0);

    // A real PNG, but dated ten days back on a form that allows seven.
    fireEvent.change(fileInput, { target: { files: [pngFile()] } });
    await waitFor(() => expect(within(form).getByTestId('photo-preview')).toHaveTextContent('PNG'));
    fireEvent.change(within(form).getByTestId('photo-taken'), { target: { value: localDaysAgo(10) } });
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await waitFor(() => expect(screen.getByTestId('entry-problems')).toHaveTextContent('taken date must not be more than 7 days ago'));

    // Dated yesterday, with the body site and a remark: saved, audited, shown.
    fireEvent.change(within(form).getByTestId('photo-taken'), { target: { value: localDaysAgo(1) } });
    fireEvent.change(within(form).getByTestId('photo-site'), { target: { value: 'Sacrum' } });
    fireEvent.change(within(form).getByTestId('photo-note-input'), { target: { value: 'Category 2, 3 × 2 cm.' } });
    fireEvent.click(within(form).getByTestId('entry-submit'));
    await screen.findByTestId('action-saved', {}, { timeout: 4000 });
    expect(screen.getByTestId('action-saved')).toHaveTextContent('The photo is part of the patient record.');
    await waitFor(() => expect(within(gallery).getByTestId('photo-count')).toHaveTextContent('3 photos'), { timeout: 4000 });
    const newest = within(gallery).getAllByTestId(/^photo-thumb-/)[0]!;
    expect(newest).toHaveTextContent('Pressure ulcer');
    expect(newest).toHaveTextContent('Sacrum');
    expect(audit.find((a) => a.primitive_id === 'p_new_photo')?.detail).toMatch(/^Media\/media-mock-/);

    fireEvent.click(newest);
    const detail = await screen.findByTestId('photo-detail');
    expect(within(detail).getByTestId('photo-note')).toHaveTextContent('Category 2, 3 × 2 cm.');
    expect(detail).toHaveTextContent('0 KB'); // 70 bytes round to 0 KB — the size is shown, however small
  });
});
