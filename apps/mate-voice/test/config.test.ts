import { describe, expect, test } from 'bun:test';
import { ConfigError, readConfig } from '../src/config.ts';

describe('config', () => {
  test('needs mate and takes the defaults', () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(() => readConfig({ MATE_VOICE_MATE_URL: 'http://mate' })).toThrow(
      'ws(s) URL',
    );
    const config = readConfig({ MATE_VOICE_MATE_URL: 'ws://mate:8080/voice' });
    expect(config.port).toBe(8080);
    expect(config.rejoinCap).toBe(3);
    expect(config.orphanMs).toBe(30_000);
  });

  test('ElevenLabs is off until both the engine id and the key file are set', () => {
    const base = { MATE_VOICE_MATE_URL: 'ws://mate:8080/voice' };
    expect(readConfig(base).elevenlabs).toBeNull();
    expect(() =>
      readConfig({ ...base, MATE_VOICE_ELEVENLABS_ENGINE_ID: 'seng_1' }),
    ).toThrow('go together');
    expect(() =>
      readConfig({
        ...base,
        MATE_VOICE_ELEVENLABS_ENGINE_ID: 'agent_1',
        MATE_VOICE_ELEVENLABS_KEY_FILE: '/k',
      }),
    ).toThrow('seng_');
    expect(
      readConfig({
        ...base,
        MATE_VOICE_ELEVENLABS_ENGINE_ID: 'seng_1',
        MATE_VOICE_ELEVENLABS_KEY_FILE: '/k',
      }).elevenlabs,
    ).toEqual({
      api: 'https://api.elevenlabs.io',
      engineId: 'seng_1',
      keyFile: '/k',
    });
    expect(() =>
      readConfig({
        ...base,
        MATE_VOICE_ELEVENLABS_ENGINE_ID: 'seng_1',
        MATE_VOICE_ELEVENLABS_KEY_FILE: '/k',
        MATE_VOICE_ELEVENLABS_API: 'http://plain',
      }),
    ).toThrow('https');
  });

  test('refuses a cap that is not a count', () => {
    expect(() =>
      readConfig({
        MATE_VOICE_MATE_URL: 'ws://mate:8080/voice',
        MATE_VOICE_REJOIN_CAP: '-1',
      }),
    ).toThrow(ConfigError);
    expect(
      readConfig({
        MATE_VOICE_MATE_URL: 'ws://mate:8080/voice',
        MATE_VOICE_REJOIN_CAP: '0',
      }).rejoinCap,
    ).toBe(0);
  });
});
