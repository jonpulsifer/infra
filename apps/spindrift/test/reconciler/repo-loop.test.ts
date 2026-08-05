/**
 * The repository loop (Task 24, §15).
 *
 * Two of Task 24's three acceptance criteria live here, and both are stated as
 * facts about the database rather than about a return value:
 *
 * - **"An unmerged PR changes nothing."** The configuration pull request is
 *   opened on a branch, and the loop adopts only from the default branch. The
 *   test opens a real transaction through the real client against the fake API,
 *   then reconciles, and asserts that nothing was adopted — the same assertion
 *   whether the PR exists or not.
 * - **"Revoked access sets a frozen state with every Deploy intact."** The test
 *   snapshots every `apps`, `builds`, and `deploys` row, takes access away, and
 *   asserts the snapshot is byte-identical afterwards while the repository is
 *   frozen with a sentence on it.
 *
 * Everything runs against a real Postgres through the harness, because
 * "changes nothing" and "intact" are claims about rows and a fake would be
 * asserting them against itself.
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
  type RepoLoopContext,
  reconcileAllRepositories,
  reconcileRepository,
} from '../../src/reconciler/repo-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { targetValues } from '../harness/installation.ts';
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
    authorization: () => 'Bearer test-user-token',
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

/** A live Deploy, so "never destroys a Deploy" has something to be about. */
async function liveDeploy(appId: string) {
  const db = database().db;
  const [component] = await db
    .insert(components)
    .values({ appId, name: 'api', kind: 'service', expose: true })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(targetValues({ name: 'cluster', rank: 1 }))
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
          // The file that settled it, named — this is what the workspace shows
          // when it says where a Component's kind came from.
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
    // The previously adopted commit is still what governs: §15 makes the
    // repository's configuration one transaction, so half of it does not land.
    expect((await reload(repository.id)).authoritativeCommit).toBe(adopted);
  });
});

describe('an unmerged configuration pull request', () => {
  test('changes nothing', async () => {
    const fake = new FakeGitHub();
    const base = fake.commitFiles('main', { 'README.md': 'unconnected' });
    const { repository } = await connect(fake);
    const github = await host(fake);

    // The real client writes the real transaction to its own branch.
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

    // The branch the PR is on carries a Spindrift file. The default branch does
    // not, so the scope reconciles as absent and the adopted commit is the
    // default branch's — never the pull request's.
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

    // Merging is somebody moving the default branch, which is the only act §15
    // treats as authoritative.
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
    // And the last known-good configuration still governs.
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

    // A freeze is a state to recover from, so skipping frozen repositories
    // would make it permanent until somebody noticed by hand.
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
    // Not one call was made: reconciling would have read the default branch and
    // found nothing new, one round trip later.
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
    // Nothing else in the delivery path can reach a Deploy.
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
