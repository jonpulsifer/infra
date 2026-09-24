/**
 * The repository loop over real Postgres. It adopts only from the default
 * branch, and lost access freezes the repository with every Deploy intact.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  apps,
  builds,
  components,
  deploys,
  repositories,
  targets,
} from '../../src/db/schema.ts';
import type { DetectionProposal } from '../../src/domain/detection/ladder.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import {
  configurationTransaction,
  openConfigurationPullRequest,
} from '../../src/integrations/github/config-pr.ts';
import {
  applyWebhookDelivery,
  PUSH_LAG_RETRY_MS,
  type RepoLoopContext,
  reconcileAllRepositories,
  reconcileRepository,
} from '../../src/reconciler/repo-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { insertVessel, targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();

const BUILD_WORKFLOW =
  'example/platform/.github/workflows/spindrift-build.yml@4bf1f21a7c1e2d3b5a6f708192a3b4c5d6e7f809';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const clock = { now: () => NOW };

const proposal: DetectionProposal = {
  source: 'detection',
  kind: 'service',
  reason: 'a fixture',
  kinds: [{ kind: 'service', available: true }],
  build: {
    frontend: 'railpack',
    buildCommand: 'bun run build',
    outputDirectory: null,
  },
  watchPaths: ['services/api'],
};

const SPINDRIFT_YAML = [
  'version: 1',
  'component:',
  '  kind: service',
  'build:',
  '  frontend: railpack',
  '  command: bun run build',
  '  outputDirectory: null',
  'watchPaths:',
  '  - services/api',
  '',
].join('\n');

function host(fake: FakeGitHub): GitHubApp {
  return new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-installation-token',
    appAuthorization: () => 'Bearer test-app-jwt',
    fetch: fake.fetch,
  });
}

async function context(fake: FakeGitHub): Promise<RepoLoopContext> {
  return { db: database().db, clock, host: host(fake) };
}

/** One connected repository with one App scoped into it. */
async function connect(
  fake: FakeGitHub,
  subpath: string | null = 'services/api',
) {
  const db = database().db;
  const [repository] = await db
    .insert(repositories)
    .values({
      fullName: fake.fullName,
      installationId: fake.installationId,
      defaultBranch: fake.defaultBranch,
    })
    .returning();
  const [app] = await db
    .insert(apps)
    .values({
      name: 'invoices',
      sourceKind: 'repo',
      sourceRepoUrl: `https://git.invalid/${fake.fullName}`,
      sourceRepoSubpath: subpath,
      repositoryId: repository!.id,
    })
    .returning();
  return { repository: repository!, app: app! };
}

/** A LIVE Deploy for the access tests to leave intact. */
async function liveDeploy(appId: string) {
  const db = database().db;
  const [component] = await db
    .insert(components)
    .values({ appId, name: 'api', kind: 'service', expose: true })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', { name: 'cluster' });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, rank: 1 }))
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: '1111111111111111111111111111111111111111',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      status: 'SUCCEEDED',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
      url: 'https://invoices.apps.example.test',
    })
    .returning();
  return { component: component!, deploy: deploy! };
}

async function reload(repositoryId: string) {
  const [row] = await database()
    .db.select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  return row!;
}

