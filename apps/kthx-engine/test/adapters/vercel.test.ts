/**
 * The Vercel deploy adapter against a fake of the platform API, with real
 * gzipped tars from `test/harness/tar.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

/** The project `vercelProjectName` gives App `shop`, Component `site`. */
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
 * A `vercel-output` artifact: the Build Output tree under `.vercel/output/`,
 * with the files a function's `filePathMap` names at the root beside it.
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

/**
 * The tree with its symlinks lifted out into the manifest the adapter recreates
 * them from, each path relative to the deployment root.
 */
function linkedTree(
  links: readonly { path: string; target: string }[],
): Uint8Array<ArrayBuffer> {
  return tarball([
    { name: '.vercel/output/config.json', bytes: bytes('{"version":3}') },
    {
      name: '.vercel/output/functions/index.func/.vc-config.json',
      bytes: bytes('{"runtime":"nodejs20.x"}'),
    },
    {
      name: '.vercel/output/__spindrift/func-links.json',
      bytes: bytes(JSON.stringify(links)),
    },
  ]);
}

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
      // One fake stands for both the platform and the artifact registry.
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
    // With all three null, the platform serves the upload and builds nothing.
    expect(settings.framework).toBeNull();
    expect(settings.buildCommand).toBeNull();
    expect(settings.installCommand).toBeNull();
  });

  test('the files are uploaded before the deployment references them', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));

    // The fake refuses a deployment that references a file it never received,
    // so a served project proves the order.
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
  const buildOutput = () =>
    desired({
      artifact: {
        type: 'vercel-output',
        digest: 'sha256:ssr',
        refs: [`${DEPOT}/bundles/sha256:ssr`],
      },
    });

  /**
   * Stands in for `vercel deploy`: records the directory and inputs, and
   * registers the deployment the real CLI would create.
   */
  function cliAdapter(tree: Uint8Array<ArrayBuffer> = OUTPUT_TREE): {
    api: FakeVercel;
    adapter: VercelDeployAdapter;
    calls: PrebuiltDeployInput[];
    trees: string[][];
    /** Every symlink in the tree the CLI was handed, as `path -> target`. */
    links: Record<string, string>[];
  } {
    const calls: PrebuiltDeployInput[] = [];
    const trees: string[][] = [];
    const links: Record<string, string>[] = [];
    let api!: FakeVercel;
    const deploy: PrebuiltDeploy = async (input) => {
      calls.push(input);
      trees.push(
        (
          await Array.fromAsync(
            // Without `dot: true` the glob skips `.vercel/`.
            new Bun.Glob('**/*').scan({ cwd: input.directory, dot: true }),
          )
        ).sort(),
      );
      const found: Record<string, string> = {};
      for (const entry of await readdir(input.directory, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isSymbolicLink()) continue;
        const at = join(entry.parentPath, entry.name);
        found[relative(input.directory, at)] = await readlink(at);
      }
      links.push(found);
      api.recordPrebuiltDeploy({ project: input.project, meta: input.meta });
      return { ok: true };
    };
    const built = adapterFor(
      { bundle: { origin: DEPOT, bytes: tree } },
      deploy,
    );
    api = built.api;
    return { ...built, calls, trees, links };
  }

  test('the CLI deploys the staged tree, and the platform’s answer is the verdict', async () => {
    const { api, adapter } = cliAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, buildOutput()));

    expect(verdict.phase).toBe('LIVE');
    // The adapter finds the CLI's deployment by the meta it set.
    expect(api.servedPrebuilt(PROJECT)).toBe(true);
  });

  test('the CLI is handed the deployment tree, the project, and this Deploy’s meta', async () => {
    const { adapter, calls, trees } = cliAdapter();
    await drain(adapter.apply(TARGET, buildOutput()));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.project).toBe(PROJECT);
    expect(calls[0]?.team).toBe(CONNECTION.team);
    expect(calls[0]?.meta.spindriftDeploy).toBe('deploy-1');
    expect(trees[0]).toContain('.vercel/output/config.json');
    expect(trees[0]).toContain('node_modules/@scope/dep/index.js');
  });

  test('the symlinks the build lifted out are back before the CLI runs, and the manifest is not', async () => {
    const { adapter, trees, links } = cliAdapter(
      linkedTree([
        { path: '.vercel/output/functions/home.func', target: 'index.func' },
        {
          path: '.vercel/output/functions/home.segments/_tree.segment.rsc.func',
          target: '../index.func',
        },
      ]),
    );
    const { verdict } = await drain(adapter.apply(TARGET, buildOutput()));

    expect(verdict.phase).toBe('LIVE');
    // Recreated as links with the target verbatim: the platform counts a
    // linked function as the one it points at.
    expect(links[0]).toEqual({
      '.vercel/output/functions/home.func': 'index.func',
      '.vercel/output/functions/home.segments/_tree.segment.rsc.func':
        '../index.func',
    });
    expect(trees[0]).not.toContain(
      '.vercel/output/__spindrift/func-links.json',
    );
  });

  test('a link out of the deployment is refused as the build’s defect', async () => {
    const { adapter, calls } = cliAdapter(
      linkedTree([
        { path: '.vercel/output/functions/home.func', target: '../../../..' },
      ]),
    );
    const { verdict } = await drain(adapter.apply(TARGET, buildOutput()));

    expect(verdict.phase).toBe('FAILED');
    expect(verdict.phase === 'FAILED' && verdict.reason).toBe('BUILD_FAILED');
    expect(calls).toHaveLength(0);
  });

  test('a chain of links that only escapes once it is followed is refused too', async () => {
    // `a` links to `.vercel`, so `a/c` is made at `.vercel/c` and its target
    // resolves to a missing `secret` at the root, which realpath refuses.
    const { adapter, calls } = cliAdapter(
      linkedTree([
        { path: '.vercel/output/a', target: '..' },
        { path: '.vercel/output/a/c', target: '../secret' },
      ]),
    );
    const { verdict } = await drain(adapter.apply(TARGET, buildOutput()));

    expect(verdict.phase).toBe('FAILED');
    expect(verdict.phase === 'FAILED' && verdict.reason).toBe('BUILD_FAILED');
    expect(calls).toHaveLength(0);
  });

  test('a plain files artifact is still deployed the way it always was', async () => {
    const { api, adapter } = adapterFor();
    await drain(adapter.apply(TARGET, desired()));

    expect(api.servedPrebuilt(PROJECT)).toBe(false);
    expect(api.servedPaths(PROJECT)).toEqual(['assets/app.css', 'index.html']);
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
    api: FakeVercel;
    adapter: VercelDeployAdapter;
    signed: string[];
    fetched: string[];
  } {
    // A signed URL points at the storage host, so the fake depot serves there.
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
    // An upload has no registry reference, and HTTP clients cannot fetch gs://.
    const { api, adapter, signed, fetched } = depotAdapter();
    const { verdict } = await drain(adapter.apply(TARGET, supplied(OBJECT)));

    expect(verdict.phase).toBe('LIVE');
    expect(api.servedPaths(PROJECT)).toEqual(['assets/app.css', 'index.html']);
    // The federated identity signs; the fetch uses the signed URL.
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
      // The API answers a bare host; the adapter adds the scheme.
      expect(verdict.url).toBe(`https://${PROJECT}.vercel.app`);
      // Every Vercel project uses the same vendor CNAME.
      expect(verdict.address).toEqual({
        recordType: 'CNAME',
        target: 'cname.vercel-dns.com',
        proxied: true,
      });
    }
    // WAITING is emitted once, however many polls it takes.
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
      // Every poll costs a minute, so the five-minute budget runs out long
      // before the fake settles.
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
    // A refused listing says nothing about whether the team exists.
    expect(byName.get('VESSEL')?.assessed).toBe(false);
    // Every team can hold projects, so a refusal never makes it absent.
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
    // The second apply finds the first deployment by its Deploy meta.
    expect(api.deploymentCount).toBe(1);
    expect(
      again.events.some(
        (event) => event.type === 'log' && event.line.includes('adopting'),
      ),
    ).toBe(true);
    // Only the first apply's two files were uploaded.
    expect(
      api.requests.filter((request) => request.path === '/v2/files'),
    ).toHaveLength(2);
  });

  test('an attempt that died after creating is recovered, not orphaned', async () => {
    const { api, adapter } = adapterFor({ pollsBeforeSettling: 3 });
    // The first attempt creates the deployment and dies before any verdict, as
    // when a lease is reclaimed.
    await abandonAfter(
      adapter.apply(TARGET, desired()),
      (event) =>
        event.type === 'log' && event.line.startsWith('created deployment'),
    );

    const { verdict } = await drain(adapter.apply(TARGET, desired()));

    expect(verdict.phase).toBe('LIVE');
    expect(api.deploymentCount).toBe(1);
  });

  test('a deployment the platform failed is not adopted — its successor is the retry', async () => {
    const { api, adapter } = adapterFor({ settlesOn: 'ERROR' });
    const first = await drain(adapter.apply(TARGET, desired()));
    expect(first.verdict.phase).toBe('FAILED');

    const again = await drain(adapter.apply(TARGET, desired()));

    // A failed deployment never served, so a retry creates a new one.
    expect(again.verdict.phase).toBe('FAILED');
    expect(api.deploymentCount).toBe(2);
  });
});
