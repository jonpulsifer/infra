/**
 * Slack as a surface: Socket Mode inbound (`socket.ts`) and a few Web API calls
 * on Bun's `fetch`, since the `@slack/*` packages declare a Node engine.
 */
import { type Clock, duration, type Handle } from './clock.ts';
import { SANDBOX_CARD_ID } from './lease.ts';
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
// Slack silently drops a plan's tasks past the 50th.
export const PLAN_ROWS = 49;
// Slack adds each chunk's `details` to what the task holds, and took 600
// characters in one; a row's sum stays inside that.
export const DETAILS_MAX = 600;
/** Kept free in a full row for the count of the calls it could not list. */
const MORE_ROOM = 16;
/** The plan's running title changes at most this often. */
export const TITLE_CADENCE_MS = 3_000;

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

/** The parts of a `rich_text` element the replay reads. */
export interface RichElement {
  type: string;
  text?: string;
  url?: string;
  name?: string;
  range?: string;
  user_id?: string;
  channel_id?: string;
  usergroup_id?: string;
  /** A text's `{ bold, italic, strike, code }`, or a list's `bullet` or `ordered`. */
  style?: unknown;
  elements?: RichElement[];
}

export interface SlackBlock {
  type: string;
  text?: unknown;
  elements?: RichElement[];
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  thread_ts?: string;
  blocks?: SlackBlock[];
}

/**
 * What mate said in a message: Slack folds a plan's title, and every timeline
 * card's, into `text`, so the answer is read from the blocks that hold it.
 */
export function spokenSlack(message: SlackMessage): string {
  const blocks = message.blocks ?? [];
  if (blocks.length === 0) return decodeSlack(message.text ?? '');
  return blocks.map(blockText).join('');
}

function blockText(block: SlackBlock): string {
  if (block.type === 'markdown') {
    return typeof block.text === 'string' ? block.text : '';
  }
  if (block.type !== 'rich_text') return '';
  return (block.elements ?? []).map(richText).join('');
}

function richText(element: RichElement): string {
  const inner = element.elements ?? [];
  const flat = () => inner.map(inline).join('');
  switch (element.type) {
    case 'rich_text_section':
      return flat();
    case 'rich_text_list':
      return `${inner
        .map(
          (item, i) =>
            `${element.style === 'ordered' ? `${i + 1}.` : '-'} ${richText(item)}`,
        )
        .join('\n')}\n`;
    case 'rich_text_preformatted':
      return `\`\`\`\n${flat()}\n\`\`\`\n`;
    case 'rich_text_quote':
      return `> ${flat()}\n`;
    default:
      return inline(element);
  }
}

// A mention reads back in the escape a human's message carries.
function inline(element: RichElement): string {
  switch (element.type) {
    case 'text':
      return styled(element.text ?? '', element.style);
    case 'link':
      return element.text
        ? `[${element.text}](${element.url})`
        : (element.url ?? '');
    case 'user':
      return `<@${element.user_id}>`;
    case 'channel':
      return `<#${element.channel_id}>`;
    case 'usergroup':
      return `<!subteam^${element.usergroup_id}>`;
    case 'broadcast':
      return `<!${element.range}>`;
    case 'emoji':
      return `:${element.name}:`;
    default:
      return element.text ?? '';
  }
}

// Back to the markdown mate streamed, so `*stopped*` still reads as a notice.
function styled(text: string, style: unknown): string {
  const on = (style ?? {}) as Record<string, unknown>;
  let out = text;
  if (on.code) out = `\`${out}\``;
  if (on.italic) out = `*${out}*`;
  if (on.bold) out = `**${out}**`;
  if (on.strike) out = `~~${out}~~`;
  return out;
}

