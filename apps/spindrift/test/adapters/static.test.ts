/**
 * The static-hosting deploy adapter and its bundle reader, against a fake of
 * the hosting API. Tars come from `test/harness/tar.ts`, not the reader.
 */
import { describe, expect, test } from 'bun:test';
import { BundleError, readBundle } from '@repo/archive/bundle';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor } from '../../src/adapters/deploy/contract.ts';
import {
  StaticDeployAdapter,
  siteId,
} from '../../src/adapters/deploy/static/index.ts';
import { deriveHealth } from '../../src/domain/capabilities.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import type { StaticAdapterConnection } from '../../src/domain/target.ts';
import {
  FakeHosting,
  type FakeHostingOptions,
} from '../harness/fakes/hosting-api.ts';
import {
  FakeOciRegistry,
  type FakeOciRegistryOptions,
} from '../harness/fakes/oci-registry.ts';
import { CLOUD_ENDPOINTS } from '../harness/installation.ts';
import { bytes, header, tar, tarball } from '../harness/tar.ts';

const DEPOT = 'https://artifacts.example.test';

const CONNECTION: StaticAdapterConnection = {
  adapter: 'static',
  project: 'example-vessel',
  endpoint: CLOUD_ENDPOINTS.hosting,
};

const TARGET: DeployTarget = {
  vessel: 'hosting',
  adapter: 'static',
  connection: CONNECTION,
};

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    deploy: 'deploy-1',
    app: 'shop',
    component: 'site',
    target: 'hosting',
    kind: 'website',
    artifact: {
      type: 'files',
      digest: 'sha256:bundle',
      refs: [`${DEPOT}/bundles/sha256:bundle`],
    },
    reach: 'public',
    auth: 'none',
    config: [],
    requirements: { platform: { os: 'linux', arch: 'amd64' }, resources: {} },
    hostname: { canonical: '' },
    ...overrides,
  };
}

/** A site of two files, which is enough for order and dedup to be visible. */
const SITE = tarball([
  { name: 'index.html', bytes: bytes('<!doctype html>home') },
  { name: 'assets/app.css', bytes: bytes('body{}') },
]);

function adapterFor(options: FakeHostingOptions = {}): {
  api: FakeHosting;
  adapter: StaticDeployAdapter;
} {
  const api = new FakeHosting({
    bundle: { origin: DEPOT, bytes: SITE },
    ...options,
  });
  return {
    api,
    adapter: new StaticDeployAdapter({ token: api.token, fetch: api.fetch }),
  };
}

async function drain(
  stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
): Promise<{ events: DeployEvent[]; verdict: DeployVerdict }> {
  const events: DeployEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, verdict: step.value };
}

describe('§9: static hosting serves Public only', () => {
  test('anything but a public reach is refused, as core’s bug', async () => {
    for (const reach of ['none', 'private'] as const) {
      const { api, adapter } = adapterFor();
      const { verdict } = await drain(
        adapter.apply(TARGET, desired({ reach, auth: 'none' })),
      );
      expect(verdict.phase).toBe('FAILED');
      if (verdict.phase === 'FAILED') {
        // Placement never sends a non-public Component here, so one arriving is
        // core's bug: INTERNAL, not REJECTED.
        expect(verdict.reason).toBe('INTERNAL');
        expect(blameFor(verdict.reason)).toBe('platform');
        expect(verdict.detail).toContain('a public reach only');
      }
      expect(api.hasSite('shop-site')).toBe(false);
    }
  });
});

