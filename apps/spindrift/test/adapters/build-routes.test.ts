/**
 * The three build routes (Task 25, §4, §16).
 *
 * Every test drives a real route against a fake of its far-side HTTP API
 * (§ Seam 2) — so the real dispatch bodies, the real polling, and the real
 * reading of a runner's report all run. The conformance suite already asserts
 * that all three satisfy the contract identically; what is here is the part of
 * each route that is *its own*, plus the three rules §4 makes that a plausible
 * implementation would quietly break:
 *
 * - **Logs are read, not pushed**, so a failure *before* the build step — a
 *   dispatch refused, a Job that could not be created — has to arrive as text
 *   rather than as an empty log and a spinner (§4 story 48).
 * - **The bundle digest is a parameter on every route**, and it is checked
 *   rather than copied: a runner that reports a build of some other bundle has
 *   produced a provenance that points at the wrong source (§16).
 * - **`in-cluster` is L1**, which is what makes an L2 Target refuse it.
 */
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
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
  sealRegistryAuth,
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

/** Generated once — every sealing test opens envelopes with the same pair. */
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
};

/**
 * A destination on the one vendor's registry a cloud build step can authorize
 * itself against, and a second one it cannot. `spec` above stays on neither, so
 * every test that does not care about credentials is unaffected by them.
 */
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
 * A clock that only moves when the route waits.
 *
 * Every route's budget is measured against `now`, so a test that stubbed the
 * sleep and left the clock alone would have a route that polls forever without
 * ever timing out — which is how a timeout goes untested. Advancing the clock
 * *inside* the sleep is what makes a poll loop's own budget observable, with no
 * wall-clock time spent.
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

/** What every route in this file is paced with unless a test says otherwise. */
const PACING = { intervalMs: 1_000, timeoutMs: 600_000 } as const;

/** Drive a route to its verdict, collecting the timeline it yielded. */
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

/** Every log line the route yielded, joined — what a person would read. */
function text(events: readonly BuildEvent[]): string {
  return events
    .filter((event) => event.type === 'log')
    .map((event) => (event as { line: string }).line)
    .join('\n');
}

