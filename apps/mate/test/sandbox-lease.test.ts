/**
 * The lease and the sandbox slots, through KubeHands on a fake apiserver
 * whose pods run the real daemon.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { HANDS_BINARY } from '../src/hands.ts';
import {
  type ExecOptions,
  type ExecStream,
  Kube,
  type RequestOptions,
} from '../src/kube.ts';
import { HANDS_LABEL, START_BUDGET_MS } from '../src/lease.ts';
import { PREEMPT_IDLE_MS, SandboxSlots } from '../src/sandbox-lease.ts';
import {
  sandboxLabels,
  sandboxManifest,
  sandboxName,
  THREAD_LABEL,
  TURN_ANNOTATION,
} from '../src/sandboxes.ts';
import type { ThreadRef } from '../src/surface.ts';
import {
  aborting,
  alive,
  begin,
  CUSTODIAN,
  cleanUp,
  FakeApp,
  GUILD,
  Hooks,
  OPERATOR,
  OTHER_THREAD,
  pidsIn,
  RecordingHandsInstruments,
  type Rig,
  rig,
  SANDBOX_CONFIG,
  THIRD_THREAD,
  THREAD,
  until,
} from './hands-support.ts';
import { FakeClock, RecordingLog, settle } from './support.ts';

afterEach(cleanUp);

const C = BACKGROUND_CONTEXT;
const NAME = sandboxName(THREAD);

function posts(r: Rig): number {
  return r.fake.requests.filter(
    (q) => q.method === 'POST' && q.path.endsWith('/sandboxes'),
  ).length;
}

function shutdownOf(r: Rig, name: string): number {
  const spec = r.fake.sandboxes.get(name)?.spec as
    | { shutdownTime?: string }
    | undefined;
  return Date.parse(spec?.shutdownTime ?? '');
}

function labelsOf(r: Rig, name: string): Record<string, string> {
  const meta = r.fake.sandboxes.get(name)?.metadata as
    | { labels?: Record<string, string> }
    | undefined;
  return meta?.labels ?? {};
}

/** The `writeFiles` calls each hands exec carried, oldest exec first. */
function writesPerExec(r: Rig): number[] {
  return r.fake.handsExecs.map(
    (e) => e.stdin.filter((line) => line.includes('"writeFiles"')).length,
  );
}

/**
 * Holds what `holding` names until `open`: each mate-hands exec, or each
 * list of one thread's sandboxes whatever their protocol, as a preemption
 * makes.
 */
class HeldKube extends Kube {
  held = 0;
  private readonly gate = Promise.withResolvers<void>();

  constructor(
    r: Rig,
    private readonly holding: 'hands' | 'thread-list',
  ) {
    super(r.fake.config());
  }

  open(): void {
    this.gate.resolve();
  }

  override async exec(opts: ExecOptions): Promise<ExecStream> {
    if (this.holding === 'hands' && opts.command[0] === HANDS_BINARY) {
      await this.hold();
    }
    return super.exec(opts);
  }

  override async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const selector = opts.query?.labelSelector ?? '';
    if (
      this.holding === 'thread-list' &&
      selector.includes(THREAD_LABEL) &&
      !selector.includes(HANDS_LABEL)
    ) {
      await this.hold();
    }
    return super.json<T>(path, opts);
  }

  private async hold(): Promise<void> {
    this.held += 1;
    await this.gate.promise;
  }
}

