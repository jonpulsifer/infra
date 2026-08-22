/**
 * Run — the preview worker, driven by real sources.
 *
 * Nothing is faked: the point of the seam is that an author's code actually
 * executes, so every case here is a module the worker imports for real. The
 * claim worth stating is the last one — a handler that never returns has to be
 * a bounded failure rather than a wedged request.
 */
import { describe, expect, test } from 'bun:test';
import { runPreview } from '../../src/functions/preview.ts';

const GET = { method: 'GET', path: '/' } as const;

describe('runPreview', () => {
  test('returns the handler’s response', async () => {
    const result = await runPreview(
      `export default {
         async fetch(request) {
           const url = new URL(request.url);
           return Response.json({ hello: 'world', path: url.pathname });
         },
       };`,
      { method: 'GET', path: '/greet' },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      hello: 'world',
      path: '/greet',
    });
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.error).toBeNull();
  });

  test('captures console output as levelled lines', async () => {
    const result = await runPreview(
      `export default {
         fetch() {
           console.log('one', { two: 2 });
           console.warn('careful');
           return new Response('ok');
         },
       };`,
      GET,
    );
    expect(result.ok).toBe(true);
    expect(result.logs.map((entry) => entry.line)).toEqual([
      'one {"two":2}',
      'careful',
    ]);
    expect(result.logs.map((entry) => entry.level)).toEqual(['log', 'warn']);
    expect(Number.isNaN(Date.parse(result.logs[0]!.at))).toBe(false);
  });

  test('reports a throw as the failure it is', async () => {
    const result = await runPreview(
      `export default { fetch() { throw new Error('kaboom'); } };`,
      GET,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('kaboom');
  });

  test('names the contract when there is no default export', async () => {
    const result = await runPreview('export const fetch = () => {};', GET);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch(request, env)');
  });

  test('sends a body on a POST', async () => {
    const result = await runPreview(
      `export default {
         async fetch(request) {
           return new Response(request.method + ' ' + (await request.text()));
         },
       };`,
      { method: 'POST', path: '/', body: 'payload' },
    );
    expect(result.body).toBe('POST payload');
  });

  test('a handler that never returns times out rather than wedging', async () => {
    const result = await runPreview(
      'export default { fetch() { while (true) {} } };',
      GET,
      { timeoutMs: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timed out after 0.5s');
    expect(result.durationMs).toBeLessThan(3000);
  });
});
