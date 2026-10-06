/**
 * Declaring the buckets sources are staged to. The bucket is checked before the
 * manifest is written, so a refused check leaves the manifest as it was.
 */
import { describe, expect, test } from 'bun:test';
import { listSourceBuckets } from '../../src/commands/storage/list-buckets.ts';
import { useSourceBucket } from '../../src/commands/storage/use-bucket.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { sharedServicesOf } from '../../src/config/manifest.schema.ts';
import {
  readStoredManifest,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { authoredFixture, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const NOW = new Date('2026-08-02T12:00:00.000Z');

/**
 * A fake GCP token exchange and bucket read. STS answers OAuth's `access_token`
 * and `iamcredentials` its own `accessToken`, as the real APIs do.
 */
function cloud(bucketStatus: number): typeof fetch {
  return (async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generateAccessToken')) {
      return Response.json({
        accessToken: 'impersonated',
        expireTime: '2099-01-01T00:00:00Z',
      });
    }
    if (url.includes('sts.')) {
      return Response.json({ access_token: 'federated', expires_in: 3600 });
    }
    if (url.includes('storage.googleapis.com')) {
      return bucketStatus === 200
        ? Response.json({ name: 'a bucket' })
        : new Response('no', { status: bucketStatus });
    }
    throw new Error(`the test far side was asked for ${url}`);
  }) as unknown as typeof fetch;
}

const adapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => {
    throw new Error('declaring a bucket reached the supply chain');
  },
};

async function context(bucketStatus = 200): Promise<CommandContext> {
  const base = await fixtureManifest();
  const manifest = {
    ...base,
    cloud: {
      ...base.cloud,
      federation: {
        audience: '//iam.example/pool',
        tokenUrl: 'https://sts.example/v1/token',
        tokenPath: '/var/run/secrets/token',
        impersonationUrl:
          'https://iamcredentials.example/v1/projects/-/serviceAccounts/c@p.iam.gserviceaccount.com:generateAccessToken',
        fetch: cloud(bucketStatus),
        readToken: async () => 'a-projected-token',
      },
    },
  } as CommandContext['manifest'];

  // Stored as authored, since the schema refuses the resolved federation.
  await writeStoredManifest(database().db, await authoredFixture());

  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => NOW },
    db: database().db,
    adapters,
    manifest,
  };
}

/** `sources.buckets` and the home vessel's `shared.sourceBucket` together. */
async function storedBuckets() {
  const stored = await readStoredManifest(database().db);
  if (stored === null) return null;
  return {
    buckets: stored.sources.buckets,
    defaultBucket: sharedServicesOf(stored).sourceBucket,
  };
}

describe('declaring a source bucket', () => {
  test('checks the bucket, then declares it', async () => {
    const result = await useSourceBucket(
      { bucketName: 'a-second-bucket', makeDefault: false },
      await context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets).toContain('a-second-bucket');
    expect(await storedBuckets()).toMatchObject({
      buckets: ['example-source-bucket', 'a-second-bucket'],
      defaultBucket: 'example-source-bucket',
    });
  });

  test('makes it the default when asked, in the same act', async () => {
    const result = await useSourceBucket(
      { bucketName: 'a-second-bucket', makeDefault: true },
      await context(),
    );

    expect(result.ok).toBe(true);
    expect(await storedBuckets()).toMatchObject({
      defaultBucket: 'a-second-bucket',
    });
  });

  test('moves the default onto a bucket already declared, without duplicating it', async () => {
    const ctx = await context();
    await useSourceBucket(
      { bucketName: 'a-second-bucket', makeDefault: true },
      ctx,
    );
    await useSourceBucket(
      { bucketName: 'example-source-bucket', makeDefault: true },
      ctx,
    );

    expect(await storedBuckets()).toMatchObject({
      buckets: ['example-source-bucket', 'a-second-bucket'],
      defaultBucket: 'example-source-bucket',
    });
  });

  test('writes nothing when the bucket cannot be reached', async () => {
    const result = await useSourceBucket(
      { bucketName: 'not-ours', makeDefault: true },
      await context(403),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('not-ours');
    expect(await storedBuckets()).toMatchObject({
      buckets: ['example-source-bucket'],
      defaultBucket: 'example-source-bucket',
    });
  });

  test('refuses when there is no federated identity to check with', async () => {
    const base = await context();
    const result = await useSourceBucket(
      { bucketName: 'a-second-bucket', makeDefault: false },
      {
        ...base,
        manifest: {
          ...base.manifest,
          cloud: { ...base.manifest.cloud, federation: null },
        } as CommandContext['manifest'],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('Workload Identity Federation');
  });

  test('the list says whether anything here can be checked at all', async () => {
    const base = await context();

    const withFederation = await listSourceBuckets({}, base);
    expect(withFederation.ok && withFederation.value.canVerify).toBe(true);

    const without = await listSourceBuckets(
      {},
      {
        ...base,
        manifest: {
          ...base.manifest,
          cloud: { ...base.manifest.cloud, federation: null },
        } as CommandContext['manifest'],
      },
    );
    expect(without.ok && without.value.canVerify).toBe(false);
  });
});
