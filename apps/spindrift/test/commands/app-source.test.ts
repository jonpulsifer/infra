/**
 * What the Config tab says about where an App comes from (§5, §15).
 *
 * `getAppSource` is the read behind that card, and the three facts it has to
 * get right are the three an operator opens it for:
 *
 * - **The scope, not the repository root.** §5 makes a named directory the unit
 *   of detection, so an App scoped into `services/api` is asked about
 *   `services/api/spindrift.yaml` and nothing else.
 * - **At the adopted commit, never the branch head.** §15 makes
 *   `authoritative_commit` the configuration that is actually governing. A file
 *   pushed after it has not taken effect, and this read must not show it as
 *   though it had.
 * - **"Not there" and "could not look" are different answers.** A scope with no
 *   file is `absent`, which is detection's ordinary state; a repository that
 *   was never connected is `unread` with the reason on it.
 */
import { describe, expect, test } from 'bun:test';
import { getAppSource } from '../../src/commands/apps/source.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, repositories } from '../../src/db/schema.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const SPINDRIFT_YAML = ['version: 1', 'component:', '  kind: service', ''].join(
  '\n',
);

function context(fake: FakeGitHub | null): CommandContext {
  const host =
    fake === null
      ? null
      : new GitHubApp({
          baseUrl: fake.baseUrl,
          authorization: () => 'Bearer test-installation-token',
          appAuthorization: () => 'Bearer test-app-jwt',
          fetch: fake.fetch,
        });
  const adapters = {
    deploy: () => null,
    build: () => null,
    store: () => null,
    repository: () => host,
    supplyChain: () => null,
  } as unknown as AdapterRegistry;
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => new Date('2026-08-13T12:00:00.000Z') },
    db: database().db,
    adapters,
    manifest,
  };
}

/** One connected repository, one App scoped into it, adopted at `commit`. */
async function connectedApp(
  fake: FakeGitHub,
  commit: string | null,
  subpath: string | null,
): Promise<string> {
  const db = database().db;
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
      name: `invoices-${crypto.randomUUID().slice(0, 8)}`,
      sourceKind: 'repo',
      sourceRepoUrl: `https://github.com/${fake.fullName}`,
      sourceRepoSubpath: subpath,
      repositoryId: repository!.id,
    })
    .returning();
  return app!.name;
}

describe('getAppSource', () => {
  test('reads the scope’s spindrift.yaml at the adopted commit', async () => {
    const fake = new FakeGitHub();
    const adopted = fake.commitFiles('main', {
      'services/api/spindrift.yaml': SPINDRIFT_YAML,
      'services/api/Dockerfile': 'FROM scratch\n',
    });
    // A later commit that changes the file. Adoption has not reached it, so
    // this read must not see it.
    fake.commitFiles('main', {
      'services/api/spindrift.yaml': 'version: 1\ncomponent:\n  kind: job\n',
    });

    const name = await connectedApp(fake, adopted, 'services/api');
    const result = await getAppSource({ app: name }, context(fake));
    if (!result.ok) throw new Error(result.failure.message);
    const source = result.value.source;

    expect(source).not.toBeNull();
    expect(source?.repo).toBe(fake.fullName);
    expect(source?.branch).toBe('main');
    expect(source?.subpath).toBe('services/api');
    expect(source?.commit).toBe(adopted);
    expect(source?.manifest).toEqual({
      path: 'services/api/spindrift.yaml',
      state: 'present',
      text: SPINDRIFT_YAML,
    });
  });

  test('a scope with no file is absent, not a failed read', async () => {
    const fake = new FakeGitHub();
    const adopted = fake.commitFiles('main', {
      'services/api/Dockerfile': 'FROM scratch\n',
      // At the root, and therefore not this App's — the scope is what is read.
      'spindrift.yaml': SPINDRIFT_YAML,
    });

    const name = await connectedApp(fake, adopted, 'services/api');
    const result = await getAppSource({ app: name }, context(fake));
    if (!result.ok) throw new Error(result.failure.message);

    expect(result.value.source?.manifest).toEqual({
      path: 'services/api/spindrift.yaml',
      state: 'absent',
    });
  });

  test('an App with no connected repository says why nothing was read', async () => {
    const [app] = await database()
      .db.insert(apps)
      .values({
        name: `unconnected-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'repo',
        sourceRepoUrl: 'https://github.com/example/app',
      })
      .returning();

    const result = await getAppSource({ app: app!.name }, context(null));
    if (!result.ok) throw new Error(result.failure.message);
    const source = result.value.source;

    expect(source?.repo).toBe('https://github.com/example/app');
    expect(source?.branch).toBeNull();
    expect(source?.subpath).toBe('.');
    expect(source?.manifest.state).toBe('unread');
  });

  test('an archive App has no source to state', async () => {
    const [app] = await database()
      .db.insert(apps)
      .values({
        name: `uploaded-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'archive',
        sourceArchiveDigest: `sha256:${'c'.repeat(64)}`,
      })
      .returning();

    const result = await getAppSource({ app: app!.name }, context(null));
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.value.source).toBeNull();
  });
});
