/**
 * Every line mate posts that is not an answer. They live together because the
 * transcript replay has to tell them apart from mate's own replies: a fresh
 * harness is handed the thread's history, and mate's own bookkeeping is not
 * part of the conversation.
 */
import { NO_REPLY, PLACEHOLDER, STOPPED } from './reply.ts';
import type { MintStep } from './sandbox.ts';

export const SANDBOX_CLOSED = 'sandbox closed; message again to start fresh';
export const RESTARTED =
  'mate restarted, so the turn that was running is gone; ask again and it runs from the top';
export const WAITING = 'waiting for a sandbox';
export const STOPPED_WAITING =
  'stopped waiting for a sandbox; message again to start fresh';
export const MINT_FAILED = 'the sandbox did not start';
export const ATTACH_FAILED =
  'the sandbox started but the harness did not answer';
export const SANDBOX_DIED = 'the sandbox died mid-turn';
export const HARNESS_FAILED = 'the harness failed';
export const UNDELIVERED = 'the reply could not be delivered';
export const THREAD_SPENT = 'this thread has used its';
export const DAY_SPENT = 'the daily budget of';
export const NEVER_STARTED =
  'mate restarted before this could start; ask again and it runs from the top';

/**
 * What each step of a mint is, in the words of the human waiting on it. They
 * are the acknowledgment mate holds while a thread has nothing else to show:
 * `progress.ts` rewrites one line through them, and which of them a thread
 * sees is which wait it is paying — a fresh boot, its own sandbox waking, or
 * a warm one being handed over.
 */
export const MINT_STEPS: Record<MintStep, string> = {
  reusing: 'waking the sandbox this thread already has',
  adopting: 'taking a sandbox that was already warm',
  refreshing: 'bringing its checkout up to date',
  creating: 'asking for a sandbox',
  booting: 'booting the sandbox and cloning the repo',
};

/** The step after every mint, and the last thing said before the turn itself. */
export const ATTACHING = 'waking the agent';

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
  if (!text || text === PLACEHOLDER) return true;
  return PREFIXES.some((prefix) => text.startsWith(prefix));
}
