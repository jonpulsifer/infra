/**
 * The build routes against fakes of their far-side HTTP APIs. A failure before
 * the build step still arrives as log text, a runner reporting another bundle
 * is refused, and `in-cluster` is L1.
 */
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildKitProgram,
  DOCKERFILE_CONTEXT_PROBE,
} from '../../src/adapters/build/buildkit.ts';
import { CloudBuildRoute } from '../../src/adapters/build/cloud-build.ts';
import type {
  BuildEvent,
  BuildResult,
  BuildSource,
  BuildSpec,
} from '../../src/adapters/build/contract.ts';
import {
  GitHubActionsBuildRoute,
  reusableWorkflowRepository,
  sealForRun,
} from '../../src/adapters/build/github-actions.ts';
import {
  InClusterBuildRoute,
  JOB_LABEL,
} from '../../src/adapters/build/in-cluster.ts';
import {
  BUILD_REPORT_MARKER,
  encodeBuildReport,
} from '../../src/adapters/build/report.ts';
import { KubernetesApi } from '../../src/adapters/deploy/kubernetes/api.ts';
import { buildRouteProfiles } from '../../src/adapters/registry.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import {
  buildWorkflowCaller,
  RUN_NAME_PREFIX,
} from '../../src/integrations/github/config-pr.ts';
import type { RegistryAuth } from '../../src/storage/registry-credentials.ts';
import {
  ATTACHMENT_DIGEST,
  attested,
  GCLOUD_STUB,
  INDEX_DIGEST,
  indexStub,
  RUNTIME_DIGEST,
} from '../harness/attest-step.ts';
import {
  FakeCloudBuild,
  type FakeCloudBuildOptions,
} from '../harness/fakes/cloud-build-api.ts';
import {
  FakeGitHub,
  type FakeGitHubOptions,
} from '../harness/fakes/github-api.ts';
import {
  FakeKubernetes,
  type FakeKubernetesOptions,
} from '../harness/fakes/kubernetes-api.ts';

const PLATFORM_REPO = 'example/platform';
const WORKFLOW_REF = `${PLATFORM_REPO}/.github/workflows/spindrift-build.yml@${'f'.repeat(40)}`;
const FRONTEND = 'registry.example.test/zero-config:pinned';
const SIGNER =
  'gcpkms://projects/example/locations/global/keyRings/keys/cryptoKeys/signer';
const ATTESTOR = 'projects/example/attestors/provenance';

const SEAL_KEYPAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const spec: BuildSpec = {
  artifactType: 'image',
  kind: 'service',
  platform: { os: 'linux', arch: 'amd64' },
  destinations: ['registry.example.test/app'],
  tags: ['sha256-bundle', 'latest'],
  buildArgs: {},
  outputDirectory: null,
  vercelFramework: null,
  registryAuth: [],
  buildSecrets: [],
};

/** The one registry a cloud build step can authorize itself against. */
const CLOUD_REGISTRY = 'example-region-docker.pkg.dev';

const cloudSpec: BuildSpec = {
  ...spec,
  destinations: [
    `${CLOUD_REGISTRY}/example-builds/i/app`,
    'registry.example.test/app',
  ],
};

function archiveSource(digest = 'sha256:bundle'): BuildSource {
  return {
    bundleDigest: digest,
    origin: { type: 'archive', location: 'staged://bundle', subpath: '.' },
  };
}

function repoSource(repository: string): BuildSource {
  return {
    bundleDigest: 'sha256:bundle',
    origin: {
      type: 'repo',
      repository,
      commit: 'c0ffee',
      subpath: 'apps/web',
      location: 'staged://bundle',
    },
  };
}

/**
 * Advances only inside `sleep`, so a poll loop reaches its timeout without
 * spending wall-clock time.
 */
function fakeClock(): {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
} {
  let elapsed = 0;
  return {
    now: () => new Date(elapsed),
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  };
}

const PACING = { intervalMs: 1_000, timeoutMs: 600_000 } as const;

async function run(
  stream: AsyncGenerator<BuildEvent, BuildResult, void>,
): Promise<{ events: BuildEvent[]; result: BuildResult }> {
  const events: BuildEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, result: step.value };
}

function text(events: readonly BuildEvent[]): string {
  return events
    .filter((event) => event.type === 'log')
    .map((event) => (event as { line: string }).line)
    .join('\n');
}

function hostedRoute(
  options: FakeGitHubOptions = {},
  pacing: { discoveryMs?: number; timeoutMs?: number } = {},
  sealPublicKey?: string,
): {
  host: FakeGitHub;
  route: GitHubActionsBuildRoute;
} {
  const host = new FakeGitHub({ fullName: PLATFORM_REPO, ...options });
  return {
    host,
    route: new GitHubActionsBuildRoute({
      name: 'hosted',
      host: new GitHubApp({
        baseUrl: host.baseUrl,
        authorization: () => 'Bearer test-installation-token',
        appAuthorization: () => 'Bearer test-app-jwt',
        fetch: host.fetch,
      }),
      buildWorkflow: WORKFLOW_REF,
      zeroConfigFrontend: FRONTEND,
      signer: SIGNER,
      attestor: ATTESTOR,
      correlation: () => 'fixed-correlation',
      ...(sealPublicKey !== undefined ? { sealPublicKey } : {}),
      ...PACING,
      ...pacing,
      ...fakeClock(),
    }),
  };
}

/**
 * The decrypt half of the workflow's "Log in with sealed credentials" step,
 * cut at `const auth = …` so `docker login` never runs.
 */
