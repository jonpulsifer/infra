import { describe, expect, test } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { type ThreadRef, threadKey } from '../src/surface.ts';
import {
  GithubPullRequests,
  MAX_WAKE_MINUTES,
  NO_RUNS_MS,
  PostgresWakeStore,
  type PullRequests,
  type PullState,
  type RepoReader,
  WAKE_INTERVAL_MS,
  type Wake,
  type WakeStore,
  Wakes,
  type WakeTarget,
  wakeTool,
} from '../src/wakes.ts';
import { withDatabase } from './db.ts';
import { FakeClock, RecordingLog } from './support.ts';

const THREAD: ThreadRef = { surface: 'slack', channelId: 'C1', id: '17.1' };
const OTHER: ThreadRef = { surface: 'discord', channelId: 'c2', id: 't2' };
const OWNER = 'U1';

class MemoryWakes implements WakeStore {
  readonly rows = new Map<string, Wake>();
  async put(wake: Wake): Promise<void> {
    this.rows.set(wake.key, wake);
  }
  async list(): Promise<Wake[]> {
    return [...this.rows.values()].sort((a, b) => a.dueAt - b.dueAt);
  }
  async take(key: string, createdAt: number): Promise<boolean> {
    if (this.rows.get(key)?.createdAt !== createdAt) return false;
    return this.rows.delete(key);
  }
  async cancel(key: string): Promise<boolean> {
    return this.rows.delete(key);
  }
}

class Target implements WakeTarget {
  readonly woken: { ref: ThreadRef; asker: string; text: string }[] = [];
  readonly posts: { ref: ThreadRef; text: string }[] = [];
  answer = true;
  async wake(request: {
    ref: ThreadRef;
    asker: string;
    text: string;
  }): Promise<boolean> {
    this.woken.push(request);
    return this.answer;
  }
  async post(ref: ThreadRef, text: string): Promise<void> {
    this.posts.push({ ref, text });
  }
}

function rig(
  opts: { pulls?: PullRequests | null; store?: WakeStore | null } = {},
) {
  const clock = new FakeClock();
  const store = opts.store === undefined ? new MemoryWakes() : opts.store;
  const target = new Target();
  const log = new RecordingLog();
  const wakes = new Wakes({
    store,
    pulls: opts.pulls === undefined ? null : opts.pulls,
    log,
    clock,
  });
  wakes.bind(target);
  return { clock, store, target, log, wakes };
}

function pullsAnswering(answer: () => PullState | Error): PullRequests {
  return {
    state: async () => {
      const value = answer();
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe('setting a wake', () => {
  test('stores one wake a thread, says when in the thread, and a new one replaces it', async () => {
    const { wakes, store, target, clock } = rig();
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 30,
      note: ' check the deploy ',
      pr: null,
    });
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 60,
      note: 'check again',
      pr: null,
    });
    const listed = await store!.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      key: threadKey(THREAD),
      asker: OWNER,
      note: 'check again',
      dueAt: clock.now() + 60 * 60_000,
      pr: null,
    });
    expect(target.posts.map((p) => p.text)).toHaveLength(2);
    expect(target.posts[0]!.text).toMatch(
      /^⏰ checking back at \w{3} \d\d:\d\d Atlantic$/,
    );
  });

  test('refuses minutes out of range, an empty note, a PR with no GitHub App, and no database', async () => {
    const { wakes } = rig();
    const ask = (minutes: number, note = 'n', pr: number | null = null) =>
      wakes.schedule({ ref: THREAD, asker: OWNER, minutes, note, pr });
    await expect(ask(4)).rejects.toThrow('from 5 to 1440');
    await expect(ask(MAX_WAKE_MINUTES + 1)).rejects.toThrow('from 5 to 1440');
    await expect(ask(5.5)).rejects.toThrow('whole number');
    await expect(ask(10, '  ')).rejects.toThrow('needs a note');
    await expect(ask(10, 'n', 7)).rejects.toThrow('no GitHub App');
    await expect(
      rig({ store: null }).wakes.schedule({
        ref: THREAD,
        asker: OWNER,
        minutes: 10,
        note: 'n',
        pr: null,
      }),
    ).rejects.toThrow('mate-db is down');
  });

  test('cancel drops the pending wake and says so once', async () => {
    const { wakes, store, target } = rig();
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 10,
      note: 'n',
      pr: null,
    });
    expect(await wakes.cancel(THREAD)).toBe(true);
    expect(await wakes.cancel(THREAD)).toBe(false);
    expect(await store!.list()).toEqual([]);
    expect(target.posts.at(-1)?.text).toBe('⏰ wake cancelled');
    expect(target.posts).toHaveLength(2);
  });
});

