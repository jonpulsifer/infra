/**
 * The Vercel deploy adapter (§4, §6, §9, §17).
 *
 * Every test drives the real adapter against a fake of the platform's HTTP API
 * (§ Seam 2), with a **real gzipped tar** written by `test/harness/tar.ts`.
 *
 * The claims worth stating up front:
 *
 * - **The platform is never asked to build** (§4). A deployment carries the
 *   finished tree and project settings that name no framework and no build
 *   command, so a rollback re-deploys rather than rebuilding.
 * - **`Public` only** (§9), for the reason the other files backend states.
 * - **The deployment is not ready when it is created.** `apply` reaches its
 *   verdict from the platform's `readyState`, not from the create response.
 * - **The platform names its own** (§9), so the address comes back on the
 *   verdict.
 * - **A red deployment is a `BUILD_FAILED` the developer owns**, and a refused
 *   call is not.
 */
import { describe, expect, test } from 'bun:test';
import type {
  DeployEvent,
  DeployTarget,
  DeployVerdict,
} from '../../src/adapters/deploy/contract.ts';
import { blameFor } from '../../src/adapters/deploy/contract.ts';
import {
  type PrebuiltDeploy,
  type PrebuiltDeployInput,
  projectName,
  VercelDeployAdapter,
} from '../../src/adapters/deploy/vercel/index.ts';
import { deriveHealth } from '../../src/domain/capabilities.ts';
import type { DesiredState } from '../../src/domain/desired-state.ts';
import type { VercelAdapterConnection } from '../../src/domain/target.ts';
import {
  FakeVercel,
  type FakeVercelOptions,
} from '../harness/fakes/vercel-api.ts';
import { VERCEL_ENDPOINT } from '../harness/installation.ts';
import { bytes, tarball } from '../harness/tar.ts';

const DEPOT = 'https://artifacts.example.test';

const CONNECTION: VercelAdapterConnection = {
  adapter: 'vercel',
  team: 'example-team',
  endpoint: VERCEL_ENDPOINT,
};

const TARGET: DeployTarget = {
  vessel: 'edge',
  adapter: 'vercel',
  connection: CONNECTION,
};

/** What every test deploys: `shop-site`, per `workloadName`. */
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

/** Two files, which is enough for path handling to be visible. */
const SITE = tarball([
  { name: 'index.html', bytes: bytes('<!doctype html>home') },
  { name: 'assets/app.css', bytes: bytes('body{}') },
]);

/**
 * The tree a `vercel-output` artifact is: the Build Output API tree under
 * `.vercel/output/`, and beside it at the root the files a function's
 * `filePathMap` names. The CLI is handed this directory verbatim.
 */
const OUTPUT_TREE = tarball([
  { name: '.vercel/output/config.json', bytes: bytes('{"version":3}') },
  {
    name: '.vercel/output/functions/index.func/.vc-config.json',
    bytes: bytes('{"runtime":"nodejs20.x"}'),
  },
  {
    name: 'node_modules/@scope/dep/index.js',
    bytes: bytes('module.exports = {}'),
  },
]);

