/**
 * The edge static-hosting deploy adapter (§6, §9, §17).
 *
 * Every test drives the real adapter against a fake of the platform's HTTP API
 * (§ Seam 2), with a **real gzipped tar** written by `test/harness/tar.ts`
 * rather than by the reader under test.
 *
 * The claims worth stating up front:
 *
 * - **The asset key is the vendor's formula**, checked against a fixed vector
 *   rather than against this implementation. It is the one thing here nothing
 *   else can catch: a wrong hash offers keys the store has never seen, uploads
 *   every file every time, and still deploys — so the site works and the
 *   contract is silently broken.
 * - **The two credentials are not interchangeable.** The account credential
 *   does not authorize the asset store and the minted token does not authorize
 *   anything else, so an adapter using one client for both fails here.
 * - **A deployment may only name files the store holds.** This is what the
 *   check-and-upload round exists to guarantee.
 * - **`Public` only** (§9), for the same reason its cloud sibling is: no
 *   non-public rendering here has a non-bypassable origin.
 * - **The platform names its own** (§9), and the canonical is the project's
 *   address rather than one deployment's.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor } from '../../src/adapters/deploy/contract.ts';
import { hashOf } from '../../src/adapters/deploy/pages/assets.ts';
import {
  PagesDeployAdapter,
  projectName,
} from '../../src/adapters/deploy/pages/index.ts';
import { deriveHealth } from '../../src/domain/capabilities.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import type { CloudflarePagesAdapterConnection } from '../../src/domain/target.ts';
import {
  FakeCloudflarePages,
  type FakeCloudflarePagesOptions,
} from '../harness/fakes/cloudflare-pages-api.ts';
import { FakeOciRegistry } from '../harness/fakes/oci-registry.ts';
import { CLOUDFLARE_ENDPOINT } from '../harness/installation.ts';
import { bytes, tarball } from '../harness/tar.ts';

const DEPOT = 'https://artifacts.example.test';

const CONNECTION: CloudflarePagesAdapterConnection = {
  adapter: 'cloudflare-pages',
  account: 'example-account',
  endpoint: CLOUDFLARE_ENDPOINT,
};

const TARGET: DeployTarget = {
  vessel: 'edge',
  adapter: 'cloudflare-pages',
  connection: CONNECTION,
};

/** The project every test below deploys to. */
const PROJECT = 'shop-site';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return {
    deploy: 'deploy-1',
    app: 'shop',
    component: 'site',
    target: 'edge',
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

function adapterFor(options: FakeCloudflarePagesOptions = {}): {
  api: FakeCloudflarePages;
  adapter: PagesDeployAdapter;
} {
  const api = new FakeCloudflarePages({
    bundle: { origin: DEPOT, bytes: SITE },
    ...options,
  });
  return {
    api,
    adapter: new PagesDeployAdapter({
      token: api.token,
      artifactToken: api.token,
      fetch: api.fetch,
    }),
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

describe('the asset key is the platform’s formula, not ours', () => {
  /**
   * A vector computed from the published algorithm — BLAKE3 over the base64
   * text of the contents concatenated with the extension without its dot,
   * hex, first 32 characters — rather than from this implementation. A round
   * trip through the code under test would prove it self-consistent and
   * nothing else, and self-consistent is exactly what a wrong hash is.
   */
  test('a known file hashes to a known key', () => {
    expect(hashOf({ path: '/index.html', bytes: bytes('<h1>hi</h1>') })).toBe(
      'e5e943f01929441dfbb0d4956a759fda',
    );
  });

  test('the extension is part of the key, so two files differ by name alone', () => {
    const content = bytes('same bytes');
    expect(hashOf({ path: '/a.html', bytes: content })).not.toBe(
      hashOf({ path: '/a.css', bytes: content }),
    );
  });

  test('a file with no extension hashes with an empty one', () => {
    // A dotfile is not an extension: `.nojekyll` is a name beginning with a
    // dot, and reading `nojekyll` as its type is how a leading-dot name gets
    // served as something it is not.
    expect(hashOf({ path: '/LICENSE', bytes: bytes('x') })).toBe(
      hashOf({ path: '/nested/LICENSE', bytes: bytes('x') }),
    );
    expect(hashOf({ path: '/.nojekyll', bytes: bytes('x') })).toBe(
      hashOf({ path: '/LICENSE', bytes: bytes('x') }),
    );
  });
});

describe('§9: edge static hosting serves Public only', () => {
  test('anything but a public reach is refused, as core’s bug', async () => {
    for (const reach of ['none', 'private'] as const) {
      const { api, adapter } = adapterFor();
      const { verdict } = await drain(
        adapter.apply(TARGET, desired({ reach, auth: 'none' })),
      );
      expect(verdict.phase).toBe('FAILED');
      if (verdict.phase === 'FAILED') {
        // Placement already excludes this Target for a non-public Component,
        // so one arriving here is core's bug and not the developer's.
        expect(verdict.reason).toBe('INTERNAL');
        expect(blameFor(verdict.reason)).toBe('platform');
        expect(verdict.detail).toContain('a public reach only');
      }
      expect(api.hasProject(PROJECT)).toBe(false);
    }
  });

  test('an authenticated edge is refused: there is none to put there', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(TARGET, desired({ auth: 'proxy' })),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('INTERNAL');
  });
});

describe('a deploy is check, upload, deploy', () => {
  test('a project is created and every file is served', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    expect(api.hasProject(PROJECT)).toBe(true);
    expect(api.servedPaths(PROJECT)).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // The deployment lands on the production branch, which is what makes it
    // the live site rather than a preview nobody's name points at.
    expect(api.serving(PROJECT)?.branch).toBe('production');
  });

  test('only the files the store lacks are uploaded, and all are served', async () => {
    const held = hashOf({
      path: '/index.html',
      bytes: bytes('<!doctype html>home'),
    });
    const { api, adapter } = adapterFor({ held: [held] });

    await drain(adapter.apply(TARGET, desired()));

    // The held file was not offered again...
    expect(api.uploads).not.toContain(held);
    expect(api.uploads).toHaveLength(1);
    // ...and the manifest still names it, because the manifest is what the
    // site serves rather than a list of what changed.
    expect(api.servedPaths(PROJECT)).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
  });

  test('an existing project is revised rather than re-created', async () => {
    const { api, adapter } = adapterFor({ projects: [PROJECT] });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    expect(api.pathsOf('POST')).not.toContain(
      `/accounts/${api.account}/pages/projects`,
    );
  });

  test('losing the create race is the desired state arriving elsewhere', async () => {
    const { api, adapter } = adapterFor({ appearsBeforeCreate: PROJECT });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('LIVE');
    expect(api.hasProject(PROJECT)).toBe(true);
  });
});

describe('a supplied upload is fetched out of the depot', () => {
  /** Where `stageArchiveBytes` puts an upload when the installation has one. */
  const OBJECT = 'gs://bluenose-spindrift-source/abc123.tgz';

  const FEDERATION = {
    audience:
      '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
    tokenUrl: 'https://sts.googleapis.test/v1/token',
    tokenPath: '/var/run/secrets/spindrift/gcp-token',
    impersonationUrl:
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
  };

  test('a bundle staged at gs:// is signed for, fetched, and served', async () => {
    // Nothing built a supplied upload, so it has no registry reference and no
    // URL — only the depot address, which this backend's account credential
    // has no bearing on at all. A V4 signature is what reads it.
    const api = new FakeCloudflarePages({
      // The depot serves on the storage host, which is where a signed URL
      // points — so the adapter's own fetch of the object runs for real.
      bundle: { origin: 'https://storage.googleapis.com', bytes: SITE },
    });
    const signed: string[] = [];
    const fetched: string[] = [];
    const adapter = new PagesDeployAdapter({
      token: api.token,
      artifactToken: api.token,
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

    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: {
            type: 'files',
            digest: 'sha256:bundle',
            refs: [OBJECT],
          },
        }),
      ),
    );

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths(PROJECT)).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // Signed with the federated identity rather than a stored credential
    // (§13), and the object fetched with the capability that signature is.
    expect(signed).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/bluenose-spindrift-source/abc123.tgz?');
    expect(fetched[0]).toContain('X-Goog-Signature=01fe');
  });
});

