/**
 * The mounted bosun poll surface (Task: bosun build route).
 *
 * Mirrors `webhook-route.test.ts`'s shape for the other machine-authed
 * route: real `Request`s against the handlers `webRoutes` mounts, over a real
 * outbox row. The claim endpoint's long-poll window is injected short so
 * these tests take milliseconds, not the ~25s production waits.
 */
import { describe, expect, test } from 'bun:test';
import { buildOutbox } from '../../src/storage/build-outbox.ts';
import {
  BOSUN_CLAIM_PATH,
  BOSUN_HEARTBEAT_PATH,
  BOSUN_RESULT_PATH,
  type BosunRouteDeps,
  bosunRoutes,
} from '../../src/web/bosun-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();
const SECRET = 'the-pools-shared-secret';
const NOW = new Date('2026-08-10T00:00:00.000Z');

function deps(overrides: Partial<BosunRouteDeps> = {}): BosunRouteDeps {
  return {
    db: database().db,
    // A real, advancing clock — not `NOW` — because the claim route's
    // long-poll budget measures real elapsed time against it. `pollTimeoutMs`
    // below is what keeps that real wait down to single-digit milliseconds
    // rather than the production ~25s.
    clock: { now: () => new Date() },
    secret: SECRET,
    pollIntervalMs: 1,
    pollTimeoutMs: 5,
    ...overrides,
  };
}

function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://spindrift.example.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function post(
  routePath: string,
  d: BosunRouteDeps,
  req: Request,
): Promise<Response> {
  return bosunRoutes(d)[routePath]!(req);
}

describe('authentication, identical across all three routes', () => {
  test('refuses every request when no secret is configured', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps({ secret: null }),
      request(BOSUN_CLAIM_PATH, { classes: ['skiff-a'] }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).failure.code).toBe('NOT_CONFIGURED');
  });

  test('refuses a wrong bearer token', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      request(
        BOSUN_CLAIM_PATH,
        { classes: ['skiff-a'] },
        {
          authorization: 'Bearer not-the-secret',
        },
      ),
    );
    expect(response.status).toBe(401);
  });

  test('refuses a missing bearer token', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      request(
        BOSUN_CLAIM_PATH,
        { classes: ['skiff-a'] },
        { authorization: '' },
      ),
    );
    expect(response.status).toBe(401);
  });

  test('refuses a non-POST', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      new Request(`https://spindrift.example.test${BOSUN_CLAIM_PATH}`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(405);
  });
});

describe('claim', () => {
  test('nothing claimable answers 204 after the poll window', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      request(BOSUN_CLAIM_PATH, { classes: ['skiff-a'] }),
    );
    expect(response.status).toBe(204);
  });

  test('claims the enqueued request and returns it verbatim', async () => {
    const store = buildOutbox(database().db, () => NOW);
    const body = { source: { bundleDigest: 'sha256:bundle' }, spec: {} };
    const { id } = await store.enqueue({ class: 'skiff-a', request: body });

    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      request(BOSUN_CLAIM_PATH, { classes: ['skiff-a'] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id,
      class: 'skiff-a',
      request: body,
    });
  });

  test('a malformed body is refused', async () => {
    const response = await post(
      BOSUN_CLAIM_PATH,
      deps(),
      request(BOSUN_CLAIM_PATH, { classes: [] }),
    );
    expect(response.status).toBe(400);
  });
});

describe('heartbeat', () => {
  test('extends a claimed request’s lease', async () => {
    const store = buildOutbox(database().db, () => NOW);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    const response = await post(
      BOSUN_HEARTBEAT_PATH,
      deps(),
      request(`/internal/bosun/requests/${id}/heartbeat`),
    );
    expect(response.status).toBe(204);
  });

  test('an unknown or unclaimed id is 404', async () => {
    const response = await post(
      BOSUN_HEARTBEAT_PATH,
      deps(),
      request(`/internal/bosun/requests/${crypto.randomUUID()}/heartbeat`),
    );
    expect(response.status).toBe(404);
  });
});

describe('result', () => {
  test('records a result for a claimed request', async () => {
    const store = buildOutbox(database().db, () => NOW);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    const response = await post(
      BOSUN_RESULT_PATH,
      deps(),
      request(`/internal/bosun/requests/${id}/result`, {
        status: 'SUCCEEDED',
        log: 'the build finished',
      }),
    );
    expect(response.status).toBe(204);
    expect((await store.get(id))?.state).toBe('DONE');
  });

  test('an unknown id is 404', async () => {
    const response = await post(
      BOSUN_RESULT_PATH,
      deps(),
      request(`/internal/bosun/requests/${crypto.randomUUID()}/result`, {
        status: 'FAILED',
        log: '',
      }),
    );
    expect(response.status).toBe(404);
  });

  test('a second result is 409', async () => {
    const store = buildOutbox(database().db, () => NOW);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);
    await store.complete(id, { status: 'SUCCEEDED', log: 'first' });

    const response = await post(
      BOSUN_RESULT_PATH,
      deps(),
      request(`/internal/bosun/requests/${id}/result`, {
        status: 'FAILED',
        log: 'second, too late',
      }),
    );
    expect(response.status).toBe(409);
  });

  test('a log over 2 MiB is refused', async () => {
    const store = buildOutbox(database().db, () => NOW);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    const response = await post(
      BOSUN_RESULT_PATH,
      deps(),
      request(`/internal/bosun/requests/${id}/result`, {
        status: 'SUCCEEDED',
        log: 'x'.repeat(2 * 1024 * 1024 + 1),
      }),
    );
    expect(response.status).toBe(400);
  });
});