function adapterFor(
  options: FakeVercelOptions = {},
  deployPrebuilt?: PrebuiltDeploy,
): {
  api: FakeVercel;
  adapter: VercelDeployAdapter;
} {
  const api = new FakeVercel({
    bundle: { origin: DEPOT, bytes: SITE },
    ...options,
  });
  return {
    api,
    adapter: new VercelDeployAdapter({
      token: api.token,
      // One fake stands for both far sides here: what the split buys is proved
      // by the adapter having two providers, not by this test holding two.
      artifactToken: api.token,
      fetch: api.fetch,
      pollIntervalMs: 1,
      sleep: async () => {},
      ...(deployPrebuilt === undefined ? {} : { deployPrebuilt }),
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

/** The body of the one deployment that was created. */
function createdBody(api: FakeVercel): Record<string, unknown> {
  const created = api.requests.find(
    (request) =>
      request.method === 'POST' && request.path === '/v13/deployments',
  );
  expect(created).toBeDefined();
  return created?.body as Record<string, unknown>;
}

describe('§4: build stays separate from deploy', () => {
  test('the deployment names no framework and no build command', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    const settings = createdBody(api).projectSettings as Record<
      string,
      unknown
    >;
    // Every one of these being null is what makes the platform serve what was
    // uploaded rather than build it. A value here would be Spindrift asking for
    // the second build §4 exists to prevent.
    expect(settings.framework).toBeNull();
    expect(settings.buildCommand).toBeNull();
    expect(settings.installCommand).toBeNull();
  });

  test('the files are uploaded before the deployment references them', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));

    // The fake refuses a deployment referencing a file it never received, so
    // reaching a served project at all is the ordering assertion; the paths
    // are what proves the whole bundle went, root-relative.
    expect(api.servedPaths(PROJECT)).toEqual(['assets/app.css', 'index.html']);
    expect(api.uploads).toHaveLength(2);
  });

  test('the artifact digest travels on the deployment, so observe can read it', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({
          artifact: {
            type: 'files',
            digest: 'sha256:observed',
            refs: [`${DEPOT}/bundles/sha256:observed`],
          },
        }),
      ),
    );
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    const observed = await adapter.observe(TARGET, verdict.ref);
    expect(observed?.artifactDigest).toBe('sha256:observed');
    expect(observed?.phase).toBe('LIVE');
    expect(api.serving(PROJECT)?.meta.spindriftDeploy).toBe('deploy-1');
  });
});

describe('the platform’s own build output deploys prebuilt', () => {
  /** The shape a Component built for this Target renders to. */
  const buildOutput = () =>
    desired({
      artifact: {
        type: 'vercel-output',
        digest: 'sha256:ssr',
        refs: [`${DEPOT}/bundles/sha256:ssr`],
      },
    });

  /**
   * The adapter drives the platform's own CLI on this path; the fake stands in
   * for `vercel deploy`, capturing the directory and inputs it was handed and
   * registering the deployment the real CLI would create — which the adapter
   * then finds by its meta and polls to its verdict.
   */
  function cliAdapter(): {
    api: FakeVercel;
    adapter: VercelDeployAdapter;
    calls: PrebuiltDeployInput[];
    trees: string[][];
  } {
    const calls: PrebuiltDeployInput[] = [];
    const trees: string[][] = [];
    let api!: FakeVercel;
    const deploy: PrebuiltDeploy = async (input) => {
      calls.push(input);
      trees.push(
        (
          await Array.fromAsync(
            // `dot: true` so `.vercel/output/…` is seen — the tree the CLI reads.
            new Bun.Glob('**/*').scan({ cwd: input.directory, dot: true }),
          )
        ).sort(),
      );
      api.recordPrebuiltDeploy({ project: input.project, meta: input.meta });
      return { ok: true };
    };
    const built = adapterFor(
      { bundle: { origin: DEPOT, bytes: OUTPUT_TREE } },
      deploy,
    );
    api = built.api;
    return { ...built, calls, trees };
  }

  test('the CLI deploys the staged tree, and the platform’s answer is the verdict', async () => {
    const { api, adapter } = cliAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, buildOutput()));

    expect(verdict.phase).toBe('LIVE');
    // The deployment the CLI made carries the meta the adapter stamped, so it is
    // found and adopted rather than a second one created.
    expect(api.servedPrebuilt(PROJECT)).toBe(true);
  });

  test('the CLI is handed the deployment tree, the project, and this Deploy’s meta', async () => {
    const { adapter, calls, trees } = cliAdapter();
    await drain(adapter.apply(TARGET, buildOutput()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.project).toBe(PROJECT);
    expect(calls[0]?.team).toBe(CONNECTION.team);
    expect(calls[0]?.meta.spindriftDeploy).toBe('deploy-1');
    // The directory is the tree the build staged: the Build Output tree under
    // `.vercel/output/`, and the mapped file at the root beside it.
    expect(trees[0]).toContain('.vercel/output/config.json');
    expect(trees[0]).toContain('node_modules/@scope/dep/index.js');
  });

  test('a plain files artifact is still deployed the way it always was', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));

    // §4's supplied artifact is `files` and has no build output to have been
    // produced by, so it must keep the built-nothing settings and the paths
    // rooted at the site.
    expect(api.servedPrebuilt(PROJECT)).toBe(false);
    expect(api.servedPaths(PROJECT)).toEqual(['assets/app.css', 'index.html']);
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

  /** A supplied artifact: the bundle's own address, and no registry anywhere. */
  function supplied(location: string): DesiredState {
    return desired({
      artifact: { type: 'files', digest: 'sha256:bundle', refs: [location] },
    });
  }

  function depotAdapter(): {
    api: FakeVercel;
    adapter: VercelDeployAdapter;
    signed: string[];
    fetched: string[];
  } {
    // The depot serves on the storage host, which is also where a signed URL
    // points — so the adapter's own fetch of the object runs for real.
    const api = new FakeVercel({
      bundle: { origin: 'https://storage.googleapis.com', bytes: SITE },
    });
    const signed: string[] = [];
    const fetched: string[] = [];
    const adapter = new VercelDeployAdapter({
      token: api.token,
      artifactToken: api.token,
      federation: { ...FEDERATION, readToken: async () => 'jwt' },
      pollIntervalMs: 1,
      sleep: async () => {},
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

  test('a bundle staged at gs:// is signed for, fetched, and deployed', async () => {
    // Both files backends take a supplied upload, and this one reached the
    // same dead end: nothing built the bundle, so there is no registry
    // reference, and the depot address is not something an HTTP client
    // resolves.
    const { api, adapter, signed, fetched } = depotAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, supplied(OBJECT)));

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths(PROJECT)).toEqual(['assets/app.css', 'index.html']);
    // Signed with the federated identity rather than a stored credential
    // (§13), and the object fetched with the capability that signature is —
    // neither of this adapter's two bearers was what read it.
    expect(signed).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/bluenose-spindrift-source/abc123.tgz?');
    expect(fetched[0]).toContain('X-Goog-Signature=01fe');
  });

  test('a bundle nothing can fetch says that, rather than blaming a registry', async () => {
    // An installation with no depot stages an upload on the web pod's own
    // disk. That is unfetchable, and it used to be reported as an artifact
    // homed on a registry this identity cannot read — a true sentence about a
    // different problem, which sends the operator to IAM.
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
});

