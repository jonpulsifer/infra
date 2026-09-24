// Which routes answer for which `Host`, through a real `Bun.serve`: its router
// matches by path alone, so host scoping exists only in the served table.
import { afterEach, describe, expect, test } from 'bun:test';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import type { GatewayDeps } from '../../src/auth/gateway.ts';
import { authPathFor } from '../../src/auth/routes.ts';
import type { Database } from '../../src/db/client.ts';
import { apps, components } from '../../src/db/schema.ts';
import { BOSUN_CLAIM_PATH } from '../../src/web/bosun-route.ts';
import {
  inClusterHostnames,
  SERVICE_NAME_VAR,
  SERVICE_NAMESPACE_VAR,
  scopeToHost,
} from '../../src/web/host-scope.ts';
import { MCP_PATH } from '../../src/web/mcp-route.ts';
import { HEALTH_PATH, READY_PATH, webRoutes } from '../../src/web/routes.ts';
import { STATUS_PATH } from '../../src/web/status-route.ts';
import { streamWebSocket } from '../../src/web/streams.ts';
import { WEBHOOK_PATH } from '../../src/web/webhook-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const CONTROL_PLANE = manifest.controlPlane.hostname;
const ZONE = 'apps.example.test';
const APP_NAME = `someapp.${ZONE}`;
const PUBLIC_NAME = `spindrift-control.${ZONE}`;
const IN_CLUSTER = inClusterHostnames({
  [SERVICE_NAME_VAR]: 'spindrift',
  [SERVICE_NAMESPACE_VAR]: 'spindrift',
});
const CLIENT_DOCUMENT = 'the client document';

const anonymous = {
  authenticate: async () => ({ kind: 'anonymous' as const }),
  context: (): never => {
    throw new Error('an anonymous request reached a command context');
  },
};

function table(db: Database) {
  const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
  const auth: EnrolmentDeps & GatewayDeps = {
    db,
    clock,
    relyingParty: {
      id: CONTROL_PLANE,
      name: 'example',
      origin: `https://${CONTROL_PLANE}`,
    },
    enrolmentToken: null,
    gateway: null,
  };
  return webRoutes(
    { '/': new Response(CLIENT_DOCUMENT) },
    anonymous,
    auth,
    {
      db,
      clock,
      secret: async () => null,
      current: () => {
        throw new Error('an unsigned delivery read installation state');
      },
    },
    { db, clock, secret: null },
    {
      authenticate: async () => ({ kind: 'anonymous' as const }),
      auth: () => {
        throw new Error('a host-scope test reached the GitHub App identity');
      },
    },
    { db, current: async () => ({ manifest }) },
    anonymous,
  );
}

function mount(db: Database) {
  return scopeToHost(table(db), {
    controlPlane: CONTROL_PLANE,
    public: PUBLIC_NAME,
    inCluster: IN_CLUSTER,
  });
}

let server: Bun.Server<unknown> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function send(
  host: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  server ??= Bun.serve({
    port: 0,
    routes: mount(database().db) as never,
    websocket: streamWebSocket as never,
  });
  return fetch(new URL(path, server.url), {
    ...init,
    headers: { ...(init.headers as Record<string, string>), host },
  });
}

async function expectStatusPage(response: Response, what: string) {
  const body = await response.text();
  expect({ what, status: response.status }).toEqual({ what, status: 404 });
  expect(body).toContain('No app here');
}

const SERVED_PATHS = Object.keys(table({} as Database))
  .filter((path) => path !== STATUS_PATH)
  .map((path) => path.replaceAll(':id', 'r1'));

describe("an App's name reaches the status page and nothing else", () => {
  test('every control-plane path, read or written', async () => {
    for (const path of SERVED_PATHS) {
      for (const method of ['GET', 'POST']) {
        const response = await send(APP_NAME, path, {
          method,
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        await expectStatusPage(response, `${method} ${path}`);
      }
    }
  });

  test("a claimed name reports its App's standing, whatever the path", async () => {
    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'demo', sourceKind: 'repo' })
      .returning();
    await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' });

    const response = await send(`demo-web.${ZONE}`, authPathFor('session'));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Waiting for a first release');
  });

  test("a name that merely contains the control plane's is not it", async () => {
    const response = await send(`${CONTROL_PLANE}.${ZONE}`, '/');
    await expectStatusPage(response, 'suffixed control-plane name');
  });
});