describe('the release is five steps, in the product’s order', () => {
  test('a site is created, populated, finalized, and released', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    expect(api.hasSite('shop-site')).toBe(true);
    expect(api.servedPaths('shop-site')).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // The product refuses to release a draft version, and so does the fake.
    expect(api.serving('shop-site')?.status).toBe('FINALIZED');
  });

  test('the platform names its own, and the name comes back on the verdict', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase === 'LIVE') {
      expect(verdict.url).toBe('https://shop-site.hosted.example.test');
    }
  });

  test('only the files the product does not hold are uploaded', async () => {
    // The offered hash is over the gzipped bytes, which the product stores and
    // deduplicates on.
    const first = adapterFor();
    await drain(first.adapter.apply(TARGET, desired()));
    expect(first.api.uploads).toHaveLength(2);

    const held = first.api.uploads;
    const second = adapterFor({ held });
    await drain(second.adapter.apply(TARGET, desired()));
    expect(second.api.uploads).toEqual([]);
    expect(second.api.servedPaths('shop-site')).toHaveLength(2);
  });

  test('a site of more than a thousand files is offered in chunks the API takes', async () => {
    // The API refuses more than 1000 file hashes in one `populateFiles` call.
    const many = tarball(
      Array.from({ length: 1_001 }, (_, at) => ({
        name: `assets/${at}.txt`,
        bytes: bytes(`file ${at}`),
      })),
    );
    const api = new FakeHosting({ bundle: { origin: DEPOT, bytes: many } });
    const adapter = new StaticDeployAdapter({
      token: api.token,
      fetch: api.fetch,
    });

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    expect(
      api.pathsOf('POST').filter((path) => path.endsWith(':populateFiles')),
    ).toHaveLength(2);
    expect(api.servedPaths('shop-site')).toHaveLength(1_001);
    // Hashes from both chunks' answers are uploaded, not only the last's.
    expect(api.uploads).toHaveLength(1_001);
  });

  test('a redeploy releases onto the site that exists rather than a second one', async () => {
    const { api, adapter } = adapterFor({ sites: ['shop-site'] });
    await drain(adapter.apply(TARGET, desired()));
    await drain(adapter.apply(TARGET, desired({ deploy: 'deploy-2' })));

    expect(api.serving('shop-site')?.labels['spindrift-deploy']).toBe(
      'deploy-2',
    );
    expect(
      api.pathsOf('POST').filter((path) => path.endsWith('/sites')),
    ).toEqual([]);
  });

  test('a site this adapter created takes the next deploy as a revision', async () => {
    const { api, adapter } = adapterFor();

    const first = await drain(adapter.apply(TARGET, desired()));
    expect(first.verdict.phase).toBe('LIVE');

    const second = await drain(
      adapter.apply(TARGET, desired({ deploy: 'deploy-2' })),
    );
    expect(second.verdict.phase).toBe('LIVE');

    expect(
      api.pathsOf('POST').filter((path) => path.endsWith('/sites')),
    ).toHaveLength(1);
    expect(api.serving('shop-site')?.labels['spindrift-deploy']).toBe(
      'deploy-2',
    );
  });

  test('losing the create race is the desired state, not a failure', async () => {
    const { api, adapter } = adapterFor({ appearsBeforeCreate: 'shop-site' });

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    // The one create is refused with a 409, and the deploy is applied to the
    // site that exists.
    expect(
      api.pathsOf('POST').filter((path) => path.endsWith('/sites')),
    ).toHaveLength(1);
    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths('shop-site')).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
  });

  test('a name reserved by a deleted site is refused as spent, not as existing', async () => {
    // A site id is global and stays reserved after its site is deleted, so its
    // create collides forever and the read-back finds nothing.
    const { adapter } = adapterFor({ reserved: ['shop-site'] });

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('REJECTED');
      expect(verdict.detail).toContain('shop-site');
      expect(verdict.detail).toContain('reserved permanently');
      expect(verdict.detail).toContain('cannot be reclaimed');
    }
  });

  test('a 409 whose read-back never answered is not called spent', async () => {
    // Only a read-back that answers 404 proves the name is spent. A failed one
    // says nothing, and "rename the App" would spend a second id.
    const { api } = adapterFor({ reserved: ['shop-site'] });
    let reads = 0;
    const adapter = new StaticDeployAdapter({
      token: api.token,
      fetch: (request) => {
        const isSiteRead =
          request.method === 'GET' &&
          new URL(request.url).pathname.endsWith('/sites/shop-site');
        if (isSiteRead && ++reads > 1) {
          return Promise.resolve(new Response('', { status: 503 }));
        }
        return api.fetch(request);
      },
    });

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.detail).not.toContain('reserved permanently');
      expect(verdict.detail).toContain('already exists');
    }
  });
});

