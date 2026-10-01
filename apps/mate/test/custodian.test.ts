import { describe, expect, test } from 'bun:test';
import {
  Custodian,
  type CustodianLedger,
  custodianPrompt,
  dueDay,
} from '../src/custodian.ts';
import { silentLog } from '../src/log.ts';
import type { SlackApi } from '../src/slack.ts';
import type { Start, Threads } from '../src/threads.ts';
import { FakeSlack } from './fakesurface.ts';
import { FakeClock } from './support.ts';

const at = (iso: string) => Date.parse(iso);

describe('Atlantic schedule', () => {
  test('fires at 18:00 across both daylight-saving offsets', () => {
    expect(dueDay(at('2026-01-03T21:59:00Z'))).toBeNull();
    expect(dueDay(at('2026-01-03T22:00:00Z'))).toBe('2026-01-03');
    expect(dueDay(at('2026-07-03T20:59:00Z'))).toBeNull();
    expect(dueDay(at('2026-07-03T21:00:00Z'))).toBe('2026-07-03');
    expect(dueDay(at('2026-07-04T02:59:00Z'))).toBe('2026-07-03');
    expect(dueDay(at('2026-07-04T03:00:00Z'))).toBeNull();
  });

  test('the assignment allows GitOps repairs and guarded merges', () => {
    const prompt = custodianPrompt('2026-07-03');
    expect(prompt).toContain('Fix clear issues through the repository');
    expect(prompt).toContain(
      'merge only changes you understand whose required checks pass',
    );
    expect(prompt).toContain('never make live infrastructure changes by hand');
  });
});

class Ledger implements CustodianLedger {
  roots = new Map<string, string | null>();
  async root(day: string): Promise<string | null> {
    if (!this.roots.has(day)) this.roots.set(day, null);
    return this.roots.get(day) ?? null;
  }
  async saved(day: string, ts: string): Promise<void> {
    this.roots.set(day, ts);
  }
}

type Starts = Pick<Threads, 'start'>;

test('a failed dispatch retries the same saved root', async () => {
  const ledger = new Ledger();
  const slack = new FakeSlack();
  const refs: string[] = [];
  const threads: Starts = {
    async start({ ref }: Start) {
      refs.push(ref.id);
      if (refs.length === 1) throw new Error('store unavailable');
      return true;
    },
  };
  const fixed = {
    now: () => at('2026-07-03T21:00:00Z'),
    after: () => ({}),
    cancel: () => {},
    sleep: async () => {},
  };
  const job = new Custodian({
    ledger,
    slack,
    threads,
    channel: 'C062BS4GADR',
    owner: 'UAR78LSKC',
    log: silentLog,
    clock: fixed,
  });
  await job.tick();
  await job.tick();
  job.stop();
  expect(refs).toEqual(['p-1', 'p-1']);
  expect(slack.calls.filter((call) => call.call === 'post')).toHaveLength(1);
});

test('the day starts its thread under the custodian profile, asked by the owner', async () => {
  const ledger = new Ledger();
  const slack = new FakeSlack();
  const starts: Start[] = [];
  const threads: Starts = {
    async start(start: Start) {
      starts.push(start);
      return starts.length === 1;
    },
  };
  const fixed = {
    now: () => at('2026-07-03T21:00:00Z'),
    after: () => ({}),
    cancel: () => {},
    sleep: async () => {},
  };
  const job = new Custodian({
    ledger,
    slack,
    threads,
    channel: 'C062BS4GADR',
    owner: 'UAR78LSKC',
    log: silentLog,
    clock: fixed,
  });
  await job.tick();
  // The thread exists, so the tick does nothing more.
  await job.tick();
  job.stop();
  const first: Start = {
    ref: { surface: 'slack', channelId: 'C062BS4GADR', id: 'p-1' },
    profile: 'custodian',
    asker: 'UAR78LSKC',
    text: custodianPrompt('2026-07-03'),
  };
  expect(starts).toEqual([first, first]);
  expect(slack.calls).toHaveLength(1);
});

test('one root and one queued assignment per day, including after restart', async () => {
  const ledger = new Ledger();
  const slack = new FakeSlack();
  const prompts: string[] = [];
  const threads: Starts = {
    async start({ text }: Start) {
      if (prompts.includes(text)) return false;
      prompts.push(text);
      return true;
    },
  };
  const clock = new FakeClock();
  // FakeClock's initial time is not today's date: inject a minimal fixed clock.
  const fixed = {
    now: () => at('2026-07-03T21:00:00Z'),
    after: clock.after.bind(clock),
    cancel: clock.cancel.bind(clock),
    sleep: clock.sleep.bind(clock),
  };
  const make = () =>
    new Custodian({
      ledger,
      slack: slack as SlackApi,
      threads,
      channel: 'C062BS4GADR',
      owner: 'UAR78LSKC',
      log: silentLog,
      clock: fixed,
    });
  const first = make();
  await first.tick();
  first.stop();
  const restarted = make();
  await restarted.tick();
  restarted.stop();
  expect(slack.calls.filter((call) => call.call === 'post')).toHaveLength(1);
  expect(prompts).toHaveLength(1);
});
