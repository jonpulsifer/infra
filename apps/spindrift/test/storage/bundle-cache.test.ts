/**
 * The commit → bundle index, over real Postgres and a faked depot
 * (`src/storage/bundle-cache.ts`).
 *
 * One claim carries the whole design: **a hit is only ever returned after the
 * depot confirmed the object**. Every way that confirmation can fail to arrive
 * has to come back as a miss rather than as a throw, because the fall-through
 * is the fetch that used to happen unconditionally — a cache is allowed to be
 * cold and is not allowed to fail a deploy.
 */
import { describe, expect, test } from 'bun:test';
import type { SourceDepot } from '../../src/storage/archives.ts';
import {
  cachedBundle,
  rememberBundle,
} from '../../src/storage/bundle-cache.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

const REPOSITORY = 'jonpulsifer/infra';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = 'sha256:beef';
const BUCKET = 'bluenose-spindrift-source';
const OBJECT = 'ephemeral/beef.tgz';
const LOCATION = `gs://${BUCKET}/${OBJECT}`;
const STAGED_AT = new Date('2026-08-22T00:00:00.000Z');

const BUNDLE = {
  digest: DIGEST,
  location: LOCATION,
  retention: 'ephemeral' as const,
};

/**
 * A depot whose object metadata endpoint answers however the test says.
 *
 * Requests are recorded so "the hit was verified" is an assertion about a call
 * that happened, not an inference from the value that came back.
 */
function depotFor(
  answer: (url: string) => Response,
  bucket = BUCKET,
): { depot: SourceDepot; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    depot: {
      bucket,
      federation: {
        audience: '//iam.googleapis.com/projects/1/locations/global/x/y',
        tokenUrl: 'https://sts.example/token',
        tokenPath: '/tmp/fake-token',
        impersonationUrl: null,
        readToken: async () => 'projected-jwt',
        fetch: async (request: Request) => {
          if (request.url.includes('sts.example')) {
            return new Response(
              JSON.stringify({ access_token: 'gcs', expires_in: 3600 }),
            );
          }
          reads.push(request.url);
          return answer(request.url);
        },
      },
    },
  };
}

const present = () => depotFor(() => new Response('{"name":"x"}'));
const expired = () =>
  depotFor(() => new Response('no such object', { status: 404 }));

describe('cachedBundle', () => {
  test('a commit nothing staged is a miss, and the depot is never asked', async () => {
    const { depot, reads } = present();

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toBeNull();
    expect(reads).toEqual([]);
  });

  test('a remembered bundle the depot still holds comes back', async () => {
    const { depot, reads } = present();
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toEqual(BUNDLE);
    // Escaped as one path segment, so the slash in the prefix is not a
    // separator the JSON API would read as a different object.
    expect(reads).toEqual([
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/ephemeral%2Fbeef.tgz?fields=name`,
    ]);
  });

  test('a bundle the lifecycle rule expired is a miss, not a dead location', async () => {
    // The founding defect wearing its newest scheme: handing back a `gs://`
    // address whose object is gone dies at `curl` inside a runner log.
    const { depot } = expired();
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toBeNull();
  });

  test('a row naming another bucket is a miss', async () => {
    // An installation that moved `sources.buckets` has rows pointing outside
    // the bucket its manifest says it stages to (§20).
    const { depot, reads } = depotFor(
      () => new Response('{"name":"x"}'),
      'some-other-bucket',
    );
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toBeNull();
    expect(reads).toEqual([]);
  });

  test('a depot having a bad minute is a miss rather than a failed deploy', async () => {
    const { depot } = depotFor(
      () => new Response('permission denied', { status: 403 }),
    );
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toBeNull();
  });

  test('the key is the pair — a sibling commit does not answer for this one', async () => {
    const { depot } = present();
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, `${COMMIT}0`),
    ).toBeNull();
    expect(
      await cachedBundle(database().db, depot, 'jonpulsifer/other', COMMIT),
    ).toBeNull();
  });
});

describe('rememberBundle', () => {
  test('re-staging the same commit updates the row rather than colliding', async () => {
    const { depot } = present();
    await rememberBundle(database().db, REPOSITORY, COMMIT, BUNDLE, STAGED_AT);

    const later = new Date('2026-09-30T00:00:00.000Z');
    const restaged = {
      ...BUNDLE,
      location: `gs://${BUCKET}/ephemeral/beef.tgz`,
    };
    await rememberBundle(database().db, REPOSITORY, COMMIT, restaged, later);

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toEqual(restaged);
  });

  test('a hit carries what the fetch knew of the commit, so a sibling App gets the same headline', async () => {
    const { depot } = present();
    const headlined = {
      ...BUNDLE,
      commit: {
        message: 'feat: one push, many Apps',
        author: 'octocat',
        authoredAt: new Date('2026-08-21T08:00:00.000Z'),
      },
    };
    await rememberBundle(
      database().db,
      REPOSITORY,
      COMMIT,
      headlined,
      STAGED_AT,
    );

    expect(
      await cachedBundle(database().db, depot, REPOSITORY, COMMIT),
    ).toEqual(headlined);
  });
});
