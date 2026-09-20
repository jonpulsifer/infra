/**
 * The place mate is present, behind one interface. Discord and Slack are both
 * adapters over it, so the thread state machine and the renderer never name
 * either one and the whole contract runs against a fake.
 *
 * A surface is one workspace: its own bot identity, its own allowlists, its
 * own ids. Two surfaces in one process share the concurrency cap, the turn
 * budgets and the quiet timer, because those belong to mate rather than to a
 * place it answers in.
 */

export type SurfaceName = 'discord' | 'slack';

/** One thread, named the way its own surface names it. */
export interface ThreadRef {
  readonly surface: SurfaceName;
  /** The channel the thread hangs under. */
  readonly channelId: string;
  /** The thread itself, inside that channel. */
  readonly id: string;
}

/**
 * The name a thread is known by across both surfaces, and the only key the
 * state machine uses. A Discord thread is itself a channel, so its id is a
 * snowflake that stands alone and a message in a thread names nothing else; a
 * Slack thread is the timestamp of its parent message, which is only unique
 * inside its channel, so the channel is part of its name.
 */
export function threadKey(thread: ThreadRef): string {
  return thread.surface === 'discord'
    ? `discord:${thread.id}`
    : `${thread.surface}:${thread.channelId}:${thread.id}`;
}

/** A message the surface delivered, already stripped of its own wire shape. */
export interface Inbound {
  readonly surface: SurfaceName;
  readonly id: string;
  readonly channelId: string;
  /** The thread it landed in, or null when it is not in one. */
  readonly threadId: string | null;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly mentionsMe: boolean;
}

/** One message already in a thread, as the transcript replay reads it. */
export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
}

export interface HistoryQuery {
  limit: number;
  /** Only messages older than this id, which is how a replay pages backwards. */
  before?: string;
}

export type Outcome = 'done' | 'stopped' | 'failed';

/**
 * How far one tool call has got. The three values are Slack's `task_card`
 * statuses, which is the only surface that renders them; ACP's `pending` is
 * `in_progress` here because a card cannot be pending.
 */
export type ToolState = 'in_progress' | 'complete' | 'error';

/** One tool call of a turn, as a surface that shows them one by one reads it. */
export interface ToolCall {
  /** The harness's own id for it, stable across its updates. */
  readonly id: string;
  readonly title: string;
  readonly state: ToolState;
}

/**
 * Where one turn's answer is painted. The renderer decides what the answer
 * says and when to repaint it; the canvas decides how that reaches the
 * surface — edited in place and chunked on Discord, streamed on Slack — and
 * is the only thing that remembers what has already been shown.
 */
export interface Canvas {
  /** The answer so far, and the line naming what the harness is doing. */
  live(text: string, status: string | null): Promise<void>;
  /** The last frame; whatever the surface drew for a live turn goes with it. */
  final(text: string, outcome: Outcome): Promise<void>;
  /** The surface's "working" sign, shown until the first live frame. */
  working?(): Promise<void>;
  /**
   * One tool call, where the surface renders them itself. Slack has a card
   * per call that mutates in place; Discord has nothing of the kind and
   * declares no `tool`, so its turns are painted by the status line alone.
   */
  tool?(call: ToolCall): Promise<void>;
}

/**
 * One line mate keeps a hand on: rewritten in place as the news changes, and
 * taken back when there is nothing left to say. Both surfaces post a message
 * and edit it, because a thread has nowhere else to put words — Discord's
 * typing indicator and Slack's agent session each say that mate is working
 * and neither can say what it is working on.
 */
export interface Notice {
  /** Says the line, or rewrites what it already says. */
  say(text: string): Promise<void>;
  /** The last word: a sentence replaces the line, `null` takes it away. */
  done(text: string | null): Promise<void>;
}

export interface Surface {
  readonly name: SurfaceName;
  /** The bot's own user id here: what a mention looks like, and who "you" is. */
  readonly me: string;
  /** Who may drive mate here. Anyone else is silence. */
  readonly allowedUserIds: ReadonlySet<string>;
  /** Where a mention may open a thread. */
  readonly allowedChannelIds: ReadonlySet<string>;
  /** The thread a mention opens. */
  openThread(message: Inbound, title: string): Promise<ThreadRef>;
  /** One plain line in the thread: everything mate says that is not an answer. */
  post(thread: ThreadRef, text: string): Promise<void>;
  /**
   * A line mate will keep rewriting, for news that is only true until the
   * next thing happens — which is the wait for a sandbox, and nothing else.
   */
  notice(thread: ThreadRef): Notice;
  /** The thread's own messages, newest first. */
  history(thread: ThreadRef, query: HistoryQuery): Promise<HistoryMessage[]>;
  /**
   * A fresh canvas for one turn. `asker` is the human it answers: Slack
   * requires a streamed message to name who it is for, Discord does not care.
   */
  canvas(thread: ThreadRef, asker: string): Canvas;
  /**
   * Seals the thread at teardown, where the surface has such a thing. Discord
   * archives the thread; Slack closes the agent session on its parent, which
   * is what stops the thread reading as live. A surface with neither declares
   * no `archive` and the state machine has nothing to call.
   */
  archive?(thread: ThreadRef): Promise<void>;
  /**
   * The thread is not working on anything — for a surface whose working sign
   * belongs to the thread rather than to one message, and so outlives the
   * process that raised it. Slack's agent session sits on the thread's
   * parent; Discord's only such sign is a message mid-edit, which ends with
   * the process, so it declares no `settle`.
   */
  settle?(thread: ThreadRef): Promise<void>;
}
