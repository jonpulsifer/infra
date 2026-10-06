import { describe, expect, test } from 'bun:test';
import {
  assertEnvConsistent,
  EnvConflictError,
  legacyEnvName,
  readEnv,
} from '../../src/config/env.ts';

describe('readEnv', () => {
  test('the new name wins over the old one', () => {
    expect(
      readEnv(
        { KTHX_ENGINE_HOSTNAME: 'a.example.test', SPINDRIFT_HOSTNAME: '' },
        'KTHX_ENGINE_HOSTNAME',
      ),
    ).toBe('a.example.test');
  });

  test('falls back to the old name when the new one is unset or blank', () => {
    expect(
      readEnv({ SPINDRIFT_HOSTNAME: 'b.example.test' }, 'KTHX_ENGINE_HOSTNAME'),
    ).toBe('b.example.test');
    expect(
      readEnv(
        { KTHX_ENGINE_HOSTNAME: '  ', SPINDRIFT_HOSTNAME: 'b.example.test' },
        'KTHX_ENGINE_HOSTNAME',
      ),
    ).toBe('b.example.test');
    expect(readEnv({}, 'KTHX_ENGINE_HOSTNAME')).toBeUndefined();
  });

  test('both names agreeing is not a conflict', () => {
    expect(
      readEnv(
        { KTHX_ENGINE_VERSION: 'v1', SPINDRIFT_VERSION: ' v1 ' },
        'KTHX_ENGINE_VERSION',
      ),
    ).toBe('v1');
  });

  test('both names set and differing throws, naming both and neither value', () => {
    const read = () =>
      readEnv(
        {
          KTHX_ENGINE_BOSUN_SECRET: 'new-value',
          SPINDRIFT_BOSUN_SECRET: 'old-value',
        },
        'KTHX_ENGINE_BOSUN_SECRET',
      );
    expect(read).toThrow(EnvConflictError);
    expect(read).toThrow(/KTHX_ENGINE_BOSUN_SECRET and SPINDRIFT_BOSUN_SECRET/);
    expect(read).not.toThrow(/new-value|old-value/);
  });

  test('refuses a name outside the engine prefix', () => {
    expect(() => legacyEnvName('DATABASE_URL')).toThrow('KTHX_ENGINE_');
  });
});

describe('assertEnvConsistent', () => {
  test('passes an environment with only one name of each variable', () => {
    expect(() =>
      assertEnvConsistent({
        KTHX_ENGINE_HOSTNAME: 'a.example.test',
        SPINDRIFT_ENROLMENT_TOKEN: 'token',
        DATABASE_URL: 'postgres://example.test/db',
      }),
    ).not.toThrow();
  });

  test('fails boot on any old name that disagrees with its new one', () => {
    expect(() =>
      assertEnvConsistent({
        KTHX_ENGINE_KTHX_ZONE: 'kthx.dev',
        SPINDRIFT_KTHX_ZONE: 'kthx.test',
      }),
    ).toThrow(/KTHX_ENGINE_KTHX_ZONE and SPINDRIFT_KTHX_ZONE/);
  });
});
