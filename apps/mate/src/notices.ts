/**
 * Every line mate posts that is not an answer, kept together so the transcript
 * replay can leave them out of the history a fresh harness is handed.
 */
import { NO_REPLY, STOPPED } from './reply.ts';
import type { MintStep } from './sandbox.ts';

export const SANDBOX_CLOSED = '💤 sandbox closed — reply to pick this back up';
export const RESTARTED =
  '🔄 mate restarted mid-turn, so that answer is lost — ask again';
export const WAITING = '⏳ waiting for a free sandbox';
export const STOPPED_WAITING =
  '💤 gave up waiting for a sandbox — reply to try again';
export const MINT_FAILED = "⚠️ couldn't start a sandbox";
export const ATTACH_FAILED =
  "⚠️ the sandbox started but the agent didn't answer";
export const SANDBOX_DIED = '⚠️ the sandbox died mid-turn';
export const HARNESS_FAILED = '⚠️ the agent hit an error';
export const UNDELIVERED = "⚠️ couldn't deliver the reply";
export const THREAD_SPENT = '🛑 this thread has used its';
export const DAY_SPENT = '🛑 the daily budget of';
export const NEVER_STARTED =
  '🔄 mate restarted before this could start — ask again';

export const MINT_STEPS: Record<MintStep, string> = {
  reusing: "⏳ waking this thread's sandbox",
  adopting: '⏳ grabbing a warm sandbox',
  refreshing: '⏳ updating its checkout',
  creating: '⏳ asking for a sandbox',
  booting: '⏳ booting a sandbox and cloning the repo',
};

export const ATTACHING = '🔌 connecting to the agent';

const PREFIXES: readonly string[] = [
  SANDBOX_CLOSED,
  RESTARTED,
  NEVER_STARTED,
  WAITING,
  ATTACHING,
  // Spread, so a new mint step is filtered too.
  ...Object.values(MINT_STEPS),
  STOPPED_WAITING,
  MINT_FAILED,
  ATTACH_FAILED,
  SANDBOX_DIED,
  HARNESS_FAILED,
  UNDELIVERED,
  THREAD_SPENT,
  DAY_SPENT,
  NO_REPLY,
  STOPPED,
];

export function isNotice(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  return PREFIXES.some((prefix) => text.startsWith(prefix));
}
