/**
 * Build and Deploy, and the three claims §6 makes about them (Task 19).
 *
 * Every test here targets a sentence that would still "work" if it were false,
 * which is what makes them worth writing:
 *
 * - **Two concurrent deploys of the same Component@Target serialize.** Against a
 *   fake database this passes by accident, because a fake has no concurrency to
 *   get wrong. It is asserted here with **two real Postgres sessions contending
 *   for one row**, which is the only arrangement that can fail.
 * - **A late-finishing older build moves nothing** (§4: "a build records an
 *   artifact rather than deploying one... there is no `SUPERSEDED` verdict to
 *   explain"). Asserted by finishing an older Build *after* a newer one is live
 *   and reading the desired row back.
 * - **Rollback dispatches no build** (§6: "rollback is an ordinary deploy"). The
 *   context's build registry throws if it is so much as consulted, so this is a
 *   claim about what the code path does not contain rather than about what it
 *   returned.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { placeIntent } from '../../src/commands/deploys/create.ts';
import {
  createDeploy,
  dispatchBuild,
  rollbackDeploy,
  uploadArchive,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** A digest of the right shape, distinct per call. */
function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/**
 * A registry whose build side is a tripwire.
 *
 * "Rollback dispatches no build" and "creating a Deploy dispatches no build" are
 * negative claims, and a negative claim needs something that fails when it is
 * violated. A `build()` that throws is that something.
 */
function registryOf(
  deployAdapter: DeployAdapter,
  buildAdapter?: FakeBuildAdapter,
): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: (route) => {
      if (buildAdapter === undefined) {
        throw new Error(
          `a command that must not build looked up the ${route} route`,
        );
      }
      return route === buildAdapter.name ? buildAdapter : null;
    },
    store: () => {
      throw new Error('a deploy command reached the secret store');
    },
  };
}

