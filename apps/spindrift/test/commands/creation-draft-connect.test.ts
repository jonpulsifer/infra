/**
 * Deploying from a repository Spindrift has not connected yet (§15, story 24).
 *
 * The creation flow lists every repository the GitHub App installation grants,
 * not only the ones with rows, and selecting one is a **read**:
 * `inspectRepository` writes nothing, so browsing five repositories leaves five
 * of nothing behind. That is the promise the draft itself makes on screen —
 * "Nothing has been created. This draft is kept." — and a wizard that opened a
 * configuration pull request per repository somebody looked at would leave a
 * trail of PRs for Apps that never existed.
 *
 * So the connect happens inside the one committing act. Pressing Deploy writes
 * the `repositories` row and opens §15's one configuration pull request, and it
 * does it through `connectRepository` rather than through a second way of
 * connecting a repository — the alternative is two acts that can disagree about
 * what connecting means.
 *
 * Both halves are asserted here, and the first one is the load-bearing one: an
 * abandoned draft leaves no row and no pull request.
 */
import { describe, expect, test } from 'bun:test';
import {
  completeCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from '../../src/commands/creation-drafts/lifecycle.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, repositories, targets, users } from '../../src/db/schema.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { CAPABLE_DISCOVERY } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const builder = new FakeBuildAdapter({ name: 'hosted' });
const supplyChain = new SupplyChainHarness();

/** A repository the operator has granted and Spindrift has never connected. */
function grantedRepository() {
  const fake = new FakeGitHub();
  fake.commitFiles('main', {
    'README.md': 'granted, unconnected',
    'go.mod': 'module example.com/app\n',
  });
  return fake;
}

async function context(fake: FakeGitHub): Promise<CommandContext> {
  const [principal] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const host = new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-installation-token',
    appAuthorization: () => 'Bearer test-app-jwt',
    fetch: fake.fetch,
  });
  const adapters: AdapterRegistry = {
    deploy: (adapter) => ({
      adapter,
      artifactTypes: ['image'],
      apply: async function* () {
        yield {
          type: 'status',
          at: new Date('2026-08-07T12:00:00.000Z'),
          phase: 'APPLYING',
        };
        return { phase: 'FAILED', reason: 'INTERNAL' };
      },
      observe: async () => null,
      destroy: async () => {},
      inspect: async () => {
        throw new Error('creation drafts do not inspect the far side');
      },
      tail: async () => ({
        kind: 'stream',
        entries: [],
        cursor: null,
        reach: 0,
      }),
      run: async () => ({ kind: 'none', because: 'nothing runs here' }),
      restart: async () => ({ kind: 'none', because: 'nothing runs here' }),
      executions: async () => ({ kind: 'none', because: 'nothing runs here' }),
    }),
    build: (name) => (name === builder.name ? builder : null),
    store: () => null,
    repository: () => host,
    source: () => ({
      async stageRepository(input) {
        return {
          digest: `sha256:${'b'.repeat(64)}`,
          location: `https://bundles.example.test/${input.commit}.tar.gz`,
          retention: 'ephemeral',
        };
      },
    }),
    supplyChain: () => supplyChain,
  };
  return {
    principal: { id: principal!.id, displayName: principal!.displayName },
    clock: { now: () => new Date('2026-08-07T12:00:00.000Z') },
    db: database().db,
    adapters,
    manifest: await fixtureManifest(),
  };
}

async function seedTarget() {
  const vessel = await insertVessel(database().db, 'kubernetes');
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        vesselId: vessel.id,
        rank: 1,
        reaches: ['none', 'private', 'public'],
        discovery: CAPABLE_DISCOVERY,
      }),
    )
    .returning();
  return target!;
}

/** A draft that deploys from the granted repository, saved and not completed. */
async function draftOn(fake: FakeGitHub, ctx: CommandContext) {
  const target = await seedTarget();
  const started = await startCreationDraft({}, ctx);
  if (!started.ok) throw new Error(started.failure.message);
  const saved = await saveCreationDraft(
    {
      id: started.value.id,
      revision: started.value.revision,
      draft: {
        ...started.value.draft,
        appName: 'granted',
        source: {
          kind: 'repo',
          repo: fake.fullName,
          url: `https://github.com/${fake.fullName}.git`,
          subpath: '.',
          connect: true,
        },
        targetId: target.id,
      },
    },
    ctx,
  );
  if (!saved.ok) throw new Error(saved.failure.message);
  return saved.value;
}

describe('a draft on a repository the grant offers', () => {
  test('is not blocked by the row it does not have yet', async () => {
    const fake = grantedRepository();
    const ctx = await context(fake);

    const draft = await draftOn(fake, ctx);

    expect(draft.blockers).toEqual([]);
    expect(draft.ready).toBe(true);
  });

  test('leaves no row and no pull request while it is abandoned', async () => {
    const fake = grantedRepository();
    const ctx = await context(fake);

    await draftOn(fake, ctx);

    expect(await database().db.select().from(repositories)).toEqual([]);
    expect(fake.pulls).toEqual([]);
  });

  test('connects the repository and opens the one PR when the App is created', async () => {
    const fake = grantedRepository();
    const ctx = await context(fake);
    const draft = await draftOn(fake, ctx);

    const completed = await completeCreationDraft(
      { id: draft.id, revision: draft.revision },
      ctx,
    );

    expect(completed.ok).toBe(true);
    if (!completed.ok || completed.value.app === null) {
      throw new Error('the App was not created');
    }
    // §15's transaction, opened once, by the same command the Repositories
    // screen presses.
    expect(fake.pulls).toHaveLength(1);
    const [row] = await database().db.select().from(repositories);
    expect(row).toMatchObject({
      fullName: fake.fullName,
      access: 'active',
      configPullRequest: 1,
    });
    // And the App is on that row rather than on a repository URL nothing
    // resolves to.
    const [app] = await database().db.select().from(apps);
    expect(app?.repositoryId).toBe(row!.id);
    expect(completed.value.app.buildStatus).toBe('PENDING');
  });

  test('a repository nothing can be built in refuses, and creates nothing', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'just prose' });
    const ctx = await context(fake);
    const draft = await draftOn(fake, ctx);

    const completed = await completeCreationDraft(
      { id: draft.id, revision: draft.revision },
      ctx,
    );

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.failure.message).toContain(
      'nothing it knows how to build',
    );
    expect(await database().db.select().from(repositories)).toEqual([]);
    expect(await database().db.select().from(apps)).toEqual([]);
    expect(fake.pulls).toEqual([]);
  });
});
