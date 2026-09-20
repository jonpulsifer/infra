/**
 * The thread contract, end to end against a fake Discord and the stub
 * sandbox: what starts a thread, who is heard, how a reply streams, how it
 * stops, what an error and a quiet thread say.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { silentLog } from '../src/log.ts';
import { RESTARTED, SANDBOX_CLOSED } from '../src/notices.ts';
import { type Script, StubSandboxes } from '../src/sandbox.ts';
import { type Surface, threadKey } from '../src/surface.ts';
import {
  type Inbound,
  Threads,
  type ThreadsConfig,
  threadName,
} from '../src/threads.ts';
import {
  discordRef,
  FakeClock,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const ME = '900000000000000001';
const OWNER = '308072071949320204';
const STRANGER = '111111111111111111';
const CHANNEL = '1509024937422356532';
const OTHER_CHANNEL = '1509024937422356599';
const QUIET_MS = 15 * 60_000;

const config: ThreadsConfig = {
  quietMs: QUIET_MS,
  maxTurnsPerThread: 30,
  maxTurnsPerDay: 120,
  maxConcurrent: 3,
};

let clock: FakeClock;
let discord: FakeDiscord;
let surface: Surface;
let log: RecordingLog;
let metrics: RecordingInstruments;
let serial = 0;

/** A Discord thread as the state machine names it. */
const ref = (threadId: string) => discordRef(threadId, CHANNEL);
const key = (threadId: string) => threadKey(ref(threadId));

