/**
 * Slack as a surface. Socket Mode carries everything inbound (`socket.ts`);
 * outbound is six Web API calls on Bun's own `fetch`, which is the whole of
 * what mate needs and is why no `@slack/*` package is here — they declare a
 * Node engine, and the Kubernetes client in this same process already took
 * the raw path for the same reason.
 *
 * What Slack does differently from Discord, and why the canvas below looks
 * nothing like the Discord one:
 *
 * - Slack streams. `chat.startStream` / `appendStream` / `stopStream` take
 *   deltas, so an answer is appended rather than a message rewritten, and
 *   nothing has to be chunked at a message cap the way Discord's 2000
 *   characters force.
 * - Because the answer is append-only, the status line cannot sit above it.
 *   It goes on a control message of its own, which also carries Stop and is
 *   deleted when the turn ends — `chat.update` against a message that is
 *   streaming is refused, so the button could not live on the answer anyway.
 * - In a channel the stream is addressed: `thread_ts`, `recipient_user_id`
 *   and `recipient_team_id` are all required. The mention that opened the
 *   thread is its parent, so mate has all three without asking for them.
 */
import type { Clock } from './clock.ts';
import { type Log, plain } from './log.ts';
import { NO_REPLY, PLACEHOLDER, splitAt, statusLine } from './reply.ts';
import {
  type Canvas,
  type HistoryMessage,
  type Inbound,
  type Outcome,
  type Surface,
  type ThreadRef,
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
export const STOP_ACTION = 'mate-stop';
/** One read of a thread, bounded: the replay only ever wants the newest few. */
const REPLIES_PAGE = 200;
const REPLIES_PAGES = 5;

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

export interface StreamStart {
  channel: string;
  threadTs: string;
  userId: string;
  teamId: string;
  markdown: string;
}

/** The six calls and the lookup mate makes; the fake in tests records them. */
export interface SlackApi {
  post(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
  ): Promise<string>;
  update(
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<void>;
  remove(channel: string, ts: string): Promise<void>;
  startStream(args: StreamStart): Promise<string>;
  appendStream(channel: string, ts: string, markdown: string): Promise<void>;
  stopStream(channel: string, ts: string): Promise<void>;
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

  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${SLACK_API}${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
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
        throw new Error(`${method}: HTTP ${response.status}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (payload.ok !== true) {
        throw new Error(`${method}: ${payload.error ?? response.status}`);
      }
      return payload;
    }
  }

  return {
    async post(channel, threadTs, text, blocks) {
      const sent = await call('chat.postMessage', {
        channel,
        thread_ts: threadTs,
        text,
        ...(blocks ? { blocks } : {}),
      });
      return String(sent.ts);
    },
    async update(channel, ts, text, blocks) {
      await call('chat.update', {
        channel,
        ts,
        text,
        ...(blocks ? { blocks } : {}),
      });
    },
    async remove(channel, ts) {
      await call('chat.delete', { channel, ts });
    },
    async startStream(args) {
      const started = await call('chat.startStream', {
        channel: args.channel,
        thread_ts: args.threadTs,
        recipient_user_id: args.userId,
        recipient_team_id: args.teamId,
        markdown_text: args.markdown,
      });
      return String(started.ts);
    },
    async appendStream(channel, ts, markdown) {
      await call('chat.appendStream', { channel, ts, markdown_text: markdown });
    },
    async stopStream(channel, ts) {
      await call('chat.stopStream', { channel, ts });
    },
    async replies(channel, threadTs) {
      const all: SlackMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < REPLIES_PAGES; page += 1) {
        const read = await call('conversations.replies', {
          channel,
          ts: threadTs,
          limit: REPLIES_PAGE,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...((read.messages ?? []) as SlackMessage[]));
        const meta = read.response_metadata as
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
        const read = await call('users.info', { user: userId });
        const user = read.user as
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
      const auth = await call('auth.test', {});
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

function stopBlock(key: string): Record<string, unknown> {
  return {
    type: 'actions',
    block_id: STOP_ACTION,
    elements: [
      {
        type: 'button',
        style: 'danger',
        action_id: STOP_ACTION,
        value: key,
        text: { type: 'plain_text', text: 'Stop' },
      },
    ],
  };
}

/**
 * The control message's body: the status line, then Stop. `text` on a message
 * that carries `blocks` is only the fallback a notification shows — the
 * rendered body is the blocks alone — so the line the human reads has to be a
 * block of its own, and `text` stays what the notification says.
 */
export function controlBlocks(
  text: string,
  key: string,
): Record<string, unknown>[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }, stopBlock(key)];
}

/**
 * One turn in a Slack thread: the answer streamed into a message of its own,
 * and a control message beside it holding the status line and Stop until the
 * turn ends.
 */
export class SlackCanvas implements Canvas {
  private streamTs: string | null = null;
  /** Characters streamed this turn, across every message it has taken. */
  private sent = 0;
  /** Characters in the streamed message that is live now. */
  private painted = 0;
  private controlTs: string | null = null;
  private controlText = '';

  constructor(
    private readonly api: SlackApi,
    private readonly log: Log,
    private readonly thread: ThreadRef,
    private readonly recipient: { userId: string; teamId: string },
    private readonly key: string,
    private readonly cap = STREAM_CAP,
  ) {}

  async live(text: string, status: string | null): Promise<void> {
    await this.stream(text);
    await this.control(status ? escapeSlack(statusLine(status)) : PLACEHOLDER);
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    try {
      await this.stream(text, true);
      if (this.streamTs) {
        await this.api.stopStream(this.thread.channelId, this.streamTs);
        this.streamTs = null;
      } else if (this.sent === 0 && outcome !== 'failed') {
        // A turn with nothing to show still says so, exactly as it does on
        // Discord — except a failed one, whose reason is its own line.
        await this.api.post(
          this.thread.channelId,
          this.thread.id,
          escapeSlack(NO_REPLY),
        );
      }
    } finally {
      // Whatever the last call did: a live Stop button on a finished turn is
      // worse than a turn that ended with one failed call.
      await this.clearControl();
    }
  }

  private async stream(text: string, last = false): Promise<void> {
    // The answer as Slack will hold it, so the offset below indexes the same
    // string every frame. A trailing `<` is held back until the next one:
    // the character after it decides whether it opens a mention, and a delta
    // that split the pair would let the halves meet in the rendered message
    // with the escape never having seen them.
    const whole = last || !text.endsWith('<') ? text : text.slice(0, -1);
    let tail = escapeMentions(whole).slice(this.sent);
    while (tail) {
      if (this.streamTs && this.painted >= this.cap) {
        await this.api.stopStream(this.thread.channelId, this.streamTs);
        this.streamTs = null;
        this.painted = 0;
      }
      const [head, rest] = splitAt(tail, this.cap - this.painted);
      if (this.streamTs) {
        await this.api.appendStream(this.thread.channelId, this.streamTs, head);
      } else {
        this.streamTs = await this.api.startStream({
          channel: this.thread.channelId,
          threadTs: this.thread.id,
          userId: this.recipient.userId,
          teamId: this.recipient.teamId,
          markdown: head,
        });
      }
      this.sent += head.length;
      this.painted += head.length;
      tail = rest;
    }
  }

  private async control(text: string): Promise<void> {
    const blocks = controlBlocks(text, this.key);
    if (!this.controlTs) {
      this.controlTs = await this.api.post(
        this.thread.channelId,
        this.thread.id,
        text,
        blocks,
      );
      this.controlText = text;
      return;
    }
    // Only when it actually changed: an edit per second would spend the
    // method's whole per-minute allowance on a line that rarely moves.
    if (text === this.controlText) return;
    this.controlText = text;
    await this.api.update(this.thread.channelId, this.controlTs, text, blocks);
  }

  /** A button that outlives its turn is worse than one that fails to go away quietly. */
  private async clearControl(): Promise<void> {
    const ts = this.controlTs;
    this.controlTs = null;
    if (!ts) return;
    await this.api.remove(this.thread.channelId, ts).catch((error) =>
      this.log.warn('the stop button could not be removed', {
        threadId: this.thread.id,
        error: plain(error),
      }),
    );
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
        thread,
        { userId: asker, teamId: deps.teamId },
        threadKey(thread),
        deps.streamCap,
      );
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

export interface BlockActions {
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
}

/** The Stop click, or null when the payload is some other interaction. */
export function slackStop(
  payload: BlockActions,
): { key: string; userId: string } | null {
  const action = payload.actions?.find(
    (candidate) => candidate.action_id === STOP_ACTION,
  );
  if (!action?.value) return null;
  return { key: action.value, userId: payload.user?.id ?? '' };
}