describe('firing wakes', () => {
  test('a timed wake continues its thread as the asker once it is due, and only once', async () => {
    const { wakes, store, target, clock } = rig();
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 10,
      note: 'check the rollout',
      pr: null,
    });
    wakes.start();
    await clock.advance(9 * 60_000);
    expect(target.woken).toEqual([]);
    await clock.advance(WAKE_INTERVAL_MS);
    expect(target.woken).toEqual([
      { ref: THREAD, asker: OWNER, text: '⏰ wake: check the rollout' },
    ]);
    expect(await store!.list()).toEqual([]);
    await clock.advance(5 * WAKE_INTERVAL_MS);
    expect(target.woken).toHaveLength(1);
    wakes.stop();
  });

  test('a pull request wake waits while its runs are going, then fires with what they did', async () => {
    let state: PullState = {
      settled: false,
      summary: '#7 at abc1234: 2 running',
    };
    const { wakes, target, clock } = rig({
      pulls: pullsAnswering(() => state),
    });
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 120,
      note: 'merge it if green',
      pr: 7,
    });
    expect(target.posts[0]!.text).toStartWith(
      '⏰ watching PR #7; checking back when its checks finish, or at ',
    );
    wakes.start();
    await clock.advance(10 * 60_000);
    expect(target.woken).toEqual([]);
    state = { settled: true, summary: '#7 at abc1234: 2 success' };
    await clock.advance(WAKE_INTERVAL_MS);
    expect(target.woken.map((w) => w.text)).toEqual([
      '⏰ PR #7 at abc1234: 2 success. merge it if green',
    ]);
    wakes.stop();
  });

  test('a pull request wake still running, or unreadable, at its deadline fires anyway', async () => {
    let state: PullState | Error = {
      settled: false,
      summary: '#7 at abc1234: 1 running',
    };
    const { wakes, target, clock, log } = rig({
      pulls: pullsAnswering(() => state),
    });
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 5,
      note: 'look',
      pr: 7,
    });
    await wakes.schedule({
      ref: OTHER,
      asker: OWNER,
      minutes: 5,
      note: 'peek',
      pr: 8,
    });
    wakes.start();
    await clock.advance(4 * 60_000);
    state = new Error('github GET: timed out');
    await clock.advance(2 * WAKE_INTERVAL_MS);
    expect(target.woken.map((w) => w.text).sort()).toEqual([
      '⏰ PR #7 was still running at the deadline. look',
      '⏰ PR #8 was still running at the deadline. peek',
    ]);
    expect(
      log.of('a pull request could not be read for a wake').length,
    ).toBeGreaterThan(0);
    wakes.stop();
  });

  test('a wake replaced after the list is left for the new one', async () => {
    const store = new MemoryWakes();
    const { wakes, target, clock } = rig({ store });
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 5,
      note: 'old',
      pr: null,
    });
    const listed = await store.list();
    // The replacement lands between the tick's list and its claim.
    store.list = async () => {
      await wakes.schedule({
        ref: THREAD,
        asker: OWNER,
        minutes: 30,
        note: 'new',
        pr: null,
      });
      return listed;
    };
    await clock.advance(6 * 60_000);
    await wakes.tick();
    expect(target.woken).toEqual([]);
    expect((await MemoryWakes.prototype.list.call(store))[0]?.note).toBe('new');
    wakes.stop();
  });

  test('a wake whose thread is gone is dropped, and logged', async () => {
    const { wakes, store, target, clock, log } = rig();
    target.answer = false;
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 5,
      note: 'n',
      pr: null,
    });
    await clock.advance(5 * 60_000);
    await wakes.tick();
    expect(await store!.list()).toEqual([]);
    expect(log.of('a wake found no thread to continue')).toHaveLength(1);
    wakes.stop();
  });
});

describe('firing faults', () => {
  test('a thread that refuses the wake while mate drains gets it back', async () => {
    const { wakes, store, target, clock, log } = rig();
    target.wake = async () => {
      throw new Error('mate is shutting down');
    };
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 5,
      note: 'n',
      pr: null,
    });
    await clock.advance(5 * 60_000);
    await wakes.tick();
    expect((await store!.list()).map((w) => w.note)).toEqual(['n']);
    expect(
      log.of('a wake could not continue its thread; keeping it'),
    ).toHaveLength(1);
    wakes.stop();
  });

  test('one wake that cannot be claimed leaves the rest of the tick to fire', async () => {
    const store = new MemoryWakes();
    const { wakes, target, clock } = rig({ store });
    await wakes.schedule({
      ref: THREAD,
      asker: OWNER,
      minutes: 5,
      note: 'a',
      pr: null,
    });
    await wakes.schedule({
      ref: OTHER,
      asker: OWNER,
      minutes: 6,
      note: 'b',
      pr: null,
    });
    const take = store.take.bind(store);
    store.take = async (key, createdAt) => {
      if (key === threadKey(THREAD)) throw new Error('connection reset');
      return take(key, createdAt);
    };
    await clock.advance(6 * 60_000);
    await wakes.tick();
    expect(target.woken.map((w) => w.text)).toEqual(['⏰ wake: b']);
    wakes.stop();
  });
});

