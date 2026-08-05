/**
 * `dispatchAutoDeploys` — the opt-in gate (§15).
 *
 * `repo-loop.test.ts` proves what a pass over a repository adopts;
 * `webhook-route.test.ts` proves one delivery reaches this module end to end.
 * This file is about the one decision that is this module's own: which of
 * the Apps a pass named actually gets a Deploy. `apps.autoDeploy` is the
 * whole of that decision, so the passes below are synthetic —
 * `RepositoryReconciliation` values built by hand rather than produced by a
 * real reconciliation pass — which is what lets this file assert the gate in
 * isolation from repository reads.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  type AutoDeployContext,
  dispatchAutoDeploys,
} from '../../src/reconciler/auto-deploy.ts';
import type { RepositoryReconciliation } from '../../src/reconciler/repo-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const NOW = new Date('2026-07-28T12:00:00.000Z');
const clock = { now: () => NOW };

/** An App with a Component, a connected Target, and a Build ready to deploy. */
async function deployableApp(autoDeploy: boolean) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({
      name: `svc-${crypto.randomUUID()}`,
      sourceKind: 'archive',
      autoDeploy,
    })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(targetValues({ name: `cluster-${crypto.randomUUID()}` }))
    .returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
    updatedAt: NOW,
  });
  const digest = `sha256:${crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: crypto.randomUUID().replaceAll('-', '').padEnd(40, '0'),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest,
      bundleDigest: digest,
      bundleLocation: 'https://depot.lolwtf.ca/bundles/1.zip',
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(digest, NOW.toISOString()),
    })
    .returning();
  return { app: app!, component: component!, build: build! };
}

/** A working `AutoDeployContext` — a real `createDeploy` runs behind it. */
function context(): AutoDeployContext {
  return {
    db: database().db,
    clock,
    adapters: {
      deploy: (adapter) =>
        adapter === 'kubernetes' ? new FakeDeployAdapter({ adapter }) : null,
      build: () => null,
      store: () => {
        throw new Error('auto-deploy dispatch reached the secret store');
      },
      repository: () => null,
      supplyChain: () => new SupplyChainHarness(),
    },
    manifest,
  };
}

function adoptedPass(appIds: readonly string[]): RepositoryReconciliation {
  return {
    repositoryId: crypto.randomUUID(),
    fullName: 'example/app',
    outcome: 'adopted',
    commit: '1'.repeat(40),
    scopes: appIds.map((appId) => ({
      scope: '.',
      appId,
      outcome: 'absent' as const,
    })),
  };
}

async function deployCountFor(componentId: string): Promise<number> {
  return (
    await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, componentId))
  ).length;
}

describe('the opt-in gate', () => {
  test('an opted-in App is deployed through the same command the workspace button calls', async () => {
    const { app, component, build } = await deployableApp(true);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass([app.id]),
    ]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ appId: app.id, result: { ok: true } });
    expect(await deployCountFor(component.id)).toBe(1);
    const [desired] = await database()
      .db.select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, component.id));
    expect(desired?.desiredBuildId).toBe(build.id);
  });

  test('an App that never opted in is left alone', async () => {
    const { app, component } = await deployableApp(false);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass([app.id]),
    ]);

    expect(attempts).toEqual([]);
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('one repository can carry both — only the opted-in App moves', async () => {
    const opted = await deployableApp(true);
    const silent = await deployableApp(false);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass([opted.app.id, silent.app.id]),
    ]);

    expect(attempts.map((attempt) => attempt.appId)).toEqual([opted.app.id]);
    expect(await deployCountFor(opted.component.id)).toBe(1);
    expect(await deployCountFor(silent.component.id)).toBe(0);
  });

  test('a pass that adopted nothing dispatches nothing, opted in or not', async () => {
    const { app, component } = await deployableApp(true);
    const unchanged: RepositoryReconciliation = {
      repositoryId: crypto.randomUUID(),
      fullName: 'example/app',
      outcome: 'unchanged',
      commit: '2'.repeat(40),
    };

    const attempts = await dispatchAutoDeploys(context(), [unchanged]);

    expect(attempts).toEqual([]);
    expect(await deployCountFor(component.id)).toBe(0);
    // Confirms the App really was eligible, so the empty result above is the
    // pass being ignored rather than the fixture being wrong.
    expect(app.autoDeploy).toBe(true);
  });

  test('no adopted commit anywhere is not a database round trip', async () => {
    const unreachable: AutoDeployContext = {
      db: new Proxy(
        {},
        {
          get: () => {
            throw new Error(
              'dispatch reached the database with nothing adopted',
            );
          },
        },
      ) as AutoDeployContext['db'],
      clock,
      adapters: context().adapters,
      manifest,
    };

    expect(await dispatchAutoDeploys(unreachable, [])).toEqual([]);
  });
});