describe('the digest travels where a deployment can carry it', () => {
  test('observe reads back the digest apply deployed', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: {
            type: 'files',
            digest: 'sha256:one',
            refs: [`${DEPOT}/b`],
          },
        }),
      ),
    );
    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase !== 'LIVE') return;

    const observed = await adapter.observe(TARGET, verdict.ref);
    expect(observed?.artifactDigest).toBe('sha256:one');
    expect(observed?.phase).toBe('LIVE');
  });

  test('a deployment nobody here made reports no digest, which reads as drift', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));
    // Somebody deployed through the dashboard: a real deployment with a commit
    // message that carries no marker.
    const form = new FormData();
    form.append('manifest', '{}');
    form.append('branch', 'production');
    form.append('commit_message', 'fix the header');
    await api.fetch(
      new Request(
        `${CLOUDFLARE_ENDPOINT}/accounts/${api.account}/pages/projects/${PROJECT}/deployments`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${api.token()}` },
          body: form,
        },
      ),
    );

    const observed = await adapter.observe(
      TARGET,
      `${api.account}/pages/${PROJECT}`,
    );
    expect(observed?.artifactDigest).toBe('');
  });
});

describe('§9: the platform names its own', () => {
  test('the canonical is the project’s address, not one deployment’s', async () => {
    const { verdict } = await drain(
      adapterFor().adapter.apply(TARGET, desired()),
    );
    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase === 'LIVE') {
      // A deployment's own URL changes every release, so it cannot be what a
      // name points at.
      expect(verdict.url).toBe(`https://${PROJECT}.pages.example.test`);
      // §9: the vanity record `deploy-loop.ts` publishes points at the same
      // subdomain, proxied — Cloudflare flattens an apex CNAME.
      expect(verdict.address).toEqual({
        recordType: 'CNAME',
        target: `${PROJECT}.pages.example.test`,
        proxied: true,
      });
    }
  });

  test('the vanity name goes on the project that is already serving', async () => {
    const { api, adapter } = adapterFor();
    await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(api.domainsOf(PROJECT)).toEqual(['shop.example.com']);
  });

  test('a name already on the project is the state being asked for', async () => {
    const { adapter } = adapterFor({
      domainAnswer: { status: 409, body: null },
    });
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(verdict.phase).toBe('LIVE');
  });
});

