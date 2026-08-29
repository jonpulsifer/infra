/**
 * `kthx dev`: production's resolution rules over a directory, and a `/_/`
 * the SDK cannot tell from the real one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dev } from '../cli/dev.ts';

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
const server = dev(dir, 0);
const url = (path: string) => `${server.url.origin}${path}`;
afterAll(() => server.stop(true));

describe('files', () => {
  test('resolve like production: directories, 404.html, nothing reserved', async () => {
    expect(await (await fetch(url('/'))).text()).toBe('<h1>home</h1>');
    expect(await (await fetch(url('/about'))).text()).toBe('<h1>about</h1>');
    expect(await (await fetch(url('/about/'))).text()).toBe('<h1>about</h1>');
    const css = await fetch(url('/style.css'));
    expect(css.headers.get('content-type')).toStartWith('text/css');
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
    const lost = await fetch(url('/nope'));
    expect(lost.status).toBe(404);
    expect(await lost.text()).toBe('<h1>lost</h1>');
    for (const path of [
      '/_/secret.txt',
      '/.env',
      '/kthx.json',
      '/../etc/passwd',
    ]) {
      expect((await fetch(url(path))).status).toBe(404);
    }
    expect((await fetch(url('/'), { method: 'POST' })).status).toBe(405);
  });

  test('serves the real SDK and a cookie identity', async () => {
    expect(await (await fetch(url('/_/sdk.js'))).text()).toContain(
      'window.kthx',
    );
    const me = await fetch(url('/_/me'));
    const { id } = (await me.json()) as { id: string };
    const cookie = me.headers.get('set-cookie')!;
    expect(cookie).toStartWith(`kthx_me=${id};`);
    const again = await fetch(url('/_/me'), { headers: { cookie } });
    expect(((await again.json()) as { id: string }).id).toBe(id);
  });
});

describe('db', () => {
  const put = (
    key: string,
    value: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(url(`/_/db/${key}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    });

  test('is a JSON store with etags, CAS, prefix lists, and fan-out', async () => {
    const socket = new WebSocket(url('/_/ws').replace('http', 'ws'));
    const frames: unknown[] = [];
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });
    socket.send(JSON.stringify({ t: 'watch', prefix: '' }));

    expect((await fetch(url('/_/db/votes'))).status).toBe(404);
    const first = await put('votes', { b: 1, a: 2 });
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const read = await fetch(url('/_/db/votes'));
    expect(read.headers.get('etag')).toBe(etag);
    expect(await read.json()).toEqual({ a: 2, b: 1 });

    expect((await put('votes', 3, { 'if-match': '"stale"' })).status).toBe(412);
    expect((await put('votes', 3, { 'if-none-match': '*' })).status).toBe(412);
    expect((await put('votes', 3, { 'if-match': etag })).status).toBe(200);
    expect((await put('votes', null)).status).toBe(400);
    await put('v/x', 1);
    const listed = await fetch(url('/_/db?prefix=v'));
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([
      { key: 'v/x', value: 1 },
      { key: 'votes', value: 3 },
    ]);
    expect((await fetch(url('/_/db/votes'), { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await fetch(url('/_/db/votes'))).status).toBe(404);

    await Bun.sleep(20);
    expect(frames).toEqual([
      { t: 'put', key: 'votes', value: { b: 1, a: 2 } },
      { t: 'put', key: 'votes', value: 3 },
      { t: 'put', key: 'v/x', value: 1 },
      { t: 'del', key: 'votes' },
    ]);
    socket.close();
  });
});

describe('live', () => {
  test('rooms carry messages between peers and say who is there', async () => {
    const open = async () => {
      const socket = new WebSocket(url('/_/ws').replace('http', 'ws'));
      const frames: Record<string, unknown>[] = [];
      socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
      await new Promise((resolve) => {
        socket.onopen = resolve;
      });
      return { socket, frames };
    };
    const a = await open();
    const b = await open();
    a.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    await Bun.sleep(20);
    b.socket.send(JSON.stringify({ t: 'join', room: 'lobby' }));
    await Bun.sleep(20);
    b.socket.send(JSON.stringify({ t: 'send', room: 'lobby', data: 'hi' }));
    await Bun.sleep(20);
    b.socket.close();
    await Bun.sleep(20);

    // Neither socket sent a cookie, so each was given an id on upgrade.
    const [A] = (a.frames[0] as { peers: string[] }).peers;
    const B = (a.frames[1] as { peer: string }).peer;
    expect(A).toMatch(/^[0-9a-f-]{36}$/);
    expect(B).toMatch(/^[0-9a-f-]{36}$/);
    expect(A).not.toBe(B);
    expect(a.frames).toEqual([
      { t: 'peers', room: 'lobby', peers: [A] },
      { t: 'join', room: 'lobby', peer: B },
      { t: 'msg', room: 'lobby', from: B, data: 'hi' },
      { t: 'leave', room: 'lobby', peer: B },
    ]);
    expect(b.frames).toEqual([{ t: 'peers', room: 'lobby', peers: [A, B] }]);
    a.socket.close();
  });
});
