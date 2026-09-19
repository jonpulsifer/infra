/**
 * Slack as a surface. Socket Mode carries everything inbound (`socket.ts`);
 * outbound is a handful of Web API calls on Bun's own `fetch`, the whole of
 * what mate needs and is why no `@slack/*` package is here — they declare a
 * Node engine, and the Kubernetes client in this same process already took
 * the raw path for the same reason.
 *
 * What Slack does differently from Discord, and why the canvas below looks
 * nothing like the Discord one:
 *
 * - Slack streams, in chunks. `chat.startStream` / `appendStream` /
 *   `stopStream` take an array of chunks, so an answer is appended rather
 *   than a message rewritten. A `markdown_text` chunk is answer text; a
 *   `task_update` chunk merges by its id into a `task_card` block that
 *   mutates in place, which is exactly one ACP tool call. The mode is fixed
 *   at `startStream`: a stream opened with `markdown_text` refuses chunks
 *   with `streaming_mode_mismatch`, so every stream here opens in chunks.
 * - Those same `task_update` chunks render two ways and `task_display_mode`
 *   picks which, at `startStream` and nowhere else: `timeline` is a
 *   `task_card` per call that mutates in place, `plan` is the one `plan`
 *   block summarising them, and anything else is `invalid_arguments`. mate
 *   sends `timeline`, because a turn's tool calls are discovered one at a
 *   time rather than announced up front, and because a plan stopped under a
 *   running step retitles itself "Something went wrong" — which Slack folds
 *   into the message's `text`, where the transcript replay reads it back as
 *   something mate said.
 * - A channel thread has no free-text status. `agents.sessions.setStatus`
 *   takes a lifecycle enum and no words, and `assistant.threads.setStatus`
 *   answers `ok` and does nothing at all here. So the italic line Discord
 *   paints has no home: the tool cards say what mate is doing, and the
 *   session says that it is doing something.
 * - Stop is Slack's own control, drawn on a `processing` agent session for an
 *   app subscribed to `agent_session_stopped`. mate has no button here: the
 *   click arrives as that event and drops into the same cancel the Discord
 *   button asks for. Slack ends the stream itself as it sends it, so the
 *   frame mate was mid-way through is refused with `stopped_by_user` or
 *   `message_not_in_streaming_state` — an end, not a fault.
 * - In a channel the stream is addressed: `thread_ts`, `recipient_user_id`
 *   and `recipient_team_id` are all required. The mention that opened the
 *   thread is its parent, so mate has all three without asking for them.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import { NO_REPLY, splitAt } from './reply.ts';
import {
  type Canvas,
  type HistoryMessage,
  type Inbound,
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
/**
 * The cap on one streamed message. It is Slack's documented maximum for a
 * single `markdown_text`, used as the message's own ceiling as well, so no
 * call can exceed it and no answer grows without bound; past it the stream is
 * stopped and a new one starts, which is Slack's shape of the seal-and-
 * continue Discord's message cap forces.
 */
export const STREAM_CAP = 12_000;
/**
 * How often a turn in flight re-asserts its agent session's `processing`.
 * Slack expires that status an hour after it is set — the session carries a
 * `date_status_processing_expire` of that moment plus 3601 seconds — and past
 * it the thread reads as idle with the harness still working, taking the stop
 * control Slack draws on a `processing` session with it. What holds a turn
 * inside that hour is the harness's own cap on one turn, `TURN_TIMEOUT_MS` in
 * `sandboxes.ts`: fifteen minutes, and injectable. So this guards a cap that
 * can be raised, not a length nothing bounds.
 *
 * It takes a call of its own. Measured against the workspace: another
 * `agents.sessions.setStatus` of `processing` moves the expiry to the moment
 * of that call, and a `chat.appendStream` does not move it at all — so a turn
 * that streamed for an hour would still lose the status, and only this would
 * say otherwise. Half the window leaves a whole missed call's worth of room.
 */
export const PROCESSING_RENEW_MS = 1_800_000;
/** One read of a thread, bounded: the replay only ever wants the newest few. */
const REPLIES_PAGE = 200;
const REPLIES_PAGES = 5;

