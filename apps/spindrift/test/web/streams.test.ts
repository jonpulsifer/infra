import { describe, expect, test } from 'bun:test';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
  users,
} from '../../src/db/schema.ts';
import {
  recordBuildEvent,
  recordDeployEvent,
} from '../../src/domain/attempt-log.ts';
import {
  ATTEMPT_STREAM_PATH,
  readStreamPage,
  type StreamSocketData,
  streamRoutes,
  streamWebSocket,
} from '../../src/web/streams.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();

async function seedAttempt() {
  const [user] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const [app] = await database()
    .db.insert(apps)
    .values({ name: 'live-app', sourceKind: 'repo' })
    .returning();
  const [component] = await database()
    .db.insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues({ name: 'cluster' }))
    .returning();
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abc123',
      targetShape: 'image',
      artifactType: 'image',
    })
    .returning();
  const [deploy] = await database()
    .db.insert(deploys)
    .values({
      componentId: component!.id,
      targetId: target!.id,
      buildId: build!.id,
    })
    .returning();
  return {
    user: user!,
    app: app!,
    component: component!,
    target: target!,
    build: build!,
    deploy: deploy!,
  };
}

async function context(
  principal: { id: string; displayName: string },
  adapter: DeployAdapter = new FakeDeployAdapter(),
): Promise<CommandContext> {
  return {
    principal,
    clock: { now: () => new Date('2026-07-29T12:00:00Z') },
    db: database().db,
    adapters: {
      deploy: () => adapter,
      build: () => null,
      store: () => null,
      repository: () => null,
      supplyChain: () => {
        throw new Error('stream tests do not use supply chain');
      },
    },
    manifest: await fixtureManifest(),
  };
}

function request(query: string) {
  return new Request(
    `https://spindrift.example.test${ATTEMPT_STREAM_PATH}?${query}`,
    { headers: { upgrade: 'websocket' } },
  );
}

describe('authenticated attempt stream', () => {
  test('refuses an anonymous upgrade before constructing a context', async () => {
    const routes = streamRoutes({
      authenticate: async () => ({ kind: 'anonymous' }),
      context: () => {
        throw new Error('anonymous stream constructed a context');
      },
    });
    const server = {
      upgrade: () => {
        throw new Error('anonymous stream attempted an upgrade');
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const response = await routes[ATTEMPT_STREAM_PATH]!(
      request('buildId=1'),
      server,
    );
    expect(response?.status).toBe(401);
  });

  test('refuses a forbidden identity before constructing a context', async () => {
    const routes = streamRoutes({
      authenticate: async () => ({
        kind: 'forbidden',
        message: 'link the Gateway identity first',
      }),
      context: () => {
        throw new Error('forbidden stream constructed a context');
      },
    });
    const server = {
      upgrade: () => {
        throw new Error('forbidden stream attempted an upgrade');
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const response = await routes[ATTEMPT_STREAM_PATH]!(
      request('buildId=1'),
      server,
    );
    expect(response?.status).toBe(403);
  });

  test('replays after dropped connections and controller/web restarts without gaps or duplicates', async () => {
    const seeded = await seedAttempt();
    const principal = {
      id: seeded.user.id,
      displayName: seeded.user.displayName,
    };
    const ctx = await context(principal);
    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'log', line: 'compile one' },
    );

    let firstData: StreamSocketData | null = null;
    const firstServer = {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        firstData = options.data;
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const firstRoutes = streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal }),
      context: () => ctx,
    });
    const upgraded = await firstRoutes[ATTEMPT_STREAM_PATH]!(
      request(`buildId=${seeded.build.id}`),
      firstServer,
    );
    expect(upgraded).toBeUndefined();
    const first = await readStreamPage(firstData!);
    expect(first.kind).toBe('attempt');
    if (first.kind !== 'attempt') return;
    expect(first.entries.map((entry) => entry.type)).toEqual(['log']);

    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'status', phase: 'SUCCEEDED' },
    );

    let resumedData: StreamSocketData | null = null;
    const restartedServer = {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        resumedData = options.data;
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const restartedContext = await context(principal);
    const restartedRoutes = streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal }),
      context: () => restartedContext,
    });
    await restartedRoutes[ATTEMPT_STREAM_PATH]!(
      request(
        `buildId=${seeded.build.id}&after=${encodeURIComponent(String(first.cursor))}`,
      ),
      restartedServer,
    );
    const resumed = await readStreamPage(resumedData!);
    expect(resumed.kind).toBe('attempt');
    if (resumed.kind !== 'attempt') return;
    expect(resumed.entries).toHaveLength(1);
    expect(resumed.entries[0]?.type).toBe('status');
    expect(resumed.terminal).toBe(true);
  });

  test('an adapter read failure is a typed error and closes for cursor-preserving reconnect', async () => {
    class ThrowingAdapter extends FakeDeployAdapter {
      override async tail(): Promise<never> {
        throw new Error('cluster log endpoint is unavailable');
      }
    }

    const sent: string[] = [];
    const closes: [number, string][] = [];
    const socket = {
      data: {
        kind: 'runtime',
        adapter: new ThrowingAdapter(),
        target: {
          name: 'cluster',
          adapter: 'kubernetes',
          connection: targetValues({ name: 'cluster' }).connection!,
        },
        subject: { app: 'live-app', component: 'web' },
        cursor: 'durable-cursor',
        closed: false,
      },
      send: (message: string) => sent.push(message),
      close: (code: number, reason: string) => closes.push([code, reason]),
    } as unknown as Bun.ServerWebSocket<StreamSocketData>;

    streamWebSocket.open?.(socket);
    await Bun.sleep(1);

    expect(JSON.parse(sent[0]!)).toEqual({
      kind: 'error',
      message: 'cluster log endpoint is unavailable',
    });
    expect(closes).toEqual([[1011, 'stream read failed']]);
    expect(socket.data.cursor).toBe('durable-cursor');
  });

  test('a deploy terminal event is unambiguous and includes the red reason', async () => {
    const seeded = await seedAttempt();
    const principal = {
      id: seeded.user.id,
      displayName: seeded.user.displayName,
    };
    await recordDeployEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        deployId: seeded.deploy.id,
      },
      { type: 'status', phase: 'FAILED', reason: 'STARTUP_FAILED' },
    );
    let data: StreamSocketData | null = null;
    const server = {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        data = options.data;
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const ctx = await context(principal);
    await streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal }),
      context: () => ctx,
    })[ATTEMPT_STREAM_PATH]!(
      request(`buildId=${seeded.build.id}&deployId=${seeded.deploy.id}`),
      server,
    );
    const page = await readStreamPage(data!);
    expect(page.kind).toBe('attempt');
    if (page.kind !== 'attempt') return;
    expect(page.terminal).toBe(true);
    expect(page.entries[0]).toMatchObject({
      type: 'status',
      phase: 'FAILED',
      reason: 'STARTUP_FAILED',
    });
  });
});
