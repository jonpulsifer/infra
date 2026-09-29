import { describe, expect, test } from 'bun:test';
import type { API } from '@discordjs/core';
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
  discordOver,
  discordThread,
  type OutMessage,
  spoken,
  stopRow,
  subtext,
  TEXT_CAP,
} from '../src/discord.ts';
import { SANDBOX_CARD_ID } from '../src/lease.ts';
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

describe("a card's footer", () => {
  test('counts the tools the agent called, and not the sandbox card', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const canvas = new DiscordCanvas(discord, THREAD, 'k', clock);
    await canvas.tool?.({
      id: SANDBOX_CARD_ID,
      title: 'sandbox ready',
      state: 'complete',
    });
    await canvas.tool?.({ id: 'c1', title: '$ ls', state: 'complete' });
    await canvas.final('done', 'done');
    expect(discord.inThread(THREAD).at(-1)?.subtext).toEqual([
      '-# ✓ 1 tool · 0s',
    ]);
  });
});

describe('a whisper', () => {
  test('opens the DM channel with the user and posts there, mentioning nobody', async () => {
    const calls: unknown[][] = [];
    const api = {
      users: {
        createDM: async (userId: string) => {
          calls.push(['createDM', userId]);
          return { id: 'dm-channel' };
        },
      },
      channels: {
        createMessage: async (channelId: string, body: unknown) => {
          calls.push(['createMessage', channelId, body]);
          return { id: 'dm-message' };
        },
      },
    } as unknown as API;
    const id = await discordOver(api).directMessage(OWNER, {
      content: 'the code',
    });
    expect(id).toBe('dm-message');
    expect(calls).toEqual([
      ['createDM', OWNER],
      [
        'createMessage',
        'dm-channel',
        {
          content: 'the code',
          components: [],
          allowed_mentions: { parse: [] },
        },
      ],
    ]);
  });

  test('from the surface is a DM in full words, and nothing lands in the thread', async () => {
    const discord = new FakeDiscord();
    const surface = discord.surface({
      me: 'bot',
      allowedUserIds: new Set([OWNER]),
      allowedChannelIds: new Set([CHANNEL]),
    });
    await surface.whisper?.(discordThread(THREAD, CHANNEL), OWNER, 'the code');
    expect(discord.dms).toEqual([{ userId: OWNER, content: 'the code' }]);
    expect(discord.messages).toEqual([]);
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
