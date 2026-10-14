import { describe, expect, test } from 'bun:test';
import {
  decodeFromBridge,
  decodeFromMate,
  encode,
  PROTOCOL_VERSION,
} from '../src/index.ts';

const GUILD = '444444444444444444';
const CHANNEL = '333333333333333333';
const OWNER = '222222222222222222';

describe('protocol', () => {
  test('decodes a join and keeps the dispatch data as sent', () => {
    expect(
      decodeFromMate(
        JSON.stringify({
          type: 'join',
          guildId: GUILD,
          channelId: CHANNEL,
          ownerId: OWNER,
        }),
      ),
    ).toEqual({
      type: 'join',
      guildId: GUILD,
      channelId: CHANNEL,
      ownerId: OWNER,
    });
    const server = decodeFromMate(
      JSON.stringify({
        type: 'voice_server',
        data: { guild_id: GUILD, token: 't', endpoint: 'x.discord.media:443' },
      }),
    );
    expect(server?.type).toBe('voice_server');
    expect(server && 'data' in server ? server.data.endpoint : null).toBe(
      'x.discord.media:443',
    );
  });

  test('refuses what is not a message', () => {
    expect(decodeFromMate('{')).toBeNull();
    expect(decodeFromMate(JSON.stringify({ type: 'dance' }))).toBeNull();
    expect(
      decodeFromMate(
        JSON.stringify({
          type: 'join',
          guildId: 'g',
          channelId: CHANNEL,
          ownerId: OWNER,
        }),
      ),
    ).toBeNull();
    expect(
      decodeFromBridge(JSON.stringify({ type: 'gateway', payload: {} })),
    ).toBeNull();
  });

  test('round-trips what the bridge sends', () => {
    const stall = {
      type: 'stall',
      reason: 'closed_by_discord',
      code: 4014,
    } as const;
    expect(decodeFromBridge(encode(stall))).toEqual(stall);
    const ready = {
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      version: '0.1.0',
    } as const;
    expect(decodeFromBridge(encode(ready))).toEqual(ready);
    expect(decodeFromBridge(encode({ type: 'state', call: null }))).toEqual({
      type: 'state',
      call: null,
    });
  });
});
