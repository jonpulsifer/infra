import { describe, expect, test } from 'bun:test';
import { command } from '../../src/web/client.ts';
import { SESSION_EXPIRED_EVENT } from '../../src/web/session-events.ts';

function stubFetch(body: unknown, status: number): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

async function withStubbedFetch<T>(
  body: unknown,
  status: number,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(body, status);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('the browser command boundary re-gates on an expired session', () => {
  test('UNAUTHENTICATED raises the shared session-expired signal', async () => {
    let fired = false;
    const onExpired = () => {
      fired = true;
    };
    addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    const result = await withStubbedFetch(
      { ok: false, failure: { code: 'UNAUTHENTICATED', message: 'expired' } },
      401,
      () => command('getInstallationManifest', {}),
    );

    removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    expect(result.ok).toBe(false);
    expect(fired).toBe(true);
  });

  test('an ordinary refusal is left for the view to render, not re-gated', async () => {
    let fired = false;
    const onExpired = () => {
      fired = true;
    };
    addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    await withStubbedFetch(
      { ok: false, failure: { code: 'INTERNAL', message: 'boom' } },
      500,
      () => command('getInstallationManifest', {}),
    );

    removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    expect(fired).toBe(false);
  });
});
