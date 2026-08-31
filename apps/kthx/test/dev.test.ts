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
      body: await request.text(),
    });
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