describe('§9: Vercel serves Public only', () => {
  test('anything but a public reach is refused, as core’s bug', async () => {
    for (const reach of ['none', 'private'] as const) {
      const { api, adapter } = adapterFor();
      const { verdict } = await drain(
        adapter.apply(TARGET, desired({ reach, auth: 'none' })),
      );
      expect(verdict.phase).toBe('FAILED');
      if (verdict.phase === 'FAILED') {
        expect(verdict.reason).toBe('INTERNAL');
        expect(blameFor(verdict.reason)).toBe('platform');
      }
      expect(api.hasProject(PROJECT)).toBe(false);
    }
  });

  test('the vanity name goes on the project that is serving', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(
      adapter.apply(
        TARGET,
        desired({ hostname: { canonical: '', vanity: 'shop.example.test' } }),
      ),
    );

    expect(verdict.phase).toBe('LIVE');
    expect(api.domainsOf(PROJECT)).toEqual(['shop.example.test']);
  });

  test('a vanity name already on the project is not attached twice', async () => {
    const { api, adapter } = adapterFor();
    const withVanity = desired({
      hostname: { canonical: '', vanity: 'shop.example.test' },
    });
    await drain(adapter.apply(TARGET, withVanity));
    await drain(adapter.apply(TARGET, withVanity));

    expect(api.domainsOf(PROJECT)).toEqual(['shop.example.test']);
  });
});

