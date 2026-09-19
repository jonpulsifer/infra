/**
 * The Slack half: what it reads off the socket and refuses to read twice,
 * what it streams, and what it does with the Stop button.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { silentLog } from '../src/log.ts';
import { NO_REPLY, PLACEHOLDER, Reply } from '../src/reply.ts';
import {
  decodeSlack,
  escapeSlack,
  SlackCanvas,
  STOP_ACTION,
  slackInbound,
  slackSessionStopped,
  slackStop,
  slackSurface,
  slackWeb,
} from '../src/slack.ts';
import { SocketMode } from '../src/socket.ts';
import type { ThreadRef } from '../src/surface.ts';
import { FakeSlack, FakeSocket } from './fakesurface.ts';
import { FakeClock, RecordingLog, settle } from './support.ts';

const ME = 'U06267D79UH';
const BOT = 'B061D291YCF';
const OWNER = 'UAR78LSKC';
const TEAM = 'TAR78LS82';
const CHANNEL = 'C062BS4GADR';
const TS = '1758300000.000100';
const THREAD: ThreadRef = { surface: 'slack', channelId: CHANNEL, id: TS };
const KEY = `slack:${CHANNEL}:${TS}`;

let api: FakeSlack;
let log: RecordingLog;

beforeEach(() => {
  api = new FakeSlack();
  log = new RecordingLog();
});

const canvas = (cap?: number) =>
  new SlackCanvas(api, log, THREAD, { userId: OWNER, teamId: TEAM }, KEY, cap);

/** The thread key the Stop button carries, or undefined when there is none. */
const button = (blocks: unknown[] | null): string | undefined =>
  (
    blocks?.find(
      (block) => (block as { block_id?: string }).block_id === STOP_ACTION,
    ) as { elements?: { value?: string }[] } | undefined
  )?.elements?.[0]?.value;

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

describe('the Stop button', () => {
  test('carries the thread key and the human who clicked it', () => {
    expect(
      slackStop({
        user: { id: OWNER },
        actions: [{ action_id: STOP_ACTION, value: KEY }],
      }),
    ).toEqual({ key: KEY, userId: OWNER });
  });

  test('any other interaction is not a Stop', () => {
    expect(slackStop({ user: { id: OWNER }, actions: [] })).toBeNull();
    expect(
      slackStop({ actions: [{ action_id: 'something-else', value: 'x' }] }),
    ).toBeNull();
  });

  test("Slack's own stop names the same thread key the button carries", () => {
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
});

describe('streaming a turn', () => {
  test('the first frame starts an addressed stream and posts the control message', async () => {
    const painter = canvas();
    await painter.live('hello ', 'reading files');
    const [start, control] = api.calls;
    expect(start).toEqual({
      call: 'start',
      args: {
        channel: CHANNEL,
        threadTs: TS,
        userId: OWNER,
        teamId: TEAM,
        chunks: [{ type: 'markdown_text', text: 'hello ' }],
      },
    });
    // The control message carries Stop and nothing else: a channel thread
    // has no free-text status, so the line Discord paints is not sent here.
    expect(control).toMatchObject({
      call: 'post',
      threadTs: TS,
      text: PLACEHOLDER,
      stop: true,
    });
    expect(control?.call === 'post' ? button(control.blocks) : null).toBe(KEY);
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

  test('the control message is posted once and never edited', async () => {
    const painter = canvas();
    await painter.live('a', 'thinking');
    await painter.live('ab', 'running `mise run docs:check`');
    await painter.tool({ id: 't1', title: 'read files', state: 'complete' });
    expect(api.only('post')).toHaveLength(1);
  });

  test('a turn with no status yet still shows the button', async () => {
    const painter = canvas();
    await painter.live('', null);
    const control = api.only('post')[0];
    expect(control).toMatchObject({ text: PLACEHOLDER, stop: true });
    expect(button(control?.blocks ?? null)).toBe(KEY);
  });

  test('the last frame stops the stream and takes the button away', async () => {
    const painter = canvas();
    await painter.live('hello ', 'thinking');
    await painter.final('hello there', 'done');
    expect(api.streamed()).toBe('hello there');
    expect(api.only('stop')).toHaveLength(1);
    expect(api.only('remove')).toHaveLength(1);
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
    expect(api.only('post').map((c) => c.text)).toEqual([PLACEHOLDER]);
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

  test('a button that cannot be deleted is one warning, not a failed turn', async () => {
    const painter = canvas();
    await painter.live('a', null);
    api.failRemove = new Error('message_not_found');
    await painter.final('a', 'done');
    expect(log.of('the stop button could not be removed')).toHaveLength(1);
  });

  test('a last call that fails still ends the stream and takes the button away', async () => {
    const painter = canvas();
    await painter.live('a', 'thinking');
    api.failAppend = new Error('streaming_state_conflict');
    await expect(painter.final('ab', 'done')).rejects.toThrow(
      'streaming_state_conflict',
    );
    // A message left streaming refuses every later edit, so the stop goes
    // out whatever the frame before it did.
    expect(api.only('stop')).toHaveLength(1);
    expect(api.only('remove')).toHaveLength(1);
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

describe('the renderer against Slack', () => {
  test('coalesces to one append per cadence and ends with the stream stopped', async () => {
    const clock = new FakeClock();
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
    expect(api.only('remove')).toHaveLength(1);
  });

  test('a stopped turn ends with the mark, streamed like any other text', async () => {
    const clock = new FakeClock();
    const reply = new Reply(canvas(), clock, silentLog, TS, 1_000);
    reply.update({ kind: 'text', delta: 'partial ' });
    await clock.advance(0);
    await reply.finish('stopped');
    expect(api.streamed()).toBe('partial \n\n*stopped*');
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
  const web = () => slackWeb('xoxb', { clock: new FakeClock(), log });

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
  function drive(opts: {
    since?: number;
    onEvent?: (payload: unknown) => void;
    sockets?: FakeSocket[];
  }) {
    const clock = new FakeClock();
    const sockets = opts.sockets ?? [new FakeSocket()];
    let next = 0;
    const events: unknown[] = [];
    const interactions: unknown[] = [];
    const socket = new SocketMode({
      open: async () => `wss://wss-primary.slack.com/link/${next}`,
      connect: () =>
        sockets[Math.min(next++, sockets.length - 1)] as FakeSocket,
      clock,
      log,
      since: opts.since ?? 0,
      onEvent: (payload) => events.push(payload),
      onInteractive: (payload) => interactions.push(payload),
    });
    return { socket, sockets, clock, events, interactions };
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

  test('a button click arrives on the same socket and is acknowledged too', async () => {
    const { socket, sockets, interactions } = drive({});
    void socket.run();
    await settle();
    const wire = sockets[0] as FakeSocket;
    wire.deliver({
      type: 'interactive',
      envelope_id: 'i1',
      payload: { actions: [{ action_id: STOP_ACTION, value: KEY }] },
    });
    expect(wire.acks).toEqual(['i1']);
    expect(interactions).toHaveLength(1);
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