describe('the wake tool', () => {
  test('a cancel with no other field passes the schema', () => {
    const tool = wakeTool(THREAD, () => OWNER, rig().wakes);
    const call = (args: Record<string, boolean | number | string>) =>
      validateToolArguments(tool, {
        type: 'toolCall',
        id: 'c1',
        name: tool.name,
        arguments: args,
      });
    expect(() => call({ cancel: true })).not.toThrow();
    expect(() => call({ minutes: 3, note: 'n' })).toThrow();
  });

  test('sets a wake as the running turn’s asker, cancels, and refuses between turns', async () => {
    const { wakes, store } = rig();
    let asker: string | null = OWNER;
    const tool = wakeTool(THREAD, () => asker, wakes);
    const run = (args: Record<string, unknown>) =>
      tool.execute(args as never, {} as never, {} as never);

    const set = await run({ minutes: 15, note: 'check CI' });
    expect(set.isError).toBeUndefined();
    expect((await store!.list())[0]).toMatchObject({
      asker: OWNER,
      note: 'check CI',
    });

    const refused = await run({ minutes: 15, note: 'n', pr: 4 });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('no GitHub App');

    const cancelled = await run({ minutes: 15, note: 'n', cancel: true });
    expect(JSON.stringify(cancelled.content)).toContain('cancelled');
    expect(await store!.list()).toEqual([]);

    asker = null;
    const idle = await run({ minutes: 15, note: 'n' });
    expect(idle.isError).toBe(true);
  });
});

class Repo implements RepoReader {
  pull: unknown = { state: 'open', merged: false, head: { sha: 'abc1234def' } };
  runs: unknown = { workflow_runs: [] };
  readonly paths: string[] = [];
  async read<T>(path: string): Promise<T> {
    this.paths.push(path);
    return (path.startsWith('/pulls/') ? this.pull : this.runs) as T;
  }
}

describe('pull request state', () => {
  const since = 1_700_000_000_000;

  test('merged and closed settle at once', async () => {
    const repo = new Repo();
    const pulls = new GithubPullRequests(repo, new FakeClock(since));
    repo.pull = { state: 'closed', merged: true };
    expect(await pulls.state(7, since)).toEqual({
      settled: true,
      summary: '#7 merged',
    });
    repo.pull = { state: 'closed', merged: false };
    expect(await pulls.state(7, since)).toEqual({
      settled: true,
      summary: '#7 closed without merging',
    });
  });

  test('reads the runs on the head, and settles when every one completed, naming failures', async () => {
    const repo = new Repo();
    const pulls = new GithubPullRequests(repo, new FakeClock(since));
    repo.runs = {
      workflow_runs: [
        { name: 'typescript', status: 'completed', conclusion: 'success' },
        { name: 'nix', status: 'in_progress', conclusion: null },
      ],
    };
    expect(await pulls.state(7, since)).toEqual({
      settled: false,
      summary: '#7 at abc1234: 1 success, 1 running',
    });
    expect(repo.paths.at(-1)).toBe(
      '/actions/runs?head_sha=abc1234def&per_page=100',
    );
    repo.runs = {
      workflow_runs: [
        { name: 'typescript', status: 'completed', conclusion: 'success' },
        { name: 'nix', status: 'completed', conclusion: 'failure' },
        { name: 'docs', status: 'completed', conclusion: 'skipped' },
      ],
    };
    expect(await pulls.state(7, since)).toEqual({
      settled: true,
      summary: '#7 at abc1234: 1 success, 1 failure, 1 skipped (nix)',
    });
  });

  test('a head with no runs settles only after the grace, since CI may run nothing', async () => {
    const repo = new Repo();
    const clock = new FakeClock(since);
    const pulls = new GithubPullRequests(repo, clock);
    expect((await pulls.state(7, since)).settled).toBe(false);
    await clock.advance(NO_RUNS_MS);
    expect(await pulls.state(7, since)).toEqual({
      settled: true,
      summary: '#7 at abc1234 ran no GitHub Actions runs',
    });
  });
});

describe('the wake table', () => {
  const db = withDatabase();

  test('replaces by thread, lists by due time, and claims only the wake it listed', async () => {
    const store = new PostgresWakeStore(db().sql);
    const wake = (
      ref: ThreadRef,
      dueAt: number,
      createdAt: number,
      pr: number | null = null,
    ): Wake => ({
      key: threadKey(ref),
      ref,
      asker: OWNER,
      note: `due ${dueAt}`,
      dueAt,
      pr,
      createdAt,
    });
    await store.put(wake(THREAD, 300, 1));
    await store.put(wake(OTHER, 200, 2, 9));
    await store.put(wake(THREAD, 100, 3));
    expect(await store.list()).toEqual([
      wake(THREAD, 100, 3),
      wake(OTHER, 200, 2, 9),
    ]);
    expect(await store.take(threadKey(THREAD), 1)).toBe(false);
    expect(await store.take(threadKey(THREAD), 3)).toBe(true);
    expect(await store.cancel(threadKey(OTHER))).toBe(true);
    expect(await store.cancel(threadKey(OTHER))).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
