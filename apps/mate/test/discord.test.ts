/**
 * The Discord adapter: which gateway messages reach the state machine, the
 * key a thread is known by once they do, and how a turn is drawn and read
 * back.
 */
import { describe, expect, test } from 'bun:test';
import {
  type APIMessageTopLevelComponent,
  ComponentType,
} from 'discord-api-types/v10';
import { duration } from '../src/clock.ts';
import {
  CHUNK_BUDGET,
  DiscordCanvas,
  discordInbound,
  discordKey,
  discordThread,
  type OutMessage,
  spoken,
  stopRow,
  subtext,
  TEXT_CAP,
} from '../src/discord.ts';
import { isNotice, SANDBOX_CLOSED } from '../src/notices.ts';
import { threadKey } from '../src/surface.ts';
import { FakeClock, FakeDiscord } from './support.ts';

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

describe('what a message says as conversation', () => {
  test("is a card's answer and none of the subtext around it", () => {
    expect(
      spoken({
        components: [
          {
            type: ComponentType.Container,
            components: [
              { type: ComponentType.TextDisplay, content: '-# ⟳ bun test' },
              { type: ComponentType.TextDisplay, content: 'the answer' },
              stopRow(discordKey(THREAD)),
            ],
          },
        ],
      }),
    ).toBe('the answer');
    expect(
      spoken({
        components: [
          { type: ComponentType.TextDisplay, content: 'the answer' },
          { type: ComponentType.TextDisplay, content: '-# ✓ 2 tools · 9s' },
        ],
      }),
    ).toBe('the answer');
  });

  test('is a plain line without its subtext mark, so the notice filter knows it', () => {
    expect(spoken({ content: subtext(SANDBOX_CLOSED) })).toBe(SANDBOX_CLOSED);
    expect(isNotice(spoken({ content: subtext(SANDBOX_CLOSED) }))).toBe(true);
    expect(spoken({ content: 'a human said this' })).toBe('a human said this');
  });
});

describe('a live card', () => {
  test("never passes Discord's text cap, however much the turn has done", async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const canvas = new DiscordCanvas(discord, THREAD, 'k', clock);
    for (let i = 0; i < 20; i += 1) {
      await canvas.step?.('s'.repeat(500));
      await canvas.tool?.({
        id: `c${i}`,
        title: 't'.repeat(500),
        state: 'in_progress',
      });
    }
    await canvas.live('a'.repeat(CHUNK_BUDGET * 2), 'x'.repeat(500));
    const total = (body: OutMessage) =>
      'components' in body ? textLength(body.components) : 0;
    for (const message of discord.inThread(THREAD))
      expect(total(message.body)).toBeLessThanOrEqual(TEXT_CAP);
    await canvas.final('a'.repeat(CHUNK_BUDGET * 2), 'done');
    for (const message of discord.inThread(THREAD))
      expect(total(message.body)).toBeLessThanOrEqual(TEXT_CAP);
  });
});

describe('a wait as a human reads it', () => {
  test('is seconds, then minutes and seconds', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(45_900)).toBe('45s');
    expect(duration(185_000)).toBe('3m 05s');
  });
});

function textLength(
  components: readonly APIMessageTopLevelComponent[],
): number {
  return components.reduce((sum, component) => {
    if (component.type === ComponentType.TextDisplay)
      return sum + component.content.length;
    if (component.type === ComponentType.Container)
      return sum + textLength(component.components);
    if (component.type === ComponentType.ActionRow)
      return (
        sum +
        component.components.reduce(
          (n, button) =>
            n + ('label' in button ? (button.label?.length ?? 0) : 0),
          0,
        )
      );
    return sum;
  }, 0);
}