/**
 * Slack's own refusal, carrying the code it answered rather than only a
 * sentence about it: a caller that has to tell one refusal from another
 * should not be reading it back out of a message.
 */
export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
    this.name = 'SlackError';
  }
}

/**
 * Whether a failed call means the stream is already over rather than broken.
 * A human who stops a turn with Slack's own control has Slack end the stream
 * as it sends the event, so the frame mate was mid-way through sending is
 * refused: `stopped_by_user` for the stop itself, and
 * `message_not_in_streaming_state` for a message Slack has already taken out
 * of streaming, which is what both `chat.appendStream` and a second
 * `chat.stopStream` answer. Neither is worth a line in the thread — the turn
 * ended the way the human asked it to.
 */
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

/**
 * The three sequences that make a mention out of model output. Streamed
 * answers go out as `markdown_text` and are otherwise left alone — the field
 * exists to carry raw markdown, and escaping every angle bracket would mangle
 * a code fence holding `<div>` — but `<!channel>`, `<!here>` and `<@U…>` are
 * not markup: Slack resolves them to a real broadcast or a real ping. Discord
 * has no equivalent hazard because every message there is sent with
 * `allowed_mentions: {parse: []}`.
 */
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

/**
 * One piece of a streamed message. Answer text is `markdown_text`; a tool
 * call is `task_update`, which Slack merges by `id` into the `task_card`
 * block it renders as `task-<id>` and mutates in place on every later chunk
 * carrying the same id.
 */
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

/**
 * The lifecycle of the agent session on a thread's parent. `processing` is
 * Slack's own loading UX and the state its stop control is drawn on, `active`
 * is ready for the next prompt and `closed` is the thread sealed; `suspended`
 * is for an agent waiting on a human and mate has nothing to wait for.
 * Nothing moves a session on its own — `chat.stopStream` leaves it `active`
 * and only the hour-long `processing` expiry passes without being asked — so
 * every one of these is mate saying so.
 */
export type SessionStatus = 'processing' | 'active' | 'closed';

/** The calls and lookups mate makes; the fake in tests records them. */
export interface SlackApi {
  post(channel: string, threadTs: string, text: string): Promise<string>;
  startStream(args: StreamStart): Promise<string>;
  appendStream(
    channel: string,
    ts: string,
    chunks: StreamChunk[],
  ): Promise<void>;
  stopStream(channel: string, ts: string): Promise<void>;
  /** Where the thread's agent session is in its lifecycle. */
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
  /** Every session warning already said, so a new one is still heard once. */
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
        // address hangs rather than failing: every call is bounded.
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
      // Slack answers 200 with `ok: false` for its own errors, so anything
      // else is the transport: a proxy page, a 5xx body, or the retry limit
      // spent on 429s. Parsing those as JSON throws a SyntaxError naming
      // nothing, and the method and the status are the whole diagnosis.
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

