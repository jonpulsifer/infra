/**
 * mate's end of mate-hands, the tool daemon in each sandbox: typed calls over
 * one exec stream, cancellation, streamed command output, and a ping that
 * keeps the daemon's watchdog fed. No turn uses it yet.
 */
import {
  encode,
  execError,
  fileError,
  HandsError,
  type Hello,
  LineSplitter,
  type Method,
  type Notifications,
  type Params,
  PROTOCOL_VERSION,
  protocolError,
  type Result,
  type ShellOutputUpdate,
  type WireError,
} from '@repo/mate-hands/protocol';
import { type Clock, type Handle, systemClock } from './clock.ts';
import type { ExecClose, ExecStream } from './kube.ts';
import { type Log, plain } from './log.ts';

export { HandsError };

export const HANDS_BINARY = '/usr/local/bin/mate-hands';
const HELLO_TIMEOUT_MS = 30_000;
// Far over the largest answer the daemon sends: a whole file at its read
// limit, in base64.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
// How long a closing client waits for its `shutdown` to be written, and a
// finished output stream for the exec close status.
const CLOSE_GRACE_MS = 1_000;

export interface HandsCommand {
  /** Newer than every epoch before it in this sandbox. */
  epoch: number;
  cwd: string;
  watchdogMs?: number;
}

export function handsCommand(opts: HandsCommand): string[] {
  return [
    HANDS_BINARY,
    '--epoch',
    String(opts.epoch),
    '--cwd',
    opts.cwd,
    ...(opts.watchdogMs ? ['--watchdog-ms', String(opts.watchdogMs)] : []),
  ];
}

export interface CallOptions {
  /** Cancels the call; the daemon answers `aborted` once it has stopped. */
  signal?: AbortSignal;
  /** Output updates of an `exec` call. A throw cancels the command. */
  onUpdate?: (update: ShellOutputUpdate) => void;
}

export interface HandsOptions {
  /** The epoch in the command that started the daemon. */
  epoch: number;
  log: Log;
  clock?: Clock;
  fields?: Record<string, unknown>;
  /** Capped at a third of the daemon's watchdog window. */
  pingEveryMs?: number;
  helloTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: HandsError): void;
  onUpdate?: (update: ShellOutputUpdate) => void;
  /** Set when `onUpdate` threw; the call fails with it. */
  failed?: HandsError;
}

function aborted(method: Method): HandsError {
  return method === 'exec'
    ? execError('aborted', 'aborted')
    : fileError('aborted', 'aborted');
}

function closedBy(close: ExecClose): HandsError {
  const said = close.status?.message ?? close.reason;
  return protocolError(
    'closed',
    `hands stream closed (${close.code}${said ? ` ${said}` : ''})`,
  );
}

export class HandsClient {
  readonly closed: Promise<ExecClose>;
  private greeting: Hello | null = null;
  private readonly clock: Clock;
  private readonly fields: Record<string, unknown>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ended: HandsError | null = null;
  private pinger: Handle | null = null;

  private constructor(
    private readonly exec: ExecStream,
    private readonly opts: HandsOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.fields = opts.fields ?? {};
    this.writer = exec.stdin.getWriter();
    this.closed = exec.closed.then((close) => {
      this.end(closedBy(close));
      return close;
    });
    void this.read();
  }

  /** Opens the client with a `hello`, checking the protocol and epoch. */
  static async connect(
    exec: ExecStream,
    opts: HandsOptions,
  ): Promise<HandsClient> {
    const client = new HandsClient(exec, opts);
    try {
      const hello = await client.bounded(
        client.call('hello', {}),
        opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
        'hello',
      );
      if (hello.protocol !== PROTOCOL_VERSION) {
        throw protocolError(
          'mismatch',
          `hands speak protocol ${hello.protocol}, mate speaks ${PROTOCOL_VERSION}`,
        );
      }
      if (hello.epoch !== opts.epoch) {
        throw protocolError(
          'mismatch',
          `hands answered for epoch ${hello.epoch}, not ${opts.epoch}`,
        );
      }
      client.greeting = hello;
    } catch (error) {
      await client.close();
      throw error;
    }
    client.schedulePing();
    return client;
  }

  /** What the daemon said at connect: its cwd, home, limits and watchdog. */
  get hello(): Hello {
    if (!this.greeting) throw new Error('hands are not connected');
    return this.greeting;
  }

  get isClosed(): boolean {
    return this.ended !== null;
  }