function mention(content: string, overrides: Partial<Inbound> = {}): Inbound {
  return {
    surface: 'discord',
    id: `m-${++serial}`,
    channelId: CHANNEL,
    threadId: CHANNEL,
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
  // The message is in Discord's log the moment it is sent, which is where the
  // transcript replay reads it back from.
  discord.post(threadId, content, authorId);
  return {
    surface: 'discord',
    id: `m-${++serial}`,
    channelId: threadId,
    threadId,
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
    mintDelayMs?: number;
    attachDelayMs?: number;
    mintFails?: string;
    attachFails?: string;
    costUsd?: number;
    resumes?: boolean;
  } = {},
) {
  const sandboxes = new StubSandboxes({
    clock,
    script: opts.script,
    mintDelayMs: opts.mintDelayMs,
    attachDelayMs: opts.attachDelayMs,
    mintFails: opts.mintFails,
    attachFails: opts.attachFails,
    costUsd: opts.costUsd,
    resumes: opts.resumes,
  });
  const threads = new Threads({
    surfaces: [surface],
    sandboxes,
    clock,
    log,
    config: { ...config, ...opts.config },
    editCadenceMs: 1_000,
    metrics,
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
  discord = new FakeDiscord(ME);
  surface = discord.surface({
    me: ME,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
  });
  log = new RecordingLog();
  metrics = new RecordingInstruments();
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
    expect(threads.stateOf(key(threadId))).toBe('turn');
    await clock.advance(5_000);
    expect(threads.stateOf(key(threadId))).toBe('attached');
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

  test('a mention outside an allowed channel, without a mention, or from a bot is silence', async () => {
    const { threads } = build();
    await threads.onMessage(
      mention('hi', { channelId: OTHER_CHANNEL, threadId: OTHER_CHANNEL }),
    );
    await threads.onMessage(mention('hi', { mentionsMe: false }));
    await threads.onMessage(mention('hi', { authorIsBot: true }));
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
    await threads.onStop(key(threadId), OWNER, () => discord.ackUpdate('i-1'));
    await clock.advance(2_000);
    expect(discord.acks).toEqual(['i-1']);
    expect(threads.stateOf(key(threadId))).toBe('attached');
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
    await threads.onStop(key(threadId), STRANGER, () =>
      discord.ackUpdate('i-2'),
    );
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
    expect(threads.stateOf(key(threadId))).toBe('closed');
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
    expect(threads.stateOf(key(threadId))).toBe('attached');
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
    expect(threads.stateOf(key(threadId))).toBe('closed');
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
    expect(threads.stateOf(key(threadId))).toBe('attached');
    await clock.advance(1);
    expect(threads.stateOf(key(threadId))).toBe('closed');
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
    expect(threads.stateOf(key(threadId))).toBe('attached');
  });

  test('a message after teardown mints a fresh sandbox', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(key(threadId))).toBe('closed');
    await threads.onMessage(inThread(threadId, 'again'));
    await clock.advance(5_000);
    expect(threads.stateOf(key(threadId))).toBe('attached');
    expect(sandboxes.liveCount).toBe(1);
    expect(discord.contentsIn(threadId).at(-1)).toBe('ok ');
  });

  test('a human archiving the thread tears it down too', async () => {
    const { threads, sandboxes } = build({ script: streaming('ok') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    await threads.onThreadArchived(ref(threadId));
    expect(sandboxes.liveCount).toBe(0);
    expect(discord.contentsIn(threadId).at(-1)).toBe(SANDBOX_CLOSED);
    // the closing line auto-unarchives the thread, so mate archives it again
    expect(discord.archived).toEqual([threadId]);
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
    expect(threads.stateOf(key(first))).toBe('turn');
    expect(threads.stateOf(key(second))).toBe('waiting');
    expect(threads.stateOf(key(third))).toBe('waiting');
    expect(discord.contentsIn(second)).toEqual([
      'waiting for a sandbox (0 ahead)',
    ]);
    expect(discord.contentsIn(third)).toEqual([
      'waiting for a sandbox (1 ahead)',
    ]);
    await clock.advance(5_000);
    expect(threads.stateOf(key(second))).toBe('waiting');
    await threads.onThreadArchived(ref(first));
    await settle();
    expect(threads.stateOf(key(first))).toBe('closed');
    expect(threads.stateOf(key(second))).toBe('turn');
    expect(threads.stateOf(key(third))).toBe('waiting');
    await clock.advance(5_000);
    expect(discord.contentsIn(second).at(-1)).toBe('ok ');
    await threads.onThreadArchived(ref(second));
    await settle();
    expect(threads.stateOf(key(third))).toBe('turn');
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
    expect(threads.stateOf(key(second))).toBe('waiting');
    await clock.advance(1);
    expect(threads.stateOf(key(second))).toBe('closed');
    expect(threads.waitingIds).toHaveLength(0);
    expect(discord.contentsIn(second).at(-1)).toBe(
      'stopped waiting for a sandbox; message again to start fresh',
    );
  });

  test('a second message to a waiting thread keeps its quiet timer running', async () => {
    const { threads } = build({
      script: streaming('ok'),
      config: { maxConcurrent: 1 },
    });
    await threads.onMessage(mention('first'));
    await threads.onMessage(mention('second'));
    await settle();
    const second = discord.threads[1]!.id;
    await threads.onMessage(inThread(second, 'still waiting'));
    await clock.advance(QUIET_MS + 1);
    expect(threads.stateOf(key(second))).toBe('closed');
    expect(threads.waitingIds).toHaveLength(0);
    expect(discord.contentsIn(second).at(-1)).toBe(
      'stopped waiting for a sandbox; message again to start fresh',
    );
  });
});

describe('delivery failures', () => {
  test('edits that fail mid-stream are logged once, re-sent by the next flush, and the turn ends normally', async () => {
    const script: Script = () => [
      { status: 'thinking' },
      { wait: 100 },
      { text: 'one ' },
      { wait: 1_000 },
      { text: 'two ' },
      { wait: 1_000 },
      { status: null },
    ];
    const { threads } = build({ script });
    await threads.onMessage(mention('go'));
    await clock.advance(50);
    const threadId = discord.threads[0]!.id;
    discord.failEdits = new Error('429 past retries');
    await clock.advance(1_500);
    expect(log.of('reply edit failed; the next flush re-sends')).toHaveLength(
      1,
    );
    discord.failEdits = null;
    await clock.advance(5_000);
    expect(threads.stateOf(key(threadId))).toBe('attached');
    expect(discord.contentsIn(threadId)).toEqual(['one two ']);
    expect(log.of('reply delivery failed')).toHaveLength(0);
  });

  test('a reply whose final send fails is one plain line, the turn ends, the next turn runs, and quiet still closes the thread', async () => {
    const { threads } = build({ script: streaming('one two') });
    await threads.onMessage(mention('go'));
    await settle();
    const threadId = discord.threads[0]!.id;
    await threads.onMessage(inThread(threadId, 'and again'));
    await clock.advance(50);
    discord.failEdits = new Error('thread archived');
    await clock.advance(5_000);
    expect(threads.stateOf(key(threadId))).toBe('attached');
    expect(log.of('reply delivery failed')).toHaveLength(2);
    expect(
      discord
        .contentsIn(threadId)
        .filter(
          (c) => c === 'the reply could not be delivered: thread archived',
        ),
    ).toHaveLength(2);
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(key(threadId))).toBe('closed');
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
    expect(threads.stateOf(key(threadId))).toBe('attached');
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
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      editCadenceMs: 1_000,
    });
    await before.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;

    const after = new Threads({
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      editCadenceMs: 1_000,
    });
    await after.rehydrate();
    expect(after.stateOf(key(threadId))).toBe('attached');
    await after.onMessage(inThread(threadId, 'still there?'));
    await clock.advance(5_000);
    expect(shared.liveCount).toBe(1);
    expect(discord.contentsIn(threadId).at(-1)).toBe('back ');
  });

  test('an adopted thread with no sandbox mints on the next message', async () => {
    const { threads, sandboxes } = build({ script: streaming('fresh') });
    threads.adopt(ref('thread-old'));
    expect(threads.stateOf(key('thread-old'))).toBe('new');
    await threads.onMessage(inThread('thread-old', 'hello again'));
    await clock.advance(5_000);
    expect(sandboxes.liveCount).toBe(1);
    expect(discord.contentsIn('thread-old').at(-1)).toBe('fresh ');
  });

  test('a message that lands during rehydration is handled afterwards, against the rehydrated sandbox', async () => {
    const shared = new StubSandboxes({ clock, script: streaming('back') });
    const before = new Threads({
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      editCadenceMs: 1_000,
    });
    await before.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;
    expect(shared.mintCount).toBe(1);

    const after = new Threads({
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
    });
    after.adopt(ref(threadId));
    const hydrating = after.rehydrate();
    await after.onMessage(inThread(threadId, 'racing'));
    expect(after.stateOf(key(threadId))).not.toBe('minting');
    await hydrating;
    await clock.advance(5_000);
    expect(shared.mintCount).toBe(1);
    expect(shared.liveCount).toBe(1);
    expect(after.stateOf(key(threadId))).toBe('attached');
    expect(discord.contentsIn(threadId).at(-1)).toBe('back ');
  });

  test('rehydration leaves a thread that is already minting alone', async () => {
    const shared = new StubSandboxes({
      clock,
      script: streaming('x'),
      mintDelayMs: 500,
    });
    const before = new Threads({
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log: silentLog,
      config,
      editCadenceMs: 1_000,
    });
    await before.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]!.id;

    const after = new Threads({
      surfaces: [surface],
      sandboxes: shared,
      clock,
      log,
      config,
      editCadenceMs: 1_000,
    });
    after.adopt(ref(threadId));
    await after.onMessage(inThread(threadId, 'first'));
    await settle();
    expect(after.stateOf(key(threadId))).toBe('minting');
    await after.rehydrate();
    expect(after.stateOf(key(threadId))).toBe('minting');
    expect(log.of('rehydrate skipped a thread already in motion')).toHaveLength(
      1,
    );
    await clock.advance(5_000);
    expect(after.stateOf(key(threadId))).toBe('attached');
    expect(discord.contentsIn(threadId).at(-1)).toBe('x ');
  });
});

