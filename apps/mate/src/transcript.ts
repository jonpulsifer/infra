/**
 * Replays a thread's history into a session mate-db does not hold: a thread
 * from before the brain moved into mate, or one whose session was set aside.
 */
import { isNotice } from './notices.ts';
import type { HistoryMessage, Surface, ThreadRef } from './surface.ts';

/** Sized against the thread cap of 30 turns (MATE_MAX_TURNS_PER_THREAD). */
export const REPLAY_MESSAGES = 40;
/** Counts the preamble with its header and footer; 8000 keeps it a small share of the model's context. */
export const REPLAY_CHARS = 8_000;
/** Bounds the read to two requests; past either cap the newest messages win. */
export const REPLAY_PAGES = 2;
const PAGE = 100;

/** Heads a trusted trigger's prompt, which mate posts in its thread before any turn. */
export const ASSIGNMENT = '📋 assignment';

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
  /** True for a human's line that commands mate itself, which no session hears. */
  command?(text: string): boolean;
}

export function assignmentPost(text: string): string {
  return `${ASSIGNMENT}\n${text}`;
}

function assignmentOf(content: string): string | null {
  const text = content.trim();
  return text.startsWith(`${ASSIGNMENT}\n`)
    ? text.slice(ASSIGNMENT.length + 1).trim()
    : null;
}

function render(
  message: HistoryMessage,
  me: string,
  assignment = false,
): string {
  if (assignment) return `assignment: ${assignmentOf(message.content)}`;
  const who = message.authorId === me ? 'you' : message.authorName;
  return `${who}: ${message.content.trim()}`;
}

/** Only what a live session would have heard: mate and the allowlist. */
function eligible(
  message: HistoryMessage,
  allowed: ReadonlySet<string>,
  { me, skip, command }: ReplayOptions,
): boolean {
  if (message.authorId === me) {
    if (isNotice(message.content)) return false;
  } else if (
    message.authorIsBot ||
    !allowed.has(message.authorId) ||
    command?.(message.content)
  ) {
    return false;
  }
  const text = message.content.trim();
  if (!text) return false;
  return !skip.includes(assignmentOf(text) ?? text);
}

/**
 * Null when the thread holds nothing worth replaying. Only mate's first post
 * after the root, read with the whole thread, is the assignment: a model reply
 * can start the same way, but never before every turn.
 */
export async function replayPreamble(
  surface: Surface,
  thread: ThreadRef,
  options: ReplayOptions,
): Promise<string | null> {
  const kept: HistoryMessage[] = [];
  let characters = HEADER.length + FOOTER.length + SEPARATORS;
  let before: string | undefined;
  let full = false;
  let whole = false;
  // mate's oldest post past the root so far, kept or not.
  let first: HistoryMessage | null = null;
  for (let page = 0; page < REPLAY_PAGES && !full; page += 1) {
    const batch = await surface.history(thread, { limit: PAGE, before });
    if (batch.length === 0) {
      whole = true;
      break;
    }
    before = batch.at(-1)?.id;
    for (const message of batch) {
      if (
        message.authorId === options.me &&
        message.id !== thread.id &&
        !isNotice(message.content)
      ) {
        first = message;
      }
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
    if (batch.length < PAGE) {
      whole = !full;
      break;
    }
  }
  if (kept.length === 0) return null;
  const assignment =
    whole &&
    first &&
    kept.includes(first) &&
    assignmentOf(first.content) !== null
      ? first
      : null;
  const lines = kept
    .reverse()
    .map((message) => render(message, options.me, message === assignment))
    .join('\n');
  return `${HEADER}\n\n${lines}\n\n${FOOTER}\n\n`;
}
