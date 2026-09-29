import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SANDBOX_CARD_ID } from '../src/lease.ts';
import { silentLog } from '../src/log.ts';
import {
  CONNECTING,
  MINT_STEPS,
  SANDBOX_READY,
  UNDELIVERED,
} from '../src/notices.ts';
import { NO_REPLY, Reply } from '../src/reply.ts';
import { type Script, StubBrain } from '../src/sandbox.ts';
import {
  DETAILS_MAX,
  decodeSlack,
  escapeSlack,
  PLAN_ROWS,
  PROCESSING_RENEW_MS,
  type SlackBlock,
  SlackCanvas,
  SlackError,
  slackEvent,
  slackInbound,
  slackSessionStopped,
  slackSurface,
  slackWeb,
  TITLE_CADENCE_MS,
} from '../src/slack.ts';
import { SocketMode } from '../src/socket.ts';
import { MemoryThreadStore } from '../src/store.ts';
import type { Inbound, ThreadRef, ToolCall } from '../src/surface.ts';
import { Threads } from '../src/threads.ts';
import { replayPreamble } from '../src/transcript.ts';
import { FakeSlack, FakeSocket } from './fakesurface.ts';
import {
  FakeClock,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const ME = 'U06267D79UH';
const BOT = 'B061D291YCF';
const OWNER = 'UAR78LSKC';
const STRANGER = 'U0NOPE';
const TEAM = 'TAR78LS82';
const CHANNEL = 'C062BS4GADR';
const TS = '1758300000.000100';
const THREAD: ThreadRef = { surface: 'slack', channelId: CHANNEL, id: TS };
const KEY = `slack:${CHANNEL}:${TS}`;
const QUIET_MS = 15 * 60_000;

let api: FakeSlack;
let log: RecordingLog;
let clock: FakeClock;

beforeEach(() => {
  api = new FakeSlack();
  log = new RecordingLog();
  clock = new FakeClock();
});

const canvas = (cap?: number) =>
  new SlackCanvas(
    api,
    log,
    clock,
    THREAD,
    { userId: OWNER, teamId: TEAM },
    cap,
  );

/** What Slack answers once it has ended the stream itself. */
const ended = (code: string) => new SlackError('chat.appendStream', code);

describe('reading a message off the socket', () => {
  test('a mention in a channel is a message with the mention escape in its text', () => {
    const inbound = slackInbound(
      {
        type: 'message',
        channel: CHANNEL,
        ts: TS,
        user: OWNER,
        text: `<@${ME}> hello`,
      },
      ME,
    );
    expect(inbound).toEqual({
      surface: 'slack',
      id: TS,
      channelId: CHANNEL,
      threadId: null,
      authorId: OWNER,
      authorIsBot: false,
      content: `<@${ME}> hello`,
      mentionsMe: true,
    });
  });

  test('a reply names the thread it continues', () => {
    const inbound = slackInbound(
      {
        type: 'message',
        channel: CHANNEL,
        ts: '1758300100.000200',
        thread_ts: TS,
        user: OWNER,
        text: 'more',
      },
      ME,
    );
    expect(inbound?.threadId).toBe(TS);
    expect(inbound?.mentionsMe).toBe(false);
  });

  test('a reply the human also sent to the channel is still a reply', () => {
    const inbound = slackInbound(
      {
        type: 'message',
        subtype: 'thread_broadcast',
        channel: CHANNEL,
        ts: '1758300100.000300',
        thread_ts: TS,
        user: OWNER,
        text: 'and everyone should see this',
      },
      ME,
    );
    expect(inbound?.threadId).toBe(TS);
  });

  test("mate's own post comes back with a bot id and no subtype, and is marked a bot", () => {
    const inbound = slackInbound(
      {
        type: 'message',
        channel: CHANNEL,
        ts: TS,
        user: ME,
        bot_id: 'B061D291YCF',
        text: 'an answer',
      },
      ME,
    );
    expect(inbound?.authorIsBot).toBe(true);
  });

  test('one human sentence is one message, whatever else the app subscribes to', () => {
    // An app_mention repeats a message under its own event id, so only the
    // type check keeps one sentence from being answered twice.
    expect(
      slackInbound(
        {
          type: 'app_mention',
          channel: CHANNEL,
          ts: TS,
          user: OWNER,
          text: `<@${ME}> hello`,
        },
        ME,
      ),
    ).toBeNull();
    expect(
      slackInbound(
        { type: 'reaction_added', channel: CHANNEL, ts: TS, user: OWNER },
        ME,
      ),
    ).toBeNull();
    expect(
      slackInbound({ channel: CHANNEL, ts: TS, text: 'x' }, ME),
    ).toBeNull();
  });

  test('an edit, a delete and a join are not messages to answer', () => {
    expect(
      slackInbound(
        {
          type: 'message',
          channel: CHANNEL,
          ts: TS,
          subtype: 'message_changed',
          hidden: true,
        },
        ME,
      ),
    ).toBeNull();
    expect(
      slackInbound(
        { type: 'message', channel: CHANNEL, ts: TS, hidden: true },
        ME,
      ),
    ).toBeNull();
    expect(
      slackInbound(
        {
          type: 'message',
          channel: CHANNEL,
          ts: TS,
          subtype: 'channel_join',
          user: OWNER,
        },
        ME,
      ),
    ).toBeNull();
    expect(
      slackInbound({ type: 'message', ts: TS, user: OWNER, text: 'x' }, ME),
    ).toBeNull();
  });

  test('control characters are decoded for the harness, but not into a mention', () => {
    const inbound = slackInbound(
      {
        type: 'message',
        channel: CHANNEL,
        ts: TS,
        user: OWNER,
        text: `a &lt;div&gt; &amp; &lt;@${ME}&gt;`,
      },
      ME,
    );
    expect(inbound?.content).toBe(`a <div> & <@${ME}>`);
    expect(inbound?.mentionsMe).toBe(false);
  });

  test('escaping is the other direction of the same rule', () => {
    expect(escapeSlack('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    expect(decodeSlack(escapeSlack('a <b> & c'))).toBe('a <b> & c');
  });
});

describe("Slack's own stop", () => {
  test('names the thread it stops and the human who pressed it', () => {
    expect(
      slackSessionStopped({
        type: 'agent_session_stopped',
        channel: CHANNEL,
        thread_ts: TS,
        user: OWNER,
      }),
    ).toEqual({ key: KEY, userId: OWNER });
  });

  test('a stop naming no thread, and any other event, is not a stop', () => {
    expect(
      slackSessionStopped({ type: 'agent_session_stopped', channel: CHANNEL }),
    ).toBeNull();
    expect(
      slackSessionStopped({ type: 'message', channel: CHANNEL, ts: TS }),
    ).toBeNull();
  });

  test('an event is either the stop or a message, never both and never neither', () => {
    const stopped: unknown[] = [];
    const messages: Inbound[] = [];
    const on = {
      stopped: (stop: unknown) => stopped.push(stop),
      message: (inbound: Inbound) => messages.push(inbound),
    };
    slackEvent(
      {
        type: 'agent_session_stopped',
        channel: CHANNEL,
        thread_ts: TS,
        user: OWNER,
      },
      ME,
      on,
    );
    slackEvent(
      { type: 'message', channel: CHANNEL, ts: TS, user: OWNER, text: 'hi' },
      ME,
      on,
    );
    slackEvent({ type: 'reaction_added', channel: CHANNEL, ts: TS }, ME, on);
    expect(stopped).toEqual([{ key: KEY, userId: OWNER }]);
    expect(messages.map((m) => m.content)).toEqual(['hi']);
  });
});

describe('streaming a turn', () => {
  test('the first frame starts an addressed stream and nothing beside it', async () => {
    const painter = canvas();
    await painter.live('hello ', 'reading files');
    expect(api.calls).toEqual([
      {
        call: 'start',
        ts: 's-1',
        args: {
          channel: CHANNEL,
          threadTs: TS,
          userId: OWNER,
          teamId: TEAM,
          chunks: [{ type: 'markdown_text', text: 'hello ' }],
        },
      },
    ]);
    // A channel thread has no free-text status, so the status line is not sent.
    expect(JSON.stringify(api.calls)).not.toContain('reading files');
  });

  test('later frames append only what is new', async () => {
    const painter = canvas();
    await painter.live('one ', 'thinking');
    await painter.live('one two ', 'thinking');
    await painter.live('one two three ', 'thinking');
    expect(api.only('start')).toHaveLength(1);
    expect(api.only('append').map((c) => c.chunks)).toEqual([
      [{ type: 'markdown_text', text: 'two ' }],
      [{ type: 'markdown_text', text: 'three ' }],
    ]);
    expect(api.streamed()).toBe('one two three ');
  });

  test('a turn posts no message of its own beside the answer', async () => {
    const painter = canvas();
    await painter.live('a', 'thinking');
    await painter.live('ab', 'running `mise run docs:check`');
    await painter.tool({ id: 't1', title: 'read files', state: 'complete' });
    await painter.final('ab', 'done');
    expect(api.only('post')).toEqual([]);
  });

  test('the last frame stops the stream', async () => {
    const painter = canvas();
    await painter.live('hello ', 'thinking');
    await painter.final('hello there', 'done');
    expect(api.streamed()).toBe('hello there');
    expect(api.only('stop')).toHaveLength(1);
  });

  test('a turn with nothing to show says so; a failed one leaves its own line to speak', async () => {
    const quiet = canvas();
    await quiet.final('', 'done');
    expect(api.only('post').map((c) => c.text)).toEqual([NO_REPLY]);

    api.calls.length = 0;
    const failed = canvas();
    await failed.final('', 'failed');
    expect(api.only('post')).toEqual([]);
    expect(api.only('start')).toEqual([]);
  });

  test('a turn that only ran tools still says it answered nothing', async () => {
    const painter = canvas();
    await painter.tool({ id: 't1', title: 'read files', state: 'complete' });
    await painter.final('', 'done');
    // A card is not an answer, so the no-reply line streams into the same message.
    expect(api.streamed()).toBe(NO_REPLY);
    expect(api.only('post')).toEqual([]);
    expect(api.only('stop')).toHaveLength(1);
  });

  test('an answer past the cap rolls into a new stream, and no call exceeds it', async () => {
    const painter = canvas(40);
    const text = `${'lorem ipsum '.repeat(10).trim()}\n`.repeat(3);
    await painter.live(text, null);
    await painter.final(text, 'done');
    const written = api
      .chunks()
      .flatMap((chunk) => (chunk.type === 'markdown_text' ? [chunk.text] : []));
    expect(written.length).toBeGreaterThan(1);
    for (const body of written) {
      expect(body.length).toBeLessThanOrEqual(40);
    }
    expect(api.streamed()).toBe(text);
    expect(api.only('start').length).toBeGreaterThan(1);
  });

  test('a last call that fails still ends the stream and settles the thread', async () => {
    const painter = canvas();
    await painter.live('a', 'thinking');
    api.failAppend = new Error('streaming_state_conflict');
    await expect(painter.final('ab', 'done')).rejects.toThrow(
      'streaming_state_conflict',
    );
    // A message left streaming refuses every later edit, so the stop goes
    // out whatever the frame before it did.
    expect(api.only('stop')).toHaveLength(1);
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('a stream that cannot be stopped is one warning, not a failed turn', async () => {
    const painter = canvas();
    await painter.live('a', null);
    api.failStopStream = new Error('streaming_state_conflict');
    await painter.final('a', 'done');
    expect(log.of('the stream could not be stopped')).toHaveLength(1);
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('what the model says cannot mention anyone, across frames', async () => {
    const painter = canvas();
    // A trailing `<` is held until the next frame, so it is escaped with its `@`.
    await painter.live('ping <', null);
    expect(api.streamed()).toBe('ping ');
    await painter.live(`ping <@${OWNER}> and <!channel> and <#C0X>`, null);
    await painter.final(`ping <@${OWNER}> and <!channel> and <#C0X>`, 'done');
    expect(api.streamed()).toBe(
      `ping &lt;@${OWNER}> and &lt;!channel> and &lt;#C0X>`,
    );
  });

  test('a trailing bracket that never becomes a mention is still delivered', async () => {
    const painter = canvas();
    await painter.live('a <', null);
    await painter.final('a <', 'done');
    expect(api.streamed()).toBe('a <');
  });
});

describe('the plan', () => {
  const running = (id: string, title: string): ToolCall => ({
    id,
    title,
    state: 'in_progress',
  });
  const finished = (id: string, title: string): ToolCall => ({
    id,
    title,
    state: 'complete',
  });
  const broke = (id: string, title: string): ToolCall => ({
    id,
    title,
    state: 'error',
  });

  test('a tool call before any text opens the stream with a titled plan', async () => {
    const painter = canvas();
    await painter.tool(running('call-1', 'read files'));
    // An untitled plan stopped over an open task reads "Something went wrong".
    expect(api.only('start')[0]?.args.chunks).toEqual([
      { type: 'plan_update', title: 'read files…' },
      {
        type: 'task_update',
        id: 'phase-1',
        title: 'read files',
        status: 'in_progress',
      },
    ]);
    expect(api.streamed()).toBe('');
  });

  test('a plan in a stream the answer opened is titled with its first task', async () => {
    const painter = canvas();
    await painter.live('On it. ', null);
    await painter.step('Let me look first.');
    expect(api.only('append')[0]?.chunks).toEqual([
      { type: 'plan_update', title: 'Working · 1 step…' },
      {
        type: 'task_update',
        id: 'phase-1',
        title: 'Let me look first.',
        status: 'in_progress',
      },
    ]);
  });

  test('narration opens a phase titled with the sentence, and the calls after it are its details', async () => {
    const painter = canvas();
    await painter.step(
      'Before I make a change,\nlet me confirm the tooling can push.',
    );
    await painter.tool(running('c1', '$ git status'));
    await painter.tool(finished('c1', '$ git status'));
    await painter.tool(running('c2', 'read src/slack.ts'));
    await painter.tool(broke('c2', 'read src/slack.ts'));
    await painter.step('x'.repeat(400));
    await painter.tool(running('c3', '$ bun test'));
    await painter.tool(finished('c3', '$ bun test'));
    await painter.final('No token here.', 'done');
    // A failed call is a mark in the row, not a failed row.
    expect(api.plan().rows).toEqual([
      {
        id: 'phase-1',
        title: 'Before I make a change, let me confirm the tooling can push.',
        status: 'complete',
        details: '✓ $ git status\n✗ read src/slack.ts',
      },
      {
        id: 'phase-2',
        title: `${'x'.repeat(119)}…`,
        status: 'complete',
        details: '✓ $ bun test',
      },
    ]);
    expect(api.streamed()).toBe('No token here.');
  });

  test('calls before any narration open a phase titled from the first of them', async () => {
    const painter = canvas();
    await painter.tool(finished('c1', '$ git status'));
    await painter.tool(finished('c2', '$ git log'));
    await painter.step('Now the tests.');
    await painter.tool(finished('c3', '$ bun test'));
    await painter.final('ok', 'done');
    expect(api.plan().rows).toEqual([
      {
        id: 'phase-1',
        title: '$ git status',
        status: 'complete',
        details: '✓ $ git status\n✓ $ git log',
      },
      {
        id: 'phase-2',
        title: 'Now the tests.',
        status: 'complete',
        details: '✓ $ bun test',
      },
    ]);
  });

  test('a row runs while it is the current phase or a call under it does', async () => {
    const painter = canvas();
    const statuses = () => api.plan().rows.map((row) => row.status);
    await painter.step('One.');
    await painter.tool(running('c1', '$ sleep 60'));
    await painter.step('Two.');
    expect(statuses()).toEqual(['in_progress', 'in_progress']);
    await painter.tool(finished('c1', '$ sleep 60'));
    expect(statuses()).toEqual(['complete', 'in_progress']);
    // The call lands in the phase it started in.
    expect(api.plan().rows[0]?.details).toBe('✓ $ sleep 60');
    await painter.step('Three.');
    expect(statuses()).toEqual(['complete', 'complete', 'in_progress']);
  });

  test('a row lists its calls within the details cap, and counts the rest', async () => {
    const painter = canvas();
    await painter.step('Many commands.');
    for (let i = 1; i <= 30; i += 1) {
      await painter.tool(finished(`c${i}`, `$ echo ${'y'.repeat(40)} ${i}`));
    }
    await painter.step('Next.');
    await painter.final('ok', 'done');
    const lines = api.plan().rows[0]?.details.split('\n') ?? [];
    const listed = lines.length - 1;
    // Slack appends details, so the earliest lines stay and the rest are counted.
    expect(listed).toBeGreaterThan(5);
    expect(lines.slice(0, listed)).toEqual(
      Array.from(
        { length: listed },
        (_, i) => `✓ $ echo ${'y'.repeat(40)} ${i + 1}`,
      ),
    );
    expect(lines.at(-1)).toBe(`…${30 - listed} more`);
    expect(api.plan().rows[0]?.details.length).toBeLessThanOrEqual(DETAILS_MAX);
  });

  test('the sandbox is listed like a call, and not counted as one', async () => {
    const painter = canvas();
    await painter.tool(running('c1', '$ git status'));
    await painter.tool(running(SANDBOX_CARD_ID, MINT_STEPS.reusing));
    await painter.tool(running(SANDBOX_CARD_ID, CONNECTING));
    await painter.tool(finished(SANDBOX_CARD_ID, SANDBOX_READY));
    await painter.tool(finished('c1', '$ git status'));
    await painter.final('ok', 'done');
    expect(api.plan()).toEqual({
      title: 'Ran 1 command in 1 step · 0s',
      rows: [
        {
          id: 'phase-1',
          title: '$ git status',
          status: 'complete',
          details: `✓ ${SANDBOX_READY}\n✓ $ git status`,
        },
      ],
    });
  });

  test('the running title changes at most once a cadence, and the latest one lands', async () => {
    const painter = canvas();
    await painter.tool(running('c1', '$ git status'));
    await painter.tool(finished('c1', '$ git status'));
    await clock.advance(1_000);
    await painter.tool(running(SANDBOX_CARD_ID, MINT_STEPS.booting));
    expect(api.titles()).toEqual(['$ git status…']);
    await clock.advance(TITLE_CADENCE_MS - 1_001);
    expect(api.titles()).toEqual(['$ git status…']);
    // The newest call running is the one a human waits on.
    await clock.advance(1);
    expect(api.titles()).toEqual(['$ git status…', `${MINT_STEPS.booting}…`]);
    await painter.tool(finished(SANDBOX_CARD_ID, SANDBOX_READY));
    await clock.advance(TITLE_CADENCE_MS);
    expect(api.titles().at(-1)).toBe('Working · 1 command in 1 step…');
    await painter.tool(running('c2', '$ bun test'));
    await painter.final('ok', 'done');
    expect(api.titles().at(-1)).toBe('Ran 2 commands in 1 step · 6s');
    expect(clock.pendingTimers).toBe(0);
  });

  const endings = [
    {
      outcome: 'done',
      title: 'Ran 2 commands in 2 steps · 42s',
      statuses: ['complete', 'complete'],
      last: '✓ $ bun test',
    },
    {
      outcome: 'stopped',
      title: '⏹️ Stopped · 2 commands in 2 steps · 42s',
      statuses: ['complete', 'error'],
      last: '✗ $ bun test',
    },
    {
      outcome: 'failed',
      title: '⚠️ Failed · 2 commands in 2 steps · 42s',
      statuses: ['error', 'error'],
      last: '✗ $ bun test',
    },
  ] as const;
  for (const ending of endings) {
    test(`a ${ending.outcome} turn closes every row and titles the plan in the stop itself`, async () => {
      const painter = canvas();
      await painter.step('Looking first.');
      await painter.tool(broke('c1', '$ git push'));
      await painter.step('Now the tests.');
      await painter.tool(running('c2', '$ bun test'));
      await clock.advance(42_000);
      await painter.final('answer', ending.outcome);
      const [stop] = api.only('stop');
      expect(stop?.chunks.at(-1)).toEqual({
        type: 'plan_update',
        title: ending.title,
      });
      // Nothing follows the stop, so the plan is left as the stop leaves it.
      expect(api.calls.at(-1)).toMatchObject({ call: 'session' });
      const { title, rows } = api.plan();
      expect(title).toBe(ending.title);
      expect(rows.map((row) => row.status)).toEqual([...ending.statuses]);
      expect(rows[1]?.details).toBe(ending.last);
    });
  }

  test('a turn that only narrated counts its steps', async () => {
    const painter = canvas();
    await painter.step('Thinking out loud.');
    await clock.advance(5_000);
    await painter.final('ok', 'done');
    expect(api.plan().title).toBe('1 step · 5s');
  });

  test('a turn with no tool work has no plan', async () => {
    const painter = canvas();
    await painter.live('hello ', 'thinking');
    await painter.final('hello there', 'done');
    expect(
      api.chunks().filter((chunk) => chunk.type !== 'markdown_text'),
    ).toEqual([]);
    expect(api.only('stop')).toEqual([{ call: 'stop', ts: 's-1', chunks: [] }]);
  });

  test("a stream the human's stop already ended keeps the title it had", async () => {
    const painter = canvas();
    await painter.tool(running('c1', '$ bun test'));
    api.failAppend = ended('stopped_by_user');
    await painter.final('partial', 'stopped');
    // Slack refuses every later frame, so the title sent first is the one it keeps.
    expect(api.only('stop')).toEqual([]);
    expect(api.plan().title).toBe('$ bun test…');
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('a rolled answer leaves its plan closed and titled, and a later call opens another', async () => {
    const painter = canvas(40);
    const text = `${'a'.repeat(30)}\n${'b'.repeat(29)}`;
    await painter.step('Looking.');
    await painter.tool(running('c1', '$ ls'));
    await painter.live(text, null);
    expect(api.only('stop')[0]?.chunks).toEqual([
      {
        type: 'task_update',
        id: 'phase-1',
        title: 'Looking.',
        status: 'complete',
      },
      { type: 'plan_update', title: 'Ran 1 command in 1 step · 0s' },
    ]);
    await painter.tool(finished('c1', '$ ls'));
    const opened = api.only('append').at(-1);
    expect(opened?.ts).toBe('s-2');
    expect(opened?.chunks[0]).toEqual({
      type: 'plan_update',
      title: 'Working · 1 command in 2 steps…',
    });
    await painter.final(text, 'done');
    expect(api.plan(1)).toEqual({
      title: 'Ran 1 command in 2 steps · 0s',
      rows: [
        {
          id: 'phase-1',
          title: '$ ls',
          status: 'complete',
          details: '✓ $ ls',
        },
      ],
    });
    expect(api.streamed()).toBe(text);
  });

  test('phases past the plan cap fold into its last row', async () => {
    const painter = canvas();
    for (let i = 1; i <= 60; i += 1) {
      await painter.step(`Step ${i}.`);
      await painter.tool(finished(`c${i}`, `$ echo ${i}`));
    }
    await painter.final('ok', 'done');
    const { title, rows } = api.plan();
    // Slack keeps a plan's first 50 tasks and silently drops the rest.
    expect(rows).toHaveLength(PLAN_ROWS);
    expect(rows.at(-1)).toMatchObject({
      id: `phase-${PLAN_ROWS}`,
      title: 'Step 60.',
      status: 'complete',
    });
    expect(rows.at(-1)?.details.split('\n')).toEqual(
      Array.from(
        { length: 60 - PLAN_ROWS + 1 },
        (_, i) => `✓ $ echo ${PLAN_ROWS + i}`,
      ),
    );
    expect(title).toBe('Ran 60 commands in 60 steps · 0s');
  });

  test('nothing in a plan can ping a human, however the model writes it', async () => {
    const painter = canvas();
    await painter.step(`Asking <@${OWNER}> first.`);
    await painter.tool(running('c1', 'echo <!channel> <#C0X>'));
    await painter.final('', 'stopped');
    const planned = api
      .chunks()
      .filter((chunk) => chunk.type !== 'markdown_text');
    expect(JSON.stringify(planned)).not.toMatch(/<[@!#]/);
    expect(api.plan().rows).toEqual([
      {
        id: 'phase-1',
        title: `Asking &lt;@${OWNER}> first.`,
        status: 'error',
        details: '✗ echo &lt;!channel> &lt;#C0X>',
      },
    ]);
  });
});

describe('the agent session', () => {
  test('the working sign is the session, and the end of the turn settles it', async () => {
    const painter = canvas();
    await painter.working();
    await painter.live('a', null);
    await painter.final('a', 'done');
    expect(api.only('session')).toEqual([
      { call: 'session', threadTs: TS, status: 'processing' },
      { call: 'session', threadTs: TS, status: 'active' },
    ]);
  });

  test('a session that cannot be settled is one warning, not a failed turn', async () => {
    const painter = canvas();
    await painter.live('a', null);
    api.failSession = new Error('invalid_arguments');
    await painter.final('a', 'done');
    expect(log.of('the agent session could not be settled')).toHaveLength(1);
    expect(api.only('stop')).toHaveLength(1);
  });
});

describe('a stream Slack has already ended', () => {
  for (const code of ['stopped_by_user', 'message_not_in_streaming_state']) {
    test(`${code} on the last frame ends the turn, it does not fail it`, async () => {
      const painter = canvas();
      await painter.live('partial ', null);
      api.failAppend = ended(code);
      await painter.final('partial ', 'stopped');
      expect(api.streamed()).toBe('partial ');
      expect(api.only('start')).toHaveLength(1);
      expect(api.only('post')).toEqual([]);
      expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
      // Logged, since a human's stop is not the only reason Slack ends a stream.
      expect(log.of('the stream was already over')).not.toEqual([]);
      expect(api.only('session').at(-1)?.status).toBe('active');
    });

    test(`${code} opening the stream leaves the thread settled and quiet`, async () => {
      const painter = canvas();
      api.failStart = ended(code);
      await painter.final('gone', 'stopped');
      expect(api.only('start')).toEqual([]);
      expect(api.only('post')).toEqual([]);
      expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
      expect(api.only('session').at(-1)?.status).toBe('active');
    });
  }

  test('a stream Slack ended needs no stopping, and says nothing about it', async () => {
    const painter = canvas();
    await painter.live('a', null);
    api.failStopStream = ended('message_not_in_streaming_state');
    await painter.final('a', 'stopped');
    expect(log.of('the stream could not be stopped')).toEqual([]);
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('a refusal that is not the turn being over is still a failure', async () => {
    const painter = canvas();
    await painter.live('a', null);
    api.failAppend = new SlackError('chat.appendStream', 'ratelimited');
    await expect(painter.final('ab', 'done')).rejects.toThrow(
      'chat.appendStream: ratelimited',
    );
  });
});

describe('the renderer against Slack', () => {
  test('coalesces to one append per cadence and ends with the stream stopped', async () => {
    const reply = new Reply(canvas(), clock, silentLog, TS, 1_000, 3_000);
    reply.update({ kind: 'status', line: 'thinking' });
    await clock.advance(0);
    // Held as a step until the run outlives the grace, then streamed.
    reply.update({ kind: 'text', delta: 'a' });
    await clock.advance(3_000);
    expect(api.streamed()).toBe('');
    reply.update({ kind: 'text', delta: 'b' });
    await clock.advance(1_000);
    expect(api.streamed()).toBe('ab');
    expect(api.only('start')).toHaveLength(1);
    await reply.finish('done');
    expect(api.only('stop')).toHaveLength(1);
    expect(api.only('post')).toEqual([]);
  });

  test('a stopped turn ends with the mark, streamed like any other text', async () => {
    const reply = new Reply(canvas(), clock, silentLog, TS, 1_000);
    reply.update({ kind: 'text', delta: 'partial ' });
    await clock.advance(0);
    await reply.finish('stopped');
    expect(api.streamed()).toBe('partial \n\n*stopped*');
  });

  test('a turn that outlives the hour keeps saying it is working', async () => {
    const reply = new Reply(canvas(), clock, silentLog, TS, 1_000);
    reply.startWorking();
    await clock.advance(0);
    reply.update({ kind: 'text', delta: 'thinking hard' });
    await clock.advance(1_000);
    // Slack expires `processing` an hour after it is set.
    expect(
      api.only('session').filter((c) => c.status === 'processing'),
    ).toEqual([{ call: 'session', threadTs: TS, status: 'processing' }]);
    await clock.advance(PROCESSING_RENEW_MS * 2);
    expect(
      api.only('session').filter((c) => c.status === 'processing'),
    ).toHaveLength(3);

    await reply.finish('done');
    const after = api.only('session').length;
    // A renewal after the turn would mark a settled thread working again.
    await clock.advance(PROCESSING_RENEW_MS * 3);
    expect(api.only('session')).toHaveLength(after);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('the surface', () => {
  const surface = () =>
    slackSurface({
      api,
      me: ME,
      appBotId: BOT,
      teamId: TEAM,
      allowedUserIds: new Set([OWNER]),
      allowedChannelIds: new Set([CHANNEL]),
      log,
      clock,
    });

  test('a thread needs no call to open: its parent message is the thread', async () => {
    const opened = await surface().openThread(
      {
        surface: 'slack',
        id: TS,
        channelId: CHANNEL,
        threadId: null,
        authorId: OWNER,
        authorIsBot: false,
        content: 'hi',
        mentionsMe: true,
      },
      'hi',
    );
    expect(opened).toEqual(THREAD);
    expect(api.calls).toEqual([]);
  });

  test('a mention inside a thread that already exists adopts it', async () => {
    const opened = await surface().openThread(
      {
        surface: 'slack',
        id: '1758300100.000200',
        channelId: CHANNEL,
        threadId: TS,
        authorId: OWNER,
        authorIsBot: false,
        content: 'hi',
        mentionsMe: true,
      },
      'hi',
    );
    expect(opened.id).toBe(TS);
  });

  test('a notice is escaped before it is posted', async () => {
    await surface().post(THREAD, 'the harness failed: <nil> & gone');
    expect(api.only('post')[0]).toMatchObject({
      threadTs: TS,
      text: 'the harness failed: &lt;nil&gt; &amp; gone',
    });
  });

  test('history comes back newest first, named, decoded, and pages backwards', async () => {
    api.names.set(OWNER, 'jawn');
    api.thread.push(
      { ts: '1.000001', user: OWNER, text: 'first &amp; oldest' },
      { ts: '2.000002', user: ME, bot_id: BOT, text: 'an answer' },
      { ts: '3.000003', user: OWNER, text: 'newest' },
    );
    const page = await surface().history(THREAD, { limit: 10 });
    expect(page.map((m) => m.content)).toEqual([
      'newest',
      'an answer',
      'first & oldest',
    ]);
    expect(page[0]).toMatchObject({ authorId: OWNER, authorName: 'jawn' });
    expect(page[1]?.authorIsBot).toBe(true);

    const older = await surface().history(THREAD, {
      limit: 10,
      before: '2.000002',
    });
    expect(older.map((m) => m.content)).toEqual(['first & oldest']);
  });

  test('teardown closes the thread’s agent session', async () => {
    // Slack never closes an agent session on its own.
    await surface().archive?.(THREAD);
    expect(api.only('session')).toEqual([
      { call: 'session', threadTs: TS, status: 'closed' },
    ]);
  });

  test('an idle thread puts its agent session back to ready', async () => {
    await surface().settle?.(THREAD);
    expect(api.only('session')).toEqual([
      { call: 'session', threadTs: TS, status: 'active' },
    ]);
  });

  test("mate's own words are read from the blocks, not the text Slack folds its plan into", async () => {
    const plan = {
      type: 'plan',
      title: 'Ran 2 commands in 1 step · 4s',
      tasks: [{ task_id: 'phase-1', title: 'Looking.', status: 'complete' }],
    } as SlackBlock;
    const card = (id: string, title: string) =>
      ({
        type: 'task_card',
        task_id: id,
        title,
        status: 'complete',
      }) as SlackBlock;
    api.thread.push(
      {
        ts: '1.000001',
        bot_id: BOT,
        text: 'Ran 2 commands in 1 step · 4s Here is the *fix* for <@U1>:\n• one',
        blocks: [
          plan,
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [
                  { type: 'text', text: 'Here is the ' },
                  { type: 'text', text: 'fix', style: { bold: true } },
                  { type: 'text', text: ' for ' },
                  { type: 'user', user_id: OWNER },
                  { type: 'text', text: ':\n' },
                ],
              },
              {
                type: 'rich_text_list',
                style: 'bullet',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'text', text: 'one' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        ts: '2.000002',
        bot_id: BOT,
        text: 'Let me look. $ git status Done &amp; dusted.',
        blocks: [
          card('say-1', 'Let me look.'),
          card('toolu_01', '$ git status'),
          {
            type: 'rich_text',
            elements: [
              {
                type: 'rich_text_section',
                elements: [{ type: 'text', text: 'Done & dusted.' }],
              },
            ],
          },
        ],
      },
      { ts: '3.000003', bot_id: BOT, text: 'a plain &lt;line&gt;' },
      {
        ts: '4.000004',
        user: OWNER,
        text: `thanks &lt;3 <@${ME}>`,
        blocks: [{ type: 'rich_text', elements: [] }],
      },
    );
    const page = await surface().history(THREAD, { limit: 10 });
    expect(page.map((m) => m.content)).toEqual([
      `thanks <3 <@${ME}>`,
      'a plain <line>',
      'Done & dusted.',
      `Here is the **fix** for <@${OWNER}>:\n- one\n`,
    ]);
  });

  test('the replay hands a fresh session the answers, never a plan title', async () => {
    api.names.set(OWNER, 'jawn');
    const plan = (title: string) => ({ type: 'plan', title }) as SlackBlock;
    const said = (text: string, style?: object): SlackBlock => ({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text, style }],
        },
      ],
    });
    const failed = '⚠️ Failed · 1 command in 1 step · 3s';
    const ran = 'Ran 1 command in 1 step · 2s';
    api.thread.push(
      { ts: '1.000001', user: OWNER, text: 'fix it' },
      { ts: '2.000002', bot_id: BOT, text: failed, blocks: [plan(failed)] },
      { ts: '3.000003', user: OWNER, text: 'again' },
      {
        ts: '4.000004',
        bot_id: BOT,
        text: `${ran} Fixed.`,
        blocks: [plan(ran), said('Fixed.')],
      },
      {
        ts: '5.000005',
        bot_id: BOT,
        text: `${ran} _stopped_`,
        blocks: [plan(ran), said('stopped', { italic: true })],
      },
    );
    const preamble = await replayPreamble(surface(), THREAD, {
      me: ME,
      skip: [],
    });
    // A plan alone is no answer, and the stop mark is still a notice.
    expect(preamble).toContain(
      '\n\njawn: fix it\njawn: again\nyou: Fixed.\n\n',
    );
    expect(preamble).not.toContain('Ran ');
    expect(preamble).not.toContain('stopped');
  });

  test("mate's own answer is mate's, whether or not Slack put a user on it", async () => {
    api.thread.push(
      { ts: '1.000001', bot_id: BOT, username: 'rowbutt', text: 'an answer' },
      { ts: '2.000002', bot_id: 'B0OTHER', username: 'cd', text: 'a digest' },
    );
    const page = await surface().history(THREAD, { limit: 10 });
    // Replay drops other bots, so an answer read back without a `user` must stay mate's.
    expect(page.map((m) => m.authorId)).toEqual(['B0OTHER', ME]);
  });
});

describe('a Web API call', () => {
  const original = globalThis.fetch;
  const web = () => slackWeb('xoxb', { clock, log });

  afterEach(() => {
    globalThis.fetch = original;
  });

  test('a transport failure names the method and the status', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
      })) as unknown as typeof fetch;
    await expect(web().post(CHANNEL, TS, 'hi')).rejects.toThrow(
      'chat.postMessage: HTTP 502',
    );
  });

  test("Slack's own refusal is the error", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        ok: false,
        error: 'not_in_channel',
      })) as unknown as typeof fetch;
    await expect(web().post(CHANNEL, TS, 'hi')).rejects.toThrow(
      'chat.postMessage: not_in_channel',
    );
  });

  test('the code Slack answered is carried, not only spelled into a sentence', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        ok: false,
        error: 'message_not_in_streaming_state',
      })) as unknown as typeof fetch;
    // The error code alone tells an ended stream from a broken one.
    const failed = await web()
      .appendStream(CHANNEL, TS, [{ type: 'markdown_text', text: 'x' }])
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SlackError);
    expect((failed as SlackError).code).toBe('message_not_in_streaming_state');
  });

  /**
   * A read sent as JSON fails with `invalid_arguments` or a false
   * `user_not_found`, and the transcript replay comes back empty.
   */
  test('a read is form-encoded and a write that carries chunks is JSON', async () => {
    const sent: { url: string; type: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url: String(url),
        type: String((init.headers as Record<string, string>)['content-type']),
        body: String(init.body),
      });
      return Response.json({ ok: true, ts: '1.1', messages: [], user: {} });
    }) as unknown as typeof fetch;

    const client = web();
    await client.replies(CHANNEL, TS);
    await client.userName(OWNER);
    await client.startStream({
      channel: CHANNEL,
      threadTs: TS,
      userId: OWNER,
      teamId: TEAM,
      chunks: [{ type: 'markdown_text', text: 'hi' }],
    });

    const [replies, users, stream] = sent;
    expect(replies?.type).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    );
    expect(replies?.body).toContain(`channel=${CHANNEL}`);
    expect(users?.body).toBe(`user=${OWNER}`);
    expect(stream?.type).toBe('application/json; charset=utf-8');
    expect(JSON.parse(stream?.body ?? '{}')).toMatchObject({
      chunks: [{ type: 'markdown_text', text: 'hi' }],
      recipient_user_id: OWNER,
      recipient_team_id: TEAM,
      // Every task of the stream is a row of one titled plan block.
      task_display_mode: 'plan',
    });
  });

  test("a stop carries the plan's last chunks, and a bare stop sends none", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const client = web();
    const title = {
      type: 'plan_update',
      title: 'Ran 1 command in 1 step · 1s',
    };
    await client.stopStream(CHANNEL, '1.1', [title as never]);
    await client.stopStream(CHANNEL, '1.2');
    expect(bodies).toEqual([
      { channel: CHANNEL, ts: '1.1', chunks: [title] },
      { channel: CHANNEL, ts: '1.2' },
    ]);
  });

  test('a session warning is said once each, not once a turn', async () => {
    let warning = 'missing_agent_session_stopped_event_subscription';
    globalThis.fetch = (async () =>
      Response.json({ ok: true, warning })) as unknown as typeof fetch;
    const client = web();
    await client.session(CHANNEL, TS, 'processing');
    await client.session(CHANNEL, TS, 'active');
    expect(log.of('slack agent session')).toHaveLength(1);
    // Deduped per warning, so the first does not silence the rest.
    warning = 'something_else_entirely';
    await client.session(CHANNEL, TS, 'processing');
    expect(log.of('slack agent session')).toHaveLength(2);
  });
});

