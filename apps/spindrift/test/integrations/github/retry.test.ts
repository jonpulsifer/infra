/**
 * The retry policy the source fetch opts into (`src/integrations/github/http.ts`).
 *
 * `GitHubHttp` classifies a refusal and deliberately does not act on it. These
 * tests are about the one place that acts: what is worth asking again, and the
 * one thing that never is.
 */
import { describe, expect, test } from 'bun:test';
import {
  GitHubAccessError,
  retryTransient,
  TRANSIENT_ATTEMPTS,
} from '../../../src/integrations/github/http.ts';

/** No real waiting; the delays are policy, the retrying is the behaviour. */
const slept: number[] = [];
const sleep = async (ms: number) => {
  slept.push(ms);
};

function refusal(code: 'ACCESS_LOST' | 'RATE_LIMITED' | 'UNAVAILABLE') {
  return new GitHubAccessError(code, 'GET', 'https://api/x', 503, '');
}

describe('retryTransient', () => {
  test('a transient refusal is asked again and its success returned', async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      calls += 1;
      if (calls < TRANSIENT_ATTEMPTS) throw refusal('UNAVAILABLE');
      return 'the archive';
    }, sleep);

    expect(result).toBe('the archive');
    expect(calls).toBe(TRANSIENT_ATTEMPTS);
  });

  test('a spent quota is transient — it is a delay, not lost access', async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      calls += 1;
      if (calls === 1) throw refusal('RATE_LIMITED');
      return 'the archive';
    }, sleep);

    expect(result).toBe('the archive');
    expect(calls).toBe(2);
  });

  test('a reset connection is retried, though it never became a status', async () => {
    // The failure this exists for: `fetch` throws partway through a large
    // archive, so there is no response to classify and no loop above to wait.
    let calls = 0;
    const result = await retryTransient(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('terminated');
      return 'the archive';
    }, sleep);

    expect(result).toBe('the archive');
    expect(calls).toBe(2);
  });

  test('lost access is never retried — it is §15’s freeze, not a blip', async () => {
    let calls = 0;
    const lost = refusal('ACCESS_LOST');

    await expect(
      retryTransient(async () => {
        calls += 1;
        throw lost;
      }, sleep),
    ).rejects.toBe(lost);

    expect(calls).toBe(1);
  });

  test('it gives up, and the last refusal is what the caller sees', async () => {
    let calls = 0;
    const last = refusal('UNAVAILABLE');

    await expect(
      retryTransient(async () => {
        calls += 1;
        throw calls < TRANSIENT_ATTEMPTS ? refusal('UNAVAILABLE') : last;
      }, sleep),
    ).rejects.toBe(last);

    expect(calls).toBe(TRANSIENT_ATTEMPTS);
  });
});
