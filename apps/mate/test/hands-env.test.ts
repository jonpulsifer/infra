/**
 * HandsEnv and HandsLink against the real daemon on pipes: pi's
 * ExecutionEnv semantics, and what happens when the daemon stops answering.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { type Hello, PROTOCOL_VERSION } from '@repo/mate-hands/protocol';
import { type Clock, systemClock } from '../src/clock.ts';
import type { HandsClient } from '../src/hands.ts';
import {
  Epochs,
  FILE_DEADLINE_MS,
  HandsEnv,
  HandsImageTooOld,
  HandsLink,
  type LeaseAccess,
  LeaseFailure,
  supersededEpoch,
  unseen,
} from '../src/hands-env.ts';
import type { ExecOptions, ExecStream, Kube } from '../src/kube.ts';
import type { HandsDropReason } from '../src/lease.ts';
import { plain } from '../src/log.ts';
import {
  alive,
  cleanUp,
  daemon,
  pidsIn,
  pipeKube,
  RecordingHandsInstruments,
  tempDir,
  until,
} from './hands-support.ts';
import { FakeClock, RecordingLog } from './support.ts';

afterEach(cleanUp);

const C = BACKGROUND_CONTEXT;

/** The lease a turn would give: the link's client, or why there is none. */
class LinkLease implements LeaseAccess {
  gate: Promise<void> | null = null;
  failure: LeaseFailure | null = null;
  asked = 0;

  constructor(readonly link: HandsLink) {}

  async client(signal: AbortSignal | undefined) {
    this.asked += 1;
    if (this.gate) await this.gate;
    if (this.failure) return this.failure;
    try {
      return await this.link.get(signal);
    } catch (error) {
      return new LeaseFailure(plain(error), Boolean(signal?.aborted));
    }
  }

  current(): HandsClient | null {
    return this.link.current();
  }

  drop(client: HandsClient, reason: HandsDropReason): void {
    this.link.drop(client, reason);
  }
}

interface Setup {
  cwd: string;
  home: string;
  env: HandsEnv;
  link: HandsLink;
  lease: LinkLease;
  metrics: RecordingHandsInstruments;
  log: RecordingLog;
  epochs: () => number[];
  started: ReturnType<typeof pipeKube>['started'];
}

function setup(
  opts: { clock?: Clock; state?: string; cwd?: string } = {},
): Setup {
  const cwd = opts.cwd ?? tempDir('ws');
  const home = tempDir('home');
  const piped = pipeKube({ cwd, home, state: opts.state });
  const log = new RecordingLog();
  const metrics = new RecordingHandsInstruments();
  const link = new HandsLink({
    kube: piped.kube,
    namespace: 'mate',
    log,
    metrics,
    cwd,
    expectHome: home,
    epochs: new Epochs(),
    locate: async () => ({ sandbox: 'mate-1', pod: 'mate-1' }),
  });
  const lease = new LinkLease(link);
  const env = new HandsEnv({
    cwd,
    home,
    clock: opts.clock ?? systemClock,
    metrics,
    lease: () => lease,
  });
  return {
    cwd,
    home,
    env,
    link,
    lease,
    metrics,
    log,
    started: piped.started,
    epochs: () =>
      piped.commands.map((c) => Number(c[c.indexOf('--epoch') + 1])),
  };
}

function aborting(): { context: Context; abort: () => void } {
  const controller = new AbortController();
  return {
    context: withAbortSignal(controller.signal, C),
    abort: () => controller.abort(),
  };
}

/** A result with the run's root path swapped out and the clock readings dropped. */
function shape(result: unknown, root: string): unknown {
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll(root, '<root>');
    if (value instanceof Uint8Array) return [...value];
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === 'object') {
      if (value instanceof Error) {
        const e = value as Error & { code?: string; path?: string };
        return { error: e.constructor.name, code: e.code, path: swap(e.path) };
      }
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'mtimeMs')
          .map(([key, v]) => [key, key === 'spillPath' ? Boolean(v) : swap(v)]),
      );
    }
    return value;
  };
  return swap(result);
}