describe('a turn', () => {
  test('with no tool call asks nothing of the cluster', async () => {
    const app = new FakeApp();
    const r = rig({
      config: { kubeServiceAccount: 'mate-sandbox-admin', github: true },
      deps: { githubApp: app },
    });
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const summary = await turn.lease.finish();
    turn.end();
    expect(summary).toEqual({ source: 'none', sandbox: null, stamped: false });
    expect(r.fake.requests).toEqual([]);
    expect(app.minted).toBe(0);
    expect(app.revoked).toEqual([]);
    expect(r.metrics.turnSandboxes).toEqual(['none']);
  });

  test('mints on its first tool call, and says so in order', async () => {
    const r = rig();
    const hooks = new Hooks();
    const turn = begin(r.hands.thread(THREAD, hooks, OPERATOR));
    expect(r.fake.sandboxes.size).toBe(0);
    const said = await turn.env.exec('echo hi', undefined, C);
    expect(said.ok && said.value.exitCode).toBe(0);
    expect(turn.kinds()).toEqual([
      'step:creating',
      'step:booting',
      'connecting',
      'ready',
    ]);
    expect(turn.events.at(-1)).toEqual({
      kind: 'ready',
      sandbox: NAME,
      source: 'fresh',
    });
    expect(hooks.sandboxes).toEqual([NAME]);
    expect(labelsOf(r, NAME)[HANDS_LABEL]).toBe('2');
    expect(r.metrics.mints).toEqual(['ok']);
    expect(r.metrics.mintSamples[0]?.source).toBe('fresh');
    expect(await turn.lease.finish()).toEqual({
      source: 'fresh',
      sandbox: NAME,
      stamped: false,
    });
    expect(r.metrics.turnSandboxes).toEqual(['fresh']);
  });

  test('five calls at once share one mint, one connect and one stamp', async () => {
    const r = rig({ config: { kubeServiceAccount: 'mate-sandbox-admin' } });
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const found = await Promise.all(
      Array.from({ length: 5 }, () => turn.env.exists('.', C)),
    );
    expect(found.map((f) => f.ok && f.value)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(posts(r)).toBe(1);
    expect(r.fake.handsExecs).toHaveLength(1);
    expect(r.fake.tokenRequests).toHaveLength(1);
    const writes = r.fake.handsExecs[0]?.stdin.filter((line) =>
      line.includes('"writeFiles"'),
    );
    expect(writes).toHaveLength(1);
    await turn.lease.finish();
  });

  test('a Stop during the mint answers at once, and the sandbox is kept once Ready', async () => {
    const r = rig();
    r.fake.readyOnCreate = false;
    const hooks = new Hooks();
    const thread = r.hands.thread(THREAD, hooks, OPERATOR);
    const turn = begin(thread);
    const { context, abort } = aborting();
    const call = turn.env.exec('true', undefined, context);
    await until(() => r.fake.sandboxes.has(NAME));
    const stopped = Date.now();
    abort();
    const result = await call;
    expect(result.ok ? null : result.error.code).toBe('aborted');
    expect(Date.now() - stopped).toBeLessThan(1_000);
    const finishing = Date.now();
    const summary = await turn.lease.finish();
    turn.end();
    expect(Date.now() - finishing).toBeLessThan(1_000);
    expect(summary.sandbox).toBeNull();
    expect(hooks.sandboxes).toEqual([]);

    r.fake.markReady(NAME);
    await until(() => hooks.sandboxes.length === 1);
    expect(hooks.sandboxes).toEqual([NAME]);
    await until(() => r.metrics.mints.length === 1);
    expect(r.metrics.mints).toEqual(['ok']);
    expect(r.metrics.mintSamples[0]?.source).toBe('fresh');
    const next = begin(thread);
    expect((await next.env.exists('.', C)).ok).toBe(true);
    expect(next.events.at(-1)).toMatchObject({
      kind: 'ready',
      source: 'reused',
    });
    expect(posts(r)).toBe(1);
    await next.lease.finish();
  });

  test('remembers a failed mint for the rest of the turn, and the next turn retries', async () => {
    const r = rig({ deps: { readyTimeoutMs: 200 } });
    r.fake.readyOnCreate = false;
    const thread = r.hands.thread(THREAD, new Hooks(), OPERATOR);
    const turn = begin(thread);
    const first = await turn.env.exists('.', C);
    const said = first.ok ? '' : first.error.message;
    expect(said).toMatch(/^could not start a sandbox: .*not ready in time/);
    const second = await turn.env.exists('.', C);
    expect(second.ok ? '' : second.error.message).toBe(said);
    expect(posts(r)).toBe(1);
    expect(turn.kinds()).toEqual(['step:creating', 'step:booting', 'failed']);
    expect(r.metrics.mints).toEqual(['mint-failed']);
    expect((await turn.lease.finish()).source).toBe('failed');
    turn.end();

    r.fake.readyOnCreate = true;
    const next = begin(thread);
    expect((await next.env.exists('.', C)).ok).toBe(true);
    expect(posts(r)).toBe(2);
    await next.lease.finish();
  });

  test('the next turn reuses the sandbox, with a full TTL from its start', async () => {
    const r = rig();
    const thread = r.hands.thread(THREAD, new Hooks(), OPERATOR);
    const first = begin(thread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    await first.lease.finish();
    first.end();
    const minted = shutdownOf(r, NAME);
    await Bun.sleep(5);
    const second = begin(thread);
    expect((await second.env.exists('.', C)).ok).toBe(true);
    expect(second.events.at(-1)).toEqual({
      kind: 'ready',
      sandbox: NAME,
      source: 'reused',
    });
    expect(second.kinds()[0]).toBe('step:reusing');
    expect(posts(r)).toBe(1);
    const slid = shutdownOf(r, NAME);
    expect(slid).toBeGreaterThan(minted);
    await second.lease.finish();
  });

  test('a link that drops mid-turn reconnects to the same pod and stamps nothing again', async () => {
    const r = rig({ config: { kubeServiceAccount: 'mate-sandbox-admin' } });
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(true);
    const first = r.fake.daemons.get(NAME)?.[0];
    first?.kill('SIGKILL');
    await until(() => turn.lease.current() === null);

    expect((await turn.env.exists('.', C)).ok).toBe(true);
    expect(r.fake.handsExecs.map((e) => e.pod)).toEqual([NAME, NAME]);
    expect(writesPerExec(r)).toEqual([1, 0]);
    expect(r.fake.tokenRequests).toHaveLength(1);
    expect(r.metrics.drops).toEqual(['closed']);
    expect(turn.kinds().filter((k) => k === 'lost')).toEqual([]);
    await turn.lease.finish();
  });

  test('a sandbox that dies is lost, replaced once, and not twice', async () => {
    const r = rig();
    const hooks = new Hooks();
    const turn = begin(r.hands.thread(THREAD, hooks, OPERATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(true);

    r.fake.killPod(NAME);
    await until(() => turn.lease.current() === null);
    const lost = await turn.env.exists('.', C);
    expect(lost.ok ? '' : lost.error.message).toContain(
      `the sandbox ${NAME} is gone`,
    );
    expect(turn.events.filter((e) => e.kind === 'lost')).toEqual([
      { kind: 'lost', sandbox: NAME, error: expect.stringContaining(NAME) },
    ]);
    expect(hooks.gone).toEqual(['lost']);
    expect(r.metrics.drops).toEqual(['closed']);
    await until(() => !r.fake.sandboxes.has(NAME));

    expect((await turn.env.exists('.', C)).ok).toBe(true);
    const replacement = hooks.sandboxes.at(-1) as string;
    expect(hooks.sandboxes).toHaveLength(2);
    r.fake.killPod(replacement);
    await until(() => turn.lease.current() === null);
    expect((await turn.env.exists('.', C)).ok).toBe(false);
    const done = await turn.env.exists('.', C);
    expect(done.ok ? '' : done.error.message).toContain('lost twice');
    expect(hooks.gone).toEqual(['lost', 'lost']);
    await turn.lease.finish();
  });

  test('an image with no daemon mate speaks to is condemned as lost', async () => {
    const r = rig();
    r.fake.oldHands = true;
    const hooks = new Hooks();
    const turn = begin(r.hands.thread(THREAD, hooks, OPERATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(false);
    expect(turn.kinds()).toEqual([
      'step:creating',
      'step:booting',
      'connecting',
      'lost',
    ]);
    expect(r.metrics.mints).toEqual(['connect-failed']);
    expect(r.metrics.connects.map((c) => c.result)).toEqual(['mismatch']);
    expect(hooks.gone).toEqual(['lost']);
    await until(() => !r.fake.sandboxes.has(NAME));
    await turn.lease.finish();
  });

  test('a sandbox it cannot connect to fails the turn once', async () => {
    const r = rig();
    r.fake.refuseHands = true;
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const first = await turn.env.exists('.', C);
    const said = first.ok ? '' : first.error.message;
    expect(said).toContain('could not reach the sandbox');
    expect(turn.kinds().slice(-2)).toEqual(['connecting', 'failed']);
    expect(r.metrics.mints).toEqual(['connect-failed']);
    const second = await turn.env.exists('.', C);
    expect(second.ok ? '' : second.error.message).toBe(said);
    await turn.lease.finish();
  });
});

describe('the slots', () => {
  test('a thread waits in line while every slot is busy, and leaves when its turn ends', async () => {
    const r = rig({ deps: { maxSandboxes: 1 } });
    const a = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await a.env.exists('.', C)).ok).toBe(true);
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    const c = begin(r.hands.thread(THIRD_THREAD, new Hooks(), OPERATOR));
    const bCall = b.env.exists('.', C);
    const cCall = c.env.exists('.', C);
    await until(() => r.metrics.waiters === 2);
    expect(b.events).toEqual([{ kind: 'waiting', ahead: 0 }]);
    expect(c.events).toEqual([{ kind: 'waiting', ahead: 1 }]);
    expect(r.metrics.live).toBe(1);

    b.end();
    const gaveUp = await bCall;
    expect(gaveUp.ok ? '' : gaveUp.error.code).toBe('aborted');
    await until(() => r.metrics.waiters === 1);
    expect(c.events.at(-1)).toEqual({ kind: 'waiting', ahead: 0 });
    c.end();
    await cCall;
    await until(() => r.metrics.waiters === 0);
    await a.lease.finish();
    expect(posts(r)).toBe(1);
  });

  test('a holder idle for the preempt window gives its sandbox to a waiting thread', async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const aHooks = new Hooks();
    const a = begin(r.hands.thread(THREAD, aHooks, OPERATOR));
    expect((await a.env.exists('.', C)).ok).toBe(true);
    await a.lease.finish();
    a.end();
    await clock.advance(PREEMPT_IDLE_MS);
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    expect((await b.env.exists('.', C)).ok).toBe(true);
    expect(aHooks.gone).toEqual(['preempted']);
    expect(r.metrics.teardowns).toEqual(['preempted']);
    await until(() => !r.fake.sandboxes.has(NAME));
    expect(r.metrics.live).toBe(1);
    await b.lease.finish();
  });

  test('a busy holder is never preempted; a waiter gets it once it has sat idle for the window', async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const aHooks = new Hooks();
    const aThread = r.hands.thread(THREAD, aHooks, OPERATOR);
    const first = begin(aThread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    await first.lease.finish();
    first.end();
    // A turn that has begun holds its slot before it calls a tool.
    const second = begin(aThread);
    await clock.advance(2 * PREEMPT_IDLE_MS);
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    let served = false;
    const bCall = b.env.exists('.', C).then((result) => {
      served = true;
      return result;
    });
    await until(() => r.metrics.waiters === 1);
    await clock.advance(PREEMPT_IDLE_MS);
    expect(served).toBe(false);
    expect(aHooks.gone).toEqual([]);

    await second.lease.finish();
    second.end();
    await clock.advance(PREEMPT_IDLE_MS - 1);
    expect(served).toBe(false);
    await clock.advance(1);
    expect((await bCall).ok).toBe(true);
    expect(aHooks.gone).toEqual(['preempted']);
    await b.lease.finish();
  });

  test('a turn that ends while it waits for a slot leaves the line, before its signal aborts', async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const a = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await a.env.exists('.', C)).ok).toBe(true);
    const bHooks = new Hooks();
    const b = begin(r.hands.thread(OTHER_THREAD, bHooks, OPERATOR));
    const { context, abort } = aborting();
    const bCall = b.env.exists('.', context);
    await until(() => r.metrics.waiters === 1);
    abort();
    expect((await bCall).ok).toBe(false);
    expect(r.metrics.waiters).toBe(1);

    await b.lease.finish();
    expect(r.metrics.waiters).toBe(0);
    await a.lease.finish();
    a.end();
    await clock.advance(2 * PREEMPT_IDLE_MS);
    await Bun.sleep(50);
    expect(bHooks.sandboxes).toEqual([]);
    expect(posts(r)).toBe(1);
    expect(r.metrics.live).toBe(1);
    b.end();
  });

  test('a turn that begins before its idle sandbox is condemned keeps it', async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const kube = new HeldKube(r, 'thread-list');
    const hands = r.another({ kube });
    const aHooks = new Hooks();
    const aThread = hands.thread(THREAD, aHooks, OPERATOR);
    const first = begin(aThread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    await first.lease.finish();
    first.end();
    await clock.advance(PREEMPT_IDLE_MS);

    const b = begin(hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    const bCall = b.env.exists('.', C);
    await until(() => kube.held === 1);
    const second = begin(aThread);
    const aCall = second.env.exists('.', C);
    kube.open();
    expect((await aCall).ok).toBe(true);
    expect(second.kinds()).toEqual(['step:reusing', 'connecting', 'ready']);
    expect(aHooks.gone).toEqual([]);
    expect(r.metrics.teardowns).toEqual([]);
    expect(r.fake.sandboxes.has(NAME)).toBe(true);
    expect(r.metrics.waiters).toBe(1);
    await second.lease.finish();
    second.end();
    b.end();
    expect((await bCall).ok).toBe(false);
  });

  test('a turn that begins while its sandbox is condemned waits for a slot, and never fails for it', async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const aHooks = new Hooks();
    const aThread = r.hands.thread(THREAD, aHooks, OPERATOR);
    const first = begin(aThread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    await first.lease.finish();
    first.end();
    await clock.advance(PREEMPT_IDLE_MS);

    r.fake.patchDelayMs = 500;
    const patched = () =>
      r.fake.requests.filter((q) => q.method === 'PATCH').length;
    const before = patched();
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    const bCall = b.env.exists('.', C);
    await until(() => patched() > before);
    const second = begin(aThread);
    const aCall = second.env.exists('.', C);
    expect((await bCall).ok).toBe(true);
    await until(() => second.kinds().includes('waiting'));
    expect(aHooks.gone).toEqual(['preempted']);

    r.fake.patchDelayMs = 0;
    await b.lease.finish();
    b.end();
    await clock.advance(PREEMPT_IDLE_MS);
    expect((await aCall).ok).toBe(true);
    expect(second.kinds()).not.toContain('failed');
    expect(second.events.at(-1)).toMatchObject({
      kind: 'ready',
      source: 'fresh',
    });
    // Its new slot is busy for the rest of the turn.
    const c = begin(r.hands.thread(THIRD_THREAD, new Hooks(), OPERATOR));
    const cCall = c.env.exists('.', C);
    await until(() => r.metrics.waiters === 1);
    await clock.advance(2 * PREEMPT_IDLE_MS);
    await Bun.sleep(50);
    expect(aHooks.gone).toEqual(['preempted']);
    await second.lease.finish();
    c.end();
    expect((await cCall).ok).toBe(false);
  });

  test('a turn that ends holding no sandbox hands its slot to the head of the line at once', async () => {
    const r = rig({ deps: { maxSandboxes: 1 } });
    const a = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await a.env.exists('.', C)).ok).toBe(true);
    r.fake.killPod(NAME);
    await until(() => a.lease.current() === null);
    expect((await a.env.exists('.', C)).ok).toBe(false);
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    const bCall = b.env.exists('.', C);
    await until(() => r.metrics.waiters === 1);
    await a.lease.finish();
    a.end();
    expect((await bCall).ok).toBe(true);
    await b.lease.finish();
  });
});

