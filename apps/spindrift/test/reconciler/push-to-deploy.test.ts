/**
 * A push reaches a running deploy (§15).
 *
 * Every other file on this path proves one joint. `repo-loop.test.ts` proves
 * what a pass adopts, `auto-deploy.test.ts` proves which act a pass is
 * dispatched for, `build-loop.test.ts` proves which placement a Build binds to.
 * None of them runs the whole chain, so the two ways it could come apart —
 * a screen consuming the transition before the loop sees it, and a Build
 * finishing with nobody left to place its artifact — were both invisible to the
 * suite while being exactly the thing "push to deploy" means.
 *
 * So the passes here are **real**: a commit lands on a fake git host, a real
 * `reconcileAllRepositories` reads it through the real `GitHubApp` client, and
 * what it returns is what gets dispatched. Nothing below hand-builds a
 * `RepositoryReconciliation` — the point is that the ones the loop produces
 * carry what the dispatcher needs.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
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
 * Records what it was asked to stage; fetches nothing.
 *
 * The location is `https://` rather than the depot's own `gs://`, because
 * `dispatchBuild` exchanges a `gs://` address for a signed URL and this suite
 * is offline. An `https://` bundle passes through untouched, which is the one
 * property the build below needs from it.
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
 * The far side, as every context below sees it.
 *
 * `build` answers only for the route the fixture manifest ranks first, so a
 * test that passes no route is an installation with none configured — which is
 * how the two cases that must not build stay honest.
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
 * A healthy repo App: connected repository, one Component placed on a
 * connected Target, and one SUCCEEDED Build of the commit the repository is
 * currently at.
 *
 * Deliberately *healthy* rather than never-built. An App with nothing built
 * would take a Build on any push at all, so it could not tell "the push was
 * dispatched for its own commit" apart from "the fixture had nothing to
 * deploy"; with an artifact already on hand, a new Build is only reachable
 * because the pushed commit is not the one it was made from.
 */
async function pushableApp(autoDeploy: boolean) {
  const db = database().db;
  const fake = new FakeGitHub({ fullName: `example/${crypto.randomUUID()}` });
  const base = fake.commitFiles('main', { 'README.md': 'hello' });

  const [repository] = await db
    .insert(repositories)
    .values({
      fullName: fake.fullName,
      // TEXT, not a number — the column stores what the host calls it.
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
      // Explicit, and before the frozen clock: the column defaults to the
      // database's `now()`, which in a test is the real wall clock and
      // therefore *newer* than every row a dispatch writes at `NOW`.
      createdAt: new Date(NOW.getTime() - 60_000),
    })
    .returning();

  return {
    fake,
    base,
    repository: repository!,
    app: app!,
    component: component!,
    build: build!,
  };
}

/** A developer merges something. The default branch moves; nothing else does. */
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

    // The window this test is about: somebody opens the Repositories screen
    // after the merge and before the loop's next tick. That read refreshes
    // every active repository against the host, which is the whole reason it
    // could ever have consumed the transition.
    const listed = await listRepositories({}, commandContext(fake));
    if (!listed.ok) throw new Error(listed.failure.message);
    const row = listed.value.repos.find(
      (repo) => repo.fullName === fake.fullName,
    );
    // What the screen renders is still the commit that *governs* — the read
    // refreshed the row without claiming the new head.
    expect(row?.lastReconciledSha).toBe(base);

    const { passes, attempts } = await tick(fake);

    // The transition is still there for the loop to claim. Before ticket 132
    // the list read advanced `authoritative_commit` and dispatched nothing, so
    // this pass reported `unchanged`, the dispatcher had nothing to fire on,
    // and the pushed commit was never built at all — by anybody, ever.
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
    // The `#<millis>` suffix is the rerun uniqueness key, so the commit is read
    // off the base of it.
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
    // Half an arc: a Build is queued and nothing is live yet. The App's
    // existing artifact was made from the previous commit, and placing it here
    // is precisely what a push must not do.
    expect(await deploysFor(component.id)).toHaveLength(0);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(1);

    const rows = await buildsFor(component.id);
    const built = rows.find((one) => one.id !== build.id);
    expect(built?.status).toBe('SUCCEEDED');
    expect(built?.commit.split('#')[0]).toBe(pushed);
    expect(built?.artifactDigest).not.toBeNull();
    // The route was handed the bundle staged for the pushed commit, so the
    // artifact about to be deployed is genuinely that commit's.
    expect(route.built).toHaveLength(1);
    expect(route.built[0]?.source.origin).toMatchObject({
      commit: built!.commit,
    });

    // The second half of the push, and the joint that had no coverage: a green
    // Build a push asked for is a Build with nobody left to place its artifact,
    // so the build loop makes the same call the workspace button makes.
    const placed = await deploysFor(component.id);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.buildId).toBe(built!.id);

    // And it is what the pair *wants*, not merely a row that happened — which
    // is the difference between a deploy and a log line.
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
    // The commit was adopted all the same — opting out of deploying is not
    // opting out of reconciliation, and the row still learns where the branch
    // is.
    expect(passes.map((pass) => pass.outcome)).toEqual(['adopted']);
    expect(attempts).toEqual([]);

    const route = new FakeBuildAdapter();
    expect(await runBuildPass(commandContext(fake, route))).toBe(0);

    // No second Build and no Deploy. This is what makes the two cases above
    // assertions about the opt-in firing rather than about a fixture that
    // deploys whenever anything touches it.
    expect((await buildsFor(component.id)).map((one) => one.id)).toEqual([
      build.id,
    ]);
    expect(await deploysFor(component.id)).toHaveLength(0);
    expect(stager.staged).toEqual([]);
    expect(route.built).toEqual([]);
  });
});
