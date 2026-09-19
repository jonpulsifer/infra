import { describe, expect, test } from 'bun:test';
import { readConfig } from '../src/config.ts';

const minimal = {
  DISCORD_TOKEN: 'token',
  MATE_GUILD_ID: '1509024936717455381',
  MATE_ALLOWED_USER_IDS: '308072071949320204',
  MATE_ALLOWED_CHANNEL_IDS: '1509024937422356532, 1509024937422356533',
};

describe('config from the environment', () => {
  test('applies the contract defaults', () => {
    const config = readConfig(minimal);
    expect(config.quietMs).toBe(15 * 60_000);
    expect(config.maxTurnsPerThread).toBe(30);
    expect(config.maxTurnsPerDay).toBe(120);
    expect(config.maxConcurrent).toBe(3);
    expect(config.port).toBe(8080);
    expect(config.sessionFile).toBeNull();
    expect([...config.allowedChannelIds]).toEqual([
      '1509024937422356532',
      '1509024937422356533',
    ]);
  });

  test('refuses a missing token, an empty allowlist, and a non-snowflake id', () => {
    expect(() => readConfig({ ...minimal, DISCORD_TOKEN: '' })).toThrow(
      'DISCORD_TOKEN is required',
    );
    expect(() =>
      readConfig({ ...minimal, MATE_ALLOWED_USER_IDS: ' , ' }),
    ).toThrow('MATE_ALLOWED_USER_IDS is empty');
    expect(() =>
      readConfig({ ...minimal, MATE_ALLOWED_CHANNEL_IDS: 'general' }),
    ).toThrow('non-snowflake');
  });

  test('refuses a non-positive number', () => {
    expect(() => readConfig({ ...minimal, MATE_QUIET_MINUTES: '0' })).toThrow(
      'MATE_QUIET_MINUTES',
    );
    expect(() =>
      readConfig({ ...minimal, MATE_MAX_CONCURRENT: 'three' }),
    ).toThrow('MATE_MAX_CONCURRENT');
  });

  test('answers threads with the stub unless told otherwise', () => {
    expect(readConfig(minimal).sandboxes).toEqual({ mode: 'stub' });
    expect(() =>
      readConfig({ ...minimal, MATE_SANDBOXES: 'kubernetes' }),
    ).toThrow('MATE_SANDBOXES must be stub or kube');
  });

  test('kube mode needs a harness image and takes the sandbox defaults', () => {
    expect(() => readConfig({ ...minimal, MATE_SANDBOXES: 'kube' })).toThrow(
      'MATE_SANDBOX_IMAGE is required',
    );
    const config = readConfig({
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    });
    expect(config.sandboxes).toEqual({
      mode: 'kube',
      sandbox: {
        image: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
        runtimeClass: 'kata-clh',
        namespace: null,
        secret: 'mate-opencode',
        checkoutRepo: 'https://github.com/jonpulsifer/infra',
        checkoutRef: 'main',
        model: 'opencode-go/qwen3.8-flash',
      },
    });
  });
});
