/**
 * `dispatchAutoDeploys`: which Apps an adopted pass dispatches, and whether a
 * push builds its commit or deploys the Build already made from it.
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

const PUSHED = '1'.repeat(40);
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
 * `dispatchAutoDeploys` skips a pass whose commit no longer governs, so a
 * synthetic pass needs a repository row at the commit it claims.
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

/**
 * A repo App, the only kind that can opt in, with a placed Component and a
 * signed Build of `builtCommit`.
 */
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
      // The column defaults to the database's wall-clock `now()`, which is
      // newer than every row a dispatch writes at the frozen `NOW`.
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

/** A real `createDeploy` runs behind this context. */
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

    // The pushed commit, never the previous Build's or `HEAD`.
    expect(stager.staged.map((entry) => entry.commit)).toEqual([PUSHED]);

    // A Build `deployApp` writes carries a `#<millis>` uniqueness suffix, so
    // compare the base commit.
    const rows = await buildsFor(component.id);
    expect(rows).toHaveLength(2);
    const pending = rows.find((row) => row.id !== build.id);
    expect(pending?.status).toBe('PENDING');
    expect(pending?.commit.split('#')[0]).toBe(PUSHED);

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
    expect(stager.staged).toEqual([]);
    expect(await buildsFor(component.id)).toHaveLength(1);
  });

  test('a push whose commit is already what is desired writes nothing at all', async () => {
    stager = new FakeSourceStager();
    const { app, component, build, repository } = await deployableApp(
      true,
      PUSHED,
    );

    // The first pass places it, as for an App created from the adopted commit.
    await dispatchAutoDeploys(context(), [adoptedPass(repository, [app.id])]);
    expect(await deployCountFor(component.id)).toBe(1);

    const again = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id]),
    ]);

    expect(again[0]).toMatchObject({
      result: { ok: true, value: { buildId: build.id, phase: 'UNCHANGED' } },
    });
    expect(await deployCountFor(component.id)).toBe(1);
    expect(await buildsFor(component.id)).toHaveLength(1);
  });

  test('a push arriving while that commit is still building waits for it', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true);

    await dispatchAutoDeploys(context(), [adoptedPass(repository, [app.id])]);
    const afterFirst = await buildsFor(component.id);
    expect(afterFirst).toHaveLength(2);

    // The webhook and the poll loop can adopt the same commit twice, and the
    // second must not reset its Build.
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
    // A poll pass can be minutes old on arrival, and the webhook may have
    // adopted a newer commit meanwhile.
    const newer = '3'.repeat(40);
    await database()
      .db.update(repositories)
      .set({ authoritativeCommit: newer })
      .where(eq(repositories.id, repository.id));

    const attempts = await dispatchAutoDeploys(context(), [
      adoptedPass(repository, [app.id], PUSHED),
    ]);

    // Acting on the older commit would roll back the newer one.
    expect(attempts).toEqual([]);
    expect(stager.staged).toEqual([]);
    expect(await buildsFor(component.id)).toHaveLength(1);
    expect(await deployCountFor(component.id)).toBe(0);
  });

  test('the same pass dispatches while its commit still governs', async () => {
    stager = new FakeSourceStager();
    const { app, component, repository } = await deployableApp(true);

    // The control for the case above: the same pass with the row unchanged.
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
    // The App's own repository at its adopted commit, so only the `unchanged`
    // outcome can explain an empty result.
    const unchanged: RepositoryReconciliation = {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unchanged',
      commit: PUSHED,
    };

    const attempts = await dispatchAutoDeploys(context(), [unchanged]);

    expect(attempts).toEqual([]);
    expect(await deployCountFor(component.id)).toBe(0);
    // The App was eligible, so the empty result is the pass being ignored.
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
