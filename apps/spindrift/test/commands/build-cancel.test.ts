/**
 * Cancelling a queued Build (`cancelBuild`).
 *
 * The dispatch loop's `waits` arm has no exit of its own — that is the point of
 * it — so the claim under test is that an operator has one, and that it does
 * not reach past what §4 lets it stop:
 *
 * - **A queued Build ends, and says who ended it.** The row is terminal and its
 *   `dispatchWaitingOn` sentence is gone with it, so nothing reads as still
 *   waiting; the attempt log is where the act survives.
 * - **A running Build is refused.** The route's own terminal write is what ends
 *   an attempt, so a cancel that returned `ok` here would be a button that
 *   claims to have stopped something still streaming.
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
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-22T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** Nothing here reaches an adapter: cancelling is a row and two log lines. */
const adapters = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('cancelling reached the secret store');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('cancelling reached the supply chain');
  },
} as unknown as AdapterRegistry;

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Jordan' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** One Build in the state the caller names, and nothing else. */
async function aBuild(row: {
  status: 'PENDING' | 'RUNNING';
  leasedAt?: Date | null;
  dispatchWaitingOn?: string;
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
    })
    .returning();
  return build!;
}

const rowOf = async (id: number) =>
  (await database().db.select().from(builds).where(eq(builds.id, id)))[0]!;

describe('cancelling a Build', () => {
  test('a queued Build ends terminal, waiting on nothing, and the log says who', async () => {
    const build = await aBuild({
      status: 'PENDING',
      dispatchWaitingOn: 'this Build produces a vercel-output artifact and…',
    });

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(true);

    const row = await rowOf(build.id);
    expect(row.status).toBe('FAILED');
    expect(row.dispatchWaitingOn).toBeNull();
    expect(row.nextDispatchAt).toBeNull();

    const log = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.buildId, build.id));
    expect(log.map((event) => event.line ?? '').join('\n')).toContain(
      'cancelled by Jordan',
    );
    // No reason: §6's set indicts a developer or the platform, and this is
    // neither — so nothing derives a blame from it either.
    const verdict = log.find((event) => event.phase === 'FAILED')!;
    expect(verdict.reason).toBeNull();
    expect(verdict.blame).toBeNull();
  });

  test('a Build under a live lease is refused, because nothing here can stop it', async () => {
    const build = await aBuild({ status: 'RUNNING', leasedAt: FROZEN });

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(false);
    expect((await rowOf(build.id)).status).toBe('RUNNING');
  });

  test('a Build whose lease has expired cancels: nothing is coming back for it', async () => {
    const build = await aBuild({
      status: 'RUNNING',
      leasedAt: new Date(FROZEN.getTime() - DISPATCH_LEASE_TIMEOUT_MS - 1),
    });

    const result = await cancelBuild({ id: build.id }, context());
    expect(result.ok).toBe(true);

    const row = await rowOf(build.id);
    expect(row.status).toBe('FAILED');
    // Fenced out: the abandoned attempt's terminal write names a dispatch id
    // this row no longer carries, so it cannot overwrite the verdict.
    expect(row.dispatchId).toBeNull();
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
