/**
 * The thread contract, end to end against a fake Discord and the stub
 * sandbox: what starts a thread, who is heard, how a reply streams, how it
 * stops, what an error and a quiet thread say.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { silentLog } from '../src/log.ts';
import { type Script, StubSandboxes } from '../src/sandbox.ts';
import {
  type Inbound,
  SANDBOX_CLOSED,
  Threads,
  type ThreadsConfig,
  threadName,
} from '../src/threads.ts';
import { FakeClock, FakeDiscord, settle } from './support.ts';

const ME = '900000000000000001';
const OWNER = '308072071949320204';
const STRANGER = '111111111111111111';
const GUILD = '1509024936717455381';
const CHANNEL = '1509024937422356532';
const OTHER_CHANNEL = '1509024937422356599';
const QUIET_MS = 15 * 60_000;

const config: ThreadsConfig = {
  guildId: GUILD,
  allowedUserIds: new Set([OWNER]),
  allowedChannelIds: new Set([CHANNEL]),
  quietMs: QUIET_MS,
  maxTurnsPerThread: 30,
  maxTurnsPerDay: 120,
  maxConcurrent: 3,
};

let clock: FakeClock;
let discord: FakeDiscord;
let serial = 0;

function mention(content: string, overrides: Partial<Inbound> = {}): Inbound {
  return {
    id: `m-${++serial}`,
    guildId: GUILD,
    channelId: CHANNEL,
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
  return {
    id: `m-${++serial}`,
    guildId: GUILD,
    channelId: threadId,
    authorId,
    authorIsBot: false,
    content,
    mentionsMe: false,
  };
}

function build(
  opts: {
    script?: Script;
    config?: Partial<ThreadsConfig>;
    mintFails?: string;
  } = {},
) {
  const sandboxes = new StubSandboxes({
    clock,
    script: opts.script,
    mintFails: opts.mintFails,
  });
  const threads = new Threads({
    discord,
    sandboxes,
    clock,
    log: silentLog,
    config: { ...config, ...opts.config },
    me: ME,
    editCadenceMs: 1_000,
  });
  return { threads, sandboxes };
}

/** A script that streams the given text word by word with a status line up front. */
const streaming =
  (text: string, status = 'running `mise run docs:check`…'): Script =>
  () => {
    const steps: ReturnType<Script> = [{ status }, { wait: 100 }];
    for (const word of text.split(' '))
      steps.push({ text: `${word} ` }, { wait: 100 });
    steps.push({ status: null });
    return steps;
  };

beforeEach(() => {
  clock = new FakeClock();
  discord = new FakeDiscord();
});