describe('adopting the default branch', () => {
  test('adopts a scope’s Spindrift file and records the commit', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository, app } = await connect(fake);

    const pass = await reconcileRepository(await context(fake), repository);

    expect(pass).toMatchObject({ outcome: 'adopted', commit });
    expect(pass.outcome === 'adopted' && pass.scopes).toEqual([
      {
        scope: 'services/api',
        appId: app.id,
        outcome: 'adopted',
        proposal: {
          ...proposal,
          source: 'spindrift-file',
          // The workspace shows this as where the Component's kind came from.
          reason: 'services/api/spindrift.yaml asserts this scope is a service',
          kinds: [
            {
              kind: 'service',
              available: true,
              reason: 'asserted by spindrift.yaml',
            },
          ],
        },
        // First adoption: there is no earlier commit to have differed from.
        changed: true,
      },
    ]);
    expect((await reload(repository.id)).authoritativeCommit).toBe(commit);
  });

  test('a scope with no Spindrift file is absent, not an error', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'nothing here' });
    const { repository } = await connect(fake);

    const pass = await reconcileRepository(await context(fake), repository);

    expect(pass.outcome).toBe('adopted');
    expect(pass.outcome === 'adopted' && pass.scopes[0]?.outcome).toBe(
      'absent',
    );
    expect((await reload(repository.id)).authoritativeCommit).toBe(commit);
  });

  test('a second pass over an unchanged branch adopts nothing again', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);

    await reconcileRepository(loop, repository);
    const second = await reconcileRepository(loop, await reload(repository.id));

    expect(second.outcome).toBe('unchanged');
  });

  test('reports whether a scope actually changed between adopted commits', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'first',
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    // A commit that moves the branch without touching the scope's file.
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'second',
    });
    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass.outcome).toBe('adopted');
    expect(pass.outcome === 'adopted' && pass.scopes[0]).toMatchObject({
      outcome: 'adopted',
      changed: false,
    });
  });

  test('a commit carrying an unparseable file is rejected whole', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);
    const adopted = (await reload(repository.id)).authoritativeCommit;

    fake.commitFiles('main', {
      'services/api/spindrift.yaml': 'version: 1\ncomponent:\n  kind: banana\n',
    });
    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass.outcome).toBe('rejected');
    expect(pass.outcome === 'rejected' && pass.scopes[0]).toMatchObject({
      outcome: 'invalid',
    });
    // A commit's configuration lands whole or not at all, so the previous
    // commit still governs.
    expect((await reload(repository.id)).authoritativeCommit).toBe(adopted);
  });
});

/** Every file-contents read the client made; `adopt: false` skips them. */
function scopeFileReads(fake: FakeGitHub) {
  return fake.requests.filter((request) => request.path.includes('/contents/'));
}

/**
 * A repository that adopted `commit`, with all three columns a refresh owns
 * visibly stale.
 */
async function alreadyAdopted(fake: FakeGitHub, commit: string) {
  const { repository } = await connect(fake);
  await database()
    .db.update(repositories)
    .set({
      authoritativeCommit: commit,
      defaultBranch: 'master',
      reconciledAt: null,
    })
    .where(eq(repositories.id, repository.id));
  return repository;
}

describe('a pass that is not going to dispatch', () => {
  test('refreshes the row and leaves the transition for a pass that will', async () => {
    const fake = new FakeGitHub();
    const adopted = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const repository = await alreadyAdopted(fake, adopted);
    const loop = await context(fake);

    const pushed = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'pushed',
    });
    const read = await reconcileRepository(loop, await reload(repository.id), {
      adopt: false,
    });

    // `behind`: a commit is waiting, which a screen can show.
    expect(read).toMatchObject({ outcome: 'behind', commit: pushed, adopted });
    const row = await reload(repository.id);
    expect(row.authoritativeCommit).toBe(adopted);
    expect(row.defaultBranch).toBe('main');
    expect(row.reconciledAt).toEqual(NOW);

    // The push is still there to claim. Nothing dispatches a `behind`, so a
    // read that advanced the cursor would lose it.
    const claim = await reconcileRepository(loop, await reload(repository.id));
    expect(claim).toMatchObject({ outcome: 'adopted', commit: pushed });
    expect((await reload(repository.id)).authoritativeCommit).toBe(pushed);
  });

  test('does not read one scope’s Spindrift file', async () => {
    const fake = new FakeGitHub();
    const adopted = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const repository = await alreadyAdopted(fake, adopted);
    const loop = await context(fake);
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'pushed',
    });

    await reconcileRepository(loop, await reload(repository.id), {
      adopt: false,
    });

    // Scope file reads are most of what a listing costs, and a pass that will
    // not adopt has no use for them.
    expect(scopeFileReads(fake)).toEqual([]);

    // The adopting pass does read the scope, so the fixture is not bare.
    await reconcileRepository(loop, await reload(repository.id));
    expect(
      scopeFileReads(fake).map((request) => request.path.split('?')[0]),
    ).toContain('/repos/example/app/contents/services/api/spindrift.yaml');
  });
});