// In a `plan` stream every task is a row of one block. Slack merges
// `task_update` chunks by `id`, and appends each one's `details` to the row's.
export type StreamChunk =
  | { type: 'markdown_text'; text: string }
  | { type: 'plan_update'; title: string }
  | {
      type: 'task_update';
      id: string;
      title: string;
      status: ToolState;
      details?: string;
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
  /** `chunks` land with the stop, as the stream's last frame. */
  stopStream(
    channel: string,
    ts: string,
    chunks?: StreamChunk[],
  ): Promise<void>;
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
        // A plan keeps the title mate gives it through the stop; an untitled
        // one stopped over an open task retitles itself "Something went wrong".
        task_display_mode: 'plan',
        // Opened with chunks: a `markdown_text` stream refuses them later with
        // `streaming_mode_mismatch`.
        chunks: args.chunks,
      });
      return String(started.ts);
    },
    async appendStream(channel, ts, chunks) {
      await call('chat.appendStream', { channel, ts, chunks });
    },
    async stopStream(channel, ts, chunks = []) {
      await call('chat.stopStream', {
        channel,
        ts,
        ...(chunks.length > 0 ? { chunks } : {}),
      });
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

interface Row {
  readonly id: string;
  title: string;
  status: ToolState;
  /** The `details` characters sent, which Slack keeps adding up. */
  written: number;
  /** Finished calls past the details budget, counted instead of listed. */
  hidden: number;
  failed: boolean;
  running: number;
}

interface Running {
  title: string;
  /** Null once a roll has closed the plan the call started in. */
  row: Row | null;
}

const MARK = { complete: '✓', error: '✗' } as const;

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Mentions are escaped: `<@U…>` in a title or details is a real mention.
function taskChunk(row: Row, details: string): StreamChunk {
  return {
    type: 'task_update',
    id: row.id,
    title: escapeMentions(row.title),
    status: row.status,
    ...(details ? { details } : {}),
  };
}

/**
 * A turn's tool work as plan rows: a sentence of narration, or a call made
 * before any, opens a phase, and each call lands in its phase's details as a
 * line once it finishes. Rows belong to one stream's plan; a call finishing
 * after a roll lands in the next.
 */
class Phases {
  private rows: Row[] = [];
  private current: Row | null = null;
  private readonly running = new Map<string, Running>();
  private readonly commands = new Set<string>();
  private steps = 0;
  private readonly touched = new Map<Row, string>();

  step(text: string): StreamChunk[] {
    this.open(oneLine(text));
    return this.flush();
  }

  tool(call: ToolCall): StreamChunk[] {
    // Discord's footer does not count the lease either.
    if (call.id !== SANDBOX_CARD_ID) this.commands.add(call.id);
    const known = this.running.get(call.id);
    if (call.state === 'in_progress') {
      if (known) {
        known.title = call.title;
      } else {
        const row = this.current ?? this.open(call.title);
        row.running += 1;
        this.running.set(call.id, { title: call.title, row });
      }
      return this.flush();
    }
    this.running.delete(call.id);
    const row = known?.row ?? this.current ?? this.open(call.title);
    if (known?.row) row.running -= 1;
    this.note(row, call.title, call.state);
    this.release(row);
    return this.flush();
  }

  /**
   * Closes every row of the plan. `null` is a roll: its calls run on into the
   * next stream. A row with a failed call is `complete`, since agents fail
   * commands harmlessly all the time, unless the turn itself failed.
   */
  close(outcome: Outcome | null): StreamChunk[] {
    if (outcome) {
      const state = outcome === 'done' ? 'complete' : 'error';
      for (const call of this.running.values()) {
        this.note(
          call.row ?? this.current ?? this.open(call.title),
          call.title,
          state,
        );
      }
      this.running.clear();
    }
    for (const row of this.rows) {
      const open = row.status === 'in_progress';
      const failed =
        (open && outcome !== null && outcome !== 'done') ||
        (outcome === 'failed' && row.failed);
      const status = failed ? 'error' : open ? 'complete' : row.status;
      if (status !== row.status || row.hidden > 0) this.settle(row, status);
    }
    this.current = null;
    return this.flush();
  }

  /** After a roll: the next stream's plan starts empty. */
  reset(): void {
    this.rows = [];
    this.current = null;
    this.touched.clear();
    for (const call of this.running.values()) call.row = null;
  }

  /** The title while the turn runs: the newest call running, or the tally. */
  live(): string {
    const newest = [...this.running.values()].at(-1);
    return newest ? `${newest.title}…` : `Working · ${this.tally()}…`;
  }

  /** The turn in one line, with the outcomes of Discord's footer. */
  summary(outcome: Outcome, ms: number): string {
    const facts = `${this.tally()} · ${duration(ms)}`;
    if (outcome === 'stopped') return `⏹️ Stopped · ${facts}`;
    if (outcome === 'failed') return `⚠️ Failed · ${facts}`;
    return this.commands.size > 0 ? `Ran ${facts}` : facts;
  }

  private tally(): string {
    const steps = count(this.steps, 'step');
    return this.commands.size > 0
      ? `${count(this.commands.size, 'command')} in ${steps}`
      : steps;
  }

  private open(title: string): Row {
    this.steps += 1;
    const last = this.rows.at(-1);
    if (last && this.rows.length >= PLAN_ROWS) {
      last.title = title;
      last.status = 'in_progress';
      this.current = last;
      this.touch(last);
      return last;
    }
    const previous = this.current;
    const row: Row = {
      id: `phase-${this.rows.length + 1}`,
      title,
      status: 'in_progress',
      written: 0,
      hidden: 0,
      failed: false,
      running: 0,
    };
    this.rows.push(row);
    this.current = row;
    if (previous) this.release(previous);
    this.touch(row);
    return row;
  }

  // Slack only appends to details, so a line is written once, finished. Past
  // the budget the earliest lines stay, and the rest become a count.
  private note(row: Row, title: string, state: 'complete' | 'error'): void {
    if (state === 'error') row.failed = true;
    const line = escapeMentions(`${MARK[state]} ${oneLine(title)}`);
    const text = row.written > 0 ? `\n${line}` : line;
    if (row.hidden > 0 || row.written + text.length > DETAILS_MAX - MORE_ROOM) {
      row.hidden += 1;
      return;
    }
    row.written += text.length;
    this.touch(row, text);
  }

  /** A row stays open while it is the current phase or a call under it runs. */
  private release(row: Row): void {
    if (row === this.current || row.running > 0) return;
    if (row.status === 'in_progress') this.settle(row, 'complete');
  }

  private settle(row: Row, status: ToolState): void {
    row.status = status;
    let more = '';
    if (row.hidden > 0) {
      more = `${row.written > 0 ? '\n' : ''}…${row.hidden} more`;
      row.written += more.length;
      row.hidden = 0;
    }
    this.touch(row, more);
  }

  private touch(row: Row, details = ''): void {
    this.touched.set(row, `${this.touched.get(row) ?? ''}${details}`);
  }

  private flush(): StreamChunk[] {
    const chunks = [...this.touched].map(([row, details]) =>
      taskChunk(row, details),
    );
    this.touched.clear();
    return chunks;
  }
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
  private readonly phases = new Phases();
  /** The live stream holds a plan, which has had a title from its first chunk. */
  private planned = false;
  private title: string | null = null;
  private titledAt = Number.NEGATIVE_INFINITY;
  private retitling: Handle | null = null;
  private ending = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly startedAt: number;

  constructor(
    private readonly api: SlackApi,
    private readonly log: Log,
    private readonly clock: Clock,
    private readonly thread: ThreadRef,
    private readonly recipient: { userId: string; teamId: string },
    private readonly cap = STREAM_CAP,
  ) {
    this.startedAt = clock.now();
  }

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
  // does nothing there, so the plan's title carries it.
  async live(text: string, _status: string | null): Promise<void> {
    await this.serial(() => this.stream(text));
  }

  async tool(call: ToolCall): Promise<void> {
    await this.serial(() => this.send(this.phases.tool(call)));
  }

  async step(text: string): Promise<void> {
    await this.serial(() => this.send(this.phases.step(text)));
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    await this.serial(() => this.finish(text, outcome));
  }

  // The title's timer writes between the renderer's frames, and Slack keeps
  // the order the calls land in.
  private serial(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async finish(text: string, outcome: Outcome): Promise<void> {
    this.ending = true;
    this.unschedule();
    try {
      await this.stream(
        outcome === 'stopped' ? `${text}${text ? '\n\n' : ''}${STOPPED}` : text,
        true,
      );
      // A plan is not an answer. A failed turn has its own line, and after
      // the human's stop a "no reply" is noise.
      if (this.sent === 0 && outcome !== 'failed' && !this.over) {
        await this.nothing();
      }
    } finally {
      // Always: a message left streaming refuses later edits, and the thread
      // would keep spinning.
      this.rest();
      await this.endStream(outcome);
      await this.settle();
    }
  }

  // The plan's closes and title ride the stop: Slack turns a task left
  // `in_progress` to `error`, and retitles an untitled plan.
  private async endStream(outcome: Outcome): Promise<void> {
    const ts = this.streamTs;
    this.streamTs = null;
    if (!ts || this.over) return;
    await this.api
      .stopStream(this.thread.channelId, ts, this.closing(outcome))
      .catch((error) => {
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
    this.planned = false;
  }

  /** A roll passes `null`: the turn goes on, so its title is the tally so far. */
  private closing(outcome: Outcome | null): StreamChunk[] {
    const closes = this.phases.close(outcome);
    if (!this.planned && closes.length === 0) return [];
    const title = this.phases.summary(
      outcome ?? 'done',
      this.clock.now() - this.startedAt,
    );
    return [...closes, { type: 'plan_update', title }];
  }

  private async nothing(): Promise<void> {
    if (this.streamTs) {
      await this.send([{ type: 'markdown_text', text: NO_REPLY }]);
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
  private async send(chunks: StreamChunk[]): Promise<void> {
    if (this.over) return;
    const tasks = chunks.some((chunk) => chunk.type === 'task_update');
    const batch =
      this.planned || tasks
        ? [...this.retitle(!this.planned), ...chunks]
        : chunks;
    if (batch.length === 0) return;
    try {
      if (this.streamTs) {
        await this.api.appendStream(
          this.thread.channelId,
          this.streamTs,
          batch,
        );
      } else {
        this.streamTs = await this.api.startStream({
          channel: this.thread.channelId,
          threadTs: this.thread.id,
          userId: this.recipient.userId,
          teamId: this.recipient.teamId,
          chunks: batch,
        });
      }
      if (tasks) this.planned = true;
    } catch (error) {
      if (!alreadyOver(error)) throw error;
      this.ended(error);
      this.streamTs = null;
    }
  }

  // A plan's first chunk always carries a title: one stopped untitled reads
  // "Something went wrong". Later titles wait out the cadence.
  private retitle(first: boolean): StreamChunk[] {
    if (this.ending && !first) return [];
    const title = escapeMentions(this.phases.live());
    if (!first && title === this.title) return [];
    const wait = this.titledAt + TITLE_CADENCE_MS - this.clock.now();
    if (!first && wait > 0) {
      this.schedule(wait);
      return [];
    }
    this.unschedule();
    this.title = title;
    this.titledAt = this.clock.now();
    return [{ type: 'plan_update', title }];
  }

  private schedule(wait: number): void {
    if (this.retitling) return;
    this.retitling = this.clock.after(wait, () => {
      this.retitling = null;
      void this.serial(() => this.send([])).catch((error) =>
        this.log.warn('the plan title could not be updated', {
          threadId: this.thread.id,
          error: plain(error),
        }),
      );
    });
  }

  private unschedule(): void {
    if (this.retitling) this.clock.cancel(this.retitling);
    this.retitling = null;
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
      await this.send([{ type: 'markdown_text', text: head }]);
      this.sent += head.length;
      this.painted += head.length;
      tail = rest;
    }
  }

  // The rolled message keeps its plan, closed and titled; a call after the
  // roll opens a plan of its own in the next one.
  private async roll(): Promise<void> {
    const ts = this.streamTs;
    if (!ts) return;
    try {
      await this.api.stopStream(this.thread.channelId, ts, this.closing(null));
    } catch (error) {
      if (!alreadyOver(error)) throw error;
      this.ended(error);
    }
    this.streamTs = null;
    this.painted = 0;
    this.planned = false;
    this.phases.reset();
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
          content:
            message.bot_id === deps.appBotId
              ? spokenSlack(message)
              : decodeSlack(message.text ?? ''),
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
