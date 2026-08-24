/**
 * Cancelling a Deploy (`cancelDeploy`, §6).
 *
 * The command is two acts under one name, and the refusals are the edges of
 * each:
 *
 * - **An intent nobody has claimed ends here.** `PENDING` is a row and nothing
 *   else, so the command fails it and moves the desired pointer back — only
 *   when the intent is what the pointer names. An older intent queued behind a
 *   newer one never held it, and a first-ever intent had nothing before it.
 * - **An in-flight attempt is only asked.** The generator is in the reconciler
 *   and the row stays `APPLYING`/`WAITING` with the request stamped; the loop's
 *   own tests prove the attempt honours it.
 * - **A verdict is not cancellable.** `LIVE` is a rollback wearing the wrong
 *   word, and `FAILED` has nothing left to stop.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cancelDeploy } from '../../src/commands/deploys/cancel.ts';
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
  componentTargetDesired,
  type Deploy,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-23T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** Nothing here reaches an adapter: cancelling is rows and log lines. */
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

/** One Component@Target with a desired row, and a way to add intents to it. */
async function pair() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, adapter: 'kubernetes' }))
    .returning();
  const [desired] = await db
    .insert(componentTargetDesired)
    .values({ componentId: component!.id, targetId: target!.id })
    .returning();

  let seed = 0;
  /** A new Build and an intent naming it, with the pointer moved onto it. */
  const intent = async (phase: Deploy['phase'], attemptId?: string) => {
    seed += 1;
    const [build] = await db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: `commit-${seed}`,
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${seed.toString(16).padStart(64, '0')}`,
        status: 'SUCCEEDED',
      })
      .returning();
    const [deploy] = await db
      .insert(deploys)
      .values({
        componentId: component!.id,
        targetId: target!.id,
        buildId: build!.id,
        phase,
        desired: aDesiredDocument(),
        attemptId: attemptId ?? null,
      })
      .returning();
    await db
      .update(componentTargetDesired)
      .set({ desiredBuildId: build!.id, desiredDeployId: deploy!.id })
      .where(eq(componentTargetDesired.id, desired!.id));
    return deploy!;
  };

  const pointer = async () => {
    const [row] = await db
      .select({
        desiredBuildId: componentTargetDesired.desiredBuildId,
        desiredDeployId: componentTargetDesired.desiredDeployId,
      })
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.id, desired!.id));
    return row!;
  };

  return {
    intent,
    pointer,
    componentId: component!.id,
    targetId: target!.id,
  };
}

const rowOf = async (id: number) =>
  (await database().db.select().from(deploys).where(eq(deploys.id, id)))[0]!;

const linesOf = async (id: number) =>
  (
    await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, id))
  ).map((event) => event.phase ?? event.line);

describe('cancelling a Deploy', () => {
  test('a first-ever PENDING intent is failed and the pointer goes back to nothing', async () => {
    const { intent, pointer } = await pair();
    const deploy = await intent('PENDING');

    const result = await cancelDeploy({ id: deploy.id }, context());
    expect(result).toMatchObject({ ok: true, value: { phase: 'FAILED' } });

    expect(await rowOf(deploy.id)).toMatchObject({
      phase: 'FAILED',
      reason: null,
      blame: null,
      detail: 'cancelled by Jordan',
      cancelRequestedAt: FROZEN,
      cancelRequestedBy: 'Jordan',
    });
    // Nothing was desired here before it, so nothing is desired here now —
    // which is what lets `rollbackDeploy` say so rather than name this row.
    expect(await pointer()).toEqual({
      desiredBuildId: null,
      desiredDeployId: null,
    });
    expect(await linesOf(deploy.id)).toEqual(['cancelled by Jordan', 'FAILED']);
  });

  test('an older intent queued behind a newer one never held the pointer, so it stays', async () => {
    const { intent, pointer } = await pair();
    const older = await intent('PENDING');
    const newer = await intent('PENDING');

    const result = await cancelDeploy({ id: older.id }, context());
    expect(result).toMatchObject({ ok: true, value: { phase: 'FAILED' } });

    expect(await pointer()).toEqual({
      desiredBuildId: newer.buildId,
      desiredDeployId: newer.id,
    });
    expect((await rowOf(newer.id)).phase).toBe('PENDING');
  });

  test('the pointer skips intents that were cancelled before they were claimed', async () => {
    const { intent, pointer } = await pair();
    const landed = await intent('LIVE', crypto.randomUUID());
    const first = await intent('PENDING');
    expect((await cancelDeploy({ id: first.id }, context())).ok).toBe(true);
    const second = await intent('PENDING');

    // Back past the intent this same command already failed, to the release
    // that was actually desired before either press.
    expect((await cancelDeploy({ id: second.id }, context())).ok).toBe(true);
    expect(await pointer()).toEqual({
      desiredBuildId: landed.buildId,
      desiredDeployId: landed.id,
    });
  });

  test('an in-flight attempt is asked, not ended: the row stays in flight with the request on it', async () => {
    const { intent } = await pair();
    const deploy = await intent('WAITING', crypto.randomUUID());

    const result = await cancelDeploy({ id: deploy.id }, context());
    expect(result).toMatchObject({ ok: true, value: { phase: 'WAITING' } });

    expect(await rowOf(deploy.id)).toMatchObject({
      phase: 'WAITING',
      attemptId: deploy.attemptId,
      cancelRequestedAt: FROZEN,
      cancelRequestedBy: 'Jordan',
      detail: null,
    });
    expect(await linesOf(deploy.id)).toEqual([
      'cancel requested by Jordan; the attempt ends at its next event',
    ]);
  });

  test('a live release is refused towards rollback', async () => {
    const { intent } = await pair();
    const deploy = await intent('LIVE', crypto.randomUUID());

    const result = await cancelDeploy({ id: deploy.id }, context());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('roll back');
    expect(await rowOf(deploy.id)).toMatchObject({
      phase: 'LIVE',
      cancelRequestedAt: null,
    });
  });

  test('a failed release has nothing to cancel', async () => {
    const { intent } = await pair();
    const deploy = await intent('FAILED', crypto.randomUUID());

    const result = await cancelDeploy({ id: deploy.id }, context());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('nothing to cancel');
  });

  /**
   * The locking read, asserted the way `deploys.test.ts` asserts
   * `placeIntent`'s: the desired row is **held from another session**, the
   * command is watched stop, and the claim's write lands under the hold —
   * from inside it, because `claimNextDeploy` skips a locked pair rather than
   * waiting on it. Deleting cancel's `FOR UPDATE` fails this: the phase would
   * be re-read before the claim committed, and the command would report an
   * attempt it left streaming into the row as cancelled.
   */
  test('a claim that lands while the cancel waits on the desired row is what the cancel reads', async () => {
    const { intent, pointer, componentId, targetId } = await pair();
    const deploy = await intent('PENDING');
    const attemptId = crypto.randomUUID();

    const other = database().connect();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = other.begin(async (tx: typeof other) => {
      await tx.unsafe(
        'select * from component_target_desired where component_id = $1 and target_id = $2 for update',
        [componentId, targetId],
      );
      await held;
      // What `claimNextDeploy` writes under this lock.
      await tx.unsafe(
        "update deploys set phase = 'APPLYING', attempt_id = $1, updated_at = now() where id = $2",
        [attemptId, deploy.id],
      );
    });
    await Bun.sleep(100);

    let settled = false;
    const contending = cancelDeploy({ id: deploy.id }, context()).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    await Bun.sleep(400);
    expect(settled).toBe(false);

    release();
    await holding;

    // Asked, not ended: the claim came first, and the attempt it minted is
    // what will honour the request.
    expect(await contending).toMatchObject({
      ok: true,
      value: { deployId: deploy.id, phase: 'APPLYING' },
    });
    expect(await rowOf(deploy.id)).toMatchObject({
      phase: 'APPLYING',
      attemptId,
      cancelRequestedBy: 'Jordan',
    });
    expect(await pointer()).toEqual({
      desiredBuildId: deploy.buildId,
      desiredDeployId: deploy.id,
    });
    expect(await linesOf(deploy.id)).toEqual([
      'cancel requested by Jordan; the attempt ends at its next event',
    ]);
  });

  test('a Deploy that does not exist is not found', async () => {
    const result = await cancelDeploy({ id: 424242 }, context());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});
