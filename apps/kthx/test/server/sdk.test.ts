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
import { afterAll, describe, expect, test } from 'bun:test';
import { SDK_PATH } from '@repo/kthx/assets';
import { ask, idToken, withServer, ZONE } from '../harness/server.ts';

/** Enough of an upstream for `ai.chat` to have something to read a string out of. */
const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!JSON.parse(await request.text()).stream) {
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'an answer' } }],
        usage: { total_tokens: 9 },
      });
    }
    // Split across the frame boundary on purpose: the reader has to hold half
    // a frame back rather than parse it.
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"an "}}]}\n'),
          );
          controller.enqueue(
            encoder.encode(
              '\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  },
});

afterAll(() => {
  upstream.stop(true);
});

const kthx = withServer({ aiUrl: `http://127.0.0.1:${upstream.port}/v1` });

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
  ai: {
    baseURL: string;
    chat(input: unknown, options?: unknown): Promise<unknown>;
  };
  files: {
    url(path: string): string;
    upload(
      path: unknown,
      body?: unknown,
      options?: { type?: string },
    ): Promise<{ path: string; url: string; size: number; type: string }>;
    list(): Promise<{ path: string; type: string; size: number }[]>;
    delete(path: string): Promise<undefined>;
  };
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
      token: await idToken(`${name}@example.com`),
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

  test('ai.chat reaches the passthrough, and baseURL is absolute', async () => {
    const sdk = await loaded('ai');
    // Absolute because the OpenAI SDK throws on a relative one at request time.
    expect(sdk.ai.baseURL).toBe(
      `https://${kthx().name('ai')}.${ZONE}/api/ai/v1`,
    );
    // A string prompt becomes one user message, and what comes back is the
    // content rather than the envelope around it.
    expect(await sdk.ai.chat('hello')).toBe('an answer');

    const deltas: string[] = [];
    for await (const delta of (await sdk.ai.chat([{ role: 'user' }], {
      stream: true,
    })) as AsyncIterable<string>) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['an ', 'answer']);
  });

  test('files: a type per body kind, and the url the upload answered', async () => {
    const sdk = await loaded('files');
    const text = await sdk.files.upload('notes/a.txt', 'hello');
    expect(text).toEqual({
      path: 'notes/a.txt',
      url: `${sdk.site.url}/files/notes/a.txt`,
      size: 5,
      type: 'text/plain',
    });
    expect(sdk.files.url('notes/a.txt')).toBe(text.url);

    // An object is JSON, and a Blob carries its own type.
    const json = await sdk.files.upload('data.json', { a: 1 });
    expect(json.type).toBe('application/json');
    const blob = await sdk.files.upload(
      'cover.png',
      new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
    );
    expect(blob).toMatchObject({ type: 'image/png', size: 2 });
    // A File brings its own name, so the path is the whole of what is left out.
    const named = await sdk.files.upload(
      new File(['x,y'], 'table.csv', { type: 'text/csv' }),
    );
    expect(named.path).toBe('table.csv');

    expect((await sdk.files.list()).map((item) => item.path)).toEqual([
      'cover.png',
      'data.json',
      'notes/a.txt',
      'table.csv',
    ]);
    expect(await sdk.files.delete('data.json')).toBeUndefined();
    expect((await sdk.files.list()).length).toBe(3);
    await expect(
      sdk.files.upload('page.html', '<h1>hi</h1>', { type: 'text/html' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE', status: 400 });
  });
});
