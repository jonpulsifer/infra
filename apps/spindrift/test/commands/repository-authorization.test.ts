import { describe, expect, test } from 'bun:test';
import {
  beginRepositoryAuthorization,
  pollRepositoryAuthorization,
} from '../../src/commands/repositories/authorize.ts';
import type { RepositoryAuthorization } from '../../src/domain/repository.ts';
import { unreachableContext } from '../harness/context.ts';

const base = await unreachableContext();
const EXPIRES = new Date('2026-07-30T12:15:00.000Z');

function context(authorization: RepositoryAuthorization | null) {
  return {
    ...base,
    principal: { id: 'operator-id', displayName: 'Operator' },
    adapters: {
      ...base.adapters,
      repositoryAuthorization: () => authorization,
    },
  };
}

describe('repository authorization commands', () => {
  test('binds a new Device Flow attempt to the authenticated principal', async () => {
    let begunFor: string | null = null;
    const authorization: RepositoryAuthorization = {
      status: async () => ({ state: 'unauthorized' }),
      begin: async (userId) => {
        begunFor = userId;
        return {
          attemptId: '33a7b26a-230b-4b4d-a0d0-653eda86be98',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.example.test/login/device',
          expiresAt: EXPIRES,
          intervalSeconds: 5,
        };
      },
      poll: async () => ({ state: 'expired' }),
      repositories: async () => [],
      installationFor: async () => ({ installationId: 'not-used' }),
    };

    const result = await beginRepositoryAuthorization(
      {},
      context(authorization),
    );
    expect(String(begunFor)).toBe('operator-id');
    expect(result).toEqual({
      ok: true,
      value: {
        attemptId: '33a7b26a-230b-4b4d-a0d0-653eda86be98',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.example.test/login/device',
        expiresAt: EXPIRES.toISOString(),
        intervalSeconds: 5,
      },
    });
  });

  test('polls only as the authenticated principal and serializes dates', async () => {
    let polled: readonly string[] | null = null;
    const authorization: RepositoryAuthorization = {
      status: async () => ({ state: 'unauthorized' }),
      begin: async () => {
        throw new Error('not reached');
      },
      poll: async (userId, attemptId) => {
        polled = [userId, attemptId];
        return {
          state: 'pending',
          retryAfterSeconds: 7,
          expiresAt: EXPIRES,
        };
      },
      repositories: async () => [],
      installationFor: async () => ({ installationId: 'not-used' }),
    };

    const result = await pollRepositoryAuthorization(
      { attemptId: '33a7b26a-230b-4b4d-a0d0-653eda86be98' },
      context(authorization),
    );
    expect((polled ?? []) as readonly string[]).toEqual([
      'operator-id',
      '33a7b26a-230b-4b4d-a0d0-653eda86be98',
    ]);
    expect(result).toEqual({
      ok: true,
      value: {
        state: 'pending',
        retryAfterSeconds: 7,
        expiresAt: EXPIRES.toISOString(),
      },
    });
  });

  test('refuses when the encrypted connector is not configured', async () => {
    const result = await beginRepositoryAuthorization({}, context(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_DEPLOYABLE');
  });
});
