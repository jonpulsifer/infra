/**
 * A surface the state machine has never heard of: no Discord types, no Slack
 * types, channel-scoped thread keys and no archive. Driving the contract
 * through this is what proves the seam holds. The Slack Web API fake below
 * records the six calls the real adapter makes.
 */
import type { SlackApi, SlackMessage, StreamStart } from '../src/slack.ts';
import type { SocketLike } from '../src/socket.ts';
import type {
  Canvas,
  HistoryMessage,
  HistoryQuery,
  Inbound,
  Outcome,
  Surface,
  SurfaceName,
  ThreadRef,
} from '../src/surface.ts';

export interface Frame {
  text: string;
  status: string | null;
  outcome: Outcome | null;
}

export class FakeCanvas implements Canvas {
  readonly frames: Frame[] = [];
  working_ = 0;

  async live(text: string, status: string | null): Promise<void> {
    this.frames.push({ text, status, outcome: null });
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    this.frames.push({ text, status: null, outcome });
  }

  async working(): Promise<void> {
    this.working_ += 1;
  }

  /** What the last frame says, which is what a human would be looking at. */
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

export class FakeSurface implements Surface {
  readonly name: SurfaceName = 'slack';
  readonly canvases = new Map<string, FakeCanvas>();
  readonly posted: Posted[] = [];
  readonly opened: { channelId: string; messageId: string; title: string }[] =
    [];
  readonly askers: string[] = [];
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

  canvas(thread: ThreadRef, asker: string): Canvas {
    this.askers.push(asker);
    const canvas = new FakeCanvas();
    this.canvases.set(thread.id, canvas);
    return canvas;
  }

  /** A message landing in the thread, which is what the replay reads back. */
  say(
    threadId: string,
    content: string,
    authorId: string,
    authorName = 'jawn',
    authorIsBot = false,
  ): void {
    this.posted.push({
      threadId,
      id: `s-${++this.serial}`,
      authorId,
      authorName,
      authorIsBot,
      content,
    });
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
  | {
      call: 'post';
      channel: string;
      threadTs: string;
      text: string;
      blocks: unknown[] | null;
      stop: boolean;
    }
  | { call: 'update'; ts: string; text: string; blocks: unknown[] | null }
  | { call: 'remove'; ts: string }
  | { call: 'start'; args: StreamStart }
  | { call: 'append'; ts: string; markdown: string }
  | { call: 'stop'; ts: string };

export class FakeSlack implements SlackApi {
  readonly calls: SlackCall[] = [];
  readonly thread: SlackMessage[] = [];
  readonly names = new Map<string, string>();
  failRemove: Error | null = null;
  failStopStream: Error | null = null;
  private serial = 0;

  async post(
    channel: string,
    threadTs: string,
    text: string,
    blocks?: unknown[],
  ): Promise<string> {
    const ts = `p-${++this.serial}`;
    this.calls.push({
      call: 'post',
      channel,
      threadTs,
      text,
      blocks: blocks ?? null,
      stop: Boolean(blocks?.length),
    });
    return ts;
  }

  async update(
    _channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<void> {
    this.calls.push({ call: 'update', ts, text, blocks: blocks ?? null });
  }

  async remove(_channel: string, ts: string): Promise<void> {
    if (this.failRemove) throw this.failRemove;
    this.calls.push({ call: 'remove', ts });
  }

  async startStream(args: StreamStart): Promise<string> {
    const ts = `s-${++this.serial}`;
    this.calls.push({ call: 'start', args });
    return ts;
  }

  async appendStream(
    _channel: string,
    ts: string,
    markdown: string,
  ): Promise<void> {
    this.calls.push({ call: 'append', ts, markdown });
  }

  async stopStream(_channel: string, ts: string): Promise<void> {
    if (this.failStopStream) throw this.failStopStream;
    this.calls.push({ call: 'stop', ts });
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

  /** Everything the stream was given, in order. */
  streamed(): string {
    return this.calls
      .map((c) =>
        c.call === 'start'
          ? c.args.markdown
          : c.call === 'append'
            ? c.markdown
            : '',
      )
      .join('');
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

  /** One frame down the wire. */
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