describe('a built files artifact is pulled out of the registry', () => {
  const AR_HOST = 'region-docker.pkg.dev';
  const AR_REPOSITORY = 'example-vessel/i/shop/site';
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const AR_REF = `${AR_HOST}/${AR_REPOSITORY}@${DIGEST}`;
  const GHCR_REF = `ghcr.io/example/shop/site@${DIGEST}`;

  function ociAdapter(): {
    registry: FakeOciRegistry;
    api: FakeCloudflarePages;
    adapter: PagesDeployAdapter;
  } {
    const registry = new FakeOciRegistry({
      host: AR_HOST,
      repository: AR_REPOSITORY,
      digest: DIGEST,
      layer: SITE,
    });
    const api = new FakeCloudflarePages({});
    // One transport, split by host: the registry answers for itself and the
    // platform API answers for everything else.
    const adapter = new PagesDeployAdapter({
      token: api.token,
      artifactToken: async () => 'federated-token',
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

  test('the readable reference is chosen even when it is not the first', async () => {
    const { registry, api, adapter } = ociAdapter();
    const { verdict } = await drain(
      adapter.apply(TARGET, built([GHCR_REF, AR_REF])),
    );

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths(PROJECT)).toEqual([
      '/assets/app.css',
      '/index.html',
    ]);
    // The registry read carried the federated identity, never the account
    // credential this adapter drives the platform with.
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) {
      expect(request.authorization).toBe('Bearer federated-token');
    }
  });

  test('an artifact homed only where the identity cannot read is refused by name', async () => {
    const { registry, adapter } = ociAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, built([GHCR_REF])));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      // §6 blames the platform: the build is green and the bytes are not
      // reachable in the form this Target serves.
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
      expect(verdict.detail).toContain('ghcr.io');
    }
    // And nothing tried to pull anonymously on the way to refusing.
    expect(registry.requests).toEqual([]);
  });
});

