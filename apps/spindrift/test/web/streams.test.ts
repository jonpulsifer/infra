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
  RUNTIME_STREAM_PATH,
  readStreamPage,
  type StreamSocketData,
  streamRoutes,
  streamWebSocket,
} from '../../src/web/streams.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

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
      desired: aDesiredDocument(),
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

  test('events written by the reconciler while no pump is connected are picked up on resume without gaps', async () => {
    // Simulates a controller restart: the web process was down (or the
    // WebSocket was disconnected), the reconciler kept writing events, and
    // then a new web process or a new WebSocket connection picks up from
    // the last cursor. This proves the durable cursor survives the gap.
    const seeded = await seedAttempt();
    const principal = {
      id: seeded.user.id,
      displayName: seeded.user.displayName,
    };

    // Phase 1: A pump reads the first event and records a cursor.
    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'log', line: 'step 1' },
    );

    let firstData: StreamSocketData | null = null;
    const firstServer = {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        firstData = options.data;
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const firstCtx = await context(principal);
    await streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal }),
      context: () => firstCtx,
    })[ATTEMPT_STREAM_PATH]!(
      request(`buildId=${seeded.build.id}`),
      firstServer,
    );
    const firstPage = await readStreamPage(firstData!);
    expect(firstPage.kind).toBe('attempt');
    if (firstPage.kind !== 'attempt') return;
    expect(firstPage.entries).toHaveLength(1);
    const savedCursor = firstPage.cursor;

    // Phase 2: While no WebSocket is connected (simulating web downtime),
    // the reconciler writes multiple events. No pump is running.
    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'log', line: 'step 2' },
    );
    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'log', line: 'step 3' },
    );
    await recordDeployEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        deployId: seeded.deploy.id,
      },
      { type: 'status', phase: 'APPLYING' },
    );

    // Phase 3: A completely new context (simulating a restarted web
    // process) resumes from the saved cursor. All events written during
    // the gap must appear, in order, with no duplicates.
    let resumedData: StreamSocketData | null = null;
    const newServer = {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        resumedData = options.data;
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>;
    const newCtx = await context(principal);
    await streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal }),
      context: () => newCtx,
    })[ATTEMPT_STREAM_PATH]!(
      request(
        `buildId=${seeded.build.id}&deployId=${seeded.deploy.id}&after=${encodeURIComponent(String(savedCursor))}`,
      ),
      newServer,
    );
    const resumed = await readStreamPage(resumedData!);
    expect(resumed.kind).toBe('attempt');
    if (resumed.kind !== 'attempt') return;
    // Exactly the 3 events written during the gap, nothing from before
    expect(resumed.entries).toHaveLength(3);
    expect(resumed.entries.map((e) => e.type)).toEqual([
      'log',
      'log',
      'status',
    ]);
    if (resumed.entries[0]?.type === 'log') {
      expect(resumed.entries[0].line).toBe('step 2');
    }
    if (resumed.entries[1]?.type === 'log') {
      expect(resumed.entries[1].line).toBe('step 3');
    }
    if (resumed.entries[2]?.type === 'status') {
      expect(resumed.entries[2].phase).toBe('APPLYING');
    }
  });
});

describe('in-process attempt event notifications', () => {
  test('notifyAttemptEvent wakes a subscribed listener', async () => {
    const { notifyAttemptEvent, onAttemptEvent } = await import(
      '../../src/db/notify.ts'
    );
    const wakes: string[] = [];
    const unsub = onAttemptEvent('comp-1', () => wakes.push('woke'));

    notifyAttemptEvent('comp-1');
    expect(wakes).toEqual(['woke']);

    // A second component's events do not wake this listener.
    notifyAttemptEvent('comp-2');
    expect(wakes).toEqual(['woke']);

    // After unsubscribing, no more wakes.
    unsub();
    notifyAttemptEvent('comp-1');
    expect(wakes).toEqual(['woke']);
  });

  test('recordBuildEvent fires the in-process notification', async () => {
    const { onAttemptEvent } = await import('../../src/db/notify.ts');
    const seeded = await seedAttempt();
    const wakes: string[] = [];
    const unsub = onAttemptEvent(seeded.component.id, () => wakes.push('woke'));

    await recordBuildEvent(
      database().db,
      {
        appId: seeded.app.id,
        componentId: seeded.component.id,
        buildId: seeded.build.id,
      },
      { type: 'log', line: 'triggers notification' },
    );

    expect(wakes).toEqual(['woke']);
    unsub();
  });
});

/**
 * §17's second pipe, aimed at a job.
 *
 * A job's output belongs to a run, so the subject the socket carries has to say
 * which one. Both directions are asserted, because the failure of each is
 * silent: a job with no run named would tail every run at once, and a service
 * with one named would drop the name and hand back the Component's whole tail
 * under it.
 */
