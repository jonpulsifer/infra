import { describe, expect, test } from 'bun:test';
import type { GatewaySendPayload } from 'discord-api-types/v10';
import {
  CLOSE_PROTOCOL,
  CLOSE_QUIET,
  CLOSE_REPLACED,
  CLOSE_RESTARTING,
  HEARTBEAT_MS,
  type LinkSocket,
  QUIET_BEATS,
  Voice,
  voiceCommand,
} from '../src/voice.ts';
import { FakeClock, RecordingLog } from './support.ts';

const GUILD = '1509024936717455381';
const TEXT = '1509024937422356532';
const VOICE = '1509024937422356999';
const OTHER_VOICE = '1509024937422356998';
const OWNER = '308072071949320204';
const FRIEND = '308072071949320205';
const BOT = '1509024936717455000';

class FakeSocket implements LinkSocket {
  readonly frames: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string): void {
    this.frames.push(JSON.parse(text));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  types(): string[] {
    return this.frames.map((frame) => frame.type as string);
  }
}

function harness(overrides: { allowedChannels?: string[] } = {}) {
  const clock = new FakeClock();
  const log = new RecordingLog();
  const sends: GatewaySendPayload[] = [];
  const posts: { channelId: string; line: string }[] = [];
  const voice = new Voice({
    guildId: GUILD,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set(overrides.allowedChannels ?? [TEXT, VOICE]),
    gateway: {
      send: async (payload) => {
        sends.push(payload);
      },
    },
    clock,
    log,
    post: async (channelId, line) => {
      posts.push({ channelId, line });
    },
  });
  const link = async () => {
    const socket = new FakeSocket();
    voice.attach(socket);
    await voice.receive(
      socket,
      JSON.stringify({ type: 'ready', protocol: 1, version: '0.1.0' }),
    );
    return socket;
  };
  const from = (socket: FakeSocket, message: Record<string, unknown>) =>
    voice.receive(socket, JSON.stringify(message));
  const state = (
    status: string,
    channelId = VOICE,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'state',
    call: {
      guildId: GUILD,
      channelId,
      ownerId: OWNER,
      status,
      ownerFrames: 0,
      resubscribes: 0,
      rejoins: 0,
      ...extra,
    },
  });
  return { clock, log, sends, posts, voice, link, from, state };
}

const op4 = (channelId: string | null) => ({
  op: 4,
  d: {
    guild_id: GUILD,
    channel_id: channelId,
    self_mute: false,
    self_deaf: false,
  },
});

describe('the voice link', () => {
  test('greets a bridge with hello, and a second bridge replaces the first', async () => {
    const { voice, link } = harness();
    const first = await link();
    expect(first.types()).toEqual(['hello']);
    expect(voice.ready).toBe(true);
    const second = new FakeSocket();
    voice.attach(second);
    expect(first.closed?.code).toBe(CLOSE_REPLACED);
    expect(voice.ready).toBe(false);
    expect(second.types()).toEqual(['hello']);
  });

  test('closes a bridge that speaks another protocol', async () => {
    const { voice, from, log } = harness();
    const socket = new FakeSocket();
    voice.attach(socket);
    await from(socket, { type: 'ready', protocol: 2, version: 'x' });
    expect(socket.closed?.code).toBe(CLOSE_PROTOCOL);
    expect(voice.ready).toBe(false);
    expect(log.of('voice: the bridge speaks another protocol')).toHaveLength(1);
  });

  test('beats on the cadence and ends a quiet link', async () => {
    const { voice, clock, link, from } = harness();
    const socket = await link();
    await clock.advance(HEARTBEAT_MS);
    await from(socket, { type: 'heartbeat' });
    await clock.advance(HEARTBEAT_MS);
    expect(socket.types()).toEqual(['hello', 'heartbeat', 'heartbeat']);
    expect(socket.closed).toBeNull();
    await clock.advance(HEARTBEAT_MS * (QUIET_BEATS + 1));
    expect(socket.closed?.code).toBe(CLOSE_QUIET);
    await voice.detach(socket);
    expect(voice.ready).toBe(false);
  });

  test('ignores frames from a socket it no longer holds', async () => {
    const { voice, link, from } = harness();
    const old = await link();
    await link();
    await from(old, { type: 'stall', reason: 'join_timeout' });
    expect(voice.current).toBeNull();
  });
});

