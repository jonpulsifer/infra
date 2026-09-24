/**
 * A push reaches a running deploy. A commit lands on a fake git host, and real
 * repository passes read it through the real `GitHubApp` client.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { listRepositories } from '../../src/commands/repositories/list.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  repositories,
  targets,
} from '../../src/db/schema.ts';
import { readAttemptStream } from '../../src/domain/attempt-log.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import {
  type AutoDeployContext,
  dispatchAutoDeploys,
} from '../../src/reconciler/auto-deploy.ts';
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import {
  type RepoLoopContext,
  reconcileAllRepositories,
} from '../../src/reconciler/repo-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
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
const NOW = new Date('2026-07-28T12:00:00.000Z');
const clock = { now: () => NOW };

/** Nobody is at the keyboard for a push; this is who opens the screen. */
const operator = { id: crypto.randomUUID(), displayName: 'Operator' };

/**
 * Records what it was asked to stage. An `https://` location passes through
 * `dispatchBuild` untouched, where a `gs://` one would need a signed URL.
 */
class FakeSourceStager implements RepositorySourceStager {
  readonly staged: Array<{ repository: string; commit: string }> = [];

  async stageRepository(input: {
    readonly repository: string;
    readonly commit: string;
  }): Promise<StagedSourceBundle> {
    this.staged.push({ repository: input.repository, commit: input.commit });
    return {
      digest: `sha256:${'b'.repeat(64)}`,
      location: `https://depot.lolwtf.ca/bundles/${input.commit}.tgz`,
      retention: 'ephemeral',
    };
  }
}

let stager = new FakeSourceStager();

function host(fake: FakeGitHub): GitHubApp {
  return new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-installation-token',
    appAuthorization: () => 'Bearer test-app-jwt',
    fetch: fake.fetch,
  });
}

/**
 * `build` answers only for the fixture's `hosted` route, so a null `route` is
 * an installation with no build route configured.
 */
function adapters(
  fake: FakeGitHub,
  route: FakeBuildAdapter | null,
): AdapterRegistry {
  return {
    deploy: (adapter) =>
      adapter === 'kubernetes' ? new FakeDeployAdapter({ adapter }) : null,
    build: (name) => (route !== null && name === 'hosted' ? route : null),
    store: () => new FakeSecretStore(),
    repository: () => host(fake),
    source: () => stager,
    supplyChain: () => new SupplyChainHarness(),
  };
}

function commandContext(
  fake: FakeGitHub,
  route: FakeBuildAdapter | null = null,
): CommandContext {
  return {
    principal: operator,
    clock,
    db: database().db,
    adapters: adapters(fake, route),
    manifest,
  };
}

function repoContext(fake: FakeGitHub): RepoLoopContext {
  return { db: database().db, clock, host: host(fake) };
}

function autoContext(fake: FakeGitHub): AutoDeployContext {
  return { db: database().db, clock, adapters: adapters(fake, null), manifest };
}

/**
 * A repo App with a SUCCEEDED Build of the repository's current commit, so a
 * new Build is reachable only because a push moved the commit.
 */
