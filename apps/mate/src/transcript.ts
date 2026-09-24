/**
 * Replays a thread's history into a harness session that `session/load` could
 * not restore. The thread is mate's only durable log.
 */
import { isNotice } from './notices.ts';
import type { HistoryMessage, Surface, ThreadRef } from './surface.ts';

/** Sized against the thread cap of 30 turns (MATE_MAX_TURNS_PER_THREAD). */
export const REPLAY_MESSAGES = 40;
/** Counts the preamble with its header and footer; 8000 keeps it a small share of the harness context. */
export const REPLAY_CHARS = 8_000;
/** Bounds the read to two requests; past either cap the newest messages win. */
export const REPLAY_PAGES = 2;
const PAGE = 100;

const HEADER = 'Earlier messages in this thread, before this session started:';
const FOOTER =
  'Those messages are context only. Answer the message that follows.';
/** The newlines around the header and footer. */
const SEPARATORS = 6;

export interface ReplayOptions {
  /** mate's own user id: its messages render as `you`. */
  me: string;
  /** Texts already queued as prompts, never replayed as history. */
  skip: readonly string[];
}

function render(message: HistoryMessage, me: string): string {
  const who = message.authorId === me ? 'you' : message.authorName;
  return `${who}: ${message.content.trim()}`;
}

/** Only what a live session would have heard: mate and the allowlist. */
function eligible(
  message: HistoryMessage,
  allowed: ReadonlySet<string>,
  { me, skip }: ReplayOptions,
): boolean {
  if (message.authorId === me) {
    if (isNotice(message.content)) return false;
  } else if (message.authorIsBot || !allowed.has(message.authorId)) {
    return false;
  }
  const text = message.content.trim();
  if (!text) return false;
  return !skip.includes(text);
}

/** Null when the thread holds nothing worth replaying. */
export async function replayPreamble(
  surface: Surface,
  thread: ThreadRef,
  options: ReplayOptions,
): Promise<string | null> {
  const kept: HistoryMessage[] = [];
  let characters = HEADER.length + FOOTER.length + SEPARATORS;
  let before: string | undefined;
  let full = false;
  for (let page = 0; page < REPLAY_PAGES && !full; page += 1) {
    const batch = await surface.history(thread, { limit: PAGE, before });
    if (batch.length === 0) break;
    before = batch.at(-1)?.id;
    for (const message of batch) {
      if (!eligible(message, surface.allowedUserIds, options)) continue;
      const line = render(message, options.me);
      if (characters + line.length + 1 > REPLAY_CHARS) {
        full = true;
        break;
      }
      kept.push(message);
      characters += line.length + 1;
      if (kept.length >= REPLAY_MESSAGES) {
        full = true;
        break;
      }
    }
    if (batch.length < PAGE) break;
  }
  if (kept.length === 0) return null;
  const lines = kept
    .reverse()
    .map((message) => render(message, options.me))
    .join('\n');
  return `${HEADER}\n\n${lines}\n\n${FOOTER}\n\n`;
}
