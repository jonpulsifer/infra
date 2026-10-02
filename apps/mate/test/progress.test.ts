/**
 * The status line a thread watches while it waits: through the surface port
 * first, then as each adapter draws it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DiscordNotice } from '../src/discord.ts';
import {
  GAVE_UP_WAITING,
  MINT_FAILED,
  MINT_STEPS,
  NEVER_STARTED,
  STORE_DOWN,
  TURN_WAITING,
} from '../src/notices.ts';
import { escapeSlack, SlackNotice } from '../src/slack.ts';
import { MemoryThreadStore } from '../src/store.ts';
import type { Inbound, ThreadRef } from '../src/surface.ts';
import { Threads, type ThreadsConfig } from '../src/threads.ts';
import { FakeSlack, FakeSurface } from './fakesurface.ts';
import { type Script, StubBrain } from './stub-brain.ts';
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
/** How long the first thread holds the only turn slot. */
const TURN_MS = 30_000;

const config: ThreadsConfig = {
  quietMs: 15 * 60_000,
  maxTurnsPerThread: 30,
  maxTurnsPerDay: 120,
  maxConcurrent: 1,
};

let clock: FakeClock;
let surface: FakeSurface;
let log: RecordingLog;
let metrics: RecordingInstruments;
let serial = 0;

/** The prompt `hold` keeps its slot for `TURN_MS`; every other one answers at once. */
const answering: Script = (prompt) =>
  prompt === 'hold' ? [{ wait: TURN_MS }, { text: 'held' }] : [{ text: 'ok' }];

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

function build(holdMs = TURN_MS) {
  const script: Script = (prompt) =>
    prompt === 'hold'
      ? [{ wait: holdMs }, { text: 'held' }]
      : answering(prompt);
  const brain = new StubBrain({ clock, script });
  const threads = new Threads({
    surfaces: [surface],
    brain,
    store: new MemoryThreadStore(clock),
    clock,
    log,
    config,
    editCadenceMs: 1_000,
    metrics,
  });
  return { threads, brain };
}

/** A thread that has to wait behind one holding the only slot. */
async function queued(holdMs = TURN_MS) {
  const built = build(holdMs);
  void built.threads.onMessage(mention('hold'));
  await settle();
  const start = mention();
  void built.threads.onMessage(start);
  await settle();
  return { ...built, start };
}

beforeEach(() => {
  clock = new FakeClock();
  surface = new FakeSurface(ME, new Set([OWNER]), new Set([CHANNEL]));
  log = new RecordingLog();
  metrics = new RecordingInstruments();
});

describe('the line a thread watches while it waits for a turn', () => {
  test('is in the thread before the answer is, and says where it is in the queue', async () => {
    const { start } = await queued();
    expect(surface.linesIn(start.id)).toEqual([`${TURN_WAITING} · next up`]);
    expect(surface.canvases.has(start.id)).toBe(false);
  });

  test('says how long the wait has been, so a slow one reads as alive', async () => {
    const { start } = await queued();
    await clock.advance(5_000);
    expect(surface.linesIn(start.id)).toEqual([
      `${TURN_WAITING} · next up · 5s`,
    ]);
    await clock.advance(5_000);
    expect(surface.linesIn(start.id)).toEqual([
      `${TURN_WAITING} · next up · 10s`,
    ]);
  });

  test('is taken out of the thread when the turn starts', async () => {
    const { start } = await queued();
    await clock.advance(TURN_MS);
    await settle();
    expect(surface.answerIn(start.id)).toBe('ok');
    expect(surface.linesIn(start.id)).toEqual([]);
  });

  test('is never drawn for a turn that starts at once', async () => {
    const { threads } = build();
    const start = mention();
    await threads.onMessage(start);
    await clock.advance(1_000);
    expect(surface.answerIn(start.id)).toBe('ok');
    expect(surface.notices).toEqual([]);
  });
});

describe('the line when the wait ends badly', () => {
  test('a store that is down becomes the reason, in the same line', async () => {
    const { brain, start } = await queued();
    brain.openFails = 'connection refused';
    await clock.advance(TURN_MS);
    await settle();
    expect(surface.linesIn(start.id)).toEqual([STORE_DOWN]);
    const calls = surface.noticeCalls;
    const first = calls[0];
    expect(first?.call).toBe('post');
    expect(calls.at(-1)).toEqual({
      call: 'edit',
      id: first?.id ?? '',
      text: STORE_DOWN,
    });
    // Remove-then-post leaves the same words, so only the call log shows an edit in place.
    expect(calls.filter((call) => call.call === 'post')).toHaveLength(1);
    expect(calls.filter((call) => call.call === 'remove')).toHaveLength(0);
  });

  test('a line that cannot be taken back is left standing, and the answer still lands', async () => {
    const { start } = await queued();
    // Every draw fails from here, including the removal at the turn's start.
    surface.failNotice = new Error('rate limited');
    await clock.advance(TURN_MS + 5_000);

    expect(surface.answerIn(start.id)).toBe('ok');
    expect(surface.linesIn(start.id)).toHaveLength(1);
    expect(log.of('the waiting line could not be drawn')).toHaveLength(1);
  });

  test('a wait that outlasts the quiet timer is replaced by the reason', async () => {
    const { start } = await queued(config.quietMs * 2);
    await clock.advance(config.quietMs + 1_000);
    expect(surface.linesIn(start.id)).toEqual([GAVE_UP_WAITING]);
  });

  test('mate going down replaces every line it is holding', async () => {
    const { threads, start } = await queued();
    expect(surface.linesIn(start.id)).toEqual([`${TURN_WAITING} · next up`]);

    await threads.quiesce();
    expect(surface.linesIn(start.id)).toEqual([NEVER_STARTED]);
  });

  test('a surface that refuses the line still gets the sentence', async () => {
    surface.failNotice = new Error('rate limited');
    const { brain, start } = await queued();
    brain.openFails = 'connection refused';
    await clock.advance(TURN_MS);
    await settle();

    // The rewrite failed, so the reason arrives as a plain post.
    expect(surface.linesIn(start.id)).toEqual([STORE_DOWN]);
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
