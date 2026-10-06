// The readiness handler against a live Postgres and an unreachable one.
import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import type { GatewayDeps } from '../../src/auth/gateway.ts';
import { createDb, type Database } from '../../src/db/client.ts';
import { READY_PATH, webRoutes } from '../../src/web/routes.ts';
import type { WebhookRouteDeps } from '../../src/web/webhook-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

// A stand-in, so this file never needs a client build.
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
    {
      db,
      current: () => {
        throw new Error('a readiness test read the installation');
      },
    },
    noSession,
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
    // Nothing listens on port 1. connectionTimeout is in seconds; Bun's default is 30.
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
