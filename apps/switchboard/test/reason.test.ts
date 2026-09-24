import { describe, expect, test } from 'bun:test';
import { REASON_MAX_LEN, sanitizeReason } from '../src/reason.ts';

describe('sanitizeReason', () => {
  test('passes a short printable string through, trimmed', () => {
    expect(sanitizeReason('  server is on fire  ')).toBe('server is on fire');
  });

  test('strips control characters and non-ASCII text', () => {
    expect(sanitizeReason('call\x00me\nnow\u{1F525}')).toBe('callmenow');
  });

  test('caps the length', () => {
    const long = 'x'.repeat(REASON_MAX_LEN + 50);
    const sanitized = sanitizeReason(long);
    expect(sanitized).toHaveLength(REASON_MAX_LEN);
    expect(sanitized).toBe(long.slice(0, REASON_MAX_LEN));
  });

  test('a non-string input becomes an empty reason', () => {
    expect(sanitizeReason(undefined)).toBe('');
    expect(sanitizeReason(null)).toBe('');
    expect(sanitizeReason(42)).toBe('');
    expect(sanitizeReason({ inject: true })).toBe('');
    expect(sanitizeReason(['a'])).toBe('');
  });
});
