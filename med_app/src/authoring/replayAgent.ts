import type { DraftOp } from './types';
import type { LocalAgent, LocalAgentOutput } from './localClient';

/**
 * A drafting assistant that replays a recorded session — the model's own replies, the tools it called and the operations
 * those calls made — turn by turn, whatever is typed. It exists so the drafting page can be seen (the README's video) and
 * developed without a Bedrock connection: `VITE_AGENT_MODE=replay` in mock mode wires it in (src/App.tsx). It is not the
 * assistant: nothing here reads the message, and the script ends.
 */

export interface ReplayTurn {
  /** What the clinician said in the recorded session — shown nowhere; a hint for whoever drives the replay. */
  readonly user: string;
  /** The tools the assistant called in this turn, read-only ones included — the turn's progress steps. */
  readonly tool_calls?: readonly string[];
  /** What those calls did to the draft. */
  readonly ops?: readonly DraftOp[];
  /** The assistant's reply, verbatim. */
  readonly reply: string;
}

export interface ReplayScript {
  readonly title: string;
  readonly note?: string;
  readonly turns: readonly ReplayTurn[];
}

export const REPLAY_ENDED = 'That is the end of the recorded session. This is a replay — the drafting assistant itself runs on Amazon Bedrock in a deployed environment.';

/** The next turn of the script on every call; past its end, a note. */
export function replayAgent(script: ReplayScript): LocalAgent {
  let index = 0;
  return (): LocalAgentOutput => {
    const turn = script.turns[index];
    if (!turn) return { reply: REPLAY_ENDED };
    index += 1;
    return { reply: turn.reply, ops: turn.ops, tool_calls: turn.tool_calls };
  };
}
