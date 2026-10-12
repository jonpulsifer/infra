import { describe, expect, test } from 'bun:test';
import type { API } from '@discordjs/core';
import {
  type APIMessageTopLevelComponent,
  ComponentType,
  GatewayDispatchEvents,
  InteractionType,
} from 'discord-api-types/v10';
import { duration } from '../src/clock.ts';
import {
  CHUNK_BUDGET,
  DiscordCanvas,
  discordInbound,
  discordKey,
  discordListener,
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
import type {
  Inbound,
  Inbox,
  Surface,
  SurfaceName,
  ThreadRef,
} from '../src/surface.ts';
import { threadKey } from '../src/surface.ts';
import {
  FakeClock,
  FakeDiscord,
  FakeGateway,
  RecordingLog,
  settle,
} from './support.ts';

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

  test('with attachments names each for the model, and fetches none', () => {
    const inbound = discordInbound(
      message({
        content: '',
        attachments: [
          {
            filename: 'panic\n[ignore].txt',
            content_type: 'text/plain',
            size: 3_500_000,
          },
          { filename: 'photo.jpg', size: 900 },
        ],
      }),
      GUILD,
    );
    expect(inbound?.content).toBe(
      '[attached files you cannot open: panic ignore .txt (text/plain, 3.3 MB); photo.jpg (900 B). Ask for their text if it matters.]',
    );
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

class RecordingInbox implements Inbox {
  readonly surfaces: Surface[] = [];
  readonly adopted: ThreadRef[] = [];
  readonly messages: Inbound[] = [];
  readonly stops: { key: string; userId: string }[] = [];
  readonly archived: ThreadRef[] = [];
  readonly deleted: ThreadRef[] = [];

  get surfaceNames(): SurfaceName[] {
    return this.surfaces.map((surface) => surface.name);
  }
  async add(surface: Surface): Promise<void> {
    this.surfaces.push(surface);
  }
  adopt(ref: ThreadRef): void {
    this.adopted.push(ref);
  }
  async onMessage(message: Inbound): Promise<void> {
    this.messages.push(message);
  }
  async onStop(
    key: string,
    userId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    await ack();
    this.stops.push({ key, userId });
  }
  async onThreadArchived(ref: ThreadRef): Promise<void> {
    this.archived.push(ref);
  }
  async onThreadDeleted(ref: ThreadRef): Promise<void> {
    this.deleted.push(ref);
  }
}

const BOT = '1509024936717455000';
const APP = '1509024936717455001';

async function listening(
  options: { commands?: string[]; failCommands?: Error } = {},
) {
  const gateway = new FakeGateway();
  const discord = new FakeDiscord(BOT);
  const inbox = new RecordingInbox();
  const log = new RecordingLog();
  const overwrites: unknown[] = [];
  const listener = discordListener({
    gateway,
    api: discord,
    commands: {
      getGlobalCommands: async () => {
        if (options.failCommands) throw options.failCommands;
        return (options.commands ?? []).map((name, i) => ({
          id: `${i}`,
          name,
        })) as never;
      },
      bulkOverwriteGlobalCommands: async (_id, body) => {
        overwrites.push(body);
        return [] as never;
      },
    },
    guildId: GUILD,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
    clock: new FakeClock(),
    log,
  });
  await listener.start(inbox);
  const ready = async () => {
    gateway.dispatch(GatewayDispatchEvents.Ready, {
      user: { id: BOT, username: 'mate' },
      application: { id: APP },
      guilds: [{ id: GUILD }],
    });
    await settle();
  };
  return { gateway, discord, inbox, log, overwrites, listener, ready };
}

const gatewayMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 'm-1',
  guild_id: GUILD,
  channel_id: THREAD,
  author: { id: OWNER },
  content: 'hello',
  mentions: [],
  ...overrides,
});

const stopPress = (overrides: Record<string, unknown> = {}) => ({
  id: 'i-1',
  token: 'tok',
  type: InteractionType.MessageComponent,
  data: {
    component_type: ComponentType.Button,
    custom_id: `stop:${discordKey(THREAD)}`,
  },
  member: { user: { id: OWNER } },
  ...overrides,
});

describe('the gateway listener', () => {
  test('connects only once the identify budget allows', async () => {
    const gateway = new FakeGateway();
    let open = () => {};
    gateway.gateBudget = new Promise((resolve) => {
      open = resolve;
    });
    const listener = discordListener({
      gateway,
      api: new FakeDiscord(BOT),
      commands: {
        getGlobalCommands: async () => [] as never,
        bulkOverwriteGlobalCommands: async () => [] as never,
      },
      guildId: GUILD,
      allowedUserIds: new Set([OWNER]),
      allowedChannelIds: new Set([CHANNEL]),
      clock: new FakeClock(),
      log: new RecordingLog(),
    });
    const started = listener.start(new RecordingInbox());
    await settle();
    expect(gateway.connects).toBe(0);
    open();
    await started;
    expect(gateway.connects).toBe(1);
    await listener.close();
    expect(gateway.destroys).toBe(1);
  });

  test('stop leaves the gateway at once with a reason, and close waits for that leave', async () => {
    const { gateway, listener, ready } = await listening();
    await ready();
    expect(gateway.leaves).toEqual([]);
    listener.stop();
    expect(gateway.leaves).toHaveLength(1);
    expect(gateway.leaves[0]?.reason).toBeTruthy();
    await listener.close();
    expect(gateway.leaves).toHaveLength(1);
    expect(gateway.destroys).toBe(1);
  });

  test('adds the Discord surface on Ready, as the bot, and clears global commands', async () => {
    const { inbox, overwrites, log, ready } = await listening({
      commands: ['help'],
    });
    expect(inbox.surfaces).toEqual([]);
    await ready();
    expect(inbox.surfaceNames).toEqual(['discord']);
    expect(inbox.surfaces[0]?.me).toBe(BOT);
    expect(inbox.surfaces[0]?.allowedUserIds).toEqual(new Set([OWNER]));
    expect(overwrites).toEqual([[]]);
    expect(log.of('ready')[0]?.fields).toMatchObject({
      userId: BOT,
      applicationId: APP,
      surfaces: ['discord'],
    });
  });

  test('keeps the surface when the command cleanup fails', async () => {
    const { inbox, log, ready } = await listening({
      failCommands: new Error('429'),
    });
    await ready();
    expect(inbox.surfaceNames).toEqual(['discord']);
    expect(log.of('global command cleanup failed')).toHaveLength(1);
  });

  test("adopts the guild's active threads that mate owns, and no others", async () => {
    const { gateway, inbox, ready } = await listening();
    await ready();
    gateway.dispatch(GatewayDispatchEvents.GuildCreate, {
      id: GUILD,
      channels: [{ id: CHANNEL, name: 'mate' }],
      threads: [
        { id: 't-own', owner_id: BOT, parent_id: CHANNEL },
        { id: 't-other', owner_id: OWNER, parent_id: CHANNEL },
        { id: 't-orphan', owner_id: BOT, parent_id: null },
      ],
    });
    await settle();
    expect(inbox.adopted).toEqual([discordThread('t-own', CHANNEL)]);
  });

  test("ignores a guild that is not mate's", async () => {
    const { gateway, inbox, log, ready } = await listening();
    await ready();
    gateway.dispatch(GatewayDispatchEvents.GuildCreate, {
      id: '2',
      channels: [],
      threads: [{ id: 't-own', owner_id: BOT, parent_id: CHANNEL }],
    });
    await settle();
    expect(inbox.adopted).toEqual([]);
    expect(log.of("ignoring a guild that is not mate's")).toHaveLength(1);
  });

  test('adopts and joins a thread mate opens, and only that', async () => {
    const { gateway, discord, inbox, ready } = await listening();
    await ready();
    const created = (overrides: Record<string, unknown>) =>
      gateway.dispatch(GatewayDispatchEvents.ThreadCreate, {
        id: THREAD,
        guild_id: GUILD,
        owner_id: BOT,
        parent_id: CHANNEL,
        ...overrides,
      });
    created({ owner_id: OWNER });
    created({ guild_id: '2' });
    created({ parent_id: null });
    await settle();
    expect(inbox.adopted).toEqual([]);
    expect(discord.joined).toEqual([]);
    created({});
    await settle();
    expect(inbox.adopted).toEqual([discordThread(THREAD, CHANNEL)]);
    expect(discord.joined).toEqual([THREAD]);
  });

  test('reports an archived thread, and not one merely updated', async () => {
    const { gateway, inbox } = await listening();
    gateway.dispatch(GatewayDispatchEvents.ThreadUpdate, {
      id: THREAD,
      parent_id: CHANNEL,
      thread_metadata: { archived: false },
    });
    gateway.dispatch(GatewayDispatchEvents.ThreadUpdate, {
      id: THREAD,
      parent_id: CHANNEL,
      thread_metadata: { archived: true },
    });
    await settle();
    expect(inbox.archived).toEqual([discordThread(THREAD, CHANNEL)]);
  });

  test('reports a deleted thread', async () => {
    const { gateway, inbox } = await listening();
    gateway.dispatch(GatewayDispatchEvents.ThreadDelete, {
      id: THREAD,
      parent_id: CHANNEL,
    });
    await settle();
    expect(inbox.deleted).toEqual([discordThread(THREAD, CHANNEL)]);
  });

  test("delivers a message from mate's guild, mentioning mate when it names the bot", async () => {
    const { gateway, inbox, ready } = await listening();
    await ready();
    gateway.dispatch(
      GatewayDispatchEvents.MessageCreate,
      gatewayMessage({ mentions: [{ id: BOT }] }),
    );
    gateway.dispatch(
      GatewayDispatchEvents.MessageCreate,
      gatewayMessage({ id: 'm-2', author: { id: OWNER, bot: true } }),
    );
    gateway.dispatch(
      GatewayDispatchEvents.MessageCreate,
      gatewayMessage({ id: 'm-3', guild_id: '2' }),
    );
    gateway.dispatch(
      GatewayDispatchEvents.MessageCreate,
      gatewayMessage({ id: 'm-4', guild_id: undefined }),
    );
    await settle();
    expect(inbox.messages).toEqual([
      {
        surface: 'discord',
        id: 'm-1',
        channelId: THREAD,
        threadId: THREAD,
        authorId: OWNER,
        authorIsBot: false,
        content: 'hello',
        mentionsMe: true,
      },
      {
        surface: 'discord',
        id: 'm-2',
        channelId: THREAD,
        threadId: THREAD,
        authorId: OWNER,
        authorIsBot: true,
        content: 'hello',
        mentionsMe: false,
      },
    ]);
  });

  test("turns a Stop press into its thread's key and presser, acked through the interaction", async () => {
    const { gateway, discord, inbox } = await listening();
    gateway.dispatch(GatewayDispatchEvents.InteractionCreate, stopPress());
    gateway.dispatch(
      GatewayDispatchEvents.InteractionCreate,
      stopPress({ id: 'i-2', member: undefined, user: { id: 'dm-user' } }),
    );
    await settle();
    expect(inbox.stops).toEqual([
      { key: discordKey(THREAD), userId: OWNER },
      { key: discordKey(THREAD), userId: 'dm-user' },
    ]);
    expect(discord.acks).toEqual(['i-1', 'i-2']);
  });

  test('ignores every interaction that is not a Stop button', async () => {
    const { gateway, discord, inbox } = await listening();
    gateway.dispatch(
      GatewayDispatchEvents.InteractionCreate,
      stopPress({ type: InteractionType.ApplicationCommand }),
    );
    gateway.dispatch(
      GatewayDispatchEvents.InteractionCreate,
      stopPress({
        data: {
          component_type: ComponentType.StringSelect,
          custom_id: `stop:${discordKey(THREAD)}`,
        },
      }),
    );
    gateway.dispatch(
      GatewayDispatchEvents.InteractionCreate,
      stopPress({
        data: { component_type: ComponentType.Button, custom_id: 'other' },
      }),
    );
    await settle();
    expect(inbox.stops).toEqual([]);
    expect(discord.acks).toEqual([]);
  });

  test('delivers nothing once stopped', async () => {
    const { gateway, discord, inbox, listener, ready } = await listening();
    await ready();
    listener.stop();
    gateway.dispatch(
      GatewayDispatchEvents.MessageCreate,
      gatewayMessage({ mentions: [{ id: BOT }] }),
    );
    gateway.dispatch(GatewayDispatchEvents.InteractionCreate, stopPress());
    gateway.dispatch(GatewayDispatchEvents.ThreadDelete, {
      id: THREAD,
      parent_id: CHANNEL,
    });
    await settle();
    expect(inbox.messages).toEqual([]);
    expect(inbox.stops).toEqual([]);
    expect(inbox.deleted).toEqual([]);
    expect(discord.acks).toEqual([]);
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
