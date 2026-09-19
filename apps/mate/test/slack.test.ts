/**
 * The Slack half: what it reads off the socket and refuses to read twice,
 * what it streams, and what it does with Slack's own stop.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { silentLog } from '../src/log.ts';
import { UNDELIVERED } from '../src/notices.ts';
import { NO_REPLY, Reply } from '../src/reply.ts';
import { type Script, StubSandboxes } from '../src/sandbox.ts';
import {
  decodeSlack,
  escapeSlack,
  PROCESSING_RENEW_MS,
  SlackCanvas,
  SlackError,
  slackEvent,
  slackInbound,
  slackSessionStopped,
  slackSurface,
  slackWeb,
} from '../src/slack.ts';
import { SocketMode } from '../src/socket.ts';
import type { Inbound, ThreadRef } from '../src/surface.ts';
import { Threads } from '../src/threads.ts';
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
    // An app_mention carries the same channel, ts, user and text under its
    // own event id, so nothing downstream would dedupe it: the type is what
    // keeps one sentence from being answered twice, rather than a dashboard
    // setting no code can read.
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
        args: {
          channel: CHANNEL,
          threadTs: TS,
          userId: OWNER,
          teamId: TEAM,
          chunks: [{ type: 'markdown_text', text: 'hello ' }],
        },
      },
    ]);
    // A channel thread has no free-text status, so the line Discord paints
    // is not sent here, and Slack draws the stop itself: the answer's own
    // message is the only one a turn posts.
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
    // The card is not an answer: the line goes into the same message, which
    // is the one Slack will not let a second message be edited into.
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
    // The delta ends mid-pair: the `<` is held back until the next frame
    // rather than meeting its `@` in the rendered message unescaped.
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

describe('tool cards', () => {
  test('a tool call before any text opens the stream with a card of its own', async () => {
    const painter = canvas();
    await painter.tool({
      id: 'call-1',
      title: 'read files',
      state: 'in_progress',
    });
    expect(api.only('start')[0]?.args.chunks).toEqual([
      {
        type: 'task_update',
        id: 'call-1',
        title: 'read files',
        status: 'in_progress',
      },
    ]);
    expect(api.streamed()).toBe('');
  });

  test('one card per call, mutated by its id, interleaved with the answer', async () => {
    const painter = canvas();
    await painter.tool({ id: 'c1', title: 'read files', state: 'in_progress' });
    await painter.live('looking. ', 'read files');
    await painter.tool({ id: 'c1', title: 'read files', state: 'complete' });
    await painter.tool({
      id: 'c2',
      title: 'run `bun test`',
      state: 'in_progress',
    });
    await painter.tool({ id: 'c2', title: 'run `bun test`', state: 'error' });
    await painter.final('looking. done', 'done');
    // Slack merges a task_update into the card its id names, so the same id
    // twice is one card that moved rather than two cards.
    expect(api.cards()).toEqual([
      { id: 'c1', title: 'read files', status: 'in_progress' },
      { id: 'c1', title: 'read files', status: 'complete' },
      { id: 'c2', title: 'run `bun test`', status: 'in_progress' },
      { id: 'c2', title: 'run `bun test`', status: 'error' },
    ]);
    expect(api.chunks().map((chunk) => chunk.type)).toEqual([
      'task_update',
      'markdown_text',
      'task_update',
      'task_update',
      'task_update',
      'markdown_text',
    ]);
    expect(api.streamed()).toBe('looking. done');
    expect(api.only('stop')).toHaveLength(1);
  });

  test('a turn stopped under a running tool closes its card', async () => {
    const painter = canvas();
    await painter.tool({ id: 'c1', title: 'read files', state: 'complete' });
    await painter.tool({
      id: 'c2',
      title: 'run `bun test`',
      state: 'in_progress',
    });
    await painter.final('partial\n\n*stopped*', 'stopped');
    // Slack has no cancelled card, and one left running would spin for ever
    // on a turn that has ended; the call that did finish is untouched.
    expect(api.cards().at(-1)).toEqual({
      id: 'c2',
      title: 'run `bun test`',
      status: 'error',
    });
    expect(api.cards().filter((card) => card.id === 'c1')).toHaveLength(1);
  });

  test('a turn that ends normally completes the card it was still running', async () => {
    const painter = canvas();
    await painter.tool({ id: 'c1', title: 'read files', state: 'in_progress' });
    await painter.final('done', 'done');
    // Leaving it is not leaving the harness's last word: `chat.stopStream`
    // stamps a card still `in_progress` as `error` itself, so a successful
    // turn would render a failed call.
    expect(api.cards()).toEqual([
      { id: 'c1', title: 'read files', status: 'in_progress' },
      { id: 'c1', title: 'read files', status: 'complete' },
    ]);
  });

  test('a card title cannot ping a human, however the model writes it', async () => {
    const painter = canvas();
    // Slack folds the title into the streamed message's `text` byte for
    // byte, where a raw `<@U…>` is indistinguishable from a real mention.
    await painter.tool({
      id: 'c1',
      title: `ping <@${OWNER}> and <!channel>`,
      state: 'in_progress',
    });
    await painter.final('', 'stopped');
    for (const card of api.cards()) {
      expect(card.title).toBe(`ping &lt;@${OWNER}> and &lt;!channel>`);
    }
    expect(api.cards()).toHaveLength(2);
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
      await painter.final('partial \n\n*stopped*', 'stopped');
      // Nothing to append to and nothing worth opening a second message
      // for: the human asked for the turn to stop and it stopped.
      expect(api.streamed()).toBe('partial ');
      expect(api.only('start')).toHaveLength(1);
      expect(api.only('post')).toEqual([]);
      expect(log.entries.filter((e) => e.level !== 'info')).toEqual([]);
      // Quiet is not silent: an answer that stops mid-sentence leaves a line
      // saying so, because a human's stop is the usual cause and not the only
      // one Slack could have for ending a stream itself.
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
    const reply = new Reply(canvas(), clock, silentLog, TS, 1_000);
    reply.update({ kind: 'status', line: 'thinking' });
    await clock.advance(0);
    reply.update({ kind: 'text', delta: 'a' });
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
    // Slack expires `processing` an hour after it is set, which a turn
    // reaches only if the harness's own turn cap is raised past it.
    expect(
      api.only('session').filter((c) => c.status === 'processing'),
    ).toEqual([{ call: 'session', threadTs: TS, status: 'processing' }]);
    await clock.advance(PROCESSING_RENEW_MS * 2);
    expect(
      api.only('session').filter((c) => c.status === 'processing'),
    ).toHaveLength(3);

    await reply.finish('done');
    const after = api.only('session').length;
    // And stops the moment the turn does: a renewal past the last frame
    // would put a settled thread back to working.
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
    // Nothing moves a session to `closed` on its own, so a torn-down thread
    // that was never told would keep reading as one mate is living in.
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

  test("mate's own answer is mate's, whether or not Slack put a user on it", async () => {
    api.thread.push(
      { ts: '1.000001', bot_id: BOT, username: 'rowbutt', text: 'an answer' },
      { ts: '2.000002', bot_id: 'B0OTHER', username: 'cd', text: 'a digest' },
    );
    const page = await surface().history(THREAD, { limit: 10 });
    // The replay keeps what mate said and drops what other bots said, so an
    // answer read back without a `user` has to still be mate's.
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
    // Telling a stream that is already over from one that is broken is a
    // reading of this field, and re-parsing the message would be a worse one.
    const failed = await web()
      .appendStream(CHANNEL, TS, [{ type: 'markdown_text', text: 'x' }])
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SlackError);
    expect((failed as SlackError).code).toBe('message_not_in_streaming_state');
  });

  /**
   * The encoding is not a style choice. A read sent as JSON comes back
   * `invalid_arguments` naming a field that is right there in the body, or
   * `user_not_found` for a user who exists — a lie that reads like a
   * permission problem and leaves the transcript replay silently empty.
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
      // A card per call rather than one plan block summarising them: the
      // same chunks render either way and only this says which.
      task_display_mode: 'timeline',
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
    // The one Slack sends today would otherwise silence every later one.
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
    // mate draws no buttons, so nothing acts on an interactive payload — but
    // an unacknowledged envelope is one Slack sends again, and again.
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

/**
 * The whole path a stop takes: the envelope Slack sends, read the way the
 * wiring reads it, into the one cancel the state machine has — which is the
 * same one the Discord button reaches.
 */
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
      sandboxes: new StubSandboxes({ clock, script }),
      clock,
      log,
      config: {
        quietMs: QUIET_MS,
        maxTurnsPerThread: 30,
        maxTurnsPerDay: 120,
        maxConcurrent: 3,
      },
      editCadenceMs: 100,
      metrics,
    });
    // The wiring the socket is given, so what a test drives is the route an
    // envelope really takes rather than a second reading of it.
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
    expect(threads.stateOf(KEY)).toBe('attached');
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
      // Slack ends the stream as it sends the event, so every frame mate
      // still had in flight is refused from here on.
      api.failAppend = ended(code);
      deliver(stopping());
      await clock.advance(3_000);
      // The last frame never landed and no second message was opened to
      // hold it, so the stop mark is not in the thread at all.
      expect(api.only('start')).toHaveLength(1);
      expect(api.streamed()).not.toContain('*stopped*');
      expect(metrics.turns).toEqual(['cancelled']);
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
    expect(threads.stateOf(KEY)).toBe('attached');
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