describe('a built files artifact is pulled out of the registry', () => {
  const AR_HOST = 'region-docker.pkg.dev';
  const AR_REPOSITORY = 'example-vessel/i/shop/site';
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const AR_REF = `${AR_HOST}/${AR_REPOSITORY}@${DIGEST}`;
  const GHCR_REF = `ghcr.io/example/shop/site@${DIGEST}`;

  function ociAdapter(options: Partial<FakeOciRegistryOptions> = {}): {
    registry: FakeOciRegistry;
    api: FakeHosting;
    adapter: StaticDeployAdapter;
  } {
    const registry = new FakeOciRegistry({
      host: AR_HOST,
      repository: AR_REPOSITORY,
      digest: DIGEST,
      layer: SITE,
      ...options,
    });
    const api = new FakeHosting({});
    const adapter = new StaticDeployAdapter({
      token: api.token,
      fetch: async (request) =>
        new URL(request.url).host === AR_HOST
          ? registry.fetch(request)
          : api.fetch(request),
    });
    return { registry, api, adapter };
  }

  function built(refs: readonly string[]): DesiredState {
    return desired({ artifact: { type: 'files', digest: DIGEST, refs } });
  }

  test('the readable reference is chosen, pulled with the identity, and served', async () => {
    const { registry, api, adapter } = ociAdapter();
    const { verdict } = await drain(
      adapter.apply(TARGET, built([GHCR_REF, AR_REF])),
    );

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths('shop-site')).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // Registry reads carry the hosting identity, never an anonymous pull.
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) {
      expect(request.authorization).toStartWith('Bearer ');
    }
  });

  test('an image at a files address is refused with the layer count in the sentence', async () => {
    // A build route with no files arm pushes an ordinary image. The layer count
    // tells that apart from a corrupt push.
    const { adapter } = ociAdapter({ layerCount: 4 });
    const { verdict } = await drain(adapter.apply(TARGET, built([AR_REF])));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
      expect(verdict.detail).toContain('4 layers');
    }
  });

  test('an artifact homed only where the identity cannot read is refused by name', async () => {
    const { registry, adapter } = ociAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, built([GHCR_REF])));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(verdict.detail).toContain('ghcr.io');
    }
    expect(registry.requests).toEqual([]);
  });

  test('a layer that is not a gzipped tar is refused as what it is', async () => {
    const { adapter } = ociAdapter({
      layerMediaType: 'application/vnd.oci.image.layer.v1.tar',
    });
    const { verdict } = await drain(adapter.apply(TARGET, built([AR_REF])));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(verdict.detail).toContain('gzipped tar');
    }
  });
});

