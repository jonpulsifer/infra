/**
 * The status line a thread watches while it waits: through the surface port
 * first, then as each adapter draws it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DiscordNotice } from '../src/discord.ts';
import {
  ATTACHING,
  MINT_FAILED,
  MINT_STEPS,
  NEVER_STARTED,
  STOPPED_WAITING,
  WAITING,
} from '../src/notices.ts';
import { type Script, StubSandboxes } from '../src/sandbox.ts';
import { escapeSlack, SlackNotice } from '../src/slack.ts';
import type { Inbound, ThreadRef } from '../src/surface.ts';
import { Threads, type ThreadsConfig } from '../src/threads.ts';
import { FakeSlack, FakeSurface } from './fakesurface.ts';
import {
  FakeClock,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const ME = 'U0BOT';
const OWNER = 'UAR78LSKC';
const CHANNEL = 'C062BS4GADR';
/** Longer than any incidental clock advance. */
const MINT_MS = 30_000;

const config: ThreadsConfig = {
  quietMs: 15 * 60_000,
  maxTurnsPerThread: 30,
  maxTurnsPerDay: 120,
  maxConcurrent: 2,
};

let clock: FakeClock;
let surface: FakeSurface;
let log: RecordingLog;
let metrics: RecordingInstruments;
let serial = 0;

const answering: Script = () => [{ text: 'ok' }];

/** The distinct steps the line showed, elapsed counts stripped. */
function said(): string[] {
  const steps = surface.notices.map((line) => line.split(' · ')[0] ?? line);
  return steps.filter((step, at) => step !== steps[at - 1]);
}

function mention(content = 'go'): Inbound {
  return {
    surface: 'slack',
    id: `17583000${String(++serial).padStart(2, '0')}.000100`,
    channelId: CHANNEL,
    threadId: null,
    authorId: OWNER,
    authorIsBot: false,
    content: `<@${ME}> ${content}`,
    mentionsMe: true,
  };
}

function build(
  opts: {
    mintDelayMs?: number;
    mintFails?: string;
    attachFails?: string;
    spares?: number;
    spareDelayMs?: number;
    maxConcurrent?: number;
  } = {},
) {
  const sandboxes = new StubSandboxes({
    clock,
    script: answering,
    mintDelayMs: opts.mintDelayMs,
    mintFails: opts.mintFails,
    attachFails: opts.attachFails,
    spares: opts.spares,
    spareDelayMs: opts.spareDelayMs,
  });
  const threads = new Threads({
    surfaces: [surface],
    sandboxes,
    clock,
    log,
    config: {
      ...config,
      ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
    },
    editCadenceMs: 1_000,
    metrics,
  });
  return { threads, sandboxes };
}

beforeEach(() => {
  clock = new FakeClock();
  surface = new FakeSurface(ME, new Set([OWNER]), new Set([CHANNEL]));
  log = new RecordingLog();
  metrics = new RecordingInstruments();
});

describe('the line a thread watches while it waits', () => {
  test('is in the thread before the sandbox is, and names each step', async () => {
    const { threads } = build({ mintDelayMs: MINT_MS });
    const start = mention();
    void threads.onMessage(start);
    await settle();

    expect(surface.linesIn(start.id)).toEqual([MINT_STEPS.booting]);
    expect(surface.canvases.has(start.id)).toBe(false);
    expect(said()).toEqual([MINT_STEPS.creating, MINT_STEPS.booting]);

    await clock.advance(MINT_MS + 5_000);
    expect(said()).toEqual([
      MINT_STEPS.creating,
      MINT_STEPS.booting,
      ATTACHING,
    ]);
  });

  test('says how long the wait has been, so a slow one reads as alive', async () => {
    const { threads } = build({ mintDelayMs: MINT_MS });
    const start = mention();
    void threads.onMessage(start);
    await settle();
    await clock.advance(5_000);

    expect(surface.linesIn(start.id)).toEqual([`${MINT_STEPS.booting} · 5s`]);
    await clock.advance(5_000);
    expect(surface.linesIn(start.id)).toEqual([`${MINT_STEPS.booting} · 10s`]);
  });

  test('is taken out of the thread when the turn starts', async () => {
    const { threads } = build();
    const start = mention();
    await threads.onMessage(start);
    // Read before the redraw cadence, while an uncancelled redraw timer would
    // still be pending; the one left is the quiet timer.
    await clock.advance(1_000);
    expect(clock.pendingTimers).toBe(1);

    expect(surface.answerIn(start.id)).toBe('ok');
    expect(surface.linesIn(start.id)).toEqual([]);
  });

  test('never says a spare was taken when no pool is configured', async () => {
    const { threads } = build();
    await threads.onMessage(mention());
    await clock.advance(5_000);

    expect(said()).not.toContain(MINT_STEPS.adopting);
    expect(said()).not.toContain(MINT_STEPS.refreshing);
  });

  test('says so when the thread is handed a sandbox that was already warm', async () => {
    const { threads, sandboxes } = build({ spares: 1, spareDelayMs: 2_000 });
    await sandboxes.ensureSpares();
    await threads.onMessage(mention());
    await clock.advance(5_000);

    expect(said()).toEqual([
      MINT_STEPS.creating,
      MINT_STEPS.adopting,
      MINT_STEPS.refreshing,
      ATTACHING,
    ]);
    expect(said()).not.toContain(MINT_STEPS.booting);
  });
});