describe('what this Target cannot fetch, it says so about', () => {
  test('an artifact with no address at all is named as such', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: { type: 'files', digest: 'sha256:bundle', refs: [] },
        }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.detail).toContain('no address');
    }
  });

  test('a bundle nothing can fetch says that, rather than blaming a credential', async () => {
    // An installation with no depot stages an upload on the web pod's own
    // disk. That is unfetchable, and it used to take the registry sentence — a
    // true statement about a different problem, which sends the operator to a
    // credential they cannot fix this with.
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: {
            type: 'files',
            digest: 'sha256:bundle',
            refs: ['upload://abc123'],
          },
        }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
      expect(verdict.detail).toContain('upload://abc123');
      expect(verdict.detail).not.toContain('registry');
    }
  });

  test('an image artifact is refused as core’s bug', async () => {
    const { adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: {
            type: 'image',
            digest: 'sha256:img',
            refs: [`${DEPOT}/i`],
          },
        }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('INTERNAL');
  });
});

describe('a refusal from the platform is a verdict, not a throw', () => {
  test('a refused upload token fails the deploy without placing a version', async () => {
    const { api, adapter } = adapterFor({
      refuseToken: { status: 403, body: null },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('FAILED');
    // The project was made; nothing was deployed onto it.
    expect(api.hasProject(PROJECT)).toBe(true);
    expect(api.serving(PROJECT)).toBeUndefined();
  });

  test('an unfetchable artifact indicts the platform', async () => {
    const { adapter } = adapterFor({
      bundle: { origin: 'https://elsewhere.example.test', bytes: SITE },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
    }
  });
});

describe('§17: nothing here runs', () => {
  test('the three runtime questions get one sentence', async () => {
    const { adapter } = adapterFor();
    const ref = `${CONNECTION.account}/pages/${PROJECT}`;
    const tail = await adapter.tail(TARGET, { app: 'shop', component: 'site' });
    const run = await adapter.run(TARGET, ref);
    const runs = await adapter.executions(TARGET, ref);

    expect(tail.kind).toBe('none');
    expect(run.kind).toBe('none');
    expect(runs.kind).toBe('none');
    // One fact, one sentence — three different ones would read as three
    // different limitations.
    const because = [tail, run, runs].map((answer) =>
      answer.kind === 'none' ? answer.because : '',
    );
    expect(new Set(because).size).toBe(1);
  });
});

describe('destroy is idempotent, and never reports success it did not earn', () => {
  test('a project that is gone stays gone', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));
    const ref = `${api.account}/pages/${PROJECT}`;

    await adapter.destroy(TARGET, ref);
    expect(api.hasProject(PROJECT)).toBe(false);
    // Destroying what is already gone succeeds (§6).
    await adapter.destroy(TARGET, ref);
  });

  test('a delete the platform refused is not reported as a destroy', async () => {
    const { api, adapter } = adapterFor({
      refuseDelete: { status: 200, body: null },
    });
    await drain(adapter.apply(TARGET, desired()));
    expect(
      adapter.destroy(TARGET, `${api.account}/pages/${PROJECT}`),
    ).rejects.toThrow(/still exists/);
  });
});

