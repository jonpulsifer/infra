/**
 * Test support for the hands: the real mate-hands daemon on pipes shaped like
 * an exec stream, and a recorder for the hands instruments. The pipes never
 * send EOF when mate closes, as a pods/exec v4 stream cannot.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { SandboxConfig } from '../src/config.ts';
import { Epochs } from '../src/hands-env.ts';
import {
  type ExecClose,
  type ExecOptions,
  type ExecStream,
  Kube,
} from '../src/kube.ts';
import type {
  HandsCallResult,
  HandsConnectResult,
  HandsConnectSample,
  HandsDropReason,
  HandsInstruments,
  KubeHandsDeps,
  LeaseEvent,
  MintResult,
  MintSample,
  SandboxGoneReason,
  TeardownReason,
  ThreadHands,
  ThreadHandsHooks,
  TokenSource,
  TurnSandboxSource,
} from '../src/lease.ts';
import type { TurnLeaseImpl } from '../src/sandbox-lease.ts';
import { KubeHands } from '../src/sandboxes.ts';
import type { ThreadRef } from '../src/surface.ts';
import { FakeKube } from './fakeapi.ts';
import { RecordingLog } from './support.ts';

export const DAEMON = Bun.resolveSync('@repo/mate-hands/main', import.meta.dir);

export class RecordingHandsInstruments implements HandsInstruments {
  live = 0;
  waiters = 0;
  pool: { ready: number; wanted: number } | null = null;
  readonly mints: MintResult[] = [];
  readonly mintSamples: MintSample[] = [];
  readonly connects: {
    result: HandsConnectResult;
    sample: HandsConnectSample;
  }[] = [];
  readonly calls: { method: string; result: HandsCallResult; ms: number }[] =
    [];
  readonly drops: HandsDropReason[] = [];
  readonly tokenMints: string[] = [];
  readonly tokenStamps: string[] = [];
  readonly siteSyncs: string[] = [];
  readonly teardowns: TeardownReason[] = [];
  readonly turnSandboxes: TurnSandboxSource[] = [];

  sandboxesLive(count: number): void {
    this.live = count;
  }
  sandboxWaiters(count: number): void {
    this.waiters = count;
  }
  spares(ready: number, wanted: number): void {
    this.pool = { ready, wanted };
  }
  minted(result: MintResult, sample?: MintSample): void {
    this.mints.push(result);
    if (sample) this.mintSamples.push(sample);
  }
  handsConnected(result: HandsConnectResult, sample: HandsConnectSample): void {
    this.connects.push({ result, sample });
  }
  handsCall(method: string, result: HandsCallResult, ms: number): void {
    this.calls.push({ method, result, ms });
  }
  handsDropped(reason: HandsDropReason): void {
    this.drops.push(reason);
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
  teardown(reason: TeardownReason): void {
    this.teardowns.push(reason);
  }
  turnSandbox(source: TurnSandboxSource): void {
    this.turnSandboxes.push(source);
  }
}

const dirs: string[] = [];
const spawned: ReturnType<typeof Bun.spawn>[] = [];

export function tempDir(name: string): string {
  const made = mkdtempSync(join(tmpdir(), `mate-hands-${name}-`));
  dirs.push(made);
  return made;
}

/** Stops every rig and daemon started here and removes every temp dir. */
export async function cleanUp(): Promise<void> {
  await closeRigs();
  for (const proc of spawned.splice(0)) {
    proc.kill('SIGTERM');
    // A test may have left it stopped.
    proc.kill('SIGCONT');
    await proc.exited;
  }
  for (const made of dirs.splice(0)) {
    rmSync(made, { recursive: true, force: true });
  }
}

export interface Started {
  exec: ExecStream;
  proc: ReturnType<typeof Bun.spawn>;
  cwd: string;
  state: string;
}

export interface DaemonOptions {
  epoch?: number;
  cwd?: string;
  home?: string;
  state?: string;
  args?: string[];
}