  /** Rejects with a `HandsError` whose kind and code say what failed. */
  call<M extends Method>(
    method: M,
    params: Params<M>,
    options: CallOptions = {},
  ): Promise<Result<M>> {
    if (this.ended) return Promise.reject(this.ended);
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(aborted(method));
    const id = this.nextId++;
    const line = encode({ id, method, params });
    const max = this.greeting?.limits.maxRequestBytes;
    if (max !== undefined && Buffer.byteLength(line) > max) {
      return Promise.reject(
        protocolError('too_large', `${method} is over ${max} bytes`),
      );
    }
    return new Promise<Result<M>>((resolve, reject) => {
      const onAbort = () => this.notify('cancel', { id });
      const settled = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        onUpdate: options.onUpdate,
        resolve: (value) => {
          settled();
          resolve(value as Result<M>);
        },
        reject: (error) => {
          settled();
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write(line);
    });
  }

  /**
   * Asks the daemon to kill its children and exit, then closes the stream.
   * The request goes first because a pods/exec v4 stream cannot send EOF.
   */
  async close(): Promise<void> {
    if (!this.ended) {
      const line = encode({ method: 'shutdown', params: {} });
      await this.bounded(
        this.writer.write(this.encoder.encode(line)),
        CLOSE_GRACE_MS,
        'shutdown',
      ).catch(() => {});
    }
    this.end(protocolError('closed', 'hands closed by mate'));
    this.exec.close();
  }

  private schedulePing(): void {
    if (this.ended) return;
    const every = Math.min(
      this.opts.pingEveryMs ?? Number.POSITIVE_INFINITY,
      this.hello.watchdogMs / 3,
    );
    this.pinger = this.clock.after(every, () => void this.ping());
  }

  // A ping unanswered for a whole watchdog window means the daemon has
  // stopped or is about to, so the client gives up too.
  private async ping(): Promise<void> {
    this.pinger = null;
    if (this.ended) return;
    try {
      await this.bounded(this.call('ping', {}), this.hello.watchdogMs, 'ping');
    } catch (error) {
      if (this.ended) return;
      this.opts.log.warn('hands stopped answering pings', {
        ...this.fields,
        error: plain(error),
      });
      this.end(protocolError('unresponsive', plain(error)));
      this.exec.close();
      return;
    }
    this.schedulePing();
  }

  private bounded<T>(request: Promise<T>, ms: number, label: string) {
    let timer: Handle | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timer = this.clock.after(ms, () =>
        reject(
          protocolError('unresponsive', `${label} got no answer in ${ms}ms`),
        ),
      );
    });
    return Promise.race([request, timedOut]).finally(() => {
      if (timer) this.clock.cancel(timer);
    });
  }

  private write(line: string): void {
    this.writer.write(this.encoder.encode(line)).catch((error) => {
      this.end(protocolError('closed', `hands stream failed: ${plain(error)}`));
    });
  }

  private notify<N extends keyof Notifications>(
    method: N,
    params: Notifications[N],
  ): void {
    if (!this.ended) this.write(encode({ method, params }));
  }

  private async read(): Promise<void> {
    const splitter = new LineSplitter(
      MAX_MESSAGE_BYTES,
      (line) => this.onLine(line),
      () => {
        this.end(protocolError('too_large', 'hands sent an oversized message'));
        this.exec.close();
      },
    );
    const reader = this.exec.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(value);
      }
    } catch {}
    // The close status says more than the end of the output does.
    await Promise.race([this.closed, this.clock.sleep(CLOSE_GRACE_MS)]);
    this.end(protocolError('closed', 'hands output ended'));
  }

  private onLine(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: { id?: number; update?: ShellOutputUpdate };
      result?: unknown;
      error?: WireError;
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.opts.log.warn('hands sent a line that is not JSON', this.fields);
      return;
    }
    if (message.method === 'exec.update') {
      this.onUpdate(message.params?.id, message.params?.update);
      return;
    }
    const pending =
      message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) {
      this.opts.log.warn('hands answered an unknown call', {
        ...this.fields,
        id: message.id ?? null,
      });
      return;
    }
    this.pending.delete(message.id);
    if (pending.failed) pending.reject(pending.failed);
    else if (message.error) pending.reject(new HandsError(message.error));
    else pending.resolve(message.result);
  }

  private onUpdate(id: number | undefined, update?: ShellOutputUpdate): void {
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (!pending?.onUpdate || pending.failed || !update || id === undefined) {
      return;
    }
    try {
      pending.onUpdate(update);
    } catch (error) {
      pending.failed = execError('callback_error', plain(error));
      this.notify('cancel', { id });
    }
  }

  private end(error: HandsError): void {
    if (this.ended) return;
    this.ended = error;
    if (this.pinger) this.clock.cancel(this.pinger);
    this.pinger = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
