/**
 * The default source stager, wired the way `createAdapterRegistry` wires it.
 *
 * `test/storage/bundle-cache.test.ts` proves the index answers correctly;
 * this proves the stager *asks* it, and asks it before spending a fetch. That
 * is the whole claim of the change: §15 stages "the exact commit once", and
 * one push to a repository hosting several Apps used to fetch the same tarball
 * once per App, because `dispatchAutoDeploys` calls `deployApp` per App and
 * nothing between those calls remembered the commit.
 *
 * Both far sides are faked and both are counted — the repository host through
 * {@link FakeGitHub}, the depot through the federation's own `fetch` seam.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { FederationOptions } from '../../src/adapters/deploy/cloud/federation.ts';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import { parseManifest, resolveManifest } from '../../src/config/manifest.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub, testAppKey } from '../harness/fakes/github-api.ts';

const database = withIsolatedDatabase();

/** The bucket `test/fixtures/installation.example.yaml`'s home vessel declares. */
const BUCKET = 'example-source-bucket';

interface Depot {
  /** Objects the depot holds, by name, as the fake stored them. */
  readonly objects: Map<string, number>;
  /** Every object-metadata read, which is what a cache hit costs. */
  readonly reads: string[];
  /** Every upload, which is what a miss costs. */
  readonly writes: string[];
}

/**
 * A registry whose GitHub is `fake` and whose depot is an in-memory bucket.
 *
 * The manifest's federation carries the depot's `fetch`, because that is the
 * only seam `sourceDepotFor` reaches the far side through — `RegistryOptions`
 * has no separate one, and inventing one for a test would be a production
 * shape written for a test's convenience.
 */
async function stagerAgainst(fake: FakeGitHub): Promise<{
  stage: (commit: string) => Promise<{ digest: string; location: string }>;
  depot: Depot;
}> {
  const objects = new Map<string, number>();
  const reads: string[] = [];
  const writes: string[] = [];

  const depotFetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname === 'sts.example.test') {
      return new Response(
        JSON.stringify({ access_token: 'depot', expires_in: 3600 }),
      );
    }
    if (url.pathname.startsWith('/upload/storage/v1/b/')) {
      const name = url.searchParams.get('name') ?? '';
      writes.push(name);
      objects.set(name, (await request.arrayBuffer()).byteLength);
      return new Response(JSON.stringify({ name }));
    }
    const read = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
    if (read) {
      const name = decodeURIComponent(read[1] as string);
      reads.push(name);
      return objects.has(name)
        ? new Response(JSON.stringify({ name }))
        : new Response('no such object', { status: 404 });
    }
    return new Response('unexpected', { status: 500 });
  };

  const yaml = await Bun.file(
    join(import.meta.dir, '../fixtures/installation.example.yaml'),
  ).text();
  const base = await resolveManifest(parseManifest(yaml, 'test'), {});
  // `InstallationManifest` declares the config half only, so the two injection
  // seams `FederationOptions` adds are carried in a value the manifest widens
  // to rather than an object literal it would reject.
  const federation: FederationOptions = {
    audience: '//iam.googleapis.com/projects/1/locations/global/p/x',
    tokenUrl: 'https://sts.example.test/token',
    tokenPath: '/tmp/spindrift-fake-token',
    impersonationUrl: null,
    readToken: async () => 'projected-jwt',
    fetch: depotFetch,
  };
  const manifest: InstallationManifest = { ...base, cloud: { federation } };

  const { pem } = await testAppKey('pkcs1');
  const registry = createAdapterRegistry({
    manifest,
    db: database().db,
    env: {
      SPINDRIFT_GITHUB_APP_ID: '4576122',
      SPINDRIFT_GITHUB_APP_PRIVATE_KEY: pem,
    },
    fetch: fake.fetch,
  });

  const stager = registry.source?.();
  if (!stager) throw new Error('the registry wired no source stager');

  return {
    depot: { objects, reads, writes },
    stage: async (commit: string) => {
      const bundle = await stager.stageRepository({
        ref: { installationId: fake.installationId },
        repository: fake.fullName,
        commit,
        stagedAt: new Date('2026-08-22T00:00:00.000Z'),
      });
      return { digest: bundle.digest, location: bundle.location };
    },
  };
}

describe('the default source stager', () => {
  test('stages a commit into the depot under the ephemeral prefix', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { stage, depot } = await stagerAgainst(fake);

    const bundle = await stage(commit);
    const object = `ephemeral/${bundle.digest.replace('sha256:', '')}.tgz`;

    expect(fake.tarballs).toEqual([commit]);
    // Content-addressed and under the prefix the bucket's lifecycle rule
    // matches — the two facts that make re-staging idempotent and expirable.
    expect(bundle.location).toBe(`gs://${BUCKET}/${object}`);
    // The bundle, then its source receipt — durable, and named by its own
    // bytes rather than by the bundle's.
    expect(depot.writes).toEqual([object, expect.stringMatching(/\.json$/)]);
  });

  test('the same commit staged again costs one metadata read, not a fetch', async () => {
    // §15's "once", across the Apps a single push fans out to.
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { stage, depot } = await stagerAgainst(fake);

    const first = await stage(commit);
    const writesAfterFirst = depot.writes.length;
    const second = await stage(commit);

    expect(second).toEqual(first);
    expect(fake.tarballs).toEqual([commit]);
    expect(depot.writes.length).toBe(writesAfterFirst);
    expect(depot.reads).toEqual([
      `ephemeral/${first.digest.replace('sha256:', '')}.tgz`,
    ]);
  });

  test('a second commit is fetched — the index is keyed, not a latch', async () => {
    const fake = new FakeGitHub();
    const first = fake.commitFiles('main', { 'README.md': 'hello' });
    const second = fake.commitFiles('main', { 'README.md': 'goodbye' });
    const { stage } = await stagerAgainst(fake);

    const one = await stage(first);
    const two = await stage(second);

    expect(fake.tarballs).toEqual([first, second]);
    expect(one.digest).not.toBe(two.digest);
  });

  test('a bundle the depot no longer holds is staged again', async () => {
    // What the bucket's 30-day `ephemeral/` lifecycle rule does to a bundle
    // nothing has rebuilt. The row survives it; the object does not, and the
    // stager must notice rather than hand a builder a dead `gs://` address.
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });
    const { stage, depot } = await stagerAgainst(fake);

    const first = await stage(commit);
    depot.objects.clear();
    const second = await stage(commit);

    expect(second).toEqual(first);
    expect(fake.tarballs).toEqual([commit, commit]);
  });
});