describe('starting a thread', () => {
  test('a mention from the allowlisted user in an allowed channel opens a public thread and answers there', async () => {
    const { threads } = build({ script: streaming('hello there') });
    await threads.onMessage(mention('say hi'));
    await settle();
    expect(discord.threads).toHaveLength(1);
    expect(discord.threads[0]).toMatchObject({
      channelId: CHANNEL,
      name: 'say hi',
    });
    const threadId = discord.threads[0]!.id;
    expect(threads.stateOf(threadId)).toBe('turn');
    await clock.advance(5_000);
    expect(threads.stateOf(threadId)).toBe('attached');
    expect(discord.contentsIn(threadId).at(-1)).toBe('hello there ');
  });

  test('the thread is named from the message with the mention stripped', () => {
    expect(threadName(`<@${ME}>   fix the  docs\nsecond line`, ME)).toBe(
      'fix the docs',
    );
    expect(threadName(`<@!${ME}>`, ME)).toBe('mate');
    expect(threadName('x'.repeat(150), ME)).toHaveLength(100);
  });

  test('a mention from anyone else is silence', async () => {
    const { threads } = build();
    await threads.onMessage(mention('hi', { authorId: STRANGER }));
    await settle();
    expect(discord.threads).toHaveLength(0);
    expect(discord.messages).toHaveLength(0);
  });

  test('a mention outside an allowed channel, without a mention, from a bot, or in another guild is silence', async () => {
    const { threads } = build();
    await threads.onMessage(mention('hi', { channelId: OTHER_CHANNEL }));
    await threads.onMessage(mention('hi', { mentionsMe: false }));
    await threads.onMessage(mention('hi', { authorIsBot: true }));
    await threads.onMessage(mention('hi', { guildId: '2' }));
    await settle();
    expect(discord.threads).toHaveLength(0);
    expect(discord.messages).toHaveLength(0);
  });

  test('a second human posting in a mate thread shares its sandbox', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    await threads.onMessage(mention('start'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await threads.onMessage(inThread(threadId, 'and me', STRANGER));
    await clock.advance(5_000);
    expect(sandboxes.liveCount).toBe(1);
    expect(
      discord.contentsIn(threadId).filter((c) => c === 'ok '),
    ).toHaveLength(2);
  });
});

describe('streaming a reply', () => {
  test('one message is edited in place with an italic status line above the text and a Stop button, both gone when the turn ends', async () => {
    const script: Script = () => [
      { status: 'running `mise run docs:check`…' },
      { wait: 100 },
      { text: 'alpha ' },
      { wait: 1_000 },
      { text: 'beta ' },
      { wait: 1_000 },
      { status: null },
    ];
    const { threads } = build({ script });
    await threads.onMessage(mention('go'));
    await settle();
    const threadId = discord.threads[0]!.id;
    await clock.advance(100);
    const [reply] = discord.inThread(threadId);
    expect(reply!.content).toBe('*running `mise run docs:check`…*');
    expect(reply!.hasStop).toBe(true);
    await clock.advance(1_000);
    expect(reply!.content).toStartWith(
      '*running `mise run docs:check`…*\n\nalpha ',
    );
    expect(reply!.hasStop).toBe(true);
    await clock.advance(5_000);
    expect(discord.inThread(threadId)).toHaveLength(1);
    expect(reply!.content).toBe('alpha beta ');
    expect(reply!.hasStop).toBe(false);
  });

  test('text past the cap seals the message and continues in a new one; no message exceeds 2000 characters', async () => {
    const paragraph = `${'lorem ipsum '.repeat(40).trim()}\n`;
    const long = paragraph.repeat(12);
    const script: Script = () => [
      { text: long.slice(0, 1500) },
      { wait: 1_000 },
      { text: long.slice(1500) },
      { wait: 1_000 },
    ];
    const { threads } = build({ script });
    await threads.onMessage(mention('long'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    const chunks = discord.inThread(threadId);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(chunk.content.length).toBeLessThanOrEqual(2000);
    expect(chunks.map((c) => c.content).join('')).toBe(long);
    expect(chunks.slice(0, -1).every((c) => !c.hasStop)).toBe(true);
    expect(chunks.at(-1)!.hasStop).toBe(false);
  });

  test('edits are coalesced to one per second per thread', async () => {
    const script: Script = () =>
      Array.from({ length: 40 }, (_, i) => [
        { text: `w${i} ` },
        { wait: 50 },
      ]).flat();
    const { threads } = build({ script });
    await threads.onMessage(mention('fast'));
    await clock.advance(1_000);
    const reply = discord.inThread(discord.threads[0]!.id)[0]!;
    expect(reply.content).toContain('w19 ');
    expect(reply.edits).toBe(1);
    await clock.advance(1_500);
    expect(reply.content).toContain('w39 ');
    expect(reply.edits).toBeLessThanOrEqual(3);
  });
});

describe('stopping a turn', () => {
  test('the allowlisted user\'s Stop click is acked, cancels the turn, and the message ends with "stopped"', async () => {
    const { threads } = build({ script: streaming('one two three four five') });
    await threads.onMessage(mention('go'));
    await clock.advance(250);
    const threadId = discord.threads[0]!.id;
    await threads.onStop(threadId, OWNER, () => discord.ackUpdate('i-1'));
    await clock.advance(2_000);
    expect(discord.acks).toEqual(['i-1']);
    expect(threads.stateOf(threadId)).toBe('attached');
    const reply = discord.inThread(threadId)[0]!;
    expect(reply.content).toEndWith('*stopped*');
    expect(reply.content).not.toContain('five');
    expect(reply.hasStop).toBe(false);
  });

  test("anyone else's Stop click is acked and ignored", async () => {
    const { threads } = build({ script: streaming('one two') });
    await threads.onMessage(mention('go'));
    await clock.advance(250);
    const threadId = discord.threads[0]!.id;
    await threads.onStop(threadId, STRANGER, () => discord.ackUpdate('i-2'));
    await clock.advance(2_000);
    expect(discord.acks).toEqual(['i-2']);
    expect(discord.inThread(threadId)[0]!.content).toBe('one two ');
  });
});

describe('errors', () => {
  test('a sandbox that does not start is one plain sentence in the thread', async () => {
    const { threads } = build({ mintFails: 'ImagePullBackOff' });
    await threads.onMessage(mention('go'));
    await settle();
    const threadId = discord.threads[0]!.id;
    expect(discord.contentsIn(threadId)).toEqual([
      'the sandbox did not start: ImagePullBackOff',
    ]);
    expect(threads.stateOf(threadId)).toBe('closed');
  });

  test('a harness failure mid-turn is one plain sentence and the thread stays attached', async () => {
    const script: Script = () => [
      { text: 'partial ' },
      { wait: 100 },
      { fail: 'provider returned 402' },
    ];
    const { threads } = build({ script });
    await threads.onMessage(mention('go'));
    await clock.advance(2_000);
    const threadId = discord.threads[0]!.id;
    expect(discord.contentsIn(threadId)).toEqual([
      'partial ',
      'the harness failed: provider returned 402',
    ]);
    expect(threads.stateOf(threadId)).toBe('attached');
  });

  test('a sandbox that dies mid-turn is one plain sentence and the thread closes', async () => {
    const script: Script = () => [
      { text: 'a ' },
      { wait: 100 },
      { text: 'b ' },
    ];
    const { threads, sandboxes } = build({ script });
    await threads.onMessage(mention('go'));
    await settle();
    const threadId = discord.threads[0]!.id;
    for (const sandbox of await sandboxes.list())
      await sandboxes.teardown(sandbox);
    await clock.advance(2_000);
    expect(discord.contentsIn(threadId).at(-1)).toStartWith(
      'the sandbox died mid-turn: ',
    );
    expect(threads.stateOf(threadId)).toBe('closed');
  });
});

describe('quiet', () => {
  test('15 minutes after the last turn the sandbox is torn down, the thread is told, and archived', async () => {
    const { threads, sandboxes } = build({ script: streaming('done') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    // the turn completed 200 ms in; the timer runs from then
    await clock.advance(QUIET_MS - 5_000 + 199);
    expect(threads.stateOf(threadId)).toBe('attached');
    await clock.advance(1);
    expect(threads.stateOf(threadId)).toBe('closed');
    expect(sandboxes.liveCount).toBe(0);
    expect(discord.contentsIn(threadId).at(-1)).toBe(SANDBOX_CLOSED);
    expect(discord.archived).toEqual([threadId]);
  });

  test('a message in the thread resets the quiet timer', async () => {
    const { threads } = build({ script: streaming('ok') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await clock.advance(QUIET_MS - 60_000);
    await threads.onMessage(inThread(threadId, 'still here'));
    await clock.advance(5_000);
    await clock.advance(QUIET_MS - 60_000);
    expect(threads.stateOf(threadId)).toBe('attached');
  });

  test('a message after teardown mints a fresh sandbox', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(threadId)).toBe('closed');
    await threads.onMessage(inThread(threadId, 'again'));
    await clock.advance(5_000);
    expect(threads.stateOf(threadId)).toBe('attached');
    expect(sandboxes.liveCount).toBe(1);
    expect(discord.contentsIn(threadId).at(-1)).toBe('ok ');
  });

  test('a human archiving the thread tears it down too', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await threads.onThreadArchived(threadId);
    expect(sandboxes.liveCount).toBe(0);
    expect(discord.contentsIn(threadId).at(-1)).toBe(SANDBOX_CLOSED);
  });
});

describe('capacity', () => {
  test('the N+1th thread waits FIFO, is told how many are ahead, and starts when a slot frees', async () => {
    const { threads } = build({
      script: streaming('ok'),
      config: { maxConcurrent: 1 },
    });
    await threads.onMessage(mention('first'));
    await threads.onMessage(mention('second'));
    await threads.onMessage(mention('third'));
    await settle();
    const [first, second, third] = discord.threads.map((t) => t.id) as [
      string,
      string,
      string,
    ];
    expect(threads.stateOf(first)).toBe('turn');
    expect(threads.stateOf(second)).toBe('waiting');
    expect(threads.stateOf(third)).toBe('waiting');
    expect(discord.contentsIn(second)).toEqual([
      'waiting for a sandbox (0 ahead)',
    ]);
    expect(discord.contentsIn(third)).toEqual([
      'waiting for a sandbox (1 ahead)',
    ]);
    await clock.advance(5_000);
    expect(threads.stateOf(second)).toBe('waiting');
    await threads.onThreadArchived(first);
    await settle();
    expect(threads.stateOf(first)).toBe('closed');
    expect(threads.stateOf(second)).toBe('turn');
    expect(threads.stateOf(third)).toBe('waiting');
    await clock.advance(5_000);
    expect(discord.contentsIn(second).at(-1)).toBe('ok ');
    await threads.onThreadArchived(second);
    await settle();
    expect(threads.stateOf(third)).toBe('turn');
  });

  test('a thread that waits 15 minutes in the queue is told and closed', async () => {
    const { threads } = build({
      script: streaming('ok'),
      config: { maxConcurrent: 1 },
    });
    await threads.onMessage(mention('first'));
    await threads.onMessage(mention('second'));
    await settle();
    const second = discord.threads[1]!.id;
    await threads.onMessage(inThread(discord.threads[0]!.id, 'keep busy'));
    await clock.advance(QUIET_MS - 1);
    expect(threads.stateOf(second)).toBe('waiting');
    await clock.advance(1);
    expect(threads.stateOf(second)).toBe('closed');
    expect(threads.waitingIds).toHaveLength(0);
    expect(discord.contentsIn(second).at(-1)).toBe(
      'stopped waiting for a sandbox; message again to start fresh',
    );
  });
});

describe('turn budgets', () => {
  test('the per-thread cap trips with the thread told', async () => {
    const { threads } = build({
      script: streaming('ok'),
      config: { maxTurnsPerThread: 2 },
    });
    await threads.onMessage(mention('one'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await threads.onMessage(inThread(threadId, 'two'));
    await clock.advance(5_000);
    await threads.onMessage(inThread(threadId, 'three'));
    await clock.advance(5_000);
    expect(discord.contentsIn(threadId).at(-1)).toBe(
      'this thread has used its 2 turns; start a new thread',
    );
    expect(
      discord.contentsIn(threadId).filter((c) => c === 'ok '),
    ).toHaveLength(2);
    expect(threads.stateOf(threadId)).toBe('attached');
  });

  test('the daily cap trips across threads and frees after 24 hours', async () => {
    const { threads } = build({
      script: streaming('ok'),
      config: { maxTurnsPerDay: 2 },
    });
    await threads.onMessage(mention('a'));
    await threads.onMessage(mention('b'));
    await threads.onMessage(mention('c'));
    await clock.advance(5_000);
    const third = discord.threads[2]!.id;
    expect(discord.contentsIn(third)).toEqual([
      'the daily budget of 2 turns is spent; try again later',
    ]);
    await clock.advance(QUIET_MS);
    await clock.advance(24 * 3_600_000);
    await threads.onMessage(inThread(third, 'tomorrow'));
    await clock.advance(5_000);
    expect(discord.contentsIn(third).at(-1)).toBe('ok ');
  });
});

describe('rehydrating', () => {
  test('a restarted mate re-attaches to the sandboxes it finds and continues the thread', async () => {
    const shared = new StubSandboxes({ clock, script: streaming('back') });
    const before = new Threads({
      discord,
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      me: ME,
      editCadenceMs: 1_000,
    });
    await before.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;

    const after = new Threads({
      discord,
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      me: ME,
      editCadenceMs: 1_000,
    });
    await after.rehydrate();
    expect(after.stateOf(threadId)).toBe('attached');
    await after.onMessage(inThread(threadId, 'still there?'));
    await clock.advance(5_000);
    expect(shared.liveCount).toBe(1);
    expect(discord.contentsIn(threadId).at(-1)).toBe('back ');
  });

  test('an adopted thread with no sandbox mints on the next message', async () => {
    const { threads, sandboxes } = build({ script: streaming('fresh') });
    threads.adopt('thread-old', CHANNEL);
    expect(threads.stateOf('thread-old')).toBe('new');
    await threads.onMessage(inThread('thread-old', 'hello again'));
    await clock.advance(5_000);
    expect(sandboxes.liveCount).toBe(1);
    expect(discord.contentsIn('thread-old').at(-1)).toBe('fresh ');
  });
});