// Automation turns share the slots but never take an owner's sandbox.
describe('the lanes', () => {
  function slots(capacity: number) {
    const clock = new FakeClock();
    const metrics = new RecordingHandsInstruments();
    const evicted: string[] = [];
    const made = new SandboxSlots({
      capacity,
      clock,
      log: new RecordingLog(),
      metrics,
      evict: async (key) => {
        evicted.push(key);
        return true;
      },
    });
    return { slots: made, clock, metrics, evicted };
  }

  test('an automation waiter never preempts an idle interactive holder, and arms no timer', async () => {
    const { slots: s, clock, metrics, evicted } = slots(1);
    s.register('owner');
    await clock.advance(2 * PREEMPT_IDLE_MS);
    let served = false;
    const taken = s.take('custodian', { lane: 'automation' }).then(() => {
      served = true;
    });
    await settle();
    expect(clock.pendingTimers).toBe(0);
    expect(metrics.waitersBy).toEqual({ interactive: 0, automation: 1 });
    await clock.advance(PREEMPT_IDLE_MS);
    expect(served).toBe(false);
    expect(evicted).toEqual([]);

    s.release('owner');
    await taken;
    expect(s.holds('custodian')).toBe(true);
    expect(metrics.waitersBy).toEqual({ interactive: 0, automation: 0 });
  });

  test('an interactive waiter goes ahead of an automation one, and may preempt an idle automation holder', async () => {
    const { slots: s, clock, metrics, evicted } = slots(1);
    s.register('custodian', 'automation');
    const auto: number[] = [];
    const owner: number[] = [];
    let ownerServed = false;
    const autoTake = s.take('responder', {
      lane: 'automation',
      onWaiting: (ahead) => auto.push(ahead),
    });
    const ownerTake = s
      .take('owner', { onWaiting: (ahead) => owner.push(ahead) })
      .then(() => {
        ownerServed = true;
      });
    await settle();
    expect(auto).toEqual([0, 1]);
    expect(owner).toEqual([0]);
    expect(metrics.waitersBy).toEqual({ interactive: 1, automation: 1 });

    await clock.advance(PREEMPT_IDLE_MS);
    await ownerTake;
    expect(ownerServed).toBe(true);
    expect(evicted).toEqual(['custodian']);
    expect(s.holds('owner')).toBe(true);
    expect(s.holds('responder')).toBe(false);
    expect(metrics.waitersBy).toEqual({ interactive: 0, automation: 1 });
    s.release('owner');
    await autoTake;
    expect(s.holds('responder')).toBe(true);
  });

  test('an interactive waiter evicts an idle interactive holder, never a busy automation one', async () => {
    const { slots: s, clock, evicted } = slots(2);
    s.register('owner');
    s.register('custodian', 'automation');
    const done = s.use('custodian');
    await clock.advance(PREEMPT_IDLE_MS);
    await s.take('other-owner');
    expect(evicted).toEqual(['owner']);
    expect(s.holds('custodian')).toBe(true);
    done?.();
  });

  describe('an eviction under way for an interactive waiter', () => {
    function gated() {
      const clock = new FakeClock();
      const evicted: string[] = [];
      let open = () => {};
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });
      const made = new SandboxSlots({
        capacity: 1,
        clock,
        log: new RecordingLog(),
        evict: async (key, wanted) => {
          evicted.push(key);
          await held;
          return wanted();
        },
      });
      return { slots: made, clock, evicted, open };
    }

    test('is abandoned when that waiter leaves, so an automation waiter never takes the sandbox', async () => {
      const { slots: s, clock, evicted, open } = gated();
      s.register('owner');
      await clock.advance(2 * PREEMPT_IDLE_MS);
      let custodianServed = false;
      const custodian = s.take('custodian', { lane: 'automation' }).then(() => {
        custodianServed = true;
      });
      await settle();
      expect(evicted).toEqual([]);
      const leaving = new AbortController();
      const other = s.take('other-owner', { signal: leaving.signal });
      await settle();
      expect(evicted).toEqual(['owner']);

      leaving.abort(new Error('turn over'));
      await expect(other).rejects.toThrow('turn over');
      open();
      await settle();
      expect(s.holds('owner')).toBe(true);
      expect(s.holds('custodian')).toBe(false);
      expect(custodianServed).toBe(false);
      expect(clock.pendingTimers).toBe(0);

      s.release('owner');
      await custodian;
      expect(s.holds('custodian')).toBe(true);
    });

    test('completes for that waiter while it stays, ahead of an automation waiter', async () => {
      const { slots: s, clock, evicted, open } = gated();
      s.register('owner');
      await clock.advance(2 * PREEMPT_IDLE_MS);
      void s.take('custodian', { lane: 'automation' });
      const other = s.take('other-owner');
      await settle();
      open();
      await other;
      expect(evicted).toEqual(['owner']);
      expect(s.holds('other-owner')).toBe(true);
      expect(s.holds('custodian')).toBe(false);
    });
  });

  test('an interactive waiter waits behind a busy automation holder, and is served when it goes', async () => {
    const { slots: s, clock, metrics, evicted } = slots(2);
    s.register('custodian', 'automation');
    s.register('owner');
    const custodianDone = s.use('custodian');
    const ownerDone = s.use('owner');
    let served = false;
    const taken = s.take('other-owner').then(() => {
      served = true;
    });
    await clock.advance(3 * PREEMPT_IDLE_MS);
    expect(served).toBe(false);
    expect(evicted).toEqual([]);
    expect(metrics.waitersBy).toEqual({ interactive: 1, automation: 0 });

    custodianDone?.();
    s.release('custodian');
    await taken;
    expect(s.holds('other-owner')).toBe(true);
    expect(evicted).toEqual([]);
    ownerDone?.();
  });

  test("a custodian thread waits for an owner's idle sandbox to go, and never takes it", async () => {
    const clock = new FakeClock();
    const r = rig({ deps: { maxSandboxes: 1, clock } });
    const ownerHooks = new Hooks();
    const owner = begin(r.hands.thread(THREAD, ownerHooks, OPERATOR));
    expect((await owner.env.exists('.', C)).ok).toBe(true);
    await owner.lease.finish();
    owner.end();
    await clock.advance(PREEMPT_IDLE_MS);

    const custodian = begin(
      r.hands.thread(OTHER_THREAD, new Hooks(), CUSTODIAN),
    );
    const call = custodian.env.exists('.', C);
    await until(() => r.metrics.waitersBy.automation === 1);
    expect(r.metrics.waiters).toBe(0);
    await clock.advance(2 * PREEMPT_IDLE_MS);
    await Bun.sleep(50);
    expect(ownerHooks.gone).toEqual([]);
    expect(custodian.kinds()).toEqual(['waiting']);

    await r.hands.release(THREAD, 'quiet');
    expect((await call).ok).toBe(true);
    expect(r.metrics.waitersBy.automation).toBe(0);
    await custodian.lease.finish();
    custodian.end();
  });
});

