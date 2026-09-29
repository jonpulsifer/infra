/**
 * The wire protocol between mate and mate-hands, the tool daemon in each
 * sandbox. Messages are newline-delimited JSON on one stdio stream. mate sends
 * `{id, method, params}` and the daemon answers `{id, result}` or
 * `{id, error}`. Calls run at the same time, so a caller that needs one to
 * follow another waits for its answer. Notifications have no id: the daemon
 * streams `exec.update`, and mate sends `cancel` and `shutdown`.
 *
 * The file and shell shapes mirror the `FileSystem` and `Shell` interfaces of
 * pi-agent-core's `ExecutionEnv`, and error codes are its `FileError` and
 * `ExecutionError` codes, so an adapter maps each one straight across.
 */
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = 2;
export const HANDS_VERSION = '0.2.0';

export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unknown';

export type ExecErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown';

export type ProtocolErrorCode =
  /** A malformed message or parameter. */
  | 'bad_request'
  | 'unknown_method'
  /** A request line over `Limits.maxRequestBytes`. */
  | 'too_large'
  /** Too many calls, commands or readers open at once. */
  | 'busy'
  /** A daemon with a newer epoch owns the sandbox. */
  | 'superseded'
  /** The daemon speaks another protocol version or epoch. */
  | 'mismatch'
  | 'closed'
  /** The daemon stopped answering pings. */
  | 'unresponsive';

export type WireError =
  | { kind: 'file'; code: FileErrorCode; message: string; path?: string }
  | { kind: 'exec'; code: ExecErrorCode; message: string }
  | {
      kind: 'protocol';
      code: ProtocolErrorCode;
      message: string;
      /** On `superseded`, the epoch of the daemon that owns the sandbox. */
      epoch?: number;
    };

export class HandsError extends Error {
  override readonly name = 'HandsError';
  constructor(readonly detail: WireError) {
    super(detail.message);
  }

  /** The owner's epoch on a `superseded` error, for a retry past it. */
  get ownerEpoch(): number | undefined {
    const { detail } = this;
    if (detail.kind !== 'protocol' || detail.code !== 'superseded') {
      return undefined;
    }
    return Number.isSafeInteger(detail.epoch) ? detail.epoch : undefined;
  }
}

export function fileError(
  code: FileErrorCode,
  message: string,
  path?: string,
): HandsError {
  return new HandsError({
    kind: 'file',
    code,
    message,
    ...(path === undefined ? {} : { path }),
  });
}

export function execError(code: ExecErrorCode, message: string): HandsError {
  return new HandsError({ kind: 'exec', code, message });
}

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
): HandsError {
  return new HandsError({ kind: 'protocol', code, message });
}

export function supersededBy(epoch: number): HandsError {
  return new HandsError({
    kind: 'protocol',
    code: 'superseded',
    message: `a daemon with epoch ${epoch} owns this sandbox`,
    epoch,
  });
}

export type FileKind = 'file' | 'directory' | 'symlink';