/** What a tail-keeping reader holds: the last 2000 lines, as the daemon's view drops the final newline. */
function tailOf(text: string): string {
  return text.replace(/\n$/, '').split('\n').slice(-2000).join('\n');
}

/** One script, run the same way against any env rooted at `root`. */
async function script(env: ExecutionEnv, root: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const note = (label: string, result: unknown) =>
    out.push([label, shape(result, root)]);
  const exec = async (
    command: string,
    options: Parameters<ExecutionEnv['exec']>[1] = {},
  ) => {
    let text = '';
    const result = await env.exec(
      command,
      {
        ...options,
        onOutput: (chunk) => {
          text += chunk;
        },
      },
      C,
    );
    return { result, text: tailOf(text) };
  };
  note('write', await env.writeFile('a/b.txt', 'one\ntwo\nthree', C));
  note('append', await env.appendFile('a/b.txt', '\nfour\n', C));
  note('read', await env.readTextFile('a/b.txt', C));
  note('lines', await env.readTextLines('a/b.txt', { maxLines: 2 }, C));
  note('all lines', await env.readTextLines('a/b.txt', undefined, C));
  note('no lines', await env.readTextLines('a/b.txt', { maxLines: 0 }, C));
  note(
    'write bytes',
    await env.writeFile('bin', new Uint8Array([0, 1, 255]), C),
  );
  note('read bytes', await env.readBinaryFile('bin', C));
  note('info', await env.fileInfo('a/b.txt', C));
  const listed = await env.listDir('a', C);
  note('list', listed.ok ? listed.value.map((f) => [f.name, f.kind]) : listed);
  note('rename', await env.renameFile('a/b.txt', 'a/c.txt', C));
  note('canonical', await env.canonicalPath('a/../a/c.txt', C));
  note('exists', await env.exists('a/c.txt', C));
  note('exists missing', await env.exists('nope', C));
  note('read missing', await env.readTextFile('nope', C));
  note('read a directory', await env.readTextFile('a', C));
  note('rename missing', await env.renameFile('gone', 'here', C));
  note('mkdir', await env.createDir('x/y/z', undefined, C));
  note('rm dir', await env.remove('x', { recursive: true }, C));
  note('rm missing', await env.remove('nope', undefined, C));
  note('rm missing forced', await env.remove('nope', { force: true }, C));
  const reader = await env.openTextLineReader('a/c.txt', C);
  if (reader.ok) {
    const lines = [];
    for (let at = 0; at < 6; at += 1)
      lines.push(await reader.value.readLine(C));
    await reader.value.close(C);
    note('reader', lines);
  } else {
    note('reader', reader);
  }
  // stdout and stderr are separate pipes; either may arrive first. Compare
  // their content without assuming a cross-pipe order.
  const mixed = await exec('echo hi; echo err >&2; exit 3');
  note('exec', { ...mixed, text: mixed.text.split('\n').sort().join('\n') });
  note(
    'exec truncated',
    await exec('for i in $(seq 1 3000); do echo line $i; done', {
      spill: { afterBytes: 50 * 1024, afterLines: 2000 },
    }),
  );
  note('exec cwd', await exec('pwd', { cwd: 'a' }));
  note(
    'exec env',
    await exec('echo "$MATE_TEST_VALUE"', {
      env: { MATE_TEST_VALUE: 'set' },
      inheritEnv: false,
    }),
  );
  note('exec timeout', await exec('sleep 5', { timeout: 0.3 }));
  note('exec bad timeout', await exec('true', { timeout: -1 }));
  return out;
}

