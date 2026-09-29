/**
 * pi's `ExecutionEnv` over mate-hands. `HandsLink` keeps one daemon connection
 * to a sandbox; `HandsEnv` is the stable per-thread facade pi's tools call. It
 * resolves paths in the brain, never throws, and gives up on a call the
 * daemon does not answer.
 */
import { posix } from 'node:path';
import {
  type Context,
  type ExecutionEnv,
  ExecutionError,
  type ExecutionErrorCode,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  ok,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-agent-core';
import {
  HandsError,
  resolvePath,
  type TextLine,
} from '@repo/mate-hands/protocol';
import { type Clock, type Handle, systemClock } from './clock.ts';
import {
  HARNESS_CONTAINER,
  HandsClient,
  type HandsCommand,
  handsCommand,
} from './hands.ts';
import type { ExecStream, Kube } from './kube.ts';
import {
  AGENT_HOME,
  type HandsConnectResult,
  type HandsDropReason,
  type HandsInstruments,
  WORKSPACE,
} from './lease.ts';
import { type Log, plain } from './log.ts';
import { redact } from './redact.ts';

/** A file call's bound once it has a link: pings do not catch a hung syscall. */
export const FILE_DEADLINE_MS = 60_000;
/** How long an aborted call waits for the daemon before settling on its own. */
export const ABORT_GRACE_MS = 5_000;
/** How long a failed open's error answers every caller. */
export const OPEN_BACKOFF_MS = 3_000;
const STDERR_LINE_LIMIT = 500;
const CLOSE_STATUS_MS = 1_000;

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type TextLineReader = Extract<
  Awaited<ReturnType<ExecutionEnv['openTextLineReader']>>,
  { ok: true }
>['value'];

/** The sandbox, or its pod, is not there any more; its files went with it. */
export class SandboxGone extends Error {
  override readonly name = 'SandboxGone';
}

/** The sandbox runs no daemon that speaks this protocol. */
export class HandsImageTooOld extends Error {
  override readonly name = 'HandsImageTooOld';
}

class LinkSealed extends Error {
  override readonly name = 'LinkSealed';
}

/** The owner's epoch from a `superseded` answer, the one place B's field is read. */
export function supersededEpoch(error: unknown): number | null {
  return error instanceof HandsError ? (error.ownerEpoch ?? null) : null;
}

/**
 * Newer than every epoch before it in this process. A clock that stepped
 * back, or a daemon started past the clock, cannot make an epoch repeat.
 */
export class Epochs {
  private last = 0;

  next(now: number, atLeast = 0): number {
    this.last = Math.max(now, this.last + 1, atLeast);
    return this.last;
  }
}

const processEpochs = new Epochs();

export interface HandsTarget {
  readonly sandbox: string;
  readonly pod: string;
}

export interface HandsLinkOptions {
  readonly kube: Kube;
  readonly namespace: string;
  readonly log: Log;
  readonly clock?: Clock;
  readonly metrics?: HandsInstruments;
  /** Where to connect; throws `SandboxGone` when the sandbox's pod is not there. */
  locate(): Promise<HandsTarget>;
  /** The daemon's working directory in the sandbox. */
  readonly cwd?: string;
  /** Refuses a daemon whose home differs, since credentials are stamped there. */
  readonly expectHome?: string | null;
  readonly epochs?: Epochs;
}

/**
 * One daemon connection to one sandbox at a time, opened on demand. A new
 * connection takes a new epoch, so its daemon kills whatever an earlier one
 * left running.
 */
export class HandsLink {
  /** Counts successful opens. */
  generation = 0;
  private client: HandsClient | null = null;
  private target: HandsTarget | null = null;
  private opening: Promise<HandsClient> | null = null;
  private failed: { error: unknown; until: number } | null = null;
  private sealed = false;
  private readonly closedByMate = new WeakSet<HandsClient>();
  private readonly clock: Clock;
  private readonly epochs: Epochs;

  constructor(private readonly opts: HandsLinkOptions) {
    this.clock = opts.clock ?? systemClock;
    this.epochs = opts.epochs ?? processEpochs;
  }

  /** The open client, without connecting. */
  current(): HandsClient | null {
    const client = this.client;
    return client && !client.isClosed ? client : null;
  }

  /**
   * The open client, or one opened now. Callers share one open, which no
   * caller's abort cancels.
   */
  get(signal?: AbortSignal): Promise<HandsClient> {
    if (this.sealed) {
      return Promise.reject(new LinkSealed('the hands link is sealed'));
    }
    const live = this.current();
    if (live) return Promise.resolve(live);
    if (this.failed && this.clock.now() < this.failed.until) {
      return Promise.reject(this.failed.error);
    }
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return raced(this.opening, signal);
  }

  /** Closes the open client: it asks the daemon to kill its children and exit. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    this.closedByMate.add(client);
    await client.close();
  }

  /** Gives up on `client`, which a call found unanswering. */
  drop(client: HandsClient, reason: HandsDropReason): void {
    if (this.closedByMate.has(client)) return;
    this.closedByMate.add(client);
    if (this.client === client) this.client = null;
    this.opts.metrics?.handsDropped(reason);
    this.opts.log.warn('gave up on the hands link', {
      ...this.fields(),
      reason,
    });
    void client.close();
  }

  /** Every later `get` fails at once; the open client stays for a last retire. */
  seal(): void {
    this.sealed = true;
  }

  private fields(): Record<string, unknown> {
    return {
      sandbox: this.target?.sandbox,
      pod: this.target?.pod,
      generation: this.generation,
    };
  }

  private async open(): Promise<HandsClient> {
    try {
      const client = await this.connect();
      this.failed = null;
      return client;
    } catch (error) {
      this.failed = { error, until: this.clock.now() + OPEN_BACKOFF_MS };
      throw error;
    }
  }

  private async connect(): Promise<HandsClient> {
    const target = await this.opts.locate();
    const epoch = this.epochs.next(this.clock.now());
    try {
      return await this.attempt(target, epoch);
    } catch (error) {
      const owner = supersededEpoch(error);
      if (owner === null) throw error;
      this.opts.log.info('another daemon owns the sandbox; starting past it', {
        sandbox: target.sandbox,
        pod: target.pod,
        epoch,
        owner,
      });
      return this.attempt(
        target,
        this.epochs.next(this.clock.now(), owner + 1),
      );
    }
  }

  private async attempt(
    target: HandsTarget,
    epoch: number,
  ): Promise<HandsClient> {
    const { kube, namespace, log, metrics } = this.opts;
    const reconnect = this.generation > 0;
    const fields = { sandbox: target.sandbox, pod: target.pod, epoch };
    const command: HandsCommand = { epoch, cwd: this.opts.cwd ?? WORKSPACE };
    const started = this.clock.now();
    let stream: ExecStream;
    try {
      stream = await kube.exec({
        namespace,
        pod: target.pod,
        container: HARNESS_CONTAINER,
        command: handsCommand(command),
        onStderr: stderrLines(log, fields),
      });
    } catch (error) {
      metrics?.handsConnected('failed', { reconnect });
      throw error;
    }
    const execOpenMs = this.clock.now() - started;
    const greeted = this.clock.now();
    let client: HandsClient;
    try {
      client = await HandsClient.connect(stream, {
        epoch,
        log,
        clock: this.clock,
        fields,
      });
    } catch (error) {
      const result = await connectResult(error, stream);
      metrics?.handsConnected(result, { reconnect, execOpenMs });
      if (result === 'mismatch') {
        throw new HandsImageTooOld(
          `sandbox ${target.sandbox} runs no daemon mate can speak to: ${plain(error)}`,
        );
      }
      throw error;
    }
    const home = this.opts.expectHome;
    if (this.sealed || (home && client.hello.home !== home)) {
      this.closedByMate.add(client);
      await client.close();
      metrics?.handsConnected('failed', { reconnect, execOpenMs });
      throw this.sealed
        ? new LinkSealed('the hands link is sealed')
        : new Error(
            `the daemon's home is ${client.hello.home}, not ${home}, where credentials go`,
          );
    }
    metrics?.handsConnected('ok', {
      reconnect,
      execOpenMs,
      connectMs: this.clock.now() - greeted,
    });
    this.generation += 1;
    this.client = client;
    this.target = target;
    void client.closed.then((close) => {
      if (this.client === client) this.client = null;
      if (this.closedByMate.has(client)) return;
      const reason =
        client.failure?.detail.code === 'unresponsive'
          ? 'unresponsive'
          : 'closed';
      metrics?.handsDropped(reason);
      log.warn('the hands link dropped', {
        ...fields,
        reason,
        code: close.code,
        said: close.status?.message ?? close.reason,
      });
    });
    return client;
  }
}

/**
 * `mismatch` covers a daemon on another protocol and an exec that failed
 * before `hello`: the image has no daemon, or one too old to start.
 */
async function connectResult(
  error: unknown,
  stream: ExecStream,
): Promise<HandsConnectResult> {
  if (supersededEpoch(error) !== null) return 'superseded';
  if (!(error instanceof HandsError) || error.detail.kind !== 'protocol') {
    return 'failed';
  }
  if (error.detail.code === 'mismatch') return 'mismatch';
  if (error.detail.code !== 'closed') return 'failed';
  // The client closed the stream on its way out; the status is due now.
  const close = await Promise.race([
    stream.closed,
    Bun.sleep(CLOSE_STATUS_MS).then(() => null),
  ]);
  return close?.status?.status === 'Failure' ? 'mismatch' : 'failed';
}

/** The daemon's JSON log lines, redacted, into mate's log. */
function stderrLines(
  log: Log,
  fields: Record<string, unknown>,
): (text: string) => void {
  let pending = '';
  return (text) => {
    pending += text;
    const lines = pending.split('\n');
    pending = (lines.pop() ?? '').slice(-STDERR_LINE_LIMIT);
    for (const raw of lines) {
      const line = redact(raw).trim().slice(0, STDERR_LINE_LIMIT);
      if (!line) continue;
      const level = /"level":"(warn|error)"/.test(line) ? 'warn' : 'info';
      log[level]('hands said', { ...fields, line });
    }
  };
}

function raced<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Why a call has no client: no sandbox this turn, or the caller gave up. */
export class LeaseFailure {
  constructor(
    readonly message: string,
    readonly aborted = false,
  ) {}
}

/** What a turn's lease gives the env; D1-internal. */
export interface LeaseAccess {
  /** The turn's client, leasing a sandbox and connecting on first use. */
  client(signal: AbortSignal | undefined): Promise<HandsClient | LeaseFailure>;
  /** The open client, without connecting. */
  current(): HandsClient | null;
  /** Closes `client`'s link: a call gave up on it. */
  drop(client: HandsClient, reason: HandsDropReason): void;
}

export interface HandsEnvOptions {
  readonly cwd?: string;
  readonly home?: string;
  /** The running turn's lease, or `null` outside a turn. */
  lease(): LeaseAccess | null;
  readonly clock?: Clock;
  readonly metrics?: HandsInstruments;
}

type Kind = 'file' | 'exec';

interface Failure {
  code: FileErrorCode | ExecutionErrorCode;
  message: string;
  path?: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };

type Settled<T> =
  | { value: T }
  | { error: unknown }
  | { deadline: true }
  | { graced: true };

type Call<T> = (client: HandsClient, signal?: AbortSignal) => Promise<T>;

const ABORTED: Failure = { code: 'aborted', message: 'aborted' };
const READER_CLOSED = 'Text line reader is closed';

/**
 * pi's `ExecutionEnv` for one thread, the same object for the thread's life,
 * since pi keys its write queue on it. A call outside a turn fails; a call in
 * one leases the thread's sandbox on first use.
 */
export class HandsEnv implements ExecutionEnv {
  cwd: string;
  private readonly home: string;
  private readonly clock: Clock;

  constructor(private readonly opts: HandsEnvOptions) {
    this.cwd = opts.cwd ?? WORKSPACE;
    this.home = opts.home ?? AGENT_HOME;
    this.clock = opts.clock ?? systemClock;
  }

  async absolutePath(
    path: string,
    _context: Context,
  ): Promise<Result<string, FileError>> {
    return ok(this.resolve(path));
  }

  async joinPath(
    parts: string[],
    _context: Context,
  ): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  readTextFile(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path);
    return this.file('readTextFile', resolved, context, (client, signal) =>
      client.call('readTextFile', { path: resolved }, { signal }),
    );
  }

  openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const resolved = this.resolve(path);
    return this.file(
      'reader.open',
      resolved,
      context,
      async (client, signal) => {
        const { reader } = await client.call(
          'reader.open',
          { path: resolved },
          { signal },
        );
        return new HandsLineReader(this, client, reader, resolved);
      },
    );
  }

  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const resolved = this.resolve(path);
    const maxLines = wireLines(options?.maxLines);
    return this.file('readTextLines', resolved, context, (client, signal) =>
      client.call(
        'readTextLines',
        { path: resolved, ...(maxLines === undefined ? {} : { maxLines }) },
        { signal },
      ),
    );
  }

  readBinaryFile(
    path: string,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(path);
    return this.file('readBinaryFile', resolved, context, async (c, signal) =>
      Uint8Array.from(
        Buffer.from(
          await c.call('readBinaryFile', { path: resolved }, { signal }),
          'base64',
        ),
      ),
    );
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    return this.file('writeFile', resolved, context, async (client, signal) => {
      await client.call(
        'writeFile',
        { path: resolved, ...wireContent(content) },
        { signal },
      );
    });
  }

  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    return this.file(
      'appendFile',
      resolved,
      context,
      async (client, signal) => {
        await client.call(
          'appendFile',
          { path: resolved, ...wireContent(content) },
          { signal },
        );
      },
    );
  }

  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const from = this.resolve(sourcePath);
    const to = this.resolve(destinationPath);
    return this.file('renameFile', from, context, async (client, signal) => {
      await client.call('renameFile', { from, to }, { signal });
    });
  }

  fileInfo(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path);
    return this.file('fileInfo', resolved, context, (client, signal) =>
      client.call('fileInfo', { path: resolved }, { signal }),
    );
  }

  listDir(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path);
    return this.file('listDir', resolved, context, (client, signal) =>
      client.call('listDir', { path: resolved }, { signal }),
    );
  }

  canonicalPath(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path);
    return this.file('canonicalPath', resolved, context, (client, signal) =>
      client.call('canonicalPath', { path: resolved }, { signal }),
    );
  }

  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const resolved = this.resolve(path);
    return this.file('exists', resolved, context, (client, signal) =>
      client.call('exists', { path: resolved }, { signal }),
    );
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    const recursive = options?.recursive ?? true;
    return this.file('createDir', resolved, context, async (client, signal) => {
      await client.call('createDir', { path: resolved, recursive }, { signal });
    });
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path);
    const params = {
      path: resolved,
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    };
    return this.file('remove', resolved, context, async (client, signal) => {
      await client.call('remove', params, { signal });
    });
  }

  createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file('createTempDir', undefined, context, (client, signal) =>
      client.call('createTempDir', prefix === undefined ? {} : { prefix }, {
        signal,
      }),
    );
  }

  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const params = {
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options?.suffix === undefined ? {} : { suffix: options.suffix }),
    };
    return this.file('createTempFile', undefined, context, (client, signal) =>
      client.call('createTempFile', params, { signal }),
    );
  }

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const onUpdate = options?.onUpdate;
    const params = {
      command,
      cwd: options?.cwd ? this.resolve(options.cwd) : this.cwd,
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.inheritEnv === undefined
        ? {}
        : { inheritEnv: options.inheritEnv }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options?.capture === undefined ? {} : { capture: options.capture }),
      updates: Boolean(onUpdate),
    };
    const outcome = await this.invoke(
      'exec',
      'exec',
      context,
      (client, signal) =>
        client.call('exec', params, {
          signal,
          // A throw here is the client's callback_error, as it is pi's.
          onUpdate: onUpdate && ((update) => onUpdate(update, context)),
        }),
    );
    if (outcome.ok) return ok(outcome.value);
    const { code, message } = outcome.failure;
    return err(new ExecutionError(code as ExecutionErrorCode, message));
  }

  /** Never connects: with no open link there is nothing to release. */
  async cleanup(_context: Context): Promise<void> {
    const client = this.opts.lease()?.current();
    if (!client) return;
    let timer: Handle | null = null;
    const grace = new Promise<void>((resolve) => {
      timer = this.clock.after(ABORT_GRACE_MS, resolve);
    });
    await Promise.race([client.call('cleanup', {}).catch(() => {}), grace]);
    if (timer) this.clock.cancel(timer);
  }

  /** A reader's call, on the client that opened it and no other. */
  readerCall<T>(
    client: HandsClient,
    method: 'reader.readLine' | 'reader.close',
    path: string,
    context: Context,
    call: Call<T>,
  ): Promise<Result<T, FileError>> {
    return this.file(method, path, context, call, client);
  }

  private resolve(path: string): string {
    return resolvePath(path, this.cwd, this.home);
  }

  private async file<T>(
    method: string,
    path: string | undefined,
    context: Context,
    call: Call<T>,
    bound?: HandsClient,
  ): Promise<Result<T, FileError>> {
    const outcome = await this.invoke('file', method, context, call, bound);
    if (outcome.ok) return ok(outcome.value);
    const failure = outcome.failure;
    return err(
      new FileError(
        failure.code as FileErrorCode,
        failure.message,
        failure.path ?? path,
      ),
    );
  }

  private async invoke<T>(
    kind: Kind,
    method: string,
    context: Context,
    call: Call<T>,
    bound?: HandsClient,
  ): Promise<Outcome<T>> {
    const { metrics } = this.opts;
    const signal = context.abortSignal;
    const began = this.clock.now();
    const failed = (result: 'aborted' | 'lost', failure: Failure) => {
      metrics?.handsCall(method, result, this.clock.now() - began);
      return { ok: false as const, failure };
    };
    if (signal?.aborted) return failed('aborted', ABORTED);
    const lease = this.opts.lease();
    if (bound && (!lease || bound.isClosed)) {
      return failed('lost', { code: 'invalid', message: READER_CLOSED });
    }
    if (!lease) {
      return failed('lost', { code: 'unknown', message: 'no turn is running' });
    }
    const got = bound ?? (await lease.client(signal));
    if (got instanceof LeaseFailure) {
      return got.aborted || signal?.aborted
        ? failed('aborted', ABORTED)
        : failed('lost', { code: 'unknown', message: got.message });
    }
    const start = this.clock.now();
    const settled = await this.race(kind, got, lease, signal, call);
    const ms = this.clock.now() - start;
    if ('value' in settled) {
      metrics?.handsCall(method, 'ok', ms);
      return { ok: true, value: settled.value };
    }
    if ('deadline' in settled) {
      metrics?.handsCall(method, 'deadline', ms);
      const seconds = FILE_DEADLINE_MS / 1000;
      return {
        ok: false,
        failure: { code: 'unknown', message: `no answer in ${seconds}s` },
      };
    }
    if ('graced' in settled) {
      metrics?.handsCall(method, 'aborted', ms);
      return { ok: false, failure: ABORTED };
    }
    const failure = mapError(kind, settled.error, Boolean(signal?.aborted));
    metrics?.handsCall(method, callResult(settled.error, failure), ms);
    return { ok: false, failure };
  }

  /** The daemon's answer, or a local end: the file deadline, or the abort grace. */
  private race<T>(
    kind: Kind,
    client: HandsClient,
    lease: LeaseAccess,
    signal: AbortSignal | undefined,
    call: Call<T>,
  ): Promise<Settled<T>> {
    return new Promise((resolve) => {
      const timers: Handle[] = [];
      let done = false;
      const giveUp = (reason: HandsDropReason, settled: Settled<T>) => () => {
        if (done) return;
        lease.drop(client, reason);
        finish(settled);
      };
      const onAbort = () => {
        timers.push(
          this.clock.after(
            ABORT_GRACE_MS,
            giveUp('abort-grace', { graced: true }),
          ),
        );
      };
      const finish = (settled: Settled<T>) => {
        if (done) return;
        done = true;
        for (const timer of timers) this.clock.cancel(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(settled);
      };
      if (kind === 'file') {
        timers.push(
          this.clock.after(
            FILE_DEADLINE_MS,
            giveUp('deadline', { deadline: true }),
          ),
        );
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      let request: Promise<T>;
      try {
        request = call(client, signal);
      } catch (error) {
        request = Promise.reject(error);
      }
      request.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }
}

class HandsLineReader implements TextLineReader {
  private closed = false;

  constructor(
    private readonly env: HandsEnv,
    private readonly client: HandsClient,
    private readonly reader: number,
    private readonly path: string,
  ) {}

  async readLine(
    context: Context,
  ): Promise<Result<TextLine | undefined, FileError>> {
    if (this.closed || this.client.isClosed) {
      return err(new FileError('invalid', READER_CLOSED, this.path));
    }
    const read = await this.env.readerCall(
      this.client,
      'reader.readLine',
      this.path,
      context,
      (client, signal) =>
        client.call('reader.readLine', { reader: this.reader }, { signal }),
    );
    return read.ok ? ok(read.value ?? undefined) : read;
  }

  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.isClosed) return;
    await this.client
      .call('reader.close', { reader: this.reader })
      .catch(() => {});
  }
}

/** A whole count on the wire: pi reads while `lines < maxLines`, so it rounds up. */
function wireLines(maxLines: number | undefined): number | undefined {
  if (maxLines === undefined || maxLines === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  return Number.isFinite(maxLines) ? Math.ceil(maxLines) : 0;
}

function wireContent(content: string | Uint8Array): {
  content: string;
  encoding?: 'base64';
} {
  return typeof content === 'string'
    ? { content }
    : { content: Buffer.from(content).toString('base64'), encoding: 'base64' };
}

function mapError(kind: Kind, error: unknown, aborted: boolean): Failure {
  if (!(error instanceof HandsError)) {
    return { code: 'unknown', message: plain(error) };
  }
  const { detail } = error;
  if (detail.kind === 'file') {
    return kind === 'file'
      ? { code: detail.code, message: detail.message, path: detail.path }
      : { code: 'unknown', message: detail.message };
  }
  if (detail.kind === 'exec') {
    return kind === 'exec'
      ? { code: detail.code, message: detail.message }
      : { code: 'unknown', message: detail.message };
  }
  if (detail.code === 'closed' || detail.code === 'unresponsive') {
    if (aborted) return ABORTED;
    return {
      code: 'unknown',
      message: `the sandbox connection dropped (${detail.message}); the next call reconnects`,
    };
  }
  if (kind === 'file') {
    if (detail.code === 'bad_request' || detail.code === 'too_large') {
      return { code: 'invalid', message: detail.message };
    }
    if (detail.code === 'unknown_method') {
      return { code: 'not_supported', message: detail.message };
    }
  }
  return { code: 'unknown', message: detail.message };
}

function callResult(
  error: unknown,
  failure: Failure,
): 'error' | 'aborted' | 'lost' {
  if (failure.code === 'aborted') return 'aborted';
  if (
    error instanceof HandsError &&
    error.detail.kind === 'protocol' &&
    (error.detail.code === 'closed' || error.detail.code === 'unresponsive')
  ) {
    return 'lost';
  }
  return 'error';
}
