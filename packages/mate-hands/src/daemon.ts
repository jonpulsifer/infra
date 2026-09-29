/**
 * The daemon: requests in on stdin, answers out on stdout, for as long as
 * its client is there. It stops on stdin EOF, on `shutdown`, when no message
 * arrives within the watchdog window, or when a newer daemon supersedes it,
 * and it kills every process group it started as it goes. A pods/exec v4
 * stream has no half-close, so a client that crashes may never send EOF.
 */
import { runExec } from './exec.ts';
import { Files, toFileError } from './files.ts';
import {
  claim,
  type DaemonRecord,
  Groups,
  Ledger,
  startTime,
} from './groups.ts';
import {
  type ExecParams,
  encode,
  execError,
  HANDS_VERSION,
  HandsError,
  type Hello,
  type Limits,
  LineSplitter,
  leadingId,
  type Method,
  type Notification,
  PROTOCOL_VERSION,
  protocolError,
  type Response,
  type Result,
  resolvePath,
  type ShellOutputUpdate,
} from './protocol.ts';

export type Fields = Record<string, unknown>;

export interface Log {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
}

export interface DaemonOptions {
  epoch: number;
  cwd: string;
  home: string;
  tmp: string;
  shell: string;
  stateDir: string;
  watchdogMs: number;
  limits: Limits;
  log: Log;
}

export interface Stdio {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  exit(code: number): void;
}

const EXIT = { clean: 0, superseded: 2, watchdog: 3 } as const;

const MIB = 1024 * 1024;
// Updates wait while this much output is unwritten; answers never do.
const BACKLOG_BYTES = 4 * MIB;
const DRAIN_MS = 2_000;

/** Limits for a read cap; a request fits a whole capped file in base64. */
export function limitsFor(maxReadBytes: number): Limits {
  return {
    maxReadBytes,
    maxRequestBytes: Math.ceil(maxReadBytes / 3) * 4 + 64 * 1024,
    maxCaptureBytes: MIB,
    maxCaptureLines: 100_000,
    maxSpillBytes: 256 * MIB,
    maxListEntries: 20_000,
    maxInflight: 64,
    maxRunning: 16,
    maxReaders: 64,
  };
}

type Params = Record<string, unknown>;
type Handlers = {
  [M in Method]: (
    params: Params,
    signal: AbortSignal,
    id: number,
  ) => Promise<Result<M>>;
};

interface Call {
  method: string;
  controller: AbortController;
  done: Promise<void>;
}

export class Daemon {
  private readonly ledger: Ledger;
  private readonly groups: Groups;
  private readonly files: Files;
  private readonly calls = new Map<number, Call>();
  private superseded: DaemonRecord | null = null;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private backlog = 0;

  constructor(
    private readonly options: DaemonOptions,
    private readonly stdio: Stdio,
  ) {
    this.ledger = new Ledger(options.stateDir, {
      epoch: options.epoch,
      pid: process.pid,
      start: startTime(process.pid),
    });
    this.groups = new Groups(this.ledger);
    this.files = new Files(options.tmp, options.limits);
  }

  async start(): Promise<void> {
    const { log, epoch } = this.options;
    const claimed = await claim(this.ledger);
    if (claimed.superseded) {
      this.superseded = claimed.superseded;
      this.ledger.remove();
      log.warn('superseded', { epoch, by: claimed.superseded.epoch });
    } else {
      for (const old of claimed.killed) {
        const fields = {
          epoch,
          old: old.epoch,
          pid: old.pid,
          groups: old.groups.length,
        };
        if (old.epoch < epoch)
          log.info('took over from an older daemon', fields);
        else log.warn('cleared the record of a dead newer daemon', fields);
      }
    }
    const { stdin, stdout } = this.stdio;
    const splitter = new LineSplitter(
      this.options.limits.maxRequestBytes,
      (line) => this.onLine(line),
      (head) => this.onOversize(head),
    );
    stdin.on('data', (chunk: Buffer) => splitter.push(chunk));
    stdin.on('end', () => void this.stop('stdin closed', EXIT.clean));
    stdin.on('error', () => void this.stop('stdin failed', EXIT.clean));
    stdout.on('error', () => void this.stop('stdout failed', EXIT.clean));
    this.arm();
  }

