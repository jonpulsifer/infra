/**
 * The one bounded call: what it is allowed to repeat, and how far the bound
 * reaches.
 */
import { afterAll, expect, test } from 'bun:test';
import { reach, timedOut } from '../cli/reach.ts';

/** How many requests actually arrived, which is the point of half of this. */
let hits = 0;

const site = Bun.serve({
  port: 0,
  async fetch(request) {
    hits += 1;
    const { pathname } = new URL(request.url);
    if (pathname === '/stall') {
      // Headers, then a body that never ends: the hang that wears a 200.
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array([123])),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    // Slower than a sliced bound would allow, well inside a whole one.
    await Bun.sleep(400);
    return Response.json({ ok: true });
  },
});
const url = (path: string) => `${site.url.origin}${path}`;
afterAll(() => site.stop(true));

test('sends a request that changes something exactly once', async () => {
  // `DELETE /api/sites/:name` carries no body and deletes a site: a retry
  // after a deadline is a second delete, not a second try.
  hits = 0;
  await expect(
    reach(url('/site'), { method: 'DELETE' }, 250),
  ).rejects.toThrow();
  expect(hits).toBe(1);
});

test('gives the first attempt the whole bound', async () => {
  // Halving it per attempt would fail this call at 250ms on a site answering
  // in 400, and would have asked twice on the way.
  hits = 0;
  const answer = await reach(url('/site'), {}, 2_000);
  expect(await answer.json()).toEqual({ ok: true });
  expect(hits).toBe(1);
});

test('bounds the body, not just the headers', async () => {
  const answer = await reach(url('/stall'), {}, 250);
  expect(answer.status).toBe(200);
  const read = await answer.text().then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(timedOut(read)).toBe(true);
});

test('leaves a streamed body alone', async () => {
  // The proxy hands the answer to the tab as it arrives; a completion streamed
  // token by token is as long as the site means it to be.
  const answer = await reach(url('/stall'), {}, 250, true);
  const reader = answer.body!.getReader();
  await reader.read();
  await Bun.sleep(400);
  const next = await Promise.race([
    reader.read().then(() => 'read'),
    Bun.sleep(100).then(() => 'still open'),
  ]);
  expect(next).toBe('still open');
  await reader.cancel();
});