describe('HandsEnv', () => {
  test('answers a script as pi’s NodeExecutionEnv does', async () => {
    // Roots of one length, so byte counts of printed paths agree.
    const local = tempDir('local');
    const expected = await script(new NodeExecutionEnv({ cwd: local }), local);
    const { env, cwd } = setup({ cwd: tempDir('hands') });
    const actual = await script(env, cwd);
    expect(actual).toEqual(expected);
  });

  test('never rejects, with no link or with bad params', async () => {
    const { env, lease, link } = setup();
    const every = (target: ExecutionEnv) => [
      target.readTextFile('a', C),
      target.openTextLineReader('a', C),
      target.readTextLines('a', { maxLines: Number.NaN }, C),
      target.readBinaryFile('a', C),
      target.writeFile('a', 'x', C),
      target.appendFile('a', new Uint8Array([1]), C),
      target.renameFile('a', 'b', C),
      target.fileInfo('a', C),
      target.listDir('a', C),
      target.canonicalPath('a', C),
      target.exists('a', C),
      target.createDir('a', undefined, C),
      target.remove('a', undefined, C),
      target.createTempDir(undefined, C),
      target.createTempFile(undefined, C),
      target.truncateFile('a', 0, C),
      target.flushFile('a', C),
      target.exec('true', { timeout: Number.NaN }, C),
    ];
    lease.failure = new LeaseFailure('no sandbox this turn');
    for (const result of await Promise.all(every(env))) {
      expect(result.ok).toBe(false);
    }
    lease.failure = null;
    link.seal();
    for (const result of await Promise.all(every(env))) {
      expect(result.ok).toBe(false);
    }
    const outside = new HandsEnv({ lease: () => null });
    const [first] = await Promise.all(every(outside));
    expect(first?.ok ? null : first?.error.message).toBe('no turn is running');
  });

  test('a call that is already aborted asks nothing of the sandbox', async () => {
    const { env, lease, started } = setup();
    const { context, abort } = aborting();
    abort();
    const read = await env.readTextFile('a', context);
    const run = await env.exec('true', undefined, context);
    expect(read.ok ? null : read.error.code).toBe('aborted');
    expect(run.ok ? null : run.error.code).toBe('aborted');
    expect(lease.asked).toBe(0);
    expect(started).toHaveLength(0);
  });

  test('aborting a command kills its whole group', async () => {
    const { env, cwd } = setup();
    const pids = join(cwd, 'pids');
    const { context, abort } = aborting();
    const running = env.exec(
      `sleep 300 & echo $! > ${pids}; echo $$ >> ${pids}; wait`,
      undefined,
      context,
    );
    const group = await pidsIn(pids, 2);
    abort();
    const result = await running;
    expect(result.ok ? null : result.error.code).toBe('aborted');
    await until(() => group.every((pid) => !alive(pid)));
  });

  test('an abort the daemon never answers settles after the grace, and drops the link', async () => {
    const clock = new FakeClock();
    const { env, cwd, link, metrics, started } = setup({ clock });
    const pids = join(cwd, 'pids');
    const { context, abort } = aborting();
    const running = env.exec(
      `echo $$ > ${pids}; sleep 300`,
      undefined,
      context,
    );
    await pidsIn(pids, 1);
    const stalled = started[0]?.proc;
    stalled?.kill('SIGSTOP');
    abort();
    await clock.advance(4_999);
    expect(link.current()).not.toBeNull();
    await clock.advance(1);
    const result = await running;
    expect(result.ok ? null : result.error.code).toBe('aborted');
    expect(link.current()).toBeNull();
    expect(metrics.drops).toEqual(['abort-grace']);
    stalled?.kill('SIGCONT');
  });

  test('a file call past its deadline drops the link, and the next epoch kills what the old daemon left', async () => {
    const clock = new FakeClock();
    const { env, cwd, metrics, started, epochs } = setup({ clock });
    const pids = join(cwd, 'pids');
    void env.exec(`sleep 300 & echo $! > ${pids}; wait`, undefined, C);
    const [sleeper] = await pidsIn(pids, 1);
    started[0]?.proc.kill('SIGSTOP');
    const reading = env.readTextFile('pids', C);
    await clock.advance(FILE_DEADLINE_MS);
    const read = await reading;
    expect(read.ok ? null : [read.error.code, read.error.message]).toEqual([
      'unknown',
      'no answer in 60s',
    ]);
    expect(metrics.drops).toEqual(['deadline']);
    expect(metrics.calls.find((c) => c.method === 'readTextFile')?.result).toBe(
      'deadline',
    );

    const again = await env.exists('pids', C);
    expect(again.ok && again.value).toBe(true);
    const [first, second] = epochs();
    expect(second).toBeGreaterThan(first as number);
    await until(() => !alive(sleeper as number));
    expect(alive(started[0]?.proc.pid as number)).toBe(false);
  });

  test('the file deadline waits for the lease: a slow first write still lands', async () => {
    const clock = new FakeClock();
    const { env, cwd, lease } = setup({ clock });
    let open: () => void = () => {};
    lease.gate = new Promise((resolve) => {
      open = resolve;
    });
    const writing = env.writeFile('late.txt', 'still here', C);
    await clock.advance(90_000);
    open();
    const written = await writing;
    expect(written.ok).toBe(true);
    expect(readFileSync(join(cwd, 'late.txt'), 'utf8')).toBe('still here');
  });

  test('a reader from before a reconnect is closed', async () => {
    const { env, cwd, link } = setup();
    writeFileSync(join(cwd, 'lines.txt'), 'one\ntwo\n');
    const opened = await env.openTextLineReader('lines.txt', C);
    if (!opened.ok) throw opened.error;
    const first = await opened.value.readLine(C);
    expect(first.ok && first.value).toEqual({ text: 'one', terminated: true });
    await link.close();
    expect((await env.exists('lines.txt', C)).ok).toBe(true);
    const stale = await opened.value.readLine(C);
    expect(stale.ok ? null : [stale.error.code, stale.error.message]).toEqual([
      'invalid',
      'Text line reader is closed',
    ]);
    expect(stale.ok ? null : stale.error.path).toBe(join(cwd, 'lines.txt'));
  });

  test('each env names its own file namespace, and a given id is kept', () => {
    const { env } = setup();
    const other = setup().env;
    expect(env.id).not.toBe(other.id);
    expect(env.id).toBe(env.id);
    expect(new HandsEnv({ id: 'thread-1', lease: () => null }).id).toBe(
      'thread-1',
    );
  });

  test('streams every chunk raw and spills the whole output past the thresholds', async () => {
    const { env } = setup();
    let seen = '';
    const result = await env.exec(
      'for i in $(seq 1 3000); do echo line $i; done',
      {
        onOutput: (text) => {
          seen += text;
        },
        spill: { afterBytes: 50 * 1024, afterLines: 2000 },
      },
      C,
    );
    if (!result.ok) throw result.error;
    expect(result.value.exitCode).toBe(0);
    const full = readFileSync(result.value.spillPath as string, 'utf8');
    expect(full.split('\n')).toHaveLength(3001);
    expect(seen.trimEnd().endsWith('line 3000')).toBe(true);
    const quiet = await env.exec('echo hi', { spill: undefined }, C);
    expect(quiet.ok && quiet.value).toEqual({ exitCode: 0 });
  });

  test('a command that times out past the threshold still names its spill file', async () => {
    const { env } = setup();
    const result = await env.exec(
      'for i in $(seq 1 3000); do echo line $i; done; sleep 5',
      { timeout: 1, spill: { afterBytes: 50 * 1024, afterLines: 2000 } },
      C,
    );
    if (result.ok) throw new Error('expected a timeout');
    expect(result.error.code).toBe('timeout');
    expect(readFileSync(result.error.spillPath as string, 'utf8')).toContain(
      'line 3000',
    );
  });

  test('an output callback that throws fails the command', async () => {
    const { env } = setup();
    const result = await env.exec(
      'echo hi; sleep 5',
      {
        onOutput: () => {
          throw new Error('boom');
        },
      },
      C,
    );
    expect(
      result.ok ? null : [result.error.code, result.error.message],
    ).toEqual(['callback_error', 'boom']);
  });

  test('truncating and flushing a file are not supported', async () => {
    const { env, lease } = setup();
    const truncated = await env.truncateFile('a', 0, C);
    const flushed = await env.flushFile('a', C);
    expect(truncated.ok ? null : truncated.error.code).toBe('not_supported');
    expect(flushed.ok ? null : flushed.error.code).toBe('not_supported');
    expect(lease.asked).toBe(0);
  });

  test('cleanup and absolutePath never connect', async () => {
    const { env, home, lease, started } = setup();
    await env.cleanup(C);
    const path = await env.absolutePath('~/x', C);
    expect(path.ok && path.value).toBe(join(home, 'x'));
    const joined = await env.joinPath(['/a', 'b', '../c'], C);
    expect(joined.ok && joined.value).toBe('/a/c');
    expect(lease.asked).toBe(0);
    expect(started).toHaveLength(0);
  });
});