describe('the control plane answers on its own name', () => {
  test('the client, the probes, auth, commands, and MCP', async () => {
    const client = await send(CONTROL_PLANE, '/');
    expect(await client.text()).toBe(CLIENT_DOCUMENT);

    const health = await send(CONTROL_PLANE, HEALTH_PATH);
    expect(await health.text()).toBe('ok\n');

    const session = await send(CONTROL_PLANE, authPathFor('session'));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ ok: true });

    const mcp = await send(CONTROL_PLANE, MCP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(mcp.status).toBe(401);
  });

  test('whatever the case, and with a port', async () => {
    const client = await send(`${CONTROL_PLANE.toUpperCase()}:443`, '/');
    expect(await client.text()).toBe(CLIENT_DOCUMENT);
  });
});

describe('the public name carries the machine surfaces and nothing else', () => {
  test('the webhook, the bosun outbox, and MCP reach their handlers', async () => {
    const webhook = await send(PUBLIC_NAME, WEBHOOK_PATH, {
      method: 'POST',
      body: '{}',
    });
    expect(webhook.status).toBe(503);
    expect(await webhook.json()).toMatchObject({
      failure: { code: 'NOT_CONFIGURED' },
    });

    const bosun = await send(PUBLIC_NAME, BOSUN_CLAIM_PATH, {
      method: 'POST',
      body: '{}',
    });
    expect(bosun.status).toBe(503);
    expect(await bosun.json()).toMatchObject({
      failure: { code: 'NOT_CONFIGURED' },
    });

    const mcp = await send(PUBLIC_NAME, MCP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(mcp.status).toBe(401);
  });

  test('the UI, auth, and the probes are not there', async () => {
    for (const path of ['/', authPathFor('session'), HEALTH_PATH]) {
      await expectStatusPage(await send(PUBLIC_NAME, path), path);
    }
  });
});

describe("the Service's in-cluster names carry the machine surfaces too", () => {
  test('every name cluster DNS answers for the Service', () => {
    expect(IN_CLUSTER).toEqual([
      'spindrift',
      'spindrift.spindrift',
      'spindrift.spindrift.svc',
      'spindrift.spindrift.svc.cluster.local',
    ]);
    expect(inClusterHostnames({ [SERVICE_NAME_VAR]: 'spindrift' })).toEqual([]);
  });

  test('MCP, the webhook, and the bosun outbox reach their handlers', async () => {
    for (const host of IN_CLUSTER) {
      const mcp = await send(`${host}:3000`, MCP_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect({ host, status: mcp.status }).toEqual({ host, status: 401 });

      for (const path of [WEBHOOK_PATH, BOSUN_CLAIM_PATH]) {
        const response = await send(host, path, { method: 'POST', body: '{}' });
        expect({ host, path, status: response.status }).toEqual({
          host,
          path,
          status: 503,
        });
      }
    }
  });

  test('the UI, auth, and the probes are not there', async () => {
    for (const host of IN_CLUSTER) {
      for (const path of ['/', authPathFor('session'), HEALTH_PATH]) {
        await expectStatusPage(await send(host, path), `${host}${path}`);
      }
    }
  });

  test('a public name that merely contains one is not it', async () => {
    const response = await send(
      `spindrift.spindrift.svc.cluster.local.${ZONE}`,
      MCP_PATH,
      { method: 'POST', body: '{}' },
    );
    await expectStatusPage(response, 'suffixed in-cluster name');
  });
});

describe('the kubelet probes by address', () => {
  test('both probes answer on an IPv4 or IPv6 pod address', async () => {
    for (const host of ['10.42.0.7:3000', '[fd00::7]:3000']) {
      expect(await (await send(host, HEALTH_PATH)).text()).toBe('ok\n');
      expect(await (await send(host, READY_PATH)).text()).toBe('ok\n');
    }
  });

  test('and nothing else does', async () => {
    const response = await send('10.42.0.7:3000', '/');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe(CLIENT_DOCUMENT);
  });
});
