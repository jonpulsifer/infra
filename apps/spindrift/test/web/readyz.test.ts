/**
 * `/readyz` — whether this pod can currently reach the database.
 *
 * `test/web/routes.test.ts` proves the route-table *shape*, and does it with a
 * `db` Proxy that throws on any access precisely so those tests never touch a
 * real connection. This file is the complement: it is the one place that
 * calls the readiness handler for real, against a healthy Postgres and
 * against one that cannot be reached — because the whole point of `/readyz`
 * is telling those two states apart, and a route-table test that never
 * invokes a handler could not prove that either way.
 */
import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import type { GatewayDeps } from '../../src/auth/gateway.ts';
import { createDb, type Database } from '../../src/db/client.ts';
import { READY_PATH, webRoutes } from '../../src/web/routes.ts';
import type { WebhookRouteDeps } from '../../src/web/webhook-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

/** A stand-in for the client, so this file never depends on a build having run. */
const CLIENT = { '/': new Response('the client document') };

const noSession = {
  authenticate: async () => ({ kind: 'anonymous' as const }),
  context: (): never => {
    throw new Error('unreachable — /readyz needs no session and no command');
  },
};

function authDeps(db: Database): EnrolmentDeps & GatewayDeps {
  return {
    db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    relyingParty: {
      id: 'spindrift.example.test',
      name: 'example',
      origin: 'https://spindrift.example.test',
    },
    enrolmentToken: null,
    gateway: null,
  };
}

/** Inert: `/readyz` never routes a delivery, so reaching these is the bug. */
function noWebhook(db: Database): WebhookRouteDeps {
  return {
    db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    secret: async () => null,
    current: () => {
      throw new Error('a readiness test read installation state');
    },
  };
}

/** Inert: `/readyz` never routes a claim, so reaching these is the bug. */
function noBosun(db: Database) {
  return {
    db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    secret: null,
  };
}

async function readyz(db: Database): Promise<Response> {
  const routes = webRoutes(
    CLIENT,
    noSession,
    authDeps(db),
    noWebhook(db),
    noBosun(db),
    {
      authenticate: () => {
        throw new Error('a readiness test authenticated a request');
      },
      auth: () => {
        throw new Error('a readiness test reached the GitHub App identity');
      },
    },
  );
  const handler = routes[READY_PATH] as () => Promise<Response>;
  return handler();
}

describe('/readyz', () => {
  test('answers ok with a live database round trip', async () => {
    const response = await readyz(database().db);
    expect(response.status).toBe(200);
    expect(await response.clone().text()).toBe('ok\n');
  });

  test('answers 503 when the database cannot be reached', async () => {
    // Port 1 is a reserved port nothing listens on. Bun's default connection
    // timeout is 30s, which is far longer than a test should wait to prove a
    // negative, so it is cut down to keep this fast rather than flaky.
    const client = new SQL(
      'postgres://postgres:postgres@127.0.0.1:1/spindrift',
      {
        connectionTimeout: 1,
      },
    );
    try {
      const response = await readyz(createDb(client));
      expect(response.status).toBe(503);
      expect(await response.clone().text()).toContain('not ready');
    } finally {
      await client.close();
    }
  });
});