describe('claiming a transition exactly once', () => {
  test('two passes observing the same new commit adopt it once', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    const pushed = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'pushed',
    });
    // The webhook and poll passes each read the row before the branch, so the
    // loser holds this stale row. Passing it twice replays that race.
    const observed = await reload(repository.id);

    const winner = await reconcileRepository(loop, observed);
    const loser = await reconcileRepository(loop, observed);

    expect(winner).toMatchObject({ outcome: 'adopted', commit: pushed });
    // A second `adopted` would add a second Build, and its `commit#<millis>`
    // key keeps the unique index from collapsing it.
    expect(loser).toMatchObject({ outcome: 'unchanged', commit: pushed });
    expect((await reload(repository.id)).authoritativeCommit).toBe(pushed);
  });

  test('a repository adopting its very first commit still adopts', async () => {
    const fake = new FakeGitHub();
    const first = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    // With nothing adopted yet, the compare-and-swap matches a null column.
    const { repository } = await connect(fake);
    const loop = await context(fake);
    expect(repository.authoritativeCommit).toBeNull();

    const pass = await reconcileRepository(loop, repository);

    expect(pass).toMatchObject({ outcome: 'adopted', commit: first });
    expect((await reload(repository.id)).authoritativeCommit).toBe(first);

    // A concurrent pass holding the same pre-adoption row loses the swap.
    const loser = await reconcileRepository(loop, repository);
    expect(loser).toMatchObject({ outcome: 'unchanged', commit: first });
  });
});

describe('an unmerged configuration pull request', () => {
  test('changes nothing', async () => {
    const fake = new FakeGitHub();
    const base = fake.commitFiles('main', { 'README.md': 'unconnected' });
    const { repository } = await connect(fake);
    const github = await host(fake);

    const opened = await openConfigurationPullRequest(
      github,
      { installationId: fake.installationId },
      {
        fullName: fake.fullName,
        defaultBranch: 'main',
        transaction: configurationTransaction({
          scopes: [{ scope: 'services/api', proposal }],
          buildWorkflow: BUILD_WORKFLOW,
        }),
      },
    );
    expect(fake.pulls).toHaveLength(1);

    const pass = await reconcileRepository(
      { db: database().db, clock, host: github },
      repository,
    );

    // Only the PR branch has the scope file, so the default branch adopts the
    // scope as absent.
    expect(pass.outcome).toBe('adopted');
    expect(pass.outcome === 'adopted' && pass.scopes[0]?.outcome).toBe(
      'absent',
    );
    const row = await reload(repository.id);
    expect(row.authoritativeCommit).toBe(base);
    expect(row.authoritativeCommit).not.toBe(opened.commit);
  });

  test('becomes authoritative only once it is on the default branch', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    // A merge moves the default branch, the only authoritative act.
    const merged = fake.commitFiles('main', {
      'README.md': 'unconnected',
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass.outcome === 'adopted' && pass.scopes[0]?.outcome).toBe(
      'adopted',
    );
    expect((await reload(repository.id)).authoritativeCommit).toBe(merged);
  });
});

/**
 * Each pass checks a recorded configuration pull request, so one closed
 * unmerged is cleared even though the branch never moves.
 */