describe('warm', () => {
  test('reconnects to a standing sandbox with a new epoch, which kills what a dead mate left', async () => {
    const r = rig();
    const before = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const pids = join(r.workspace, 'pids');
    void before.env.exec(`sleep 300 & echo $! > ${pids}; wait`, undefined, C);
    const [sleeper] = await pidsIn(pids, 1);

    // mate died there: no finish, and its daemon runs on.
    const restarted = r.another();
    expect(await restarted.start()).toEqual([]);
    const hooks = new Hooks();
    const after = begin(restarted.thread(THREAD, hooks, OPERATOR));
    await after.lease.warm();
    expect(r.fake.handsExecs).toHaveLength(2);
    expect(posts(r)).toBe(1);
    await until(() => !alive(sleeper as number));
    expect(hooks.sandboxes).toEqual([NAME]);
    expect((await after.env.exists('.', C)).ok).toBe(true);
    expect(after.events.at(-1)).toMatchObject({
      kind: 'ready',
      source: 'reused',
    });
    expect(r.fake.handsExecs).toHaveLength(2);
    await after.lease.finish();
  });

  test('cut short by the end of the turn, it closes what it opens and says nothing', async () => {
    const r = rig();
    const before = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await before.env.exists('.', C)).ok).toBe(true);
    await before.lease.finish();
    before.end();

    const kube = new HeldKube(r, 'hands');
    const restarted = r.another({ kube });
    await restarted.start();
    const turn = begin(restarted.thread(THREAD, new Hooks(), OPERATOR));
    const warming = turn.lease.warm();
    await until(() => kube.held === 1);
    await turn.lease.finish();
    kube.open();
    await warming;
    await until(() => r.fake.handsExecs.length === 2);
    const late = r.fake.handsExecs[1];
    await until(() => late?.clientClosed === true);
    expect(turn.lease.current()).toBeNull();
    expect(
      r.log.of('could not reconnect to the sandbox before a resume'),
    ).toEqual([]);
    turn.end();
  });

  test('with no sandbox standing it mints nothing', async () => {
    const r = rig();
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    await turn.lease.warm();
    expect(posts(r)).toBe(0);
    expect(r.fake.handsExecs).toHaveLength(0);
    expect(turn.events).toEqual([]);
    await turn.lease.finish();
  });
});