async function pushableApp(autoDeploy: boolean) {
  const db = database().db;
  const fake = new FakeGitHub({ fullName: `example/${crypto.randomUUID()}` });
  const base = fake.commitFiles('main', { 'README.md': 'hello' });

  const [repository] = await db
    .insert(repositories)
    .values({
      fullName: fake.fullName,
      // A TEXT column: it stores the id as the host spells it.
      installationId: fake.installationId,
      defaultBranch: fake.defaultBranch,
      authoritativeCommit: base,
    })
    .returning();
  const [app] = await db
    .insert(apps)
    .values({
      name: `svc-${crypto.randomUUID()}`,
      sourceKind: 'repo',
      sourceRepoUrl: `https://git.invalid/${fake.fullName}`,
      repositoryId: repository!.id,
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
      commit: base,
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
    fake,
    base,
    repository: repository!,
    app: app!,
    component: component!,
    // Returned so a test can disconnect it between the push and the verdict.
    target: target!,
    build: build!,
  };
}

function pushCommit(fake: FakeGitHub): string {
  return fake.commitFiles('main', {
    'README.md': 'hello',
    'src/index.ts': 'export const answer = 42;\n',
  });
}

async function buildsFor(componentId: string) {
  return await database()
    .db.select()
    .from(builds)
    .where(eq(builds.componentId, componentId));
}

async function deploysFor(componentId: string) {
  return await database()
    .db.select()
    .from(deploys)
    .where(eq(deploys.componentId, componentId));
}

/**
 * The "deploying it was refused" lines on one Build's leg of the attempt log,
 * read through `readAttemptStream`, which the attempt screen subscribes with.
 */
async function refusalsOn(
  componentId: string,
  buildId: number,
): Promise<readonly string[]> {
  const page = await readAttemptStream(database().db, { componentId, buildId });
  return page.entries.flatMap((entry) =>
    entry.type === 'log' && entry.line.includes('deploying it was refused')
      ? [entry.line]
      : [],
  );
}

/** One real pass over every repository, dispatched exactly as the loop does. */
async function tick(fake: FakeGitHub) {
  const passes = await reconcileAllRepositories(repoContext(fake));
  const attempts = await dispatchAutoDeploys(autoContext(fake), passes);
  return { passes, attempts };
}

describe('a push reaches a running deploy', () => {
  test('reading the Repositories screen between a push and the next tick does not swallow the push', async () => {
    stager = new FakeSourceStager();
    const { fake, base, component, build } = await pushableApp(true);
    const pushed = pushCommit(fake);

    // Opening the Repositories screen between the merge and the next tick
    // refreshes every active repository against the host.
    const listed = await listRepositories({}, commandContext(fake));
    if (!listed.ok) throw new Error(listed.failure.message);
    const row = listed.value.repos.find(
      (repo) => repo.fullName === fake.fullName,
    );
    // The read refreshes the row without claiming the new head.
    expect(row?.lastReconciledSha).toBe(base);

    const { passes, attempts } = await tick(fake);

    expect(passes.map((pass) => pass.outcome)).toEqual(['adopted']);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      commit: pushed,
      result: { ok: true, value: { phase: 'BUILDING' } },
    });

    const rows = await buildsFor(component.id);
    expect(rows).toHaveLength(2);
    const pending = rows.find((one) => one.id !== build.id);
    expect(pending?.status).toBe('PENDING');
    // Compare the base commit, before the `#<millis>` uniqueness suffix.
    expect(pending?.commit.split('#')[0]).toBe(pushed);
    expect(stager.staged.map((entry) => entry.commit)).toEqual([pushed]);
  });

  test('a push builds the pushed commit and then deploys what it built', async () => {
    stager = new FakeSourceStager();
    const { fake, component, build } = await pushableApp(true);
    const pushed = pushCommit(fake);

    const { attempts } = await tick(fake);

    expect(attempts[0]).toMatchObject({
      commit: pushed,
      result: { ok: true, value: { phase: 'BUILDING' } },
    });
    // Nothing deploys yet: the existing artifact is the previous commit's.
    expect(await deploysFor(component.id)).toHaveLength(0);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(1);

    const rows = await buildsFor(component.id);
    const built = rows.find((one) => one.id !== build.id);
    expect(built?.status).toBe('SUCCEEDED');
    expect(built?.commit.split('#')[0]).toBe(pushed);
    expect(built?.artifactDigest).not.toBeNull();
    // The origin names the pushed commit without the row's `#<millis>` suffix,
    // which no git host can resolve.
    expect(route.built).toHaveLength(1);
    expect(route.built[0]?.source.origin).toMatchObject({
      commit: pushed,
    });

    // Nobody is left to place a pushed Build's artifact, so the build loop
    // places it.
    const placed = await deploysFor(component.id);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.buildId).toBe(built!.id);

    const [desired] = await database()
      .db.select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, component.id));
    expect(desired?.desiredBuildId).toBe(built!.id);
  });

  test('an App that did not opt in gets neither', async () => {
    stager = new FakeSourceStager();
    const { fake, component, build } = await pushableApp(false);
    pushCommit(fake);

    const { passes, attempts } = await tick(fake);
    // Opting out of deploys still adopts the commit.
    expect(passes.map((pass) => pass.outcome)).toEqual(['adopted']);
    expect(attempts).toEqual([]);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(0);

    expect((await buildsFor(component.id)).map((one) => one.id)).toEqual([
      build.id,
    ]);
    expect(await deploysFor(component.id)).toHaveLength(0);
    expect(stager.staged).toEqual([]);
    expect(route.built).toEqual([]);
  });

  test("an operator's Rebuild press on an opted-in App does not deploy by itself", async () => {
    stager = new FakeSourceStager();
    const { fake, app, component, build } = await pushableApp(true);

    // Nothing is pushed, so only the opt-in misread as a trigger could place a
    // Deploy.
    const pressed = await deployApp(
      // A Rebuild press: the App by id, `rebuild`, and no commit.
      { name: app.id, rebuild: true },
      commandContext(fake),
    );
    if (!pressed.ok) throw new Error(pressed.failure.message);
    expect(pressed.value.phase).toBe('BUILDING');

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(1);

    const rebuilt = (await buildsFor(component.id)).find(
      (one) => one.id !== build.id,
    );
    expect(rebuilt?.status).toBe('SUCCEEDED');
    // `deployApp` sets this only for a caller that names a commit, as a push
    // does.
    expect(rebuilt?.deployOnSuccess).toBe(false);

    // `apps.autoDeploy` means deploy on push, and this Build did not come from
    // one.
    expect(await deploysFor(component.id)).toHaveLength(0);
  });

  test("a push's Build carries the instruction to place it, and a Rebuild's does not", async () => {
    stager = new FakeSourceStager();
    const { fake, base, app, component } = await pushableApp(true);

    // A Rebuild press, then a push, on the same App.
    const pressed = await deployApp(
      { name: app.id, rebuild: true },
      commandContext(fake),
    );
    if (!pressed.ok) throw new Error(pressed.failure.message);

    const pushed = pushCommit(fake);
    const { attempts } = await tick(fake);
    const dispatched = attempts[0]?.result;
    if (dispatched === undefined || !dispatched.ok) {
      throw new Error('the push dispatched nothing to assert on');
    }

    const rows = await buildsFor(component.id);
    const rebuilt = rows.find((one) => one.id === pressed.value.buildId);
    const fromPush = rows.find((one) => one.id === dispatched.value.buildId);

    expect(rebuilt?.id).not.toBe(fromPush?.id);
    expect(rebuilt?.commit.split('#')[0]).toBe(base);
    expect(fromPush?.commit.split('#')[0]).toBe(pushed);

    // Recorded on the Build because the opt-in can flip before the verdict,
    // and the build loop keys on it.
    expect(fromPush?.deployOnSuccess).toBe(true);
    expect(rebuilt?.deployOnSuccess).toBe(false);
  });

  test('the Build that succeeded is the one placed, even when a newer Build is already queued', async () => {
    stager = new FakeSourceStager();
    const { fake, component } = await pushableApp(true);

    // A second push while the first is queued writes a second PENDING row, so
    // two queued Builds both ask to be placed.
    const first = fake.commitFiles('main', {
      'README.md': 'hello',
      'src/index.ts': 'export const answer = 42;\n',
    });
    await tick(fake);
    const second = fake.commitFiles('main', {
      'README.md': 'hello',
      'src/index.ts': 'export const answer = 43;\n',
    });
    await tick(fake);

    const queued = (await buildsFor(component.id))
      .filter((one) => one.status === 'PENDING')
      .sort((left, right) => left.id - right.id);
    expect(queued.map((one) => one.commit.split('#')[0])).toEqual([
      first,
      second,
    ]);
    expect(queued.map((one) => one.deployOnSuccess)).toEqual([true, true]);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(2);

    const placed = (await deploysFor(component.id)).sort(
      (left, right) => left.id - right.id,
    );
    // `runBuildPass` dispatches oldest first, and each Deploy names the Build
    // that just succeeded, never the App's newest.
    expect(placed[0]?.buildId).toBe(queued[0]!.id);
    expect(placed.map((one) => one.buildId)).toEqual([
      queued[0]!.id,
      queued[1]!.id,
    ]);
  });

  test('a refused deploy is recorded on the Build it is about', async () => {
    stager = new FakeSourceStager();
    const { fake, component, target, build } = await pushableApp(true);
    pushCommit(fake);
    await tick(fake);

    // `checkDeployable` refuses a disconnected Target, but nothing sweeps its
    // PENDING Build, so the build runs and the deploy is refused.
    await database()
      .db.update(targets)
      .set({ status: 'disconnected' })
      .where(eq(targets.id, target.id));

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(1);

    const built = (await buildsFor(component.id)).find(
      (one) => one.id !== build.id,
    );
    expect(built?.status).toBe('SUCCEEDED');
    expect(await deploysFor(component.id)).toHaveLength(0);

    // The refusal lands on the attempt log of the Build the push points at.
    const refusals = await refusalsOn(component.id, built!.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toStartWith(
      'this Build succeeded, and deploying it was refused:',
    );
    expect(refusals[0]).toContain(
      'is disconnected, so nothing new can be placed on it',
    );
    expect(await refusalsOn(component.id, build.id)).toEqual([]);
  });
});