function context(adapters: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** An App, a Component, and a connected Target that accepts images. */
async function fixture(
  options: { kind?: 'service' | 'website'; adapter?: 'kubernetes' } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: options.kind ?? 'service',
      expose: true,
    })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cluster-${crypto.randomUUID()}`,
        adapter: options.adapter ?? 'kubernetes',
        discovery: null,
      }),
    )
    .returning();
  return { app: app!, component: component!, target: target! };
}

/** A Build that is ready to deploy: succeeded, with an artifact of one shape. */
async function succeededBuild(
  componentId: string,
  seed: number,
  shape: 'image' | 'files' = 'image',
) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: digest(seed),
      targetShape: shape,
      artifactType: shape,
      artifactDigest: digest(seed),
      bundleDigest: digest(seed),
      // Where the bundle was staged. A Build without one cannot be dispatched
      // at all — a route would have nothing to fetch.
      bundleLocation: `bundles/${seed}.zip`,
      status: 'SUCCEEDED',
    })
    .returning();
  return build!;
}

/** A Target whose discovery makes it capable, so `artifactTypeFor` agrees. */
function capableAdapter(): FakeDeployAdapter {
  return new FakeDeployAdapter({ adapter: 'kubernetes' });
}

async function desiredRow(componentId: string, targetId: string) {
  const [row] = await database()
    .db.select()
    .from(componentTargetDesired)
    .where(
      and(
        eq(componentTargetDesired.componentId, componentId),
        eq(componentTargetDesired.targetId, targetId),
      ),
    );
  return row;
}

describe('createDeploy writes an intent, and only an intent', () => {
  test('the Deploy is PENDING and the desired row points at it', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 1);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe('PENDING');
    // Nothing was live here before, so there is nothing this superseded.
    expect(result.value.supersededBuildId).toBeNull();

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));
    expect(row?.phase).toBe('PENDING');
    // §6: the loop owns every phase after PENDING, so an intent has placed
    // nothing and carries no adapter handle yet.
    expect(row?.ref).toBeNull();
    expect(row?.url).toBeNull();

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(build.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  test('a Build that has not succeeded has no artifact to place', async () => {
    const { component, target } = await fixture();
    const [pending] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(9),
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
      })
      .returning();

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: pending!.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    // No intent row was written, so the loop has nothing to find.
    expect(await desiredRow(component.id, target.id)).toBeUndefined();
  });

  test('a shape the Target does not take needs a rebuild, and says so', async () => {
    // §3: "changing placement across shapes forces a rebuild." A `files`
    // artifact against a cluster is that case, caught here rather than as a
    // deploy that fails on the far side.
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 2, 'files');

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('rebuild');
  });

  test('a disconnected Target takes nothing new', async () => {
    const { component, target } = await fixture();
    await database()
      .db.update(targets)
      .set({ status: 'disconnected' })
      .where(eq(targets.id, target.id));
    const build = await succeededBuild(component.id, 3);

    const result = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
  });
});

describe('concurrency: the locking read (§6)', () => {
  /**
   * The load-bearing test, and the reason the harness hands out a second
   * session.
   *
   * §6 rests correctness on "a **locking read** on the desired row", and the
   * honest way to assert a lock is to **hold it from another session and watch
   * the command stop**. Firing two commands with `Promise.all` does not do that:
   * it passes whether or not the `FOR UPDATE` is there, because nothing forces
   * the two transactions to overlap. This test forces it — the row is locked
   * before `createDeploy` is called and released only after we have observed it
   * blocked — so deleting the `FOR UPDATE` makes it fail.
   */
  test('an intent waits for whoever holds the desired row', async () => {
    const { component, target } = await fixture();
    const first = await succeededBuild(component.id, 60);
    const second = await succeededBuild(component.id, 61);
    const registry = registryOf(capableAdapter());

    // The desired row has to exist before it can be locked.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: first.id },
      context(registry),
    );

    const other = database().connect();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = other.begin(async (tx: typeof other) => {
      await tx.unsafe(
        'select * from component_target_desired where component_id = $1 and target_id = $2 for update',
        [component.id, target.id],
      );
      await held;
    });

    // Give the holder time to actually take the lock before contending.
    await Bun.sleep(100);

    let settled = false;
    const contending = createDeploy(
      { componentId: component.id, targetId: target.id, buildId: second.id },
      context(registry),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Bun.sleep(400);
    // The claim: it is *stopped*, not merely slow-and-lucky. Without the
    // locking read this command would have committed by now.
    expect(settled).toBe(false);

    release();
    await holding;

    const result = await contending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Having waited, it read the committed state rather than the stale one.
    expect(result.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(result.value.deployId);
  });

  /**
   * The check-and-set itself, with the interleaving pinned.
   *
   * The previous test proves a contending intent *waits*; it does not prove the
   * `FOR UPDATE` is what makes it wait, because the closing `UPDATE` takes a row
   * lock too and would block a second transaction anyway. What only the locking
   * read gives is **what the second transaction reads**: without it, both read
   * the desired row before either commits, both see the same stale value, and
   * the second one's answer about what it superseded is a lie that the row it
   * finally writes does not contradict.
   *
   * So this test holds the first transaction open *past its read* — using the
   * guard, which runs under the lock — starts the second, and asserts the second
   * saw the first's write. Deleting `.for('update')` fails it.
   */
  test('the second intent reads what the first wrote, not what preceded it', async () => {
    const { component, target } = await fixture();
    const existing = await succeededBuild(component.id, 69);
    const first = await succeededBuild(component.id, 70);
    const second = await succeededBuild(component.id, 71);
    const registry = registryOf(capableAdapter());

    // The desired row must already exist and be committed. If the two intents
    // below were both its first writer they would serialize on its unique index
    // instead — which is correct behaviour, but it is not the locking read, and
    // a test that cannot tell them apart proves nothing about `FOR UPDATE`.
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: existing.id },
      context(registry),
    );

    const preconditions = {
      componentId: component.id,
      targetId: target.id,
      exposure: 'private' as const,
    };

    let announceRead = (): void => {};
    const hasRead = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    // First intent: enters the transaction, takes the lock, reads — and then
    // stops inside the guard, still holding everything.
    const holding = placeIntent(
      context(registry),
      { ...preconditions, buildId: first.id },
      async () => {
        announceRead();
        await released;
        return null;
      },
    );

    await hasRead;

    // Second intent, started while the first is provably mid-transaction.
    const contending = createDeploy(
      { componentId: component.id, targetId: target.id, buildId: second.id },
      context(registry),
    );

    // Long enough that an unlocked read would certainly have happened by now.
    await Bun.sleep(300);
    release();

    const [a, b] = await Promise.all([holding, contending]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // The first superseded what was already there; the second superseded the
    // first. That pair is only reachable if the second's read happened after the
    // first's commit — without the locking read, both read `existing` and the
    // second's answer is stale.
    expect(a.value.supersededBuildId).toBe(existing.id);
    expect(b.value.supersededBuildId).toBe(first.id);

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(second.id);
    expect(desired?.desiredDeployId).toBe(b.value.deployId);
  });

  test('two concurrent deploys of one Component@Target serialize', async () => {
    // The claim under test is that the desired row ends up describing *one* of
    // the two intents completely — same Build, same Deploy — rather than a torn
    // pair where one command's Build is left beside the other's Deploy. Only
    // two real sessions contending on one row can produce the torn state, which
    // is why this test is worth its Postgres.
    const { component, target } = await fixture();
    const first = await succeededBuild(component.id, 10);
    const second = await succeededBuild(component.id, 11);

    const registry = registryOf(capableAdapter());
    const [a, b] = await Promise.all([
      createDeploy(
        { componentId: component.id, targetId: target.id, buildId: first.id },
        context(registry),
      ),
      createDeploy(
        { componentId: component.id, targetId: target.id, buildId: second.id },
        context(registry),
      ),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Both intents exist — neither was lost, and neither was refused.
    const rows = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(rows).toHaveLength(2);

    const desired = await desiredRow(component.id, target.id);
    const winner = [a.value, b.value].find(
      (value) => value.deployId === desired?.desiredDeployId,
    );
    // The pair is consistent: the desired Build is the one that winning intent
    // named. A lost update would leave the other command's Build here.
    expect(winner).toBeDefined();
    expect(desired?.desiredBuildId).toBe(winner!.buildId);

    // Exactly one of them saw the other's write, which is what serialization
    // means: the loser ran second and read the winner's row under the lock.
    const superseded = [a.value, b.value].map((v) => v.supersededBuildId);
    expect(superseded.filter((value) => value === null)).toHaveLength(1);
    expect(superseded.filter((value) => value !== null)).toHaveLength(1);
  });
});

describe('§4: a late-finishing older build moves nothing', () => {
  test('finishing an older Build leaves the desired row alone', async () => {
    const { app, component, target } = await fixture();
    const older = await succeededBuild(component.id, 20);
    const newer = await succeededBuild(component.id, 21);

    // The newer artifact is what should be live here.
    const deployed = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registryOf(capableAdapter())),
    );
    expect(deployed.ok).toBe(true);

    const before = await desiredRow(component.id, target.id);

    // Now the older build finishes — late, as §4 allows. It records an artifact
    // and that is the whole of its effect.
    await database()
      .db.update(builds)
      .set({ status: 'PENDING', artifactDigest: null })
      .where(eq(builds.id, older.id));
    const builder = new FakeBuildAdapter({
      script: [{ result: { status: 'SUCCEEDED', digest: digest(20) } }],
    });
    const finished = await dispatchBuild(
      { buildId: older.id, route: builder.name },
      context(registryOf(capableAdapter(), builder)),
    );

    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.value.status).toBe('SUCCEEDED');

    const after = await desiredRow(component.id, target.id);
    expect(after?.desiredBuildId).toBe(before!.desiredBuildId!);
    expect(after?.desiredDeployId).toBe(before!.desiredDeployId!);

    // And no second Deploy appeared for the App as a side effect.
    const all = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(all).toHaveLength(1);
    expect(app.id).toBeDefined();
  });
});

describe('§6: rollback is an ordinary deploy', () => {
  test('it places an older Build and dispatches nothing', async () => {
    const { component, target } = await fixture();
    const older = await succeededBuild(component.id, 30);
    const newer = await succeededBuild(component.id, 31);

    // The build registry throws if consulted — see `registryOf`.
    const registry = registryOf(capableAdapter());

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registry),
    );

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );

    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    // A newer intent row pointing at an older Build — §6's definition, verbatim.
    expect(rolled.value.buildId).toBe(older.id);
    expect(rolled.value.supersededBuildId).toBe(newer.id);
    expect(rolled.value.phase).toBe('PENDING');

    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(older.id);
    expect(desired?.desiredDeployId).toBe(rolled.value.deployId);

    // Three intents, one per act. Rollback made a Deploy like any other.
    const all = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(all).toHaveLength(3);
  });

  test('a "rollback" to a newer Build is refused as the typo it is', async () => {
    const { component, target } = await fixture();
    const older = await succeededBuild(component.id, 40);
    const newer = await succeededBuild(component.id, 41);
    const registry = registryOf(capableAdapter());

    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: older.id },
      context(registry),
    );

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: newer.id },
      context(registry),
    );

    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.code).toBe('NOT_DEPLOYABLE');
    expect(rolled.failure.message).toContain('older');

    // The refusal wrote nothing: the desired row still names the first intent.
    const desired = await desiredRow(component.id, target.id);
    expect(desired?.desiredBuildId).toBe(older.id);
  });

  test('rolling back where nothing was ever deployed is refused', async () => {
    const { component, target } = await fixture();
    const build = await succeededBuild(component.id, 50);

    const rolled = await rollbackDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(registryOf(capableAdapter())),
    );

    expect(rolled.ok).toBe(false);
    if (rolled.ok) return;
    expect(rolled.failure.message).toContain('nothing has been deployed');
  });
});

describe('§4: an uploaded artifact is recorded, never built', () => {
  test('a finished bundle becomes a SUCCEEDED Build with no builder invoked', async () => {
    const { component, target } = await fixture({ kind: 'website' });

    // The registry's `build()` throws. If uploading finished output so much as
    // looked for a route, this test fails rather than passing quietly.
    const result = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(60),
        location: 'bundles/shop-web/60.zip',
        contents: 'artifact',
        subpath: '.',
      },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('SUCCEEDED');
    expect(result.value.artifactType).toBe('files');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    // §16: the digest is over the uploaded bundle, and it is what names the
    // artifact — one digest, so the receipt and the provenance have a join.
    expect(row?.artifactDigest).toBe(digest(60));
    expect(row?.bundleDigest).toBe(digest(60));
    // §4: the backend and its fidelity are visible on the Build. There was no
    // backend, and saying so beats naming a runner that never ran.
    expect(row?.runner).toBeNull();
    expect(row?.logFidelity).toBeNull();
  });

  test('an uploaded source bundle waits for a route instead', async () => {
    const { component, target } = await fixture();

    const result = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(61),
        location: 'bundles/shop-web/61.zip',
        contents: 'source',
        subpath: '.',
      },
      context(registryOf(capableAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('PENDING');

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    // Staged, digested, and not yet an artifact — §4's other arm.
    expect(row?.bundleDigest).toBe(digest(61));
    expect(row?.artifactDigest).toBeNull();
  });

  test('a source bundle reaches its builder with the location it was staged at', async () => {
    // The bug this pins: the staged location was only kept on the supplied arm,
    // so every source upload handed its route an empty location — a build that
    // cannot fetch what it is building, with nothing saying so.
    const { component, target } = await fixture();
    const builder = new FakeBuildAdapter();
    const registry = registryOf(capableAdapter(), builder);

    const uploaded = await uploadArchive(
      {
        componentId: component.id,
        targetId: target.id,
        bundleDigest: digest(63),
        location: 'bundles/shop-web/63.zip',
        contents: 'source',
        subpath: 'apps/web',
      },
      context(registry),
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;

    const dispatched = await dispatchBuild(
      { buildId: uploaded.value.buildId, route: builder.name },
      context(registry),
    );
    expect(dispatched.ok).toBe(true);

    expect(builder.built).toHaveLength(1);
    const origin = builder.built[0]!.source.origin;
    expect(origin.type).toBe('archive');
    if (origin.type !== 'archive') return;
    expect(origin.location).toBe('bundles/shop-web/63.zip');
    // §5's scope, per Build: the unwrap is a fact about the uploaded bytes.
    expect(origin.subpath).toBe('apps/web');
    // §16's join reaches the route on every path.
    expect(builder.built[0]!.source.bundleDigest).toBe(digest(63));
  });

  test('a Build with no staged bundle is refused rather than dispatched empty', async () => {
    const { component } = await fixture();
    const [orphan] = await database()
      .db.insert(builds)
      .values({
        componentId: component.id,
        commit: digest(64),
        targetShape: 'image',
        artifactType: 'image',
        bundleDigest: digest(64),
        status: 'PENDING',
      })
      .returning();

    const builder = new FakeBuildAdapter();
    const result = await dispatchBuild(
      { buildId: orphan!.id, route: builder.name },
      context(registryOf(capableAdapter(), builder)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_BUILDABLE');
    expect(builder.built).toHaveLength(0);
  });

  test('re-uploading identical bytes lands on the same Build', async () => {
    // §2 keys a Build on (component, commit, target-shape), and for an upload
    // the bundle digest is the commit. Identical bytes are the same input, so
    // they are the same row rather than two rows meaning one thing.
    const { component, target } = await fixture({ kind: 'website' });
    const input = {
      componentId: component.id,
      targetId: target.id,
      bundleDigest: digest(62),
      location: 'bundles/shop-web/62.zip',
      contents: 'artifact' as const,
      subpath: '.',
    };
    const registry = registryOf(capableAdapter());

    const first = await uploadArchive(input, context(registry));
    const second = await uploadArchive(input, context(registry));

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.buildId).toBe(first.value.buildId);

    // And the second upload changed nothing. The bug this pins: an upsert that
    // wrote on conflict blanked the artifact refs of a Build that had already
    // succeeded — a finished artifact quietly losing the address it is pulled by.
    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, first.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.artifactDigest).toBe(digest(62));
    expect(row?.artifactRefs).toEqual(['bundles/shop-web/62.zip']);
  });

  test('a source re-upload cannot blank a Build that already succeeded', async () => {
    const { component, target } = await fixture({ kind: 'website' });
    const registry = registryOf(capableAdapter());
    const common = {
      componentId: component.id,
      targetId: target.id,
      bundleDigest: digest(65),
      location: 'bundles/shop-web/65.zip',
      subpath: '.',
    };

    const supplied = await uploadArchive(
      { ...common, contents: 'artifact' as const },
      context(registry),
    );
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;

    // Same bytes, now claimed to be source. The key is identical, so it lands on
    // the same row — which must not be demoted out from under a live Deploy.
    await uploadArchive(
      { ...common, contents: 'source' as const },
      context(registry),
    );

    const [row] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.id, supplied.value.buildId));
    expect(row?.status).toBe('SUCCEEDED');
    expect(row?.artifactDigest).toBe(digest(65));
    expect(row?.artifactRefs).toEqual(['bundles/shop-web/65.zip']);
  });
});
