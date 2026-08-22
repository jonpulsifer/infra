/**
 * Reading a connected Cloudflare account.
 *
 * The reader is what makes the connection account-shaped rather than
 * Pages-shaped, so the claims worth stating are about the three listings and,
 * above all, about the difference between two answers that look alike:
 *
 * - **Three reads, one credential, one pass** — zones scoped to the account,
 *   the Workers subdomain, the Pages projects.
 * - **An empty listing and a refused one are not the same fact.** `[]` says the
 *   account has none; `null` plus a sentence says nobody could look. Flattening
 *   them is how a screen tells an operator to create a zone they already have.
 * - **One refusal does not sink the other two**, which is why the reads are
 *   folded into their own fields rather than wrapped in one `try`.
 */
import { describe, expect, test } from 'bun:test';
import { readCloudflareAccount } from '../../src/adapters/cloudflare.ts';

const ENDPOINT = 'https://edge.example.test/client/v4';

function api(routes: Readonly<Record<string, () => Response>>): {
  fetch: (request: Request) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      return (
        routes[`${request.method} ${url.pathname}`]?.() ??
        Response.json({ success: true, result: null })
      );
    },
  };
}

function ok(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function read(fetch: (request: Request) => Promise<Response>) {
  return readCloudflareAccount('account-1', {
    token: () => 'edge-token',
    endpoint: ENDPOINT,
    fetch,
  });
}

describe('readCloudflareAccount', () => {
  test('lists the account’s zones, Workers subdomain and Pages projects', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([
          { id: 'zone-1', name: 'example.test', status: 'active' },
          { id: 'zone-2', name: 'other.test', status: 'pending' },
        ]),
      'GET /client/v4/accounts/account-1/workers/subdomain': () =>
        ok({ subdomain: 'acme' }),
      'GET /client/v4/accounts/account-1/pages/projects': () =>
        ok([{ name: 'site' }, { name: 'docs' }]),
    });

    const found = await read(far.fetch);

    expect(found).toEqual({
      kind: 'cloudflare-account',
      zones: [
        { name: 'example.test', id: 'zone-1', status: 'active' },
        { name: 'other.test', id: 'zone-2', status: 'pending' },
      ],
      workersSubdomain: 'acme',
      pagesProjects: ['site', 'docs'],
    });
    // Scoped to the account: a token holding two accounts must not list the
    // other one's zones under this boundary.
    expect(far.calls).toContain('GET /client/v4/zones');
  });

  test('an empty account is read, not refused', async () => {
    const far = api({
      'GET /client/v4/zones': () => ok([]),
      'GET /client/v4/accounts/account-1/workers/subdomain': () => ok({}),
      'GET /client/v4/accounts/account-1/pages/projects': () => ok([]),
    });

    const found = await read(far.fetch);

    expect(found.zones).toEqual([]);
    expect(found.pagesProjects).toEqual([]);
    // Workers has no subdomain to report, which is an answer rather than a gap.
    expect(found.workersSubdomain).toBeNull();
    expect(found.unreadable).toBeUndefined();
  });

  test('a refused read is null with the platform’s own sentence', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        Response.json(
          { success: false, errors: [{ code: 9109, message: 'unauthorized' }] },
          { status: 403 },
        ),
      'GET /client/v4/accounts/account-1/workers/subdomain': () =>
        ok({ subdomain: 'acme' }),
      'GET /client/v4/accounts/account-1/pages/projects': () =>
        ok([{ name: 'site' }]),
    });

    const found = await read(far.fetch);

    expect(found.zones).toBeNull();
    expect(found.unreadable?.zones).toContain('403');
    // The other two answered, and one refusal must not take them with it.
    expect(found.workersSubdomain).toBe('acme');
    expect(found.pagesProjects).toEqual(['site']);
  });

  test('a zone missing the fields anything addresses it by is dropped', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([{ name: 'nameless.test' }, { id: 'zone-1', name: 'real.test' }]),
    });

    const found = await read(far.fetch);

    expect(found.zones).toEqual([
      { name: 'real.test', id: 'zone-1', status: 'unknown' },
    ]);
  });
});
