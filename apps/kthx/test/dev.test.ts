/**
 * `kthx dev`: production's resolution rules over a directory, and everything
 * under `/api` and `/files` handed to the real site.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dev } from '../cli/dev.ts';
import { ME_COOKIE } from '../server/me.ts';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly origin: string | null;
  readonly cookie: string | null;
  readonly authorization: string | null;
  readonly host: string | null;
  readonly encoding: string | null;
  readonly body: string;
}

const seen: Seen[] = [];
/** The query string the last upgrade arrived with. */
let wsSearch = '';

/** The site host: it records what arrived and answers like the server does. */
const upstream = Bun.serve<{ echo: true }>({
  port: 0,
  async fetch(request, server) {
    const { pathname, search } = new URL(request.url);
    if (pathname === '/api/ws') {
      wsSearch = search;
      return server.upgrade(request, { data: { echo: true } })
        ? undefined
        : new Response('no', { status: 400 });
    }
    seen.push({
      method: request.method,
      path: pathname,
      search,
      origin: request.headers.get('origin'),
      cookie: request.headers.get('cookie'),
      authorization: request.headers.get('authorization'),
      host: request.headers.get('host'),
      encoding: request.headers.get('accept-encoding'),
      body: await request.text(),
    });
    if (pathname === '/api/zstd') {
      // A site that compresses anyway, whatever the proxy asked for.
      const zipped = new Uint8Array(
        Bun.zstdCompressSync(new TextEncoder().encode('{"items":[7]}')),
      );
      return new Response(zipped, {
        headers: {
          'content-encoding': 'zstd',
          'content-type': 'application/json',
        },
      });
    }
    if (pathname.startsWith('/_/')) {
      return Response.json(
        { code: 'GONE', message: 'retired' },
        { status: 410 },
      );
    }
    if (pathname === '/files/logo.png') {
      return new Response('PNG', { headers: { 'content-type': 'image/png' } });
    }
    return Response.json(
      { items: [], path: pathname },
      {
        headers: {
          'set-cookie': `${ME_COOKIE}=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
          'cache-control': 'no-store',
        },
      },
    );
  },
  websocket: {
    message: (socket, raw) => {
      socket.send(`echo:${raw}`);
    },
  },
});

const dir = mkdtempSync(join(tmpdir(), 'kthx-dev-'));
for (const [path, text] of Object.entries({
  'index.html': '<h1>home</h1>',
  'about/index.html': '<h1>about</h1>',
  'style.css': 'h1{}',
  '404.html': '<h1>lost</h1>',
  '_/secret.txt': 'reserved',
  '.env': 'SECRET',
  'kthx.json': '{"name":"notes"}',
})) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
const server = dev(
  dir,
  { name: 'notes', token: 'tok-notes', site: upstream.url.origin },
  0,
);
const url = (path: string) => `${server.url.origin}${path}`;
afterAll(() => {
  server.stop(true);
  upstream.stop(true);
});

describe('files', () => {
  test('resolve like production, and never leak what an upload excludes', async () => {
    expect(await (await fetch(url('/'))).text()).toBe('<h1>home</h1>');
    expect(await (await fetch(url('/about'))).text()).toBe('<h1>about</h1>');
    expect(await (await fetch(url('/about/'))).text()).toBe('<h1>about</h1>');

    const css = await fetch(url('/style.css'));
    expect(css.headers.get('content-type')).toStartWith('text/css');
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
    // A working directory changes under the browser; nothing here is cacheable.
    expect(css.headers.get('cache-control')).toBe('no-store');
    expect(css.headers.get('etag')).toBeNull();

    const icon = await fetch(url('/favicon.ico'));
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/x-icon');

    const lost = await fetch(url('/nope'));
    expect(lost.status).toBe(404);
    expect(await lost.text()).toBe('<h1>lost</h1>');

    for (const path of ['/.env', '/kthx.json', '/../etc/passwd']) {
      expect((await fetch(url(path))).status).toBe(404);
    }
    expect((await fetch(url('/style.css'), { method: 'POST' })).status).toBe(
      405,
    );
  });

  test('treats a lone top-level directory as the site, like a release', async () => {
    const wrapped = mkdtempSync(join(tmpdir(), 'kthx-dev-'));
    mkdirSync(join(wrapped, 'dist'));
    writeFileSync(join(wrapped, 'dist', 'index.html'), '<h1>dist</h1>');
    writeFileSync(join(wrapped, 'kthx.json'), '{}');
    const inner = dev(
      wrapped,
      { name: 'notes', token: 't', site: upstream.url.origin },
      0,
    );
    try {
      expect(await (await fetch(`${inner.url.origin}/`)).text()).toBe(
        '<h1>dist</h1>',
      );
    } finally {
      inner.stop(true);
    }
  });
});

describe('the proxy', () => {
  test('sends /api to the site, as a visitor and from the site origin', async () => {
    seen.length = 0;
    const answer = await fetch(url('/api/db/notes'), {
      headers: {
        origin: server.url.origin,
        cookie: 'other=1; kthx_me=abc.def',
      },
    });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { path: string }).path).toBe(
      '/api/db/notes',
    );

    const [call] = seen;
    expect(call!.host).toBe(new URL(upstream.url.origin).host);
    // The server compares `Origin` to its own host, and rejects a foreign one.
    expect(call!.origin).toBe(upstream.url.origin);
    // The cookie a browser will keep over http, under the name the server signs
    // — and nothing else: `localhost` holds every other local server's cookies,
    // and none of them belong on the internet.
    expect(call!.cookie).toBe(`${ME_COOKIE}=abc.def`);
    // A page is a visitor here exactly as it is in production.
    expect(call!.authorization).toBeNull();

    // `__Host-` and `Secure` come back off: a browser drops both over http, and
    // a visitor id that never sticks is a new visitor on every request.
    const cookie = answer.headers.getSetCookie()[0]!;
    expect(cookie).toStartWith('kthx_me=abc.def;');
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });

  test('attaches the bearer to the owner routes and to nothing else', async () => {
    seen.length = 0;
    await fetch(url('/api/db/notes'), { method: 'DELETE' });
    await fetch(url('/api/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    await fetch(url('/api/db/notes/x'), { method: 'DELETE' });
    await fetch(url('/api/db/notes'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(seen.map((call) => call.authorization)).toEqual([
      'Bearer tok-notes',
      'Bearer tok-notes',
      null,
      null,
    ]);
    expect(seen[3]!.body).toBe('{"a":1}');
  });

  test('hands over /files and the retired /_/ too', async () => {
    seen.length = 0;
    const file = await fetch(url('/files/logo.png'));
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(await file.text()).toBe('PNG');

    // The bundle has `_/secret.txt`; a site never serves it, and the site host
    // says why.
    const retired = await fetch(url('/_/secret.txt'));
    expect(retired.status).toBe(410);
    expect(seen.map((call) => call.path)).toEqual([
      '/files/logo.png',
      '/_/secret.txt',
    ]);
  });

  test('sends no cookie header when the tab holds no visitor cookie', async () => {
    seen.length = 0;
    await fetch(url('/api/db/notes'), { headers: { cookie: 'grafana=DEAD' } });
    expect(seen[0]!.cookie).toBeNull();
  });

  test('runs without a token, and then signs nothing', async () => {
    seen.length = 0;
    const loose = dev(dir, { name: 'notes', site: upstream.url.origin }, 0);
    try {
      await fetch(`${loose.url.origin}/api/db/notes`, { method: 'DELETE' });
      expect(seen[0]!.authorization).toBeNull();
    } finally {
      loose.stop(true);
    }
  });

  test('asks the site for no encoding, and passes one back anyway', async () => {
    seen.length = 0;
    const answer = await fetch(url('/api/zstd'));
    // A proxy hands the bytes on rather than negotiating an encoding of its
    // own — and when the site encodes regardless, what comes out is readable
    // and not labelled with an encoding this hop already undid.
    expect(seen[0]!.encoding).toBe('identity');
    expect(await answer.json()).toEqual({ items: [7] });
    expect(answer.headers.get('content-encoding')).toBeNull();
  });

  test('carries the websocket', async () => {
    const socket = new WebSocket(url('/api/ws?room=a').replace('http', 'ws'));
    const frames: string[] = [];
    socket.onmessage = (event) => frames.push(String(event.data));
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    socket.send('{"t":"ping"}');
    const deadline = Date.now() + 2000;
    while (frames.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(frames).toEqual(['echo:{"t":"ping"}']);
    // Whatever the page put on the URL reaches the site, as it does on /api/*.
    expect(wsSearch).toBe('?room=a');
    socket.close();
  });
});

describe('a site that never answers', () => {
  /**
   * The shape of the failure that made the loop look hung: a socket that
   * accepts and then says nothing. No RST, so a connect with no deadline waits
   * on the OS — minutes, on the route that prompted this.
   */
  const deaf = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => {}, open: () => {} },
  });
  const gone = `http://127.0.0.1:${deaf.port}`;
  const loop = dev(dir, { name: 'notes', token: 't', site: gone }, 0, 300);
  afterAll(() => {
    loop.stop(true);
    deaf.stop();
  });

  test('answers 504 inside the deadline and keeps serving', async () => {
    const started = Date.now();
    const answer = await fetch(`${loop.url.origin}/api/db/notes`);
    expect(answer.status).toBe(504);
    expect(await answer.json()).toEqual({
      code: 'UNREACHABLE',
      message: `${gone} did not answer in 0.3s`,
    });
    // The bound is the whole bound, the retry inside it — not one per attempt.
    expect(Date.now() - started).toBeLessThan(2000);

    // The loop is still up: the files still serve, and the next call answers
    // the same way instead of hanging.
    expect(await (await fetch(`${loop.url.origin}/`)).text()).toBe(
      '<h1>home</h1>',
    );
    expect((await fetch(`${loop.url.origin}/api/db/notes`)).status).toBe(504);
  });

  test('closes the tab socket rather than leaving it open forever', async () => {
    const socket = new WebSocket(
      `${loop.url.origin}/api/ws`.replace('http', 'ws'),
    );
    const closed = await new Promise<CloseEvent>((resolve, reject) => {
      socket.onclose = resolve;
      setTimeout(() => reject(new Error('still open')), 2000);
    });
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe(`${gone} did not answer in 0.3s`);
  });
});