/** A second mate over the same sandboxes: what a Deployment roll leaves behind. */
function rebuild(sandboxes: StubSandboxes): Threads {
  return new Threads({
    surfaces: [surface],
    sandboxes,
    clock,
    log,
    config,
    editCadenceMs: 1_000,
    metrics,
  });
}

/** Runs a thread to the point where quiet has torn its first sandbox down. */
async function reopened(
  opts: Parameters<typeof build>[0] = {},
): Promise<ReturnType<typeof build> & { threadId: string }> {
  const built = build({ script: streaming('alpha'), ...opts });
  await built.threads.onMessage(mention('first question'));
  await clock.advance(5_000);
  const threadId = discord.threads[0]?.id ?? '';
  await built.threads.onMessage(inThread(threadId, 'second question'));
  await clock.advance(5_000);
  await clock.advance(QUIET_MS);
  return { ...built, threadId };
}

describe('replaying the transcript', () => {
  test('a fresh sandbox is handed what the thread already said, in order', async () => {
    const { threads, sandboxes, threadId } = await reopened();
    expect(sandboxes.liveCount).toBe(0);

    await threads.onMessage(inThread(threadId, 'third question'));
    await clock.advance(5_000);

    const prompt = sandboxes.prompts.at(-1) ?? '';
    expect(prompt).toContain('jawn: second question');
    expect(prompt).toContain('you: alpha');
    expect(prompt.indexOf('second question')).toBeLessThan(
      prompt.lastIndexOf('you: alpha'),
    );
    expect(prompt.endsWith('third question')).toBe(true);
    // The teardown line and the message being answered are not conversation.
    expect(prompt).not.toContain(SANDBOX_CLOSED);
    expect(prompt.match(/third question/g)).toHaveLength(1);
  });

  test('a brand new thread replays nothing', async () => {
    const { threads, sandboxes } = build({ script: streaming('alpha') });
    await threads.onMessage(mention('say hi'));
    await clock.advance(5_000);
    expect(sandboxes.prompts).toEqual(['say hi']);
  });

  test('a session the harness reloads is not replayed', async () => {
    const { threads, sandboxes } = build({
      script: streaming('alpha'),
      resumes: true,
    });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]?.id ?? '';

    const after = rebuild(sandboxes);
    await after.rehydrate();
    discord.historyCalls = 0;
    await after.onMessage(inThread(threadId, 'still there?'));
    await clock.advance(5_000);

    expect(discord.historyCalls).toBe(0);
    expect(sandboxes.prompts.at(-1)).toBe('still there?');
  });

  test('only the first turn of a session replays', async () => {
    const { threads, sandboxes, threadId } = await reopened();
    await threads.onMessage(inThread(threadId, 'third question'));
    await clock.advance(5_000);
    discord.historyCalls = 0;

    await threads.onMessage(inThread(threadId, 'fourth question'));
    await clock.advance(5_000);
    expect(discord.historyCalls).toBe(0);
    expect(sandboxes.prompts.at(-1)).toBe('fourth question');
  });

  test('a stop while the transcript is being read never reaches the harness', async () => {
    const { threads, sandboxes, threadId } = await reopened();
    let release = () => {};
    discord.gateHistory = new Promise<void>((resolve) => {
      release = resolve;
    });

    const turn = threads.onMessage(inThread(threadId, 'third question'));
    await clock.advance(1_000);
    expect(threads.stateOf(key(threadId))).toBe('turn');
    await threads.onStop(key(threadId), OWNER, async () => {});
    release();
    await turn;
    await clock.advance(5_000);

    expect(sandboxes.prompts).not.toContain('third question');
    expect(discord.contentsIn(threadId).at(-1)).toBe('*stopped*');
    expect(metrics.turns.at(-1)).toBe('cancelled');
    expect(threads.stateOf(key(threadId))).toBe('attached');
  });

  test('a history read that fails leaves the turn alone', async () => {
    const { threads, sandboxes, threadId } = await reopened();
    discord.failHistory = new Error('403 Missing Access');

    await threads.onMessage(inThread(threadId, 'third question'));
    await clock.advance(5_000);

    expect(sandboxes.prompts.at(-1)).toBe('third question');
    expect(
      log.of('transcript replay failed; the session starts empty'),
    ).toHaveLength(1);
    expect(discord.contentsIn(threadId).at(-1)).toBe('alpha ');
  });
});