describe('joining', () => {
  test('refuses in order: stranger, no bridge, not in voice, channel not allowed', async () => {
    const { voice, link } = harness({ allowedChannels: [TEXT] });
    expect(await voice.join(FRIEND, TEXT)).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await voice.join(OWNER, TEXT)).toEqual({
      ok: false,
      reason: 'bridge_not_ready',
    });
    await link();
    expect(await voice.join(OWNER, TEXT)).toEqual({
      ok: false,
      reason: 'not_in_voice',
    });
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: OWNER,
      channel_id: VOICE,
    } as never);
    expect(await voice.join(OWNER, TEXT)).toEqual({
      ok: false,
      reason: 'channel_not_allowed',
    });
  });

  test("asks the bridge for the owner's channel and relays its gateway sends", async () => {
    const { voice, link, from, sends, posts, state } = harness();
    const socket = await link();
    voice.onGuildCreate([{ user_id: OWNER, channel_id: VOICE } as never]);
    expect(await voice.join(OWNER, TEXT)).toEqual({ ok: true });
    expect(socket.frames.at(-1)).toEqual({
      type: 'join',
      guildId: GUILD,
      channelId: VOICE,
      ownerId: OWNER,
    });
    expect(voice.current?.status).toBe('joining');
    await from(socket, { type: 'gateway', payload: op4(VOICE) });
    expect(sends).toEqual([op4(VOICE)]);
    expect(await voice.join(OWNER, TEXT)).toEqual({
      ok: false,
      reason: 'already_there',
    });
    await from(socket, state('ready'));
    expect(posts).toEqual([
      { channelId: TEXT, line: 'joined the voice channel' },
    ]);
    await from(socket, state('destroyed'));
    await from(socket, { type: 'state', call: null });
    expect(voice.current).toBeNull();
    expect(posts.at(-1)?.line).toBe('left the voice channel');
  });

  test("relays only the bot's own voice state, and the voice server", async () => {
    const { voice, link } = harness();
    const socket = await link();
    await voice.onReady(BOT);
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: FRIEND,
      channel_id: VOICE,
    } as never);
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: BOT,
      channel_id: VOICE,
    } as never);
    voice.onVoiceServerUpdate({ guild_id: GUILD, token: 't', endpoint: 'e' });
    voice.onVoiceServerUpdate({ guild_id: '1', token: 't', endpoint: 'e' });
    expect(socket.types()).toEqual(['hello', 'voice_state', 'voice_server']);
  });
});

describe('leaving', () => {
  async function inCall() {
    const h = harness();
    const socket = await h.link();
    await h.voice.onReady(BOT);
    h.voice.onGuildCreate([
      { user_id: OWNER, channel_id: VOICE },
      { user_id: FRIEND, channel_id: VOICE },
    ] as never);
    await h.voice.join(OWNER, TEXT);
    await h.from(socket, h.state('ready'));
    return { ...h, socket };
  }

  test('on /leave, through the bridge', async () => {
    const { voice, socket } = await inCall();
    expect(await voice.leave(FRIEND)).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await voice.leave(OWNER)).toEqual({ ok: true });
    expect(socket.types().at(-1)).toBe('leave');
  });

  test('when the owner moves away', async () => {
    const { voice, socket } = await inCall();
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: OWNER,
      channel_id: OTHER_VOICE,
    } as never);
    expect(socket.types().at(-1)).toBe('leave');
  });

  test('when the channel empties, but not while a friend stays', async () => {
    const { voice, socket } = await inCall();
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: BOT,
      channel_id: VOICE,
    } as never);
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: FRIEND,
      channel_id: null,
    } as never);
    expect(socket.types().at(-1)).toBe('voice_state');
    await voice.onVoiceStateUpdate({
      guild_id: GUILD,
      user_id: OWNER,
      channel_id: null,
    } as never);
    expect(socket.types().at(-1)).toBe('leave');
  });

  test('sends the op 4 itself when the bridge is lost mid-call', async () => {
    const { voice, socket, sends, posts } = await inCall();
    await voice.detach(socket);
    expect(sends.at(-1)).toEqual(op4(null));
    expect(voice.current).toBeNull();
    expect(posts.at(-1)?.line).toContain('bridge went away');
  });

  test('on a stall, tells the channel and forgets the call', async () => {
    const { voice, socket, from, posts } = await inCall();
    await from(socket, { type: 'stall', reason: 'rejoin_cap' });
    expect(voice.current).toBeNull();
    expect(posts.at(-1)?.line).toBe('voice stalled: rejoin_cap');
  });

  test('a restart keeps the call on the bridge and says so', async () => {
    const { voice, socket, sends, posts } = await inCall();
    await voice.stop();
    expect(socket.closed?.code).toBe(CLOSE_RESTARTING);
    expect(
      sends.some(
        (payload) => payload.op === 4 && payload.d.channel_id === null,
      ),
    ).toBe(false);
    expect(posts.at(-1)?.line).toContain('restarting');
  });
});

describe('a held call', () => {
  test('is adopted from the bridge, and rejoined on a fresh gateway session', async () => {
    const { voice, link, from, state, sends } = harness();
    const socket = await link();
    await from(socket, state('ready'));
    expect(voice.current).toEqual({
      guildId: GUILD,
      channelId: VOICE,
      ownerId: OWNER,
      originChannelId: null,
      status: 'ready',
    });
    await voice.onReady(BOT);
    expect(sends).toEqual([op4(VOICE)]);
  });

  test("the old call's last state does not clobber a new join", async () => {
    const { voice, link, from, state } = harness();
    const socket = await link();
    voice.onGuildCreate([{ user_id: OWNER, channel_id: VOICE } as never]);
    await from(socket, state('ready', OTHER_VOICE));
    await voice.join(OWNER, TEXT);
    await from(socket, state('destroyed', OTHER_VOICE));
    expect(voice.current?.channelId).toBe(VOICE);
    await from(socket, state('joining'));
    expect(voice.current?.status).toBe('joining');
  });
});

describe('a mention', () => {
  test('is a voice command only when it says just join or leave', () => {
    expect(voiceCommand(`<@${BOT}> join`, BOT)).toBe('join');
    expect(voiceCommand(`<@!${BOT}>  Leave `, BOT)).toBe('leave');
    expect(voiceCommand(`<@${BOT}> join us for dinner`, BOT)).toBeNull();
    expect(voiceCommand('join', BOT)).toBe('join');
  });
});
