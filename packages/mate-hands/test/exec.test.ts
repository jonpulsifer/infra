/**
 * `exec` through a real daemon: exit codes, streamed output, bounded capture
 * with truncation and spill, timeouts, and cancellation of a whole process
 * group.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyUpdate,
  type ShellExecResult,
  type ShellOutputView,
} from '../src/protocol.ts';
import {
  alive,
  eventually,
  Hands,
  pidsIn,
  removeScratch,
  scratch,
} from './support.ts';

let hands: Hands;
let cwd: string;

beforeAll(() => {
  cwd = scratch('exec');
  hands = new Hands({ cwd });
});

afterAll(async () => {
  hands.end();
  await hands.exited;
  removeScratch();
});

const TAIL = { limits: { maxBytes: 50 * 1024, maxLines: 2000 }, spill: true };

/** Runs a command and folds its updates into the final view. */
async function run(params: Record<string, unknown>) {
  const { id, answer } = hands.start('exec', { updates: true, ...params });
  const settled = await answer;
  const view = hands
    .updatesFor(id)
    .reduce<ShellOutputView | undefined>(applyUpdate, undefined);
  return { settled, view, updates: hands.updatesFor(id) };
}

describe('a command', () => {
  test('reports its exit code and combined output', async () => {
    const { settled, view } = await run({
      command: 'echo out; echo err >&2; exit 3',
    });
    expect(settled).toMatchObject({
      result: { exitCode: 3, truncation: { truncated: false, totalLines: 2 } },
    });
    expect(view?.text.split('\n').sort()).toEqual(['', 'err', 'out']);
  });

  test('runs in the workspace, or in the cwd it is given', async () => {
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    expect((await run({ command: 'pwd' })).view?.text).toBe(`${cwd}\n`);
    expect((await run({ command: 'pwd', cwd: 'sub' })).view?.text).toBe(
      `${join(cwd, 'sub')}\n`,
    );
  });

  test('inherits the environment unless told not to', async () => {
    // Builtins only: without the inherited PATH, bash finds no programs.
    const command =
      'echo "$EXTRA"; [ -n "$HOME" ] && echo "$HOME" || echo none';
    const env = { EXTRA: 'set' };
    expect((await run({ command, env })).view?.text).toBe(
      `set\n${process.env.HOME}\n`,
    );
    expect((await run({ command, env, inheritEnv: false })).view?.text).toBe(
      'set\nnone\n',
    );
  });

  test('streams output while it runs', async () => {
    const { view, updates } = await run({
      command: 'for i in 1 2 3; do echo $i; sleep 0.25; done',
    });
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]?.kind).toBe('replace');
    expect(updates.slice(1).some((u) => u.kind === 'append')).toBe(true);
    expect(view?.text).toBe('1\n2\n3\n');
  });

  test('sends no updates unless asked', async () => {
    const { id, answer } = hands.start('exec', { command: 'echo quiet' });
    expect(await answer).toMatchObject({ result: { exitCode: 0 } });
    expect(hands.updatesFor(id)).toEqual([]);
  });
});