describe('§13: the standing checklist', () => {
  test('an account that answers is healthy', async () => {
    const { adapter } = adapterFor();
    const inspection = await adapter.inspect(TARGET);
    expect(deriveHealth(inspection.prerequisites, 'cloudflare-pages')).toBe(
      'healthy',
    );
    expect(inspection.surface).toEqual({ kind: 'carried' });
  });

  test('a refused credential is API_TOKEN, and says the account is unchecked', async () => {
    const { adapter } = adapterFor({ refuseList: { status: 403 } });
    const inspection = await adapter.inspect(TARGET);

    const byName = new Map(
      inspection.prerequisites.map((item) => [item.name, item]),
    );
    // The API answered, so what is unmet is the bearer and not the platform —
    // the split that keeps an operator off the wrong page.
    expect(byName.get('PLATFORM_API')?.met).toBe(true);
    expect(byName.get('API_TOKEN')?.met).toBe(false);
    expect(byName.get('API_TOKEN')?.assessed).toBe(true);
    // A boundary that refused to answer has not said it exists — reporting it
    // met would be core deciding that what it failed to check was fine.
    expect(byName.get('VESSEL')?.met).toBe(false);
    expect(byName.get('VESSEL')?.assessed).toBe(false);
  });

  test('a missing account is VESSEL, and the API is met because it answered', async () => {
    const { adapter } = adapterFor({ refuseList: { status: 404 } });
    const byName = new Map(
      (await adapter.inspect(TARGET)).prerequisites.map((item) => [
        item.name,
        item,
      ]),
    );
    expect(byName.get('PLATFORM_API')?.met).toBe(true);
    expect(byName.get('VESSEL')?.met).toBe(false);
    expect(byName.get('VESSEL')?.assessed).toBe(true);
  });

  test('the surface is never reported absent, because nothing can establish it', async () => {
    // This product is not a per-account switch, so no refusal means "this
    // account does not do static hosting" — reading one that way would delete
    // a Target over an expired credential.
    const { adapter } = adapterFor({ refuseList: { status: 403 } });
    expect((await adapter.inspect(TARGET)).surface.kind).toBe('undetermined');
  });

  test('API_TOKEN stands where OIDC_FEDERATION would, because there is none', async () => {
    const { adapter } = adapterFor();
    const names = (await adapter.inspect(TARGET)).prerequisites.map(
      (item) => item.name,
    );
    // A federation row here could never fail, and would send an operator to
    // configure a trust relationship that exists on neither side.
    expect(names).not.toContain('OIDC_FEDERATION');
    // In this adapter's own declared order, which is what the screen shows.
    expect(names).toEqual(['PLATFORM_API', 'API_TOKEN', 'VESSEL']);
  });
});

describe('a project is named once, deterministically', () => {
  test('the name is the App and Component, lowercased', () => {
    expect(projectName(desired())).toBe(PROJECT);
  });

  test('a long name keeps a recognisable head and a digest tail', () => {
    const long = projectName(
      desired({ app: 'a'.repeat(60), component: 'site' }),
    );
    expect(long.length).toBeLessThanOrEqual(58);
    // Deterministic: a second deploy that computed a different name would
    // create a second project rather than revise the first.
    expect(long).toBe(
      projectName(desired({ app: 'a'.repeat(60), component: 'site' })),
    );
  });
});

describe('a re-apply finds the deployment it already made', () => {
  test('a second apply adopts the deployment carrying its Deploy', async () => {
    const { api, adapter } = adapterFor();
    const first = await drain(adapter.apply(TARGET, desired()));
    expect(first.verdict.phase).toBe('LIVE');

    const again = await drain(adapter.apply(TARGET, desired()));

    expect(again.verdict.phase).toBe('LIVE');
    // One deployment ever: the second apply found the first one by its
    // commit-message marker and said so, rather than creating a sibling.
    expect(api.deploymentCount).toBe(1);
    expect(
      again.events.some(
        (event) => event.type === 'log' && event.line.includes('adopting'),
      ),
    ).toBe(true);
    // And it spent nothing getting there: no second fetch of the bundle, no
    // second offer to the asset store.
    expect(
      api.requests.filter(
        (request) => request.path === '/pages/assets/check-missing',
      ),
    ).toHaveLength(1);
    // The adopted verdict still carries the canonical address (§9).
    if (again.verdict.phase === 'LIVE') {
      expect(again.verdict.url).toBe(`https://${PROJECT}.pages.example.test`);
    }
  });

  test('a deployment the platform failed is not adopted — its successor is the retry', async () => {
    const { api, adapter } = adapterFor({
      stage: { name: 'deploy', status: 'failure' },
    });
    await drain(adapter.apply(TARGET, desired()));

    await drain(adapter.apply(TARGET, desired()));

    // A failed deployment never served, so creating its successor is what a
    // retry is; adopting it would pin the Deploy to a corpse.
    expect(api.deploymentCount).toBe(2);
  });
});
