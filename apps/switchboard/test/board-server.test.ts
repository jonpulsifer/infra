import { describe, expect, test } from 'bun:test';
import type { BoardView } from '../src/board/model.ts';
import { BoardModel } from '../src/board/model.ts';
import { createBoardApp } from '../src/board/server.ts';
import { PLAN } from './board-fixtures.ts';

function setup(heartbeatMs = 1_000) {
  const model = new BoardModel({ plan: PLAN, recentLimit: 5 });
  const app = createBoardApp({ board: model, heartbeatMs, coalesceMs: 1 });
  return { model, app };
}

interface Reader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}

async function readFrame(reader: Reader) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('the board server', () => {
  test('answers the health check', async () => {
    const res = await setup().app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('serves the snapshot as JSON, uncached', async () => {
    const { app, model } = setup();
    model.setLink('connected');
    const res = await app.request('/api/board');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as BoardView;
    expect(body.asterisk.ari).toBe('connected');
    expect(body.lines).toHaveLength(4);
  });

  test('serves one self-contained page', async () => {
    const res = await setup().app.request('/');
    const html = await res.text();
    expect(res.headers.get('content-type')).toStartWith('text/html');
    expect(res.headers.get('content-security-policy')).toContain(
      "connect-src 'self'",
    );
    expect(html).toContain("new EventSource('/events')");
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(html).not.toContain('innerHTML');
  });

  test('streams a snapshot, then one after each change, then pings', async () => {
    const { app, model } = setup(30);
    const res = await app.request('/events');
    expect(res.headers.get('content-type')).toStartWith('text/event-stream');
    const reader = res.body!.getReader();
    const first = await readFrame(reader);
    expect(first).toContain('event: board');
    expect(JSON.parse(first.split('data: ')[1] ?? '').asterisk.ari).toBe(
      'connecting',
    );
    model.setLink('disconnected', 'unreachable');
    const second = await readFrame(reader);
    expect(second).toContain('event: board');
    expect(second).toContain('"reason":"unreachable"');
    const third = await readFrame(reader);
    expect(third).toContain('event: ping');
    await reader.cancel();
  });

  test('changes nothing: every write verb is refused', async () => {
    const { app } = setup();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await app.request('/api/board', { method });
      expect(res.status).toBe(404);
    }
  });
});