describe('bounded capture', () => {
  test('keeps the last 2000 lines and spills the rest to a file', async () => {
    const { settled, view } = await run({
      command: 'seq 1 3000',
      capture: TAIL,
    });
    const result = (settled as { result: ShellExecResult }).result;
    expect(result.truncation).toMatchObject({
      truncated: true,
      truncatedBy: 'lines',
      totalLines: 3000,
      outputLines: 2000,
    });
    const lines = view?.text.split('\n');
    expect(lines?.[0]).toBe('1001');
    expect(lines?.at(-1)).toBe('3000');
    expect(view?.spillPath).toBe(result.spillPath);
    const spilled = readFileSync(result.spillPath as string, 'utf8');
    expect(spilled.split('\n').filter(Boolean)).toHaveLength(3000);
  });

  test('keeps the end of one line longer than the byte limit', async () => {
    const { settled, view } = await run({
      command: "head -c 100000 /dev/zero | tr '\\0' a",
      capture: { limits: { maxBytes: 1000, maxLines: 10 } },
    });
    expect(settled).toMatchObject({
      result: {
        lastLineBytes: 100_000,
        truncation: {
          truncatedBy: 'bytes',
          lastLinePartial: true,
          outputBytes: 1000,
          totalBytes: 100_000,
        },
      },
    });
    expect(view?.text).toBe('a'.repeat(1000));
  });

  test('keeps the head when asked', async () => {
    const { view } = await run({
      command: 'seq 1 100',
      capture: { limits: { maxBytes: 1024, maxLines: 3, retain: 'head' } },
    });
    expect(view?.text).toBe('1\n2\n3');
  });

  test('writes no spill file for output inside the limits', async () => {
    const { settled } = await run({ command: 'seq 1 5', capture: TAIL });
    expect(settled).toMatchObject({ result: { exitCode: 0 } });
    const result = (settled as { result: ShellExecResult }).result;
    expect(result.spillPath).toBeUndefined();
  });

  test('clamps limits to the daemon ceiling', async () => {
    const { settled } = await run({
      command: 'true',
      capture: { limits: { maxBytes: 1e12, maxLines: 1e9 } },
    });
    expect(settled).toMatchObject({
      result: {
        truncation: { maxBytes: 1024 * 1024, maxLines: 100_000 },
      },
    });
  });
});

describe('ending a command early', () => {
  test('a timeout kills the command and says timeout', async () => {
    const started = Date.now();
    const answer = await hands.call('exec', {
      command: 'sleep 5',
      timeout: 0.3,
    });
    expect(answer).toMatchObject({
      error: { kind: 'exec', code: 'timeout' },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('an invalid timeout is a timeout error, as in pi', async () => {
    expect(await hands.error('exec', { command: 'true', timeout: -1 })).toEqual(
      {
        kind: 'exec',
        code: 'timeout',
        message: 'Invalid timeout: must be a finite number of seconds',
      },
    );
  });

  test('cancel kills every process in the group', async () => {
    const pids = join(cwd, 'cancel.pids');
    const { id, answer } = hands.start('exec', {
      command: `sleep 300 & echo $! > ${pids}; echo $$ >> ${pids}; wait`,
    });
    const [child, shell] = await pidsIn(pids, 2);
    expect(alive(child as number) && alive(shell as number)).toBe(true);
    hands.send({ method: 'cancel', params: { id } });
    expect(await answer).toMatchObject({
      error: { kind: 'exec', code: 'aborted' },
    });
    expect(await eventually(() => !alive(child as number))).toBe(true);
    expect(await eventually(() => !alive(shell as number))).toBe(true);
  });

  test('cleanup aborts running commands', async () => {
    const { answer } = hands.start('exec', { command: 'sleep 300' });
    await Bun.sleep(100);
    await hands.result('cleanup');
    expect(await answer).toMatchObject({ error: { code: 'aborted' } });
  });
});

describe('commands that cannot start', () => {
  test('a missing working directory is spawn_error', async () => {
    expect(
      await hands.error('exec', { command: 'true', cwd: 'no/such/dir' }),
    ).toMatchObject({ kind: 'exec', code: 'spawn_error' });
  });

  test('a missing shell is shell_unavailable', async () => {
    const noShell = new Hands({ args: ['--shell', '/no/such/bash'] });
    expect(await noShell.error('exec', { command: 'true' })).toMatchObject({
      kind: 'exec',
      code: 'shell_unavailable',
    });
    noShell.end();
    await noShell.exited;
  });

  test('a command that is not a string is a bad request', async () => {
    expect(await hands.error('exec', { command: ['ls'] })).toMatchObject({
      kind: 'protocol',
      code: 'bad_request',
    });
  });
});