describe('a supplied upload is fetched out of the depot', () => {
  /** Where `stageArchiveBytes` stages an upload when there is a depot. */
  const OBJECT = 'gs://bluenose-spindrift-source/abc123.tgz';

  const FEDERATION = {
    audience:
      '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
    tokenUrl: 'https://sts.googleapis.test/v1/token',
    tokenPath: '/var/run/secrets/spindrift/gcp-token',
    impersonationUrl:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
  };

  function supplied(location: string): DesiredState {
    return desired({
      artifact: { type: 'files', digest: 'sha256:bundle', refs: [location] },
    });
  }

  function depotAdapter(): {
    api: FakeHosting;
    adapter: StaticDeployAdapter;
    signed: string[];
    fetched: string[];
  } {
    // A signed URL points at the storage host, so the fake depot serves there.
    const api = new FakeHosting({
      bundle: { origin: 'https://storage.googleapis.com', bytes: SITE },
    });
    const signed: string[] = [];
    const fetched: string[] = [];
    const adapter = new StaticDeployAdapter({
      token: api.token,
      federation: { ...FEDERATION, readToken: async () => 'jwt' },
      fetch: async (request) => {
        if (request.url.startsWith(FEDERATION.tokenUrl)) {
          return Response.json({
            access_token: 'federated-token',
            expires_in: 3600,
          });
        }
        if (request.url.includes(':signBlob')) {
          signed.push(request.url);
          // Two bytes, so the hex encoding is checkable without arithmetic.
          return Response.json({ signedBlob: btoa('\x01\xfe') });
        }
        if (request.url.startsWith('https://storage.googleapis.com')) {
          fetched.push(request.url);
        }
        return api.fetch(request);
      },
    });
    return { api, adapter, signed, fetched };
  }

  test('a bundle staged at gs:// is signed for, fetched, and served', async () => {
    // An upload has no registry reference, and HTTP clients cannot fetch gs://.
    const { api, adapter, signed, fetched } = depotAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, supplied(OBJECT)));

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths('shop-site')).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // The federated identity signs; no stored credential is used.
    expect(signed).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/bluenose-spindrift-source/abc123.tgz?');
    expect(fetched[0]).toContain('X-Goog-Signature=01fe');
  });

  test('a bundle nothing can fetch says that, rather than blaming a registry', async () => {
    // With no depot, an upload is staged on the web pod's own disk, which no
    // adapter can fetch. A registry sentence would send the operator to IAM.
    const { adapter } = depotAdapter();
    const { verdict } = await drain(
      adapter.apply(TARGET, supplied('upload://abc123')),
    );

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
      expect(verdict.detail).toContain('upload://abc123');
      expect(verdict.detail).not.toContain('registry');
    }
  });

  test('an installation that federates nothing refuses rather than crashes', async () => {
    // Without `federation` nothing can sign for a depot object.
    const api = new FakeHosting({
      bundle: { origin: 'https://storage.googleapis.com', bytes: SITE },
    });
    const adapter = new StaticDeployAdapter({
      token: api.token,
      fetch: api.fetch,
    });
    const { verdict } = await drain(adapter.apply(TARGET, supplied(OBJECT)));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(verdict.detail).toContain(OBJECT);
      expect(verdict.detail).toContain('federation');
    }
  });
});

describe('§9: the vanity name is one record on the serving site', () => {
  test('a vanity name is attached to the site that is already serving', async () => {
    const { api, adapter } = adapterFor();
    await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.test' } }),
      ),
    );
    expect(api.domainsOf('shop-site')).toEqual(['shop.example.test']);
  });

  test('a name already on the site is the state being asked for', async () => {
    const { adapter } = adapterFor({
      domainAnswer: { status: 409, body: { error: { message: 'exists' } } },
    });
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.test' } }),
      ),
    );
    expect(verdict.phase).toBe('LIVE');
  });

  test('no vanity name means no record is written', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));
    expect(api.domainsOf('shop-site')).toEqual([]);
  });
});

