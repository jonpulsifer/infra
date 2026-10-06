/**
 * The interface Discord and Slack adapt to. Surfaces in one process share the
 * concurrency cap, the turn budgets and the quiet timer.
 */

export type SurfaceName = 'discord' | 'slack';

export interface ThreadRef {
  readonly surface: SurfaceName;
  /** The channel the thread hangs under. */
  readonly channelId: string;
  readonly id: string;
}

// A Slack thread's ts is unique only within its channel, so the key includes
// the channel. A Discord thread id stands alone.
export function threadKey(thread: ThreadRef): string {
  return thread.surface === 'discord'
    ? `discord:${thread.id}`
    : `${thread.surface}:${thread.channelId}:${thread.id}`;
}

export interface Inbound {
  readonly surface: SurfaceName;
  readonly id: string;
  readonly channelId: string;
  /** The thread it was posted in, or null when it is not in one. */
  readonly threadId: string | null;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly mentionsMe: boolean;
}

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

/**
 * Why an allowlisted human's message ran nothing and said nothing: no mention
 * outside a thread mate holds, a channel mate does not open threads in, a
 * thread that could not be created, a Slack event older than the replay
 * window, or a Slack message shape mate does not read.
 */
export type InboundDropReason =
  | 'no-mention'
  | 'channel'
  | 'thread-create'
  | 'stale'
  | 'subtype';

export type Outcome = 'done' | 'stopped' | 'failed';

/** Slack's `task_card` statuses. */
export type ToolState = 'in_progress' | 'complete' | 'error';

export interface ToolCall {
  /** pi's own id for it, stable across its updates. */
  readonly id: string;
  readonly title: string;
  readonly state: ToolState;
}

// The renderer decides what the answer says and when; the canvas decides how it
// reaches the surface, and alone remembers what has been shown.
export interface Canvas {
  /** The answer so far, and the line naming what the agent is doing. */
  live(text: string, status: string | null): Promise<void>;
  /** The last frame; whatever the surface drew for a live turn goes with it. */
  final(text: string, outcome: Outcome): Promise<void>;
  /** The surface's "working" sign, shown until the first live frame. */
  working?(): Promise<void>;
  /** Without it, the status line alone shows tool calls. */
  tool?(call: ToolCall): Promise<void>;
  /** A run of text that a tool call followed, kept beside the tool calls. */
  step?(text: string): Promise<void>;
}

// A posted message edited in place: a typing indicator or agent session says
// that mate is working, and cannot say on what.
export interface Notice {
  say(text: string): Promise<void>;
  /** The last word: a sentence replaces the line, `null` takes it away. */
  done(text: string | null): Promise<void>;
}

export interface MessageRef {
  readonly channelId: string;
  readonly id: string;
}

export type Mark = 'seen' | Outcome;

export interface Surface {
  readonly name: SurfaceName;
  /** The bot's own user id here: what a mention looks like, and who "you" is. */
  readonly me: string;
  /** Who may drive mate here; mate ignores everyone else. */
  readonly allowedUserIds: ReadonlySet<string>;
  /** Where a mention may open a thread. */
  readonly allowedChannelIds: ReadonlySet<string>;
  openThread(message: Inbound, title: string): Promise<ThreadRef>;
  post(thread: ThreadRef, text: string): Promise<void>;
  /** For the wait for a turn, which is news only until the turn starts. */
  notice(thread: ThreadRef): Notice;
  /** The thread's own messages, newest first. */
  history(thread: ThreadRef, query: HistoryQuery): Promise<HistoryMessage[]>;
  /** Slack's streams require the `asker`; Discord ignores it. */
  canvas(thread: ThreadRef, asker: string): Canvas;
  /** Discord archives the thread; Slack closes its agent session. */
  archive?(thread: ThreadRef): Promise<void>;
  /** Clears a working sign that outlives the process, like Slack's session. */
  settle?(thread: ThreadRef): Promise<void>;
  /** Discord reacts on the message; Slack's agent session already shows it. */
  mark?(message: MessageRef, mark: Mark): Promise<void>;
  /**
   * A message only `userId` can see, never in the thread: a Discord DM, or a
   * Slack message in the thread's channel that only they see.
   */
  whisper?(thread: ThreadRef, userId: string, text: string): Promise<void>;
}

export interface AddOptions {
  /**
   * False leaves the surface's stored threads where they are: a process that
   * shares mate-db with the running mate must not open or resume its threads.
   */
  readonly rehydrate?: boolean;
}

/** Where a listener delivers inbound: `Threads`, as a surface sees it. */
export interface Inbox {
  readonly surfaceNames: readonly SurfaceName[];
  add(surface: Surface, options?: AddOptions): Promise<void>;
  adopt(ref: ThreadRef): void;
  onMessage(message: Inbound): Promise<void>;
  onStop(key: string, userId: string, ack: () => Promise<void>): Promise<void>;
  onThreadArchived(ref: ThreadRef): Promise<void>;
  onThreadDeleted(ref: ThreadRef): Promise<void>;
}

/** A surface's connection, which brings its inbound to the threads. */
export interface SurfaceListener {
  /** Adds the surface to `threads` and delivers its inbound there. */
  start(threads: Inbox): Promise<void>;
  /** Delivers no more inbound; the surface can still post. */
  stop(): void;
  close(): Promise<void>;
}