describe('the line when the wait ends badly', () => {
  test('a mint that fails becomes the reason, in the same line', async () => {
    const { threads } = build({ mintFails: 'no room on the node' });
    const start = mention();
    await threads.onMessage(start);
    await settle();

    expect(surface.linesIn(start.id)).toEqual([
      `${MINT_FAILED}: no room on the node`,
    ]);
  });

  test('an attach that fails becomes the reason too', async () => {
    const { threads } = build({ attachFails: 'the harness did not answer' });
    const start = mention();
    await threads.onMessage(start);
    await settle();

    expect(surface.linesIn(start.id)).toHaveLength(1);
    expect(surface.linesIn(start.id)[0]).toContain('did not answer');
  });

  test('the reason is the line rewritten, not a second message under it', async () => {
    const { threads } = build({ mintFails: 'no room on the node' });
    const start = mention();
    await threads.onMessage(start);
    await settle();

    const calls = surface.noticeCalls;
    const first = calls[0];
    expect(first?.call).toBe('post');
    expect(calls.at(-1)).toEqual({
      call: 'edit',
      id: first?.id ?? '',
      text: `${MINT_FAILED}: no room on the node`,
    });
    // Remove-then-post leaves the same words, so only the call log shows an edit in place.
    expect(calls.filter((call) => call.call === 'post')).toHaveLength(1);
    expect(calls.filter((call) => call.call === 'remove')).toHaveLength(0);
  });

  test('a line that cannot be taken back is left standing, and the answer still lands', async () => {
    const { threads } = build({ mintDelayMs: MINT_MS });
    const start = mention();
    void threads.onMessage(start);
    await settle();
    // Every draw fails from here, including the removal at the turn's start.
    surface.failNotice = new Error('rate limited');
    await clock.advance(MINT_MS + 5_000);

    expect(surface.answerIn(start.id)).toBe('ok');
    expect(surface.linesIn(start.id)).toHaveLength(1);
    expect(log.of('the waiting line could not be drawn')).toHaveLength(1);
  });

  test('a thread that has to queue watches the same line, and it is replaced', async () => {
    const { threads } = build({ maxConcurrent: 1, mintDelayMs: MINT_MS });
    void threads.onMessage(mention());
    const queued = mention();
    void threads.onMessage(queued);
    await settle();

    expect(surface.linesIn(queued.id)).toEqual([`${WAITING} · next up`]);

    // No slot frees, so the quiet timer drops it from the queue.
    await clock.advance(config.quietMs + 1_000);
    expect(surface.linesIn(queued.id)).toEqual([STOPPED_WAITING]);
  });

  test('mate going down replaces every line it is holding', async () => {
    const { threads } = build({ mintDelayMs: MINT_MS });
    const start = mention();
    void threads.onMessage(start);
    await settle();
    expect(surface.linesIn(start.id)).toEqual([MINT_STEPS.booting]);

    await threads.quiesce();
    expect(surface.linesIn(start.id)).toEqual([NEVER_STARTED]);
  });

  test('a surface that refuses the line still gets the sentence', async () => {
    surface.failNotice = new Error('rate limited');
    const { threads } = build({ mintFails: 'no room on the node' });
    const start = mention();
    await threads.onMessage(start);
    await settle();

    // The rewrite failed, so the reason arrives as a plain post.
    expect(surface.linesIn(start.id)).toEqual([
      `${MINT_FAILED}: no room on the node`,
    ]);
    expect(log.of('the waiting line could not be drawn')).toHaveLength(1);
  });
});

describe('the line as each surface draws it', () => {
  test('Discord posts one message, edits it, and takes it back', async () => {
    const discord = new FakeDiscord(ME);
    const notice = new DiscordNotice(discord, 'thread-1');

    await notice.say(MINT_STEPS.creating);
    await notice.say(MINT_STEPS.booting);
    expect(discord.contentsIn('thread-1')).toEqual([MINT_STEPS.booting]);
    expect(discord.inThread('thread-1')[0]?.edits).toBe(1);
    // No Stop button: nothing is running yet to cancel.
    expect(discord.inThread('thread-1')[0]?.hasStop).toBe(false);

    await notice.done(null);
    expect(discord.contentsIn('thread-1')).toEqual([]);
  });

  test('Discord that cannot take the line back says so rather than swallowing it', async () => {
    const discord = new FakeDiscord(ME);
    const notice = new DiscordNotice(discord, 'thread-1');
    await notice.say(MINT_STEPS.booting);
    discord.failDeletes = new Error('429 too many requests');

    // Raised so `Progress` counts the failure and the caller posts instead.
    await expect(notice.done(null)).rejects.toThrow('429');
    expect(discord.contentsIn('thread-1')).toEqual([MINT_STEPS.booting]);
  });

  test('Discord leaves the last word where the line was', async () => {
    const discord = new FakeDiscord(ME);
    const notice = new DiscordNotice(discord, 'thread-1');

    await notice.say(MINT_STEPS.booting);
    await notice.done(MINT_FAILED);
    expect(discord.contentsIn('thread-1')).toEqual([MINT_FAILED]);
  });

  test('Slack posts into the thread, updates it, and deletes it', async () => {
    const api = new FakeSlack();
    const thread: ThreadRef = {
      surface: 'slack',
      channelId: CHANNEL,
      id: '1758300000.000100',
    };
    const notice = new SlackNotice(api, thread);

    // A plain message: a stream chunk would count as part of the answer.
    await notice.say(MINT_STEPS.creating);
    await notice.say('<@U0NOPE> booting');
    await notice.done(null);

    expect(api.only('post').map((call) => call.text)).toEqual([
      MINT_STEPS.creating,
    ]);
    expect(api.only('edit').map((call) => call.text)).toEqual([
      escapeSlack('<@U0NOPE> booting'),
    ]);
    expect(api.only('remove')).toHaveLength(1);
    expect(api.only('start')).toEqual([]);
  });
});