// --- The hosted route --------------------------------------------------

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
 * The decrypt half of the reusable workflow's "Log in with sealed
 * credentials" step, lifted from the workflow file itself rather than
 * retyped — so the round-trip test below proves the algorithm this repository
 * actually runs, not a copy of it that could quietly drift out of step.
 *
 * Sliced at `const auth = …` — the point where the workflow's own script has
 * finished decrypting and has nothing further to prove — with one line of the
 * test's own appended so the spawned process has something to report back.
 * `docker login` never runs under this cut.
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
  // The bash preamble sits before the heredoc and is not JavaScript, so the
  // slice starts *after* the line that opens it — not at the top of `run`.
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
  test('a repo build runs in the connected repository, on its own minutes', async () => {
    // §15: "the connected repo owns its Actions minutes". The workflow it
    // dispatches is the thin caller the configuration PR wrote there, not the
    // reusable workflow — which lives somewhere the repository cannot see.
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
    // Connecting a repository grants access; it does not have to also merge a
    // configuration PR before the first App on it can build. The runner fetches
    // the staged bundle by URL and never checks the source repository out, so
    // the build is the same build wherever it runs — only whose minutes pay
    // for it differs. Without the fallback this is `TARGET_UNREACHABLE` and
    // the operator is sent to merge a PR to find out whether the thing builds.
    const { host, route } = hostedRoute({ fullName: PLATFORM_REPO });
    const { events, result } = await run(
      route.build(repoSource('someone/never-connected'), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(host.dispatches).toHaveLength(1);
    expect(host.dispatches[0]?.workflow).toBe('spindrift.yml');
    // The refused attempt is on the log rather than swallowed: it is what
    // explains why the run appears somewhere other than the App's own
    // repository.
    expect(text(events)).toContain('someone/never-connected');
  });

  test('an archive builds where the workflow lives, having no repository', async () => {
    const { host, route } = hostedRoute();
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    // The *caller*, not the reusable workflow: a dispatch names a branch, so
    // dispatching the reusable workflow directly would run whatever is on the
    // default branch and discard the commit §15 pins. The caller holds the pin.
    expect(host.dispatches[0]?.workflow).toBe('spindrift.yml');
  });

  test('the correlation is what finds the run, and travels outside the spec', async () => {
    const { host, route } = hostedRoute();
    await run(route.build(archiveSource(), spec));

    const dispatch = host.dispatches[0];
    expect(dispatch?.inputs.correlation).toBe('fixed-correlation');
    // Nothing about the build depends on it, so the reusable workflow never
    // reads it — which is only true if it is not in the spec.
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
    // §4 story 48: "a failure *before* my build step — dispatch failed, the
    // runner never came up — is visible instead of an empty log and a spinner."
    const { host, route } = hostedRoute();
    host.accessLost = true;

    const { events, result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
    }
    // The sentence names the repository the dispatch was refused in, because
    // the route now has more than one place it may try.
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
    // Observed live: the run sat queued past a 120s discovery deadline and the
    // Build was FAILED for a run that went on to complete `success`. Discovery
    // has no deadline of its own — it shares the build's own budget — so a slow
    // queue is still inside it here, with no `discoveryMs` override to shrink
    // that budget back down.
    const { route } = hostedRoute({ actions: { discoveryDelay: 150 } });
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
  });

  test('a lookup that flakes after a successful dispatch is retried, not failed', async () => {
    // Observed live: the dispatch worked, the call that goes looking for the
    // run it created answered `500`, and the build was recorded `FAILED` while
    // the run it dispatched ran to green. A `5xx` is the far side's fault by
    // definition — it says nothing about the dispatch, which already succeeded
    // and is already on the log.
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
    // The text lands at the end — that is what `LIVE_STATUS` means — but it
    // does land, because the failure is in it.
    expect(text(events)).toContain('exporting to image');
  });

  test('the log is asked for as JSON, which is the only thing the host serves', async () => {
    // The endpoint negotiates as JSON and answers with a redirect to a text
    // blob, so asking for `text/plain` — the media type of the *answer* — is a
    // `415` and a build that dispatched perfectly is recorded as failed. It
    // shipped that way, and no test could see it until the fake negotiated too.
    const { host, route } = hostedRoute();
    const { result } = await run(route.build(archiveSource(), spec));

    expect(result.status).toBe('SUCCEEDED');
    const read = host.requests.find((request) =>
      request.path.includes('/actions/jobs/'),
    );
    expect(read?.accept).toBe('application/vnd.github+json');
  });

  test('a log the host will not serve fails the build without blaming the dispatch', async () => {
    // The run was dispatched, correlated, and concluded green; only the text
    // could not be fetched. Naming that `dispatch failed:` sends an operator to
    // look for a refusal that is not there — but it is still a failure, because
    // the artifact digest travels in the log and nowhere else (`report.ts`).
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
    // Nothing the developer wrote is at fault for a runner that ran something
    // else, so the blame this reason carries is the platform's.
    if (result.status === 'FAILED') expect(result.reason).toBe('INTERNAL');
  });

  test('a runner reporting another bundle’s build is refused', async () => {
    // §16's join is only worth having if the route can disagree with the
    // runner. Echoing whatever core already knew would make it vacuous.
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
    // The route dispatches one file name in every repository. A connected
    // repository gets it from the configuration PR; this one has to have
    // committed it, or every archive build fails at dispatch.
    const caller = await Bun.file(
      new URL('../../../../.github/workflows/spindrift.yml', import.meta.url),
    ).text();
    expect(caller).toContain('workflow_dispatch:');
    expect(caller).toContain('uses: ./.github/workflows/spindrift-build.yml');
  });

  test('the reusable workflow prints the marker core reads', async () => {
    // YAML cannot import the constant, so this is what keeps the two in step:
    // a workflow that stopped printing it would produce green runs that report
    // no artifact, which reads as an adapter fault and is not one.
    const workflow = await Bun.file(
      new URL(
        '../../../../.github/workflows/spindrift-build.yml',
        import.meta.url,
      ),
    ).text();
    expect(workflow).toContain(BUILD_REPORT_MARKER);
  });

  test('the caller in somebody’s repository accepts what this route sends', async () => {
    // The coupling worth a test: this route dispatches inputs a workflow file
    // in *another repository* has to declare, and that file is generated by a
    // different module. A caller missing an input is a build that fails at
    // dispatch in every connected repository at once.
    const { host, route } = hostedRoute();
    await run(route.build(archiveSource(), spec));
    const sent = Object.keys(host.dispatches[0]?.inputs ?? {}).sort();

    const caller = buildWorkflowCaller(WORKFLOW_REF);
    for (const input of sent) expect(caller).toContain(`${input}:`);
    // And the correlation has to reach `run-name`, or the run this route goes
    // looking for is not named what it expects. Assembled rather than written
    // out, because a workflow expression and a template literal wear the same
    // syntax and the linter cannot tell which one this file meant.
    const expression = ['${', '{ inputs.correlation }', '}'].join('');
    expect(caller).toContain(`run-name: ${RUN_NAME_PREFIX} ${expression}`);
  });

  test('carries a registry credential only where a seal key is configured', () => {
    expect(hostedRoute().route.carriesRegistryCredential).toBe(false);
    expect(
      hostedRoute({}, {}, SEAL_KEYPAIR.publicKey).route
        .carriesRegistryCredential,
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

    // The whole request, not just the field it should have landed in — the
    // one thing this test cannot afford to miss is the secret showing up
    // somewhere `sealedRegistryAuth` was not, in a request GitHub renders in
    // the run header.
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
    const sealed = await sealRegistryAuth(auth, SEAL_KEYPAIR.publicKey);

    const proc = Bun.spawn(['node', '-e', await workflowDecryptScript()], {
      env: {
        ...process.env,
        SEALED: sealed,
        SEAL_KEY: SEAL_KEYPAIR.privateKey,
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
  });
});

// --- The cloud route ---------------------------------------------------

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
    // §4: "Cloud Run is driven with an explicit image, never its free
    // build-from-source path" — and the same reasoning one level down keeps
    // the engine one thing rather than a second set of frontends.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), spec));

    expect(api.programs).toHaveLength(1);
    expect(api.programs[0]).toContain('buildctl-daemonless.sh');
    expect(api.programs[0]).toContain(FRONTEND);
    // Attestations reach `buildctl` as frontend options. `--attest=type=…` is
    // buildx's flag; passing it here fails the whole invocation before any
    // step runs, and every managed build did until this was caught live.
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

    // The status read is the authority on whether the build went fine; without
    // a log there is no report, so the honest verdict is that nothing was
    // reported rather than that the build failed.
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

  // --- What the route adds around the shared program ------------------

  test('the build step authorizes its own push', async () => {
    // The shared program exports with `push=true` and a build step carries no
    // registry credential by itself, so without this the build runs to
    // completion and dies at the export with a `401`. Nothing is *passed* a
    // credential: the step mints its own identity, because a credential in a
    // submitted build body is one anybody who can read the build can read.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), cloudSpec));

    const program = api.programs[0] ?? '';
    expect(program).toContain('metadata.google.internal');
    expect(program).toContain(CLOUD_REGISTRY);
    expect(program).toContain('DOCKER_CONFIG');
    // Before the build, not after it — a config written once the export has
    // already failed is a config nothing reads.
    expect(program.indexOf('DOCKER_CONFIG')).toBeLessThan(
      program.indexOf('buildctl-daemonless.sh'),
    );
    // The submitted body holds no credential of its own.
    expect(program).not.toContain('Bearer ');
    expect(JSON.stringify(api.steps[0])).not.toContain('federated-token');
  });

  test('a destination the step cannot authorize is left to fail at the push', async () => {
    // Every host is not one host. This token authenticates to one vendor's
    // registries; a destination elsewhere reaches the push with no credential
    // and fails there naming itself, which beats a silently dropped push.
    const { api, route } = cloudRoute();
    await run(route.build(archiveSource(), spec));

    expect(api.programs[0]).not.toContain('metadata.google.internal');
  });

  test('the artifact is attested, so a policy-enforcing Target admits it', async () => {
    // §16's registry signature is core's and core makes it. The attestation is
    // the other half of the same key — an occurrence in the authority's
    // project rather than an object in the registry — and it is what a cloud
    // runtime's admission reads. Without it a cloud build is an artifact such a
    // Target refuses for the one reason that is not true of it.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    const attest = api.steps[0]?.[1];
    const program = attest?.args?.[1] ?? '';
    expect(program).toContain('sign-and-create');
    // Per destination, because an attestation is bound to an artifact URL: one
    // made against a repository says nothing about the same digest in another.
    for (const destination of cloudSpec.destinations) {
      expect(program).toContain(destination);
    }
    // The digest the builder pushed, handed over on the one path two steps of
    // a build share. A step that re-derived it could disagree about what was
    // built.
    expect(api.programs[0]).toContain('/workspace/spindrift-digest');
    expect(program).toContain('/workspace/spindrift-digest');
  });

  test('the manifests under the index are attested too', async () => {
    // BuildKit's `--attest` makes every push an image index, so the reported
    // digest names an index rather than the image a runtime runs. Cloud Run
    // resolves the index to its own platform's child *before* admission, and
    // Binary Authorization then asks about a digest nothing attested — which
    // reads as `denied by attestor` on an artifact that was attested.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    // As the step will run it: the service's template expansion turns the
    // route's `$$` literal-dollar escape back into `$` before bash sees it.
    const program = (api.steps[0]?.[1]?.args?.[1] ?? '').replaceAll('$$', '$');
    expect(program).toContain('manifests');
    expect(program).toContain('attest "$destination" "$child"');
    // The vendor's registries and no others: this step holds one metadata
    // token, and a destination it cannot read a manifest back out of is
    // attested at the index alone.
    const children = program.slice(program.indexOf('# The children,'));
    expect(children).toContain(`${CLOUD_REGISTRY}/example-builds/i/app`);
    expect(children).not.toContain('registry.example.test');
  });

  test('the attachments hanging off that index are not', async () => {
    // A child is a manifest a runtime can run. `--attest` hangs BuildKit's own
    // `provenance` and `sbom` manifests off the same index — `unknown/unknown`,
    // annotated `attestation-manifest` — and nothing ever resolves to one, so
    // each one signed is a KMS operation and an occurrence per destination per
    // build spent on a digest no admission decision is made about.
    //
    // Run rather than read: an assertion on the text of the selection would
    // pass for any expression that merely mentions `attestation-manifest`.
    const { api, route } = cloudRoute(
      {},
      {},
      { signer: SIGNER, attestor: ATTESTOR },
    );
    await run(route.build(archiveSource(), cloudSpec));

    const references = await attested(api.steps[0]?.[1]?.args?.[1] ?? '', {
      gcloud: GCLOUD_STUB,
      curl: indexStub(),
      // The `/workspace` volume the builder wrote the digest to. This box has
      // no such path and reading it is the step's first line.
      cat: `echo '${INDEX_DIGEST}'`,
    });

    // Every destination at the index, then the platform manifest under the one
    // this step can read a manifest back out of. The attachment appears
    // nowhere.
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
    // A quiet skip is a green Build whose Deploy is refused later by a webhook
    // whose message is about a policy rather than about this manifest.
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
    // §6's table gives `TIMEOUT` a dash rather than a blame, and a build that
    // ran out of its own budget is the same situation.
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('a build that never finishes runs out of core’s budget', async () => {
    const { result } = await run(
      cloudRoute({ duration: 1000 }, { timeoutMs: 5_000 }).route.build(
        archiveSource(),
        spec,
      ),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
  });

  test('a report ingested only after the build concludes is still read', async () => {
    // The report region is written in the build's last seconds and the log
    // service ingests behind the writer, so the read that finds it is the one
    // *after* the status turned `SUCCESS`. A loop that stopped at the status
    // read records this green build as `succeeded but reported no artifact`.
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

    // `Finished Step #0` is written after the report, so it is the line a route
    // that read one page too few would be missing.
    expect(text(events)).toContain('Finished Step #0');
  });

  test('every poll starts a fresh search rather than resuming an old cursor', async () => {
    // `nextPageToken` continues one search; it is not a watermark on a live
    // log. A route that carried one across polls would be paginating a snapshot
    // of the past, so a token may only be presented within the poll that minted
    // it.
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
    // The vendor documents an empty page carrying a token as "the search found
    // no log entries so far but it did not have time to search all the possible
    // log entries" — a route that read it as an end would report no artifact.
    const { result, events } = await run(
      cloudRoute({ cutShort: true }).route.build(archiveSource(), spec),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(text(events)).toContain('exporting to image');
  });

  test('the log service refuses a search that names no parent resource', async () => {
    // `entries.list` documents `resourceNames` as required. The fake refuses a
    // search without it, so the route sending it is not a matter of trust.
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

// --- The in-cluster route ----------------------------------------------

function clusterRoute(options: FakeKubernetesOptions = {}): {
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
            // The label the route selects the build's own pod by. The cluster
            // filters on it, so a fixture without it is a pod no build would
            // ever find its log through.
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
      ...fakeClock(),
    }),
  };
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
    // A Job that retried would push a second artifact for one Build row, and
    // §4's "no ordinal" rests on a Build recording one artifact.
    expect(jobSpec.backoffLimit).toBe(0);
    expect(jobSpec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    // §13's "nothing stored": the push authorizes as the account the cluster
    // projects a token for, not as a credential this process holds.
    expect(jobSpec.template.spec.serviceAccountName).toBe('builder');
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

// --- The levels selection reads ----------------------------------------

describe('the route level table', () => {
  test('says what each route class says about itself', () => {
    // `buildRouteProfiles` reads a table rather than constructing routes,
    // because placement has to be able to explain a route it cannot build. A
    // table that drifted from the classes would make that explanation wrong.
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

// --- The program itself ------------------------------------------------

describe('the BuildKit program', () => {
  const program = buildKitProgram({
    bundleUrl: 'staged://bundle',
    bundleDigest: 'sha256:bundle',
    subpath: 'apps/web',
    destinations: ['registry.example.test/app'],
    tags: ['sha256-bundle', 'latest'],
    zeroConfigFrontend: FRONTEND,
    buildArgs: { PUBLIC_URL: 'https://app.example.test' },
  });

  test('runs §5’s ladder: a Dockerfile settles how to build', () => {
    expect(program).toContain('if [ -f Dockerfile ]');
    expect(program).toContain('--frontend dockerfile.v0');
    expect(program).toContain(`--opt source='${FRONTEND}'`);
  });

  test('opens a staged bundle the one way every route opens one', () => {
    // The second of the readers `storage/archive-format.ts` converts a ZIP
    // for; the hosted workflow's copy is pinned in
    // `test/storage/archive-format.test.ts`. This program carries no unzip
    // binary in either image that runs it, so the two drifting apart is a
    // build that dies at `tar: This does not look like a tar archive`.
    expect(program).toContain('| tar -xz');
  });

  test('an empty build-arg set leaves no blank continuation line', () => {
    // A `\` continuation followed by a blank line ends the command there, and
    // the flag on the next line becomes a command of its own — observed live
    // as `sh: --opt: not found` on the first Component built with no build
    // args.
    const bare = buildKitProgram({
      bundleUrl: 'staged://bundle',
      bundleDigest: 'sha256:bundle',
      subpath: 'apps/web',
      destinations: ['registry.example.test/app'],
      tags: ['latest'],
      zeroConfigFrontend: FRONTEND,
      buildArgs: {},
    });
    expect(bare).not.toMatch(/\\\n\s*\n\s*--/);
    // The populated program holds the same invariant.
    expect(program).not.toMatch(/\\\n\s*\n\s*--/);
    expect(bare).toContain('--opt attest:provenance=mode=max');
  });

  test('lets a Dockerfile name its own directory as the context', () => {
    // The scope names the Dockerfile; the Dockerfile names its context. The
    // bundle root stays the convention — a monorepo Dockerfile is written
    // against the root `docker build -f apps/web/Dockerfile .` gives it —
    // and the probe moves off it only on the file's own evidence: a COPY/ADD
    // source resolving beside the Dockerfile and not at the root, which is
    // how every standalone repository's Dockerfile is written. The probe is
    // executed over real trees by `dockerfile-context-arm.test.ts`, which
    // also holds the hosted workflow's copy identical to this one.
    expect(program).toContain(DOCKERFILE_CONTEXT_PROBE);
    expect(program).toContain('sdc_context="$sdc_root"');
    expect(program).toContain(
      '--local context="$(spindrift_dockerfile_context Dockerfile "$root" .)"',
    );
    // And the two arms disagree on purpose, so neither may share one context
    // local on the `buildctl` line below them.
    expect(program).not.toContain('build "$@" \\\n  --local context=.');
  });

  test('hands the zero-config frontend a plan, never a `#syntax=` stub', () => {
    // The railpack frontend reads its input as a build plan: a stub comes back
    // as `invalid character '#' looking for beginning of value`, at every
    // version — which is why correcting the pin alone never made this work.
    expect(program).not.toContain('#syntax=');
    expect(program).toContain('railpack prepare . --plan-out');
    // `dockerfile` is the local the frontend reads and `railpack-plan.json` the
    // filename it defaults to, so the plan has to be named that and mounted
    // there. The context stays the source.
    expect(program).toContain('"$plan/railpack-plan.json"');
    expect(program).toContain('--local dockerfile="$plan"');
    expect(program).toContain('--local context=.');
  });

  test('generates the plan with the release that reads it', () => {
    // The plan is railpack's own serialisation format, versioned with railpack,
    // so generator and frontend must be one release. They are one *artifact*:
    // the generator is extracted from the frontend image itself, which is why
    // no version is derived from the tag and nothing is downloaded.
    expect(program).toContain(
      `--opt context:railpack=docker-image://'${FRONTEND}'`,
    );
    expect(program).toContain('COPY --from=railpack /railpack /railpack');
    expect(program).toContain('--output type=local,dest="$bin"');
    // Nothing is fetched from GitHub releases any more — no release URL, no
    // checksum dance, and no architecture to map to an asset name.
    expect(program).not.toContain('releases/download');
    expect(program).not.toContain('checksums.txt');
    expect(program).not.toContain('uname -m');
  });

  test('exports the generator alone, not a root filesystem', () => {
    // `FROM scratch` is what makes the local export one file: anything else
    // would write the frontend's whole filesystem into the workspace.
    expect(program).toContain('FROM scratch');
    // The binary and the plan are separate directories because only the second
    // is mounted into the build.
    expect(program).toContain('"$bin"/railpack prepare . --plan-out');
    expect(program).toContain('--local dockerfile="$plan"');
  });

  test('needs no tag to reach the generator', () => {
    // The version-from-tag derivation is gone, so a reference without one is a
    // reference BuildKit resolves normally rather than an arm that refuses.
    const untagged = buildKitProgram({
      bundleUrl: 'staged://bundle',
      bundleDigest: 'sha256:bundle',
      subpath: '.',
      destinations: ['registry.example.test/app'],
      tags: ['latest'],
      zeroConfigFrontend: 'registry.example.test/zero-config',
      buildArgs: {},
    });
    expect(untagged).toContain('--frontend dockerfile.v0');
    expect(untagged).not.toContain('carries no version tag');
    expect(untagged).toContain('railpack prepare');
  });

  test('applies §5’s unwrap before it applies the subpath', () => {
    // The subpath is relative to the source root, and a repository tarball
    // wraps the tree in one directory — so entering the subpath straight off
    // the extraction root is what makes every repo build miss its Dockerfile.
    expect(program).toContain('root="$workspace"');
    expect(program).toContain(`cd "$root"/'apps/web'`);
    expect(program).not.toContain(`cd "$workspace"/'apps/web'`);
    // The same rule `archiveScope` applies: exactly one entry, and a directory.
    expect(program).toContain('ls -A "$workspace" | wc -l');
    expect(program).toContain('if [ -d "$only" ]');
  });

  test('pushes every tag core chose, under the repository core chose', () => {
    // The exporter takes one comma-separated list of references and its own
    // options are comma-separated too, so the field carries buildctl's CSV
    // quotes inside the shell's — two layers, neither substituting for the
    // other. Written flat, `push=true` would parse as part of the image name.
    expect(program).toContain(
      `--output 'type=image,"name=registry.example.test/app:sha256-bundle,registry.example.test/app:latest",push=true'`,
    );
  });

  test('builds its immutable reference from the repository, never a tag', () => {
    // §16 pins an artifact by digest, and `repository:tag@sha256:…` is not what
    // the report should carry — the tag would ride along into the provenance
    // and SBOM references derived from it.
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
    // A folded payload is a payload core cannot decode.
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
      buildArgs: { EVIL: "'; rm -rf /; echo '" },
    });
    // Neither value may end its own quoting: the escape is what keeps a build
    // argument a build argument rather than an extra command.
    expect(hostile).not.toContain("'; rm -rf /; echo '\n");
    expect(hostile).toContain(`'\\''`);
  });
});
