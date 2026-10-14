import { describe, expect, test } from 'bun:test';
import { type AudioPlayer, VoiceConnectionStatus } from '@discordjs/voice';
import { Bridge, VERSION } from '../src/bridge.ts';
import type { Config } from '../src/config.ts';
import { Playback } from '../src/playback.ts';
import { type FromBridge, PROTOCOL_VERSION } from '../src/protocol.ts';
import {
  CHANNEL,
  capturingLog,
  FakePlayer,
  fakeConnect,
  GUILD,
  OWNER,
} from './fakes.ts';

const config: Config = {
  mateUrl: 'ws://mate/voice',
  port: 0,
  heartbeatMs: 1_000,
  connectTimeoutMs: 1_000,
  joinTimeoutMs: 1_000,
  rejoinCap: 1,
  resubscribeCap: 1,
  orphanMs: 30,
};

function setup() {
  const sent: FromBridge[] = [];
  const log = capturingLog();
  const { connect, connections } = fakeConnect();
  const player = new FakePlayer();
  const bridge = new Bridge({
    config,
    link: {
      send: (message) => {
        sent.push(message);
        return true;
      },
    },
    log,
    connect,
    playback: () => new Playback(player as unknown as AudioPlayer),
    joinTone: null,
  });
  return { bridge, sent, log, connections, player };
}

const join = {
  type: 'join',
  guildId: GUILD,
  channelId: CHANNEL,
  ownerId: OWNER,
} as const;

describe('bridge', () => {
  test('announces itself on each link and complains about another protocol', async () => {
    const { bridge, sent, log } = setup();
    bridge.onLinkOpen();
    expect(sent).toEqual([
      { type: 'ready', protocol: PROTOCOL_VERSION, version: VERSION },
    ]);
    await bridge.onMessage({ type: 'hello', protocol: PROTOCOL_VERSION + 1 });
    expect(log.lines.filter((l) => l.level === 'error').length).toBe(1);
    await bridge.onMessage({ type: 'hello', protocol: PROTOCOL_VERSION });
    expect(log.lines.filter((l) => l.level === 'error').length).toBe(1);
  });

  test('runs a call from join to leave, relaying the gateway both ways', async () => {
    const { bridge, sent, connections, player } = setup();
    const joining = bridge.onMessage(join);
    const connection = connections[0];
    if (!connection) throw new Error('no connection');
    expect(bridge.inCall).toBe(true);
    expect(sent[0]).toEqual({
      type: 'gateway',
      payload: { op: 4, d: { guild_id: GUILD, channel_id: CHANNEL } },
    });
    await bridge.onMessage({ type: 'voice_server', data: { guild_id: GUILD } });
    await bridge.onMessage({ type: 'voice_state', data: { guild_id: GUILD } });
    expect(connection.dispatches).toEqual(['state', 'server']);
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    expect(sent.filter((m) => m.type === 'state').at(-1)).toMatchObject({
      call: { status: 'ready', ownerId: OWNER },
    });
    await bridge.onMessage({ type: 'speak', text: 'on it', final: true });
    await bridge.onMessage({ type: 'announce', text: 'done' });
    expect(bridge.unvoicedChars).toBe(9);
    expect(player.stops).toEqual([]);
    await bridge.onMessage({ type: 'stop_playback' });
    expect(player.stops).toEqual([]);
    await bridge.onMessage({ type: 'leave' });
    expect(bridge.inCall).toBe(false);
    expect(connection.destroyed).toEqual([true]);
    const states = sent.filter((m) => m.type === 'state');
    expect(states.at(-2)).toMatchObject({ call: { status: 'destroyed' } });
    expect(states.at(-1)).toEqual({ type: 'state', call: null });
    expect(sent.filter((m) => m.type === 'stall')).toEqual([]);
  });

  test('a second join replaces the first', async () => {
    const { bridge, connections } = setup();
    void bridge.onMessage(join);
    connections[0]?.go(VoiceConnectionStatus.Ready);
    await Bun.sleep(1);
    void bridge.onMessage(join);
    expect(connections[0]?.destroyed).toEqual([true]);
    expect(connections.length).toBe(2);
    connections[1]?.go(VoiceConnectionStatus.Ready);
    await Bun.sleep(1);
    expect(bridge.inCall).toBe(true);
  });

  test('leaves a call whose mate stays away, and sends state on a relink', async () => {
    const { bridge, sent, connections } = setup();
    void bridge.onMessage(join);
    connections[0]?.go(VoiceConnectionStatus.Ready);
    await Bun.sleep(1);
    bridge.onLinkClose();
    bridge.onLinkOpen();
    expect(sent.at(-1)).toMatchObject({
      type: 'state',
      call: { status: 'ready' },
    });
    expect(connections[0]?.destroyed).toEqual([]);
    bridge.onLinkClose();
    await Bun.sleep(60);
    expect(connections[0]?.destroyed).toEqual([true]);
    expect(bridge.inCall).toBe(false);
  });

  test('stop ends the call without a stall', async () => {
    const { bridge, sent, connections } = setup();
    void bridge.onMessage(join);
    connections[0]?.go(VoiceConnectionStatus.Ready);
    await Bun.sleep(1);
    bridge.stop();
    expect(connections[0]?.destroyed).toEqual([true]);
    expect(sent.filter((m) => m.type === 'stall')).toEqual([]);
  });
});
