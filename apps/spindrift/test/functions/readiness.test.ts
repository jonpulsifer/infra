/**
 * `probeUrl` (`functions/readiness.ts`).
 *
 * Every case is a fake fetcher rather than a real one: what this module
 * decides is entirely a function of what `fetch` returned or threw, and a
 * real network call would only make that decision flaky.
 */
import { describe, expect, test } from 'bun:test';
import { probeUrl } from '../../src/functions/readiness.ts';

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const now = () => FROZEN;

describe('probeUrl', () => {
  test('a 200 is ready', async () => {
    const result = await probeUrl('https://fn.example.test', {
      now,
      fetch: async () => new Response('ok', { status: 200 }),
    });
    expect(result).toEqual({
      ready: true,
      detail: 'answering HTTP 200',
      checkedAt: FROZEN.toISOString(),
    });
  });

  test('a 404 is still ready — the platform answered, just not with a hit', async () => {
    const result = await probeUrl('https://fn.example.test', {
      now,
      fetch: async () => new Response('not found', { status: 404 }),
    });
    expect(result.ready).toBe(true);
    expect(result.detail).toBe('answering HTTP 404');
  });

  test('a certificate error names what is still happening', async () => {
    const result = await probeUrl('https://fn.example.test', {
      now,
      fetch: async () => {
        throw new TypeError('unknown certificate verification error');
      },
    });
    expect(result).toEqual({
      ready: false,
      detail:
        'the edge is still issuing the TLS certificate for a new hostname — usually a few minutes',
      checkedAt: FROZEN.toISOString(),
    });
  });

  test('an aborted fetch reads as a timeout', async () => {
    const result = await probeUrl('https://fn.example.test', {
      now,
      fetch: async () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      },
    });
    expect(result).toEqual({
      ready: false,
      detail: 'no answer within 8s',
      checkedAt: FROZEN.toISOString(),
    });
  });

  test('any other thrown error is read as-is', async () => {
    const result = await probeUrl('https://fn.example.test', {
      now,
      fetch: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result).toEqual({
      ready: false,
      detail: 'connection refused',
      checkedAt: FROZEN.toISOString(),
    });
  });
});
