/**
 * Every line mate posts that is not an answer. They live together because the
 * transcript replay has to tell them apart from mate's own replies: a fresh
 * harness is handed the thread's history, and mate's own bookkeeping is not
 * part of the conversation.
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

/**
 * What each step of a mint is, in the words of the human waiting on it. They
 * are the acknowledgment mate holds while a thread has nothing else to show:
 * `progress.ts` rewrites one line through them, and which of them a thread
 * sees is which wait it is paying — a fresh boot, its own sandbox waking, or
 * a warm one being handed over.
 */
export const MINT_STEPS: Record<MintStep, string> = {
  reusing: "⏳ waking this thread's sandbox",
  adopting: '⏳ grabbing a warm sandbox',
  refreshing: '⏳ updating its checkout',
  creating: '⏳ asking for a sandbox',
  booting: '⏳ booting a sandbox and cloning the repo',
};

/** The step after every mint, and the last thing said before the turn itself. */
export const ATTACHING = '🔌 connecting to the agent';

const PREFIXES: readonly string[] = [
  SANDBOX_CLOSED,
  RESTARTED,
  NEVER_STARTED,
  WAITING,
  ATTACHING,
  // Spread rather than listed, so a step added to the mint cannot be left out
  // of the filter and read back to a fresh harness as something mate said.
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
