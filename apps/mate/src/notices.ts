/**
 * Every line mate posts that is not an answer, kept together so the transcript
 * replay can leave them out of the history a fresh session is handed. A line
 * mate no longer posts stays listed, since old threads still hold it.
 */
import type { MintStep } from './lease.ts';
import { NO_REPLY, STOPPED } from './reply.ts';

export const RESTARTED =
  '🔄 mate restarted mid-turn, so that answer is lost — ask again';
export const RESUMING =
  '🔄 mate restarted mid-turn — picking up where it left off';
export const NEVER_STARTED =
  '🔄 mate restarted before this could start — ask again';
export const TURN_WAITING = '⏳ waiting for a free turn';
export const GAVE_UP_WAITING =
  '💤 gave up waiting for a free turn — reply to try again';
export const STORE_DOWN =
  "⚠️ mate can't reach its memory right now — try again in a minute";
export const THREAD_CLOSED = '💤 closed for now — reply to pick this back up';
export const HARNESS_FAILED = '⚠️ the agent hit an error';
export const UNDELIVERED = "⚠️ couldn't deliver the reply";
export const THREAD_SPENT = '🛑 this thread has used its';
export const DAY_SPENT = '🛑 the daily budget of';

// The `sandbox` card's titles, drawn inside a turn.
export const WAITING = '⏳ waiting for a free sandbox';
export const MINT_STEPS: Record<MintStep, string> = {
  reusing: "⏳ waking this thread's sandbox",
  adopting: '⏳ grabbing a warm sandbox',
  refreshing: '⏳ updating its checkout',
  creating: '⏳ asking for a sandbox',
  booting: '⏳ booting a sandbox and cloning the repo',
};
export const CONNECTING = '🔌 connecting to the sandbox';
export const SANDBOX_READY = '🖥️ sandbox ready';
export const MINT_FAILED = "⚠️ couldn't start a sandbox";
export const SANDBOX_LOST =
  '⚠️ the sandbox died, and its files with it — the next command starts a fresh one';

// Answers to the owner's `chatgpt` commands, each the start of its line.
export const CHATGPT = {
  codeSent: '🔑 Sent you a sign-in code',
  codeWaiting: '🔑 A sign-in is already waiting for its code',
  signedIn: '✅ mate is signed in to ChatGPT',
  proofFailed: '⚠️ mate is signed in to ChatGPT, but',
  codeExpired: '⌛ The sign-in code expired unused',
  notSent: "⚠️ Couldn't send you the code",
  noWhisper: '⚠️ mate cannot send a sign-in code privately here',
  deviceRefused: '⚠️ OpenAI refused to start a device sign-in',
  failed: '⚠️ ChatGPT sign-in failed',
  signedOut: '🔓 mate signed out of ChatGPT',
  logoutFailed: '⚠️ mate could not sign out of ChatGPT',
  paused: '⏸️ ChatGPT is paused',
  resumed: '▶️ ChatGPT is not paused',
  status: 'ChatGPT: ',
} as const;

// Posted by earlier versions of mate.
export const STOPPED_WAITING =
  '💤 gave up waiting for a sandbox — reply to try again';
export const SANDBOX_CLOSED = '💤 sandbox closed — reply to pick this back up';
export const ATTACHING = '🔌 connecting to the agent';
export const ATTACH_FAILED =
  "⚠️ the sandbox started but the agent didn't answer";
export const SANDBOX_DIED = '⚠️ the sandbox died mid-turn';

const PREFIXES: readonly string[] = [
  RESTARTED,
  RESUMING,
  NEVER_STARTED,
  TURN_WAITING,
  GAVE_UP_WAITING,
  STORE_DOWN,
  THREAD_CLOSED,
  HARNESS_FAILED,
  UNDELIVERED,
  THREAD_SPENT,
  DAY_SPENT,
  WAITING,
  // Spread, so a new mint step is filtered too.
  ...Object.values(MINT_STEPS),
  CONNECTING,
  SANDBOX_READY,
  MINT_FAILED,
  SANDBOX_LOST,
  ...Object.values(CHATGPT),
  STOPPED_WAITING,
  SANDBOX_CLOSED,
  ATTACHING,
  ATTACH_FAILED,
  SANDBOX_DIED,
  NO_REPLY,
  STOPPED,
];

export function isNotice(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  return PREFIXES.some((prefix) => text.startsWith(prefix));
}