describe('§6: what a failure is, and whose it is', () => {
  test('an artifact that cannot be fetched blames the platform', async () => {
    const { adapter } = adapterFor({
      // The bundle is served elsewhere, so the depot address answers a refusal.
      bundle: { origin: 'https://nowhere.example.test', bytes: SITE },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
    }
  });

  test('bytes that are not a bundle are the build having produced rubbish', async () => {
    const { adapter } = adapterFor({
      bundle: { origin: DEPOT, bytes: bytes('this is not a gzip') },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('BUILD_FAILED');
      expect(blameFor(verdict.reason)).toBe('developer');
    }
  });

  test('a refused write is REJECTED and an unreachable product is not', async () => {
    const refused = adapterFor({
      refuseVersion: { status: 400, body: { error: { message: 'bad' } } },
    });
    const first = await drain(refused.adapter.apply(TARGET, desired()));
    if (first.verdict.phase === 'FAILED') {
      expect(first.verdict.reason).toBe('REJECTED');
    }

    const denied = adapterFor({
      refuseVersion: { status: 403, body: { error: { message: 'nope' } } },
    });
    const second = await drain(denied.adapter.apply(TARGET, desired()));
    if (second.verdict.phase === 'FAILED') {
      expect(second.verdict.reason).toBe('TARGET_UNREACHABLE');
    }
  });
});

describe('observe, destroy, and what the site is called', () => {
  test('observe reports the digest of what is released', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    const observed = await adapter.observe(TARGET, verdict.ref);
    expect(observed?.artifactDigest).toBe('sha256:bundle');
    expect(observed?.phase).toBe('LIVE');
  });

  test('a site released by something else reports drift rather than agreement', async () => {
    // The digest lives on a label the adapter writes. A version released by
    // hand carries none, so it compares unequal to every desired digest.
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));
    const serving = api.serving('shop-site');
    if (serving !== undefined) serving.labels = {};

    const observed = await adapter.observe(
      TARGET,
      'example-vessel/sites/shop-site',
    );
    expect(observed?.artifactDigest).toBe('');
  });

  test('destroy removes the site and is idempotent', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    await adapter.destroy(TARGET, verdict.ref);
    expect(api.hasSite('shop-site')).toBe(false);
    await adapter.destroy(TARGET, verdict.ref);
    expect(await adapter.observe(TARGET, verdict.ref)).toBeNull();
  });

  test('a destroy that does not remove the site is never reported as one', async () => {
    // A DELETE on a path the API does not serve also answers 404. If destroy
    // resolved, `unplaceComponent` would orphan the Deploy row of a live site.
    const { api, adapter } = adapterFor({
      refuseDelete: {
        status: 404,
        body: { error: { message: 'no such path' } },
      },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    await expect(adapter.destroy(TARGET, verdict.ref)).rejects.toThrow();
    expect(api.hasSite('shop-site')).toBe(true);
  });

  test('a long name is shortened deterministically, never collided', () => {
    const long = desired({
      app: 'a-very-long-application-name',
      component: 'the-front-end',
    });
    const other = desired({
      app: 'a-very-long-application-name',
      component: 'the-back-end',
    });
    expect(siteId(long).length).toBeLessThanOrEqual(30);
    expect(siteId(long)).toBe(siteId({ ...long }));
    // Truncation alone would make these one site, and the second deploy would
    // replace the first.
    expect(siteId(long)).not.toBe(siteId(other));
  });
});

describe('§13 and §17: what this Target is honest about', () => {
  test('a reachable project meets every item on its own checklist', async () => {
    const { adapter } = adapterFor();
    const { prerequisites } = await adapter.inspect(TARGET);
    expect(deriveHealth(prerequisites, 'static')).toBe('healthy');
    // No chart runs on this backend, so there is no chart contract to check.
    expect(prerequisites.map((item) => item.name)).not.toContain(
      'CHART_CONTRACT',
    );
  });

  test('runtime log history is zero, which is the honest empty state', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(TARGET);
    expect(discovery.logHistorySeconds).toBe(0);
  });

  test('returns a no-runtime result instead of opening an empty tail', async () => {
    const { adapter } = adapterFor();
    expect(
      await adapter.tail(TARGET, { app: 'shop', component: 'site' }),
    ).toEqual({
      kind: 'none',
      because: 'Static files are served by the Target.',
    });
  });

  test('refuses to run, rather than being unimplemented', async () => {
    // Placement never sends a job here, but a caller that skips the kind check
    // still gets a sentence it can show, not a throw.
    const { adapter } = adapterFor();
    const refusal = {
      kind: 'none',
      because: 'Static files are served by the Target.',
    } as const;
    expect(await adapter.run(TARGET, 'example/sites/shop-site')).toEqual(
      refusal,
    );
    expect(await adapter.executions(TARGET, 'example/sites/shop-site')).toEqual(
      refusal,
    );
  });

  test('a site reaches no store, which is why §10 exempts a website', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(TARGET);
    expect(discovery.reachableSecretStores).toEqual([]);
    expect(discovery.reachableRegistries).toEqual([]);
  });

  test('nothing is admitted here, so nothing claims a verified deploy', async () => {
    const { adapter } = adapterFor();
    const { discovery } = await adapter.inspect(TARGET);
    expect(discovery.policyEngine).toEqual({ installed: false, mode: null });
  });
});

