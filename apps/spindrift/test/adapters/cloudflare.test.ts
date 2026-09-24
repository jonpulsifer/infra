/**
 * Reading a connected Cloudflare account. An empty listing (`[]`) and a
 * refused one (`null` plus the reason) stay distinct, and one refusal spares
 * the others.
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
      'GET /client/v4/accounts/account-1': () =>
        ok({ id: 'account-1', name: 'Folly Mountain Laboratories' }),
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
      accountName: 'Folly Mountain Laboratories',
      zones: [
        { name: 'example.test', id: 'zone-1', status: 'active' },
        { name: 'other.test', id: 'zone-2', status: 'pending' },
      ],
      workersSubdomain: 'acme',
      pagesProjects: ['site', 'docs'],
    });
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
    // Null here means the account has no subdomain, not a refused read.
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
    expect(found.workersSubdomain).toBe('acme');
    expect(found.pagesProjects).toEqual(['site']);
  });

  test('a refused account read costs only the pretty name', async () => {
    // A token scoped to zones alone cannot read the account object.
    const far = api({
      'GET /client/v4/accounts/account-1': () =>
        Response.json(
          { success: false, errors: [{ code: 9109, message: 'unauthorized' }] },
          { status: 403 },
        ),
      'GET /client/v4/zones': () =>
        ok([{ id: 'zone-1', name: 'example.test', status: 'active' }]),
    });

    const found = await read(far.fetch);

    expect(found.accountName).toBeNull();
    expect(found.unreadable).toBeUndefined();
    expect(found.zones).toHaveLength(1);
  });

  test('the Pages listing sends no pagination options', async () => {
    // The live endpoint refuses `page` and `per_page` (error 8000024) though
    // it documents them.
    let pagesQuery: string | null = null;
    const found = await read(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pages/projects')) pagesQuery = url.search;
      return Response.json({ success: true, errors: [], result: [] });
    });

    expect(pagesQuery ?? 'unset').toBe('');
    expect(found.pagesProjects).toEqual([]);
  });

  test('a refusal speaks the envelope’s words, not the raw body', async () => {
    const far = api({
      'GET /client/v4/accounts/account-1/pages/projects': () =>
        Response.json(
          {
            success: false,
            errors: [
              {
                code: 8000024,
                message:
                  'Invalid list options provided. Review the `page` or `per_page` parameter.',
              },
            ],
          },
          { status: 400 },
        ),
    });

    const found = await read(far.fetch);

    expect(found.unreadable?.pagesProjects).toBe(
      '400: Invalid list options provided. Review the `page` or `per_page` parameter.',
    );
    expect(found.unreadable?.pagesProjects).not.toContain('{');
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