describe('a closed configuration pull request', () => {
  /** A connected repository past its first reconcile, with an open PR on it. */
  async function withOpenPullRequest(fake: FakeGitHub) {
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    // After the first adoption the branch does not move again.
    await reconcileRepository(loop, repository);

    const github = await host(fake);
    const opened = await openConfigurationPullRequest(
      github,
      { installationId: fake.installationId },
      {
        fullName: fake.fullName,
        defaultBranch: 'main',
        transaction: configurationTransaction({
          scopes: [{ scope: 'services/api', proposal }],
          buildWorkflow: BUILD_WORKFLOW,
        }),
      },
    );
    await database()
      .db.update(repositories)
      .set({ configPullRequest: opened.number })
      .where(eq(repositories.id, repository.id));

    return { loop, repository, number: opened.number };
  }

  test('clears the column once it closes unmerged', async () => {
    const fake = new FakeGitHub();
    const { loop, repository, number } = await withOpenPullRequest(fake);
    fake.closePullRequest(number);

    const pass = await reconcileRepository(loop, await reload(repository.id));

    // The branch never moved, so only the pull request check clears it.
    expect(pass.outcome).toBe('unchanged');
    expect((await reload(repository.id)).configPullRequest).toBeNull();
  });

  test('keeps naming a pull request that is still open', async () => {
    const fake = new FakeGitHub();
    const { loop, repository, number } = await withOpenPullRequest(fake);

    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass.outcome).toBe('unchanged');
    expect((await reload(repository.id)).configPullRequest).toBe(number);
  });

  test('tolerates a deleted pull request as closed', async () => {
    const fake = new FakeGitHub();
    const { loop, repository } = await withOpenPullRequest(fake);
    // The fake has no delete; an unknown number answers the same `404`.
    fake.pulls.length = 0;

    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass.outcome).toBe('unchanged');
    expect((await reload(repository.id)).configPullRequest).toBeNull();
  });
});

describe('losing access', () => {
  async function snapshot() {
    const db = database().db;
    return {
      apps: await db.select().from(apps),
      components: await db.select().from(components),
      builds: await db.select().from(builds),
      deploys: await db.select().from(deploys),
    };
  }

  test('freezes the repository and leaves every Deploy intact', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository, app } = await connect(fake);
    await liveDeploy(app.id);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    const before = await snapshot();
    fake.accessLost = true;
    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass).toMatchObject({ outcome: 'frozen' });
    const row = await reload(repository.id);
    expect(row.access).toBe('frozen');
    expect(row.frozenReason).toContain('no longer read this repository');
    expect(row.frozenAt).toEqual(NOW);
    // Source-driven changes stop; nothing that is running is touched.
    expect(await snapshot()).toEqual(before);
    // The last known-good configuration still governs.
    expect(row.authoritativeCommit).not.toBeNull();
  });

  test('a rate limit is a delay, not a freeze', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    fake.rateLimited = true;

    const pass = await reconcileRepository(loop, repository);

    expect(pass.outcome).toBe('unavailable');
    expect((await reload(repository.id)).access).toBe('active');
  });

  test('a later pass that can read again clears the freeze', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    fake.accessLost = true;
    await reconcileRepository(loop, repository);
    expect((await reload(repository.id)).access).toBe('frozen');

    fake.accessLost = false;
    const pass = await reconcileRepository(loop, await reload(repository.id));

    expect(pass).toMatchObject({ outcome: 'adopted', thawed: true, commit });
    const row = await reload(repository.id);
    expect(row.access).toBe('active');
    expect(row.frozenReason).toBeNull();
  });

  test('a frozen repository is still visited by the loop', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    fake.accessLost = true;
    await reconcileRepository(loop, repository);

    fake.accessLost = false;
    const passes = await reconcileAllRepositories(loop);

    // Skipping frozen repositories would make a freeze permanent.
    expect(passes).toHaveLength(1);
    expect((await reload(repository.id)).access).toBe('active');
  });
});

