/**
 * `FakeSurface` uses no Discord or Slack types, and declares `settle` but not
 * `archive` to drive both sides of an optional capability.
 */
import type {
  SessionStatus,
  SlackApi,
  SlackMessage,
  StreamChunk,
  StreamStart,
} from '../src/slack.ts';
import type { SocketLike } from '../src/socket.ts';
import type {
  Canvas,
  HistoryMessage,
  HistoryQuery,
  Inbound,
  Notice,
  Outcome,
  Surface,
  SurfaceName,
  ThreadRef,
  ToolCall,
} from '../src/surface.ts';

export interface Frame {
  text: string;
  status: string | null;
  outcome: Outcome | null;
}

export class FakeCanvas implements Canvas {
  readonly frames: Frame[] = [];
  readonly cards: ToolCall[] = [];
  /** What the agent said between tool calls. */
  readonly steps: string[] = [];
  working_ = 0;
  failTool: Error | null = null;
  failStep: Error | null = null;

  async live(text: string, status: string | null): Promise<void> {
    this.frames.push({ text, status, outcome: null });
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    this.frames.push({ text, status: null, outcome });
  }

  async working(): Promise<void> {
    this.working_ += 1;
  }

  async tool(call: ToolCall): Promise<void> {
    if (this.failTool) throw this.failTool;
    this.cards.push(call);
  }

  async step(text: string): Promise<void> {
    if (this.failStep) throw this.failStep;
    this.steps.push(text);
  }

  get answer(): string {
    return this.frames.at(-1)?.text ?? '';
  }

  get outcome(): Outcome | null {
    return this.frames.at(-1)?.outcome ?? null;
  }
}

interface Posted extends HistoryMessage {
  threadId: string;
}

export type NoticeCall =
  | { call: 'post'; id: string; text: string }
  | { call: 'edit'; id: string; text: string }
  | { call: 'remove'; id: string };

/** Held in `posted`, as a real notice is, so the transcript replay sees it. */
class FakeNotice implements Notice {
  constructor(
    private readonly surface: FakeSurface,
    private readonly threadId: string,
  ) {}

  private id: string | null = null;

  async say(text: string): Promise<void> {
    if (this.surface.failNotice) throw this.surface.failNotice;
    this.surface.notices.push(text);
    const held = this.id && this.surface.find(this.id);
    if (held) {
      held.content = text;
      this.surface.noticeCalls.push({ call: 'edit', id: held.id, text });
      return;
    }
    const id = this.surface.say(
      this.threadId,
      text,
      this.surface.me,
      'mate',
      true,
    );
    this.id = id;
    this.surface.noticeCalls.push({ call: 'post', id, text });
  }

  async done(text: string | null): Promise<void> {
    if (text !== null) {
      await this.say(text);
      return;
    }
    if (this.surface.failNotice) throw this.surface.failNotice;
    const id = this.id;
    this.id = null;
    if (!id) return;
    this.surface.remove(id);
    this.surface.noticeCalls.push({ call: 'remove', id });
  }
}

export class FakeSurface implements Surface {
  readonly name: SurfaceName = 'slack';
  readonly canvases = new Map<string, FakeCanvas>();
  readonly posted: Posted[] = [];
  readonly opened: { channelId: string; messageId: string; title: string }[] =
    [];
  readonly askers: string[] = [];
  readonly settled: string[] = [];
  /** Every line a notice was given, including ones since rewritten or removed. */
  readonly notices: string[] = [];
  /** Tells a rewrite in place from a removal followed by a new post. */
  readonly noticeCalls: NoticeCall[] = [];
  failNotice: Error | null = null;
  private serial = 0;

  constructor(
    readonly me: string,
    readonly allowedUserIds: ReadonlySet<string>,
    readonly allowedChannelIds: ReadonlySet<string>,
  ) {}

  async openThread(message: Inbound, title: string): Promise<ThreadRef> {
    this.opened.push({
      channelId: message.channelId,
      messageId: message.id,
      title,
    });
    return {
      surface: this.name,
      channelId: message.channelId,
      id: message.threadId ?? message.id,
    };
  }

  async post(thread: ThreadRef, text: string): Promise<void> {
    this.say(thread.id, text, this.me, 'mate', true);
  }

  async history(
    thread: ThreadRef,
    query: HistoryQuery,
  ): Promise<HistoryMessage[]> {
    const all = this.posted.filter((m) => m.threadId === thread.id);
    const end = query.before
      ? all.findIndex((m) => m.id === query.before)
      : all.length;
    return all
      .slice(0, end < 0 ? all.length : end)
      .reverse()
      .slice(0, query.limit);
  }

  async settle(thread: ThreadRef): Promise<void> {
    this.settled.push(thread.id);
  }

