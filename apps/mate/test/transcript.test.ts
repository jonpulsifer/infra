/**
 * The replay a fresh harness is handed: what of the thread it carries, in
 * what order, and where it stops.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { SANDBOX_CLOSED, WAITING } from '../src/notices.ts';
import { STOPPED } from '../src/reply.ts';
import type { Surface } from '../src/surface.ts';
import {
  REPLAY_CHARS,
  REPLAY_MESSAGES,
  REPLAY_PAGES,
  replayPreamble,
} from '../src/transcript.ts';
import { discordRef, FakeDiscord } from './support.ts';

const ME = '900000000000000001';
const OWNER = '308072071949320204';
const THREAD = 'thread-1';
const CHANNEL = '1509024937422356532';

let discord: FakeDiscord;
let surface: Surface;

beforeEach(() => {
  discord = new FakeDiscord(ME);
  surface = discord.surface({
    me: ME,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
  });
});

function mate(content: string): void {
  void discord.createMessage(THREAD, { content });
}

function human(content: string, name = 'jawn'): void {
  discord.post(THREAD, content, OWNER, name);
}

const thread = () => discordRef(THREAD, CHANNEL);
const replay = () => replayPreamble(surface, thread(), { me: ME, skip: [] });

describe('replaying a thread', () => {
  test('carries the conversation oldest first, attributed', async () => {
    human('what does AGENTS.md say about tofu?');
    mate('it says applies go through Atlantis');
    human('thanks', 'someone else');

    const preamble = await replay();
    expect(preamble).toContain(
      'jawn: what does AGENTS.md say about tofu?\nyou: it says applies go through Atlantis\nsomeone else: thanks',
    );
    expect(preamble?.endsWith('\n\n')).toBe(true);
  });

  test("leaves out mate's own bookkeeping and other bots", async () => {
    human('hello');
    mate(SANDBOX_CLOSED);
    mate(`${WAITING} (1 ahead)`);
    mate(STOPPED);
    discord.posted.push({
      channelId: THREAD,
      id: 'other-bot',
      authorId: '42',
      authorName: 'alertmanager',
      authorIsBot: true,
      content: 'KubePodCrashLooping',
    });

    const preamble = await replay();
    expect(preamble).toContain('jawn: hello');
    expect(preamble).not.toContain(SANDBOX_CLOSED);
    expect(preamble).not.toContain(WAITING);
    expect(preamble).not.toContain(STOPPED);
    expect(preamble).not.toContain('KubePodCrashLooping');
  });

  test('skips the messages already queued as prompts', async () => {
    human('old news');
    human('the question being asked now');

    const preamble = await replayPreamble(surface, thread(), {
      me: ME,
      skip: ['the question being asked now'],
    });
    expect(preamble).toContain('old news');
    expect(preamble).not.toContain('the question being asked now');
  });

  test('keeps the newest messages up to the message cap', async () => {
    for (let i = 0; i < REPLAY_MESSAGES + 10; i += 1) human(`message ${i}`);

    const preamble = await replay();
    const lines = (preamble ?? '').split('\n').filter((l) => l.includes(': '));
    expect(lines).toHaveLength(REPLAY_MESSAGES);
    expect(lines[0]).toBe('jawn: message 10');
    expect(lines.at(-1)).toBe(`jawn: message ${REPLAY_MESSAGES + 9}`);
  });

  test('stops at the character budget', async () => {
    for (let i = 0; i < 20; i += 1) human('x'.repeat(1_000));

    const preamble = await replay();
    expect(preamble?.length).toBeLessThanOrEqual(REPLAY_CHARS);
    expect(discord.historyCalls).toBe(1);
  });

  test('pages backwards past what it cannot use, twice at most', async () => {
    for (let i = 0; i < 60; i += 1) human(`m${i}`);
    for (let i = 0; i < 150; i += 1) mate(SANDBOX_CLOSED);

    const preamble = await replay();
    expect(discord.historyCalls).toBe(2);
    expect(preamble).toContain('jawn: m59');
  });

  test('gives up rather than paging past the cap', async () => {
    human('the message no reader ever reaches');
    for (let i = 0; i < 250; i += 1) mate(SANDBOX_CLOSED);

    expect(await replay()).toBeNull();
    expect(discord.historyCalls).toBe(REPLAY_PAGES);
  });

  test('an empty thread replays nothing', async () => {
    expect(await replay()).toBeNull();
    mate(SANDBOX_CLOSED);
    expect(await replay()).toBeNull();
  });
});