describe('a verified webhook delivery', () => {
  test('a default-branch push reconciles that repository now', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);

    const passes = await applyWebhookDelivery(await context(fake), {
      kind: 'push',
      repository: fake.fullName,
      ref: 'refs/heads/main',
      defaultBranch: 'main',
      head: commit,
    });

    expect(passes).toHaveLength(1);
    expect((await reload(repository.id)).authoritativeCommit).toBe(commit);
  });

  test('a push to any other ref does nothing at all', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    const loop = await context(fake);

    const passes = await applyWebhookDelivery(loop, {
      kind: 'push',
      repository: fake.fullName,
      ref: 'refs/heads/spindrift/configure',
      defaultBranch: 'main',
      head: '2222222222222222222222222222222222222222',
    });

    expect(passes).toEqual([]);
    expect((await reload(repository.id)).authoritativeCommit).toBeNull();
    // No call at all: the default branch cannot have moved.
    expect(fake.requests).toEqual([]);
  });

  test('a push naming a repository nobody connected does nothing', async () => {
    const fake = new FakeGitHub();
    const loop = await context(fake);

    expect(
      await applyWebhookDelivery(loop, {
        kind: 'push',
        repository: 'example/unconnected',
        ref: 'refs/heads/main',
        defaultBranch: 'main',
        head: '3333333333333333333333333333333333333333',
      }),
    ).toEqual([]);
  });

  test('a deleted installation freezes every repository it reached', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository, app } = await connect(fake);
    await liveDeploy(app.id);
    const loop = await context(fake);

    const passes = await applyWebhookDelivery(loop, {
      kind: 'accessLost',
      installationId: fake.installationId,
      repositories: [],
      detail: 'the GitHub App installation was deleted',
    });

    expect(passes).toHaveLength(1);
    const row = await reload(repository.id);
    expect(row.access).toBe('frozen');
    expect(row.frozenReason).toBe('the GitHub App installation was deleted');
    expect(await database().db.select().from(deploys)).toHaveLength(1);
  });

  test('restored access is confirmed by a read, not taken at its word', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    fake.accessLost = true;
    await reconcileRepository(loop, repository);

    // The delivery says access is back while the far side still refuses.
    const passes = await applyWebhookDelivery(loop, {
      kind: 'accessRestored',
      installationId: fake.installationId,
      repositories: [fake.fullName],
    });

    expect(passes[0]?.outcome).toBe('frozen');
    expect((await reload(repository.id)).access).toBe('frozen');
  });

  test('an ignored delivery is not a database round trip', async () => {
    const fake = new FakeGitHub();
    expect(
      await applyWebhookDelivery(await context(fake), {
        kind: 'ignored',
        reason: 'ping is not subscribed to',
      }),
    ).toEqual([]);
  });
});

/**
 * The host keeps answering a renamed repository's old name while deliveries
 * arrive under the new one, so the poll follows the rename.
 */
describe('a renamed repository', () => {
  test('the poll follows the rename, and a delivery under the new name then matches', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository, app } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    fake.rename('example/renamed');
    const pushed = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'pushed',
    });
    const delivery = {
      kind: 'push' as const,
      repository: 'example/renamed',
      ref: 'refs/heads/main',
      defaultBranch: 'main',
      head: pushed,
    };

    // Until the poll looks, the delivery matches no row, and the poll adopts
    // the same commit.
    expect(await applyWebhookDelivery(loop, delivery)).toEqual([]);

    const [poll] = await reconcileAllRepositories(loop);
    expect(poll).toMatchObject({
      outcome: 'adopted',
      commit: pushed,
      fullName: 'example/renamed',
    });
    expect((await reload(repository.id)).fullName).toBe('example/renamed');
    // The App's own source URL names the repository too, and screens read it.
    const [renamedApp] = await database()
      .db.select({ url: apps.sourceRepoUrl })
      .from(apps)
      .where(eq(apps.id, app.id));
    expect(renamedApp?.url).toBe('https://git.invalid/example/renamed');

    const again = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'again',
    });
    const passes = await applyWebhookDelivery(loop, {
      ...delivery,
      head: again,
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ outcome: 'adopted', commit: again });
  });

  test('a rename with nothing pushed still rewrites the row', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    fake.rename('example/renamed');
    const pass = await reconcileRepository(loop, await reload(repository.id));

    // An `unchanged` pass still follows the rename.
    expect(pass).toMatchObject({
      outcome: 'unchanged',
      fullName: 'example/renamed',
    });
    expect((await reload(repository.id)).fullName).toBe('example/renamed');
  });

  test('a rename onto a name another row holds is not followed, and every other pass still runs', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'hello' });
    const { repository } = await connect(fake);
    // The new name, connected before this poll looked.
    await database().db.insert(repositories).values({
      fullName: 'example/renamed',
      installationId: fake.installationId,
      defaultBranch: fake.defaultBranch,
    });
    const loop = await context(fake);
    await reconcileRepository(loop, repository);

    fake.rename('example/renamed');
    const passes = await reconcileAllRepositories(loop);

    // `full_name` is unique, so the rename cannot land; the pass keeps the
    // stored name and the other passes still run.
    expect(passes).toHaveLength(2);
    expect(
      passes.find((pass) => pass.repositoryId === repository.id),
    ).toMatchObject({ outcome: 'unchanged', fullName: 'example/app' });
    expect((await reload(repository.id)).fullName).toBe('example/app');
  });
});

