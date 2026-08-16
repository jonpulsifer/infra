/**
 * `dispatchAutoDeploys` — the opt-in gate, and which act a push asks for (§15).
 *
 * `repo-loop.test.ts` proves what a pass over a repository adopts;
 * `webhook-route.test.ts` proves one delivery reaches this module end to end.
 * This file is about the two decisions that are this module's own: which of
 * the Apps a pass named gets dispatched at all, and — because a push carries a
 * commit and the workspace button does not — which act it is dispatched for.
 * The passes below are synthetic, `RepositoryReconciliation` values built by
 * hand rather than produced by a real reconciliation pass, which is what lets
 * this file vary the adopted commit against the Build on hand.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  repositories,
  targets,
} from '../../src/db/schema.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
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
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const NOW = new Date('2026-07-28T12:00:00.000Z');
const clock = { now: () => NOW };

/** The commit every `adoptedPass` below says was just pushed. */
const PUSHED = '1'.repeat(40);
/** What the App's existing Build was made from — one commit ago. */
const PREVIOUS = '0'.repeat(40);

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

let stager = new FakeSourceStager();

/**
 * An App with a Component, a connected Target, and a Build ready to deploy.
 *
 * A **repo** App, because that is the only kind a push can reach — the archive
 * arm of `setAppAutoDeploy` refuses the opt-in outright, so an archive fixture
 * with `autoDeploy` set is a state the product cannot produce.
 *
 * `builtCommit` is what the existing Build was made from. Passing `PUSHED`
 * makes the App already-built at the commit the pass adopts; the default leaves
 * it one commit behind, which is the ordinary case a push arrives in.
 */
/**
 * A repository row whose adopted commit is what a pass will claim to carry.
 *
 * Separate from the App because `dispatchAutoDeploys` re-reads
 * `authoritative_commit` before acting: a pass whose commit no longer governs
 * has been overtaken, and skipping it is the point. So a synthetic pass has to
 * name a real repository sitting at the commit it claims, or it is testing the
 * overtaken path by accident.
 */
async function repositoryAt(commit: string) {
  const [repository] = await database()
    .db.insert(repositories)
    .values({
      fullName: `example/${crypto.randomUUID()}`,
      installationId: '42',
      defaultBranch: 'main',
      authoritativeCommit: commit,
    })
    .returning();
  return repository!;
}

async function deployableApp(
  autoDeploy: boolean,
  builtCommit: string = PREVIOUS,
  on?: Awaited<ReturnType<typeof repositoryAt>>,
) {
  const db = database().db;
  const repository = on ?? (await repositoryAt(PUSHED));
  const [app] = await db
    .insert(apps)
    .values({
      name: `svc-${crypto.randomUUID()}`,
      sourceKind: 'repo',
      sourceRepoUrl: `https://git.invalid/${repository.fullName}`,
      repositoryId: repository.id,
      autoDeploy,
    })
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
    .values(targetValues({ vesselId: vessel.id }))
    .returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
    updatedAt: NOW,
  });
  await db
    .update(components)
    .set({ placedTargetId: target!.id })
    .where(eq(components.id, component!.id));
  const digest = `sha256:${crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: builtCommit,
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: digest,
      bundleDigest: digest,
      bundleLocation: 'https://depot.lolwtf.ca/bundles/1.zip',
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(digest, NOW.toISOString()),
      // Explicit, and before the frozen clock: the column defaults to the
      // database's `now()`, which in a test is the real wall clock and
      // therefore *newer* than every row a dispatch writes at `NOW`.
      createdAt: new Date(NOW.getTime() - 60_000),
    })
    .returning();
  return {
    app: app!,
    component: component!,
    build: build!,
    repository,
  };
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
      source: () => stager,
      store: () => {
        throw new Error('auto-deploy dispatch reached the secret store');
      },
      repository: () => null,
      supplyChain: () => new SupplyChainHarness(),
    },
    manifest,
  };
}

function adoptedPass(
  repository: { readonly id: string; readonly fullName: string },
  appIds: readonly string[],
  commit: string = PUSHED,
): RepositoryReconciliation {
  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    outcome: 'adopted',
    commit,
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

async function buildsFor(componentId: string) {
  return await database()
    .db.select()
    .from(builds)
    .where(eq(builds.componentId, componentId));
}

describe('which act a push asks for', () => {
  test('a push whose commit is not built writes a Build for that commit, and deploys nothing', async () => {
    stager = new FakeSourceStager();
    const { app, component, build, repository } = await deployableApp(true);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      appId: app.id,
      commit: PUSHED,
      result: { ok: true, value: { phase: 'BUILDING' } },
    });

    // The pushed commit is what got staged — not the one the previous Build
    // was made from, and not `HEAD`.
    expect(stager.staged.map((entry) => entry.commit)).toEqual([PUSHED]);

    // A PENDING Build of the pushed commit, beside the one that already
    // succeeded. Its `#<millis>` suffix is the rerun uniqueness key, so the
    // commit is read off the base.
    const rows = await buildsFor(component.id);
    expect(rows).toHaveLength(2);
    const pending = rows.find((row) => row.id !== build.id);
    expect(pending?.status).toBe('PENDING');
    expect(pending?.commit.split('#')[0]).toBe(PUSHED);

    // And crucially: no Deploy of the *previous* commit's artifact, which is
    // what a push used to produce.
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('a push whose commit is already built deploys that Build', async () => {
    stager = new FakeSourceStager();
    const { app, component, build, repository } = await deployableApp(
      true,
      PUSHED,
    );

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(attempts[0]).toMatchObject({
      result: { ok: true, value: { phase: 'PENDING' } },
    });
    expect(await deployCountFor(component.id)).toBe(1);
    const [desired] = await database()
      .db.select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, component.id));
    expect(desired?.desiredBuildId).toBe(build.id);
    // Nothing was rebuilt: the commit on hand is the commit that was pushed.
    expect(stager.staged).toEqual([]);
    expect(await buildsFor(component.id)).toHaveLength(1);
  });

  test('a push whose commit is already what is desired writes nothing at all', async () => {
    stager = new FakeSourceStager();
    const { app, component, build, repository } = await deployableApp(
      true,
      PUSHED,
    );

    // The first pass places it. This is the state an App created from the very
    // commit the loop is about to adopt lands in.
    await dispatchAutoDeploys(context(), [adoptedPass(repository, [app.id])]);
    expect(await deployCountFor(component.id)).toBe(1);

    const again = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(again[0]).toMatchObject({
      result: { ok: true, value: { buildId: build.id, phase: 'UNCHANGED' } },
    });
    // No second Deploy row, and therefore no second re-apply of a
    // byte-identical artifact.
    expect(await deployCountFor(component.id)).toBe(1);
    expect(await buildsFor(component.id)).toHaveLength(1);
  });

  test('a push arriving while that commit is still building waits for it', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true);

    // First push: a PENDING Build of the pushed commit.
    await dispatchAutoDeploys(context(), [adoptedPass(repository, [app.id])]);
    const afterFirst = await buildsFor(component.id);
    expect(afterFirst).toHaveLength(2);

    // The same commit adopted again — the webhook and the poll loop racing, or
    // a redelivery. It must not reset the Build that is already for it.
    const again = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(again[0]).toMatchObject({
      result: { ok: true, value: { phase: 'BUILDING' } },
    });
    expect(await buildsFor(component.id)).toHaveLength(2);
    expect(stager.staged).toHaveLength(1);
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('two repositories adopting in one round each dispatch their own commit', async () => {
    stager = new FakeSourceStager();
    const otherCommit = '2'.repeat(40);
    const first = await deployableApp(true);
    const second = await deployableApp(
      true,
      PREVIOUS,
      await repositoryAt(otherCommit),
    );

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(first.repository, [first.app.id]),
      adoptedPass(second.repository, [second.app.id], otherCommit),
    ]);

    expect(attempts.map((attempt) => attempt.commit)).toEqual([
      PUSHED,
      otherCommit,
    ]);
    expect(stager.staged.map((entry) => entry.commit)).toEqual([
      PUSHED,
      otherCommit,
    ]);
  });
});

