import { describe, expect, test } from 'bun:test';
import { isQuietHours } from '../src/quiet-hours.ts';

describe('isQuietHours', () => {
  test('a window that wraps midnight covers both sides of it', () => {
    const tz = 'UTC';
    expect(
      isQuietHours(new Date('2026-01-01T23:30:00Z'), tz, '23:00', '08:00'),
    ).toBe(true);
    expect(
      isQuietHours(new Date('2026-01-01T07:59:00Z'), tz, '23:00', '08:00'),
    ).toBe(true);
    expect(
      isQuietHours(new Date('2026-01-01T08:00:00Z'), tz, '23:00', '08:00'),
    ).toBe(false);
    expect(
      isQuietHours(new Date('2026-01-01T12:00:00Z'), tz, '23:00', '08:00'),
    ).toBe(false);
  });

  test('a same-day window does not wrap', () => {
    const tz = 'UTC';
    expect(
      isQuietHours(new Date('2026-01-01T13:00:00Z'), tz, '12:00', '14:00'),
    ).toBe(true);
    expect(
      isQuietHours(new Date('2026-01-01T15:00:00Z'), tz, '12:00', '14:00'),
    ).toBe(false);
  });

  test('an equal start and end means no quiet hours at all', () => {
    expect(
      isQuietHours(new Date('2026-01-01T00:00:00Z'), 'UTC', '08:00', '08:00'),
    ).toBe(false);
  });

  test('converts to the given time zone before comparing', () => {
    // Halifax runs Atlantic Standard Time (UTC-4) in January: 11:30 UTC is
    // 07:30 there, inside the default window; the same instant in UTC is not.
    const at = new Date('2026-01-02T11:30:00Z');
    expect(isQuietHours(at, 'America/Halifax', '23:00', '08:00')).toBe(true);
    expect(isQuietHours(at, 'UTC', '23:00', '08:00')).toBe(false);
  });
});
