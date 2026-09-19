/**
 * Every line mate posts that is not an answer. They live together because the
 * transcript replay has to tell them apart from mate's own replies: a fresh
 * harness is handed the thread's history, and mate's own bookkeeping is not
 * part of the conversation.
 */
import { NO_REPLY, PLACEHOLDER } from './reply.ts';

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

const PREFIXES: readonly string[] = [
  SANDBOX_CLOSED,
  RESTARTED,
  WAITING,
  STOPPED_WAITING,
  MINT_FAILED,
  ATTACH_FAILED,
  SANDBOX_DIED,
  HARNESS_FAILED,
  UNDELIVERED,
  THREAD_SPENT,
  DAY_SPENT,
  NO_REPLY,
];

export function isNotice(content: string): boolean {
  const text = content.trim();
  if (!text || text === PLACEHOLDER) return true;
  return PREFIXES.some((prefix) => text.startsWith(prefix));
}
