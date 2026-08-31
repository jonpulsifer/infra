/**
 * `sdk.js` against the real server.
 *
 * The SDK is a classic script with no build step, so the check is the same: it
 * is evaluated as one, given a `window`, a `location` and a `fetch` that lands
 * on this site's host. What that catches is the half of the SDK that is only
 * strings — a path, a verb, a header, the key a body is read out of — which is
 * exactly the half a server-side test cannot see.
 *
 * ponytail: the socket is stubbed. Its server half is `ws.test.ts` and its
 * client half is reconnection logic that wants a browser; the day that breaks,
 * a headless page is the way to find out.
 */
import { describe, expect, test } from 'bun:test';
import { SDK_PATH } from '@repo/kthx/assets';
import { ask, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.51.0.${nextAddress % 250}`;
}

interface Doc {
  id: string;
  etag: string;
  [key: string]: unknown;
}

interface Sdk {
  ready: Promise<void>;
  me: { id: string | null };
  site: { name: string | null; url: string | null };
  db: {
    collection(name: string): {
      create(document: unknown): Promise<Doc | Doc[]>;
      get(id: string): Promise<Doc | null>;
      findById(id: string): Promise<Doc | null>;
      subscribe(handlers: Record<string, unknown>): () => void;
      update(
        id: string,
        patch: unknown,
        options?: { overwrite?: boolean; ifMatch?: string },
      ): Promise<Doc>;
      put(
        id: string,
        document: unknown,
        options?: { ifNoneMatch?: boolean },
      ): Promise<Doc>;
      delete(id: string): Promise<undefined>;
      find(query?: unknown): Promise<Doc[]>;
      count(where?: unknown): Promise<number>;
      where(where: unknown): {
        orderBy(
          field: string,
          direction?: string,
        ): {
          limit(n: number): { find(): Promise<Doc[]> };
        };
      };
    };
    collections(): Promise<{ name: string; count: number }[]>;
  };
  ai: { baseURL: string; chat(): unknown };
  files: { url(path: string): string; upload(): unknown };
}

/** `sdk.js` run as a classic script over the `fetch` it is given. */
async function evaluated(
  location: { origin: string; protocol: string; host: string },
  call: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<Sdk> {
  const win: { kthx?: Sdk } = {};
  const evaluate = new Function(
    'window',
    'location',
    'fetch',
    'WebSocket',
    'setInterval',
    'clearInterval',
    await Bun.file(SDK_PATH).text(),
  );
  evaluate(
    win,
    location,
    call,
    class {
      static OPEN = 1;
      readyState = 0;
      close() {}
      send() {}
    },
    () => 0,
    () => undefined,
  );
  const sdk = win.kthx;
  if (sdk === undefined) throw new Error('sdk.js did not define window.kthx');
  return sdk;
}

/** The SDK, evaluated the way a `<script>` tag would, pointed at one site. */
async function loaded(label: string): Promise<Sdk> {
  const name = kthx().name(label);
  const claim = await kthx().fetch(
    ask('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
    }),
  );
  expect(claim.status).toBe(201);
  await claim.json();

  const host = `${name}.${ZONE}`;
  const cookies: string[] = [];
  const location = {
    origin: `https://${host}`,
    protocol: 'https:',
    host,
  };
  // A browser's cookie jar, which is what makes two calls the same visitor.
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.length > 0) headers.set('cookie', cookies.join('; '));
    const response = await kthx().fetch(ask(path, { ...init, host, headers }));
    const set = response.headers.get('set-cookie');
    if (set !== null) cookies.push(set.split(';')[0] ?? '');
    return response;
  };

  const sdk = await evaluated(location, call);
  await sdk.ready;
  expect(sdk.me.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(sdk.site.name).toBe(name);
  return sdk;
}

describe('sdk.js', () => {
  test('writes, reads, merges and queries through the real API', async () => {
    const sdk = await loaded('sdk');
    const notes = sdk.db.collection('notes');

    const made = (await notes.create({ title: 'one', n: 1 })) as Doc;
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await notes.get(made.id)).toEqual(made);
    // Quick's name for the same call, which the SDK's own docblock promises.
    expect(await notes.findById(made.id)).toEqual(made);
    expect(await notes.get('missing')).toBeNull();
    expect(await notes.findById('missing')).toBeNull();

    const merged = await notes.update(made.id, { n: 2 });
    expect(merged.n).toBe(2);
    expect(merged.title).toBe('one');
    const replaced = await notes.update(made.id, { n: 3 }, { overwrite: true });
    expect(replaced.title).toBeUndefined();

    // The CAS loop the SDK exists to make easy.
    await expect(
      notes.update(made.id, { n: 4 }, { ifMatch: merged.etag }),
    ).rejects.toMatchObject({ status: 412, code: 'PRECONDITION_FAILED' });

    const bulk = (await notes.create([{ n: 10 }, { n: 20 }])) as Doc[];
    expect(bulk).toHaveLength(2);
    expect(await notes.count()).toBe(3);
    expect(await notes.count({ n: { $gte: 10 } })).toBe(2);
    expect(
      (
        await notes
          .where({ n: { $gte: 10 } })
          .orderBy('n', 'desc')
          .limit(1)
          .find()
      ).map((item) => item.n),
    ).toEqual([20]);
    expect((await notes.find()).length).toBe(3);

    await notes.put('named', { kind: 'put' });
    expect((await sdk.db.collections()).map((c) => c.name)).toEqual(['notes']);
    await expect(
      notes.put('named', { kind: 'again' }, { ifNoneMatch: true }),
    ).rejects.toMatchObject({ status: 412 });

    expect(await notes.delete(made.id)).toBeUndefined();
    expect(await notes.get(made.id)).toBeNull();
  });

  test('a refusal is an Error carrying the server code', async () => {
    const sdk = await loaded('errors');
    await expect(
      sdk.db.collection('notes').create('not a document'),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_DOCUMENT' });
  });

  test('a site that is still provisioning rejects ready and nothing else', async () => {
    const host = `busy.${ZONE}`;
    const loose: unknown[] = [];
    const seen = (cause: unknown) => loose.push(cause);
    process.on('unhandledRejection', seen);
    const errors: unknown[] = [];
    const complain = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const sdk = await evaluated(
        { origin: `https://${host}`, protocol: 'https:', host },
        () =>
          Promise.resolve(
            new Response('{"code":"BUSY"}', {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      );
      // The contract has `ready` reject rather than hang; what must not happen
      // is every socket-backed call becoming an unhandled rejection of its own.
      await expect(sdk.ready).rejects.toThrow(/503/);
      expect(sdk.db.collection('notes').subscribe({})).toBeInstanceOf(Function);
      await Bun.sleep(20);
      expect(loose).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = complain;
      process.off('unhandledRejection', seen);
    }
  });

  test('the backends that are not here yet say so', async () => {
    const sdk = await loaded('stubs');
    expect(sdk.ai.baseURL).toBe(
      `https://${kthx().name('stubs')}.${ZONE}/api/ai/v1`,
    );
    expect(() => sdk.ai.chat()).toThrow(/not on this site yet/);
    expect(() => sdk.files.upload()).toThrow(/not on this site yet/);
    expect(sdk.files.url('a.png')).toEndWith('/files/a.png');
  });
});
