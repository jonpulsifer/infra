/**
 * Where a `LIVE_STATUS` run can be watched while it is still running.
 *
 * §4 makes the fidelity visible rather than worked around, and this route's
 * fidelity means the log text does not exist on this side until the run is
 * over. The run's own page is where that text is being written, so the route
 * reports it — as a fact about the run, not as a line in a log that is by
 * definition still empty when a reader wants it.
 */
import { describe, expect, test } from 'bun:test';
import type {
  BuildEvent,
  BuildSource,
  BuildSpec,
} from '../../src/adapters/build/contract.ts';
import {
  type ActionsHost,
  GitHubActionsBuildRoute,
} from '../../src/adapters/build/github-actions.ts';

const WORKFLOW =
  'acme/platform/.github/workflows/spindrift-build.yml@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6';

const RUN_URL = 'https://vcs.example/acme/widgets/actions/runs/9';

const source: BuildSource = {
  bundleDigest: 'sha256:bundle',
  origin: {
    type: 'repo',
    repository: 'acme/widgets',
    commit: 'c0ffee',
    subpath: '.',
    location: 'https://storage.example/depot/bundle.tgz?signed',
  },
};

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

/** A host whose run goes green, reporting whatever web address a test names. */
function hostReporting(htmlUrl: string | null | undefined): ActionsHost {
  return {
    installationFor: async () => ({ installationId: '1' }),
    repository: async () => ({ defaultBranch: 'main' }),
    dispatchWorkflow: async () => {},
    workflowRuns: async () => [
      {
        id: 9,
        name: 'spindrift fixed-correlation',
        status: 'completed',
        conclusion: 'success',
        htmlUrl,
      },
    ],
    workflowRun: async () => ({
      id: 9,
      status: 'completed',
      conclusion: 'success',
    }),
    runJobs: async () => [
      {
        id: 91,
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: 'Build and push',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    ],
    jobLog: async () => 'built\n',
  } as unknown as ActionsHost;
}

async function eventsFrom(host: ActionsHost): Promise<BuildEvent[]> {
  let elapsed = 0;
  const route = new GitHubActionsBuildRoute({
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

  const stream = route.build(source, spec);
  const events: BuildEvent[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return events;
}

describe('the run link a hosted build reports', () => {
  test('the run’s own page is announced as soon as the run is correlated', async () => {
    const events = await eventsFrom(hostReporting(RUN_URL));

    const runner = events.filter((event) => event.type === 'runner');
    expect(runner).toHaveLength(1);
    expect(runner[0]).toMatchObject({ url: RUN_URL });
  });

  test('it arrives before any log text, which is the whole of its value', async () => {
    // `LIVE_STATUS` releases text only at the end. A link that landed with the
    // text would arrive with the thing it exists to substitute for.
    const events = await eventsFrom(hostReporting(RUN_URL));

    const link = events.findIndex((event) => event.type === 'runner');
    const firstJobLogLine = events.findIndex(
      (event) => event.type === 'log' && event.line === 'built',
    );

    expect(link).toBeGreaterThanOrEqual(0);
    expect(firstJobLogLine).toBeGreaterThan(link);
  });

  test('a host that reports no web address produces no event', async () => {
    // Rather than an event carrying nothing, which reaches the screen as a link
    // to nowhere offered at the moment the reader was told to go elsewhere.
    for (const absent of [null, undefined]) {
      const events = await eventsFrom(hostReporting(absent));
      expect(events.filter((event) => event.type === 'runner')).toHaveLength(0);
    }
  });
});
