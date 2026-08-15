/**
 * Staging a bundle where a builder can fetch it, and minting the URL that lets
 * it (ticket 23).
 *
 * The defect these cover is not a wrong value, it is a wrong *place*: bundles
 * were written to the web pod's own `tmpdir()` and handed to a GitHub-hosted
 * runner as `upload://<hex>`. Neither half could work — the scheme is not a
 * scheme, and the bytes are on a disk nothing outside that one pod can reach.
 */
import { describe, expect, test } from 'bun:test';
import {
  digestOfBytes,
  isEphemeralBundleLocation,
  readStagedArchive,
  type SourceDepot,
  sourceDepotFor,
  stageArchiveBytes,
} from '../../src/storage/archives.ts';
import {
  parseGcsLocation,
  SIGNED_URL_TTL_SECONDS,
  signedObjectUrl,
} from '../../src/storage/signed-url.ts';

const federation = {
  audience:
    '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
  tokenUrl: 'https://sts.googleapis.test/v1/token',
  tokenPath: '/var/run/secrets/spindrift/gcp-token',
  impersonationUrl:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
};

const manifest = {
  installation: {
    name: 'a-test',
    controlPlaneVessel: 'here',
    homeVessel: 'home',
  },
  vessels: [
    {
      name: 'home',
      kind: 'gcp-project',
      location: { project: 'vessel' },
      shared: {
        sourceBucket: 'bluenose-spindrift-source',
        artifactsProject: 'artifacts',
        secretStoreContainer: 'vessel',
      },
    },
  ],
  cloud: { federation },
} as unknown as Parameters<typeof sourceDepotFor>[0];

/** A far side that answers the token exchange, the upload, and `signBlob`. */
function fakeCloud(): {
  fetch: (request: Request) => Promise<Response>;
  uploads: { url: string; bytes: Uint8Array }[];
  signed: string[];
  impersonated: number;
} {
  const uploads: { url: string; bytes: Uint8Array }[] = [];
  const signed: string[] = [];
  let impersonated = 0;
  const state = {
    uploads,
    signed,
    get impersonated() {
      return impersonated;
    },
    fetch: async (request: Request): Promise<Response> => {
      const url = request.url;
      if (url.includes('sts.googleapis.test')) {
        return Response.json({
          access_token: 'federated-token',
          expires_in: 3600,
        });
      }
      if (url.includes(':generateAccessToken')) {
        impersonated += 1;
        return Response.json({ accessToken: 'impersonated-token' });
      }
      if (url.includes(':signBlob')) {
        const body = (await request.json()) as { payload: string };
        signed.push(atob(body.payload));
        // Two bytes, so the hex encoding is checkable without arithmetic.
        return Response.json({ signedBlob: btoa('\x01\xfe') });
      }
      if (url.includes('storage.googleapis.com/upload/')) {
        uploads.push({
          url,
          bytes: new Uint8Array(await request.arrayBuffer()),
        });
        return Response.json({ kind: 'storage#object' });
      }
      return new Response('unexpected', { status: 500 });
    },
  };
  return state;
}

