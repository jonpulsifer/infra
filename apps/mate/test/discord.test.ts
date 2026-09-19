/**
 * The Discord adapter: which gateway messages reach the state machine, and
 * the key a thread is known by once they do.
 */
import { describe, expect, test } from 'bun:test';
import { discordInbound, discordKey, discordThread } from '../src/discord.ts';
import { threadKey } from '../src/surface.ts';

const GUILD = '1509024936717455381';
const CHANNEL = '1509024937422356532';
const THREAD = '1509024937422356777';
const OWNER = '308072071949320204';

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'm-1',
  guildId: GUILD,
  channelId: CHANNEL,
  authorId: OWNER,
  authorIsBot: false,
  content: 'hello',
  mentionsMe: true,
  ...overrides,
});

describe('a gateway message', () => {
  test("from mate's own guild becomes an inbound naming its channel as its thread", () => {
    expect(discordInbound(message(), GUILD)).toEqual({
      surface: 'discord',
      id: 'm-1',
      channelId: CHANNEL,
      threadId: CHANNEL,
      authorId: OWNER,
      authorIsBot: false,
      content: 'hello',
      mentionsMe: true,
    });
  });

  test('from another guild, or from no guild at all, is not read', () => {
    expect(discordInbound(message({ guildId: '2' }), GUILD)).toBeNull();
    expect(discordInbound(message({ guildId: null }), GUILD)).toBeNull();
  });

  test('inside a thread names the thread, which is how it is found again', () => {
    const inbound = discordInbound(message({ channelId: THREAD }), GUILD);
    expect(inbound?.threadId).toBe(THREAD);
    expect(
      threadKey({
        surface: 'discord',
        channelId: inbound?.channelId ?? '',
        id: inbound?.threadId ?? '',
      }),
    ).toBe(discordKey(THREAD));
  });
});

describe('a Discord thread key', () => {
  test('is settled by the thread id alone, whatever channel it hangs under', () => {
    expect(threadKey(discordThread(THREAD, CHANNEL))).toBe(
      threadKey(discordThread(THREAD)),
    );
    expect(discordKey(THREAD)).toBe(`discord:${THREAD}`);
  });

  test('fits the custom id a Stop button carries', () => {
    expect(`stop:${discordKey(THREAD)}`.length).toBeLessThanOrEqual(100);
  });
});
