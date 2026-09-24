/**
 * Slack as a surface: Socket Mode inbound (`socket.ts`) and a few Web API calls
 * on Bun's `fetch`, since the `@slack/*` packages declare a Node engine.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import { NO_REPLY, oneLine, STOPPED, splitAt } from './reply.ts';
import {
  type Canvas,
  type HistoryMessage,
  type Inbound,
  type Notice,
  type Outcome,
  type Surface,
  type ThreadRef,
  type ToolCall,
  type ToolState,
  threadKey,
} from './surface.ts';

export const SLACK_API = 'https://slack.com/api/';
export const CALL_TIMEOUT_MS = 15_000;
export const RETRY_LIMIT = 3;
const RETRY_FLOOR_MS = 1_000;
// Slack's documented maximum for one `markdown_text`, also used as the cap on
// one streamed message; past it a new message starts.
export const STREAM_CAP = 12_000;
// Slack expires `processing` an hour after it is set, and only another
// setStatus renews it. Half the hour leaves room for one missed call.
export const PROCESSING_RENEW_MS = 1_800_000;
/** One read of a thread, bounded: the replay only ever wants the newest few. */
const REPLIES_PAGE = 200;
const REPLIES_PAGES = 5;

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = 'SlackError';
  }
}

// Slack's own stop ends the stream, so the frame in flight is refused with
// one of these. The turn ended as the human asked, so neither is a fault.
export function alreadyOver(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return (
    code === 'stopped_by_user' || code === 'message_not_in_streaming_state'
  );
}

