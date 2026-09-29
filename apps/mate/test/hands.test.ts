/**
 * The hands client against the real daemon, over pipes shaped like an exec
 * stream. The pipes never send EOF when mate closes, as a pods/exec v4 stream
 * cannot, so the daemon ends only on what the client says.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyUpdate,
  type Hello,
  type ShellOutputView,
} from '@repo/mate-hands/protocol';
import { type Clock, systemClock } from '../src/clock.ts';
import {
  HANDS_BINARY,
  HandsClient,
  HandsError,
  handsCommand,
} from '../src/hands.ts';
import type { ExecStream } from '../src/kube.ts';
import {
  alive,
  cleanUp,
  daemon,
  pidsIn,
  type Started,
  tempDir,
} from './hands-support.ts';
import { RecordingLog } from './support.ts';

/** A stream that answers `hello` with `hello` and ignores everything else. */
function scripted(hello: Partial<Hello>): ExecStream {
  const encoder = new TextEncoder();
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const answer = (line: string) => output?.enqueue(encoder.encode(line));
  const close = () => {
    output?.close();
    output = undefined;
    ended();
  };
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    }),
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        const request = JSON.parse(new TextDecoder().decode(chunk));
        if (request.method === 'hello') {
          answer(`${JSON.stringify({ id: request.id, result: hello })}\n`);
        }
      },
    }),
    closed: closed.then(() => ({ code: 0, reason: 'closed', status: null })),
    close,
  };
}

async function connect(run: Started, epoch = 1, log = new RecordingLog()) {
  return HandsClient.connect(run.exec, { epoch, log, fields: { test: true } });
}

afterEach(cleanUp);

async function failure(promise: Promise<unknown>): Promise<HandsError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HandsError);
  return error as HandsError;
}

describe('handsCommand', () => {
  test('starts the installed daemon with its epoch and workspace', () => {
    expect(handsCommand({ epoch: 42, cwd: '/workspace' })).toEqual([
      HANDS_BINARY,
      '--epoch',
      '42',
      '--cwd',
      '/workspace',
    ]);
    expect(
      handsCommand({ epoch: 1, cwd: '/w', watchdogMs: 5000 }).slice(-2),
    ).toEqual(['--watchdog-ms', '5000']);
  });
});

describe('connect', () => {
  test('hello gives the workspace, home and limits', async () => {
    const run = daemon({ epoch: 7 });
    const client = await connect(run, 7);
    expect(client.hello).toMatchObject({
      protocol: 2,
      epoch: 7,
      cwd: run.cwd,
      pid: run.proc.pid,
    });
    await client.close();
  });

  test('a daemon started for another epoch is refused', async () => {
    const error = await failure(connect(daemon({ epoch: 3 }), 4));
    expect(error.detail).toMatchObject({ kind: 'protocol', code: 'mismatch' });
  });

  test('a stale epoch is superseded by the owner it names', async () => {
    const state = tempDir('shared');
    const owner = await connect(daemon({ epoch: 9, state }), 9);
    const stale = daemon({ epoch: 2, state });
    const error = await failure(connect(stale, 2));
    expect(error.detail).toMatchObject({ code: 'superseded', epoch: 9 });
    expect(error.ownerEpoch).toBe(9);
    expect(await stale.proc.exited).toBe(2);
    expect(await owner.call('ping', {})).toBeNull();
    await owner.close();
  });

  test('a daemon on another protocol is refused', async () => {
    const exec = scripted({ protocol: 1, epoch: 1 });
    const error = await failure(
      HandsClient.connect(exec, { epoch: 1, log: new RecordingLog() }),
    );
    expect(error.detail).toEqual({
      kind: 'protocol',
      code: 'mismatch',
      message: 'hands speak protocol 1, mate speaks 2',
    });
    expect(error.ownerEpoch).toBeUndefined();
  });

  test('a default daemon watches for 30s, and the client pings every 10s', async () => {
    const delays: number[] = [];
    const clock: Clock = {
      ...systemClock,
      after: (ms, fn) => {
        delays.push(ms);
        return systemClock.after(ms, fn);
      },
    };
    const client = await HandsClient.connect(daemon().exec, {
      epoch: 1,
      log: new RecordingLog(),
      clock,
    });
    expect(client.hello.watchdogMs).toBe(30_000);
    expect(delays.at(-1)).toBe(10_000);
    await client.close();
  });
});

