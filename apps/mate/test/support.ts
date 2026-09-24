import {
  type APIMessageTopLevelComponent,
  ComponentType,
} from 'discord-api-types/v10';
import type { Clock, Handle } from '../src/clock.ts';
import {
  type Discord,
  DiscordCanvas,
  discordSurface,
  type OutMessage,
  STOP_PREFIX,
  spoken,
} from '../src/discord.ts';
import type { SessionStartLimit } from '../src/guard.ts';
import type { Fields, Log } from '../src/log.ts';
import type {
  Instruments,
  MintResult,
  MintSample,
  TeardownReason,
  TurnEnd,
  TurnSample,
} from '../src/metrics.ts';
import type {
  Canvas,
  HistoryMessage,
  HistoryQuery,
  Surface,
  ThreadRef,
} from '../src/surface.ts';

export interface Entry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  fields: Fields | undefined;
}

export class RecordingLog implements Log {
  readonly entries: Entry[] = [];
  info(msg: string, fields?: Fields): void {
    this.entries.push({ level: 'info', msg, fields });
  }
  warn(msg: string, fields?: Fields): void {
    this.entries.push({ level: 'warn', msg, fields });
  }
  error(msg: string, fields?: Fields): void {
    this.entries.push({ level: 'error', msg, fields });
  }
  of(msg: string): Entry[] {
    return this.entries.filter((e) => e.msg === msg);
  }
}

interface Timer {
  at: number;
  fn: () => void;
  seq: number;
}

export class FakeClock implements Clock {
  private time = 1_700_000_000_000;
  private timers: Timer[] = [];
  private seq = 0;

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): Handle {
    const timer = { at: this.time + ms, fn, seq: this.seq++ };
    this.timers.push(timer);
    return timer;
  }

  cancel(handle: Handle): void {
    this.timers = this.timers.filter((t) => t !== handle);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const handle = this.after(ms, resolve);
      signal?.addEventListener('abort', () => {
        this.cancel(handle);
        reject(signal.reason);
      });
    });
  }

  /** Moves time forward, firing due timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await settle();
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await settle();
    }
    this.time = target;
    await settle();
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

/** Yields to the event loop `rounds` times so queued continuations run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface Sent {
  channelId: string;
  id: string;
  /** The answer, or a notice's words. */
  content: string;
  /** Every `-# ` line: status, tool list, footer and mark. */
  subtext: string[];
  hasStop: boolean;
  edits: number;
  /** The body as last sent, for assertions on its wire shape. */
  body: OutMessage;
}

function components(body: OutMessage): APIMessageTopLevelComponent[] {
  return 'components' in body ? body.components : [];
}

function flat(
  list: readonly APIMessageTopLevelComponent[],
): APIMessageTopLevelComponent[] {
  return list.flatMap((c) =>
    c.type === ComponentType.Container ? flat(c.components) : [c],
  );
}

function read(
  body: OutMessage,
): Pick<Sent, 'content' | 'subtext' | 'hasStop' | 'body'> {
  const all = flat(components(body));
  const lines = all.flatMap((c) =>
    c.type === ComponentType.TextDisplay ? c.content.split('\n') : [],
  );
  if ('content' in body) lines.push(body.content);
  return {
    body,
    content: spoken(body),
    subtext: lines.filter((line) => line.startsWith('-# ')),
    hasStop: all.some(
      (c) =>
        c.type === ComponentType.ActionRow &&
        c.components.some(
          (b) => 'custom_id' in b && b.custom_id.startsWith(STOP_PREFIX),
        ),
    ),
  };
}

interface Posted extends HistoryMessage {
  channelId: string;
}

export class RecordingInstruments implements Instruments {
  readonly turns: TurnEnd[] = [];
  readonly teardowns: TeardownReason[] = [];
  readonly samples: TurnSample[] = [];
  readonly mints: MintResult[] = [];
  readonly mintSamples: MintSample[] = [];
  readonly closes: { code: number; fatal: boolean }[] = [];
  started = 0;
  live = 0;
  queued = 0;
  pool: { ready: number; wanted: number } | null = null;
  readonly tokenMints: string[] = [];
  readonly tokenStamps: string[] = [];
  appReady: boolean | null = null;

  identifyLimit(_limit: SessionStartLimit): void {}
  gatewayClosed(code: number, fatal: boolean): void {
    this.closes.push({ code, fatal });
  }
  minted(result: MintResult, sample?: MintSample): void {
    this.mints.push(result);
    if (sample) this.mintSamples.push(sample);
  }
  sandboxesLive(count: number): void {
    this.live = count;
  }
  queueDepth(depth: number): void {
    this.queued = depth;
  }
  githubAppReady(ready: boolean | null): void {
    this.appReady = ready;
  }
  githubTokenMinted(result: string): void {
    this.tokenMints.push(result);
  }
  githubTokenStamped(result: string): void {
    this.tokenStamps.push(result);
  }
  spares(ready: number, wanted: number): void {
    this.pool = { ready, wanted };
  }
  turnStarted(): void {
    this.started += 1;
  }
  turnEnded(reason: TurnEnd, sample: TurnSample): void {
    this.turns.push(reason);
    this.samples.push(sample);
  }
  teardown(reason: TeardownReason): void {
    this.teardowns.push(reason);
  }
}

