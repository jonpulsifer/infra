/**
 * The deploy lock on an App, and who asked for each Deploy (§6).
 *
 * Three columns and one veto, so the claims are about what the veto holds and
 * what it lets through:
 *
 * - **A locked App refuses every ordinary intent with the reason** — a press
 *   (`createDeploy`, `deployApp`), a push (`dispatchAutoDeploys`, which
 *   skips before anything is built) and a config change (`setConfig`, which
 *   stores the value and declines the deploy).
 * - **The lock is asked again under the intent's own lock**: a hold set
 *   between `checkDeployable` and `placeIntent` still holds.
 * - **A rollback goes through and sets the lock in the same transaction as
 *   its intent**, naming what it asked for and who asked: the lock exists so
 *   the next adopted push does not undo the rollback, and refusing the
 *   rollback itself would be the lock guarding against the operator.
 * - **Unlocking clears it and resumes the push the lock held back** — for an
 *   `autoDeploy` App behind its branch, and never for the commit a rollback
 *   just rolled away from.
 * - **Every intent records its principal** — the operator's id for a press,
 *   `AUTO_DEPLOY_PRINCIPAL` for a push — and the screens print a name.
 * - **The workspace says what is pushed but not live**, joining the adopted
 *   commit to the serving Build's, and whether a Build of it is on its way.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { setAppLock } from '../../src/commands/apps/set-lock.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { setConfig } from '../../src/commands/config/set.ts';
import { cancelDeploy } from '../../src/commands/deploys/cancel.ts';
import {
  checkDeployable,
  createDeploy,
  placeIntent,
} from '../../src/commands/deploys/create.ts';
import { getDeployDetail } from '../../src/commands/deploys/get-detail.ts';
import { listDeploys } from '../../src/commands/deploys/list.ts';
import { rollbackDeploy } from '../../src/commands/deploys/rollback.ts';
import type {
  AdapterRegistry,
  CommandContext,
  Principal,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  configItems,
  deploys,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import type { TargetDiscovery } from '../../src/domain/capabilities.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
import {
  AUTO_DEPLOY_PRINCIPAL,
  dispatchAutoDeploys,
} from '../../src/reconciler/auto-deploy.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-23T09:00:00.000Z');

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

/**
 * A registry that can place an image and admit its signature, nothing else.
 * No build route: the workspace read asks for one to judge the route picker,
 * and answers `null` gracefully.
 */
function registry(): AdapterRegistry {
  const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
  const chain = new SupplyChainHarness();
  return {
    deploy: (name) => (name === adapter.adapter ? adapter : null),
    build: () => null,
    store: () => {
      throw new Error('nothing here may reach the secret store');
    },
    repository: () => null,
    supplyChain: () => chain,
  };
}

function context(principal: Principal): CommandContext {
  return {
    principal,
    clock: { now: () => FROZEN },
    db: database().db,
    adapters: registry(),
    manifest,
  };
}

/**
 * An operator, a repo App on a connected repository, one placed Component,
 * and a connected Target that takes images.
 */
async function fixture(options: { readonly adopted?: string } = {}) {
  const db = database().db;
  const [operator] = await db
    .insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      fullName: `acme/shop-${crypto.randomUUID().slice(0, 8)}`,
      installationId: '1',
      defaultBranch: 'main',
      authoritativeCommit: options.adopted ?? null,
    })
    .returning();
  const [app] = await db
    .insert(apps)
    .values({
      name: `shop-${crypto.randomUUID().slice(0, 8)}`,
      sourceKind: 'repo',
      sourceRepoUrl: repository!.fullName,
      sourceRepoSubpath: '.',
      repositoryId: repository!.id,
    })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        discovery: null,
      }),
    )
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: 'service',
      expose: true,
      placedTargetId: target!.id,
    })
    .returning();
  const principal: Principal = { id: operator!.id, displayName: 'Operator' };
  return {
    app: app!,
    repository: repository!,
    component: component!,
    target: target!,
    principal,
    ctx: context(principal),
    pair: { componentId: component!.id, targetId: target!.id },
  };
}

