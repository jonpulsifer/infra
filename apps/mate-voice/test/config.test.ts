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
