import { describe, expect, test } from 'bun:test';
import { readConfig } from '../src/config.ts';

const minimal = {
  ELEVENLABS_API_KEY: 'key',
  SWITCHBOARD_AGENT_ID: 'agent_1',
  SWITCHBOARD_PHONE_NUMBER_ID: 'phnum_1',
  SWITCHBOARD_TO_NUMBER: '+19025551234',
  SWITCHBOARD_RING_TOKEN: 'ring-token',
  SWITCHBOARD_ALERT_TOKEN: 'alert-token',
};

describe('config from the environment', () => {
  test('applies the contract defaults', () => {
    const config = readConfig(minimal);
    expect(config.ringDailyCap).toBe(3);
    expect(config.alertDailyCap).toBe(3);
    expect(config.cooldownMs).toBe(10 * 60_000);
    expect(config.quietStart).toBe('23:00');
    expect(config.quietEnd).toBe('08:00');
    expect(config.quietTz).toBe('America/Halifax');
    expect(config.port).toBe(8080);
  });

  test('fails fast when a required value is missing', () => {
    for (const key of Object.keys(minimal)) {
      expect(() => readConfig({ ...minimal, [key]: '' })).toThrow(
        `${key} is required`,
      );
    }
  });

  test('refuses a destination number that is not E.164', () => {
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_TO_NUMBER: '9025551234' }),
    ).toThrow('E.164');
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_TO_NUMBER: '+1abc' }),
    ).toThrow('E.164');
  });

  test('never puts the bad destination number in the thrown message', () => {
    const bad = '902-555-0142';
    try {
      readConfig({ ...minimal, SWITCHBOARD_TO_NUMBER: bad });
      throw new Error('expected readConfig to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });

  test('refuses a non-integer or too-low cap and cooldown', () => {
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_RING_DAILY_CAP: '0' }),
    ).toThrow('SWITCHBOARD_RING_DAILY_CAP');
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_ALERT_DAILY_CAP: 'lots' }),
    ).toThrow('SWITCHBOARD_ALERT_DAILY_CAP');
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_COOLDOWN_MINUTES: 'ten' }),
    ).toThrow('SWITCHBOARD_COOLDOWN_MINUTES');
  });

  test('refuses malformed quiet hours', () => {
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_QUIET_START: '11pm' }),
    ).toThrow('SWITCHBOARD_QUIET_START');
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_QUIET_END: '25:00' }),
    ).toThrow('SWITCHBOARD_QUIET_END');
    expect(() =>
      readConfig({ ...minimal, SWITCHBOARD_QUIET_TZ: 'Mars/Olympus' }),
    ).toThrow('SWITCHBOARD_QUIET_TZ');
  });

  test('takes every override', () => {
    const config = readConfig({
      ...minimal,
      SWITCHBOARD_RING_DAILY_CAP: '5',
      SWITCHBOARD_ALERT_DAILY_CAP: '1',
      SWITCHBOARD_COOLDOWN_MINUTES: '2',
      SWITCHBOARD_QUIET_START: '22:00',
      SWITCHBOARD_QUIET_END: '07:30',
      SWITCHBOARD_QUIET_TZ: 'UTC',
      SWITCHBOARD_PORT: '9090',
    });
    expect(config.ringDailyCap).toBe(5);
    expect(config.alertDailyCap).toBe(1);
    expect(config.cooldownMs).toBe(2 * 60_000);
    expect(config.quietStart).toBe('22:00');
    expect(config.quietEnd).toBe('07:30');
    expect(config.quietTz).toBe('UTC');
    expect(config.port).toBe(9090);
  });
});
