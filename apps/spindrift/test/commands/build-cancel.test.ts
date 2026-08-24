/**
 * Cancelling a Build (`cancelBuild`).
 *
 * The dispatch loop's `waits` arm has no exit of its own — that is the point of
 * it — so the claim under test is that an operator has one, and that what it
 * reaches past a queued row it reaches the honest way:
 *
 * - **A queued Build ends, and says who ended it.** The row is terminal and its
 *   `dispatchWaitingOn` sentence is gone with it, so nothing reads as still
 *   waiting; the attempt log is where the act survives.
 * - **A running Build is stopped through its route and settled by it.** §4
 *   makes the route's own terminal write what ends an attempt, so the command
 *   kills the far side and writes no verdict: the row stays `RUNNING` under
 *   its live lease, the route's fenced write is what will end it, and the log
 *   says who asked.
 * - **A running Build nothing here can reach is refused.** A route this
 *   installation no longer configures, or one whose far side would not stop,
 *   is a cancel that did not happen — and the row is left as it was.
 * - **A running Build whose lease has expired is not that case.** Nothing is
 *   coming back for it, which is the same condition that makes it reclaimable.
 */
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

/**
 * The one route a running Build can be cancelled through, or none. Nothing
 * else here reaches an adapter: cancelling a queued row is a row and two log
 * lines.
 */
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

/** One Build in the state the caller names, and nothing else. */
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
    // No reason: §6's set indicts a developer or the platform, and this is
    // neither — so nothing derives a blame from it either.
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

    // The route was handed what the row keeps about the far side — and no
    // more, because that is all another process could ever have.
    expect(route.cancelled).toEqual([
      { dispatchId: build.dispatchId!, runUrl: build.runUrl },
    ]);

    // Not settled here: the fenced write belongs to the attempt streaming
    // into this row, and it still holds its claim.
    const row = await rowOf(build.id);
    expect(row.status).toBe('RUNNING');
    expect(row.dispatchId).toBe(build.dispatchId!);
    expect(row.leasedAt).toEqual(FROZEN);

    const log = await logOf(build.id);
    expect(log.map((event) => event.line ?? '').join('\n')).toContain(
      'cancelled by Jordan',
    );
    expect(log.some((event) => event.phase === 'FAILED')).toBe(false);
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

  test('whose lease has expired settles here: nothing is coming back for it', async () => {
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
    // Fenced out: the abandoned attempt's terminal write names a dispatch id
    // this row no longer carries, so it cannot overwrite the verdict.
    expect(row.dispatchId).toBeNull();
    // And nothing reached the route: whatever it was running is not coming
    // back, which is the condition that made the row settle here.
    expect(route.cancelled).toEqual([]);
  });
});
