/**
 * The thread contract through a surface the state machine knows nothing
 * about, then two surfaces behind one Threads sharing mate's caps.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { MINT_FAILED, SANDBOX_CLOSED, WAITING } from '../src/notices.ts';
import { type Script, StubSandboxes } from '../src/sandbox.ts';
import { sandboxName } from '../src/sandboxes.ts';
import { type Inbound, threadKey } from '../src/surface.ts';
import { Threads, type ThreadsConfig } from '../src/threads.ts';
import { FakeSurface } from './fakesurface.ts';
import {
  FakeClock,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const ME = 'U0BOT';
const OWNER = 'UAR78LSKC';
const STRANGER = 'U0NOPE';
const CHANNEL = 'C062BS4GADR';
const QUIET_MS = 15 * 60_000;

const config: ThreadsConfig = {
  quietMs: QUIET_MS,
  maxTurnsPerThread: 30,
  maxTurnsPerDay: 120,
  maxConcurrent: 3,
};

let clock: FakeClock;
let surface: FakeSurface;
let log: RecordingLog;
let metrics: RecordingInstruments;
let serial = 0;

const streaming =
  (text: string): Script =>
  () => {
    const steps: ReturnType<Script> = [{ status: 'working' }, { wait: 100 }];
    for (const word of text.split(' '))
      steps.push({ text: `${word} ` }, { wait: 100 });
    steps.push({ status: null });
    return steps;
  };

function mention(content: string, overrides: Partial<Inbound> = {}): Inbound {
  return {
    surface: 'slack',
    id: `17583000${String(++serial).padStart(2, '0')}.000100`,
    channelId: CHANNEL,
    threadId: null,
    authorId: OWNER,
    authorIsBot: false,
    content: `<@${ME}> ${content}`,
    mentionsMe: true,
    ...overrides,
  };
}

function inThread(
  threadId: string,
  content: string,
  authorId = OWNER,
): Inbound {
  surface.say(threadId, content, authorId);
  return {
    surface: 'slack',
    id: `17583001${String(++serial).padStart(2, '0')}.000100`,
    channelId: CHANNEL,
    threadId,
    authorId,
    authorIsBot: false,
    content,
    mentionsMe: false,
  };
}

function build(opts: { script?: Script } = {}) {
  const sandboxes = new StubSandboxes({ clock, script: opts.script });
  const threads = new Threads({
    surfaces: [surface],
    sandboxes,
    clock,
    log,
    config,
    editCadenceMs: 1_000,
    metrics,
  });
  return { threads, sandboxes };
}

const key = (threadId: string) =>
  threadKey({ surface: 'slack', channelId: CHANNEL, id: threadId });

beforeEach(() => {
  clock = new FakeClock();
  surface = new FakeSurface(ME, new Set([OWNER]), new Set([CHANNEL]));
  log = new RecordingLog();
  metrics = new RecordingInstruments();
});

describe('a thread on a surface that is not Discord', () => {
  test('a mention from the allowlisted user opens a thread and the answer lands in it', async () => {
    const { threads } = build({ script: streaming('hello there') });
    const start = mention('say hi');
    await threads.onMessage(start);
    await settle();
    expect(surface.opened).toHaveLength(1);
    expect(surface.opened[0]).toMatchObject({
      channelId: CHANNEL,
      messageId: start.id,
      title: 'say hi',
    });
    await clock.advance(5_000);
    expect(threads.stateOf(key(start.id))).toBe('attached');
    expect(surface.answerIn(start.id)).toBe('hello there ');
    expect(surface.canvases.get(start.id)?.outcome).toBe('done');
    // The turn names who it answers, which a streaming surface needs.
    expect(surface.askers).toEqual([OWNER]);
  });

  test('a turn hands the surface every tool call, beside the same answer', async () => {
    const { threads } = build({
      script: () => [
        { tool: { id: 'c1', title: 'read files', state: 'in_progress' } },
        { status: 'read files…' },
        { text: 'found it' },
        { tool: { id: 'c1', title: 'read files', state: 'complete' } },
        { status: null },
      ],
    });
    const start = mention('go');
    await threads.onMessage(start);
    await clock.advance(5_000);
    expect(surface.canvases.get(start.id)?.cards).toEqual([
      { id: 'c1', title: 'read files', state: 'in_progress' },
      { id: 'c1', title: 'read files', state: 'complete' },
    ]);
    expect(surface.answerIn(start.id)).toBe('found it');
    expect(surface.canvases.get(start.id)?.outcome).toBe('done');
  });

  test('a restart under a running turn tells the surface the thread is idle', async () => {
    const { threads, sandboxes } = build({
      script: () => [{ status: 'thinking…' }, { wait: 10_000_000 }],
    });
    const start = mention('a long job');
    await threads.onMessage(start);
    await clock.advance(5_000);
    expect(threads.stateOf(key(start.id))).toBe('turn');

    const after = new Threads({
      surfaces: [surface],
      sandboxes,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
      metrics,
    });
    await after.rehydrate();
    // A thread-level working sign outlives the process, so it is settled.
    expect(surface.settled).toEqual([start.id]);
  });

  test('a restart over an idle thread tells it nothing', async () => {
    const { threads, sandboxes } = build({ script: streaming('alpha') });
    const start = mention('go');
    await threads.onMessage(start);
    await clock.advance(5_000);

    const after = new Threads({
      surfaces: [surface],
      sandboxes,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
      metrics,
    });
    await after.rehydrate();
    expect(surface.settled).toEqual([]);
  });

  test('a mention from anyone else, or outside an allowed channel, is silence', async () => {
    const { threads } = build();
    await threads.onMessage(mention('hi', { authorId: STRANGER }));
    await threads.onMessage(mention('hi', { channelId: 'C0OTHER' }));
    await threads.onMessage(mention('hi', { mentionsMe: false }));
    await settle();
    expect(surface.opened).toHaveLength(0);
    expect(surface.posted).toHaveLength(0);
  });

  test('mate does not answer itself, even unmarked, in a thread it owns', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    const start = mention('start');
    await threads.onMessage(start);
    await clock.advance(5_000);
    // Without the bot flag, mate's own message in an owned thread would loop.
    await threads.onMessage({
      ...inThread(start.id, 'ok ', ME),
      authorIsBot: false,
    });
    await clock.advance(5_000);
    expect(sandboxes.prompts).toHaveLength(1);
  });

  test("the allowlisted user's reply in a thread mate owns continues it", async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    const start = mention('start');
    await threads.onMessage(start);
    await clock.advance(5_000);
    await threads.onMessage(inThread(start.id, 'and again'));
    await clock.advance(5_000);
    expect(sandboxes.prompts).toEqual(['start', 'and again']);
    expect(surface.askers).toEqual([OWNER, OWNER]);
  });

  test('a reply from anyone else in a thread mate owns is silence', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    const start = mention('start');
    await threads.onMessage(start);
    await clock.advance(5_000);
    const stranger = inThread(start.id, 'and me', STRANGER);
    await threads.onMessage(stranger);
    await threads.onMessage({ ...stranger, mentionsMe: true });
    await clock.advance(5_000);
    expect(sandboxes.prompts).toEqual(['start']);
    expect(surface.askers).toEqual([OWNER]);
    expect(threads.stateOf(key(start.id))).toBe('attached');
  });

  test("the allowlisted user's Stop ends the turn; anyone else's is ignored", async () => {
    const { threads } = build({ script: streaming('one two three four five') });
    const start = mention('go');
    await threads.onMessage(start);
    await clock.advance(250);
    await threads.onStop(key(start.id), STRANGER, async () => {});
    await settle();
    expect(threads.stateOf(key(start.id))).toBe('turn');
    await threads.onStop(key(start.id), OWNER, async () => {});
    await clock.advance(2_000);
    expect(threads.stateOf(key(start.id))).toBe('attached');
    expect(surface.canvases.get(start.id)?.outcome).toBe('stopped');
    expect(surface.answerIn(start.id)).not.toContain('five');
  });

  test('quiet tears the sandbox down and tells the thread, with nothing to archive', async () => {
    const { threads, sandboxes } = build({ script: streaming('done') });
    const start = mention('go');
    await threads.onMessage(start);
    await clock.advance(5_000);
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(key(start.id))).toBe('closed');
    expect(sandboxes.liveCount).toBe(0);
    expect(surface.linesIn(start.id).at(-1)).toBe(SANDBOX_CLOSED);
    expect(log.of('archive failed')).toHaveLength(0);
  });

  test('a fresh sandbox is handed what the thread already said', async () => {
    const { threads, sandboxes } = build({ script: streaming('alpha') });
    const start = mention('first question');
    await threads.onMessage(start);
    await clock.advance(5_000);
    await threads.onMessage(inThread(start.id, 'second question'));
    await clock.advance(5_000);
    await clock.advance(QUIET_MS);

    await threads.onMessage(inThread(start.id, 'third question'));
    await clock.advance(5_000);
    const prompt = sandboxes.prompts.at(-1) ?? '';
    expect(prompt).toContain('jawn: second question');
    expect(prompt).not.toContain(SANDBOX_CLOSED);
    expect(prompt.endsWith('third question')).toBe(true);
  });

  test('an error is one plain line in the thread, never silence', async () => {
    const sandboxes = new StubSandboxes({
      clock,
      mintFails: 'ImagePullBackOff',
    });
    const threads = new Threads({
      surfaces: [surface],
      sandboxes,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
      metrics,
    });
    const start = mention('go');
    await threads.onMessage(start);
    await settle();
    expect(surface.linesIn(start.id)).toEqual([
      `${MINT_FAILED}: ImagePullBackOff`,
    ]);
  });
});

describe('a thread key', () => {
  test('carries the surface, and the channel where the id alone is not unique', () => {
    expect(threadKey({ surface: 'discord', channelId: 'c', id: '123' })).toBe(
      'discord:123',
    );
    expect(
      threadKey({
        surface: 'slack',
        channelId: CHANNEL,
        id: '1758300000.000100',
      }),
    ).toBe(`slack:${CHANNEL}:1758300000.000100`);
  });

  test('the same timestamp in two channels is two threads', () => {
    const a = threadKey({
      surface: 'slack',
      channelId: 'CARBAMA05',
      id: '1758300000.000100',
    });
    const b = threadKey({
      surface: 'slack',
      channelId: CHANNEL,
      id: '1758300000.000100',
    });
    expect(a).not.toBe(b);
  });
});

describe('the sandbox a thread is named after', () => {
  test('is a valid Kubernetes name and label value on either surface', () => {
    const discord = sandboxName({
      surface: 'discord',
      channelId: '1509024937422356532',
      id: '1509024937422356777',
    });
    const slack = sandboxName({
      surface: 'slack',
      channelId: CHANNEL,
      id: '1758300000.000100',
    });
    expect(discord).toBe('mate-1509024937422356777');
    expect(slack).toBe('mate-slack-c062bs4gadr-1758300000-000100');
    for (const name of [discord, slack]) {
      expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test('the thread and channel it is labelled with survive a round trip', () => {
    // A label value is up to 63 of [A-Za-z0-9._-], alphanumeric at both ends.
    const label = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
    expect('1758300000.000100').toMatch(label);
    expect(CHANNEL).toMatch(label);
  });

  test('refuses ids that are not the surface they claim', () => {
    expect(() =>
      sandboxName({
        surface: 'slack',
        channelId: '../escape',
        id: '1758300000.000100',
      }),
    ).toThrow(/not a Slack thread/);
    expect(() =>
      sandboxName({ surface: 'slack', channelId: CHANNEL, id: 'nope' }),
    ).toThrow(/not a Slack thread/);
  });
});

describe('two surfaces, one mate', () => {
  const discordMention = (content: string): Inbound => ({
    surface: 'discord',
    id: `m-${++serial}`,
    channelId: '1509024937422356532',
    threadId: '1509024937422356532',
    authorId: '308072071949320204',
    authorIsBot: false,
    content: `<@900000000000000001> ${content}`,
    mentionsMe: true,
  });

  const fakeDiscord = () => {
    const discord = new FakeDiscord('900000000000000001');
    return {
      discord,
      surface: discord.surface({
        me: '900000000000000001',
        allowedUserIds: new Set(['308072071949320204']),
        allowedChannelIds: new Set(['1509024937422356532']),
      }),
    };
  };

  test('each comes up on its own and claims only its own sandboxes', async () => {
    const { discord, surface: discordSurface } = fakeDiscord();
    const shared = new StubSandboxes({ clock, script: streaming('ok') });
    const before = new Threads({
      surfaces: [surface, discordSurface],
      sandboxes: shared,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
      metrics,
    });
    const onSlack = mention('slack first');
    await before.onMessage(onSlack);
    await before.onMessage(discordMention('discord first'));
    await clock.advance(5_000);
    const discordThreadId = discord.threads[0]?.id ?? '';

    // After a restart surfaces arrive one at a time, and a Discord that never
    // connects must not block Slack's threads.
    const after = new Threads({
      surfaces: [],
      sandboxes: shared,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
      metrics,
    });
    await after.add(surface);
    expect(after.surfaceNames).toEqual(['slack']);
    expect(after.stateOf(key(onSlack.id))).toBe('attached');
    expect(after.stateOf(`discord:${discordThreadId}`)).toBeUndefined();

    await after.add(discordSurface);
    expect(after.surfaceNames).toEqual(['slack', 'discord']);
    expect(after.stateOf(`discord:${discordThreadId}`)).toBe('attached');
  });

  test('share the concurrency cap, and each is answered on its own', async () => {
    const { discord, surface: discordSurface } = fakeDiscord();
    const sandboxes = new StubSandboxes({ clock, script: streaming('ok') });
    const threads = new Threads({
      surfaces: [discordSurface, surface],
      sandboxes,
      clock,
      log,
      config: { ...config, maxConcurrent: 1 },
      editCadenceMs: 1_000,
      metrics,
    });

    await threads.onMessage({
      surface: 'discord',
      id: 'm-1',
      channelId: '1509024937422356532',
      threadId: '1509024937422356532',
      authorId: '308072071949320204',
      authorIsBot: false,
      content: '<@900000000000000001> first',
      mentionsMe: true,
    });
    const second = mention('second');
    await threads.onMessage(second);
    await settle();

    const discordThreadId = discord.threads[0]?.id ?? '';
    expect(threads.stateOf(`discord:${discordThreadId}`)).toBe('turn');
    expect(threads.stateOf(key(second.id))).toBe('waiting');
    expect(surface.linesIn(second.id)).toEqual([`${WAITING} · next up`]);

    await clock.advance(5_000);
    await threads.onThreadArchived({
      surface: 'discord',
      channelId: '1509024937422356532',
      id: discordThreadId,
    });
    await settle();
    await clock.advance(5_000);
    expect(threads.stateOf(key(second.id))).toBe('attached');
    expect(surface.answerIn(second.id)).toBe('ok ');
    expect(discord.contentsIn(discordThreadId).at(-1)).toBe(SANDBOX_CLOSED);
  });
});