/** `&`, `<` and `>` are control characters in Slack's message text. */
export function escapeSlack(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Slack turns `<!channel>`, `<!here>` and `<@U…>` in model output into real
// pings. Other markdown stays raw, so a code fence holding `<div>` survives.
export function escapeMentions(text: string): string {
  return text
    .replaceAll('<!', '&lt;!')
    .replaceAll('<@', '&lt;@')
    .replaceAll('<#', '&lt;#');
}

export function decodeSlack(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  thread_ts?: string;
}

// Slack merges `task_update` chunks by `id` into one card it updates in place.
export type StreamChunk =
  | { type: 'markdown_text'; text: string }
  | {
      type: 'task_update';
      id: string;
      title: string;
      status: ToolState;
    };

export interface StreamStart {
  channel: string;
  threadTs: string;
  userId: string;
  teamId: string;
  chunks: StreamChunk[];
}

// Slack draws its stop control on `processing`, which expires after an hour.
// `chat.stopStream` leaves a session `active`; nothing else moves it unasked.
export type SessionStatus = 'processing' | 'active' | 'closed';

export interface SlackApi {
  post(channel: string, threadTs: string, text: string): Promise<string>;
  /** Rewrites a message mate posted; only a plain one, never a streamed answer. */
  edit(channel: string, ts: string, text: string): Promise<void>;
  remove(channel: string, ts: string): Promise<void>;
  startStream(args: StreamStart): Promise<string>;
  appendStream(
    channel: string,
    ts: string,
    chunks: StreamChunk[],
  ): Promise<void>;
  stopStream(channel: string, ts: string): Promise<void>;
  session(
    channel: string,
    threadTs: string,
    status: SessionStatus,
  ): Promise<void>;
  /** A thread's messages, oldest first. */
  replies(channel: string, threadTs: string): Promise<SlackMessage[]>;
  userName(userId: string): Promise<string>;
  identity(): Promise<{ userId: string; teamId: string; appBotId: string }>;
}

export function slackWeb(
  token: string,
  deps: { clock: Clock; log: Log },
): SlackApi {
  const names = new Map<string, string>();
  const warned = new Set<string>();

  async function send(
    method: string,
    body: string,
    contentType: string,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${SLACK_API}${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': contentType,
        },
        body,
        // Bun's fetch has no happy-eyeballs fallback, so an unreachable
        // address hangs unless the call is bounded.
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (response.status === 429 && attempt < RETRY_LIMIT) {
        await response.text().catch(() => '');
        const after = Number(response.headers.get('retry-after') ?? '1');
        const waitMs = Math.max(after * 1_000, RETRY_FLOOR_MS);
        deps.log.warn('slack rate limited', { method, waitMs });
        await deps.clock.sleep(waitMs);
        continue;
      }
      // Slack reports its own errors as 200 with `ok: false`. Any other
      // status is transport, and its body is not JSON.
      if (!response.ok) {
        await response.text().catch(() => '');
        throw new SlackError(method, `HTTP ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (payload.ok !== true) {
        throw new SlackError(method, String(payload.error ?? response.status));
      }
      return payload;
    }
  }

  /** A write, as JSON: the only encoding that carries blocks and chunks. */
  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return send(
      method,
      JSON.stringify(body),
      'application/json; charset=utf-8',
    );
  }

  // Read methods refuse a JSON body with misleading errors, such as
  // `user_not_found` for a user who exists.
  async function read(
    method: string,
    args: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      form.set(key, String(value));
    }
    return send(
      method,
      form.toString(),
      'application/x-www-form-urlencoded; charset=utf-8',
    );
  }

  return {
    async post(channel, threadTs, text) {
      const sent = await call('chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text,
      });
      return String(sent.ts);
    },
    async edit(channel, ts, text) {
      await call('chat.update', { channel, ts, text });
    },
    async remove(channel, ts) {
      await call('chat.delete', { channel, ts });
    },
    async startStream(args) {
      const started = await call('chat.startStream', {
        channel: args.channel,
        // All three are required in a channel.
        thread_ts: args.threadTs,
        recipient_user_id: args.userId,
        recipient_team_id: args.teamId,
        // A stopped `plan` retitles itself "Something went wrong", which Slack
        // folds into the message text the replay reads back.
        task_display_mode: 'timeline',
        // Opened with chunks: a `markdown_text` stream refuses them later with
        // `streaming_mode_mismatch`.
        chunks: args.chunks,
      });
      return String(started.ts);
    },
    async appendStream(channel, ts, chunks) {
      await call('chat.appendStream', { channel, ts, chunks });
    },
    async stopStream(channel, ts) {
      await call('chat.stopStream', { channel, ts });
    },
    async session(channel, threadTs, status) {
      const set = await call('agents.sessions.setStatus', {
        status,
        channel_id: channel,
        thread_ts: threadTs,
      });
      // Each distinct warning once per process: it reports app configuration,
      // such as a missing `agent_session_stopped` subscription, on every call.
      const warning = set.warning ? String(set.warning) : '';
      if (warning && !warned.has(warning)) {
        warned.add(warning);
        deps.log.warn('slack agent session', { warning });
      }
    },
    async replies(channel, threadTs) {
      const all: SlackMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < REPLIES_PAGES; page += 1) {
        const got = await read('conversations.replies', {
          channel,
          ts: threadTs,
          limit: REPLIES_PAGE,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...((got.messages ?? []) as SlackMessage[]));
        const meta = got.response_metadata as
          | { next_cursor?: string }
          | undefined;
        cursor = meta?.next_cursor || undefined;
        if (!cursor) break;
      }
      return all;
    },
    async userName(userId) {
      const known = names.get(userId);
      if (known) return known;
      try {
        const got = await read('users.info', { user: userId });
        const user = got.user as
          | { profile?: { display_name?: string }; real_name?: string }
          | undefined;
        const name = user?.profile?.display_name || user?.real_name || userId;
        names.set(userId, name);
        return name;
      } catch (error) {
        deps.log.warn('slack user lookup failed', {
          userId,
          error: plain(error),
        });
        return userId;
      }
    },
    async identity() {
      const auth = await read('auth.test', {});
      return {
        userId: String(auth.user_id),
        teamId: String(auth.team_id),
        appBotId: String(auth.bot_id),
      };
    },
  };
}

// Takes the app-level token, in the header; the call needs no scope.
export async function openSocket(appToken: string): Promise<string> {
  const opened = await fetch(`${SLACK_API}apps.connections.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const payload = (await opened.json()) as {
    ok?: boolean;
    url?: string;
    error?: string;
  };
  if (!payload.ok || !payload.url) {
    throw new Error(`apps.connections.open: ${payload.error ?? opened.status}`);
  }
  return payload.url;
}

export class SlackCanvas implements Canvas {
  private streamTs: string | null = null;
  /** Answer characters streamed this turn, across every message it has taken. */
  private sent = 0;
  /** Answer characters in the streamed message that is live now. */
  private painted = 0;
  /** Set once Slack has ended the stream itself, which its own stop does. */
  private over = false;
  private renewing: Handle | null = null;
  private readonly running = new Map<string, string>();
  private steps = 0;

  constructor(
    private readonly api: SlackApi,
    private readonly log: Log,
    private readonly clock: Clock,
    private readonly thread: ThreadRef,
    private readonly recipient: { userId: string; teamId: string },
    private readonly cap = STREAM_CAP,
  ) {}

  // Called until the first frame is sent, which also retries a failed first call.
  async working(): Promise<void> {
    this.renew();
    await this.api.session(this.thread.channelId, this.thread.id, 'processing');
  }

  // Cancelled by the last frame, so it renews only a turn still in flight.
  private renew(): void {
    if (this.renewing) return;
    const tick = () => {
      this.renewing = this.clock.after(PROCESSING_RENEW_MS, tick);
      void this.api
        .session(this.thread.channelId, this.thread.id, 'processing')
        .catch((error) =>
          this.log.warn('the agent session could not be held processing', {
            threadId: this.thread.id,
            error: plain(error),
          }),
        );
    };
    this.renewing = this.clock.after(PROCESSING_RENEW_MS, tick);
  }

  private rest(): void {
    if (this.renewing) this.clock.cancel(this.renewing);
    this.renewing = null;
  }

  // A channel thread has no free-text status, and `assistant.threads.setStatus`
  // does nothing there, so the tool cards carry it.
  async live(text: string, _status: string | null): Promise<void> {
    await this.stream(text);
  }

  async tool(call: ToolCall): Promise<void> {
    if (call.state === 'in_progress') this.running.set(call.id, call.title);
    else this.running.delete(call.id);
    await this.card(call.id, call.title, call.state);
  }

  // A finished sentence, so `complete` at once. The `say-` prefix keeps the
  // counted id clear of a `toolCallId`.
  async step(text: string): Promise<void> {
    this.steps += 1;
    await this.card(`say-${this.steps}`, oneLine(text), 'complete');
  }

  // Slack folds the title into the message text verbatim, where `<@U…>` would
  // read back as a real mention.
  private card(id: string, title: string, status: ToolState): Promise<void> {
    return this.chunk({
      type: 'task_update',
      id,
      title: escapeMentions(title),
      status,
    });
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    try {
      await this.stream(
        outcome === 'stopped' ? `${text}${text ? '\n\n' : ''}${STOPPED}` : text,
        true,
      );
      await this.closeCards(outcome === 'done' ? 'complete' : 'error');
      // Tool cards are not an answer. A failed turn has its own line, and
      // after the human's stop a "no reply" is noise.
      if (this.sent === 0 && outcome !== 'failed' && !this.over) {
        await this.nothing();
      }
    } finally {
      // Always: a message left streaming refuses later edits, and the thread
      // would keep spinning.
      this.rest();
      await this.endStream();
      await this.settle();
    }
  }

  // `chat.stopStream` marks a card left `in_progress` as `error`, so a done
  // turn closes its cards itself. Slack has no cancelled state.
  private async closeCards(state: ToolState): Promise<void> {
    const open = [...this.running];
    this.running.clear();
    for (const [id, title] of open) {
      await this.card(id, title, state).catch((error) =>
        this.log.warn('a tool card could not be closed', {
          threadId: this.thread.id,
          error: plain(error),
        }),
      );
    }
  }

  private async endStream(): Promise<void> {
    const ts = this.streamTs;
    this.streamTs = null;
    if (!ts || this.over) return;
    await this.api.stopStream(this.thread.channelId, ts).catch((error) => {
      // The human's stop may have ended the stream since the last frame.
      if (alreadyOver(error)) {
        this.ended(error);
        return;
      }
      this.log.warn('the stream could not be stopped', {
        threadId: this.thread.id,
        error: plain(error),
      });
    });
  }

  private async nothing(): Promise<void> {
    if (this.streamTs) {
      await this.chunk({ type: 'markdown_text', text: NO_REPLY });
      return;
    }
    await this.api.post(
      this.thread.channelId,
      this.thread.id,
      escapeSlack(NO_REPLY),
    );
  }

  // For a turn that streamed nothing or whose stop failed; `chat.stopStream`
  // already leaves the session `active`.
  private async settle(): Promise<void> {
    await this.api
      .session(this.thread.channelId, this.thread.id, 'active')
      .catch((error) =>
        this.log.warn('the agent session could not be settled', {
          threadId: this.thread.id,
          error: plain(error),
        }),
      );
  }

  // A stream the human stopped ends the painting; a new message would answer
  // past the stop.
  private async chunk(chunk: StreamChunk): Promise<void> {
    if (this.over) return;
    try {
      if (this.streamTs) {
        await this.api.appendStream(this.thread.channelId, this.streamTs, [
          chunk,
        ]);
        return;
      }
      this.streamTs = await this.api.startStream({
        channel: this.thread.channelId,
        threadTs: this.thread.id,
        userId: this.recipient.userId,
        teamId: this.recipient.teamId,
        chunks: [chunk],
      });
    } catch (error) {
      if (!alreadyOver(error)) throw error;
      this.ended(error);
      this.streamTs = null;
    }
  }

  // Usually Slack's own stop, so this is info: nothing is broken.
  private ended(error: unknown): void {
    this.over = true;
    this.log.info('the stream was already over', {
      threadId: this.thread.id,
      error: plain(error),
    });
  }

  private async stream(text: string, last = false): Promise<void> {
    // A trailing `<` waits a frame: the next character decides whether it
    // opens a mention, and the escape has to see both.
    const whole = last || !text.endsWith('<') ? text : text.slice(0, -1);
    let tail = escapeMentions(whole).slice(this.sent);
    while (tail && !this.over) {
      if (this.streamTs && this.painted >= this.cap) await this.roll();
      const [head, rest] = splitAt(tail, this.cap - this.painted);
      await this.chunk({ type: 'markdown_text', text: head });
      this.sent += head.length;
      this.painted += head.length;
      tail = rest;
    }
  }

  private async roll(): Promise<void> {
    const ts = this.streamTs;
    if (!ts) return;
    try {
      await this.api.stopStream(this.thread.channelId, ts);
    } catch (error) {
      if (!alreadyOver(error)) throw error;
      this.ended(error);
    }
    this.streamTs = null;
    this.painted = 0;
  }
}

// A posted message: a session status carries no words, and a stream chunk
// would join the answer. `openThread` makes no call, so this shows first.
export class SlackNotice implements Notice {
  private ts: string | null = null;

  constructor(
    private readonly api: SlackApi,
    private readonly thread: ThreadRef,
  ) {}

  async say(text: string): Promise<void> {
    const body = escapeSlack(text);
    if (this.ts) {
      await this.api.edit(this.thread.channelId, this.ts, body);
      return;
    }
    this.ts = await this.api.post(this.thread.channelId, this.thread.id, body);
  }

  async done(text: string | null): Promise<void> {
    if (text !== null) {
      await this.say(text);
      return;
    }
    const ts = this.ts;
    this.ts = null;
    if (ts) await this.api.remove(this.thread.channelId, ts);
  }
}

export interface SlackSurfaceDeps {
  api: SlackApi;
  /** The bot's own user id. */
  me: string;
  /** The one field every shape of mate's own post carries; `user` is not. */
  appBotId: string;
  teamId: string;
  allowedUserIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
  log: Log;
  clock: Clock;
  streamCap?: number;
}

export function slackSurface(deps: SlackSurfaceDeps): Surface {
  async function author(message: SlackMessage): Promise<string> {
    if (message.bot_id) return message.username ?? 'bot';
    return message.user ? deps.api.userName(message.user) : 'someone';
  }

  function speaker(message: SlackMessage): string {
    if (message.bot_id === deps.appBotId) return deps.me;
    return message.user ?? message.bot_id ?? '';
  }

  return {
    name: 'slack',
    me: deps.me,
    allowedUserIds: deps.allowedUserIds,
    allowedChannelIds: deps.allowedChannelIds,
    // A Slack thread is its parent message: the mention, or the thread it
    // was posted in.
    async openThread(message) {
      return {
        surface: 'slack',
        channelId: message.channelId,
        id: message.threadId ?? message.id,
      };
    },
    async post(thread, text) {
      await deps.api.post(thread.channelId, thread.id, escapeSlack(text));
    },
    notice(thread) {
      return new SlackNotice(deps.api, thread);
    },
    async history(thread, query) {
      const all = await deps.api.replies(thread.channelId, thread.id);
      const end = query.before
        ? all.findIndex((message) => message.ts === query.before)
        : all.length;
      const window = all
        .slice(0, end < 0 ? all.length : end)
        .reverse()
        .slice(0, query.limit);
      const read: HistoryMessage[] = [];
      for (const message of window) {
        read.push({
          id: message.ts,
          authorId: speaker(message),
          authorName: await author(message),
          authorIsBot: Boolean(message.bot_id),
          content: decodeSlack(message.text ?? ''),
        });
      }
      return read;
    },
    canvas(thread, asker) {
      return new SlackCanvas(
        deps.api,
        deps.log,
        deps.clock,
        thread,
        { userId: asker, teamId: deps.teamId },
        deps.streamCap,
      );
    },
    // Slack threads are never archived; closing the session ends the spinner.
    async archive(thread) {
      await deps.api.session(thread.channelId, thread.id, 'closed');
    },
    // The session outlives the process, so a restart would otherwise leave
    // the thread spinning.
    async settle(thread) {
      await deps.api.session(thread.channelId, thread.id, 'active');
    },
  };
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  hidden?: boolean;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

export function slackInbound(event: SlackEvent, me: string): Inbound | null {
  // One sentence arrives as both `message` and `app_mention`; answer only one.
  if (event.type !== 'message') return null;
  // `chat.update` emits a hidden `message_changed`. `thread_broadcast` is an
  // ordinary reply also sent to the channel.
  if ((event.subtype && event.subtype !== 'thread_broadcast') || event.hidden) {
    return null;
  }
  if (!event.channel || !event.ts) return null;
  const raw = event.text ?? '';
  return {
    surface: 'slack',
    id: event.ts,
    channelId: event.channel,
    threadId: event.thread_ts ?? null,
    authorId: event.user ?? event.bot_id ?? '',
    // mate's own posts carry `bot_id` but no `bot_message` subtype.
    authorIsBot: Boolean(event.bot_id),
    content: decodeSlack(raw),
    // Read before decoding, so a human typing the escape's own entities
    // cannot produce a mention from them.
    mentionsMe: raw.includes(`<@${me}>`),
  };
}

// Slack's stop arrives as this event, never as a block action, and joins the
// Discord button's cancel path, allowlist check included.
export function slackSessionStopped(
  event: SlackEvent,
): { key: string; userId: string } | null {
  if (event.type !== 'agent_session_stopped') return null;
  if (!event.channel || !event.thread_ts) return null;
  return {
    key: threadKey({
      surface: 'slack',
      channelId: event.channel,
      id: event.thread_ts,
    }),
    userId: event.user ?? '',
  };
}

export function slackEvent(
  event: SlackEvent,
  me: string,
  on: {
    stopped(stop: { key: string; userId: string }): void;
    message(inbound: Inbound): void;
  },
): void {
  const stopped = slackSessionStopped(event);
  if (stopped) {
    on.stopped(stopped);
    return;
  }
  const inbound = slackInbound(event, me);
  if (inbound) on.message(inbound);
}