describe('a pass that has been overtaken', () => {
  test('dispatches nothing, because a newer commit already governs', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true);
    // The poll loop reconciles the whole fleet before it dispatches any of it,
    // so this pass can be minutes old on arrival. In that window the webhook —
    // another process — adopted a newer commit and dispatched it. The row is
    // what that looks like from here.
    const newer = '3'.repeat(40);
    await database()
      .db.update(repositories)
      .set({ authoritativeCommit: newer })
      .where(eq(repositories.id, repository.id));

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id], PUSHED),
    ]);

    // Acting on the older commit would stage it, build it, and place it after
    // the newer one — a rollback nobody asked for. The newer pass is already
    // doing this work.
    expect(attempts).toEqual([]);
    expect(stager.staged).toEqual([]);
    expect(await buildsFor(component.id)).toHaveLength(1);
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('the same pass dispatches while its commit still governs', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true);

    // Identical to the case above but for the row, which is what makes that one
    // the guard firing rather than the fixture being inert.
    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id], PUSHED),
    ]);

    expect(attempts).toHaveLength(1);
    expect(stager.staged.map((entry) => entry.commit)).toEqual([PUSHED]);
    expect(await buildsFor(component.id)).toHaveLength(2);
  });
});

describe('the opt-in gate', () => {
  test('an App that never opted in is left alone', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(false, PUSHED);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(attempts).toEqual([]);
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('one repository can carry both — only the opted-in App moves', async () => {
    stager = new FakeSourceStager();
    // One repository, two Apps — which is the premise: the opt-in is a
    // property of the App, so the same adopted commit must move one and not
    // the other.
    const shared = await repositoryAt(PUSHED);
    const opted = await deployableApp(true, PUSHED, shared);
    const silent = await deployableApp(false, PUSHED, shared);

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(shared, [opted.app.id, silent.app.id]),
    ]);

    expect(attempts.map((attempt) => attempt.appId)).toEqual([opted.app.id]);
    expect(await deployCountFor(opted.component.id)).toBe(1);
    expect(await deployCountFor(silent.component.id)).toBe(0);
  });

  test('a pass that adopted nothing dispatches nothing, opted in or not', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true, PUSHED);
    // The App's own repository, at the commit it has actually adopted — so the
    // empty result below is the `unchanged` outcome being ignored, and not a
    // pass this dispatcher would have skipped for naming a stranger.
    const unchanged: RepositoryReconciliation = {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unchanged',
      commit: PUSHED,
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