describe('§6: the verdict is the platform’s, read from the deployment', () => {
  test('apply waits out the queue rather than trusting the create', async () => {
    const { adapter } = adapterFor({ pollsBeforeSettling: 3 });
    const { events, verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    if (verdict.phase === 'LIVE') {
      // §9: the platform names its own, and the API answers a bare host.
      expect(verdict.url).toBe(`https://${PROJECT}.vercel.app`);
      // Every Vercel project answers the same vendor CNAME regardless of
      // which project or deployment is live, unlike `url` above.
      expect(verdict.address).toEqual({
        recordType: 'CNAME',
        target: 'cname.vercel-dns.com',
        proxied: true,
      });
    }
    // WAITING is entered once however many polls it took: three events saying
    // the same thing is not progress a reader can use.
    const waiting = events.filter(
      (event) => event.type === 'status' && event.phase === 'WAITING',
    );
    expect(waiting).toHaveLength(1);
  });

  test('a red deployment is a BUILD_FAILED the developer owns', async () => {
    const { adapter } = adapterFor({ settlesOn: 'ERROR' });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('BUILD_FAILED');
      expect(blameFor(verdict.reason)).toBe('developer');
      expect(verdict.detail).toContain('did not succeed');
      // The raw payload is kept for the operator (§6).
      expect(verdict.debug).toBeDefined();
    }
  });

  test('a cancelled deployment is REJECTED rather than a build failure', async () => {
    const { adapter } = adapterFor({ settlesOn: 'CANCELED' });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('REJECTED');
  });

  test('a refused create is the platform’s refusal, not a build failure', async () => {
    const { adapter } = adapterFor({
      refuseCreate: {
        status: 402,
        body: { error: { code: 'plan', message: 'payment required' } },
      },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('REJECTED');
  });

  test('a deployment that never settles is TIMEOUT and indicts nobody', async () => {
    const { api } = adapterFor({ pollsBeforeSettling: 1_000 });
    let now = 0;
    const adapter = new VercelDeployAdapter({
      token: api.token,
      artifactToken: api.token,
      fetch: api.fetch,
      pollIntervalMs: 1,
      // Every poll costs a minute, so the ten-minute budget runs out long
      // before the fake would ever settle.
      sleep: async () => {
        now += 60_000;
      },
      now: () => now,
      timeoutMs: 5 * 60_000,
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('FAILED');
    if (verdict.phase === 'FAILED') {
      expect(verdict.reason).toBe('TIMEOUT');
      expect(blameFor(verdict.reason)).toBeNull();
    }
  });
});

describe('§13: the checklist is standing, and connect always succeeds', () => {
  test('a team that answers meets every item', async () => {
    const { adapter } = adapterFor();
    const inspection = await adapter.inspect(TARGET);

    expect(inspection.prerequisites.map((item) => item.name)).toEqual([
      'PLATFORM_API',
      'API_TOKEN',
      'VESSEL',
    ]);
    expect(deriveHealth(inspection.prerequisites, 'vercel')).toBe('healthy');
  });

  test('a refused token is API_TOKEN, not a missing team', async () => {
    const { adapter } = adapterFor({
      refuseList: {
        status: 403,
        body: { error: { code: 'forbidden', message: 'not authorized' } },
      },
    });
    const inspection = await adapter.inspect(TARGET);
    const byName = new Map(
      inspection.prerequisites.map((item) => [item.name, item]),
    );

    expect(byName.get('PLATFORM_API')?.met).toBe(true);
    expect(byName.get('API_TOKEN')?.met).toBe(false);
    // Not assessed rather than met: a platform that refused to answer has not
    // said whether the team is there.
    expect(byName.get('VESSEL')?.assessed).toBe(false);
    // The surface is undetermined, never absent: every team can hold projects,
    // so no refusal means "this boundary does not do deployments".
    expect(inspection.surface?.kind).toBe('undetermined');
  });

  test('a team that is not there is VESSEL, and Spindrift creates none', async () => {
    const { adapter } = adapterFor();
    const inspection = await adapter.inspect({
      ...TARGET,
      connection: { ...CONNECTION, team: 'somebody-elses-team' },
    });
    const byName = new Map(
      inspection.prerequisites.map((item) => [item.name, item]),
    );

    expect(byName.get('API_TOKEN')?.met).toBe(true);
    expect(byName.get('VESSEL')?.met).toBe(false);
    expect(byName.get('VESSEL')?.detail).toContain('never creates a vessel');
  });
});

describe('§17: nothing runs here, and saying so is the answer', () => {
  test('tail, run and executions all refuse with one sentence', async () => {
    const { adapter } = adapterFor();
    const subject = { app: 'shop', component: 'site' };

    const tailed = await adapter.tail(TARGET, subject);
    const ran = await adapter.run(TARGET, `${CONNECTION.team}/projects/x`);
    const runs = await adapter.executions(
      TARGET,
      `${CONNECTION.team}/projects/x`,
    );

    expect(tailed.kind).toBe('none');
    expect(ran.kind).toBe('none');
    expect(runs.kind).toBe('none');
    if (tailed.kind === 'none' && ran.kind === 'none' && runs.kind === 'none') {
      expect(new Set([tailed.because, ran.because, runs.because]).size).toBe(1);
    }
  });
});

describe('destroy takes the project, and is idempotent', () => {
  test('a project that is already gone is a destroy that succeeded', async () => {
    const { api, adapter } = adapterFor();
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    await adapter.destroy(TARGET, verdict.ref);
    expect(api.hasProject(PROJECT)).toBe(false);
    await adapter.destroy(TARGET, verdict.ref);
  });

  test('a destroy the platform refused is raised, never reported as done', async () => {
    const { adapter } = adapterFor({
      refuseDelete: {
        status: 409,
        body: { error: { code: 'conflict', message: 'being transferred' } },
      },
    });
    const { verdict } = await drain(adapter.apply(TARGET, desired()));
    if (verdict.phase !== 'LIVE') throw new Error('nothing was placed');

    await expect(adapter.destroy(TARGET, verdict.ref)).rejects.toThrow(
      /could not be destroyed/,
    );
  });
});

describe('one project per (App, Component)', () => {
  test('a long name keeps a digest tail rather than colliding', () => {
    const long = { app: 'a'.repeat(90), component: 'web' };
    const other = { app: 'a'.repeat(90), component: 'api' };

    expect(projectName(long as DesiredState).length).toBeLessThanOrEqual(100);
    expect(projectName(long as DesiredState)).not.toBe(
      projectName(other as DesiredState),
    );
  });
});

describe('a re-apply finds the deployment it already made', () => {
  /** Drive a stream to the first matching event, then abandon it mid-flight. */
  async function abandonAfter(
    stream: AsyncGenerator<DeployEvent, DeployVerdict, void>,
    matches: (event: DeployEvent) => boolean,
  ): Promise<void> {
    let step = await stream.next();
    while (!step.done) {
      if (matches(step.value)) return;
      step = await stream.next();
    }
    throw new Error('the stream ended before the awaited event');
  }

  test('a second apply adopts the deployment carrying its Deploy', async () => {
    const { api, adapter } = adapterFor();
    const first = await drain(adapter.apply(TARGET, desired()));
    expect(first.verdict.phase).toBe('LIVE');

    const again = await drain(adapter.apply(TARGET, desired()));

    expect(again.verdict.phase).toBe('LIVE');
    // One deployment ever: the second apply found the first one by its
    // DEPLOY_META and said so, rather than creating a production sibling.
    expect(api.deploymentCount).toBe(1);
    expect(
      again.events.some(
        (event) => event.type === 'log' && event.line.includes('adopting'),
      ),
    ).toBe(true);
    // And it spent nothing getting there: no second fetch of the bundle, no
    // second upload of its files.
    expect(
      api.requests.filter((request) => request.path === '/v2/files'),
    ).toHaveLength(2);
  });

  test('an attempt that died after creating is recovered, not orphaned', async () => {
    const { api, adapter } = adapterFor({ pollsBeforeSettling: 3 });
    // The first attempt creates the deployment and dies before any verdict —
    // the lease-reclaim shape: nothing recorded, the far side already real.
    await abandonAfter(
      adapter.apply(TARGET, desired()),
      (event) =>
        event.type === 'log' && event.line.startsWith('created deployment'),
    );

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    // The re-run adopted the mid-flight deployment and drove it to the
    // platform's own verdict; a second production deployment never existed.
    expect(verdict.phase).toBe('LIVE');
    expect(api.deploymentCount).toBe(1);
  });

  test('a deployment the platform failed is not adopted — its successor is the retry', async () => {
    const { api, adapter } = adapterFor({ settlesOn: 'ERROR' });
    const first = await drain(adapter.apply(TARGET, desired()));
    expect(first.verdict.phase).toBe('FAILED');

    const again = await drain(adapter.apply(TARGET, desired()));

    // A failed deployment never served, so creating its successor is what a
    // retry is; adopting it would pin the Deploy to a corpse.
    expect(again.verdict.phase).toBe('FAILED');
    expect(api.deploymentCount).toBe(2);
  });
});