describe('HandsLink', () => {
  test('a live owner past the clock is superseded by its epoch plus one', async () => {
    const state = tempDir('ledger');
    const cwd = tempDir('ws');
    const ahead = Date.now() + 10_000_000;
    const owner = daemon({ epoch: ahead, cwd, state });
    await until(() => readdirSync(state).length > 0);
    const { env, metrics, epochs } = setup({ state, cwd });
    const found = await env.exists('.', C);
    expect(found.ok && found.value).toBe(true);
    expect(epochs()).toEqual([expect.any(Number), ahead + 1]);
    expect(metrics.connects.map((c) => c.result)).toEqual(['superseded', 'ok']);
    // The newer daemon kills the one it took over from.
    await until(() => !alive(owner.proc.pid));
  });

  test('a daemon on another protocol, or none at all, is an image too old', async () => {
    const log = new RecordingLog();
    const metrics = new RecordingHandsInstruments();
    for (const stream of [scripted({ protocol: 1 }), failing()]) {
      const link = new HandsLink({
        kube: { exec: async () => stream } as unknown as Kube,
        namespace: 'mate',
        log,
        metrics,
        locate: async () => ({ sandbox: 'mate-1', pod: 'mate-1' }),
      });
      const error = await link.get().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HandsImageTooOld);
    }
    expect(metrics.connects.map((c) => c.result)).toEqual([
      'mismatch',
      'mismatch',
    ]);
  });

  test('a daemon whose home is not where credentials go is refused', async () => {
    const metrics = new RecordingHandsInstruments();
    const link = new HandsLink({
      kube: {
        exec: async (opts: ExecOptions) =>
          scripted({
            epoch: Number(opts.command[opts.command.indexOf('--epoch') + 1]),
            home: '/root',
            watchdogMs: 30_000,
          }),
      } as unknown as Kube,
      namespace: 'mate',
      log: new RecordingLog(),
      metrics,
      expectHome: '/home/agent',
      locate: async () => ({ sandbox: 'mate-1', pod: 'mate-1' }),
    });
    await expect(link.get()).rejects.toThrow(
      "the daemon's home is /root, not /home/agent",
    );
    expect(link.current()).toBeNull();
    expect(link.generation).toBe(0);
    expect(metrics.connects.map((c) => c.result)).toEqual(['failed']);
  });

  test('a failed open answers every caller for a while, then tries again', async () => {
    const clock = new FakeClock();
    let opens = 0;
    const link = new HandsLink({
      kube: {
        exec: async () => {
          opens += 1;
          throw new Error('exec refused (403)');
        },
      } as unknown as Kube,
      namespace: 'mate',
      log: new RecordingLog(),
      clock,
      locate: async () => ({ sandbox: 'mate-1', pod: 'mate-1' }),
    });
    await expect(link.get()).rejects.toThrow('exec refused');
    await expect(link.get()).rejects.toThrow('exec refused');
    expect(opens).toBe(1);
    await clock.advance(3_000);
    await expect(link.get()).rejects.toThrow('exec refused');
    expect(opens).toBe(2);
  });

  test('supersededEpoch reads the owner epoch and nothing else', () => {
    expect(supersededEpoch(new Error('x'))).toBeNull();
  });

  test('logs what the daemon prints, a line at a time and redacted', async () => {
    const log = new RecordingLog();
    const link = new HandsLink({
      kube: {
        exec: async (opts: ExecOptions) => {
          opts.onStderr?.(
            '{"level":"warn","msg":"auth failed: sk-abcd1234efgh5678ijklmnop"}\n{"level":"info","msg":"par',
          );
          opts.onStderr?.('tial"}\n');
          const at = opts.command.indexOf('--epoch');
          return scripted({
            epoch: Number(opts.command[at + 1]),
            watchdogMs: 30_000,
          });
        },
      } as unknown as Kube,
      namespace: 'mate',
      log,
      locate: async () => ({ sandbox: 'mate-1', pod: 'mate-1' }),
    });
    await link.get();
    const said = log.of('hands said');
    expect(said.map((entry) => entry.level)).toEqual(['warn', 'info']);
    expect(said[0]?.fields).toMatchObject({ sandbox: 'mate-1', pod: 'mate-1' });
    expect(String(said[0]?.fields?.line)).toContain('auth failed: [redacted]');
    expect(said[1]?.fields?.line).toBe('{"level":"info","msg":"partial"}');
    await link.close();
  });
});