/**
 * `createdAt` is the database's clock unless said otherwise. A test that
 * writes a Build through the frozen command clock afterwards and needs it
 * to be the *newest* dates this one before `FROZEN`.
 */
async function succeededBuild(
  componentId: string,
  seed: number,
  commit?: string,
  createdAt?: Date,
) {
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: commit ?? digest(seed),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest(seed),
      bundleDigest: digest(seed),
      bundleLocation: `https://depot.lolwtf.ca/bundles/${seed}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(digest(seed), FROZEN.toISOString()),
      ...(createdAt === undefined ? {} : { createdAt }),
    })
    .returning();
  return build!;
}

/** Records what it was asked to stage; fetches nothing. */
class FakeSourceStager implements RepositorySourceStager {
  readonly staged: Array<{ repository: string; commit: string }> = [];

  async stageRepository(input: {
    readonly repository: string;
    readonly commit: string;
  }): Promise<StagedSourceBundle> {
    this.staged.push({ repository: input.repository, commit: input.commit });
    return {
      digest: `sha256:${'b'.repeat(64)}`,
      location: `gs://depot/${input.commit}.tgz`,
      retention: 'ephemeral',
    };
  }
}

async function lockOf(appId: string) {
  const [row] = await database()
    .db.select({
      lockReason: apps.lockReason,
      lockedAt: apps.lockedAt,
      lockedBy: apps.lockedBy,
    })
    .from(apps)
    .where(eq(apps.id, appId));
  return row!;
}

async function deploysOf(componentId: string) {
  return database()
    .db.select()
    .from(deploys)
    .where(eq(deploys.componentId, componentId));
}

async function desiredBuildOf(componentId: string) {
  const [row] = await database()
    .db.select({ buildId: componentTargetDesired.desiredBuildId })
    .from(componentTargetDesired)
    .where(eq(componentTargetDesired.componentId, componentId));
  return row?.buildId ?? null;
}

async function pushLands(repositoryId: string, commit: string) {
  await database()
    .db.update(repositories)
    .set({ authoritativeCommit: commit })
    .where(eq(repositories.id, repositoryId));
}

async function optIn(appId: string) {
  await database()
    .db.update(apps)
    .set({ autoDeploy: true })
    .where(eq(apps.id, appId));
}