describe('calls', () => {
  test('every file method round trips', async () => {
    const run = daemon();
    const client = await connect(run);
    const call = client.call.bind(client);
    await call('writeFile', { path: 'd/a.txt', content: 'one\ntwo\n' });
    await call('appendFile', { path: 'd/a.txt', content: 'three' });
    expect(await call('readTextFile', { path: 'd/a.txt' })).toBe(
      'one\ntwo\nthree',
    );
    expect(
      await call('readTextLines', { path: 'd/a.txt', maxLines: 2 }),
    ).toEqual(['one', 'two']);
    await call('writeFile', {
      path: 'd/b.bin',
      content: Buffer.from([0, 255]).toString('base64'),
      encoding: 'base64',
    });
    expect(await call('readBinaryFile', { path: 'd/b.bin' })).toBe('AP8=');
    await call('renameFile', { from: 'd/b.bin', to: 'd/c.bin' });
    expect(await call('fileInfo', { path: 'd/c.bin' })).toMatchObject({
      kind: 'file',
      size: 2,
      path: join(run.cwd, 'd/c.bin'),
    });
    expect(
      (await call('listDir', { path: 'd' })).map((f) => f.name).sort(),
    ).toEqual(['a.txt', 'c.bin']);
    expect(await call('canonicalPath', { path: 'd/../d/a.txt' })).toBe(
      join(run.cwd, 'd/a.txt'),
    );
    expect(await call('exists', { path: 'd/b.bin' })).toBe(false);
    await call('createDir', { path: 'e/f', recursive: true });
    await call('remove', { path: 'e', recursive: true });
    expect(await call('exists', { path: 'e' })).toBe(false);
    expect(await call('createTempDir', { prefix: 'p-' })).toContain('p-');
    expect(await call('createTempFile', { suffix: '.log' })).toEndWith('.log');
    const { reader } = await call('reader.open', { path: 'd/a.txt' });
    expect(await call('reader.readLine', { reader })).toEqual({
      text: 'one',
      terminated: true,
    });
    await call('reader.close', { reader });
    expect(await call('cleanup', {})).toBeNull();
    await client.close();
  });

  test('writeFiles writes files with their modes', async () => {
    const run = daemon();
    const client = await connect(run);
    const { written } = await client.call('writeFiles', {
      files: [
        { path: 'creds/token', content: 'ghs-a-token', mode: 0o600 },
        { path: 'creds/sites.json', content: '{}', mode: 0o600 },
      ],
    });
    expect(written).toBe(2);
    expect(readFileSync(join(run.cwd, 'creds/token'), 'utf8')).toBe(
      'ghs-a-token',
    );
    expect(statSync(join(run.cwd, 'creds/token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(run.cwd, 'creds')).mode & 0o777).toBe(0o700);
    await client.close();
  });

  test('a file error keeps its kind, code and path', async () => {
    const run = daemon();
    const client = await connect(run);
    const error = await failure(client.call('readTextFile', { path: 'nope' }));
    expect(error.detail).toMatchObject({
      kind: 'file',
      code: 'not_found',
      path: join(run.cwd, 'nope'),
    });
    await client.close();
  });

  test('exec streams its output to onUpdate', async () => {
    const client = await connect(daemon());
    let view: ShellOutputView | undefined;
    const result = await client.call(
      'exec',
      { command: 'for i in 1 2; do echo $i; sleep 0.2; done', updates: true },
      { onUpdate: (update) => (view = applyUpdate(view, update)) },
    );
    expect(result.exitCode).toBe(0);
    expect(view?.text).toBe('1\n2\n');
    await client.close();
  });

  test('a request over the daemon limit fails without being sent', async () => {
    const client = await connect(daemon({ args: ['--max-read-bytes', '10'] }));
    const content = 'x'.repeat(client.hello.limits.maxRequestBytes);
    const error = await failure(
      client.call('writeFile', { path: 'big', content }),
    );
    expect(error.detail.code).toBe('too_large');
    expect(await client.call('ping', {})).toBeNull();
    await client.close();
  });
});

describe('cancellation', () => {
  test('an abort kills the command group before the call settles', async () => {
    const run = daemon();
    const client = await connect(run);
    const pids = join(run.cwd, 'pids');
    const controller = new AbortController();
    const call = client.call(
      'exec',
      { command: `sleep 300 & echo $! > ${pids}; echo $$ >> ${pids}; wait` },
      { signal: controller.signal },
    );
    const group = await pidsIn(pids, 2);
    controller.abort();
    const error = await failure(call);
    expect(error.detail).toMatchObject({ kind: 'exec', code: 'aborted' });
    await Bun.sleep(100);
    expect(group.filter(alive)).toEqual([]);
    await client.close();
  });

  test('an already aborted signal fails without a round trip', async () => {
    const client = await connect(daemon());
    const error = await failure(
      client.call(
        'readTextFile',
        { path: 'x' },
        { signal: AbortSignal.abort() },
      ),
    );
    expect(error.detail).toMatchObject({ kind: 'file', code: 'aborted' });
    await client.close();
  });

  test('an onUpdate that throws cancels the command as callback_error', async () => {
    const client = await connect(daemon());
    const started = Date.now();
    const error = await failure(
      client.call(
        'exec',
        { command: 'echo go; sleep 300', updates: true },
        {
          onUpdate: () => {
            throw new Error('renderer broke');
          },
        },
      ),
    );
    expect(error.detail).toEqual({
      kind: 'exec',
      code: 'callback_error',
      message: 'renderer broke',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await client.close();
  });
});

describe('lifetime', () => {
  test('pings keep an idle daemon past its watchdog', async () => {
    // Pings every 300ms; the idle wait spans two watchdog windows.
    const run = daemon({ args: ['--watchdog-ms', '900'] });
    const client = await connect(run);
    await Bun.sleep(1_800);
    expect(alive(run.proc.pid)).toBe(true);
    expect(await client.call('ping', {})).toBeNull();
    await client.close();
  });

  test('close tells the daemon to kill its children and exit', async () => {
    const run = daemon();
    const client = await connect(run);
    const pids = join(run.cwd, 'pids');
    const call = client.call('exec', {
      command: `echo $$ > ${pids}; sleep 300`,
    });
    const [shell] = await pidsIn(pids, 1);
    await client.close();
    expect((await failure(call)).detail.code).toBe('closed');
    expect(await run.proc.exited).toBe(0);
    expect(alive(shell as number)).toBe(false);
    expect(client.isClosed).toBe(true);
  });

  test('a daemon that dies fails every pending call', async () => {
    const run = daemon();
    const client = await connect(run);
    const pids = join(run.cwd, 'pids');
    const call = client.call('exec', {
      command: `echo $$ > ${pids}; sleep 300`,
    });
    const [shell] = await pidsIn(pids, 1);
    run.proc.kill('SIGKILL');
    // Nothing is left to kill the orphaned group.
    process.kill(-(shell as number), 'SIGKILL');
    const error = await failure(call);
    expect(error.detail).toMatchObject({ kind: 'protocol', code: 'closed' });
    expect((await client.closed).code).not.toBe(0);
    const after = await failure(client.call('ping', {}));
    expect(after.detail.code).toBe('closed');
  });

  test('a daemon that stops answering is given up on', async () => {
    const run = daemon({ args: ['--watchdog-ms', '300'] });
    const log = new RecordingLog();
    const client = await connect(run, 1, log);
    const call = client.call('exec', { command: 'sleep 300' });
    run.proc.kill('SIGSTOP');
    const error = await failure(call);
    expect(error.detail).toMatchObject({ code: 'unresponsive' });
    expect(log.of('hands stopped answering pings')).toHaveLength(1);
    // Resumed, its watchdog has expired: it kills the command and exits.
    run.proc.kill('SIGCONT');
    expect(await run.proc.exited).toBe(3);
  });
});