  /**
   * A read, form-encoded. Slack's read methods refuse a JSON body, and say so
   * as anything but an encoding problem: `conversations.replies` answers
   * `invalid_arguments` with `missing required field: channel` for a channel
   * that is right there in the body, and `users.info` answers
   * `user_not_found` for a user who exists. Form encoding is what every
   * method accepts; JSON is the exception, not the rule.
   */
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
    async startStream(args) {
      const started = await call('chat.startStream', {
        channel: args.channel,
        thread_ts: args.threadTs,
        recipient_user_id: args.userId,
        recipient_team_id: args.teamId,
        // The default, sent anyway: it is the choice between a card per call
        // and one plan block, and leaving it to the default would leave no
        // trace that the choice was made.
        task_display_mode: 'timeline',
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
      // Each distinct warning once a process: a warning here is app
      // configuration rather than a per-turn fault, and no code can read that
      // setting — dropping the `agent_session_stopped` subscription answers
      // `missing_agent_session_stopped_event_subscription` on every call and
      // leaves a spinner where Slack's stop control belongs. Keyed on the
      // warning so one repeating for an hour cannot swallow another behind it.
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

/**
 * A Socket Mode connection, on the app-level token rather than the bot's. The
 * token goes in the header, not the body, and the call needs no scope.
 */
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

/**
 * One turn in a Slack thread: the answer and its tool cards streamed into a
 * message of its own, and the agent session on the thread's parent saying the
 * turn is running — which is also what has Slack draw its stop control.
 *
 * Nothing here can fail a turn on its own. The session calls are swallowed,
 * and the canvas answers whether or not Slack rendered a single card.
 */
export class SlackCanvas implements Canvas {
  private streamTs: string | null = null;
  /** Answer characters streamed this turn, across every message it has taken. */
  private sent = 0;
  /** Answer characters in the streamed message that is live now. */
  private painted = 0;
  /** Set once Slack has ended the stream itself, which its own stop does. */
  private over = false;
  private renewing: Handle | null = null;
  /** Cards still running, so a turn that ends under them can close them. */
  private readonly running = new Map<string, string>();

  constructor(
    private readonly api: SlackApi,
    private readonly log: Log,
    private readonly clock: Clock,
    private readonly thread: ThreadRef,
    private readonly recipient: { userId: string; teamId: string },
    private readonly cap = STREAM_CAP,
  ) {}

  /**
   * Slack's own loading UX, from before the first token, and the state its
   * stop control is drawn on. The renderer calls this every few seconds until
   * the first frame lands, which is also the retry for a first call that
   * failed; the timer armed here is what would carry the status past the hour.
   */
  async working(): Promise<void> {
    this.renew();
    await this.api.session(this.thread.channelId, this.thread.id, 'processing');
  }

  /**
   * Keeps the session `processing` for as long as the turn runs. Slack
   * expires that status an hour after it is set, which a turn reaches only if
   * the harness's own turn cap is raised past it; the timer is armed with the
   * working sign and cancelled by the last frame, so it only ever renews a
   * turn that is genuinely still in flight.
   */
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

  /**
   * The answer so far. `status` is the line Discord paints and Slack has
   * nowhere to put: what the harness is doing is the tool cards' to say.
   */
  async live(text: string, _status: string | null): Promise<void> {
    await this.stream(text);
  }

  /** One tool call, as the card Slack merges by its id and mutates in place. */
  async tool(call: ToolCall): Promise<void> {
    if (call.state === 'in_progress') this.running.set(call.id, call.title);
    else this.running.delete(call.id);
    await this.card(call.id, call.title, call.state);
  }

  /**
   * One card. The title is the only string a model writes that Slack takes
   * as a field of its own, and it folds it into the streamed message's
   * `text` byte for byte: a title of `<@U…>` reads back indistinguishable
   * from a real mention, so it goes through the same escape as the answer.
   */
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
      await this.stream(text, true);
      await this.closeCards(outcome === 'done' ? 'complete' : 'error');
      // A turn with nothing to say still says so, exactly as it does on
      // Discord — except a failed one, whose reason is its own line, and one
      // Slack has already closed the stream on, where a fresh message saying
      // it answered nothing is noise after a stop the human asked for. Cards
      // are not an answer, so a turn that only ran tools still lands here.
      if (this.sent === 0 && outcome !== 'failed' && !this.over) {
        await this.nothing();
      }
    } finally {
      // Whatever the last call did. A message left streaming refuses every
      // later edit, and a thread that still reads as working is a lie: both
      // are worse than a failed call.
      this.rest();
      await this.endStream();
      await this.settle();
    }
  }

  /**
   * Every card still running when the turn ends, settled. `chat.stopStream`
   * stamps one left `in_progress` as `error` on its own — a stream stopped
   * under a running card reads back `status: "error"` — so leaving them is
   * not leaving the harness's last word, it is rendering a failed call on a
   * turn that succeeded. `complete` is what a `done` turn's unfinished card
   * actually is; on a stopped or failed one `error` is Slack's own stamp
   * said deliberately, there being no cancelled state to say better.
   */
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

  /** A message left streaming refuses every later edit, so the stop always goes. */
  private async endStream(): Promise<void> {
    const ts = this.streamTs;
    this.streamTs = null;
    if (!ts || this.over) return;
    await this.api.stopStream(this.thread.channelId, ts).catch((error) => {
      // A stop that landed between the last frame and this one has already
      // ended the stream; there is nothing here that needed doing.
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

  /**
   * `chat.stopStream` already leaves the session `active`, so this is for the
   * turn that streamed nothing and for the one whose stop failed: either way
   * the thread must not be left spinning.
   */
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

  /**
   * One chunk into the turn's stream, opening one when there is none yet. A
   * refusal that means the stream is already over ends the painting rather
   * than the turn: Slack closed the message when the human pressed stop, and
   * opening a second one to hold the rest would be answering past them.
   */
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

  /**
   * Slack took the message out of streaming under a turn that was still
   * painting — which is what its own stop control does, and the usual reason
   * to be here. Nothing is broken, so nothing warns; but the rest of the
   * answer stops arriving, and a thread that ends mid-sentence for any other
   * reason should have somewhere that says why.
   */
  private ended(error: unknown): void {
    this.over = true;
    this.log.info('the stream was already over', {
      threadId: this.thread.id,
      error: plain(error),
    });
  }

  private async stream(text: string, last = false): Promise<void> {
    // The answer as Slack will hold it, so the offset below indexes the same
    // string every frame. A trailing `<` is held back until the next one:
    // the character after it decides whether it opens a mention, and a delta
    // that split the pair would let the halves meet in the rendered message
    // with the escape never having seen them.
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

  /** Seals the message that is full, so the next chunk opens a fresh one. */
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

export interface SlackSurfaceDeps {
  api: SlackApi;
  /** The bot's own user id. */
  me: string;
  /**
   * The app's bot id, which is the only thing every shape of mate's own post
   * carries: `user` is on most of them but not all, and a prior answer read
   * back without it would be filtered out of the transcript replay as some
   * other bot's message.
   */
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

  /** mate's own, however Slack shaped that message, is "you" to the harness. */
  function speaker(message: SlackMessage): string {
    if (message.bot_id === deps.appBotId) return deps.me;
    return message.user ?? message.bot_id ?? '';
  }

  return {
    name: 'slack',
    me: deps.me,
    allowedUserIds: deps.allowedUserIds,
    allowedChannelIds: deps.allowedChannelIds,
    // No call to make and no name to give it: a Slack thread is its parent
    // message, so the mention that started it is the thread — or the thread
    // the mention already landed in.
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
    // A Slack thread is never archived, but its agent session has an end:
    // closing it is what stops the thread reading as one mate is working in.
    async archive(thread) {
      await deps.api.session(thread.channelId, thread.id, 'closed');
    },
    // The session outlives the process that set it, so a turn killed by a
    // restart would leave the thread spinning until the quiet timer tore it
    // down. `active` is the thread ready for the next prompt, which is what
    // it is the moment the restart notice lands.
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

/**
 * The message as the state machine reads it, or null when it is not one.
 *
 * mate reads `message` events and finds mentions by reading the text. The app
 * also holds `app_mentions:read`, and one human sentence delivers both a
 * `message` and an `app_mention` under two different event ids, so answering
 * it once cannot rest on which events the workspace happens to subscribe to —
 * no code can read that setting. It rests on the type check below.
 *
 * mate's own posts come back down the same socket carrying `bot_id` but **no**
 * `bot_message` subtype, so the subtype is not what tells them apart; and
 * every `chat.update` emits a hidden `message_changed`, which is why anything
 * hidden or otherwise subtyped is dropped before it can feed itself.
 */
export function slackInbound(event: SlackEvent, me: string): Inbound | null {
  if (event.type !== 'message') return null;
  // `thread_broadcast` is an ordinary reply the human also sent to the
  // channel, and is the one subtype worth answering.
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
    authorIsBot: Boolean(event.bot_id),
    content: decodeSlack(raw),
    // Read before decoding, so a human typing the escape's own entities
    // cannot conjure a mention out of them.
    mentionsMe: raw.includes(`<@${me}>`),
  };
}

/**
 * Slack's own stop, or null when the event is something else. Slack draws the
 * control itself on a `processing` agent session, and the press arrives as
 * this event rather than as a block action. It names the channel and the
 * thread, which together are exactly a thread's key, and the human who
 * pressed it — so it drops into the same cancel the Discord button asks for,
 * allowlist check and all.
 */
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

/**
 * One inbound event, routed. Slack's own stop and a human's sentence come
 * down the same socket and are told apart only by reading them, so the
 * reading lives here rather than in the wiring, where nothing drives it.
 */
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