const TOOL_USE = { stopReason: 'toolUse' } as const;

describe('a pi harness on the hands', () => {
  test('bash, read, write and edit run in the sandbox', async () => {
    const { env, cwd } = setup();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'notes.md', content: 'hello hands\n' })],
        TOOL_USE,
      ),
      fauxAssistantMessage(
        [fauxToolCall('read', { path: 'notes.md' })],
        TOOL_USE,
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('edit', {
            path: 'notes.md',
            edits: [{ oldText: 'hello', newText: 'goodbye' }],
          }),
        ],
        TOOL_USE,
      ),
      fauxAssistantMessage(
        [fauxToolCall('bash', { command: 'cat notes.md; echo "cwd=$(pwd)"' })],
        TOOL_USE,
      ),
      fauxAssistantMessage('done'),
    ]);
    const registry = createRegistry();
    registry.install(CodingTools);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: () => env },
      C,
    );
    const model = faux.getModel();
    const root = await harness.root(C, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const submission = await root.submit({ type: 'input', content: 'go' }, C);
    const settled = await submission.wait(C);
    expect(settled.status).toBe('done');
    const page = await root.entries({}, 50, undefined, C);
    const results = page.items
      .filter((entry) => entry.kind === 'pi.tool-result')
      .reverse()
      .map((entry) => {
        const [message] = entry.model ?? [];
        const content = message?.role === 'toolResult' ? message.content : [];
        return {
          error: message?.role === 'toolResult' && message.isError,
          text: content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
        };
      });
    await harness.close(C);
    expect(results.map((r) => r.error)).toEqual([false, false, false, false]);
    expect(results[1]?.text).toContain('hello hands');
    expect(results[3]?.text).toContain('goodbye hands');
    expect(results[3]?.text).toContain(`cwd=${cwd}`);
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('goodbye hands\n');
  });
});

