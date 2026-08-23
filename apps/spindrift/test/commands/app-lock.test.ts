/**
 * The deploy lock on an App, and who asked for each Deploy (§6).
 *
 * Three columns and one veto, so the claims are about what the veto holds and
 * what it lets through:
 *
 * - **A locked App refuses every ordinary intent with the reason** — a press
 *   (`createDeploy`, `deployApp`) and a push (`dispatchAutoDeploys`, which
 *   skips before anything is built).
 * - **A rollback goes through and sets the lock**, naming the Build it rolled
 *   away from and who did it: the lock exists so the next adopted push does
 *   not undo the rollback, and refusing the rollback itself would be the lock
 *   guarding against the operator.
 * - **Unlocking clears it**, and the next press is accepted.
 * - **Every intent records its principal** — the operator's id for a press,
 *   `AUTO_DEPLOY_PRINCIPAL` for a push — and the screens print a name.
 * - **The workspace says what is pushed but not live**, joining the adopted
 *   commit to the serving Build's.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { setAppLock } from '../../src/commands/apps/set-lock.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
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
  deploys,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import {
  AUTO_DEPLOY_PRINCIPAL,
  dispatchAutoDeploys,
} from '../../src/reconciler/auto-deploy.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
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

async function succeededBuild(
  componentId: string,
  seed: number,
  commit?: string,
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
    })
    .returning();
  return build!;
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
      value: { appId: app.id, reason: 'change freeze until Monday' },
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
    expect(
      await database()
        .db.select()
        .from(deploys)
        .where(eq(deploys.componentId, component.id)),
    ).toHaveLength(0);
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

    const lock = await lockOf(app.id);
    expect(lock.lockReason).toContain(`rolled back from Build ${newer.id}`);
    expect(lock.lockReason).toContain(`to Build ${older.id}`);
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
    expect(forward.failure.message).toContain('rolled back from Build');
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
});

describe('unlocking', () => {
  test('clears every column and the next deploy is accepted', async () => {
    const { app, component, ctx, pair } = await fixture();
    const build = await succeededBuild(component.id, 20);
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);

    const unlocked = await setAppLock({ appId: app.id, reason: null }, ctx);
    expect(unlocked).toEqual({
      ok: true,
      value: { appId: app.id, reason: null },
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
    await ctx.db
      .update(repositories)
      .set({ authoritativeCommit: 'bbb2222' })
      .where(eq(repositories.id, repository.id));
    await setAppLock({ appId: app.id, reason: 'freeze' }, ctx);

    const behind = await getAppWorkspace({ name: app.id }, ctx);
    expect(behind.ok).toBe(true);
    if (!behind.ok) return;
    expect(behind.value.workspace.source).toEqual({
      branch: 'main',
      pending: { commit: 'bbb2222' },
    });
    expect(behind.value.workspace.commit).toBe('aaa1111');
    expect(behind.value.workspace.lock).toEqual({
      reason: 'freeze',
      by: 'Operator',
      since: 'just now',
      at: FROZEN.toISOString(),
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
