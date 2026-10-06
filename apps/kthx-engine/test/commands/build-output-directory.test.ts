// A files build ships the directory the scope's kthx file names, read at the
// build's commit.
import { describe, expect, test } from 'bun:test';
import { dispatchBuild } from '../../src/commands/builds/dispatch.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const declaring = (outputDirectory: string) =>
  [
    'version: 1',
    'component:',
    '  kind: website',
    'build:',
    '  frontend: railpack',
    '  command: bun run build',
    `  outputDirectory: ${outputDirectory}`,
    'watchPaths:',
    '  - .',
    '',
  ].join('\n');

/** Dispatches a files build of `site` at a commit holding `files`. */
async function dispatchedOutputDirectory(
  files: Record<string, string>,
): Promise<string | null | undefined> {
  const db = database().db;
  const fake = new FakeGitHub();
  const commit = fake.commitFiles('main', files);

  const [repository] = await db
    .insert(repositories)
    .values({
      fullName: fake.fullName,
      installationId: fake.installationId,
      defaultBranch: fake.defaultBranch,
      authoritativeCommit: commit,
    })
    .returning();
  const [app] = await db
    .insert(apps)
    .values({
      name: 'shop',
      sourceKind: 'repo',
      sourceRepoUrl: fake.fullName,
      sourceRepoSubpath: 'site',
      repositoryId: repository!.id,
    })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'website', expose: true })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', { name: 'target-a' });
  await db.insert(targets).values(targetValues({ vesselId: vessel.id }));
  const digest = `sha256:${'1'.repeat(64)}`;
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit,
      targetShape: 'files',
      artifactType: 'files',
      bundleDigest: digest,
      bundleLocation: 'https://depot.example/bundles/site.zip',
      status: 'PENDING',
    })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ displayName: 'Operator' })
    .returning();

  const route = new FakeBuildAdapter({ name: 'hosted' });
  const host = new GitHubApp({
    baseUrl: fake.baseUrl,
    authorization: () => 'Bearer test-installation-token',
    appAuthorization: () => 'Bearer test-app-jwt',
    fetch: fake.fetch,
  });
  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: (name) => (name === route.name ? route : null),
    store: () => new FakeSecretStore(),
    repository: () => host,
    supplyChain: () => new SupplyChainHarness(),
  };
  const context: CommandContext = {
    principal: { id: user!.id, displayName: user!.displayName },
    clock: { now: () => new Date('2026-10-01T12:00:00.000Z') },
    db,
    adapters,
    manifest,
  };

  const result = await dispatchBuild(
    { buildId: build!.id, route: 'hosted' },
    context,
  );
  expect(result.ok).toBe(true);
  return route.built[0]?.spec.outputDirectory;
}

describe('a files build reads its output directory from the kthx file', () => {
  test('from kthx.yaml', async () => {
    expect(
      await dispatchedOutputDirectory({ 'site/kthx.yaml': declaring('dist') }),
    ).toBe('dist');
  });

  test('from a legacy spindrift.yaml when the scope has no kthx.yaml', async () => {
    expect(
      await dispatchedOutputDirectory({
        'site/spindrift.yaml': declaring('public'),
      }),
    ).toBe('public');
  });

  test('from kthx.yaml when the scope holds both', async () => {
    expect(
      await dispatchedOutputDirectory({
        'site/kthx.yaml': declaring('dist'),
        'site/spindrift.yaml': declaring('public'),
      }),
    ).toBe('dist');
  });

  test('as nothing when the scope declares nothing', async () => {
    expect(
      await dispatchedOutputDirectory({ 'site/package.json': '{}' }),
    ).toBeNull();
  });
});