describe('the socket', () => {
  function drive(opts: { since?: number; sockets?: FakeSocket[] }) {
    const sockets = opts.sockets ?? [new FakeSocket()];
    let next = 0;
    const events: unknown[] = [];
    const socket = new SocketMode({
      open: async () => `wss://wss-primary.slack.com/link/${next}`,
      connect: () =>
        sockets[Math.min(next++, sockets.length - 1)] as FakeSocket,
      clock,
      log,
      since: opts.since ?? 0,
      onEvent: (payload) => events.push(payload),
    });
    return { socket, sockets, clock, events };
  }

  const envelope = (id: string, eventId: string, at = 9_999) => ({
    type: 'events_api',
    envelope_id: id,
    payload: {
      event_id: eventId,
      event_time: at,
      event: { channel: CHANNEL, ts: TS, user: OWNER, text: 'hi' },
    },
  });

  test('acknowledges every envelope, then hands the event on once', async () => {
    const { socket, sockets, events } = drive({});
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver(envelope('e1', 'Ev1'));
    wire.deliver(envelope('e2', 'Ev1'));
    expect(wire.acks).toEqual(['e1', 'e2']);
    expect(events).toHaveLength(1);
    socket.stop();
  });

  test('an envelope mate has nothing to do with is acknowledged all the same', async () => {
    const { socket, sockets, events } = drive({});
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    // Slack redelivers any unacknowledged envelope.
    wire.deliver({
      type: 'interactive',
      envelope_id: 'i1',
      payload: { actions: [{ action_id: 'someone-elses', value: 'x' }] },
    });
    expect(wire.acks).toEqual(['i1']);
    expect(events).toEqual([]);
    socket.stop();
  });

  test("Slack's own stop arrives on the same socket, acknowledged like the rest", async () => {
    const { socket, sockets, events } = drive({});
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver({
      type: 'events_api',
      envelope_id: 'e7',
      payload: {
        event_id: 'Ev7',
        event_time: 9_999,
        event: {
          type: 'agent_session_stopped',
          channel: CHANNEL,
          thread_ts: TS,
          user: OWNER,
          streaming_message_ts: ['1758300001.000200'],
        },
      },
    });
    expect(wire.acks).toEqual(['e7']);
    expect(events).toHaveLength(1);
    socket.stop();
  });

  test('an event Slack buffered from before this process is not answered', async () => {
    const { socket, sockets, events } = drive({ since: 10_000_000 });
    void socket.run();
    await settle();
    (sockets[0] as FakeSocket).deliver(envelope('e1', 'Ev1', 9_000));
    expect(events).toHaveLength(0);
    expect(
      log.of('slack replayed an event from before this process'),
    ).toHaveLength(1);
    socket.stop();
  });

  test('more than one connection means Slack is splitting events, and it says so', async () => {
    const { socket, sockets } = drive({});
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver({
      type: 'hello',
      num_connections: 1,
      connection_info: { app_id: 'A061TGKE6KC' },
    });
    expect(log.of('slack is splitting events across connections')).toHaveLength(
      0,
    );
    wire.deliver({ type: 'hello', num_connections: 2 });
    expect(log.of('slack is splitting events across connections')).toHaveLength(
      1,
    );
    socket.stop();
  });

  test('a reconnect Slack asks for closes the socket and opens another', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { socket, clock, events } = drive({ sockets: [first, second] });
    void socket.run();
    await settle();
    first.deliver({ type: 'disconnect', reason: 'refresh_requested' });
    expect(first.closed).toBe(true);
    await clock.advance(1_000);
    await settle();
    second.deliver(envelope('e9', 'Ev9'));
    expect(events).toHaveLength(1);
    expect(second.acks).toEqual(['e9']);
    socket.stop();
  });
});