export class FakeDiscord implements Discord {
  readonly messages: Sent[] = [];
  /** Every message in every channel, mate's own included, oldest first. */
  readonly posted: Posted[] = [];
  historyCalls = 0;
  failHistory: Error | null = null;
  /** While set, history reads wait on it. */
  gateHistory: Promise<void> | null = null;
  readonly threads: {
    channelId: string;
    messageId: string;
    name: string;
    id: string;
  }[] = [];
  readonly archived: string[] = [];
  readonly joined: string[] = [];
  readonly acks: string[] = [];
  typing = 0;
  failCreateThread: Error | null = null;
  failEdits: Error | null = null;
  failDeletes: Error | null = null;
  failReactions: Error | null = null;
  private readonly reactions = new Set<string>();
  private serial = 0;

  constructor(private readonly me = 'bot') {}

  /** A human's message landing in a channel. */
  post(channelId: string, content: string, authorId: string, name = 'jawn') {
    this.posted.push({
      channelId,
      id: `h-${++this.serial}`,
      authorId,
      authorName: name,
      authorIsBot: false,
      content,
    });
  }

  async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    if (this.failCreateThread) throw this.failCreateThread;
    const id = `thread-${++this.serial}`;
    this.threads.push({ channelId, messageId, name, id });
    return id;
  }

  async createMessage(channelId: string, body: OutMessage): Promise<string> {
    const id = `msg-${++this.serial}`;
    const seen = read(body);
    this.messages.push({ channelId, id, ...seen, edits: 0 });
    this.posted.push({
      channelId,
      id,
      authorId: this.me,
      authorName: 'mate',
      authorIsBot: true,
      content: seen.content,
    });
    return id;
  }

  async history(
    channelId: string,
    query: HistoryQuery,
  ): Promise<HistoryMessage[]> {
    this.historyCalls += 1;
    if (this.gateHistory) await this.gateHistory;
    if (this.failHistory) throw this.failHistory;
    const all = this.posted.filter((m) => m.channelId === channelId);
    const end = query.before
      ? all.findIndex((m) => m.id === query.before)
      : all.length;
    return all
      .slice(0, end < 0 ? all.length : end)
      .reverse()
      .slice(0, query.limit);
  }

  async editMessage(
    channelId: string,
    messageId: string,
    body: OutMessage,
  ): Promise<void> {
    if (this.failEdits) throw this.failEdits;
    const message = this.messages.find(
      (m) => m.id === messageId && m.channelId === channelId,
    );
    if (!message) throw new Error(`no message ${messageId}`);
    Object.assign(message, read(body));
    message.edits += 1;
    const entry = this.posted.find((m) => m.id === messageId);
    if (entry) entry.content = message.content;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (this.failDeletes) throw this.failDeletes;
    const at = this.messages.findIndex(
      (m) => m.id === messageId && m.channelId === channelId,
    );
    if (at < 0) throw new Error(`no message ${messageId}`);
    this.messages.splice(at, 1);
    const entry = this.posted.findIndex((m) => m.id === messageId);
    if (entry >= 0) this.posted.splice(entry, 1);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId);
  }

  async joinThread(threadId: string): Promise<void> {
    this.joined.push(threadId);
  }

  async showTyping(): Promise<void> {
    this.typing += 1;
  }

  async ackUpdate(interactionId: string): Promise<void> {
    this.acks.push(interactionId);
  }

  async react(channelId: string, messageId: string, emoji: string) {
    if (this.failReactions) throw this.failReactions;
    this.reactions.add(`${channelId}/${messageId}/${emoji}`);
  }

  async unreact(channelId: string, messageId: string, emoji: string) {
    this.reactions.delete(`${channelId}/${messageId}/${emoji}`);
  }

  /** mate's own reactions on one message, in the order they were added. */
  reactionsOn(channelId: string, messageId: string): string[] {
    const prefix = `${channelId}/${messageId}/`;
    return [...this.reactions]
      .filter((r) => r.startsWith(prefix))
      .map((r) => r.slice(prefix.length));
  }

  inThread(threadId: string): Sent[] {
    return this.messages.filter((m) => m.channelId === threadId);
  }

  contentsIn(threadId: string): string[] {
    return this.inThread(threadId).map((m) => m.content);
  }

  /** Built the way the real surface builds it. */
  canvas(threadId: string, clock: Clock = new FakeClock()): Canvas {
    return new DiscordCanvas(this, threadId, `discord:${threadId}`, clock);
  }

  surface(options: {
    me: string;
    allowedUserIds: ReadonlySet<string>;
    allowedChannelIds: ReadonlySet<string>;
    clock?: Clock;
  }): Surface {
    return discordSurface(this, { clock: new FakeClock(), ...options });
  }
}

export function discordRef(id: string, channelId: string): ThreadRef {
  return { surface: 'discord', channelId, id };
}
