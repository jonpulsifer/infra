import { describe, expect, test } from 'bun:test';
import { readerTalosconfig } from '../src/talosconfig.ts';
import {
  ADMIN_CRT,
  READER_CRT,
  READER_OPERATOR_CRT,
  talosconfig,
} from './talos-certs.ts';

describe('the sandbox talosconfig', () => {
  test('passes a file whose every context is os:reader, as it was read', () => {
    const file = talosconfig({ folly: READER_CRT, offsite: READER_CRT });
    expect(readerTalosconfig(file)).toBe(file);
  });

  test('refuses a context with any other role, naming it', () => {
    expect(() =>
      readerTalosconfig(talosconfig({ folly: READER_CRT, offsite: ADMIN_CRT })),
    ).toThrow('context offsite grants os:admin, not os:reader alone');
    expect(() =>
      readerTalosconfig(talosconfig({ folly: READER_OPERATOR_CRT })),
    ).toThrow('context folly grants os:reader, os:operator');
  });

  test('refuses a file with no context or no certificate', () => {
    expect(() => readerTalosconfig('')).toThrow('holds no context');
    expect(() => readerTalosconfig('context: folly\ncontexts: {}\n')).toThrow(
      'holds no context',
    );
    expect(() =>
      readerTalosconfig('context: folly\ncontexts:\n  folly:\n    ca: eA==\n'),
    ).toThrow('context folly holds no client certificate');
    expect(() =>
      readerTalosconfig('context: folly\ncontexts:\n  folly:\n'),
    ).toThrow('context folly holds no client certificate');
  });

  test('refuses a certificate that does not parse', () => {
    expect(() =>
      readerTalosconfig(
        `contexts:\n  folly:\n    crt: ${Buffer.from('not a pem').toString('base64')}\n`,
      ),
    ).toThrow();
  });
});
