import type { Clock, Handle } from '../src/clock.ts';
import {
  type Discord,
  DiscordCanvas,
  discordSurface,
  type OutMessage,
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

/** Lets every queued promise continuation run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export interface Sent {
  channelId: string;
  id: string;
  content: string;
  hasStop: boolean;
  edits: number;
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

  identifyLimit(_limit: SessionStartLimit): void {}
  gatewayClosed(code: number, fatal: boolean): void {
    this.closes.push({ code, fatal });
  }
  minted(result: MintResult, sample: MintSample): void {
    this.mints.push(result);
    this.mintSamples.push(sample);
  }
  sandboxesLive(count: number): void {
    this.live = count;
  }
  queueDepth(depth: number): void {
    this.queued = depth;
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
  /** Every message in a channel, mate's own included, oldest first. */
  readonly posted: Posted[] = [];
  historyCalls = 0;
  failHistory: Error | null = null;
  /** Holds a history read open, for what lands while the transcript is being read. */
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
  private serial = 0;

  constructor(private readonly me = 'bot') {}

  /** A human message landing in a thread, which is what Discord's log holds. */
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
    this.messages.push({
      channelId,
      id,
      content: body.content,
      hasStop: (body.components?.length ?? 0) > 0,
      edits: 0,
    });
    this.posted.push({
      channelId,
      id,
      authorId: this.me,
      authorName: 'mate',
      authorIsBot: true,
      content: body.content,
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
    message.content = body.content;
    message.hasStop = (body.components?.length ?? 0) > 0;
    message.edits += 1;
    const entry = this.posted.find((m) => m.id === messageId);
    if (entry) entry.content = body.content;
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

  inThread(threadId: string): Sent[] {
    return this.messages.filter((m) => m.channelId === threadId);
  }

  contentsIn(threadId: string): string[] {
    return this.inThread(threadId).map((m) => m.content);
  }

  /** The canvas a turn in this thread paints on, as the real surface builds it. */
  canvas(threadId: string): Canvas {
    return new DiscordCanvas(this, threadId, `discord:${threadId}`);
  }

  surface(options: {
    me: string;
    allowedUserIds: ReadonlySet<string>;
    allowedChannelIds: ReadonlySet<string>;
  }): Surface {
    return discordSurface(this, options);
  }
}

/** A Discord thread as the state machine names it. */
export function discordRef(id: string, channelId: string): ThreadRef {
  return { surface: 'discord', channelId, id };
}
