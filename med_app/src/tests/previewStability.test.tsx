import { describe, expect, it } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { AuthoringClient, DraftView } from '../authoring/types';
import { loadFixtureRegistry } from './fixtures';
import type { AppManifest } from '../manifest/schema';
import { useDraft } from '../panel/drafting/useDraft';
import { MockPrimitiveExecutor } from '../primitives/data/mock/mockExecutor';
import { SEED, SEED_ANCHOR } from '../primitives/data/mock/seed';
import type { AuditRecord } from '../primitives/data/types';
import { ManifestApp } from '../renderer/ManifestApp';
import { Providers, testConfig, testMedplum } from './testUtils';

/**
 * The composer's preview reloaded every few seconds and lost what was typed: while the agent worked, the page polled
 * the draft, each poll re-rendered the preview with a new-but-equal launch context, and the renderer took the new
 * object for a new context — re-ran the data plan, reset the bindings, remounted the form. Two guards, either of
 * which stops it: the renderer reads the context by content, and the draft hook keeps the same view for the same draft.
 */

const manifest = loadFixtureRegistry().find((e) => e.ok && e.manifest.metadata.app_id === 'app_htn_assessment')!;
if (!manifest.ok) throw new Error('fixture');
const assessment: AppManifest = manifest.manifest;

describe('the preview keeps its state', () => {
  it('an equal launch context in a new object neither re-runs the data plan nor remounts the form', async () => {
    const medplum = await testMedplum();
    const executor = new MockPrimitiveExecutor(SEED, SEED_ANCHOR, 0);
    const audit: AuditRecord[] = [];
    const identity = { sub: 'test-sub', idToken: 't', displayName: 'Nurse' };
    const app = (context: Record<string, unknown>) => (
      <Providers medplum={medplum}>
        <ManifestApp manifest={assessment} role="nurse" context={context} executor={executor} config={testConfig} identity={identity} onAudit={(r) => audit.push(r)} />
      </Providers>
    );
    const view = render(app({ patient_id: 'pat-kms-0001' }));
    await screen.findByTestId('assessment-form', {}, { timeout: 4000 });
    await waitFor(() => expect(audit.filter((r) => r.kind.startsWith('data.')).length).toBeGreaterThan(0));
    const runs = audit.length;

    // Type into the form, then re-render with a new object of the same content — as the drafting page does on every poll.
    const notes = (await screen.findAllByRole('textbox'))[0]!;
    fireEvent.change(notes, { target: { value: 'half-written note' } });
    expect((notes as HTMLTextAreaElement | HTMLInputElement).value).toBe('half-written note');
    view.rerender(app({ patient_id: 'pat-kms-0001' }));
    view.rerender(app({ patient_id: 'pat-kms-0001' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(audit.length).toBe(runs); // no data primitive ran again
    expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement | HTMLInputElement).value).toBe('half-written note'); // the form is the same form

    // A different context is a different app run.
    view.rerender(app({ patient_id: 'pat-kms-0003' }));
    await waitFor(() => expect(audit.length).toBeGreaterThan(runs));
  }, 15000);

  it('the draft hook hands back the same view object while polls bring the same draft', async () => {
    const draft: DraftView = {
      session_id: 's1',
      title: 'HbA1c',
      spec: { apiVersion: 'medapp.eu/v1', kind: 'AppSpec', archetype: 'APP-02' },
      open: [],
      refusals: [],
      transcript: [{ role: 'user', text: 'HbA1c over five years' }],
      turn: { id: 't1', status: 'running', message: 'HbA1c over five years', progress: [] },
      saved_as: null,
      iterates: null,
      created_at: 't',
      updated_at: 't',
    } as unknown as DraftView;
    let fetches = 0;
    const client = {
      kind: 'local',
      pollIntervalMs: 5,
      getDraft: async () => {
        fetches += 1;
        return JSON.parse(JSON.stringify(draft)) as DraftView; // a fresh object every time, as a fetch would be
      },
    } as unknown as AuthoringClient;
    const { result } = renderHook(() => useDraft(client, 's1'));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const first = result.current.view;
    await waitFor(() => expect(fetches).toBeGreaterThan(3)); // the poll is running
    expect(result.current.view).toBe(first); // and the view did not change identity
    expect(result.current.busy).toBe(true);
  });
});
