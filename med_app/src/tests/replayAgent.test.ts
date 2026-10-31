import { describe, expect, it } from 'vitest';
import { localAuthoringClient, LocalRegistryStore, REPLAY_ENDED, replayAgent, type ReplayScript } from '../authoring';
import script from '../authoring/replay/bp-trend.json';
import { compileSpec } from '../spec';

/**
 * The replay agent plays a recorded session back: each turn's operations land on the draft exactly as the recorded tool
 * calls did, the recorded reply comes back verbatim, the recorded tool calls are the turn's progress — and at the end the
 * draft compiles. So the README's video shows a real session, and the script stays a faithful one.
 */
describe('the replay agent', () => {
  const session = script as ReplayScript;

  it('answers the recorded turns in order and says so when they are over', async () => {
    const agent = replayAgent(session);
    const first = await agent({ spec: {}, transcript: [], message: 'anything' });
    expect(first.reply).toBe(session.turns[0]!.reply);
    expect(first.tool_calls).toEqual(['choose_archetype', 'lookup_codes', 'set_app', 'set_knobs']);
    await agent({ spec: {}, transcript: [], message: '' });
    await agent({ spec: {}, transcript: [], message: '' });
    expect((await agent({ spec: {}, transcript: [], message: 'more?' })).reply).toBe(REPLAY_ENDED);
  });

  it('drives the local drafting loop to a compiling draft, with the recorded tool calls as progress', async () => {
    const client = localAuthoringClient({ hospitalId: 'hsp-musterstadt', getCallerSub: () => 'sub-ada', registry: new LocalRegistryStore(), agent: replayAgent(session), turnDelayMs: 0 });
    const draft = await client.createDraft({});
    for (const turn of session.turns) {
      const started = await client.sendTurn(draft.session_id, turn.user);
      let state = started;
      for (let i = 0; i < 50 && state.status !== 'done' && state.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 5));
        state = (await client.getDraft(draft.session_id)).turn ?? state;
      }
      expect(state.status, state.error).toBe('done');
      expect(state.reply).toBe(turn.reply);
      expect(state.tool_calls).toEqual(turn.tool_calls);
    }
    const view = await client.getDraft(draft.session_id);
    expect(view.spec.archetype).toBe('APP-02');
    expect(view.spec.default_role).toBe('viewer');
    const compiled = compileSpec({ apiVersion: 'medapp.eu/v1', kind: 'AppSpec', ...view.spec }, { hospital_id: 'hsp-musterstadt', created_at: '2026-10-01T00:00:00Z' });
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  });
});