/** A stream that answers `hello` as `hello` says and ignores everything else. */
function scripted(hello: Partial<Hello>): ExecStream {
  const encoder = new TextEncoder();
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        for (const line of new TextDecoder().decode(chunk).split('\n')) {
          if (!line.trim()) continue;
          const request = JSON.parse(line);
          if (request.method !== 'hello') continue;
          const result = { protocol: PROTOCOL_VERSION, epoch: 1, ...hello };
          output?.enqueue(
            encoder.encode(`${JSON.stringify({ id: request.id, result })}\n`),
          );
        }
      },
    }),
    closed: new Promise(() => {}),
    close: () => output?.close(),
  };
}

/** An exec whose binary is missing: it fails before it says anything. */
function failing(): ExecStream {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    stdin: new WritableStream<Uint8Array>(),
    closed: Promise.resolve({
      code: 1000,
      reason: '',
      status: {
        status: 'Failure',
        message: 'exec: "mate-hands": executable file not found in $PATH',
      },
    }),
    close: () => {},
  };
}

describe('a replaced tail', () => {
  const cases: [string, string, string, string][] = [
    ['continues what was delivered', 'one\ntwo\n', 'two\nthree\n', 'three\n'],
    ['repeats it whole', 'one\ntwo\n', 'one\ntwo\n', ''],
    ['shares nothing with it', 'one\n', 'nine\nten\n', 'nine\nten\n'],
    ['overlaps by less than the probe', 'abc', 'cde', 'de'],
    ['follows nothing', '', 'first\n', 'first\n'],
    [
      'overlaps at its second match',
      `${'ab'.repeat(40)}X${'ab'.repeat(20)}`,
      `${'ab'.repeat(20)}tail`,
      'tail',
    ],
  ];
  for (const [name, tail, text, rest] of cases) {
    test(name, () => {
      expect(unseen(tail, text)).toBe(rest);
    });
  }
});
