/**
 * The kthx client against a fake engine surface. Every failure is a sentence,
 * never a throw, so a list keeps its built Apps while kthx is down.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  KTHX_BODY_LIMIT,
  type KthxClientOptions,
  kthxClient,
} from '../../src/adapters/kthx.ts';
import {
  createAdapterRegistry,
  KTHX_TOKEN_PATH_VARIABLE,
  KTHX_URL_VARIABLE,
  KTHX_ZONE_VARIABLE,
  projectedServiceAccountToken,
} from '../../src/adapters/registry.ts';
import { fixtureManifest } from '../harness/installation.ts';

const ORIGIN = 'https://kthx.test';

const SITE = {
  name: 'acme',
  url: 'https://acme.kthx.test',
  owner: 'someone@example.com',
  serving: 7,
  held: false,
  created: '2026-09-30T12:00:00.000Z',
  deployed: '2026-09-30T12:05:00.000Z',
  provisioned: true,
};

const DETAIL = {
  ...SITE,
  releases: [
    { n: 7, digest: 'sha256:abc', size: 12345, at: '2026-09-30T12:05:00.000Z' },
  ],
  usage: {
    db_bytes: 1,
    files_bytes: 2,
    ai_requests_today: 3,
    ai_tokens_today: 4,
  },
  quotas: {
    doc_bytes: 10,
    db_bytes: 20,
    file_bytes: 30,
    files_bytes: 40,
    ai_requests_day: 200,
    ai_tokens_day: 500000,
  },
};

/** Answers every request with `answer`, recording what it was sent. */
function engine(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Request[] = [];
  const client = (overrides: Partial<KthxClientOptions> = {}) =>
    kthxClient({
      url: ORIGIN,
      zone: 'kthx.test',
      token: () => 'engine-token',
      fetch: async (request) => {
        sent.push(request);
        return answer(request);
      },
      ...overrides,
    });
  return { sent, client };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('reads', () => {
  test('a page of sites maps as kthx sends it', async () => {
    const { sent, client } = engine(() =>
      json({ total: 3, items: [SITE], next: 'acme', extra: true }),
    );

    const page = await client().listSites({ after: 'zeta', limit: 2 });

    expect(page).toEqual({
      ok: true,
      value: { total: 3, items: [SITE], next: 'acme' },
    });
    const [request] = sent;
    const url = new URL(request?.url ?? '');
    expect(request?.method).toBe('GET');
    expect(url.pathname).toBe('/api/engine/sites');
    expect(url.searchParams.get('after')).toBe('zeta');
    expect(url.searchParams.get('limit')).toBe('2');
    expect(request?.headers.get('authorization')).toBe('Bearer engine-token');
    expect(request?.redirect).toBe('error');
  });

  test('the first page names no cursor', async () => {
    const { sent, client } = engine(() =>
      json({ total: 0, items: [], next: null }),
    );
    await client().listSites({ after: null, limit: 50 });
    expect(new URL(sent[0]?.url ?? '').searchParams.has('after')).toBe(false);
  });

  test('a site detail maps snake_case to camelCase', async () => {
    const { client } = engine(() => json(DETAIL));

    const read = await client().getSite('acme');

    expect(read).toEqual({
      ok: true,
      value: {
        ...SITE,
        releases: DETAIL.releases,
        usage: {
          dbBytes: 1,
          filesBytes: 2,
          aiRequestsToday: 3,
          aiTokensToday: 4,
        },
        quotas: {
          docBytes: 10,
          dbBytes: 20,
          fileBytes: 30,
          filesBytes: 40,
          aiRequestsDay: 200,
          aiTokensDay: 500000,
        },
      },
    });
  });

  test('a path segment is encoded', async () => {
    const { sent, client } = engine(() => json(DETAIL));
    await client().getSite('a/b?c');
    expect(sent[0]?.url).toBe(`${ORIGIN}/api/engine/sites/a%2Fb%3Fc`);
  });

  test('a body kthx should not send is a reason', async () => {
    const { client } = engine(() => json({ total: 'many' }));
    const page = await client().listSites({ after: null, limit: 50 });
    expect(page).toEqual({
      ok: false,
      reason: 'kthx answered with a body the engine cannot read',
    });
  });
});

describe('a site that is not there', () => {
  test('NO_SITE and 410 are missing', async () => {
    for (const [status, code] of [
      [404, 'NO_SITE'],
      [410, 'GONE'],
    ] as const) {
      const { client } = engine(() => json({ code, message: 'no' }, status));
      expect(await client().getSite('acme')).toEqual({
        ok: true,
        value: 'missing',
      });
    }
  });

  test('a plain 404 means kthx serves no engine surface', async () => {
    const { client } = engine(() =>
      json({ code: 'NOT_FOUND', message: 'no' }, 404),
    );
    const reason = {
      ok: false,
      reason: 'kthx does not serve the engine surface (404)',
    } as const;
    expect(await client().getSite('acme')).toEqual(reason);
    expect(await client().listSites({ after: null, limit: 50 })).toEqual(
      reason,
    );
  });

  test('any 404 on the list is a reason, even NO_SITE', async () => {
    const { client } = engine(() =>
      json({ code: 'NO_SITE', message: 'no' }, 404),
    );
    const page = await client().listSites({ after: null, limit: 50 });
    expect(page.ok).toBe(false);
  });
});

describe('failures are sentences', () => {
  test('401 and 503 name the status and code', async () => {
    const cases = [
      [401, 'NOT_ENGINE', "kthx refused the engine's token (401 NOT_ENGINE)"],
      [
        503,
        'ISSUER_UNREACHABLE',
        'kthx could not answer (503 ISSUER_UNREACHABLE)',
      ],
      [
        400,
        'MALFORMED_REQUEST',
        'kthx refused the request as malformed (400 MALFORMED_REQUEST)',
      ],
    ] as const;
    for (const [status, code, reason] of cases) {
      const { client } = engine(() => json({ code, message: 'x' }, status));
      expect(await client().listSites({ after: null, limit: 50 })).toEqual({
        ok: false,
        reason,
      });
    }
  });

  test('a slow kthx is a timeout', async () => {
    const { client } = engine(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(request.signal.reason),
          );
        }),
    );

    const page = await client({ timeouts: { list: 20, call: 20 } }).listSites({
      after: null,
      limit: 50,
    });

    expect(page).toEqual({
      ok: false,
      reason: 'kthx did not answer within 0.02s',
    });
  });

  test('a body over 1 MiB is refused', async () => {
    const { client } = engine(
      () =>
        new Response(new Uint8Array(KTHX_BODY_LIMIT + 1).fill(32), {
          status: 200,
        }),
    );
    expect(await client().listSites({ after: null, limit: 50 })).toEqual({
      ok: false,
      reason: 'kthx answered with more than 1 MiB',
    });
  });

  test('a missing token file is a reason, and nothing is sent', async () => {
    const { sent, client } = engine(() => json({}));
    const read = await client({
      token: projectedServiceAccountToken(
        `/tmp/spindrift-kthx-token-${crypto.randomUUID()}`,
      ),
    }).getSite('acme');
    expect(read).toEqual({
      ok: false,
      reason: 'the engine could not read its kthx token',
    });
    expect(sent).toHaveLength(0);
  });

  test('a transport failure is a reason', async () => {
    const { client } = engine(() => {
      throw new TypeError('connection refused');
    });
    expect(await client().getSite('acme')).toEqual({
      ok: false,
      reason: 'kthx could not be reached: connection refused',
    });
  });

  test('a redirect status is not followed', async () => {
    const { client } = engine(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.test/' },
        }),
    );
    const read = await client().getSite('acme');
    expect(read).toEqual({
      ok: false,
      reason:
        'kthx answered with a redirect (302), which the engine does not follow',
    });
  });
});