/** A daemon on pipes. `close()` sends no EOF, as a pods/exec stream cannot. */
export function daemon(opts: DaemonOptions = {}): Started {
  const cwd = opts.cwd ?? tempDir('cwd');
  const state = opts.state ?? tempDir('state');
  const proc = Bun.spawn(
    [
      '/bin/sh',
      '-c',
      'umask 000; exec "$@"',
      'mate-hands',
      process.execPath,
      DAEMON,
      '--epoch',
      String(opts.epoch ?? 1),
      '--cwd',
      cwd,
      '--state-dir',
      state,
      ...(opts.args ?? []),
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...(opts.home ? { HOME: opts.home } : {}),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
    },
  );
  spawned.push(proc);
  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      proc.stdin.write(chunk);
      await proc.stdin.flush();
    },
  });
  const exec: ExecStream = {
    stdout: proc.stdout,
    stdin,
    closed: proc.exited.then(
      (code): ExecClose => ({
        code,
        reason: `exited ${code}`,
        status:
          code === 0
            ? { status: 'Success' }
            : { status: 'Failure', message: `exit status ${code}` },
      }),
    ),
    close: () => {},
  };
  return { exec, proc, cwd, state };
}

/** The flag that follows `name` in a hands command. */
function flag(command: string[], name: string): string | undefined {
  const at = command.indexOf(name);
  return at < 0 ? undefined : command[at + 1];
}

export interface PipeKube {
  kube: Kube;
  /** Every daemon an exec started, oldest first. */
  readonly started: Started[];
  readonly commands: string[][];
}

/**
 * A `Kube` whose exec starts the daemon on pipes, in `cwd` with `home`, all
 * sharing one ledger, as the execs into one pod do.
 */
export function pipeKube(opts: {
  cwd: string;
  home?: string;
  state?: string;
  args?: string[];
}): PipeKube {
  const state = opts.state ?? tempDir('state');
  const started: Started[] = [];
  const commands: string[][] = [];
  const kube = {
    namespace: 'mate',
    async exec(exec: ExecOptions): Promise<ExecStream> {
      commands.push(exec.command);
      const run = daemon({
        epoch: Number(flag(exec.command, '--epoch')),
        cwd: opts.cwd,
        home: opts.home,
        state,
        args: opts.args,
      });
      started.push(run);
      return run.exec;
    },
  } as unknown as Kube;
  return { kube, started, commands };
}

export function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

/** The pids a command wrote into `path`, once there are `count` of them. */
export async function pidsIn(path: string, count: number): Promise<number[]> {
  for (let i = 0; i < 250; i++) {
    const pids = await Bun.file(path)
      .text()
      .then((t) => t.split('\n').filter(Boolean).map(Number))
      .catch(() => []);
    if (pids.length >= count) return pids;
    await Bun.sleep(20);
  }
  throw new Error(`no pids in ${path}`);
}

export async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('it never happened');
    await Bun.sleep(10);
  }
}

export const THREAD: ThreadRef = {
  surface: 'discord',
  id: '1509024937422356777',
  channelId: '1509024937422356532',
};
export const OTHER_THREAD: ThreadRef = {
  surface: 'discord',
  id: '1509024937422356999',
  channelId: '1509024937422356532',
};
export const THIRD_THREAD: ThreadRef = {
  surface: 'discord',
  id: '1509024937422356888',
  channelId: '1509024937422356532',
};
export const GUILD = '1509024936717455381';

/** A sandbox config with every credential off; tests turn on what they check. */
export const SANDBOX_CONFIG: SandboxConfig = {
  image:
    'ghcr.io/jonpulsifer/mate-sandbox:latest@sha256:6f135be2df9ddf2cca529e845b3325cba5c6e72c8587c1ce48ec30bd5b10cbac',
  runtimeClass: 'kata-clh',
  namespace: 'mate',
  checkoutRepo: 'https://github.com/jonpulsifer/infra',
  checkoutRef: 'main',
  turnTimeoutMs: 4000,
  spares: 0,
  vault: null,
  kubeServiceAccount: null,
  kubeContext: 'offsite',
  kubePeers: [],
  github: false,
  kthx: {
    origin: null,
    sitesSecret: 'mate-kthx-sites',
  },
  switchboard: null,
};