/** From Slack's stop envelope through the socket wiring to `Threads.onStop`. */
describe('a turn stopped from Slack', () => {
  const streaming =
    (text: string): Script =>
    () => {
      const steps: ReturnType<Script> = [{ status: 'working' }, { wait: 100 }];
      for (const word of text.split(' '))
        steps.push({ text: `${word} ` }, { wait: 100 });
      return steps;
    };

  function build(script: Script) {
    const metrics = new RecordingInstruments();
    const surface = slackSurface({
      api,
      me: ME,
      appBotId: BOT,
      teamId: TEAM,
      allowedUserIds: new Set([OWNER]),
      allowedChannelIds: new Set([CHANNEL]),
      log,
      clock,
    });
    const threads = new Threads({
      surfaces: [surface],
      brain: new StubBrain({ clock, script }),
      store: new MemoryThreadStore(clock),
      clock,
      log,
      config: {
        quietMs: QUIET_MS,
        maxTurnsPerThread: 30,
        maxTurnsPerDay: 120,
        maxConcurrent: 3,
      },
      editCadenceMs: 100,
      // Scaled with the cadence, so word-at-a-time output still becomes the answer.
      runGraceMs: 100,
      metrics,
    });
    // The same wiring the socket gets.
    const deliver = (event: Record<string, unknown>) =>
      slackEvent(event, ME, {
        stopped: (stop) =>
          void threads.onStop(stop.key, stop.userId, async () => {}),
        message: (inbound) => void threads.onMessage(inbound),
      });
    return { threads, metrics, deliver };
  }

  const ask = {
    type: 'message',
    channel: CHANNEL,
    ts: TS,
    user: OWNER,
    text: `<@${ME}> go`,
  };
  const stopping = (user = OWNER, threadTs = TS) => ({
    type: 'agent_session_stopped',
    channel: CHANNEL,
    thread_ts: threadTs,
    user,
    streaming_message_ts: ['1758300001.000200'],
  });

  test('the human stopping their own thread cancels the turn', async () => {
    const { threads, metrics, deliver } = build(
      streaming('one two three four'),
    );
    deliver(ask);
    await clock.advance(250);
    deliver(stopping());
    await clock.advance(3_000);
    expect(metrics.turns).toEqual(['cancelled']);
    expect(threads.stateOf(KEY)).toBe('idle');
    expect(api.streamed()).toEndWith('*stopped*');
    expect(api.streamed()).not.toContain('four');
    expect(api.only('stop')).toHaveLength(1);
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('a stop from anyone but the allowlisted human is ignored', async () => {
    const { metrics, deliver } = build(streaming('one two'));
    deliver(ask);
    await clock.advance(250);
    deliver(stopping(STRANGER));
    await clock.advance(3_000);
    expect(metrics.turns).toEqual(['end_turn']);
    expect(api.streamed()).toBe('one two ');
  });

  test('a stop for a thread mate does not own is ignored', async () => {
    const { metrics, deliver } = build(streaming('one two'));
    deliver(ask);
    await clock.advance(250);
    deliver(stopping(OWNER, '1758399999.000900'));
    await clock.advance(3_000);
    expect(metrics.turns).toEqual(['end_turn']);
    expect(api.streamed()).toBe('one two ');
  });

  for (const code of ['stopped_by_user', 'message_not_in_streaming_state']) {
    test(`${code} under the stop is the turn ending, not a turn failing`, async () => {
      const { metrics, deliver } = build(streaming('one two three four'));
      deliver(ask);
      await clock.advance(250);
      // Slack ends the stream as it sends the event, refusing every later frame.
      api.failAppend = ended(code);
      deliver(stopping());
      await clock.advance(3_000);
      // The last frame was refused, and no second message opens for the stop mark.
      expect(api.only('start')).toHaveLength(1);
      expect(api.streamed()).not.toContain('*stopped*');
      expect(metrics.turns).toEqual(['cancelled']);
      // Nothing is posted beside the stream: a turn that starts at once has no status line.
      expect(api.only('post')).toEqual([]);
      expect(JSON.stringify(api.calls)).not.toContain(UNDELIVERED);
      expect(log.entries.filter((e) => e.level === 'error')).toEqual([]);
      expect(api.only('session').at(-1)?.status).toBe('active');
    });
  }

  test('a torn-down thread closes its agent session', async () => {
    const { threads, deliver } = build(streaming('one'));
    deliver(ask);
    await clock.advance(3_000);
    expect(threads.stateOf(KEY)).toBe('idle');
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(KEY)).toBe('closed');
    expect(api.only('session').at(-1)?.status).toBe('closed');
  });

  test('a close that will not go through does not fail the teardown', async () => {
    const { threads, deliver } = build(streaming('one'));
    deliver(ask);
    await clock.advance(3_000);
    api.failSession = new Error('channel_not_found');
    await clock.advance(QUIET_MS);
    expect(threads.stateOf(KEY)).toBe('closed');
    expect(log.of('archive failed')).toHaveLength(1);
  });
});
