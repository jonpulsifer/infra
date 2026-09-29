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
import type {
  HandsCallResult,
  HandsConnectResult,
  HandsConnectSample,
  HandsDropReason,
  MintResult,
  MintSample,
  TeardownReason,
  TurnSandboxSource,
} from '../src/lease.ts';
import type { Fields, Log } from '../src/log.ts';
import type {
  ChatgptSignIn,
  Instruments,
  ProviderErrorKind,
  StoreOp,
  TurnEnd,
  TurnResumeResult,
  TurnSample,
} from '../src/metrics.ts';
import type { Failure, Route, RouteReason } from '../src/route.ts';
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
  private timers: Timer[] = [];
  private seq = 0;

  /** pi reads `Date.now()` itself, so a test that shares a token's expiry with it starts there. */
  constructor(private time = 1_700_000_000_000) {}

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
  readonly resumes: TurnResumeResult[] = [];
  readonly tools: { tool: string; isError: boolean }[] = [];
  readonly providerErrors: ProviderErrorKind[] = [];
  readonly storeFailures: StoreOp[] = [];
  readonly turnSandboxes: TurnSandboxSource[] = [];
  readonly connects: HandsConnectResult[] = [];
  readonly calls: { method: string; result: HandsCallResult }[] = [];
  readonly drops: HandsDropReason[] = [];
  readonly mcpCalls: string[] = [];
  started = 0;
  live = 0;
  waiters = 0;
  queued = 0;
  running = 0;
  mcp: boolean | null = null;
  pool: { ready: number; wanted: number } | null = null;
  readonly tokenMints: string[] = [];
  readonly tokenStamps: string[] = [];
  readonly siteSyncs: string[] = [];
  appReady: boolean | null = null;
  /** Every sign-in state reported, oldest first. */
  readonly chatgptStates: (ChatgptSignIn | null)[] = [];
  readonly routes: { route: Route; reason: RouteReason | null }[] = [];
  readonly failures: Failure[] = [];
  primary: boolean | null = null;

  identifyLimit(_limit: SessionStartLimit): void {}
  chatgpt(state: ChatgptSignIn | null): void {
    this.chatgptStates.push(state);
  }
  modelRouted(route: Route, reason: RouteReason | null): void {
    this.routes.push({ route, reason });
  }
  primaryFailed(reason: Failure): void {
    this.failures.push(reason);
  }
  primaryUp(up: boolean | null): void {
    this.primary = up;
  }
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
  sandboxWaiters(count: number): void {
    this.waiters = count;
  }
  queueDepth(depth: number): void {
    this.queued = depth;
  }
  turnsRunning(count: number): void {
    this.running = count;
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
  kthxSitesSynced(result: string): void {
    this.siteSyncs.push(result);
  }
  spares(ready: number, wanted: number): void {
    this.pool = { ready, wanted };
  }
  handsConnected(result: HandsConnectResult, _sample: HandsConnectSample) {
    this.connects.push(result);
  }
  handsCall(method: string, result: HandsCallResult, _ms: number): void {
    this.calls.push({ method, result });
  }
  handsDropped(reason: HandsDropReason): void {
    this.drops.push(reason);
  }
  turnSandbox(source: TurnSandboxSource): void {
    this.turnSandboxes.push(source);
  }
  mcpUp(up: boolean): void {
    this.mcp = up;
  }
  mcpCall(result: string): void {
    this.mcpCalls.push(result);
  }
  turnStarted(): void {
    this.started += 1;
  }
  turnEnded(reason: TurnEnd, sample: TurnSample): void {
    this.turns.push(reason);
    this.samples.push(sample);
  }
  turnResumed(result: TurnResumeResult): void {
    this.resumes.push(result);
  }
  toolEnded(tool: string, isError: boolean): void {
    this.tools.push({ tool, isError });
  }
  providerError(kind: ProviderErrorKind): void {
    this.providerErrors.push(kind);
  }
  storeFailed(op: StoreOp): void {
    this.storeFailures.push(op);
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
  /** Direct messages, which live outside every thread. */
  readonly dms: { userId: string; content: string }[] = [];
  failDirectMessages: Error | null = null;
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

  async directMessage(userId: string, body: OutMessage): Promise<string> {
    if (this.failDirectMessages) throw this.failDirectMessages;
    this.dms.push({ userId, content: spoken(body) });
    return `dm-${++this.serial}`;
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