  notice(thread: ThreadRef): Notice {
    return new FakeNotice(this, thread.id);
  }

  find(id: string): Posted | undefined {
    return this.posted.find((m) => m.id === id);
  }

  remove(id: string): void {
    const at = this.posted.findIndex((m) => m.id === id);
    if (at >= 0) this.posted.splice(at, 1);
  }

  canvas(thread: ThreadRef, asker: string): Canvas {
    this.askers.push(asker);
    const canvas = new FakeCanvas();
    this.canvases.set(thread.id, canvas);
    return canvas;
  }

  say(
    threadId: string,
    content: string,
    authorId: string,
    authorName = 'jawn',
    authorIsBot = false,
  ): string {
    const id = `s-${++this.serial}`;
    this.posted.push({
      threadId,
      id,
      authorId,
      authorName,
      authorIsBot,
      content,
    });
    return id;
  }

  answerIn(threadId: string): string {
    return this.canvases.get(threadId)?.answer ?? '';
  }

  linesIn(threadId: string): string[] {
    return this.posted
      .filter((m) => m.threadId === threadId && m.authorId === this.me)
      .map((m) => m.content);
  }
}

export type SlackCall =
  | { call: 'post'; channel: string; threadTs: string; text: string }
  | { call: 'edit'; ts: string; text: string }
  | { call: 'remove'; ts: string }
  | { call: 'start'; args: StreamStart }
  | { call: 'append'; ts: string; chunks: StreamChunk[] }
  | { call: 'stop'; ts: string }
  | { call: 'session'; threadTs: string; status: SessionStatus };

export class FakeSlack implements SlackApi {
  readonly calls: SlackCall[] = [];
  readonly thread: SlackMessage[] = [];
  readonly names = new Map<string, string>();
  failStopStream: Error | null = null;
  failSession: Error | null = null;
  failAppend: Error | null = null;
  failStart: Error | null = null;
  failEdit: Error | null = null;
  private serial = 0;

  async post(channel: string, threadTs: string, text: string): Promise<string> {
    const ts = `p-${++this.serial}`;
    this.calls.push({ call: 'post', channel, threadTs, text });
    return ts;
  }

  async edit(_channel: string, ts: string, text: string): Promise<void> {
    if (this.failEdit) throw this.failEdit;
    this.calls.push({ call: 'edit', ts, text });
  }

  async remove(_channel: string, ts: string): Promise<void> {
    this.calls.push({ call: 'remove', ts });
  }

  async startStream(args: StreamStart): Promise<string> {
    if (this.failStart) throw this.failStart;
    const ts = `s-${++this.serial}`;
    this.calls.push({ call: 'start', args });
    return ts;
  }

  async appendStream(
    _channel: string,
    ts: string,
    chunks: StreamChunk[],
  ): Promise<void> {
    if (this.failAppend) throw this.failAppend;
    this.calls.push({ call: 'append', ts, chunks });
  }

  async stopStream(_channel: string, ts: string): Promise<void> {
    if (this.failStopStream) throw this.failStopStream;
    this.calls.push({ call: 'stop', ts });
  }

  async session(
    _channel: string,
    threadTs: string,
    status: SessionStatus,
  ): Promise<void> {
    if (this.failSession) throw this.failSession;
    this.calls.push({ call: 'session', threadTs, status });
  }

  async replies(): Promise<SlackMessage[]> {
    return this.thread;
  }

  async userName(userId: string): Promise<string> {
    return this.names.get(userId) ?? userId;
  }

  async identity() {
    return { userId: 'U0BOT', teamId: 'TAR78LS82', appBotId: 'B0BOT' };
  }

  chunks(): StreamChunk[] {
    return this.calls.flatMap((c) =>
      c.call === 'start' ? c.args.chunks : c.call === 'append' ? c.chunks : [],
    );
  }

  /** The answer text alone. */
  streamed(): string {
    return this.chunks()
      .map((chunk) => (chunk.type === 'markdown_text' ? chunk.text : ''))
      .join('');
  }

  cards(): { id: string; title: string; status: string }[] {
    return this.chunks()
      .filter((chunk) => chunk.type === 'task_update')
      .map(({ id, title, status }) => ({ id, title, status }));
  }

  only<K extends SlackCall['call']>(
    kind: K,
  ): Extract<SlackCall, { call: K }>[] {
    return this.calls.filter(
      (c): c is Extract<SlackCall, { call: K }> => c.call === kind,
    );
  }
}

export class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const fns = this.listeners.get(type) ?? [];
    fns.push(listener);
    this.listeners.set(type, fns);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }

  deliver(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  raw(data: string): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  get acks(): string[] {
    return this.sent.map(
      (line) => (JSON.parse(line) as { envelope_id: string }).envelope_id,
    );
  }
}