describe('a real redirect', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('the platform fetch refuses it and the client says so', async () => {
    let followed = false;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        if (new URL(request.url).pathname === '/elsewhere') {
          followed = true;
          return json(DETAIL);
        }
        return Response.redirect('/elsewhere', 302);
      },
    });
    const read = await kthxClient({
      url: `http://127.0.0.1:${server.port}`,
      zone: 'kthx.test',
      token: () => 'engine-token',
    }).getSite('acme');

    expect(read).toEqual({
      ok: false,
      reason: expect.stringMatching(/^kthx could not be reached/),
    });
    expect(followed).toBe(false);
  });
});

describe('reservations', () => {
  test('a reserve that holds every name is empty', async () => {
    const { sent, client } = engine(() =>
      json({ holder: 'app-1', names: ['acme'] }),
    );
    expect(await client().reserve('app-1', ['acme'])).toEqual({
      ok: true,
      value: [],
    });
    expect(sent[0]?.method).toBe('POST');
    expect(await sent[0]?.json()).toEqual({
      holder: 'app-1',
      names: ['acme'],
    });
    expect(sent[0]?.headers.get('content-type')).toBe('application/json');
  });

  test('a conflict lists the taken names', async () => {
    const taken = [{ name: 'acme', by: 'site' }] as const;
    const { client } = engine(() =>
      json({ code: 'TAKEN', message: 'that name is taken', taken }, 409),
    );
    expect(await client().reserve('app-1', ['acme'])).toEqual({
      ok: true,
      value: taken,
    });
  });

  test('more names than kthx takes at once go in batches of 32', async () => {
    const labels = Array.from({ length: 70 }, (_, i) => `n${i}`);
    const { sent, client } = engine(() => json({ holder: 'app-1' }));

    expect(await client().reserve('app-1', labels)).toEqual({
      ok: true,
      value: [],
    });
    const batches = await Promise.all(
      sent.map(async (request) => (await request.json()).names),
    );
    expect(batches.map((names) => names.length)).toEqual([32, 32, 6]);
    expect(batches.flat()).toEqual(labels);
  });

  test('a batch kthx refuses stops the reserve with its answer', async () => {
    const labels = Array.from({ length: 70 }, (_, i) => `n${i}`);
    const taken = [{ name: 'n40', by: 'app' }] as const;
    const { sent, client } = engine(() =>
      sent.length === 1
        ? json({ holder: 'app-1' })
        : json({ code: 'TAKEN', message: 'that name is taken', taken }, 409),
    );

    expect(await client().reserve('app-1', labels)).toEqual({
      ok: true,
      value: taken,
    });
    expect(sent).toHaveLength(2);
  });

  test('a release names the holder and each label', async () => {
    const { sent, client } = engine(() =>
      json({ holder: 'app-1', released: ['a', 'b'] }),
    );
    expect(await client().release('app-1', ['a', 'b'])).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
    const url = new URL(sent[0]?.url ?? '');
    expect(sent[0]?.method).toBe('DELETE');
    expect(url.searchParams.get('holder')).toBe('app-1');
    expect(url.searchParams.getAll('name')).toEqual(['a', 'b']);
  });

  test('a release of everything names only the holder', async () => {
    const { sent, client } = engine(() =>
      json({ holder: 'app-1', released: [] }),
    );
    await client().release('app-1', null);
    expect(new URL(sent[0]?.url ?? '').searchParams.has('name')).toBe(false);
  });

  test('an empty label list releases nothing and sends nothing', async () => {
    const { sent, client } = engine(() => json({}));
    expect(await client().release('app-1', [])).toEqual({
      ok: true,
      value: [],
    });
    expect(sent).toHaveLength(0);
  });
});