describe('a locked App refuses ordinary deploys with the reason', () => {
  test('createDeploy is refused, and the sentence is the operator’s', async () => {
    const { app, component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 1);

    const locked = await setAppLock(
      { appId: app.id, reason: 'change freeze until Monday' },
      ctx,
    );
    expect(locked).toEqual({
      ok: true,
      value: {
        appId: app.id,
        reason: 'change freeze until Monday',
        resumed: null,
      },
    });
    expect(await lockOf(app.id)).toEqual({
      lockReason: 'change freeze until Monday',
      lockedAt: FROZEN,
      lockedBy: ctx.principal.id,
    });

    const result = await createDeploy({ ...pair, buildId: build.id }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain(`'${app.name}' is locked`);
    expect(result.failure.message).toContain('change freeze until Monday');

    // Refused before the intent: nothing was written.
    expect(
      await database()
        .db.select()
        .from(deploys)
        .where(eq(deploys.componentId, component.id)),
    ).toHaveLength(0);
  });

  test('the one-button deploy carries the same refusal out unchanged', async () => {
    const { app, component, ctx } = await fixture();
    await succeededBuild(component.id, 2);
    await setAppLock({ appId: app.id, reason: 'incident 41 open' }, ctx);

    const result = await deployApp({ name: app.id }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('incident 41 open');
  });

  test('a push to a locked App is skipped before anything is built', async () => {
    const { app, repository, component, ctx } = await fixture({
      adopted: 'feedbeef',
    });
    await succeededBuild(component.id, 3, 'feedbeef');
    await database()
      .db.update(apps)
      .set({ autoDeploy: true })
      .where(eq(apps.id, app.id));
    await setAppLock({ appId: app.id, reason: 'hold for the weekend' }, ctx);

    const attempts = await dispatchAutoDeploys(
      { db: ctx.db, clock: ctx.clock, adapters: ctx.adapters, manifest },
      [
        {
          outcome: 'adopted',
          repositoryId: repository.id,
          fullName: repository.fullName,
          commit: 'feedbeef',
          scopes: [{ appId: app.id }],
        },
      ] as never,
    );

    // Not attempted at all — no `deployApp` call, no refusal to carry.
    expect(attempts).toEqual([]);
    expect(await deploysOf(component.id)).toHaveLength(0);
  });

  test('a config change stores the value and declines the deploy with the reason', async () => {
    const { app, component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 4);
    expect((await createDeploy({ ...pair, buildId: build.id }, ctx)).ok).toBe(
      true,
    );
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);

    // A Target that reaches a store, which the fixture's bare one does not:
    // the value has to have somewhere to go before the deploy is the question.
    const store = new FakeSecretStore({
      adapter: manifest.secretStore.adapter,
    });
    await ctx.db
      .update(targets)
      .set({
        discovery: {
          ...CAPABLE_DISCOVERY,
          reachableSecretStores: [
            manifest.secretStore.adapter,
          ] as TargetDiscovery['reachableSecretStores'],
        },
      })
      .where(eq(targets.id, pair.targetId));
    const result = await setConfig(
      { ...pair, entries: [{ key: 'TOKEN', value: 'hunter2' }] },
      { ...ctx, adapters: { ...ctx.adapters, store: () => store } },
    );

    // Its own shape, not the press's: the value is kept, the deploy is not.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written).toEqual(['TOKEN']);
    expect(result.value.deployId).toBeNull();
    expect(result.value.notDeployed).toContain(`'${app.name}' is locked`);
    expect(result.value.notDeployed).toContain('freeze');

    const items = await database()
      .db.select({ key: configItems.key })
      .from(configItems)
      .where(eq(configItems.componentId, component.id));
    expect(items).toEqual([{ key: 'TOKEN' }]);
    // Only the Deploy placed before the lock.
    expect(await deploysOf(component.id)).toHaveLength(1);
  });
});

describe('rollback goes through the lock, and sets it', () => {
  test('a rollback is accepted while locked and names what it rolled away from', async () => {
    const { app, component, ctx, pair } = await fixture();
    const older = await succeededBuild(component.id, 10);
    const newer = await succeededBuild(component.id, 11);
    expect((await createDeploy({ ...pair, buildId: older.id }, ctx)).ok).toBe(
      true,
    );
    expect((await createDeploy({ ...pair, buildId: newer.id }, ctx)).ok).toBe(
      true,
    );
    await setAppLock({ appId: app.id, reason: 'incident 41 open' }, ctx);

    const rolled = await rollbackDeploy({ ...pair, buildId: older.id }, ctx);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.value.supersededBuildId).toBe(newer.id);

    // Requested, not done: the sentence stays true if the Deploy then fails.
    const lock = await lockOf(app.id);
    expect(lock.lockReason).toContain(
      `rollback to Build ${older.id} requested`,
    );
    expect(lock.lockReason).toContain(`superseding Build ${newer.id}`);
    expect(lock.lockReason).toContain('by Operator');
    expect(lock.lockedBy).toBe(ctx.principal.id);
    expect(lock.lockedAt).toEqual(FROZEN);
  });

  test('an unlocked App is locked by the rollback, so the next push cannot undo it', async () => {
    const { app, component, ctx, pair } = await fixture();
    const older = await succeededBuild(component.id, 12);
    const newer = await succeededBuild(component.id, 13);
    await createDeploy({ ...pair, buildId: older.id }, ctx);
    await createDeploy({ ...pair, buildId: newer.id }, ctx);
    expect((await lockOf(app.id)).lockReason).toBeNull();

    expect((await rollbackDeploy({ ...pair, buildId: older.id }, ctx)).ok).toBe(
      true,
    );
    expect((await lockOf(app.id)).lockReason).not.toBeNull();

    // The very next forward deploy — what a push would do — is refused.
    const forward = await createDeploy({ ...pair, buildId: newer.id }, ctx);
    expect(forward.ok).toBe(false);
    if (forward.ok) return;
    expect(forward.failure.message).toContain('rollback to Build');
  });

  test('cancelling a rollback before it is claimed lifts the lock it set', async () => {
    const { app, component, ctx, pair } = await fixture();
    const older = await succeededBuild(component.id, 15);
    const newer = await succeededBuild(component.id, 16);
    await createDeploy({ ...pair, buildId: older.id }, ctx);
    const forward = await createDeploy({ ...pair, buildId: newer.id }, ctx);
    if (!forward.ok) throw new Error(forward.failure.message);

    const rolled = await rollbackDeploy({ ...pair, buildId: older.id }, ctx);
    if (!rolled.ok) throw new Error(rolled.failure.message);
    expect((await lockOf(app.id)).lockReason).toContain('rolled back');

    // The wrong Build, noticed before anything claimed it. The pointer goes
    // back to the release that was serving all along, and a banner asserting
    // a rollback that never landed goes with it.
    const cancelled = await cancelDeploy({ id: rolled.value.deployId }, ctx);
    expect(cancelled).toMatchObject({ ok: true, value: { phase: 'FAILED' } });
    expect(await lockOf(app.id)).toEqual({
      lockReason: null,
      lockedAt: null,
      lockedBy: null,
    });

    // The next press is accepted, which is what the lock was refusing.
    const next = await succeededBuild(component.id, 17);
    const result = await createDeploy({ ...pair, buildId: next.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supersededBuildId).toBe(newer.id);
  });

  test('a hold set on a forward intent is the operator’s, and cancelling the intent keeps it', async () => {
    const { app, component, ctx, pair } = await fixture();
    const first = await succeededBuild(component.id, 18);
    const second = await succeededBuild(component.id, 19);
    await createDeploy({ ...pair, buildId: first.id }, ctx);
    const forward = await createDeploy({ ...pair, buildId: second.id }, ctx);
    if (!forward.ok) throw new Error(forward.failure.message);
    await setAppLock({ appId: app.id, reason: 'change freeze' }, ctx);

    expect((await cancelDeploy({ id: forward.value.deployId }, ctx)).ok).toBe(
      true,
    );
    expect((await lockOf(app.id)).lockReason).toBe('change freeze');
  });

  test('a refused rollback locks nothing', async () => {
    const { app, component, ctx, pair } = await fixture();
    const only = await succeededBuild(component.id, 14);
    await createDeploy({ ...pair, buildId: only.id }, ctx);

    // Not older than what is desired — the typo refusal.
    const rolled = await rollbackDeploy({ ...pair, buildId: only.id }, ctx);
    expect(rolled.ok).toBe(false);
    expect((await lockOf(app.id)).lockReason).toBeNull();
  });

  test('a forward intent checked before the rollback cannot land after it', async () => {
    const { component, ctx, pair } = await fixture();
    const older = await succeededBuild(component.id, 15);
    const newer = await succeededBuild(component.id, 16);
    await createDeploy({ ...pair, buildId: older.id }, ctx);
    await createDeploy({ ...pair, buildId: newer.id }, ctx);

    // A push mid-flight: its checks passed while the App was unlocked, and
    // its pinned-config round trips are still in progress when the rollback
    // commits with its hold.
    const checked = await checkDeployable({ ...pair, buildId: newer.id }, ctx);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect((await rollbackDeploy({ ...pair, buildId: older.id }, ctx)).ok).toBe(
      true,
    );

    const forward = await placeIntent(ctx, checked.value);
    expect(forward.ok).toBe(false);
    if (forward.ok) return;
    expect(forward.failure.code).toBe('NOT_DEPLOYABLE');
    expect(forward.failure.message).toContain(
      `rollback to Build ${older.id} requested`,
    );
    expect(await desiredBuildOf(component.id)).toBe(older.id);
    expect(await deploysOf(component.id)).toHaveLength(3);
  });

  test('a lock set between the checks and the write still holds', async () => {
    const { app, component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 17);
    const checked = await checkDeployable({ ...pair, buildId: build.id }, ctx);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    await setAppLock({ appId: app.id, reason: 'incident 41 open' }, ctx);

    const placed = await placeIntent(ctx, checked.value);
    expect(placed.ok).toBe(false);
    if (placed.ok) return;
    expect(placed.failure.message).toContain(`'${app.name}' is locked`);
    expect(placed.failure.message).toContain('incident 41 open');
    expect(await deploysOf(component.id)).toHaveLength(0);
  });

  test('a hold that cannot be taken leaves no intent behind', async () => {
    const { app, component, ctx, pair } = await fixture();
    const older = await succeededBuild(component.id, 18);
    const newer = await succeededBuild(component.id, 19);
    await createDeploy({ ...pair, buildId: older.id }, ctx);
    await createDeploy({ ...pair, buildId: newer.id }, ctx);

    const checked = await checkDeployable({ ...pair, buildId: older.id }, ctx, {
      bypassLock: true,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    // The hold rides the intent's transaction, so a hold that fails takes
    // the intent down with it rather than leaving a rollback nothing guards.
    await expect(
      placeIntent(ctx, checked.value, undefined, async () => {
        throw new Error('the App row could not be written');
      }),
    ).rejects.toThrow('the App row could not be written');
    expect(await desiredBuildOf(component.id)).toBe(newer.id);
    expect(await deploysOf(component.id)).toHaveLength(2);
    expect((await lockOf(app.id)).lockReason).toBeNull();
  });
});

describe('unlocking', () => {
  test('clears every column and the next deploy is accepted', async () => {
    const { app, component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 20);
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);

    const unlocked = await setAppLock({ appId: app.id, reason: null }, ctx);
    expect(unlocked).toEqual({
      ok: true,
      value: { appId: app.id, reason: null, resumed: null },
    });
    expect(await lockOf(app.id)).toEqual({
      lockReason: null,
      lockedAt: null,
      lockedBy: null,
    });

    expect((await createDeploy({ ...pair, buildId: build.id }, ctx)).ok).toBe(
      true,
    );
  });

  test('an App that does not exist is not silently a no-op', async () => {
    const { ctx } = await fixture();
    const result = await setAppLock(
      { appId: '00000000-0000-4000-8000-000000000000', reason: null },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('unlocking resumes the push the lock held back', () => {
  /** A push App serving `commit`, with a Build of it dated before `FROZEN`. */
  async function servingPushApp(commit: string, seed: number) {
    const parts = await fixture({ adopted: commit });
    const build = await succeededBuild(
      parts.component.id,
      seed,
      commit,
      new Date(FROZEN.getTime() - 60_000),
    );
    expect(
      (await createDeploy({ ...parts.pair, buildId: build.id }, parts.ctx)).ok,
    ).toBe(true);
    await optIn(parts.app.id);
    return { ...parts, build };
  }

  test('the commit adopted while locked is dispatched, and the hero has its evidence', async () => {
    const { app, repository, component, ctx } = await servingPushApp(
      'aaa1111',
      70,
    );
    await setAppLock({ appId: app.id, reason: 'incident 41 open' }, ctx);
    await pushLands(repository.id, 'bbb2222');

    const stager = new FakeSourceStager();
    const unlocked = await setAppLock(
      { appId: app.id, reason: null },
      { ...ctx, adapters: { ...ctx.adapters, source: () => stager } },
    );
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    expect(await lockOf(app.id)).toEqual({
      lockReason: null,
      lockedAt: null,
      lockedBy: null,
    });

    // The same act the push would have taken: a Build of that commit, set to
    // deploy when it lands.
    expect(unlocked.value.resumed).toEqual({
      appId: app.id,
      commit: 'bbb2222',
      result: {
        ok: true,
        value: {
          deployId: null,
          buildId: expect.any(Number),
          phase: 'BUILDING',
        },
      },
    });
    expect(stager.staged).toEqual([
      { repository: repository.fullName, commit: 'bbb2222' },
    ]);
    const resumed = unlocked.value.resumed;
    if (resumed === null || !resumed.result.ok) return;
    const [queued] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, resumed.result.value.buildId));
    expect(queued?.componentId).toBe(component.id);
    expect(queued?.commit.split('#')[0]).toBe('bbb2222');
    expect(queued?.status).toBe('PENDING');
    expect(queued?.deployOnSuccess).toBe(true);

    const workspace = await getAppWorkspace({ name: app.id }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.source).toEqual({
      branch: 'main',
      pending: { commit: 'bbb2222', dispatched: true },
    });
    expect(workspace.value.workspace.lock).toBeUndefined();
  });

  test('a refusal is carried out, not thrown, and the App is unlocked anyway', async () => {
    const { app, repository, component, ctx } = await servingPushApp(
      'ccc3333',
      71,
    );
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);
    await pushLands(repository.id, 'ddd4444');

    // No source depot: the dispatch this resumes has nothing to stage into.
    const unlocked = await setAppLock({ appId: app.id, reason: null }, ctx);
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) return;
    expect((await lockOf(app.id)).lockReason).toBeNull();
    const resumed = unlocked.value.resumed;
    expect(resumed?.commit).toBe('ddd4444');
    expect(resumed?.result.ok).toBe(false);
    if (resumed === null || resumed.result.ok) return;
    expect(resumed.result.failure.code).toBe('NOT_BUILDABLE');

    // Nothing is on its way, and the hero says which button ships it.
    const workspace = await getAppWorkspace({ name: app.id }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.source?.pending).toEqual({
      commit: 'ddd4444',
      dispatched: false,
    });
    expect(await deploysOf(component.id)).toHaveLength(1);
  });

  test('a manual App resumes nothing', async () => {
    const { app, repository, ctx } = await fixture({ adopted: 'eee5555' });
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);
    await pushLands(repository.id, 'fff6666');

    const stager = new FakeSourceStager();
    const unlocked = await setAppLock(
      { appId: app.id, reason: null },
      { ...ctx, adapters: { ...ctx.adapters, source: () => stager } },
    );
    expect(unlocked.ok && unlocked.value.resumed).toBeNull();
    expect(stager.staged).toEqual([]);
  });

  test('after a rollback, the commit rolled away from is not redeployed', async () => {
    // main is still at the commit the newer Build was made from: the lock
    // held nothing back, and resuming would undo the rollback it protected.
    const {
      app,
      repository,
      component,
      ctx,
      pair,
      build: older,
    } = await servingPushApp('1111aaa', 72);
    const newer = await succeededBuild(component.id, 73, '2222bbb');
    await pushLands(repository.id, '2222bbb');
    expect((await createDeploy({ ...pair, buildId: newer.id }, ctx)).ok).toBe(
      true,
    );
    expect((await rollbackDeploy({ ...pair, buildId: older.id }, ctx)).ok).toBe(
      true,
    );
    expect((await lockOf(app.id)).lockReason).not.toBeNull();

    const stager = new FakeSourceStager();
    const unlocked = await setAppLock(
      { appId: app.id, reason: null },
      { ...ctx, adapters: { ...ctx.adapters, source: () => stager } },
    );
    expect(unlocked.ok && unlocked.value.resumed).toBeNull();
    expect(stager.staged).toEqual([]);
    expect(await desiredBuildOf(component.id)).toBe(older.id);
    expect(await deploysOf(component.id)).toHaveLength(3);
  });
});

describe('who asked for each Deploy', () => {
  test('a press records the operator, and the screens print the name', async () => {
    const { component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 30);

    const placed = await createDeploy({ ...pair, buildId: build.id }, ctx);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const [row] = await ctx.db
      .select({ requestedBy: deploys.requestedBy })
      .from(deploys)
      .where(eq(deploys.id, placed.value.deployId));
    expect(row?.requestedBy).toBe(ctx.principal.id);

    const detail = await getDeployDetail({ id: placed.value.deployId }, ctx);
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.value.deploy.requestedBy).toBe('Operator');

    const listed = await listDeploys({ app: component.appId }, ctx);
    expect(listed.ok).toBe(true);
    if (listed.ok)
      expect(listed.value.deploys[0]?.requestedBy).toBe('Operator');
  });

  test('a push records the dispatcher, printed as auto-deploy on push', async () => {
    const { app, repository, component, ctx } = await fixture({
      adopted: 'cafef00d',
    });
    await succeededBuild(component.id, 31, 'cafef00d');
    await database()
      .db.update(apps)
      .set({ autoDeploy: true })
      .where(eq(apps.id, app.id));

    const attempts = await dispatchAutoDeploys(
      { db: ctx.db, clock: ctx.clock, adapters: ctx.adapters, manifest },
      [
        {
          outcome: 'adopted',
          repositoryId: repository.id,
          fullName: repository.fullName,
          commit: 'cafef00d',
          scopes: [{ appId: app.id }],
        },
      ] as never,
    );
    expect(attempts).toHaveLength(1);
    const result = attempts[0]!.result;
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.deployId === null) return;

    const [row] = await ctx.db
      .select({ requestedBy: deploys.requestedBy })
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));
    expect(row?.requestedBy).toBe(AUTO_DEPLOY_PRINCIPAL.id);

    const detail = await getDeployDetail({ id: result.value.deployId }, ctx);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.value.deploy.requestedBy).toBe('auto-deploy on push');
    }
  });
});