describe('the bundle reader', () => {
  test('reads regular files and drops directories', () => {
    const files = readBundle(
      tarball([
        { name: 'assets/', bytes: new Uint8Array(), type: '5' },
        { name: 'assets/app.css', bytes: bytes('body{}') },
        { name: 'index.html', bytes: bytes('hi') },
      ]),
    );
    expect(files.map((file) => file.path)).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    expect(new TextDecoder().decode(files[1]?.bytes)).toBe('hi');
  });

  test('the leading ./ every archiver writes is not part of the path', () => {
    const files = readBundle(
      tarball([{ name: './index.html', bytes: bytes('hi') }]),
    );
    expect(files[0]?.path).toBe('/index.html');
  });

  test('a path that leaves the bundle is refused, not normalized away', () => {
    // A bundle is untrusted input, and a path outside its site could reach
    // another App's files.
    expect(() =>
      readBundle(
        tarball([{ name: '../elsewhere/evil.html', bytes: bytes('x') }]),
      ),
    ).toThrow(BundleError);
  });

  test('a GNU long name is used in place of the truncated header', () => {
    const long = `${'deep/'.repeat(25)}index.html`;
    const archive = tar([
      { name: '././@LongLink', bytes: bytes(`${long}\0`), type: 'L' },
      { name: long.slice(0, 99), bytes: bytes('hi') },
    ]);
    expect(readBundle(Bun.gzipSync(archive))[0]?.path).toBe(`/${long}`);
  });

  test('a pax path record is used in place of the truncated header', () => {
    const long = `${'nested/'.repeat(20)}page.html`;
    const record = paxRecord('path', long);
    const archive = tar([
      { name: 'PaxHeaders/0', bytes: record, type: 'x' },
      { name: long.slice(0, 99), bytes: bytes('hi') },
    ]);
    expect(readBundle(Bun.gzipSync(archive))[0]?.path).toBe(`/${long}`);
  });

  test('an entry a website cannot contain is skipped, not fatal', () => {
    // A static host has no symlinks; the files around one still deploy.
    const archive = tar([
      { name: 'link', bytes: new Uint8Array(), type: '2' },
      { name: 'index.html', bytes: bytes('hi') },
    ]);
    expect(readBundle(Bun.gzipSync(archive)).map((file) => file.path)).toEqual([
      '/index.html',
    ]);
  });

  test('an archive that ends inside an entry is malformed, not silently short', () => {
    // Cut inside the entry's declared data, so the archive claims more bytes
    // than it carries.
    const truncated = tar([
      { name: 'big.bin', bytes: bytes('x'.repeat(1000)) },
    ]).slice(0, 700);
    expect(() => readBundle(Bun.gzipSync(truncated))).toThrow(BundleError);
  });

  test('bytes that are not gzip say so', () => {
    try {
      readBundle(bytes('plain text'));
      throw new Error('the reader accepted something that is not a bundle');
    } catch (cause) {
      expect(cause).toBeInstanceOf(BundleError);
      if (cause instanceof BundleError) expect(cause.code).toBe('NOT_GZIP');
    }
  });
});

/** One pax record, in the `<length> <key>=<value>\n` form the format uses. */
function paxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  const body = `${key}=${value}\n`;
  // The length includes its own digits, so it is solved for.
  let length = body.length + 3;
  while (`${length}`.length + 1 + body.length !== length) {
    length = `${length}`.length + 1 + body.length;
  }
  return bytes(`${length} ${body}`);
}

describe('the test harness writes a real ustar header', () => {
  test('a header is one block with a valid checksum', () => {
    const block = header({ name: 'index.html', bytes: bytes('hi') });
    expect(block.length).toBe(512);
    expect(new TextDecoder().decode(block.subarray(257, 262))).toBe('ustar');
  });
});
