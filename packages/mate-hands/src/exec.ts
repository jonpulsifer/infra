/**
 * One shell command: bash in its own process group, output captured within
 * bounds and streamed as updates, a spill file when asked, a timeout, and a
 * kill of the whole group on cancel.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, statSync, writeSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { Capture, diff } from './capture.ts';
import { type Group, type Groups, killGroup } from './groups.ts';
import {
  type ExecParams,
  execError,
  type HandsError,
  type Limits,
  protocolError,
  type ShellExecResult,
  type ShellOutputLimits,
  type ShellOutputUpdate,
  type ShellOutputView,
} from './protocol.ts';

const DEFAULT_LIMITS: ShellOutputLimits = {
  maxBytes: 50 * 1024,
  maxLines: 2000,
  retain: 'tail',
};
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
// pi's publication pace: at most ten updates a second, and a large update
// buys a proportionally longer pause.
const MIN_UPDATE_MS = 100;
const UPDATE_BYTES_PER_SECOND = 100 * 1024;
// A command's background children can hold its pipes open after it exits;
// output that goes quiet this long after the exit ends the capture.
const EXIT_QUIET_MS = 100;

export interface ExecDeps {
  cwd: string;
  shell: string;
  tmp: string;
  limits: Limits;
  groups: Groups;
}

/**
 * Sends an update and returns true, or returns false while the stream is
 * backed up. A forced update is always sent.
 */
export type SendUpdate = (update: ShellOutputUpdate, force: boolean) => boolean;

interface Run {
  child: ChildProcess;
  group: Group;
  params: ExecParams;
  limits: Required<ShellOutputLimits>;
  timeoutMs: number | undefined;
  signal: AbortSignal;
}

function checkTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw execError(
      'timeout',
      'Invalid timeout: must be a finite number of seconds',
    );
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw execError(
      'timeout',
      `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
    );
  }
  return timeout * 1000;
}

function captureLimits(
  params: ExecParams,
  limits: Limits,
): Required<ShellOutputLimits> {
  const asked = params.capture?.limits ?? DEFAULT_LIMITS;
  if (!Number.isFinite(asked.maxBytes) || asked.maxBytes <= 0) {
    throw execError('unknown', 'Output maxBytes must be a positive number');
  }
  if (!Number.isInteger(asked.maxLines) || asked.maxLines <= 0) {
    throw execError('unknown', 'Output maxLines must be a positive integer');
  }
  return {
    maxBytes: Math.min(Math.floor(asked.maxBytes), limits.maxCaptureBytes),
    maxLines: Math.min(asked.maxLines, limits.maxCaptureLines),
    retain: asked.retain === 'head' ? 'head' : 'tail',
  };
}

/**
 * The complete output, once the view is truncated. Chunks before that point
 * are held, which the limits bound; output past `maxBytes` is left out.
 */
class Spill {
  private held: Uint8Array[] = [];
  private fd: number | null = null;
  private written = 0;
  path: string | undefined;

  constructor(
    private readonly tmp: string,
    private readonly maxBytes: number,
  ) {}

  push(chunk: Uint8Array, truncated: boolean): void {
    if (this.fd === null && !truncated) {
      this.held.push(chunk);
      return;
    }
    if (this.fd === null) {
      this.path = join(this.tmp, `mate-hands-output-${randomUUID()}.log`);
      this.fd = openSync(this.path, 'wx', 0o600);
      for (const held of this.held) this.write(held);
      this.held = [];
    }
    this.write(chunk);
  }

  private write(chunk: Uint8Array): void {
    const room = this.maxBytes - this.written;
    if (room <= 0 || this.fd === null) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    writeSync(this.fd, part);
    this.written += part.length;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.held = [];
  }
}

function textOf(update: ShellOutputUpdate): string {
  if (update.kind === 'replace') return update.output.text;
  return update.kind === 'metadata' ? '' : update.text;
}

function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let exitedYet = false;
    let open = 2;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(quiet);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // A process a signal killed has no code: report 128 plus the signal,
      // as a shell does.
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    };
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, EXIT_QUIET_MS);
    };
    const ended = () => {
      open -= 1;
      if (exitedYet && open === 0) done();
    };
    child.stdout?.once('end', ended);
    child.stderr?.once('end', ended);
    child.stdout?.on('data', () => exitedYet && arm());
    child.stderr?.on('data', () => exitedYet && arm());
    child.once('error', reject);
    child.once('exit', (exitCode, exitSignal) => {
      exitedYet = true;
      code = exitCode;
      signal = exitSignal;
      if (open === 0) done();
      else arm();
    });
  });
}

export async function runExec(
  params: ExecParams,
  signal: AbortSignal,
  deps: ExecDeps,
  send: SendUpdate,
): Promise<ShellExecResult> {
  const timeoutMs = checkTimeout(params.timeout);
  const limits = captureLimits(params, deps.limits);
  const cwd = params.cwd ?? deps.cwd;
  if (!existsSync(deps.shell)) {
    throw execError('shell_unavailable', `No shell at ${deps.shell}`);
  }
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw execError(
      'spawn_error',
      `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
    );
  }
  if (signal.aborted) throw execError('aborted', 'aborted');
  if (deps.groups.runningCount >= deps.limits.maxRunning) {
    throw protocolError(
      'busy',
      `${deps.limits.maxRunning} commands are already running`,
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(deps.shell, ['-c', params.command], {
      cwd,
      env:
        params.inheritEnv === false
          ? { ...params.env }
          : { ...process.env, ...params.env },
      // A new session, so the command and its children share one group.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw execError('spawn_error', String(error));
  }
  const pid = child.pid;
  if (pid === undefined) {
    const error = await new Promise<Error>((resolve) =>
      child.once('error', resolve),
    );
    throw execError('spawn_error', error.message);
  }
  const group = deps.groups.started(pid);
  return watch({ child, group, params, limits, timeoutMs, signal }, deps, send);
}

async function watch(
  run: Run,
  deps: ExecDeps,
  send: SendUpdate,
): Promise<ShellExecResult> {
  const { child, group, params, signal } = run;
  const capture = new Capture(run.limits);
  const spill = params.capture?.spill
    ? new Spill(deps.tmp, deps.limits.maxSpillBytes)
    : null;
  let failure: HandsError | null = null;
  let timedOut = false;
  let sent: ShellOutputView | undefined;
  let dirty = false;
  let nextAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => killGroup(group);

  const publish = (final: boolean) => {
    timer = undefined;
    if (!params.updates || !(dirty || (final && sent === undefined))) return;
    const view = capture.view(spill?.path);
    const update = diff(sent, view);
    // The final view must go out: pi's bash tool reads its text from it.
    if (!send(update, final)) {
      timer = setTimeout(() => publish(false), MIN_UPDATE_MS);
      return;
    }
    sent = view;
    dirty = false;
    const cost = (textOf(update).length / UPDATE_BYTES_PER_SECOND) * 1000;
    nextAt = Date.now() + Math.max(MIN_UPDATE_MS, cost);
  };
  const feed = (chunk: Uint8Array) => {
    capture.push(chunk);
    try {
      spill?.push(chunk, capture.truncated);
    } catch (error) {
      failure ??= execError(
        'unknown',
        `Failed to preserve complete shell output: ${String(error)}`,
      );
      kill();
    }
    dirty = true;
    timer ??= setTimeout(
      () => publish(false),
      Math.max(0, nextAt - Date.now()),
    );
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);

  const deadline =
    run.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          kill();
        }, run.timeoutMs);
  signal.addEventListener('abort', kill, { once: true });

  let exitCode: number;
  try {
    exitCode = await exited(child);
  } catch (error) {
    failure ??= execError('spawn_error', String(error));
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    clearTimeout(timer);
    signal.removeEventListener('abort', kill);
    deps.groups.exited(group);
    spill?.close();
  }
  if (capture.finish()) dirty = true;
  publish(true);

  if (timedOut) {
    throw execError(
      'timeout',
      `Command timed out after ${params.timeout} seconds`,
    );
  }
  if (signal.aborted) throw execError('aborted', 'aborted');
  if (failure) throw failure;
  const view = capture.view(spill?.path);
  return {
    exitCode,
    truncation: view.truncation,
    ...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
    ...(view.lastLineBytes === undefined
      ? {}
      : { lastLineBytes: view.lastLineBytes }),
  };
}
