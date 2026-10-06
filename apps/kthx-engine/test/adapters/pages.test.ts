/**
 * The edge static-hosting deploy adapter against a fake platform API, with a
 * real gzipped tar from `test/harness/tar.ts`. It serves `Public` reach only.
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
   * From the published formula, not this code: BLAKE3 over the base64 contents
   * plus the extension without its dot, hex, first 32 characters.
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
    // A leading dot starts a name, not an extension.
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
        // Placement already excludes this Target, so this is core's bug.
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
    // The production branch is the live site; any other is a preview.
    expect(api.serving(PROJECT)?.branch).toBe('production');
  });

  test('only the files the store lacks are uploaded, and all are served', async () => {
    const held = hashOf({
      path: '/index.html',
      bytes: bytes('<!doctype html>home'),
    });
    const { api, adapter } = adapterFor({ held: [held] });

    await drain(adapter.apply(TARGET, desired()));

    expect(api.uploads).not.toContain(held);
    expect(api.uploads).toHaveLength(1);
    // The manifest lists every file served, not only the uploads.
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
    // A supplied upload has only a depot address, read via a V4 signed URL.
    const api = new FakeCloudflarePages({
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
    // A dashboard deploy, whose commit message carries no marker.
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
      // The vanity record points at the same subdomain, proxied, because
      // Cloudflare flattens an apex CNAME.
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
    // The duplicate refusal is undocumented, so the adapter reads the domain
    // back instead of the status code.
    const { adapter } = adapterFor({
      domainAnswer: { status: 409, body: null },
      domainsAlready: { [PROJECT]: ['shop.example.com'] },
    });
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(verdict.phase).toBe('LIVE');
  });

  test('a name that is not there makes the refusal the failure', async () => {
    const { adapter } = adapterFor({
      domainAnswer: { status: 409, body: null },
    });
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
  });

  test('a certificate still issuing is said, and does not fail the deploy', async () => {
    // Every first attach is `initializing`, and the site already serves on its
    // own address, so the deploy does not wait for the certificate.
    const { adapter } = adapterFor({ domainStatus: 'initializing' });
    const { verdict, events } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(verdict.phase).toBe('LIVE');
    expect(JSON.stringify(events)).toContain('initializing');
    expect(JSON.stringify(events)).not.toContain('is serving on this project');
  });

  test('a domain Cloudflare refused fails the deploy rather than going live', async () => {
    const { adapter } = adapterFor({ domainStatus: 'blocked' });
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.com' } }),
      ),
    );
    expect(verdict.phase).toBe('FAILED');
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
    // One transport, split by host.
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
      expect(verdict.reason).toBe('ARTIFACT_UNAVAILABLE');
      expect(blameFor(verdict.reason)).toBe('platform');
      expect(verdict.detail).toContain('ghcr.io');
    }
    // No anonymous pull on the way to refusing.
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
    // With no depot, an upload is staged on the web pod's own disk.
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
    expect(byName.get('PLATFORM_API')?.met).toBe(true);
    expect(byName.get('API_TOKEN')?.met).toBe(false);
    expect(byName.get('API_TOKEN')?.assessed).toBe(true);
    // An unanswered check is unassessed, never met.
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
    // Static hosting is not a per-account switch, so no refusal means the
    // account lacks it.
    const { adapter } = adapterFor({ refuseList: { status: 403 } });
    expect((await adapter.inspect(TARGET)).surface.kind).toBe('undetermined');
  });

  test('API_TOKEN stands where OIDC_FEDERATION would, because there is none', async () => {
    const { adapter } = adapterFor();
    const names = (await adapter.inspect(TARGET)).prerequisites.map(
      (item) => item.name,
    );
    expect(names).not.toContain('OIDC_FEDERATION');
    // The screen shows this order.
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
    // Found by its commit-message marker.
    expect(api.deploymentCount).toBe(1);
    expect(
      again.events.some(
        (event) => event.type === 'log' && event.line.includes('adopting'),
      ),
    ).toBe(true);
    expect(
      api.requests.filter(
        (request) => request.path === '/pages/assets/check-missing',
      ),
    ).toHaveLength(1);
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

    expect(api.deploymentCount).toBe(2);
  });
});
