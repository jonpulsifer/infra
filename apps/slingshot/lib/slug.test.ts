import { describe, expect, test } from 'bun:test';
import {
  isReservedSlug,
  normalizeSlugInput,
  projectSlugFromPathname,
  RESERVED_SLUGS,
  slugSchema,
} from './slug';

describe('isReservedSlug', () => {
  test('covers every top-level route the app serves', () => {
    for (const reserved of ['api', 'cache', 'environment', 'gcp', 'healthz']) {
      expect(isReservedSlug(reserved)).toBe(true);
    }
  });

  test('reserves healthz, not just health', () => {
    // The ingest route used to guard "health" while the route is /api/healthz,
    // so /api/healthz was reachable as a project slug.
    expect(isReservedSlug('healthz')).toBe(true);
    expect(isReservedSlug('health')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isReservedSlug('API')).toBe(true);
  });

  test('leaves ordinary names alone', () => {
    expect(isReservedSlug('my-webhook')).toBe(false);
  });
});

describe('slugSchema', () => {
  test('accepts a well-formed slug', () => {
    expect(slugSchema.safeParse('my-webhook-1').success).toBe(true);
  });

  test('rejects malformed slugs', () => {
    const invalid = [
      '-leading',
      'trailing-',
      'Upper',
      'has space',
      '',
      'x'.repeat(33),
    ];
    for (const input of invalid) {
      expect(slugSchema.safeParse(input).success).toBe(false);
    }
  });

  test('rejects every reserved name', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(slugSchema.safeParse(reserved).success).toBe(false);
    }
  });
});

describe('normalizeSlugInput', () => {
  test('lowercases, replaces separators, and collapses runs', () => {
    expect(normalizeSlugInput('My Cool  Hook!!')).toBe('my-cool-hook-');
  });

  test('truncates to the maximum length', () => {
    expect(normalizeSlugInput('a'.repeat(50))).toHaveLength(32);
  });

  test('leaves a trailing dash so the user can keep typing', () => {
    expect(normalizeSlugInput('half-')).toBe('half-');
  });
});

describe('projectSlugFromPathname', () => {
  test('returns the slug for a project page', () => {
    expect(projectSlugFromPathname('/my-hook')).toBe('my-hook');
  });

  test('returns null for the home page', () => {
    expect(projectSlugFromPathname('/')).toBeNull();
  });

  test('returns null for the app own routes', () => {
    for (const path of ['/gcp', '/cache', '/jwt-decoder', '/api/thing']) {
      expect(projectSlugFromPathname(path)).toBeNull();
    }
  });
});