describe('a mate restart', () => {
  const stuck: Script = () => [{ status: 'thinking…' }, { wait: 10_000_000 }];

  test('a thread with a turn in flight is told once, then continues', async () => {
    const { threads, sandboxes } = build({ script: stuck });
    await threads.onMessage(mention('a long job'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]?.id ?? '';
    expect(threads.stateOf(key(threadId))).toBe('turn');

    const after = rebuild(sandboxes);
    await after.rehydrate();
    expect(after.stateOf(key(threadId))).toBe('attached');
    expect(discord.contentsIn(threadId).filter((c) => c === RESTARTED)).toEqual(
      [RESTARTED],
    );

    await after.onMessage(inThread(threadId, 'again'));
    await settle();
    expect(after.stateOf(key(threadId))).toBe('turn');
    expect(discord.contentsIn(threadId).filter((c) => c === RESTARTED)).toEqual(
      [RESTARTED],
    );
  });

  test('a thread that was idle is told nothing', async () => {
    const { threads, sandboxes } = build({ script: streaming('alpha') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]?.id ?? '';

    const after = rebuild(sandboxes);
    await after.rehydrate();
    expect(discord.contentsIn(threadId)).not.toContain(RESTARTED);
    expect(after.stateOf(key(threadId))).toBe('attached');
  });

  test('a sandbox it cannot re-attach to is torn down and the thread told', async () => {
    const { threads, sandboxes } = build({ script: streaming('alpha') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]?.id ?? '';

    const after = rebuild(sandboxes);
    sandboxes.attachFails = 'the harness never answered';
    await after.rehydrate();

    expect(after.stateOf(key(threadId))).toBe('closed');
    expect(discord.contentsIn(threadId).at(-1)).toBe(SANDBOX_CLOSED);
    expect(sandboxes.liveCount).toBe(0);
    expect(metrics.teardowns).toEqual(['restart']);
  });
});

describe('metrics', () => {
  test('a turn is counted with what the harness reported', async () => {
    const { threads } = build({
      script: streaming('alpha'),
      costUsd: 0.002178,
    });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);

    expect(metrics.started).toBe(1);
    expect(metrics.turns).toEqual(['end_turn']);
    expect(metrics.samples[0]).toMatchObject({
      costUsd: 0.002178,
      firstTokenMs: 100,
    });
    expect(metrics.live).toBe(1);
  });

  test('a stop and a dead sandbox are counted by how the turn ended', async () => {
    const { threads } = build({ script: streaming('alpha') });
    await threads.onMessage(mention('go'));
    await settle();
    const threadId = discord.threads[0]?.id ?? '';
    await threads.onStop(key(threadId), OWNER, async () => {});
    await clock.advance(5_000);
    expect(metrics.turns).toEqual(['cancelled']);

    const dying = build({ script: streaming('beta') });
    await dying.threads.onMessage(mention('go'));
    await settle();
    const second = discord.threads[1]?.id ?? '';
    await dying.sandboxes.teardown({
      name: `mate-${second}`,
      thread: ref(second),
    });
    await clock.advance(5_000);
    expect(metrics.turns.at(-1)).toBe('sandbox-died');
  });

  test('a teardown carries why it happened', async () => {
    const quiet = build({ script: streaming('alpha') });
    await quiet.threads.onMessage(mention('go'));
    await clock.advance(5_000);
    await clock.advance(QUIET_MS);
    expect(metrics.teardowns).toEqual(['quiet']);

    const archived = build({ script: streaming('alpha') });
    await archived.threads.onMessage(mention('go'));
    await clock.advance(5_000);
    await archived.threads.onThreadArchived(ref(discord.threads[1]?.id ?? ''));
    expect(metrics.teardowns.at(-1)).toBe('archived');

    const deleted = build({ script: streaming('alpha') });
    await deleted.threads.onMessage(mention('go'));
    await clock.advance(5_000);
    await deleted.threads.onThreadDeleted(ref(discord.threads[2]?.id ?? ''));
    expect(metrics.teardowns.at(-1)).toBe('thread-deleted');
  });

  test('a sandbox a thread never got is counted by how far it got', async () => {
    const minting = build({ mintFails: 'ImagePullBackOff' });
    await minting.threads.onMessage(mention('go'));
    await settle();
    // The teardown that follows a failed mint has no sandbox to tear down and
    // records nothing, so this counter is the only thing that sees it.
    expect(metrics.mints).toEqual(['mint-failed']);
    expect(metrics.teardowns).toEqual([]);
    expect(metrics.mintSamples).toEqual([]);

    const attaching = build({
      attachFails: 'the harness never answered',
      mintDelayMs: 9_000,
    });
    await attaching.threads.onMessage(mention('go'));
    await clock.advance(9_000);
    await settle();
    expect(metrics.mints.at(-1)).toBe('attach-failed');
    // The mint behind a failed attach is a finished mint, so it is still one
    // of the readings this histogram is for.
    expect(metrics.mintSamples.at(-1)).toEqual({
      source: 'fresh',
      mintMs: 9_000,
    });

    const working = build({ script: streaming('alpha') });
    await working.threads.onMessage(mention('go'));
    await clock.advance(5_000);
    expect(metrics.mints.at(-1)).toBe('ok');
  });

  test('the wait for a sandbox is timed in two parts', async () => {
    const { threads } = build({
      script: streaming('alpha'),
      mintDelayMs: 40_000,
      attachDelayMs: 2_000,
    });
    await threads.onMessage(mention('go'));
    await clock.advance(60_000);

    expect(metrics.mintSamples).toEqual([
      { source: 'fresh', mintMs: 40_000, attachMs: 2_000 },
    ]);
  });

  test('the live and queued gauges follow the table', async () => {
    const { threads } = build({
      script: streaming('alpha'),
      config: { maxConcurrent: 1 },
    });
    await threads.onMessage(mention('one'));
    await threads.onMessage(mention('two'));
    await clock.advance(5_000);
    expect(metrics.live).toBe(1);
    expect(metrics.queued).toBe(1);

    // The head of the queue takes the slot the moment it frees.
    await threads.onThreadArchived(ref(discord.threads[0]?.id ?? ''));
    await clock.advance(5_000);
    expect(metrics.queued).toBe(0);
    expect(metrics.live).toBe(1);
  });
});

describe('the log', () => {
  test('every transition names the thread, its state, its sandbox and its turns', async () => {
    const { threads } = build({ script: streaming('alpha') });
    await threads.onMessage(mention('go'));
    await clock.advance(5_000);
    const threadId = discord.threads[0]?.id ?? '';
    const states = () => log.of('thread state').map((e) => e.fields?.state);
    expect(states()).toEqual(['minting', 'attached', 'turn', 'attached']);
    expect(
      log.of('thread state').every((e) => e.fields?.surface === 'discord'),
    ).toBe(true);
    expect(
      log.of('thread state').find((e) => e.fields?.state === 'turn')?.fields,
    ).toMatchObject({
      threadId,
      sandbox: `mate-${threadId}`,
      turns: 1,
    });

    await clock.advance(QUIET_MS);
    expect(states().slice(-2)).toEqual(['tearing-down', 'closed']);
  });
});