describe('the end of a turn', () => {
  test('abandon revokes the token and closes the link, and nothing reconnects after it', async () => {
    const app = new FakeApp();
    const r = rig({
      config: { kubeServiceAccount: 'mate-sandbox-admin', github: true },
      deps: { githubApp: app },
    });
    const turn = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(true);
    const daemon = r.fake.daemons.get(NAME)?.[0];
    await turn.lease.abandon();
    expect(app.revoked).toEqual(['ghs-token-1']);
    expect(turn.lease.current()).toBeNull();
    expect(await daemon?.exited).toBe(0);
    expect(readFileSync(join(r.home, '.github-token'), 'utf8')).toBe('');

    const requests = r.fake.requests.length;
    const late = await turn.env.exists('.', C);
    expect(late.ok).toBe(false);
    expect(r.fake.requests.length).toBe(requests);
    expect(app.minted).toBe(1);
  });

  for (const end of ['finish', 'abandon'] as const) {
    test(`${end} while the link is still connecting closes what the connect opens`, async () => {
      const r = rig({ config: { kubeServiceAccount: 'mate-sandbox-admin' } });
      const kube = new HeldKube(r, 'hands');
      const hands = r.another({ kube });
      const turn = begin(hands.thread(THREAD, new Hooks(), OPERATOR));
      const { context, abort } = aborting();
      const call = turn.env.exists('.', context);
      await until(() => kube.held === 1);
      abort();
      const stopped = await call;
      expect(stopped.ok ? null : stopped.error.code).toBe('aborted');
      await turn.lease[end]();

      kube.open();
      await until(() => r.fake.handsExecs.length === 1);
      const [exec] = r.fake.handsExecs;
      await until(() => exec?.clientClosed === true);
      expect(await r.fake.daemons.get(NAME)?.[0]?.exited).toBe(0);
      expect(turn.lease.current()).toBeNull();
      expect(writesPerExec(r)).toEqual([0]);
      expect(r.fake.tokenRequests).toEqual([]);
      turn.end();
    });
  }

  test('finish and abandon do the work once, whichever comes first', async () => {
    const app = new FakeApp();
    const r = rig({
      config: { github: true },
      deps: { githubApp: app },
    });
    const thread = r.hands.thread(THREAD, new Hooks(), OPERATOR);
    const first = begin(thread);
    expect((await first.env.exists('.', C)).ok).toBe(true);
    const summary = await first.lease.finish();
    await first.lease.abandon();
    expect(await first.lease.finish()).toBe(summary);
    expect(app.revoked).toEqual(['ghs-token-1']);
    expect(r.metrics.turnSandboxes).toEqual(['fresh']);

    const second = begin(thread);
    expect((await second.env.exists('.', C)).ok).toBe(true);
    await second.lease.abandon();
    await second.lease.finish();
    expect(app.revoked).toEqual(['ghs-token-1', 'ghs-token-2']);
    expect(r.metrics.turnSandboxes).toEqual(['fresh', 'reused']);
  });

  test('shutdown abandons every open lease', async () => {
    const r = rig();
    const a = begin(r.hands.thread(THREAD, new Hooks(), OPERATOR));
    const b = begin(r.hands.thread(OTHER_THREAD, new Hooks(), OPERATOR));
    expect((await a.env.exists('.', C)).ok).toBe(true);
    expect((await b.env.exists('.', C)).ok).toBe(true);
    await r.hands.shutdown();
    expect(a.lease.current()).toBeNull();
    expect(b.lease.current()).toBeNull();
    const requests = r.fake.requests.length;
    expect((await a.env.exists('.', C)).ok).toBe(false);
    expect(r.fake.requests.length).toBe(requests);
  });
});

