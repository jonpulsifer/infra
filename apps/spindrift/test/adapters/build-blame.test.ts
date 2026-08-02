/**
 * Who a red hosted run indicts (ticket 23, item 5).
 *
 * §6's blame column is the point: `blame` is "the most useful thing the UI
 * knows", and a developer sent to debug a Dockerfile that was never compiled is
 * the exact harm it exists to prevent. Build 9 recorded `blame = developer` for
 * a run that died in Spindrift's own fetch step, because every non-green
 * conclusion mapped to `BUILD_FAILED`.
 */
import { describe, expect, test } from 'bun:test';
import type {
  BuildEvent,
  BuildResult,
  BuildSource,
  BuildSpec,
} from '../../src/adapters/build/contract.ts';
import {
  type ActionsHost,
  type ActionsJob,
  DEVELOPER_BUILD_STEP,
  GitHubActionsBuildRoute,
} from '../../src/adapters/build/github-actions.ts';
import { blameFor } from '../../src/adapters/deploy/contract.ts';

const WORKFLOW =
  'jonpulsifer/infra/.github/workflows/spindrift-build.yml@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6';

const source: BuildSource = {
  bundleDigest: 'sha256:bundle',
  origin: {
    type: 'repo',
    repository: 'jonpulsifer/infra',
    commit: 'c0ffee',
    subpath: '.',
    location: 'https://storage.googleapis.com/depot/bundle.tgz?signed',
  },
};

const spec: BuildSpec = {
  artifactType: 'image',
  kind: 'service',
  platform: { os: 'linux', arch: 'amd64' },
  destinations: ['registry.example.test/app'],
  tags: ['sha256-bundle', 'latest'],
  buildArgs: {},
};

/**
 * A host whose run always fails, with the steps a test names.
 *
 * Faked at {@link ActionsHost}, which is the contract this route declares for
 * exactly this reason: what a verdict depends on here is the *shape of the
 * steps*, and nothing else about GitHub needs to be real to vary that.
 */
function hostWithSteps(steps: NonNullable<ActionsJob['steps']>): ActionsHost {
  return {
    installationFor: async () => ({ installationId: '1' }),
    repository: async () => ({ defaultBranch: 'main' }),
    dispatchWorkflow: async () => {},
    workflowRuns: async () => [
      { id: 9, name: 'spindrift fixed-correlation', status: 'completed' },
    ],
    workflowRun: async () => ({
      id: 9,
      status: 'completed',
      conclusion: 'failure',
    }),
    runJobs: async () => [
      {
        id: 91,
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        steps,
      },
    ],
    jobLog: async () => 'curl: (1) Protocol "upload" not supported\n',
  } as unknown as ActionsHost;
}

function routeOver(host: ActionsHost): GitHubActionsBuildRoute {
  let elapsed = 0;
  return new GitHubActionsBuildRoute({
    name: 'hosted',
    host,
    buildWorkflow: WORKFLOW,
    zeroConfigFrontend: 'ghcr.io/railwayapp/railpack:railpack-frontend',
    signer: '',
    attestor: '',
    correlation: () => 'fixed-correlation',
    intervalMs: 1_000,
    timeoutMs: 600_000,
    now: () => new Date(elapsed),
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  });
}

async function verdict(host: ActionsHost): Promise<BuildResult> {
  const stream = routeOver(host).build(source, spec);
  let step = await stream.next();
  const events: BuildEvent[] = [];
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return step.value;
}

const ok = { status: 'completed', conclusion: 'success' } as const;
const broke = { status: 'completed', conclusion: 'failure' } as const;

describe('blame on a red hosted run', () => {
  test('a failure in the platform’s own fetch step is the platform’s', async () => {
    // Build 9, verbatim: the runner was handed `upload://<hex>`, `curl` refused
    // the scheme, and `tar` fell over on the empty stream. Nothing the
    // developer wrote had run yet.
    const result = await verdict(
      hostWithSteps([
        { name: 'Read the build request', ...ok },
        { name: 'Fetch the staged bundle', ...broke },
      ]),
    );

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.reason).toBe('ARTIFACT_UNAVAILABLE');
    expect(blameFor(result.reason)).toBe('platform');
    expect(result.detail).toContain('Fetch the staged bundle');
  });

  test('a failure in the App’s own build step is still the developer’s', async () => {
    // The fix must not launder real build failures into platform blame — a
    // compile error is precisely what §6 gives `BUILD_FAILED` to the developer
    // for.
    const result = await verdict(
      hostWithSteps([
        { name: 'Fetch the staged bundle', ...ok },
        { name: DEVELOPER_BUILD_STEP, ...broke },
      ]),
    );

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.reason).toBe('BUILD_FAILED');
    expect(blameFor(result.reason)).toBe('developer');
  });

  test('a run reporting no steps keeps the developer verdict', async () => {
    // The conservative direction. Claiming platform blame with no evidence
    // would put a "not your fault" chip on every genuine build failure whose
    // steps this route could not read.
    const result = await verdict(hostWithSteps([]));

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.reason).toBe('BUILD_FAILED');
  });

  test('a skipped step is not a failed one', async () => {
    // Every step after a failure is `skipped`, so counting those as failures
    // would blame the platform for the step that merely came after the App's.
    const result = await verdict(
      hostWithSteps([
        { name: DEVELOPER_BUILD_STEP, ...broke },
        {
          name: 'Report what was built',
          status: 'completed',
          conclusion: 'skipped',
        },
      ]),
    );

    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.reason).toBe('BUILD_FAILED');
  });
});
