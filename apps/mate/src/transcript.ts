/**
 * The thread's own history, handed to a harness that starts empty. Discord is
 * the only durable log mate keeps, so when `session/load` cannot replay the
 * harness's state the conversation is replayed from the thread instead.
 */
import type { Discord, HistoryMessage } from './discord.ts';
import { isNotice } from './notices.ts';

/**
 * The cap. A thread is capped at 30 turns, so 40 messages covers a thread's
 * whole life short of its budget, and 8000 characters keeps the preamble a
 * small fraction of the harness's context whatever those messages hold. Two
 * pages of 100 bound the read at two requests per session, keeping the newest
 * messages when a chatty thread runs past either cap.
 */
export const REPLAY_MESSAGES = 40;
export const REPLAY_CHARS = 8_000;
export const REPLAY_PAGES = 2;
const PAGE = 100;

const HEADER =
  'Earlier messages in this Discord thread, before this session started:';
const FOOTER =
  'Those messages are context only. Answer the message that follows.';

export interface ReplayOptions {
  /** The bot's own user id: its messages are the assistant's earlier turns. */
  me: string;
  /** Messages already queued as prompts, which must not be replayed as history. */
  skip: readonly string[];
}

function render(message: HistoryMessage, me: string): string {
  const who = message.authorId === me ? 'you' : message.authorName;
  return `${who}: ${message.content.trim()}`;
}

function eligible(
  message: HistoryMessage,
  { me, skip }: ReplayOptions,
): boolean {
  if (message.authorIsBot && message.authorId !== me) return false;
  if (message.authorId === me && isNotice(message.content)) return false;
  const text = message.content.trim();
  if (!text) return false;
  return !skip.includes(text);
}

/**
 * The preamble for the first prompt of a fresh session, or null when the
 * thread holds nothing worth replaying.
 */
export async function replayPreamble(
  discord: Discord,
  threadId: string,
  options: ReplayOptions,
): Promise<string | null> {
  const kept: HistoryMessage[] = [];
  let characters = 0;
  let before: string | undefined;
  let full = false;
  for (let page = 0; page < REPLAY_PAGES && !full; page += 1) {
    const batch = await discord.history(threadId, { limit: PAGE, before });
    if (batch.length === 0) break;
    before = batch.at(-1)?.id;
    for (const message of batch) {
      if (!eligible(message, options)) continue;
      const line = render(message, options.me);
      if (characters + line.length > REPLAY_CHARS) {
        full = true;
        break;
      }
      kept.push(message);
      characters += line.length;
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
