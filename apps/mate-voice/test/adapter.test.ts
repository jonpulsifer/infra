import { describe, expect, test } from 'bun:test';
import type { DiscordGatewayAdapterLibraryMethods } from '@discordjs/voice';
import { relayAdapter } from '../src/adapter.ts';
import { silentLog } from '../src/log.ts';

function library() {
  const seen: string[] = [];
  const methods: DiscordGatewayAdapterLibraryMethods = {
    onVoiceStateUpdate: () => seen.push('state'),
    onVoiceServerUpdate: () => seen.push('server'),
    destroy: () => seen.push('destroy'),
  };
  return { methods, seen };
}

describe('relay adapter', () => {
  test('relays each payload to mate and reports the send', () => {
    const sent: unknown[] = [];
    const adapter = relayAdapter((payload) => {
      sent.push(payload);
      return sent.length < 2;
    }, silentLog);
    const { methods } = library();
    const implementer = adapter.creator(methods);
    expect(implementer.sendPayload({ op: 4 })).toBe(true);
    expect(implementer.sendPayload({ op: 4 })).toBe(false);
    expect(sent).toEqual([{ op: 4 }, { op: 4 }]);
    expect(adapter.attached).toBe(true);
    implementer.destroy();
    expect(adapter.attached).toBe(false);
  });

  test('holds a server update until the state update has been delivered', () => {
    const adapter = relayAdapter(() => true, silentLog);
    const { methods, seen } = library();
    adapter.creator(methods);
    adapter.onVoiceServerUpdate({ token: 't' });
    expect(seen).toEqual([]);
    adapter.onVoiceStateUpdate({ session_id: 's' });
    expect(seen).toEqual(['state', 'server']);
    adapter.onVoiceServerUpdate({ token: 'u' });
    expect(seen).toEqual(['state', 'server', 'server']);
  });

  test('drops dispatches before a connection exists and tells the library when mate is gone', () => {
    const adapter = relayAdapter(() => true, silentLog);
    adapter.onVoiceStateUpdate({});
    const { methods, seen } = library();
    adapter.creator(methods);
    adapter.destroy();
    expect(seen).toEqual(['destroy']);
    expect(adapter.attached).toBe(false);
    adapter.onVoiceStateUpdate({});
    expect(seen).toEqual(['destroy']);
  });
});
