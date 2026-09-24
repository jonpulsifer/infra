// A queued Build ends here. A running Build is stopped through its route,
// which writes the verdict, unless its lease expired and its process is gone.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cancelBuild } from '../../src/commands/builds/cancel.ts';
import { DISPATCH_LEASE_TIMEOUT_MS } from '../../src/commands/builds/dispatch.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-22T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function registryOf(route: FakeBuildAdapter | null): AdapterRegistry {
  return {
    deploy: () => null,
    build: (name: string) => (name === 'hosted' ? route : null),
    store: () => {
      throw new Error('cancelling reached the secret store');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('cancelling reached the supply chain');
    },
  } as unknown as AdapterRegistry;
}

function context(route: FakeBuildAdapter | null = null): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Jordan' },
    clock,
    db: database().db,
    adapters: registryOf(route),
    manifest,
  };
}

async function aBuild(row: {
  status: 'PENDING' | 'RUNNING';
  leasedAt?: Date | null;
  dispatchWaitingOn?: string;
  runner?: string;
  runUrl?: string;
}) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({
      name: `shop-${crypto.randomUUID()}`,
      sourceKind: 'repo',
      sourceRepoUrl: 'https://x/shop',
    })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'a'.repeat(40),
      targetShape: 'vercel-output',
      artifactType: 'vercel-output',
      bundleDigest: `sha256:${'b'.repeat(64)}`,
      bundleLocation: 'https://depot.lolwtf.ca/bundles/1.zip',
      status: row.status,
      dispatchId: row.status === 'RUNNING' ? crypto.randomUUID() : null,
      leasedAt: row.leasedAt ?? null,
      dispatchWaitingOn: row.dispatchWaitingOn ?? null,
      runner: row.runner ?? null,
      runUrl: row.runUrl ?? null,
    })
    .returning();
  return build!;
}

const rowOf = async (id: number) =>
  (await database().db.select().from(builds).where(eq(builds.id, id)))[0]!;

const logOf = async (id: number) =>
  database()
    .db.select()
    .from(attemptEvents)
    .where(eq(attemptEvents.buildId, id));

describe('cancelling a queued Build', () => {
  test('ends terminal, waiting on nothing, and the log says who', async () => {
    const build = await aBuild({
      status: 'PENDING',
      dispatchWaitingOn: 'this Build produces a vercel-output artifact and…',
    });

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('FAILED');

    const row = await rowOf(build.id);
    expect(row.status).toBe('FAILED');
    expect(row.dispatchWaitingOn).toBeNull();
    expect(row.nextDispatchAt).toBeNull();

    const log = await logOf(build.id);
    expect(log.map((event) => event.line ?? '').join('\n')).toContain(
      'cancelled by Jordan',
    );
    // No reason: a cancel is neither the developer's fault nor the platform's.
    const verdict = log.find((event) => event.phase === 'FAILED')!;
    expect(verdict.reason).toBeNull();
    expect(verdict.blame).toBeNull();
  });

  test('a Build that already finished has nothing to cancel', async () => {
    const build = await aBuild({ status: 'PENDING' });
    await database()
      .db.update(builds)
      .set({ status: 'SUCCEEDED' })
      .where(eq(builds.id, build.id));

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(false);
    expect((await rowOf(build.id)).status).toBe('SUCCEEDED');
  });
});

describe('cancelling a running Build', () => {
  test('stops the far side through its route, and leaves the verdict to it', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: FROZEN,
      runner: 'hosted',
      runUrl: 'https://github.com/example/shop/actions/runs/7',
    });

    const result = await cancelBuild({ id: build.id }, context(route));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('RUNNING');

    // The route gets only what the row keeps about the far side.
    expect(route.cancelled).toEqual([
      { dispatchId: build.dispatchId!, runUrl: build.runUrl },
    ]);

    // The fenced write belongs to the attempt that still holds its claim.
    const row = await rowOf(build.id);
    expect(row.status).toBe('RUNNING');
    expect(row.dispatchId).toBe(build.dispatchId!);
    expect(row.leasedAt).toEqual(FROZEN);

    const log = await logOf(build.id);
    expect(log.map((event) => event.line ?? '').join('\n')).toContain(
      'cancel requested by Jordan',
    );
    expect(log.some((event) => event.phase === 'FAILED')).toBe(false);
  });

  test('is refused when the far side finished while the cancel was in flight, and the verdict stands', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: FROZEN,
      runner: 'hosted',
    });
    // The Build succeeds between the command's read and its cancel.
    route.cancel = async () => {
      await database()
        .db.update(builds)
        .set({ status: 'SUCCEEDED' })
        .where(eq(builds.id, build.id));
    };

    const result = await cancelBuild({ id: build.id }, context(route));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain('succeeded');
    expect((await rowOf(build.id)).status).toBe('SUCCEEDED');
    expect(await logOf(build.id)).toHaveLength(0);
  });

  test('is refused when its route is not configured here, and the row is untouched', async () => {
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: FROZEN,
      runner: 'retired',
    });

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain('retired');
    expect((await rowOf(build.id)).status).toBe('RUNNING');
    expect(await logOf(build.id)).toHaveLength(0);
  });

  test('is refused when the route cannot stop the far side, and says why', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    route.cancel = async () => {
      throw new Error('the host reported no address for this run');
    };
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: FROZEN,
      runner: 'hosted',
    });

    const result = await cancelBuild({ id: build.id }, context(route));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain('reported no address');
    }
    expect((await rowOf(build.id)).status).toBe('RUNNING');
    expect(await logOf(build.id)).toHaveLength(0);
  });

  test('whose lease has expired settles here, and the far side is told anyway', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: new Date(FROZEN.getTime() - DISPATCH_LEASE_TIMEOUT_MS - 1),
      runner: 'hosted',
    });

    const result = await cancelBuild({ id: build.id }, context(route));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('FAILED');

    const row = await rowOf(build.id);
    expect(row.status).toBe('FAILED');
    // The abandoned attempt's write names a dispatch id the row no longer
    // carries.
    expect(row.dispatchId).toBeNull();
    // The Job may outlive the process that held the lease.
    expect(route.cancelled).toEqual([
      { dispatchId: build.dispatchId!, runUrl: null },
    ]);
  });

  test('whose lease has expired settles here even when the route will not answer', async () => {
    const route = new FakeBuildAdapter({ name: 'hosted' });
    route.cancel = async () => {
      throw new Error('the host is unreachable');
    };
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: new Date(FROZEN.getTime() - DISPATCH_LEASE_TIMEOUT_MS - 1),
      runner: 'hosted',
    });

    const result = await cancelBuild({ id: build.id }, context(route));
    expect(result.ok).toBe(true);
    expect((await rowOf(build.id)).status).toBe('FAILED');
  });
});
