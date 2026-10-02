/**
 * One kthx site, read through the engine. The command reaches no database:
 * kthx holds every fact it returns.
 */
import { describe, expect, test } from 'bun:test';
import type { KthxClient, KthxSiteDetail } from '../../src/adapters/kthx.ts';
import { dispatch } from '../../src/commands/registry.ts';
import { getSite } from '../../src/commands/sites/get.ts';
import type {
  CommandContext,
  PrincipalKind,
} from '../../src/commands/types.ts';
import { unreachableContext } from '../harness/context.ts';

const base = await unreachableContext();

const DETAIL: KthxSiteDetail = {
  name: 'acme',
  url: 'https://acme.kthx.test',
  owner: null,
  serving: 7,
  held: false,
  created: '2026-09-30T12:00:00.000Z',
  deployed: '2026-09-30T12:05:00.000Z',
  provisioned: true,
  releases: [
    { n: 7, digest: 'sha256:abc', size: 12, at: '2026-09-30T12:05:00.000Z' },
    { n: 6, digest: 'sha256:def', size: 10, at: '2026-09-30T12:02:00.000Z' },
  ],
  usage: { dbBytes: 1, filesBytes: 2, aiRequestsToday: 3, aiTokensToday: 4 },
  quotas: {
    docBytes: 10,
    dbBytes: 20,
    fileBytes: 30,
    filesBytes: 40,
    aiRequestsDay: 200,
    aiTokensDay: 500000,
  },
};

function context(
  getSiteAnswer: KthxClient['getSite'] | null,
  kind: PrincipalKind | undefined = 'human',
): CommandContext & { asked: string[] } {
  const asked: string[] = [];
  const client: KthxClient | null =
    getSiteAnswer === null
      ? null
      : {
          origin: 'https://kthx.test',
          zone: 'kthx.test',
          getSite: (name) => {
            asked.push(name);
            return getSiteAnswer(name);
          },
          listSites: () => {
            throw new Error('a site read listed sites');
          },
          reserve: () => {
            throw new Error('a read reserved a name');
          },
          release: () => {
            throw new Error('a read released a name');
          },
        };
  return {
    ...base,
    principal: {
      ...base.principal,
      ...(kind === undefined ? {} : { kind }),
    },
    clock: { now: () => new Date('2026-09-30T13:05:00.000Z') },
    adapters: { ...base.adapters, kthx: () => client },
    asked,
  };
}

describe('getSite', () => {
  test('a site reads with its releases, usage and quotas', async () => {
    const ctx = context(async () => ({ ok: true, value: DETAIL }));

    const read = await getSite({ name: 'acme' }, ctx);

    expect(ctx.asked).toEqual(['acme']);
    expect(read).toEqual({
      ok: true,
      value: {
        state: 'ok',
        site: {
          name: 'acme',
          url: 'https://acme.kthx.test',
          owner: null,
          release: 7,
          held: false,
          createdAt: '2026-09-30T12:00:00.000Z',
          at: '2026-09-30T12:05:00.000Z',
          when: '1h ago',
          provisioned: true,
          releases: DETAIL.releases,
          usage: DETAIL.usage,
          quotas: DETAIL.quotas,
        },
      },
    });
  });

  test('an agent reads no owner', async () => {
    const ctx = context(
      async () => ({ ok: true, value: { ...DETAIL, owner: 'someone' } }),
      'agent',
    );
    const read = await getSite({ name: 'acme' }, ctx);
    if (!read.ok || read.value.state !== 'ok') throw new Error('not read');
    expect('owner' in read.value.site).toBe(false);
  });

  test('a site kthx has not got is NOT_FOUND', async () => {
    const read = await getSite(
      { name: 'acme' },
      context(async () => ({ ok: true, value: 'missing' })),
    );
    expect(read).toEqual({
      ok: false,
      failure: {
        code: 'NOT_FOUND',
        message: 'there is no kthx site named acme',
      },
    });
  });

  test('no kthx is NOT_FOUND, and says why', async () => {
    for (const ctx of [
      context(null),
      { ...base, adapters: { ...base.adapters } },
    ]) {
      expect(await getSite({ name: 'acme' }, ctx)).toEqual({
        ok: false,
        failure: {
          code: 'NOT_FOUND',
          message: 'this installation does not read kthx sites',
        },
      });
    }
  });

  test('a failing kthx is unreadable, with its reason', async () => {
    const read = await getSite(
      { name: 'acme' },
      context(async () => ({
        ok: false,
        reason: "kthx refused the engine's token (401 NOT_ENGINE)",
      })),
    );
    expect(read).toEqual({
      ok: true,
      value: {
        state: 'unreadable',
        reason: "kthx refused the engine's token (401 NOT_ENGINE)",
      },
    });
  });

  test('a name that is not one DNS label never reaches kthx', async () => {
    const ctx = context(async () => ({ ok: true, value: DETAIL }));
    for (const name of ['', 'Acme', 'a/b', 'a.b', '-a', 'x'.repeat(64)]) {
      const result = await dispatch('getSite', { name }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('INVALID_INPUT');
    }
    expect(ctx.asked).toEqual([]);
  });
});