describe('a job tails one run rather than the Component', () => {
  async function seedJob(): Promise<{
    user: { id: string; displayName: string };
    componentId: string;
    serviceId: string;
    targetId: string;
  }> {
    const seeded = await seedAttempt();
    const [job] = await database()
      .db.insert(components)
      .values({ appId: seeded.app.id, name: 'nightly', kind: 'job' })
      .returning();
    await database()
      .db.insert(deploys)
      .values({
        componentId: job?.id as string,
        desired: aDesiredDocument(),
        targetId: seeded.target.id,
        buildId: seeded.build.id,
      });
    return {
      user: seeded.user,
      componentId: job?.id as string,
      serviceId: seeded.component.id,
      targetId: seeded.target.id,
    };
  }

  function runtimeRequest(query: string): Request {
    return new Request(
      `https://spindrift.example.test${RUNTIME_STREAM_PATH}?${query}`,
      { headers: { upgrade: 'websocket' } },
    );
  }

  async function upgrade(
    user: { id: string; displayName: string },
    query: string,
  ): Promise<{ response: Response | undefined; upgraded: StreamSocketData[] }> {
    const upgraded: StreamSocketData[] = [];
    const ctx = await context(user);
    const response = await streamRoutes({
      authenticate: async () => ({ kind: 'authenticated', principal: user }),
      context: () => ctx,
    })[RUNTIME_STREAM_PATH]?.(runtimeRequest(query), {
      upgrade: (_request: Request, options: { data: StreamSocketData }) => {
        upgraded.push(options.data);
        return true;
      },
    } as unknown as Bun.Server<StreamSocketData>);
    return { response, upgraded };
  }

  test('a named run becomes the subject the adapter is asked about', async () => {
    const { user, componentId, targetId } = await seedJob();

    const { response, upgraded } = await upgrade(
      user,
      `componentId=${componentId}&targetId=${targetId}&execution=nightly-2`,
    );

    expect(response).toBeUndefined();
    const socket = upgraded[0];
    expect(socket?.kind).toBe('runtime');
    if (socket?.kind !== 'runtime') return;
    expect(socket.subject).toEqual({
      app: 'live-app',
      component: 'nightly',
      execution: 'nightly-2',
    });
  });

  test('a run name that is not one is refused before an adapter sees it', async () => {
    // The Cloud Run adapter concatenates this into a Cloud Logging filter over
    // `projects/<vessel>`, joining its clauses with ` AND `. `AND` binds
    // tighter than `OR`, so a value carrying a quote and an `OR` widens the
    // filter to every entry the project has — other Apps' output, GCP audit
    // logs — and the lines render in the run pane of whoever asked for them.
    // The check is here because this is the one place the value crosses in
    // from a browser.
    const { user, componentId, targetId } = await seedJob();

    for (const attempt of [
      'a" OR timestamp>="2020-01-01T00:00:00Z',
      'nightly-2" OR "x"="x',
      // `?execution=` is an empty string rather than `null`, so it passes the
      // "name one to read it" guard and names nothing.
      '',
      'Nightly-2',
      'nightly_2',
      // Deliberately narrower than Kubernetes, which names a Job as a DNS
      // *subdomain*: dots are legal there, and `executions()` lists by label,
      // so a Job somebody else created can reach the card under a name this
      // refuses. That is the trade — a name Spindrift cannot have produced
      // does not get to widen a browser-controlled string on its way into two
      // query languages, and one row whose log pane will not open is a smaller
      // failure than one that opens the whole project's.
      'blog.nightly-1',
    ]) {
      const { response, upgraded } = await upgrade(
        user,
        `componentId=${componentId}&targetId=${targetId}&execution=${encodeURIComponent(attempt)}`,
      );
      expect(response?.status).toBe(400);
      expect(upgraded).toHaveLength(0);
    }
  });

  test('a job with no run named still refuses, and says how to ask', async () => {
    const { user, componentId, targetId } = await seedJob();

    const { response } = await upgrade(
      user,
      `componentId=${componentId}&targetId=${targetId}`,
    );

    expect(response?.status).toBe(409);
    const body = (await response?.json()) as {
      failure: { code: string; message: string };
    };
    expect(body.failure.code).toBe('NO_RUNTIME');
    expect(body.failure.message).toContain('name one to read it');
  });

  test('a service is refused a run, rather than quietly given its tail', async () => {
    const { user, serviceId, targetId } = await seedJob();

    const { response } = await upgrade(
      user,
      `componentId=${serviceId}&targetId=${targetId}&execution=nightly-2`,
    );

    expect(response?.status).toBe(409);
    const body = (await response?.json()) as { failure: { message: string } };
    expect(body.failure.message).toContain('only a job has runs');
  });
});