describe('the registry builds kthx only from all three variables', () => {
  const ALL = {
    [KTHX_URL_VARIABLE]: ORIGIN,
    [KTHX_ZONE_VARIABLE]: 'kthx.test',
    [KTHX_TOKEN_PATH_VARIABLE]: '/var/run/secrets/kthx/token',
  };

  test('all three give a client on the zone', async () => {
    const registry = createAdapterRegistry({
      manifest: await fixtureManifest(),
      env: ALL,
    });
    expect(registry.kthx?.()?.zone).toBe('kthx.test');
  });

  test('any one missing gives null', async () => {
    const manifest = await fixtureManifest();
    expect(createAdapterRegistry({ manifest, env: {} }).kthx?.()).toBeNull();
    for (const variable of Object.keys(ALL)) {
      const env = { ...ALL, [variable]: '' };
      expect(createAdapterRegistry({ manifest, env }).kthx?.()).toBeNull();
    }
  });

  test('the injected token and fetch reach kthx', async () => {
    const sent: Request[] = [];
    const registry = createAdapterRegistry({
      manifest: await fixtureManifest(),
      env: ALL,
      kthxToken: () => 'injected',
      fetch: async (request) => {
        sent.push(request);
        return json({ total: 0, items: [], next: null });
      },
    });
    await registry.kthx?.()?.listSites({ after: null, limit: 50 });
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer injected');
  });
});