describe('the workspace says what is pushed but not live', () => {
  test('main moved past the serving Build', async () => {
    const { app, repository, component, ctx, pair } = await fixture({
      adopted: 'aaa1111',
    });
    const build = await succeededBuild(component.id, 40, 'aaa1111');
    expect((await createDeploy({ ...pair, buildId: build.id }, ctx)).ok).toBe(
      true,
    );

    // In step: the adopted commit is the one serving.
    const inStep = await getAppWorkspace({ name: app.id }, ctx);
    expect(inStep.ok).toBe(true);
    if (!inStep.ok) return;
    expect(inStep.value.workspace.source).toEqual({
      branch: 'main',
      pending: null,
    });
    expect(inStep.value.workspace.lock).toBeUndefined();

    // A push lands and is adopted; nothing has built it yet.
    await pushLands(repository.id, 'bbb2222');
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);

    const behind = await getAppWorkspace({ name: app.id }, ctx);
    expect(behind.ok).toBe(true);
    if (!behind.ok) return;
    expect(behind.value.workspace.source).toEqual({
      branch: 'main',
      pending: { commit: 'bbb2222', dispatched: false },
    });
    expect(behind.value.workspace.commit).toBe('aaa1111');
    expect(behind.value.workspace.lock).toEqual({
      reason: 'freeze',
      by: 'Operator',
      since: 'just now',
      at: FROZEN.toISOString(),
    });
  });

  test('a Build of the adopted commit is the evidence, unless it failed', async () => {
    const { app, repository, component, ctx, pair } = await fixture({
      adopted: 'aaa1111',
    });
    const serving = await succeededBuild(component.id, 42, 'aaa1111');
    expect((await createDeploy({ ...pair, buildId: serving.id }, ctx)).ok).toBe(
      true,
    );
    await optIn(app.id);
    await pushLands(repository.id, 'bbb2222');

    // `autoDeploy` is on and nothing is coming: the push's Build went red,
    // and no Deploy follows a failed Build.
    const [failed] = await ctx.db
      .insert(builds)
      .values({
        componentId: component.id,
        commit: 'bbb2222',
        targetShape: 'image',
        artifactType: 'image',
        status: 'FAILED',
      })
      .returning();
    const red = await getAppWorkspace({ name: app.id }, ctx);
    expect(red.ok && red.value.workspace.source?.pending).toEqual({
      commit: 'bbb2222',
      dispatched: false,
    });

    await ctx.db
      .update(builds)
      .set({ status: 'RUNNING' })
      .where(eq(builds.id, failed!.id));
    const building = await getAppWorkspace({ name: app.id }, ctx);
    expect(building.ok && building.value.workspace.source?.pending).toEqual({
      commit: 'bbb2222',
      dispatched: true,
    });
  });

  test('a rerun’s uniqueness suffix is not a different commit', async () => {
    const { app, component, ctx, pair } = await fixture({
      adopted: 'ccc3333',
    });
    const rerun = await succeededBuild(component.id, 41, 'ccc3333#1700000000');
    expect((await createDeploy({ ...pair, buildId: rerun.id }, ctx)).ok).toBe(
      true,
    );

    const result = await getAppWorkspace({ name: app.id }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.workspace.source?.pending).toBeNull();
  });
});