describe('boot and release', () => {
  async function plant(
    r: Rig,
    name: string,
    labels: Record<string, string>,
    annotations: Record<string, string> = {},
  ): Promise<void> {
    const manifest = sandboxManifest({
      name,
      namespace: 'mate',
      labels,
      config: SANDBOX_CONFIG,
      shutdownTime: new Date(Date.now() + 3_600_000).toISOString(),
      profile: OPERATOR,
    });
    manifest.metadata.annotations = annotations;
    const kube = new Kube(r.fake.config());
    const response = await kube.request(
      '/apis/agents.x-k8s.io/v1beta1/namespaces/mate/sandboxes',
      { method: 'POST', body: manifest },
    );
    expect(response.status).toBe(201);
  }

  function unlabelled(thread: ThreadRef): Record<string, string> {
    const labels = sandboxLabels(thread, GUILD, OPERATOR);
    delete labels[HANDS_LABEL];
    return labels;
  }

  test('start counts labelled sandboxes, names cut-off turns, and condemns the rest in the background', async () => {
    const r = rig();
    await plant(r, 'mate-old-busy', unlabelled(THREAD), {
      [TURN_ANNOTATION]: new Date().toISOString(),
    });
    await plant(r, 'mate-old-idle', unlabelled(OTHER_THREAD));
    const spare = unlabelled(THREAD);
    for (const key of [
      'lolwtf.ca/surface',
      'lolwtf.ca/thread',
      'lolwtf.ca/channel',
    ]) {
      delete spare[key];
    }
    await plant(r, 'mate-spare-old', { ...spare, 'lolwtf.ca/spare': 'true' });
    await plant(
      r,
      'mate-current',
      sandboxLabels(THIRD_THREAD, GUILD, OPERATOR),
    );
    r.fake.patchDelayMs = 1_000;

    const started = Date.now();
    const cut = await r.hands.start();
    expect(Date.now() - started).toBeLessThan(START_BUDGET_MS);
    expect(Date.now() - started).toBeLessThan(900);
    expect(cut).toEqual([THREAD]);
    expect(r.metrics.live).toBe(1);

    await until(
      () =>
        !r.fake.sandboxes.has('mate-old-busy') &&
        !r.fake.sandboxes.has('mate-old-idle') &&
        !r.fake.sandboxes.has('mate-spare-old'),
      10_000,
    );
    expect(r.fake.sandboxes.has('mate-current')).toBe(true);
    expect(r.metrics.teardowns).toEqual(['inherited', 'inherited']);
  });

  test('start with no apiserver names no thread and leaves the rest to the sweep', async () => {
    const r = rig();
    const closed = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(),
    });
    const port = closed.port;
    closed.stop(true);
    const offline = r.another({
      kube: new Kube({
        server: `http://127.0.0.1:${port}`,
        namespace: 'mate',
        credentials: async () => ({}),
      }),
    });
    expect(await offline.start()).toEqual([]);
    expect(
      r.log.of('could not count the standing sandboxes at boot'),
    ).toHaveLength(1);
    // The pool is off, yet the sweep still tries the condemn pass.
    await offline.ensureSpares();
    expect(
      r.log.of('could not list sandboxes an earlier mate left'),
    ).toHaveLength(1);
  });

  test('release deletes the sandbox and says so, only when there was one', async () => {
    const r = rig();
    const hooks = new Hooks();
    const turn = begin(r.hands.thread(THREAD, hooks, OPERATOR));
    expect((await turn.env.exists('.', C)).ok).toBe(true);
    await turn.lease.finish();
    turn.end();
    expect(r.metrics.live).toBe(1);
    await r.hands.release(THREAD, 'quiet');
    expect(hooks.gone).toEqual(['quiet']);
    expect(r.fake.sandboxes.has(NAME)).toBe(false);
    expect(r.metrics.teardowns).toEqual(['quiet']);
    expect(r.metrics.live).toBe(0);

    const idle = new Hooks();
    r.hands.thread(OTHER_THREAD, idle, OPERATOR);
    await r.hands.release(OTHER_THREAD, 'quiet');
    expect(idle.gone).toEqual([]);
    expect(r.metrics.teardowns).toEqual(['quiet']);
    expect(r.log.entries.filter((e) => e.level !== 'info')).toEqual([]);
  });
});