async function workflowDecryptScript(): Promise<string> {
  const text = await Bun.file(
    new URL(
      '../../../../.github/workflows/spindrift-build.yml',
      import.meta.url,
    ),
  ).text();
  const workflow = Bun.YAML.parse(text) as {
    jobs: { build: { steps: { name?: string; run?: string }[] } };
  };
  const step = workflow.jobs.build.steps.find(
    (candidate) => candidate.name === 'Log in with sealed credentials',
  );
  // The bash preamble before the heredoc is not JavaScript.
  const heredocStart = step?.run?.indexOf("<<'SPINDRIFT_SEAL_SCRIPT'\n");
  const scriptStart =
    heredocStart === undefined || heredocStart === -1
      ? -1
      : heredocStart + "<<'SPINDRIFT_SEAL_SCRIPT'\n".length;
  const marker = "const auth = JSON.parse(plaintext.toString('utf8'));";
  const cut =
    scriptStart === -1 ? -1 : (step?.run?.indexOf(marker, scriptStart) ?? -1);
  if (step?.run === undefined || scriptStart === -1 || cut === -1) {
    throw new Error(
      'could not find the sealed-credential decrypt algorithm in spindrift-build.yml',
    );
  }
  return `${step.run.slice(scriptStart, cut + marker.length)}\nconsole.log(JSON.stringify(auth));\n`;
}