/** Every default-branch ref read the client made, one per pass. */
function refReads(fake: FakeGitHub) {
  return fake.requests.filter((request) =>
    request.path.endsWith('/git/ref/heads/main'),
  );
}

/**
 * A push delivery can arrive before its ref is readable, so a pass that misses
 * the delivered commit waits once and re-reads once.
 */
describe('a push the API has not caught up to', () => {
  /** A repository at `adopted` whose ref does not show `pushed` yet. */
  async function lagged(fake: FakeGitHub) {
    const adopted = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    const { repository } = await connect(fake);
    await reconcileRepository(await context(fake), repository);
    const pushed = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'README.md': 'pushed',
    });
    fake.setHead('main', adopted);
    fake.requests.length = 0;
    const waits: number[] = [];
    return {
      repository,
      pushed,
      waits,
      delivery: {
        kind: 'push' as const,
        repository: fake.fullName,
        ref: 'refs/heads/main',
        defaultBranch: 'main',
        head: pushed,
      },
      /** Records each wait, during which the far side catches up. */
      loop: (catchUp: () => void): RepoLoopContext => ({
        db: database().db,
        clock,
        host: host(fake),
        sleep: async (ms) => {
          waits.push(ms);
          catchUp();
        },
      }),
    };
  }

  test('waits once, re-reads, and carries the delivered commit', async () => {
    const fake = new FakeGitHub();
    const { repository, pushed, waits, delivery, loop } = await lagged(fake);

    const passes = await applyWebhookDelivery(
      loop(() => fake.setHead('main', pushed)),
      delivery,
    );

    expect(waits).toEqual([PUSH_LAG_RETRY_MS]);
    expect(refReads(fake)).toHaveLength(2);
    // Both passes are returned, so a first pass that adopted something is kept.
    expect(passes.map((pass) => pass.outcome)).toEqual([
      'unchanged',
      'adopted',
    ]);
    expect(passes[1]).toMatchObject({ outcome: 'adopted', commit: pushed });
    expect((await reload(repository.id)).authoritativeCommit).toBe(pushed);
  });

  test('a far side still behind after the wait is left to the poll', async () => {
    const fake = new FakeGitHub();
    const { repository, pushed, waits, delivery, loop } = await lagged(fake);

    const passes = await applyWebhookDelivery(
      loop(() => {}),
      delivery,
    );

    expect(waits).toEqual([PUSH_LAG_RETRY_MS]);
    expect(refReads(fake)).toHaveLength(2);
    expect(passes.map((pass) => pass.outcome)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect((await reload(repository.id)).authoritativeCommit).not.toBe(pushed);
  });

  test('a delivery matched on the first read never re-reads', async () => {
    const fake = new FakeGitHub();
    const { pushed, waits, delivery, loop } = await lagged(fake);
    fake.setHead('main', pushed);

    const passes = await applyWebhookDelivery(
      loop(() => {
        throw new Error('the far side was never behind');
      }),
      delivery,
    );

    expect(waits).toEqual([]);
    expect(refReads(fake)).toHaveLength(1);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ outcome: 'adopted', commit: pushed });
  });

  test('a frozen pass never re-reads', async () => {
    const fake = new FakeGitHub();
    const { waits, delivery, loop } = await lagged(fake);
    fake.accessLost = true;

    const passes = await applyWebhookDelivery(
      loop(() => {}),
      delivery,
    );

    expect(waits).toEqual([]);
    expect(passes.map((pass) => pass.outcome)).toEqual(['frozen']);
  });

  test('an unavailable pass never re-reads', async () => {
    const fake = new FakeGitHub();
    const { waits, delivery, loop } = await lagged(fake);
    fake.rateLimited = true;

    const passes = await applyWebhookDelivery(
      loop(() => {}),
      delivery,
    );

    // Retrying into a rate limit would only spend more of the quota.
    expect(waits).toEqual([]);
    expect(passes.map((pass) => pass.outcome)).toEqual(['unavailable']);
  });
});