  async stop(reason: string, code: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.watchdog);
    this.options.log.info('stopping', { reason, calls: this.calls.size });
    this.groups.close();
    for (const call of this.calls.values()) call.controller.abort();
    const settled = Promise.all([...this.calls.values()].map((c) => c.done));
    await Promise.race([settled, Bun.sleep(DRAIN_MS)]);
    await this.files.closeAll();
    this.ledger.remove();
    const until = Date.now() + DRAIN_MS;
    while (this.backlog > 0 && Date.now() < until) await Bun.sleep(5);
    this.stdio.exit(code);
  }

  private arm(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => void this.stop('watchdog expired', EXIT.watchdog),
      this.options.watchdogMs,
    );
  }

  private send(message: Response | Notification): void {
    const line = encode(message);
    this.backlog += line.length;
    this.stdio.stdout.write(line, () => {
      this.backlog -= line.length;
    });
  }

  private sendUpdate(
    id: number,
    update: ShellOutputUpdate,
    force: boolean,
  ): boolean {
    if (!force && this.backlog > BACKLOG_BYTES) return false;
    this.send({ method: 'exec.update', params: { id, update } });
    return true;
  }

  private onOversize(head: string): void {
    if (this.stopping) return;
    this.arm();
    const id = leadingId(head);
    const limit = this.options.limits.maxRequestBytes;
    this.options.log.warn('dropped an oversized message', { id, limit });
    if (id !== undefined) {
      this.fail(
        id,
        protocolError('too_large', `request is over ${limit} bytes`),
      );
    }
  }

  private onLine(line: string): void {
    if (this.stopping) return;
    this.arm();
    let message: { id?: unknown; method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      this.options.log.warn('dropped a message that is not JSON');
      return;
    }
    const { id, method, params } = message ?? {};
    if (typeof method !== 'string') {
      this.options.log.warn('dropped a message with no method');
    } else if (id === undefined) {
      this.notification(method, params);
    } else if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      this.options.log.warn('dropped a message with a bad id', { method });
    } else {
      this.request(id, method, params);
    }
  }

  private notification(method: string, params: unknown): void {
    if (method === 'shutdown') {
      void this.stop('shutdown requested', EXIT.clean);
    } else if (method === 'cancel') {
      const id = isObject(params) ? params.id : undefined;
      if (typeof id === 'number') this.calls.get(id)?.controller.abort();
    } else {
      this.options.log.warn('dropped an unknown notification', { method });
    }
  }

  private request(id: number, method: string, params: unknown): void {
    if (this.superseded) {
      const by = this.superseded.epoch;
      this.fail(
        id,
        protocolError(
          'superseded',
          `a daemon with epoch ${by} owns this sandbox`,
        ),
      );
      void this.stop('superseded', EXIT.superseded);
      return;
    }
    if (this.calls.has(id)) {
      this.fail(id, protocolError('bad_request', `call ${id} is running`));
      return;
    }
    if (this.calls.size >= this.options.limits.maxInflight) {
      this.fail(id, protocolError('busy', 'too many calls in flight'));
      return;
    }
    if (!Object.hasOwn(this.handlers, method)) {
      this.fail(id, protocolError('unknown_method', `no method ${method}`));
      return;
    }
    const call: Call = {
      method,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.calls.set(id, call);
    call.done = this.run(id, method as Method, isObject(params) ? params : {});
  }

  private async run(id: number, method: Method, params: Params) {
    const call = this.calls.get(id);
    if (!call) return;
    try {
      const handler = this.handlers[method] as Handlers[Method];
      const result = await handler(params, call.controller.signal, id);
      this.send({ id, result: result ?? null });
    } catch (error) {
      this.fail(id, this.wireError(method, params, error));
    } finally {
      this.calls.delete(id);
    }
  }

  private wireError(method: Method, params: Params, error: unknown) {
    if (error instanceof HandsError) return error;
    if (method === 'exec') return execError('unknown', String(error));
    const path =
      typeof params.path === 'string' ? this.path(params) : undefined;
    return toFileError(error, path);
  }

  private fail(id: number, error: HandsError): void {
    this.send({ id, error: error.detail });
  }

  private path(params: Params, key = 'path'): string {
    const { cwd, home } = this.options;
    return resolvePath(text(params, key), cwd, home);
  }

  private hello(): Hello {
    const { epoch, cwd, home, tmp, watchdogMs, limits } = this.options;
    return {
      protocol: PROTOCOL_VERSION,
      version: HANDS_VERSION,
      epoch,
      pid: process.pid,
      cwd,
      home,
      tmp,
      watchdogMs,
      limits,
    };
  }

  private exec(params: Params, signal: AbortSignal, id: number) {
    const { cwd, home, shell, tmp, limits } = this.options;
    const asked = execParams(params);
    if (asked.cwd !== undefined) asked.cwd = resolvePath(asked.cwd, cwd, home);
    return runExec(
      asked,
      signal,
      { cwd, shell, tmp, limits, groups: this.groups },
      (update, force) => this.sendUpdate(id, update, force),
    );
  }

  private readonly handlers: Handlers = {
    hello: async () => this.hello(),
    ping: async () => null,
    readTextFile: async (p, signal) =>
      (await this.files.read(this.path(p), signal)).toString('utf8'),
    readTextLines: (p, signal) =>
      this.files.readTextLines(this.path(p), integer(p, 'maxLines'), signal),
    readBinaryFile: async (p, signal) =>
      (await this.files.read(this.path(p), signal)).toString('base64'),
    writeFile: (p, signal) =>
      this.files.write(this.path(p), content(p), false, signal),
    appendFile: (p, signal) =>
      this.files.write(this.path(p), content(p), true, signal),
    renameFile: (p) =>
      this.files.rename(this.path(p, 'from'), this.path(p, 'to')),
    fileInfo: (p) => this.files.fileInfo(this.path(p)),
    listDir: (p, signal) => this.files.listDir(this.path(p), signal),
    canonicalPath: (p) => this.files.canonicalPath(this.path(p)),
    exists: (p) => this.files.exists(this.path(p)),
    createDir: (p) =>
      this.files.createDir(this.path(p), flag(p, 'recursive') ?? true),
    remove: (p) =>
      this.files.remove(
        this.path(p),
        flag(p, 'recursive') ?? false,
        flag(p, 'force') ?? false,
      ),
    createTempDir: (p) =>
      this.files.createTempDir(optionalText(p, 'prefix') ?? 'tmp-'),
    createTempFile: (p) =>
      this.files.createTempFile(
        optionalText(p, 'prefix') ?? '',
        optionalText(p, 'suffix') ?? '',
      ),
    'reader.open': (p) => this.files.openReader(this.path(p)),
    'reader.readLine': (p, signal) =>
      this.files.readLine(requiredInteger(p, 'reader'), signal),
    'reader.close': (p) => this.files.closeReader(requiredInteger(p, 'reader')),
    exec: (p, signal, id) => this.exec(p, signal, id),
    cleanup: async () => {
      await this.files.closeAll();
      for (const call of this.calls.values()) {
        if (call.method === 'exec') call.controller.abort();
      }
      return null;
    },
  };
}

