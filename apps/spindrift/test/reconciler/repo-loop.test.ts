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

/** A live Deploy, so "never destroys a Deploy" has something to be about. */
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

/** Every Spindrift-file read the client made, which `adopt: false` skips. */
function scopeFileReads(fake: FakeGitHub) {
  return fake.requests.filter((request) => request.path.includes('/contents/'));
}

/**
 * A repository that has already adopted a commit and has not been looked at
 * since, wearing a default-branch name the far side has moved on from — the
 * three columns the refresh half of a pass owns, all visibly stale, so that
 * "was refreshed" is an assertion rather than a coincidence of the frozen clock.
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

    // `behind` rather than `unchanged`: there is a commit waiting, and saying
    // so is the difference between a screen that can render "one push behind"
    // and one that cannot tell that state from nothing having happened.
    expect(read).toMatchObject({ outcome: 'behind', commit: pushed, adopted });
    const row = await reload(repository.id);
    // The transition itself is untouched…
    expect(row.authoritativeCommit).toBe(adopted);
    // …while the facts a screen actually came for are current.
    expect(row.defaultBranch).toBe('main');
    expect(row.reconciledAt).toEqual(NOW);

    // The point of the whole option: the push is still there to be claimed. A
    // read that advanced the cursor would have cancelled it for good — nothing
    // dispatches a `behind`, and every later pass would see `head ===
    // authoritativeCommit` and report `unchanged`.
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

    // Not an optimisation detail: reading every scope of every repository is
    // most of what a listing costs, and a pass that is not going to adopt has
    // nothing to do with what those files say.
    expect(scopeFileReads(fake)).toEqual([]);

    // And the scope is genuinely there — the adopting pass reads it — so the
    // empty list above is the option working rather than the fixture being bare.
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
    // This row is not a simulation of the race — it *is* the race. The webhook
    // pass and the poll pass each `SELECT` the repository before they read the
    // branch, so the loser is holding exactly this: a row whose
    // `authoritativeCommit` is the predecessor, read before the winner wrote.
    // Passing it twice replays that interleaving without threads.
    const observed = await reload(repository.id);

    const winner = await reconcileRepository(loop, observed);
    const loser = await reconcileRepository(loop, observed);

    expect(winner).toMatchObject({ outcome: 'adopted', commit: pushed });
    // `unchanged`, not `adopted`: the winner is dispatching this commit, and a
    // second `adopted` would put a second Build on it — which since ticket 131
    // is keyed `commit#<millis>` and so cannot be collapsed by the unique index.
    expect(loser).toMatchObject({ outcome: 'unchanged', commit: pushed });
    expect((await reload(repository.id)).authoritativeCommit).toBe(pushed);
  });

  test('a repository adopting its very first commit still adopts', async () => {
    const fake = new FakeGitHub();
    const first = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
    });
    // Nothing adopted yet, so the compare-and-swap has no predecessor to name
    // and swaps on the column still being null instead. That is a different
    // `WHERE` from every other adoption, and it is the one every repository
    // takes exactly once.
    const { repository } = await connect(fake);
    const loop = await context(fake);
    expect(repository.authoritativeCommit).toBeNull();

    const pass = await reconcileRepository(loop, repository);

    expect(pass).toMatchObject({ outcome: 'adopted', commit: first });
    expect((await reload(repository.id)).authoritativeCommit).toBe(first);

    // And the null arm is a real condition rather than an unconditional write:
    // a concurrent pass holding the same pre-adoption row loses it too.
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

/**
 * `configPullRequest` is written once, when the configuration transaction
 * opens the pull request, and otherwise trusted — merging clears it (above),
 * but nothing used to ask again once it did not. A pull request closed
 * without merging left the column claiming "still open" forever, because the
 * one pass that would have noticed is exactly the one where the branch never
 * moves and every other read here reports `unchanged` (ticket 136).
 */
describe('a closed configuration pull request', () => {
  /** A connected repository past its first reconcile, with an open PR on it. */
  async function withOpenPullRequest(fake: FakeGitHub) {
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const { repository } = await connect(fake);
    const loop = await context(fake);
    // The first pass adopts the repository's very first commit, exactly as
    // every connected repository does — leaving a second pass with nothing on
    // the branch left to notice.
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

    // The branch never moved, so this is the exact pass that used to leave
    // the column stuck claiming a merge was still possible.
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
    // Nothing about the fake models a delete; standing in for one is simply a
    // number the far side no longer has an answer for — the same `404` a
    // pull request's own deletion answers with.
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