export class Hooks implements ThreadHandsHooks {
  readonly sandboxes: string[] = [];
  readonly gone: SandboxGoneReason[] = [];
  onSandbox(name: string): void {
    this.sandboxes.push(name);
  }
  onSandboxGone(reason: SandboxGoneReason): void {
    this.gone.push(reason);
  }
}

export interface Turn {
  readonly lease: TurnLeaseImpl;
  readonly env: ThreadHands['env'];
  readonly events: LeaseEvent[];
  /** Each event's kind, with a step's step. */
  kinds(): string[];
  /** Aborts the turn's signal, as the brain does when the turn ends. */
  end(): void;
}

export function begin(thread: ThreadHands): Turn {
  const events: LeaseEvent[] = [];
  const controller = new AbortController();
  const lease = thread.beginTurn({
    onEvent: (event) => events.push(event),
    signal: controller.signal,
  }) as TurnLeaseImpl;
  return {
    lease,
    env: thread.env,
    events,
    kinds: () =>
      events.map((e) => (e.kind === 'step' ? `step:${e.step}` : e.kind)),
    end: () => controller.abort(),
  };
}

/** A context whose signal the test aborts, as pi's Stop does a tool's. */
export function aborting(): { context: Context; abort: () => void } {
  const controller = new AbortController();
  return {
    context: withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    abort: () => controller.abort(),
  };
}

export class FakeApp implements TokenSource {
  minted = 0;
  asked = 0;
  readonly revoked: string[] = [];
  failMint: Error | null = null;
  /** Holds every mint until it settles, as a slow GitHub does. */
  hold: Promise<void> | null = null;
  async token(): Promise<{ token: string }> {
    this.asked += 1;
    if (this.hold) await this.hold;
    if (this.failMint) throw this.failMint;
    this.minted += 1;
    return { token: `ghs-token-${this.minted}` };
  }
  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }
}

export interface Rig {
  readonly fake: FakeKube;
  readonly kube: Kube;
  readonly log: RecordingLog;
  readonly metrics: RecordingHandsInstruments;
  readonly workspace: string;
  readonly home: string;
  hands: KubeHands;
  /** Another KubeHands on the same cluster, as a restarted mate would be. */
  another(overrides?: Partial<KubeHandsDeps>): KubeHands;
}

const fakes: FakeKube[] = [];

/** KubeHands on a FakeKube whose pods run the real daemon. */
export function rig(
  opts: { config?: Partial<SandboxConfig>; deps?: Partial<KubeHandsDeps> } = {},
): Rig {
  const workspace = tempDir('workspace');
  const home = tempDir('home');
  const fake = new FakeKube({
    hands: { workspace, home, stateRoot: tempDir('state') },
  });
  fakes.push(fake);
  const kube = new Kube(fake.config());
  const log = new RecordingLog();
  const metrics = new RecordingHandsInstruments();
  const make = (overrides: Partial<KubeHandsDeps> = {}) =>
    new KubeHands(
      {
        kube,
        config: { ...SANDBOX_CONFIG, ...opts.config },
        guildId: GUILD,
        maxSandboxes: 4,
        log,
        metrics,
        readyTimeoutMs: 4000,
        goneTimeoutMs: 4000,
        ...opts.deps,
        ...overrides,
      },
      { workspace, home, expectHome: home, epochs: new Epochs() },
    );
  return {
    fake,
    kube,
    log,
    metrics,
    workspace,
    home,
    hands: make(),
    another: make,
  };
}

/** Stops every rig's apiserver and daemons. */
export async function closeRigs(): Promise<void> {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
}
