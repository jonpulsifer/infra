import { describe, expect, test } from 'bun:test';
import {
  type AudioPlayer,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { relayAdapter } from '../src/adapter.ts';
import { Call } from '../src/call.ts';
import { silentLog } from '../src/log.ts';
import { Playback } from '../src/playback.ts';
import type { CallState, StallReason } from '../src/protocol.ts';
import { CHANNEL, FakePlayer, fakeConnect, GUILD, OWNER } from './fakes.ts';

function setup(overrides: { rejoinCap?: number; joinTimeoutMs?: number } = {}) {
  const sent: unknown[] = [];
  const states: CallState[] = [];
  const stalls: { reason: StallReason; code?: number }[] = [];
  const adapter = relayAdapter((payload) => {
    sent.push(payload);
    return true;
  }, silentLog);
  const { connect, connections } = fakeConnect();
  const player = new FakePlayer();
  const call = new Call({
    guildId: GUILD,
    channelId: CHANNEL,
    ownerId: OWNER,
    adapter,
    log: silentLog,
    joinTimeoutMs: overrides.joinTimeoutMs ?? 1_000,
    rejoinCap: overrides.rejoinCap ?? 2,
    resubscribeCap: 1,
    onState: (state) => states.push(state),
    onStall: (reason, code) => stalls.push({ reason, code }),
    onFrame: () => {},
    connect,
    playback: new Playback(player as unknown as AudioPlayer),
  });
  const joining = call.join();
  joining.catch(() => {});
  const connection = connections[0];
  if (!connection) throw new Error('no connection');
  return { call, joining, connection, sent, states, stalls, player };
}

describe('call', () => {
  test('joins through mate, hears the owner alone, and plays the tone', async () => {
    const { call, joining, connection, sent, states, player } = setup();
    expect(sent).toEqual([
      { op: 4, d: { guild_id: GUILD, channel_id: CHANNEL } },
    ]);
    expect(connection.subscribed).toBe(1);
    connection.go(VoiceConnectionStatus.Connecting);
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    expect(connection.asked).toEqual([OWNER]);
    expect(player.played).toBe(1);
    expect(call.state().status).toBe('ready');
    connection.streams[0]?.write(Buffer.alloc(10));
    await Bun.sleep(5);
    expect(call.state().ownerFrames).toBe(1);
    expect(states.map((s) => s.status)).toEqual(['joining', 'ready']);
  });

  test('ends on a close code the library would otherwise rejoin after', async () => {
    const { call, joining, connection, sent, stalls } = setup();
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    connection.networking.emit('close', 4022);
    expect(stalls).toEqual([{ reason: 'closed_by_discord', code: 4022 }]);
    expect(connection.destroyed).toEqual([true]);
    expect(sent.at(-1)).toEqual({
      op: 4,
      d: { guild_id: GUILD, channel_id: null },
    });
    expect(call.state().status).toBe('destroyed');
    connection.networking.emit('close', 4014);
    expect(stalls.length).toBe(1);
  });

  test('ends when Discord disconnects it', async () => {
    const { joining, connection, stalls } = setup();
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    connection.go(VoiceConnectionStatus.Disconnected, {
      reason: VoiceConnectionDisconnectReason.WebSocketClose,
      closeCode: 4014,
    });
    expect(stalls).toEqual([{ reason: 'closed_by_discord', code: 4014 }]);
    expect(connection.destroyed).toEqual([true]);
  });

  test('caps the rejoins the library makes on its own', async () => {
    const { call, joining, connection, stalls } = setup({ rejoinCap: 1 });
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    connection.rejoinAttempts = 1;
    connection.go(VoiceConnectionStatus.Signalling);
    expect(call.state()).toMatchObject({ status: 'reconnecting', rejoins: 1 });
    connection.go(VoiceConnectionStatus.Connecting);
    connection.go(VoiceConnectionStatus.Ready);
    expect(call.state().status).toBe('ready');
    connection.rejoinAttempts = 2;
    connection.go(VoiceConnectionStatus.Signalling);
    expect(stalls).toEqual([{ reason: 'rejoin_cap', code: undefined }]);
    expect(call.state().status).toBe('destroyed');
  });

  test('rejoins itself after a dropped endpoint, up to the cap', async () => {
    const { joining, connection, stalls } = setup({ rejoinCap: 1 });
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    connection.go(VoiceConnectionStatus.Disconnected, {
      reason: VoiceConnectionDisconnectReason.EndpointRemoved,
    });
    expect(connection.rejoins).toBe(1);
    expect(stalls).toEqual([]);
    connection.go(VoiceConnectionStatus.Ready);
    connection.go(VoiceConnectionStatus.Disconnected, {
      reason: VoiceConnectionDisconnectReason.EndpointRemoved,
    });
    expect(connection.rejoins).toBe(1);
    expect(stalls).toEqual([{ reason: 'rejoin_cap', code: undefined }]);
  });

  test('a join that never becomes ready ends the call', async () => {
    const { joining, connection, stalls } = setup({ joinTimeoutMs: 20 });
    await expect(joining).rejects.toThrow('did not become ready');
    expect(stalls).toEqual([{ reason: 'join_timeout', code: undefined }]);
    expect(connection.destroyed).toEqual([true]);
  });

  test('leaving is not a stall', async () => {
    const { call, joining, connection, stalls, states, player } = setup();
    connection.go(VoiceConnectionStatus.Ready);
    await joining;
    call.leave();
    call.leave();
    expect(connection.destroyed).toEqual([true]);
    expect(call.adapter.attached).toBe(false);
    expect(stalls).toEqual([]);
    expect(states.at(-1)?.status).toBe('destroyed');
    expect(player.stops).toEqual([true]);
    expect(connection.streams[0]?.destroyed).toBe(true);
  });
});
