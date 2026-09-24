/**
 * The default source stager as `createAdapterRegistry` wires it. It consults
 * the bundle index before fetching, so one push that fans out to several Apps
 * fetches the commit once.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { FederationOptions } from '@repo/archive/federation';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import { parseManifest, resolveManifest } from '../../src/config/manifest.ts';
import type { CommitHeadline } from '../../src/domain/source-bundle.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeGitHub, testAppKey } from '../harness/fakes/github-api.ts';

const database = withIsolatedDatabase();

/** The fixture installation's home-vessel `sourceBucket`. */
const BUCKET = 'example-source-bucket';

interface Depot {
  /** Stored object sizes in bytes, by name. */
  readonly objects: Map<string, number>;
  /** Object-metadata reads, made when the index already has the commit. */
  readonly reads: string[];
  /** Uploads, spent only on a miss. */
  readonly writes: string[];
}

/**
 * The depot's `fetch` goes through the manifest's federation, the only path
 * `sourceDepotFor` reaches the bucket by.
 */
async function stagerAgainst(fake: FakeGitHub): Promise<{
  stage: (commit: string) => Promise<{
    digest: string;
    location: string;
    commit: CommitHeadline | undefined;
  }>;
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
  // A typed variable, since an object literal carrying `readToken` and `fetch`
  // would fail the manifest's excess-property check.
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
      return {
        digest: bundle.digest,
        location: bundle.location,
        commit: bundle.commit,
      };
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
    // The bucket's lifecycle rule expires objects under `ephemeral/`.
    expect(bundle.location).toBe(`gs://${BUCKET}/${object}`);
    // Then the source receipt, durable and named by its own digest.
    expect(depot.writes).toEqual([object, expect.stringMatching(/\.json$/)]);
  });

  test('the same commit staged again costs one metadata read, not a fetch', async () => {
    const fake = new FakeGitHub();
    const commit = fake.commitFiles(
      'main',
      { 'README.md': 'hello' },
      {
        message: 'feat(web): stop the header wrapping\n\nAnd a body.',
        authorLogin: 'octocat',
        authoredAt: '2026-07-27T09:30:00.000Z',
      },
    );
    const { stage, depot } = await stagerAgainst(fake);

    const first = await stage(commit);
    const writesAfterFirst = depot.writes.length;
    const second = await stage(commit);

    expect(first.commit).toEqual({
      message: 'feat(web): stop the header wrapping',
      author: 'octocat',
      authoredAt: new Date('2026-07-27T09:30:00.000Z'),
    });
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
    // The lifecycle rule deletes `ephemeral/` objects but leaves the index row.
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