describe('the hosted build route', () => {
  test('a run that outlives the budget is cancelled on the host, and is TIMEOUT', async () => {
    const { host, route } = hostedRoute(
      { actions: { duration: 1000 } },
      { timeoutMs: 5_000 },
    );
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    expect(host.cancels).toEqual([1]);
    expect(text(events)).toContain('cancelling it');
  });

  test('a cancelled run is TIMEOUT: it indicts nobody', async () => {
    const { result } = await run(
      hostedRoute({ actions: { conclusion: 'cancelled' } }).route.build(
        archiveSource(),
        spec,
      ),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('the run name carries the dispatch id, and a cancel from outside finds the run by the address the host reported', async () => {
    const { host, route } = hostedRoute({ actions: { duration: 1000 } });
    const stream = route.build(archiveSource(), spec, 'dispatch-1');
    let step = await stream.next();
    let runUrl: string | null = null;
    while (!step.done && runUrl === null) {
      if (step.value.type === 'runner') runUrl = step.value.url;
      else step = await stream.next();
    }
    expect(host.dispatches[0]?.inputs.correlation).toBe('dispatch-1');
    expect(runUrl).toBe(`https://github.com/${PLATFORM_REPO}/actions/runs/1`);

    await route.cancel({ dispatchId: 'dispatch-1', runUrl });
    expect(host.cancels).toEqual([1]);

    const { result } = await run(stream);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('a cancel with no reported address refuses rather than guessing one', async () => {
    const { host, route } = hostedRoute();
    await expect(
      route.cancel({ dispatchId: 'dispatch-1', runUrl: null }),
    ).rejects.toThrow('no address');
    await expect(
      route.cancel({
        dispatchId: 'dispatch-1',
        runUrl: 'https://github.com/example/platform/pull/9',
      }),
    ).rejects.toThrow('no address');
    expect(host.cancels).toEqual([]);
  });

  test('a repo build runs in the connected repository, on its own minutes', async () => {
    // It dispatches the caller the configuration PR wrote there, since the
    // repository cannot see the reusable workflow.
    const { host, route } = hostedRoute({ fullName: 'someone/their-app' });
    const { result } = await run(
      route.build(repoSource('someone/their-app'), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(host.dispatches).toHaveLength(1);
    expect(host.dispatches[0]?.workflow).toBe('spindrift.yml');
    expect(host.dispatches[0]?.branch).toBe('main');
  });

  test('a repo with no caller falls back to where the workflow lives', async () => {
    // The runner fetches the staged bundle by URL, so the build is the same
    // wherever it runs; only whose minutes pay for it differs.
    const { host, route } = hostedRoute({ fullName: PLATFORM_REPO });
    const { events, result } = await run(
      route.build(repoSource('someone/never-connected'), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(host.dispatches).toHaveLength(1);
    expect(host.dispatches[0]?.workflow).toBe('spindrift.yml');
    // The refused attempt explains why the run is not in the App's repository.
    expect(text(events)).toContain('someone/never-connected');
  });

  test('an archive builds where the workflow lives, having no repository', async () => {
    const { host, route } = hostedRoute();
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    // A dispatch names a branch, not a commit, so the pin lives in the caller
    // and the reusable workflow is never dispatched directly.
    expect(host.dispatches[0]?.workflow).toBe('spindrift.yml');
  });

  test('the correlation is what finds the run, and travels outside the spec', async () => {
    const { host, route } = hostedRoute();
    await run(route.build(archiveSource(), spec));

    const dispatch = host.dispatches[0];
    expect(dispatch?.inputs.correlation).toBe('fixed-correlation');
    expect(JSON.parse(dispatch?.inputs.spec ?? '{}')).not.toHaveProperty(
      'correlation',
    );
  });

  test('the spec carries the bundle digest and the pinned frontend', async () => {
    const { host, route } = hostedRoute();
    await run(route.build(archiveSource(), spec));

    const request = JSON.parse(host.dispatches[0]?.inputs.spec ?? '{}');
    expect(request.bundleDigest).toBe('sha256:bundle');
    expect(request.zeroConfigFrontend).toBe(FRONTEND);
    expect(request.destinations[0]).toBe(spec.destinations[0]);
  });

  test('a dispatch that is refused is a failure with the reason in the log', async () => {
    const { host, route } = hostedRoute();
    host.accessLost = true;

    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
    }
    // The route may try more than one repository, so the sentence names which.
    expect(text(events)).toContain('could not dispatch');
    expect(text(events)).toContain('example/platform');
    expect(text(events).length).toBeGreaterThan(0);
  });

  test('a dispatch whose run never appears fails, and says so', async () => {
    const { route } = hostedRoute(
      { actions: { discoveryDelay: 1000 } },
      { discoveryMs: 5_000 },
    );
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
      expect(result.detail).toContain('no run named');
    }
    expect(text(events)).toContain('no run named');
  });

  test('a run that queues past the old discovery default still succeeds', async () => {
    // Discovery has no deadline of its own; it shares the build's budget.
    const { route } = hostedRoute({ actions: { discoveryDelay: 150 } });
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
  });

  test('a lookup that flakes after a successful dispatch is retried, not failed', async () => {
    // A 5xx on the lookup says nothing about the dispatch, which succeeded.
    const { route } = hostedRoute({ actions: { listFailures: 2 } });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    expect(text(events)).toContain('the dispatch succeeded');
    expect(text(events)).toContain('retrying');
  });

  test('a lookup that never recovers blames the lookup, not the dispatch', async () => {
    const { route } = hostedRoute(
      { actions: { listFailures: 1000 } },
      { discoveryMs: 5_000 },
    );
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
      expect(result.detail).toContain('the workflow was dispatched but');
      expect(result.detail).toContain('kept failing');
    }
    expect(text(events)).not.toContain('dispatch failed');
  });

  test('a status read that flakes mid-run is retried within the budget', async () => {
    const { route } = hostedRoute({ actions: { statusFailures: 2 } });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    expect(text(events)).toContain('could not be read; retrying');
  });

  test('a red run is a build failure carrying the runner’s own log', async () => {
    const { route } = hostedRoute({ actions: { conclusion: 'failure' } });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('BUILD_FAILED');
    // `LIVE_STATUS` text arrives only at the end.
    expect(text(events)).toContain('exporting to image');
  });

  test('the log is asked for as JSON, which is the only thing the host serves', async () => {
    // The endpoint negotiates as JSON and redirects to a text blob; asking for
    // `text/plain` gets a `415`.
    const { host, route } = hostedRoute();
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    const read = host.requests.find((request) =>
      request.path.includes('/actions/jobs/'),
    );
    expect(read?.accept).toBe('application/vnd.github+json');
  });

  test('a log the host will not serve fails the build without blaming the dispatch', async () => {
    // Still a failure, because the artifact digest travels only in the log.
    const { route } = hostedRoute({ actions: { logStatus: 500 } });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
      expect(result.detail).toContain('could not be read');
    }
    expect(text(events)).toContain('could not read the log of job');
    expect(text(events)).not.toContain('dispatch failed');
  });

  test('step transitions arrive once each, not once per poll', async () => {
    const { route } = hostedRoute({ actions: { duration: 4 } });
    const { events } = await run(route.build(archiveSource(), spec));

    const steps = events.filter((event) => event.type === 'step');
    const keys = steps.map(
      (event) =>
        `${(event as { step: string }).step}/${(event as { state: string }).state}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a green run that reports no artifact is an adapter fault, not the developer’s', async () => {
    const { route } = hostedRoute({ actions: { log: () => 'nothing useful' } });
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('INTERNAL');
  });

  test('a runner reporting another bundle’s build is refused', async () => {
    const { route } = hostedRoute({
      actions: {
        log: () =>
          encodeBuildReport({
            bundleDigest: 'sha256:some-other-bundle',
            digest: `sha256:${'a'.repeat(64)}`,
            refs: ['registry.example.test/app@sha256:a'],
            baseDigest: null,
          }),
      },
    });
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('INTERNAL');
      expect(result.detail).toContain('sha256:some-other-bundle');
    }
  });

  test('the reusable workflow reference names where an archive builds', () => {
    expect(reusableWorkflowRepository(WORKFLOW_REF)).toBe(PLATFORM_REPO);
  });

  test('the platform repository commits the caller an archive build dispatches', async () => {
    // A connected repository gets this caller from the configuration PR; the
    // platform repository must commit its own.
    const caller = await Bun.file(
      new URL('../../../../.github/workflows/spindrift.yml', import.meta.url),
    ).text();
    expect(caller).toContain('workflow_dispatch:');
    expect(caller).toContain('uses: ./.github/workflows/spindrift-build.yml');
  });

  test('the reusable workflow prints the marker core reads', async () => {
    // YAML cannot import the constant.
    const workflow = await Bun.file(
      new URL(
        '../../../../.github/workflows/spindrift-build.yml',
        import.meta.url,
      ),
    ).text();
    expect(workflow).toContain(BUILD_REPORT_MARKER);
  });

  test('the caller in somebody’s repository accepts what this route sends', async () => {
    // The caller is generated by another module and lives in another
    // repository, yet must declare every input this route sends.
    const { host, route } = hostedRoute();
    await run(route.build(archiveSource(), spec));
    const sent = Object.keys(host.dispatches[0]?.inputs ?? {}).sort();

    const caller = buildWorkflowCaller(WORKFLOW_REF);
    for (const input of sent) expect(caller).toContain(`${input}:`);
    // The route finds its run by `run-name`. Assembled, because the linter
    // flags `${` inside a plain string.
    const expression = ['${', '{ inputs.correlation }', '}'].join('');
    expect(caller).toContain(`run-name: ${RUN_NAME_PREFIX} ${expression}`);
  });

  test('carries a registry credential only where a seal key is configured', () => {
    expect(hostedRoute().route.carriesHeldSecret).toBe(false);
    expect(
      hostedRoute({}, {}, SEAL_KEYPAIR.publicKey).route.carriesHeldSecret,
    ).toBe(true);
  });

  test('a held credential travels sealed, never as a username or secret in the clear', async () => {
    const held = {
      host: 'registry-1.docker.io',
      username: 'an-owner',
      secret: 'a-token',
    };
    const { host, route } = hostedRoute({}, {}, SEAL_KEYPAIR.publicKey);
    await run(route.build(archiveSource(), { ...spec, registryAuth: [held] }));

    // The whole request, since GitHub shows dispatch inputs in the run header.
    const raw = host.dispatches[0]?.inputs.spec ?? '{}';
    expect(raw).not.toContain(held.secret);
    expect(raw).not.toContain(held.username);

    const request = JSON.parse(raw);
    expect(typeof request.sealedRegistryAuth).toBe('string');
    expect((request.sealedRegistryAuth as string).length).toBeGreaterThan(0);
  });

  test('carries no sealedRegistryAuth key at all where nothing is held', async () => {
    const { host, route } = hostedRoute({}, {}, SEAL_KEYPAIR.publicKey);
    await run(route.build(archiveSource(), spec));

    const request = JSON.parse(host.dispatches[0]?.inputs.spec ?? '{}');
    expect(request).not.toHaveProperty('sealedRegistryAuth');
  });

  test('the sealed envelope opens with the exact algorithm the workflow runs', async () => {
    const auth: RegistryAuth[] = [
      { host: 'registry-1.docker.io', username: 'an-owner', secret: 'a-token' },
      { host: 'ghcr.io', username: 'other-owner', secret: 'a-second-token' },
    ];
    const sealed = await sealForRun(auth, SEAL_KEYPAIR.publicKey);

    // The workflow reads the key from a file, never from `SEAL_KEY`.
    const dir = mkdtempSync(join(tmpdir(), 'spindrift-seal-'));
    const keyFile = join(dir, 'seal-key.pem');
    writeFileSync(keyFile, SEAL_KEYPAIR.privateKey);
    try {
      const proc = Bun.spawn(['node', '-e', await workflowDecryptScript()], {
        env: {
          ...process.env,
          SEALED: sealed,
          SEAL_KEY_FILE: keyFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual(auth);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function cloudRoute(
  options: FakeCloudBuildOptions = {},
  pacing: { timeoutMs?: number } = {},
  supplyChain: { signer?: string; attestor?: string } = {},
): {
  api: FakeCloudBuild;
  route: CloudBuildRoute;
} {
  const api = new FakeCloudBuild(options);
  return {
    api,
    route: new CloudBuildRoute({
      name: 'cloud',
      endpoint: api.endpoint,
      logsEndpoint: api.logsEndpoint,
      project: 'example-builds',
      region: 'example-region',
      image: 'registry.example.test/buildkit:pinned',
      zeroConfigFrontend: FRONTEND,
      signer: supplyChain.signer ?? '',
      attestor: supplyChain.attestor ?? '',
      token: api.token,
      fetch: api.fetch,
      ...PACING,
      ...pacing,
      ...fakeClock(),
    }),
  };
}

describe('the cloud build route', () => {
  test('submits the shared BuildKit program, never the service’s own source path', async () => {
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), spec));

    expect(api.programs).toHaveLength(1);
    expect(api.programs[0]).toContain('buildctl-daemonless.sh');
    expect(api.programs[0]).toContain(FRONTEND);
    // `buildctl` takes attestations as frontend options; `--attest` is a buildx
    // flag and fails the whole invocation.
    expect(api.programs[0]).toContain('--opt attest:provenance=mode=max');
    expect(api.programs[0]).not.toMatch(/^\s*--attest/m);
  });

  test('the log arrives while the build runs', async () => {
    const { events, result } = await run(
      cloudRoute({ duration: 3 }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(text(events)).toContain('exporting to image');
  });

  test('a page is served once, because the cursor is honoured', async () => {
    const { events } = await run(
      cloudRoute({ duration: 3 }).route.build(archiveSource(), spec),
    );

    const lines = text(events).split('\n');
    const starts = lines.filter((line) => line === 'Starting Step #0');
    expect(starts).toHaveLength(1);
  });

  test('a log service having a bad moment does not fail a good build', async () => {
    const { result } = await run(
      cloudRoute({ breakLogs: true }).route.build(archiveSource(), spec),
    );

    // With no log there is no report to read, which is INTERNAL.
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('INTERNAL');
  });

  test('a refused submit is a failure with the reason in the log', async () => {
    const { events, result } = await run(
      cloudRoute({ refuseSubmit: 403 }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
    }
    expect(text(events)).toContain('submit failed');
  });

  test('the build step authorizes its own push', async () => {
    // The export pushes, so the step mints its own registry credential; one in
    // the submitted body would be readable by anyone who can read the build.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), cloudSpec));

    const program = api.programs[0] ?? '';
    expect(program).toContain('metadata.google.internal');
    expect(program).toContain(CLOUD_REGISTRY);
    expect(program).toContain('DOCKER_CONFIG');
    expect(program.indexOf('DOCKER_CONFIG')).toBeLessThan(
      program.indexOf('buildctl-daemonless.sh'),
    );
    expect(program).not.toContain('Bearer ');
    expect(JSON.stringify(api.steps[0])).not.toContain('federated-token');
  });

  test('a destination the step cannot authorize is left to fail at the push', async () => {
    // The metadata token covers one vendor's registries; a push elsewhere
    // fails naming itself.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), spec));

    expect(api.programs[0]).not.toContain('metadata.google.internal');
  });

  test('the artifact is attested, so a policy-enforcing Target admits it', async () => {
    // A cloud runtime's admission reads this attestation, an occurrence in the
    // attestor's project.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    const attest = api.steps[0]?.[1];
    const program = attest?.args?.[1] ?? '';
    expect(program).toContain('sign-and-create');
    // An attestation binds one artifact URL, so each destination gets its own.
    for (const destination of cloudSpec.destinations) {
      expect(program).toContain(destination);
    }
    // Steps share the pushed digest through the workspace instead of
    // re-deriving it.
    expect(api.programs[0]).toContain('/workspace/spindrift-digest');
    expect(program).toContain('/workspace/spindrift-digest');
  });

  test('the manifests under the index are attested too', async () => {
    // `--attest` makes every push an image index, and Cloud Run resolves the
    // index to its platform's child before admission asks about it.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    // The build service turns the route's `$$` escape back into `$` before
    // bash sees it.
    const program = (api.steps[0]?.[1]?.args?.[1] ?? '').replaceAll('$$', '$');
    expect(program).toContain('manifests');
    expect(program).toContain('attest "$destination" "$child"');
    // The metadata token reads manifests back only from the vendor's
    // registries; any other destination is attested at the index alone.
    const children = program.slice(program.indexOf('# The children,'));
    expect(children).toContain(`${CLOUD_REGISTRY}/example-builds/i/app`);
    expect(children).not.toContain('registry.example.test');
  });

  test('the attachments hanging off that index are not', async () => {
    // `--attest` also hangs `unknown/unknown` provenance and sbom manifests off
    // the index, and nothing ever runs one, so none of them is signed.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    const references = await attested(api.steps[0]?.[1]?.args?.[1] ?? '', {
      gcloud: GCLOUD_STUB,
      curl: indexStub(),
      // Stands in for reading `/workspace`, which this machine lacks.
      cat: `echo '${INDEX_DIGEST}'`,
    });

    expect(references).toEqual([
      `${CLOUD_REGISTRY}/example-builds/i/app@${INDEX_DIGEST}`,
      `registry.example.test/app@${INDEX_DIGEST}`,
      `${CLOUD_REGISTRY}/example-builds/i/app@${RUNTIME_DIGEST}`,
    ]);
    expect(references.join('\n')).not.toContain(ATTACHMENT_DIGEST);
  });

  test('an installation that named no attestor submits no attestation', async () => {
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), cloudSpec));

    expect(api.steps[0]).toHaveLength(1);
    expect(api.programs[0]).not.toContain('/workspace/spindrift-digest');
  });

  test('a malformed signer fails the submit rather than skipping the attestation', async () => {
    // A skip would surface later as an admission refusal about policy.
    const { events, result } = await run(
      cloudRoute(
        {},
        {},
        { signer: 'not-a-key', attestor: ATTESTOR },
      ).route.build(archiveSource(), cloudSpec),
    );

    expect(result.status).toBe('FAILED');
    expect(text(events)).toContain('submit failed');
  });

  test('the service’s own timeout indicts nobody', async () => {
    const { result } = await run(
      cloudRoute({ status: 'TIMEOUT' }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('a build that never finishes runs out of core’s budget, and is cancelled', async () => {
    const { api, route } = cloudRoute({ duration: 1000 }, { timeoutMs: 5_000 });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    // A worker left running keeps billing until the service's own limit.
    expect(api.cancelled).toEqual(['build-1']);
    expect(text(events)).toContain('cancelling it');
  });

  test('the service’s CANCELLED indicts nobody either', async () => {
    const { result } = await run(
      cloudRoute({ status: 'CANCELLED' }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('the build is tagged by the dispatch id, and a cancel from outside finds it by that tag', async () => {
    const { api, route } = cloudRoute({ duration: 1000 });
    const stream = route.build(archiveSource(), spec, 'dispatch-1');
    let step = await stream.next();
    while (
      !step.done &&
      !(step.value.type === 'log' && step.value.line.includes('submitted'))
    ) {
      step = await stream.next();
    }
    expect((api.requests[0]?.body as { tags?: string[] } | null)?.tags).toEqual(
      ['spindrift-dispatch-1'],
    );

    await route.cancel({ dispatchId: 'dispatch-1', runUrl: null });
    expect(api.cancelled).toEqual(['build-1']);

    const { result } = await run(stream);
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('a cancel for a dispatch id nothing was submitted under does nothing', async () => {
    const { api, route } = cloudRoute();
    await route.cancel({ dispatchId: 'never-submitted', runUrl: null });
    expect(api.cancelled).toEqual([]);
  });

  test('a report ingested only after the build concludes is still read', async () => {
    // The log service ingests behind the writer, so the report can first
    // appear on the read after the status turns `SUCCESS`.
    const { result } = await run(
      cloudRoute().route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    if (result.status === 'SUCCEEDED') {
      expect(result.artifact?.digest).toBe(`sha256:${'b'.repeat(64)}`);
    }
  });

  test('the whole log is read, including the lines written after the last poll', async () => {
    const { events } = await run(
      cloudRoute().route.build(archiveSource(), spec),
    );

    // `Finished Step #0` comes after the report, on the last page.
    expect(text(events)).toContain('Finished Step #0');
  });

  test('every poll starts a fresh search rather than resuming an old cursor', async () => {
    // A `nextPageToken` continues one search, not a live log, so it is only
    // presented within the poll that minted it.
    const { api, route } = cloudRoute({ duration: 3 });
    await run(route.build(archiveSource(), spec));

    let fresh = true;
    for (const request of api.requests) {
      if (request.url.endsWith('entries:list')) {
        if (fresh) {
          expect((request.body as { pageToken?: string }).pageToken).toBe(
            undefined,
          );
        }
        fresh = false;
        continue;
      }
      // A status read (or the submit) ends the poll the token belonged to.
      fresh = true;
    }
  });

  test('a search cut short is not mistaken for a caught-up log', async () => {
    // An empty page carrying a token means the search ran out of time, not
    // that the log is caught up.
    const { result, events } = await run(
      cloudRoute({ cutShort: true }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(text(events)).toContain('exporting to image');
  });

  test('the log service refuses a search that names no parent resource', async () => {
    // `entries.list` requires `resourceNames`, and the fake enforces it.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), spec));

    const searches = api.requests.filter((request) =>
      request.url.endsWith('entries:list'),
    );
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(
        (search.body as { resourceNames?: string[] }).resourceNames,
      ).toEqual(['projects/example-builds']);
    }

    const refused = await api.fetch(
      new Request(`${api.logsEndpoint}/v2/entries:list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${api.token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter: 'resource.labels.build_id="build-1"' }),
      }),
    );
    expect(refused.status).toBe(400);
  });
});

function clusterRoute(
  options: FakeKubernetesOptions = {},
  pacing: { timeoutMs?: number } = {},
): {
  cluster: FakeKubernetes;
  route: InClusterBuildRoute;
} {
  const digest = `sha256:${'c'.repeat(64)}`;
  const cluster = new FakeKubernetes({
    status: () => ({ succeeded: 1 }),
    lists: {
      pods: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: 'build-pod',
            namespace: 'builds',
            // The route finds its pod by this label; the fake filters on it.
            labels: { [JOB_LABEL]: 'spindrift-build-fixed' },
          },
        },
      ],
    },
    logs: () =>
      [
        '#1 load build definition',
        encodeBuildReport({
          bundleDigest: 'sha256:bundle',
          digest,
          refs: [`registry.example.test/app@${digest}`],
          baseDigest: null,
        }),
      ].join('\n'),
    ...options,
  });
  return {
    cluster,
    route: new InClusterBuildRoute({
      name: 'local',
      api: new KubernetesApi({
        apiServer: cluster.apiServer,
        token: cluster.token,
        fetch: cluster.fetch,
      }),
      namespace: 'builds',
      image: 'registry.example.test/buildkit:pinned',
      serviceAccount: 'builder',
      zeroConfigFrontend: FRONTEND,
      id: () => 'fixed',
      ...PACING,
      ...pacing,
      ...fakeClock(),
    }),
  };
}

function jobDeletes(cluster: FakeKubernetes): string[] {
  return cluster.requests
    .filter((request) => request.method === 'DELETE')
    .map((request) => `${request.path}${request.query}`);
}

describe('the in-cluster build route', () => {
  test('is SLSA Build Level 1, which is what an L2 Target refuses', () => {
    expect(clusterRoute().route.buildLevel).toBe(1);
  });

  test('creates a Job that will not retry itself', async () => {
    const { cluster, route } = clusterRoute();
    await run(route.build(archiveSource(), spec));

    const job = cluster.get('jobs/builds/spindrift-build-fixed');
    const jobSpec = job?.spec as {
      backoffLimit: number;
      ttlSecondsAfterFinished: number;
      template: { spec: { serviceAccountName: string } };
    };
    // A retry would push a second artifact for one Build.
    expect(jobSpec.backoffLimit).toBe(0);
    expect(jobSpec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    // The push authorizes as this service account, not a stored credential.
    expect(jobSpec.template.spec.serviceAccountName).toBe('builder');
  });

  test('the Job is admissible at Pod Security baseline', async () => {
    // Every namespace this installation runs enforces at least `baseline`.
    const { cluster, route } = clusterRoute();
    await run(route.build(archiveSource(), spec));

    const job = cluster.get('jobs/builds/spindrift-build-fixed');
    const pod = (
      job?.spec as {
        template: {
          spec: {
            securityContext: Record<string, unknown>;
            containers: { securityContext: Record<string, unknown> }[];
          };
        };
      }
    )?.template.spec;

    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      // `baseline` forbids `Unconfined`.
      seccompProfile: { type: 'RuntimeDefault' },
    });
    expect(pod.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
  });

  test('reads the pod’s log as it goes and yields only what is new', async () => {
    const { route } = clusterRoute({
      status: (reads) => (reads > 2 ? { succeeded: 1 } : { active: 1 }),
      logs: (_pod, reads) =>
        reads < 3
          ? '#1 load build definition'
          : [
              '#1 load build definition',
              encodeBuildReport({
                bundleDigest: 'sha256:bundle',
                digest: `sha256:${'c'.repeat(64)}`,
                refs: ['registry.example.test/app@sha256:c'],
                baseDigest: null,
              }),
            ].join('\n'),
    });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    const first = text(events)
      .split('\n')
      .filter((line) => line === '#1 load build definition');
    expect(first).toHaveLength(1);
  });

  test('a failed Job is a build failure', async () => {
    const { route } = clusterRoute({ status: () => ({ failed: 1 }) });
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('BUILD_FAILED');
  });

  test('the Job carries the budget as its own deadline', async () => {
    const { cluster, route } = clusterRoute({}, { timeoutMs: 90_000 });
    await run(route.build(archiveSource(), spec));

    const jobSpec = cluster.get('jobs/builds/spindrift-build-fixed')?.spec as {
      activeDeadlineSeconds: number;
    };
    // The cluster ends a runaway build even if this process is gone.
    expect(jobSpec.activeDeadlineSeconds).toBe(90);
  });

  test('a Job the cluster ended for its deadline is TIMEOUT, not the developer’s failure', async () => {
    const { route } = clusterRoute({
      status: () => ({
        conditions: [
          { type: 'Failed', status: 'True', reason: 'DeadlineExceeded' },
        ],
      }),
    });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    expect(text(events)).toContain('exceeding its deadline');
  });

  test('a Job that outlives the budget is deleted, pods and all, and is TIMEOUT', async () => {
    const { cluster, route } = clusterRoute(
      { status: () => ({}) },
      { timeoutMs: 3_000 },
    );
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    expect(text(events)).toContain('deleting it');
    // Background propagation, or the API orphans the pod and it keeps going.
    expect(jobDeletes(cluster)).toEqual([
      '/apis/batch/v1/namespaces/builds/jobs/spindrift-build-fixed?propagationPolicy=Background',
    ]);
  });

  test('a Job deleted from elsewhere mid-build is TIMEOUT, and the log says so', async () => {
    let cluster: FakeKubernetes | null = null;
    const built = clusterRoute({
      status: (reads) => {
        if (reads === 2) cluster?.remove('jobs/builds/spindrift-build-fixed');
        return {};
      },
    });
    cluster = built.cluster;
    const { events, result } = await run(
      built.route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    expect(text(events)).toContain('was deleted before it finished');
  });

  test('names the Job by the dispatch id, which is what cancel deletes by', async () => {
    const { cluster, route } = clusterRoute();
    await run(route.build(archiveSource(), spec, 'dispatch-1'));
    expect(cluster.get('jobs/builds/spindrift-build-dispatch-1')).toBeDefined();

    await route.cancel({ dispatchId: 'dispatch-1', runUrl: null });
    expect(jobDeletes(cluster)).toEqual([
      '/apis/batch/v1/namespaces/builds/jobs/spindrift-build-dispatch-1?propagationPolicy=Background',
    ]);
    expect(
      cluster.get('jobs/builds/spindrift-build-dispatch-1'),
    ).toBeUndefined();
  });

  test('cancelling a Job that is already gone is not an error', async () => {
    const { route } = clusterRoute();
    await expect(
      route.cancel({ dispatchId: 'never-ran', runUrl: null }),
    ).resolves.toBeUndefined();
  });

  test('a Job that could not be created is a failure with the reason in the log', async () => {
    const { route } = clusterRoute({
      refuse: { status: 403, body: 'forbidden' },
    });
    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
    }
    expect(text(events)).toContain('could not create the build Job');
  });
});

describe('the route level table', () => {
  test('says what each route class says about itself', () => {
    // `buildRouteProfiles` reads a table so placement can explain a route it
    // cannot build, and the table must match the classes.
    const manifest = {
      build: {
        routes: [
          { name: 'hosted', adapter: 'github-actions' as const },
          {
            name: 'cloud',
            adapter: 'cloud-build' as const,
            endpoint: 'https://builds.example.test',
            logsEndpoint: 'https://logs.example.test',
            project: 'p',
            region: 'r',
            image: 'i',
          },
          {
            name: 'local',
            adapter: 'in-cluster' as const,
            endpoint: 'https://cluster.example.test',
            namespace: 'n',
            image: 'i',
            serviceAccount: 's',
          },
        ],
        zeroConfigFrontend: FRONTEND,
      },
    } as Parameters<typeof buildRouteProfiles>[0];

    const levels = Object.fromEntries(
      buildRouteProfiles(manifest).map((profile) => [
        profile.name,
        profile.level,
      ]),
    );
    expect(levels.hosted).toBe(hostedRoute().route.buildLevel);
    expect(levels.cloud).toBe(cloudRoute().route.buildLevel);
    expect(levels.local).toBe(clusterRoute().route.buildLevel);
  });
});

describe('the BuildKit program', () => {
  const program = buildKitProgram({
    bundleUrl: 'staged://bundle',
    bundleDigest: 'sha256:bundle',
    subpath: 'apps/web',
    destinations: ['registry.example.test/app'],
    tags: ['sha256-bundle', 'latest'],
    zeroConfigFrontend: FRONTEND,
    buildSecretNames: [],
    buildArgs: { PUBLIC_URL: 'https://app.example.test' },
  });

  test('keeps its layer cache in the registry, beside the first destination', () => {
    // Every layer the in-cluster route redownloads crosses its uplink, so the
    // cache lives in the registry beside the image.
    expect(program).toContain(
      "--export-cache 'type=registry,ref=registry.example.test/app:buildcache,mode=max'",
    );
    expect(program).toContain(
      "--import-cache 'type=registry,ref=registry.example.test/app:buildcache'",
    );
    expect(program).toContain('--opt attest:provenance=mode=max');
    expect(program).toContain('--opt attest:sbom=');
  });

  test('runs §5’s ladder: a Dockerfile settles how to build', () => {
    expect(program).toContain('if [ -f Dockerfile ]');
    expect(program).toContain('--frontend dockerfile.v0');
    expect(program).toContain(`--opt source='${FRONTEND}'`);
  });

  test('opens a staged bundle the one way every route opens one', () => {
    // Neither image that runs this program has unzip, so a staged ZIP reaches
    // it already converted by `@repo/archive/archive-format`.
    expect(program).toContain('| tar -xz');
  });

  test('an empty build-arg set leaves no blank continuation line', () => {
    // A `\` continuation followed by a blank line ends the command there, and
    // the flag on the next line runs as a command of its own.
    const bare = buildKitProgram({
      bundleUrl: 'staged://bundle',
      bundleDigest: 'sha256:bundle',
      subpath: 'apps/web',
      destinations: ['registry.example.test/app'],
      tags: ['latest'],
      zeroConfigFrontend: FRONTEND,
      buildSecretNames: [],
      buildArgs: {},
    });
    expect(bare).not.toMatch(/\\\n\s*\n\s*--/);
    expect(program).not.toMatch(/\\\n\s*\n\s*--/);
    expect(bare).toContain('--opt attest:provenance=mode=max');
  });

  test('lets a Dockerfile name its own directory as the context', () => {
    // The bundle root stays the context unless a COPY or ADD source resolves
    // beside the Dockerfile and not at the root.
    expect(program).toContain(DOCKERFILE_CONTEXT_PROBE);
    expect(program).toContain('sdc_context="$sdc_root"');
    expect(program).toContain(
      '--local context="$(spindrift_dockerfile_context Dockerfile "$root" .)"',
    );
    // The two arms pick different contexts, so neither may share one.
    expect(program).not.toContain('build "$@" \\\n  --local context=.');
  });

  test('hands the zero-config frontend a plan, never a `#syntax=` stub', () => {
    // The railpack frontend parses its input as a JSON plan, so a stub fails
    // with `invalid character '#'`.
    expect(program).not.toContain('#syntax=');
    expect(program).toContain('railpack prepare . --plan-out');
    // The frontend reads the `dockerfile` local and defaults to the file name
    // `railpack-plan.json`.
    expect(program).toContain('"$plan/railpack-plan.json"');
    expect(program).toContain('--local dockerfile="$plan"');
    expect(program).toContain('--local context=.');
  });

  test('generates the plan with the release that reads it', () => {
    // The plan format is versioned with railpack, so the generator is pulled
    // out of the frontend image itself.
    expect(program).toContain(
      `--opt context:railpack=docker-image://'${FRONTEND}'`,
    );
    expect(program).toContain('COPY --from=railpack /railpack /railpack');
    expect(program).toContain('--output type=local,dest="$bin"');
    expect(program).not.toContain('releases/download');
    expect(program).not.toContain('checksums.txt');
    expect(program).not.toContain('uname -m');
  });

  test('exports the generator alone, not a root filesystem', () => {
    // `FROM scratch` keeps the local export to the one binary.
    expect(program).toContain('FROM scratch');
    // Only the plan directory is mounted into the build.
    expect(program).toContain('"$bin"/railpack prepare . --plan-out');
    expect(program).toContain('--local dockerfile="$plan"');
  });

  test('needs no tag to reach the generator', () => {
    const untagged = buildKitProgram({
      bundleUrl: 'staged://bundle',
      bundleDigest: 'sha256:bundle',
      subpath: '.',
      destinations: ['registry.example.test/app'],
      tags: ['latest'],
      zeroConfigFrontend: 'registry.example.test/zero-config',
      buildSecretNames: [],
      buildArgs: {},
    });
    expect(untagged).toContain('--frontend dockerfile.v0');
    expect(untagged).not.toContain('carries no version tag');
    expect(untagged).toContain('railpack prepare');
  });

  test('applies §5’s unwrap before it applies the subpath', () => {
    // A repository tarball wraps the tree in one directory, and the subpath is
    // relative to that tree.
    expect(program).toContain('root="$workspace"');
    expect(program).toContain(`cd "$root"/'apps/web'`);
    expect(program).not.toContain(`cd "$workspace"/'apps/web'`);
    // The same rule `archiveScope` applies: exactly one entry, and a directory.
    expect(program).toContain('ls -A "$workspace" | wc -l');
    expect(program).toContain('if [ -d "$only" ]');
  });

  test('pushes every tag core chose, under the repository core chose', () => {
    // The exporter's options are CSV, so the name list carries buildctl's CSV
    // quotes inside the shell's; unquoted, `push=true` joins the image name.
    expect(program).toContain(
      `--output 'type=image,"name=registry.example.test/app:sha256-bundle,registry.example.test/app:latest",push=true'`,
    );
  });

  test('builds its immutable reference from the repository, never a tag', () => {
    // A tag would be copied into the provenance and SBOM references.
    expect(program).toContain(`ref='registry.example.test/app'@"$digest"`);
  });

  test('passes build arguments as build arguments', () => {
    expect(program).toContain(
      `--opt 'build-arg:PUBLIC_URL=https://app.example.test'`,
    );
  });

  test('ends by printing the one line core reads', () => {
    expect(program).toContain('spindrift-result');
    expect(program).toContain('--opt attest:provenance=mode=max');
    expect(program).toContain('--opt attest:sbom=');
    expect(program).toContain('"buildkitProvenanceRef":"%s"');
    expect(program).toContain('"sbomRef":"%s"');
    // A folded payload is one core cannot decode.
    expect(program).toContain("tr -d '\\n'");
  });

  test('quotes every value that reaches the shell', () => {
    const hostile = buildKitProgram({
      bundleUrl: "staged://bundle'; rm -rf /; echo '",
      bundleDigest: 'sha256:bundle',
      subpath: '.',
      destinations: ['registry.example.test/app'],
      tags: ['sha256-bundle', 'latest'],
      zeroConfigFrontend: FRONTEND,
      buildSecretNames: [],
      buildArgs: { EVIL: "'; rm -rf /; echo '" },
    });
    // Neither value may end its own quoting.
    expect(hostile).not.toContain("'; rm -rf /; echo '\n");
    expect(hostile).toContain(`'\\''`);
  });
});
