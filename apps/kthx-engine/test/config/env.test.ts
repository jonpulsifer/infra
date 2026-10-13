import { describe, expect, test } from 'bun:test';
import { engineEnvVar, readEnv } from '../../src/config/env.ts';

describe('readEnv', () => {
  test('reads the KTHX_ENGINE name', () => {
    expect(
      readEnv(
        { KTHX_ENGINE_HOSTNAME: 'a.example.test' },
        'KTHX_ENGINE_HOSTNAME',
      ),
    ).toBe('a.example.test');
  });

  test('ignores a SPINDRIFT name', () => {
    expect(
      readEnv({ SPINDRIFT_HOSTNAME: 'b.example.test' }, 'KTHX_ENGINE_HOSTNAME'),
    ).toBeUndefined();
  });
});

describe('engineEnvVar', () => {
  test('refuses a name outside the KTHX_ENGINE_ prefix', () => {
    expect(() => engineEnvVar('DATABASE_URL')).toThrow('KTHX_ENGINE_');
  });

  test('returns a declared name unchanged', () => {
    expect(engineEnvVar('KTHX_ENGINE_VERSION')).toBe('KTHX_ENGINE_VERSION');
  });
});