export interface FileInfo {
  name: string;
  /** Absolute and normalized; symlinks are not followed. */
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface TextLine {
  text: string;
  /** False for a final line with no `\n`. */
  terminated: boolean;
}

export interface ShellOutputLimits {
  maxBytes: number;
  maxLines: number;
  /** Defaults to `tail`. */
  retain?: 'head' | 'tail';
}

export interface ShellOutputCapture {
  limits: ShellOutputLimits;
  /** Keep the complete output in a file once the limits are crossed. */
  spill?: boolean;
}

export interface ShellOutputTruncation {
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface ShellOutputMetadata {
  truncation: ShellOutputTruncation;
  spillPath?: string;
  lastLineBytes?: number;
}

export interface ShellOutputView extends ShellOutputMetadata {
  text: string;
}

export type ShellOutputUpdate =
  | { kind: 'replace'; output: ShellOutputView }
  | { kind: 'append'; text: string; metadata: ShellOutputMetadata }
  | { kind: 'slide'; drop: number; text: string; metadata: ShellOutputMetadata }
  | { kind: 'metadata'; metadata: ShellOutputMetadata };

export interface ShellExecResult extends ShellOutputMetadata {
  exitCode: number;
}

export interface ExecParams {
  command: string;
  /** Defaults to the daemon's cwd. */
  cwd?: string;
  env?: Record<string, string>;
  /** Defaults to true. */
  inheritEnv?: boolean;
  /** Seconds. */
  timeout?: number;
  /** Defaults to 50 KiB and 2000 lines of tail, without a spill file. */
  capture?: ShellOutputCapture;
  /** Stream `exec.update` notifications for this call. */
  updates?: boolean;
}

export interface Limits {
  /** The largest file a read returns, in bytes. */
  maxReadBytes: number;
  /** The longest request line the daemon reads, in bytes. */
  maxRequestBytes: number;
  /** Ceilings on `capture.limits`. */
  maxCaptureBytes: number;
  maxCaptureLines: number;
  /** Output past this is left out of a spill file. */
  maxSpillBytes: number;
  maxListEntries: number;
  maxInflight: number;
  maxRunning: number;
  maxReaders: number;
}

export interface Hello {
  protocol: number;
  version: string;
  epoch: number;
  pid: number;
  cwd: string;
  home: string;
  tmp: string;
  /** The daemon exits when no message arrives for this long. */
  watchdogMs: number;
  limits: Limits;
}

type NoParams = Record<string, never>;
type PathParams = { path: string };
type WriteParams = {
  path: string;
  content: string;
  /** Defaults to `utf8`. */
  encoding?: 'utf8' | 'base64';
};

export interface FileWrite extends WriteParams {
  /** Permission bits, which the daemon's umask does not narrow. */
  mode: number;
}

export interface Methods {
  hello: { params: NoParams; result: Hello };
  ping: { params: NoParams; result: null };
  readTextFile: { params: PathParams; result: string };
  readTextLines: {
    params: { path: string; maxLines?: number };
    result: string[];
  };
  /** Base64. */
  readBinaryFile: { params: PathParams; result: string };
  writeFile: { params: WriteParams; result: null };
  appendFile: { params: WriteParams; result: null };
  /**
   * Replaces each file through a temp file and a rename, so a symlink at a
   * path is replaced, not followed. A failure names its path; the files
   * before it stay written.
   */
  writeFiles: {
    params: {
      files: FileWrite[];
      /** The mode of each missing parent it makes. Defaults to 0o700. */
      dirMode?: number;
    };
    result: { written: number };
  };
  renameFile: { params: { from: string; to: string }; result: null };
  fileInfo: { params: PathParams; result: FileInfo };
  listDir: { params: PathParams; result: FileInfo[] };
  canonicalPath: { params: PathParams; result: string };
  exists: { params: PathParams; result: boolean };
  createDir: { params: { path: string; recursive?: boolean }; result: null };
  remove: {
    params: { path: string; recursive?: boolean; force?: boolean };
    result: null;
  };
  createTempDir: { params: { prefix?: string }; result: string };
  createTempFile: {
    params: { prefix?: string; suffix?: string };
    result: string;
  };
  'reader.open': { params: PathParams; result: { reader: number } };
  'reader.readLine': { params: { reader: number }; result: TextLine | null };
  'reader.close': { params: { reader: number }; result: null };
  exec: { params: ExecParams; result: ShellExecResult };
  /** Closes every reader and kills every running command. */
  cleanup: { params: NoParams; result: null };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]['params'];
export type Result<M extends Method> = Methods[M]['result'];

export interface Notifications {
  'exec.update': { id: number; update: ShellOutputUpdate };
  cancel: { id: number };
  /** Kill every child and exit, for a stream that cannot deliver EOF. */
  shutdown: NoParams;
}

export interface Request {
  id: number;
  method: string;
  params?: unknown;
}

export type Response =
  | { id: number; result: unknown }
  | { id: number; error: WireError };

export interface Notification {
  method: keyof Notifications;
  params: unknown;
}

export function encode(message: Request | Response | Notification): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The id of the request a line starts with, read from its first bytes, so a
 * line too long to parse can still be answered. JSON.stringify keeps key
 * order, and both sides write `id` first.
 */
export function leadingId(head: string): number | undefined {
  const match = /^\s*\{\s*"id"\s*:\s*(\d+)/.exec(head);
  return match ? Number(match[1]) : undefined;
}

const HEAD_BYTES = 64;
const decoder = new TextDecoder();

/**
 * Splits a byte stream on `\n`. A line longer than `maxBytes` is dropped
 * without being buffered, and `onOversize` gets its first bytes.
 */
export class LineSplitter {
  private parts: Uint8Array[] = [];
  private size = 0;
  private dropped: string | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversize: (head: string) => void,
  ) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      this.take(chunk.subarray(start, end));
      if (newline === -1) return;
      this.endLine();
      start = newline + 1;
    }
  }

  private take(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.dropped !== null) return;
    if (this.size + bytes.length > this.maxBytes) {
      const head = joined([...this.parts, bytes]).subarray(0, HEAD_BYTES);
      this.dropped = decoder.decode(head);
      this.parts = [];
      this.size = 0;
      return;
    }
    this.parts.push(bytes);
    this.size += bytes.length;
  }

  private endLine(): void {
    if (this.dropped !== null) {
      const head = this.dropped;
      this.dropped = null;
      this.onOversize(head);
      return;
    }
    const line = decoder.decode(joined(this.parts));
    this.parts = [];
    this.size = 0;
    if (line.trim()) this.onLine(line);
  }
}

function joined(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0]) return parts[0];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** pi's path rules: `~` is home, a `file://` URL is its path, and a relative path is under `cwd`. */
export function resolvePath(path: string, cwd: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return posix.join(home, path.slice(2));
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path);
    } catch {}
  }
  return posix.resolve(cwd, path);
}

/** Applies one update to the view it was made against. */
export function applyUpdate(
  view: ShellOutputView | undefined,
  update: ShellOutputUpdate,
): ShellOutputView {
  switch (update.kind) {
    case 'replace':
      return update.output;
    case 'append':
      return { text: `${view?.text ?? ''}${update.text}`, ...update.metadata };
    case 'slide':
      return {
        text: `${view?.text.slice(update.drop) ?? ''}${update.text}`,
        ...update.metadata,
      };
    case 'metadata':
      return { text: view?.text ?? '', ...update.metadata };
  }
}
