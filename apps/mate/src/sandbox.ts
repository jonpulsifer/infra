/** What a turn streams to a surface, and what a prompt comes back with. */
import type { ToolCall } from './surface.ts';

// `status` and `tool` carry the same news two ways; each surface shows the
// one it can.
export type Update =
  | { kind: 'text'; delta: string }
  | { kind: 'status'; line: string | null }
  | { kind: 'tool'; call: ToolCall };

export interface PromptSink {
  update(update: Update): void;
}

export type StopReason = 'end_turn' | 'cancelled' | 'error';

export interface PromptResult {
  stopReason: StopReason;
  error?: string;
  /** Milliseconds from the prompt to the first streamed text, when any arrived. */
  firstTokenMs?: number | null;
  /** pi's catalog price, summed over the run, in USD. */
  costUsd?: number | null;
  /** The brain set the thread's memory aside; the next prompt carries the transcript. */
  reset?: boolean;
  /** Why ChatGPT did not answer, said once per outage after the answer. */
  notice?: string | null;
}
