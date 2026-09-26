import { describe, expect, test } from 'bun:test';
import { readBoardConfig } from '../src/board/config.ts';
import { readRole } from '../src/role.ts';

const minimal = {
  SWITCHBOARD_ARI_URL: 'http://pbx-metrics.pbx.svc.cluster.local:8088',
  SWITCHBOARD_ARI_USER: 'switchboard',
  SWITCHBOARD_ARI_PASSWORD: 'hunter2hunter2',
};

describe('the role', () => {
  test('is ring unless set, so the offsite ringer needs no change', () => {
    expect(readRole({})).toBe('ring');
    expect(readRole({ SWITCHBOARD_ROLE: ' ' })).toBe('ring');
    expect(readRole({ SWITCHBOARD_ROLE: 'board' })).toBe('board');
    expect(() => readRole({ SWITCHBOARD_ROLE: 'boss' })).toThrow(
      'SWITCHBOARD_ROLE',
    );
  });
});

describe('board config from the environment', () => {
  test('applies the defaults', () => {
    expect(readBoardConfig(minimal)).toEqual({
      ariUrl: 'http://pbx-metrics.pbx.svc.cluster.local:8088',
      ariUser: 'switchboard',
      ariPassword: 'hunter2hunter2',
      pjsipConf: '/etc/switchboard/pjsip.conf',
      recentLimit: 25,
      port: 8080,
    });
  });

  test('fails fast when a required value is missing', () => {
    for (const key of Object.keys(minimal)) {
      expect(() => readBoardConfig({ ...minimal, [key]: '' })).toThrow(
        `${key} is required`,
      );
    }
  });

  test('refuses a URL that could carry the credential, and never repeats it', () => {
    const bad = [
      'http://switchboard:hunter2hunter2@pbx:8088',
      'http://pbx:8088/ari?api_key=switchboard:hunter2hunter2',
      'ftp://pbx:8088',
      'not a url',
    ];
    for (const url of bad) {
      try {
        readBoardConfig({ ...minimal, SWITCHBOARD_ARI_URL: url });
        throw new Error(`accepted ${url}`);
      } catch (error) {
        expect((error as Error).message).toStartWith('SWITCHBOARD_ARI_URL');
        expect((error as Error).message).not.toContain('hunter2');
      }
    }
  });

  test('takes every override', () => {
    expect(
      readBoardConfig({
        ...minimal,
        SWITCHBOARD_ARI_URL: 'https://pbx.example:8089/',
        SWITCHBOARD_PJSIP_CONF: '/tmp/pjsip.conf',
        SWITCHBOARD_RECENT: '5',
        SWITCHBOARD_PORT: '9090',
      }),
    ).toMatchObject({
      ariUrl: 'https://pbx.example:8089',
      pjsipConf: '/tmp/pjsip.conf',
      recentLimit: 5,
      port: 9090,
    });
    expect(() =>
      readBoardConfig({ ...minimal, SWITCHBOARD_RECENT: '0' }),
    ).toThrow('SWITCHBOARD_RECENT');
  });
});