describe('the source depot', () => {
  test('reads the bucket and the federation the installation declares', () => {
    const depot = sourceDepotFor(manifest);
    expect(depot?.bucket).toBe('bluenose-spindrift-source');
    expect(depot?.federation.impersonationUrl).toBe(
      federation.impersonationUrl,
    );
  });

  test('is absent when there is no federation to reach the bucket with', () => {
    // A bucket name with nothing that can write to it is not a depot, and
    // answering with one would stage bundles into a call that always fails.
    const depot = sourceDepotFor({
      ...manifest,
      cloud: { ...manifest?.cloud, federation: null },
    } as never);
    expect(depot).toBeNull();
  });

  test('stages bundle bytes into the bucket, addressed by their digest', async () => {
    const cloud = fakeCloud();
    const bytes = new TextEncoder().encode('a source bundle');
    const depot: SourceDepot = {
      bucket: 'bluenose-spindrift-source',
      federation: {
        ...federation,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
    };

    const staged = await stageArchiveBytes('bundle.tgz', bytes, depot);
    const hex = digestOfBytes(bytes).replace('sha256:', '');

    expect(staged.location).toBe(`gs://bluenose-spindrift-source/${hex}.tgz`);
    // Nothing on this pod's disk: that is the whole point of the change.
    expect(staged.filepath).toBeNull();
    expect(await readStagedArchive(staged.digest)).toBeNull();
    expect(cloud.uploads).toHaveLength(1);
    expect(cloud.uploads[0]?.bytes).toEqual(bytes);
  });

  test('an ephemeral bundle lands under the prefix the lifecycle rule matches', async () => {
    // §15's "repository bundles are ephemeral" used to be a word in a union
    // and nothing else: every object landed at the bucket root, where the
    // bucket's lifecycle rules never touch a content-addressed object, and the
    // depot grew one full source archive per built commit forever. The prefix
    // is the property the bucket can act on.
    const cloud = fakeCloud();
    const bytes = new TextEncoder().encode('a repository bundle');
    const depot: SourceDepot = {
      bucket: 'bluenose-spindrift-source',
      federation: {
        ...federation,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
    };

    const staged = await stageArchiveBytes(
      'bundle.tgz',
      bytes,
      depot,
      'ephemeral',
    );
    const hex = digestOfBytes(bytes).replace('sha256:', '');

    expect(staged.location).toBe(
      `gs://bluenose-spindrift-source/ephemeral/${hex}.tgz`,
    );
    expect(isEphemeralBundleLocation(staged.location)).toBe(true);
    // A durable upload keeps the root address the rules leave alone.
    expect(
      isEphemeralBundleLocation(`gs://bluenose-spindrift-source/${hex}.tgz`),
    ).toBe(false);
  });

  test('falls back to local disk under a handle that is not a URL', async () => {
    // An installation with no depot gets the old behaviour, and the location it
    // records says so: `upload://` cannot be mistaken for something fetchable.
    const bytes = new TextEncoder().encode(`local ${Math.random()}`);
    const staged = await stageArchiveBytes('bundle.tgz', bytes, null);

    expect(staged.location.startsWith('upload://')).toBe(true);
    expect(staged.filepath).not.toBeNull();
    expect(await readStagedArchive(staged.digest)).toEqual(bytes);
  });
});

describe('signing a bundle URL', () => {
  const location = 'gs://bluenose-spindrift-source/abc123.tgz';

  test('reads a gs:// address, and declines anything that is not one', () => {
    expect(parseGcsLocation(location)).toEqual({
      bucket: 'bluenose-spindrift-source',
      object: 'abc123.tgz',
    });
    expect(parseGcsLocation('upload://abc123')).toBeNull();
    expect(parseGcsLocation('https://example.test/bundle.tgz')).toBeNull();
    expect(parseGcsLocation('gs://bucket-with-no-object')).toBeNull();
  });

  test('mints an https URL a plain curl can follow', async () => {
    const cloud = fakeCloud();
    const url = await signedObjectUrl({
      location,
      federation: {
        ...federation,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
      now: () => new Date('2026-08-01T12:00:00.000Z'),
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://storage.googleapis.com');
    expect(parsed.pathname).toBe('/bluenose-spindrift-source/abc123.tgz');
    expect(parsed.searchParams.get('X-Goog-Algorithm')).toBe(
      'GOOG4-RSA-SHA256',
    );
    expect(parsed.searchParams.get('X-Goog-Date')).toBe('20260801T120000Z');
    expect(parsed.searchParams.get('X-Goog-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Goog-Credential')).toBe(
      'controller@vessel.iam.gserviceaccount.com/20260801/auto/storage/goog4_request',
    );
    // Hex, not base64: V4 puts the signature in the query as hex.
    expect(parsed.searchParams.get('X-Goog-Signature')).toBe('01fe');
  });

  test('expires in minutes, because the URL is a bearer capability', async () => {
    const cloud = fakeCloud();
    const url = await signedObjectUrl({
      location,
      federation: {
        ...federation,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
    });
    expect(new URL(url).searchParams.get('X-Goog-Expires')).toBe(
      String(SIGNED_URL_TTL_SECONDS),
    );
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
  });

  test('signs with the federated token, never the impersonated one', async () => {
    // `signBlob` is authorized by `serviceAccountTokenCreator`, which the
    // workload identity holds on the service account — impersonating first
    // would instead need that role held on itself, a grant nothing else needs.
    const cloud = fakeCloud();
    await signedObjectUrl({
      location,
      federation: {
        ...federation,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
    });

    expect(cloud.impersonated).toBe(0);
    expect(cloud.signed).toHaveLength(1);
    expect(cloud.signed[0]?.startsWith('GOOG4-RSA-SHA256\n')).toBe(true);
  });

  test('refuses when the installation impersonates no service account', async () => {
    const cloud = fakeCloud();
    const attempt = signedObjectUrl({
      location,
      federation: {
        ...federation,
        impersonationUrl: null,
        fetch: cloud.fetch,
        readToken: async () => 'jwt',
      },
    });
    // A federated identity has no key GCS can verify a signature against, so
    // there is nothing to sign with and the sentence says which knob is missing.
    expect(attempt).rejects.toThrow('impersonationUrl');
  });
});
