import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SANDBOX_CARD_ID } from '../src/lease.ts';
import { silentLog } from '../src/log.ts';
import {
  CONNECTING,
  DAY_SPENT,
  HARNESS_FAILED,
  MINT_STEPS,
  RESTARTED,
  SANDBOX_READY,
  THREAD_CLOSED,
  UNDELIVERED,
} from '../src/notices.ts';
import { NO_REPLY, Reply } from '../src/reply.ts';
import {
  DETAILS_MAX,
  decodeSlack,
  escapeSlack,
  PLAN_ROWS,
  PROCESSING_RENEW_MS,
  type RichElement,
  type SlackBlock,
  SlackCanvas,
  SlackError,
  type SlackMessage,
  slackEvent,
  slackEvents,
  slackInbound,
  slackSessionStopped,
  slackSurface,
  slackWeb,
  TITLE_CADENCE_MS,
} from '../src/slack.ts';
import {
  CLAIM_TIMEOUT_MS,
  type EventPayload,
  REPLAY_WINDOW_MS,
  SocketMode,
} from '../src/socket.ts';
import { MemoryThreadStore } from '../src/store.ts';
import type { Inbound, ThreadRef, ToolCall } from '../src/surface.ts';
import { Threads } from '../src/threads.ts';
import { replayPreamble } from '../src/transcript.ts';
import { FakeSlack, FakeSocket } from './fakesurface.ts';
import { type Script, StubBrain } from './stub-brain.ts';
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

  test('a message with a file is read, and the file is named for the model, never fetched', () => {
    const inbound = slackInbound(
      {
        type: 'message',
        subtype: 'file_share',
        channel: CHANNEL,
        ts: '1758300100.000400',
        thread_ts: TS,
        user: OWNER,
        text: 'what is this &lt;error&gt;?',
        files: [
          { name: 'screenshot.png', mimetype: 'image/png', size: 250_880 },
          { title: 'build log' },
        ],
      },
      ME,
    );
    expect(inbound?.threadId).toBe(TS);
    expect(inbound?.content).toBe(
      'what is this <error>?\n\n[attached files you cannot open: screenshot.png (image/png, 245 KB); build log. Ask for their text if it matters.]',
    );
    expect(
      slackInbound(
        {
          type: 'message',
          subtype: 'file_share',
          channel: CHANNEL,
          ts: '1758300100.000500',
          user: OWNER,
          files: [{ name: 'trace.txt', mimetype: 'text/plain', size: 12 }],
        },
        ME,
      )?.content,
    ).toBe(
      '[attached files you cannot open: trace.txt (text/plain, 12 B). Ask for their text if it matters.]',
    );
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
      { type: 'plan_update', title: 'Working · 1 command in 1 step…' },
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

  test('a full row keeps room for the count of the calls it could not list', async () => {
    const painter = canvas();
    await painter.step('Long commands.');
    // Five of these lines come to 599 characters, one short of the cap.
    for (let i = 1; i <= 6; i += 1) {
      await painter.tool(finished(`c${i}`, `$ ${String(i).repeat(115)}`));
    }
    await painter.final('ok', 'done');
    const details = api.plan().rows[0]?.details ?? '';
    expect(details.split('\n').at(-1)).toMatch(/^…\d+ more$/);
    expect(details.length).toBeLessThanOrEqual(DETAILS_MAX);
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
    // The lease is not a command, so it leaves the title alone.
    await painter.tool(running(SANDBOX_CARD_ID, MINT_STEPS.booting));
    await painter.tool(running('c2', '$ git log'));
    expect(api.titles()).toEqual(['Working · 1 command in 1 step…']);
    await clock.advance(TITLE_CADENCE_MS - 1_001);
    expect(api.titles()).toEqual(['Working · 1 command in 1 step…']);
    await clock.advance(1);
    expect(api.titles()).toEqual([
      'Working · 1 command in 1 step…',
      'Working · 2 commands in 1 step…',
    ]);
    await painter.tool(finished(SANDBOX_CARD_ID, SANDBOX_READY));
    await painter.tool(finished('c2', '$ git log'));
    await painter.step('Now the tests.');
    await clock.advance(TITLE_CADENCE_MS);
    expect(api.titles().at(-1)).toBe('Working · 2 commands in 2 steps…');
    await painter.tool(running('c3', '$ bun test'));
    await painter.final('ok', 'done');
    expect(api.titles().at(-1)).toBe('Ran 3 commands in 2 steps · 6s');
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

  test("a stream the human's stop already ended keeps a running title that names no command", async () => {
    const painter = canvas();
    await painter.tool(running('c1', '$ bun test'));
    api.failAppend = ended('stopped_by_user');
    await painter.final('partial', 'stopped');
    // Slack refuses every later frame, so the title sent first is the one it
    // keeps unless the retitle lands, and a command's name there would read
    // as still running.
    expect(api.only('stop')).toEqual([]);
    expect(api.plan().title).toBe('Working · 1 command in 1 step…');
    expect(api.only('session').at(-1)?.status).toBe('active');
  });

  test('a close Slack never got is sent again with the stop', async () => {
    const painter = canvas();
    await painter.step('A.');
    await painter.tool(finished('c1', '$ one'));
    api.failAppend = new SlackError('chat.appendStream', 'HTTP 503');
    await expect(painter.step('B.')).rejects.toThrow('HTTP 503');
    api.failAppend = null;
    await painter.tool(finished('c2', '$ two'));
    await painter.final('ok', 'done');
    // Slack turns a row the stop leaves running into an error.
    expect(api.plan().rows.map((row) => [row.id, row.status])).toEqual([
      ['phase-1', 'complete'],
      ['phase-2', 'complete'],
    ]);
    const [stop] = api.only('stop');
    expect(stop?.chunks.map((chunk) => chunk.type)).toEqual([
      'task_update',
      'task_update',
      'plan_update',
    ]);
  });

  test('a roll whose stop is refused closes its rows when it is tried again', async () => {
    const painter = canvas(40);
    const text = `${'a'.repeat(30)}\n${'b'.repeat(29)}`;
    await painter.step('Looking.');
    await painter.tool(running('c1', '$ ls'));
    api.failStopStream = new SlackError('chat.stopStream', 'internal_error');
    await expect(painter.live(text, null)).rejects.toThrow('internal_error');
    api.failStopStream = null;
    await painter.live(text, null);
    expect(api.only('stop')[0]?.chunks).toEqual([
      {
        type: 'task_update',
        id: 'phase-1',
        title: 'Looking.',
        status: 'complete',
      },
      { type: 'plan_update', title: '1 command in 1 step so far · 0s' },
    ]);
    expect(api.plan(0).rows[0]?.status).toBe('complete');
  });

  test('a rolled answer leaves its plan closed and titled so far, and its phase goes on in the next', async () => {
    const painter = canvas(40);
    const text = `${'a'.repeat(30)}\n${'b'.repeat(29)}`;
    await painter.step('Looking.');
    await painter.tool(running('c1', '$ ls'));
    await painter.live(text, null);
    // The turn goes on, so the rolled plan does not claim it ran to the end.
    expect(api.only('stop')[0]?.chunks).toEqual([
      {
        type: 'task_update',
        id: 'phase-1',
        title: 'Looking.',
        status: 'complete',
      },
      { type: 'plan_update', title: '1 command in 1 step so far · 0s' },
    ]);
    await painter.tool(finished('c1', '$ ls'));
    const opened = api.only('append').at(-1);
    expect(opened?.ts).toBe('s-2');
    expect(opened?.chunks[0]).toEqual({
      type: 'plan_update',
      title: 'Working · 1 command in 1 step…',
    });
    await painter.tool(finished('c2', '$ pwd'));
    await painter.final(text, 'done');
    // The phase the roll cut is the same step, still under its sentence.
    expect(api.plan(1)).toEqual({
      title: 'Ran 2 commands in 1 step · 0s',
      rows: [
        {
          id: 'phase-1',
          title: 'Looking.',
          status: 'complete',
          details: '✓ $ ls\n✓ $ pwd',
        },
      ],
    });
    expect(api.streamed()).toBe(text);
  });

  test('an answer that rolls after the tool work leaves the last stream with no plan', async () => {
    const painter = canvas(40);
    await painter.step('Looking.');
    await painter.tool(finished('c1', '$ ls'));
    await painter.final(`${'a'.repeat(30)}\n${'b'.repeat(28)}`, 'failed');
    expect(api.titles()).toEqual([
      'Working · 1 step…',
      '1 command in 1 step so far · 0s',
    ]);
    expect(api.plan(1)).toEqual({ title: null, rows: [] });
    expect(api.only('stop').at(-1)?.chunks).toEqual([]);
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
    // The stop sends only what Slack has not taken: the last row and the title.
    expect(api.only('stop')[0]?.chunks).toHaveLength(2);
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

  describe("a plan Slack's own stop ended", () => {
    const STOPPED_TITLE = '⏹️ Stopped · 2 commands in 2 steps · 42s';

    /** A turn the human stops with a row still running. */
    async function stopMidTurn() {
      const painter = canvas();
      await painter.step('Looking first.');
      await painter.tool(finished('c1', '$ git status'));
      await painter.step('Now the tests.');
      await painter.tool(running('c2', '$ bun test'));
      await painter.live('Found it. ', null);
      await clock.advance(42_000);
      api.failAppend = ended('stopped_by_user');
      return painter;
    }

    test('is sent back once with the stopped title, its rows as Slack stored them', async () => {
      const painter = await stopMidTurn();
      await painter.final('Found it. More.', 'stopped');
      expect(api.only('read')).toEqual([
        { call: 'read', threadTs: TS, ts: 's-1' },
      ]);
      expect(api.only('edit')).toEqual([
        {
          call: 'edit',
          ts: 's-1',
          text: `${STOPPED_TITLE} Found it. `,
          blocks: [
            {
              type: 'plan',
              title: STOPPED_TITLE,
              tasks: [
                {
                  task_id: 'phase-1',
                  title: 'Looking first.',
                  status: 'complete',
                  details: '✓ $ git status',
                },
                // Closed as Slack closes a row a stop leaves running.
                {
                  task_id: 'phase-2',
                  title: 'Now the tests.',
                  status: 'error',
                },
              ],
            },
            { type: 'markdown', text: 'Found it. ' },
          ],
        },
      ]);
      expect(api.only('session').at(-1)?.status).toBe('active');
    });

    test('a stop found at the last frame or at a roll is retitled the same way', async () => {
      const title = '⏹️ Stopped · 1 command in 1 step · 0s';
      const atStop = canvas();
      await atStop.tool(running('c1', '$ bun test'));
      api.failStopStream = ended('message_not_in_streaming_state');
      await atStop.final('partial', 'stopped');
      expect(api.only('edit').map((c) => [c.ts, c.blocks?.[0]?.title])).toEqual(
        [['s-1', title]],
      );

      api.calls.length = 0;
      api.failStopStream = ended('stopped_by_user');
      const atRoll = canvas(40);
      await atRoll.tool(running('c1', '$ ls'));
      const text = `${'a'.repeat(30)}\n${'b'.repeat(29)}`;
      await atRoll.live(text, null);
      await atRoll.final(text, 'stopped');
      expect(api.only('edit').map((c) => [c.ts, c.blocks?.[0]?.title])).toEqual(
        [['s-2', title]],
      );
    });

    test('an answer with no plan, or one whose plan Slack never took, is left alone', async () => {
      const painter = canvas();
      await painter.live('partial ', null);
      api.failAppend = ended('stopped_by_user');
      await painter.tool(running('c1', '$ bun test'));
      await painter.final('partial more', 'stopped');
      expect(api.only('read')).toEqual([]);
      expect(api.only('edit')).toEqual([]);
    });

    test('a message that reads back without its plan is left alone', async () => {
      const painter = await stopMidTurn();
      api.thread.push({ ts: 's-1', bot_id: BOT, text: 'Found it. ' });
      await painter.final('Found it. More.', 'stopped');
      expect(api.only('read')).toHaveLength(1);
      expect(api.only('edit')).toEqual([]);
      expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
    });

    for (const outcome of ['done', 'stopped', 'failed'] as const) {
      test(`mate's own stop of a ${outcome} turn is the plan's last word`, async () => {
        const painter = canvas();
        await painter.tool(running('c1', '$ bun test'));
        await painter.final('answer', outcome);
        expect(api.only('stop')).toHaveLength(1);
        expect(api.only('read')).toEqual([]);
        expect(api.only('edit')).toEqual([]);
      });
    }

    for (const failing of ['read', 'update'] as const) {
      test(`a ${failing} that fails is one warning, tried once, and the turn still ends`, async () => {
        const painter = await stopMidTurn();
        if (failing === 'read') {
          api.failRead = new SlackError('conversations.replies', 'ratelimited');
        } else {
          api.failEdit = new SlackError('chat.update', 'cant_update_message');
        }
        await expect(
          painter.final('Found it. More.', 'stopped'),
        ).resolves.toBeUndefined();
        expect(log.entries.filter((e) => e.level !== 'info')).toEqual([
          expect.objectContaining({
            level: 'warn',
            msg: 'the stopped plan could not be retitled',
          }),
        ]);
        expect(api.only('read')).toHaveLength(1);
        expect(api.only('session').at(-1)?.status).toBe('active');
      });
    }

    test('nothing sent back can ping a human, however the read returns it', async () => {
      const painter = canvas();
      await painter.step('Asking first.');
      api.thread.push({
        ts: 's-1',
        bot_id: BOT,
        text: `Working · 1 step… <@${OWNER}>`,
        blocks: [
          {
            type: 'plan',
            title: 'Working · 1 step…',
            tasks: [
              {
                task_id: 'phase-1',
                title: `Asking <@${OWNER}> first.`,
                status: 'in_progress',
                details: '✗ echo <!channel> <#C0X>',
              },
            ],
          },
        ],
      });
      api.failAppend = ended('stopped_by_user');
      await painter.final('', 'stopped');
      const [edit] = api.only('edit');
      expect(JSON.stringify(edit)).not.toMatch(/<[@!#]/);
      expect(edit?.text).toBe(`⏹️ Stopped · 1 step · 0s &lt;@${OWNER}>`);
      expect(edit?.blocks?.[0]?.tasks).toEqual([
        {
          task_id: 'phase-1',
          title: `Asking &lt;@${OWNER}> first.`,
          status: 'error',
          details: '✗ echo &lt;!channel> &lt;#C0X>',
        },
      ]);
    });
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

  describe('marking a message', () => {
    const ref = { channelId: CHANNEL, id: TS };

    test('seen adds eyes', async () => {
      await surface().mark?.(ref, 'seen');
      expect(api.reactionsOn(CHANNEL, TS)).toEqual(['eyes']);
    });

    test.each([
      ['done', 'white_check_mark'],
      ['failed', 'warning'],
      ['stopped', 'black_square_for_stop'],
    ] as const)('%s swaps eyes for %s', async (mark, name) => {
      await surface().mark?.(ref, 'seen');
      await surface().mark?.(ref, mark);
      expect(api.reactionsOn(CHANNEL, TS)).toEqual([name]);
    });

    test('a failed unreact still adds the mark and rejects once', async () => {
      api.failUnreact = new Error('boom');
      await expect(surface().mark?.(ref, 'done')).rejects.toThrow('boom');
      expect(api.reactionsOn(CHANNEL, TS)).toEqual(['white_check_mark']);
    });

    test('a failed react still removes eyes and rejects once', async () => {
      await surface().mark?.(ref, 'seen');
      api.failReact = new Error('bang');
      await expect(surface().mark?.(ref, 'done')).rejects.toThrow('bang');
      expect(api.reactionsOn(CHANNEL, TS)).toEqual([]);
    });
  });

  test('a whisper is a message only the user sees, in the channel and not the thread', async () => {
    await surface().whisper?.(THREAD, OWNER, 'enter <this> & that');
    expect(api.calls).toEqual([
      {
        call: 'whisper',
        channel: CHANNEL,
        user: OWNER,
        text: 'enter &lt;this&gt; &amp; that',
      },
    ]);
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

  test("a human's file reads back in the history as it arrived, so the replay skips the prompt", async () => {
    api.thread.push({
      ts: '1.000001',
      user: OWNER,
      text: 'look',
      files: [{ name: 'a.log', mimetype: 'text/plain', size: 2_048 }],
    });
    const [message] = await surface().history(THREAD, { limit: 10 });
    expect(message?.content).toBe(
      slackInbound(
        {
          type: 'message',
          subtype: 'file_share',
          channel: CHANNEL,
          ts: '1.000001',
          thread_ts: TS,
          user: OWNER,
          text: 'look',
          files: [{ name: 'a.log', mimetype: 'text/plain', size: 2_048 }],
        },
        ME,
      )?.content,
    );
    expect(message?.content).toContain('a.log (text/plain, 2 KB)');
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

  test("mate's markdown reads back from the blocks Slack stored it as", async () => {
    const section = (...elements: RichElement[]): RichElement => ({
      type: 'rich_text_section',
      elements,
    });
    api.thread.push({
      ts: '1.000001',
      bot_id: BOT,
      text: 'Ran 1 command in 1 step · 1s Result …',
      blocks: [
        { type: 'plan', title: 'Ran 1 command in 1 step · 1s' } as SlackBlock,
        { type: 'markdown', text: '## Result\n' },
        {
          type: 'rich_text',
          elements: [
            section(
              { type: 'text', text: 'Run ' },
              { type: 'text', text: 'bun test', style: { code: true } },
              { type: 'text', text: ', see ' },
              { type: 'link', url: 'https://example.com/a', text: 'the page' },
              { type: 'text', text: ' or ' },
              { type: 'link', url: 'https://example.com/b' },
              { type: 'text', text: '.\n' },
            ),
            {
              type: 'rich_text_preformatted',
              elements: [{ type: 'text', text: 'const a = 1;\nconst b = 2;' }],
            },
            {
              type: 'rich_text_quote',
              elements: [{ type: 'text', text: 'quoted' }],
            },
            {
              type: 'rich_text_list',
              style: 'ordered',
              elements: [
                section({ type: 'text', text: 'first' }),
                section({
                  type: 'text',
                  text: 'second',
                  style: { italic: true },
                }),
              ],
            },
          ],
        },
      ],
    });
    const [message] = await surface().history(THREAD, { limit: 10 });
    expect(message?.content).toBe(
      [
        '## Result',
        'Run `bun test`, see [the page](https://example.com/a) or https://example.com/b.',
        '```',
        'const a = 1;',
        'const b = 2;',
        '```',
        '> quoted',
        '1. first',
        '2. *second*',
        '',
      ].join('\n'),
    );
  });

  test('a notice Slack stored with an emoji element is still a notice, and an answer keeps its emoji', async () => {
    const said = (ts: string, ...elements: RichElement[]): SlackMessage => ({
      ts,
      bot_id: BOT,
      text: 'as Slack folded it',
      blocks: [
        {
          type: 'rich_text',
          elements: [{ type: 'rich_text_section', elements }],
        },
      ],
    });
    // A notice's mark comes back as an element holding its code points.
    const notice = (ts: string, line: string) => {
      const [mark = ''] = line.split(' ');
      const unicode = [...mark]
        .map((character) => character.codePointAt(0)?.toString(16))
        .join('-');
      return said(
        ts,
        { type: 'emoji', name: 'mark', unicode },
        { type: 'text', text: line.slice(mark.length) },
      );
    };
    api.thread.push(
      { ts: '1.000001', user: OWNER, text: 'fix it' },
      notice('2.000002', RESTARTED),
      notice('3.000003', `${HARNESS_FAILED}: boom`),
      notice('4.000004', THREAD_CLOSED),
      notice('5.000005', `${DAY_SPENT} 120 turns`),
      notice('6.000006', SANDBOX_READY),
      said(
        '7.000007',
        { type: 'text', text: 'Fixed ' },
        { type: 'emoji', name: 'white_check_mark', unicode: '2705' },
        { type: 'text', text: ' ' },
        { type: 'emoji', name: 'partyparrot' },
      ),
    );
    const preamble = await replayPreamble(surface(), THREAD, {
      me: ME,
      skip: [],
    });
    expect(preamble).toContain(
      `\n\n${OWNER}: fix it\nyou: Fixed ✅ :partyparrot:\n\n`,
    );
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

  test('a scheduled report posts a root without a thread_ts', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, string>;
      expect(body.channel).toBe(CHANNEL);
      expect(body.text).toBe('daily check');
      expect(body).not.toHaveProperty('thread_ts');
      return Response.json({ ok: true, ts: TS });
    }) as unknown as typeof fetch;
    expect(await web().postRoot(CHANNEL, 'daily check')).toBe(TS);
  });

  test('a reaction already added or already gone is not an error', async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const method = url.split('/').pop() as string;
      methods.push(method);
      expect(JSON.parse(init.body as string)).toEqual({
        channel: CHANNEL,
        timestamp: TS,
        name: 'eyes',
      });
      return Response.json({
        ok: false,
        error: method === 'reactions.add' ? 'already_reacted' : 'no_reaction',
      });
    }) as unknown as typeof fetch;
    await web().react(CHANNEL, TS, 'eyes');
    await web().unreact(CHANNEL, TS, 'eyes');
    expect(methods).toEqual(['reactions.add', 'reactions.remove']);
  });

  test('any other reaction refusal is the error', async () => {
    globalThis.fetch = (async () =>
      Response.json({
        ok: false,
        error: 'missing_scope',
      })) as unknown as typeof fetch;
    await expect(web().react(CHANNEL, TS, 'eyes')).rejects.toThrow(
      'reactions.add: missing_scope',
    );
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

  test('a whisper is chat.postEphemeral to one user, with no thread', async () => {
    const sent: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, message_ts: '1.1' });
    }) as unknown as typeof fetch;
    await web().whisper(CHANNEL, OWNER, 'the code');
    expect(sent).toEqual([
      {
        url: 'https://slack.com/api/chat.postEphemeral',
        body: { channel: CHANNEL, user: OWNER, text: 'the code' },
      },
    ]);
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

  test('a reply is read by its own ts, and a streamed one is rewritten with its blocks', async () => {
    const sent: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: String(init.body) });
      return Response.json({
        ok: true,
        messages: [
          { ts: TS, text: 'the parent' },
          { ts: '1.2', text: 'the reply' },
        ],
      });
    }) as unknown as typeof fetch;
    const client = web();
    // The parent can come back beside the one reply asked for.
    expect((await client.message(CHANNEL, TS, '1.2'))?.text).toBe('the reply');
    const blocks = [{ type: 'plan', title: 'Ran 1 command in 1 step · 1s' }];
    await client.edit(CHANNEL, '1.2', 'Ran 1 command in 1 step · 1s', blocks);
    const [read, update] = sent;
    expect(read?.url).toEndWith('conversations.replies');
    expect(Object.fromEntries(new URLSearchParams(read?.body))).toEqual({
      channel: CHANNEL,
      ts: TS,
      oldest: '1.2',
      latest: '1.2',
      inclusive: 'true',
    });
    expect(update?.url).toEndWith('chat.update');
    expect(JSON.parse(update?.body ?? '{}')).toEqual({
      channel: CHANNEL,
      ts: '1.2',
      text: 'Ran 1 command in 1 step · 1s',
      blocks,
    });
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
  function drive(opts: {
    since?: number;
    sockets?: FakeSocket[];
    claim?: (eventId: string, eventTime: number) => Promise<boolean>;
    answers?: (payload: EventPayload) => boolean;
  }) {
    const sockets = opts.sockets ?? [new FakeSocket()];
    let next = 0;
    const events: unknown[] = [];
    const stale: unknown[] = [];
    const socket = new SocketMode({
      open: async () => `wss://wss-primary.slack.com/link/${next}`,
      connect: () =>
        sockets[Math.min(next++, sockets.length - 1)] as FakeSocket,
      clock,
      log,
      since: opts.since ?? 0,
      claim: opts.claim,
      answers: opts.answers,
      onEvent: (payload) => events.push(payload),
      onStale: (payload) => stale.push(payload),
    });
    return { socket, sockets, clock, events, stale };
  }

  /** mate-db's claims, shared by every process a test runs. */
  function claims() {
    const handled = new Set<string>();
    return {
      handled,
      claim: async (eventId: string) => {
        if (handled.has(eventId)) return false;
        handled.add(eventId);
        return true;
      },
    };
  }

  const nowS = () => Math.floor(clock.now() / 1000);
  const envelope = (id: string, eventId: string, at = nowS()) => ({
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
    await settle();
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
        event_time: nowS(),
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
    await settle();
    expect(events).toHaveLength(1);
    socket.stop();
  });

  test('an event sent while mate restarted is answered by the next process, once', async () => {
    const shared = claims();
    const sentWhileDown = nowS() - 90;
    const before = drive({ since: clock.now() - 600_000, claim: shared.claim });
    void before.socket.run();
    await settle();
    (before.sockets[0] as FakeSocket).deliver(
      envelope('e1', 'EvHandled', sentWhileDown - 30),
    );
    await settle();
    expect(before.events).toHaveLength(1);
    before.socket.stop();

    const after = drive({ since: clock.now(), claim: shared.claim });
    void after.socket.run();
    await settle();
    const wire = after.sockets[0] as FakeSocket;
    // Slack's retries of both: one the last process answered, one it never saw.
    wire.deliver(envelope('e2', 'EvHandled', sentWhileDown - 30));
    wire.deliver(envelope('e3', 'EvMissed', sentWhileDown));
    await settle();
    expect(wire.acks).toEqual(['e2', 'e3']);
    expect(after.events).toEqual([
      expect.objectContaining({ event_id: 'EvMissed' }),
    ]);
    expect(after.stale).toEqual([]);
    expect(log.of('slack redelivered an event already handled')).toHaveLength(
      1,
    );
    after.socket.stop();
  });

  test('events keep their order while their claims are read', async () => {
    const shared = claims();
    let first = true;
    const { socket, sockets, events } = drive({
      claim: async (eventId) => {
        if (first) {
          first = false;
          await clock.sleep(1_000);
        }
        return shared.claim(eventId);
      },
    });
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver(envelope('e1', 'Ev1'));
    wire.deliver(envelope('e2', 'Ev2'));
    await clock.advance(1_000);
    await settle();
    expect(events.map((e) => (e as { event_id: string }).event_id)).toEqual([
      'Ev1',
      'Ev2',
    ]);
    socket.stop();
  });

  test('without a claim, an event from before this process is not answered', async () => {
    const { socket, sockets, events, stale } = drive({
      since: clock.now(),
      claim: async () => {
        throw new Error('connection refused');
      },
    });
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver(envelope('e1', 'Ev1', nowS() - 60));
    wire.deliver(envelope('e2', 'Ev2', nowS()));
    await settle();
    expect(events).toEqual([expect.objectContaining({ event_id: 'Ev2' })]);
    expect(stale).toEqual([expect.objectContaining({ event_id: 'Ev1' })]);
    expect(
      log.of('slack replayed an event from before this process'),
    ).toHaveLength(1);
    expect(log.of('a slack event could not be claimed')).toHaveLength(2);
    socket.stop();
  });

  test('an event that changes nothing skips the claim and waits on no other', async () => {
    const claimed: string[] = [];
    const { socket, sockets, events } = drive({
      claim: async (eventId) => {
        claimed.push(eventId);
        await clock.sleep(1_000);
        return true;
      },
      answers: (payload) => payload.event_id !== 'EvEdit',
    });
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver(envelope('e1', 'EvAsk'));
    wire.deliver(envelope('e2', 'EvEdit'));
    await settle();
    expect(events).toEqual([expect.objectContaining({ event_id: 'EvEdit' })]);
    await clock.advance(1_000);
    expect(events).toHaveLength(2);
    expect(claimed).toEqual(['EvAsk']);
    socket.stop();
  });

  test('a claim the store does not answer in time falls back to the start-time cutoff', async () => {
    const { socket, sockets, events, stale } = drive({
      since: clock.now(),
      claim: () => new Promise<boolean>(() => {}),
    });
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver(envelope('e1', 'EvOld', nowS() - 60));
    wire.deliver(envelope('e2', 'EvNew', nowS()));
    await clock.advance(CLAIM_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    await clock.advance(1);
    expect(stale).toEqual([expect.objectContaining({ event_id: 'EvOld' })]);
    await clock.advance(CLAIM_TIMEOUT_MS);
    expect(events).toEqual([expect.objectContaining({ event_id: 'EvNew' })]);
    expect(log.of('a slack event could not be claimed')).toHaveLength(2);
    socket.stop();
  });

  test('an event older than the replay window is not answered, claimed or not', async () => {
    const shared = claims();
    const { socket, sockets, events, stale } = drive({
      since: 0,
      claim: shared.claim,
    });
    void socket.run();
    await settle();
    (sockets[0] as FakeSocket).deliver(
      envelope('e1', 'Ev1', nowS() - REPLAY_WINDOW_MS / 1000 - 1),
    );
    await settle();
    expect(events).toEqual([]);
    expect(stale).toHaveLength(1);
    expect(shared.handled.size).toBe(0);
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
    await settle();
    expect(events).toHaveLength(1);
    expect(second.acks).toEqual(['e9']);
    socket.stop();
  });
});

describe('the events that need a claim', () => {
  const answers = (event: Record<string, unknown>) =>
    slackEvents({
      me: ME,
      allowedUserIds: new Set([OWNER]),
      threads: { onMessage: async () => {}, onStop: async () => {} },
      metrics: new RecordingInstruments(),
      log,
    }).answers({ event_id: 'Ev1', event });
  const message = { type: 'message', channel: CHANNEL, ts: TS, text: 'hi' };

  test("the owner's message and the owner's stop", () => {
    expect(answers({ ...message, user: OWNER })).toBe(true);
    expect(
      answers({
        type: 'agent_session_stopped',
        channel: CHANNEL,
        thread_ts: TS,
        user: OWNER,
      }),
    ).toBe(true);
  });

  test("not mate's own posts and edits, nor anyone off the allowlist", () => {
    expect(answers({ ...message, user: ME, bot_id: 'B1' })).toBe(false);
    expect(
      answers({ ...message, subtype: 'message_changed', hidden: true }),
    ).toBe(false);
    expect(answers({ ...message, user: 'U0STRANGER' })).toBe(false);
    expect(
      answers({
        type: 'agent_session_stopped',
        channel: CHANNEL,
        thread_ts: TS,
        user: 'U0STRANGER',
      }),
    ).toBe(false);
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
    const events = slackEvents({
      me: ME,
      allowedUserIds: new Set([OWNER]),
      threads,
      metrics,
      log,
    });
    const deliver = (event: Record<string, unknown>) =>
      events.onEvent({ event_id: `Ev${TS}`, event });
    return { threads, metrics, deliver, events };
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

  test("an allowlisted human's message that never reaches the threads is counted, and nobody else's", async () => {
    const { metrics, events } = build(streaming('one'));
    const message = (overrides: Record<string, unknown>) => ({
      event: { ...ask, ...overrides },
    });
    events.onEvent(message({ subtype: 'channel_join' }));
    events.onEvent(message({ subtype: 'message_changed', hidden: true }));
    events.onEvent(message({ subtype: 'channel_join', user: STRANGER }));
    events.onEvent(message({ subtype: 'bot_message', bot_id: BOT }));
    events.onStale(message({ text: 'secret words' }));
    events.onStale(message({ user: STRANGER }));
    events.onStale({ event: stopping() });
    await clock.advance(3_000);
    expect(metrics.inboundDrops).toEqual([
      { surface: 'slack', reason: 'subtype' },
      { surface: 'slack', reason: 'stale' },
    ]);
    expect(api.only('start')).toEqual([]);
    const logged = log.of('an inbound message was ignored');
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

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
