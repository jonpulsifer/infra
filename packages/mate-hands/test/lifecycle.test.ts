/**
 * How a daemon ends, and what it leaves: stdin EOF, `shutdown`, the watchdog,
 * and a newer epoch taking over. Every way kills the process groups it
 * started, including background children of finished commands.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  alive,
  eventually,
  Hands,
  pidsIn,
  removeScratch,
  scratch,
} from './support.ts';

const running: Hands[] = [];

function hands(options: ConstructorParameters<typeof Hands>[0] = {}): Hands {
  const started = new Hands(options);
  running.push(started);
  return started;
}

// A daemon still running is shut down, so no test leaves a `sleep 300`.
afterEach(async () => {
  for (const h of running.splice(0)) {
    try {
      h.send({ method: 'shutdown', params: {} });
    } catch {}
    await Promise.race([h.exited, Bun.sleep(3_000)]);
    h.kill();
  }
  removeScratch();
});

/**
 * Starts one running command and one finished command that left a
 * background child, and returns the pids to watch.
 */
async function busy(h: Hands, dir: string): Promise<number[]> {
  const bg = join(dir, 'bg.pids');
  await h.result('exec', {
    command: `(sleep 300 & echo $! > ${bg})`,
  });
  const fg = join(dir, 'fg.pids');
  void h.call('exec', { command: `echo $$ > ${fg}; sleep 300` });
  return [...(await pidsIn(bg, 1)), ...(await pidsIn(fg, 1))];
}

async function allDead(pids: number[]): Promise<boolean> {
  return eventually(() => pids.every((pid) => !alive(pid)));
}

describe('ending', () => {
  test('stdin EOF kills every child, removes the record and exits 0', async () => {
    const dir = scratch();
    const state = scratch('state');
    const h = hands({ cwd: dir, stateDir: state });
    const pids = await busy(h, dir);
    expect(pids.every(alive)).toBe(true);
    expect(readdirSync(state)).toEqual([`1-${h.pid}.json`]);
    h.end();
    expect(await h.exited).toBe(0);
    expect(await allDead(pids)).toBe(true);
    expect(readdirSync(state)).toEqual([]);
  });

  test('shutdown does the same on a stream that stays open', async () => {
    const dir = scratch();
    const h = hands({ cwd: dir });
    const pids = await busy(h, dir);
    h.send({ method: 'shutdown', params: {} });
    expect(await h.exited).toBe(0);
    expect(await allDead(pids)).toBe(true);
  });

  test('the watchdog exits 3 when no message arrives in time', async () => {
    const dir = scratch();
    const h = hands({ cwd: dir, args: ['--watchdog-ms', '400'] });
    const pids = await busy(h, dir);
    expect(await h.exited).toBe(3);
    expect(await allDead(pids)).toBe(true);
    expect(h.stderr.join('')).toContain('watchdog expired');
  });

  test('pings keep the watchdog fed', async () => {
    const h = hands({ args: ['--watchdog-ms', '1000'] });
    for (let i = 0; i < 8; i++) {
      expect(await h.result('ping')).toBeNull();
      await Bun.sleep(250);
    }
    expect(alive(h.pid)).toBe(true);
  });
});

describe('epochs', () => {
  test('a newer daemon kills the older one and its groups', async () => {
    const dir = scratch();
    const state = scratch('state');
    const old = hands({ epoch: 5, cwd: dir, stateDir: state });
    const pids = await busy(old, dir);
    const next = hands({ epoch: 6, cwd: dir, stateDir: state });
    expect(await next.result('ping')).toBeNull();
    expect(await old.exited).not.toBe(0);
    expect(await allDead(pids)).toBe(true);
    expect(readdirSync(state)).toEqual([`6-${next.pid}.json`]);
    expect(next.stderr.join('')).toContain('took over from an older daemon');
  });

  test('a newer daemon kills groups a killed daemon left', async () => {
    const dir = scratch();
    const state = scratch('state');
    const old = hands({ epoch: 1, cwd: dir, stateDir: state });
    const pids = await busy(old, dir);
    old.kill();
    await old.exited;
    expect(pids.every(alive)).toBe(true);
    const next = hands({ epoch: 2, cwd: dir, stateDir: state });
    expect(await next.result('ping')).toBeNull();
    expect(await allDead(pids)).toBe(true);
  });

  test('an older or equal epoch is superseded and leaves the owner alone', async () => {
    const dir = scratch();
    const state = scratch('state');
    const owner = hands({ epoch: 9, cwd: dir, stateDir: state });
    const pids = await busy(owner, dir);
    for (const epoch of [8, 9]) {
      const stale = hands({ epoch, cwd: dir, stateDir: state });
      expect(await stale.error('hello')).toMatchObject({
        kind: 'protocol',
        code: 'superseded',
        message: expect.stringContaining('epoch 9'),
      });
      expect(await stale.exited).toBe(2);
    }
    expect(await owner.result('ping')).toBeNull();
    expect(pids.every(alive)).toBe(true);
    expect(readdirSync(state)).toEqual([`9-${owner.pid}.json`]);
  });
});