function isObject(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(message: string): HandsError {
  return protocolError('bad_request', message);
}

function text(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== 'string') throw bad(`${key} must be a string`);
  return value;
}

function optionalText(p: Params, key: string): string | undefined {
  return p[key] === undefined ? undefined : text(p, key);
}

function flag(p: Params, key: string): boolean | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw bad(`${key} must be a boolean`);
  return value;
}

function integer(p: Params, key: string): number | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw bad(`${key} must be an integer`);
  return value as number;
}

function requiredInteger(p: Params, key: string): number {
  const value = integer(p, key);
  if (value === undefined) throw bad(`${key} is required`);
  return value;
}

function content(p: Params): string | Buffer {
  const body = text(p, 'content');
  const encoding = optionalText(p, 'encoding') ?? 'utf8';
  if (encoding === 'base64') return Buffer.from(body, 'base64');
  if (encoding !== 'utf8') throw bad('encoding must be utf8 or base64');
  return body;
}

function execParams(p: Params): ExecParams {
  const env = p.env;
  if (
    env !== undefined &&
    (!isObject(env) || !Object.values(env).every((v) => typeof v === 'string'))
  ) {
    throw bad('env must map names to strings');
  }
  const timeout = p.timeout;
  if (timeout !== undefined && typeof timeout !== 'number') {
    throw bad('timeout must be a number');
  }
  return {
    command: text(p, 'command'),
    cwd: optionalText(p, 'cwd'),
    env: env as Record<string, string> | undefined,
    inheritEnv: flag(p, 'inheritEnv'),
    timeout,
    capture: capture(p.capture),
    updates: flag(p, 'updates'),
  };
}

function capture(value: unknown): ExecParams['capture'] {
  if (value === undefined) return undefined;
  if (!isObject(value) || !isObject(value.limits)) {
    throw bad('capture must have limits');
  }
  const { maxBytes, maxLines, retain } = value.limits;
  if (typeof maxBytes !== 'number' || typeof maxLines !== 'number') {
    throw bad('capture limits must be numbers');
  }
  if (retain !== undefined && retain !== 'head' && retain !== 'tail') {
    throw bad('capture retain must be head or tail');
  }
  return {
    limits: { maxBytes, maxLines, retain },
    spill: flag(value, 'spill'),
  };
}
