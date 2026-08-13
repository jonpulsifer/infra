/**
 * The bosun build route (Task: bosun build route).
 *
 * Unlike the other three routes, bosun's far side is not dialed — it is
 * polled through `src/storage/build-outbox.ts`, which is why this file's
 * fake (`FakeBosunOutbox`) scripts what `get` reports on each poll rather
 * than standing behind an HTTP client the way `FakeGitHub` or `FakeKubernetes`
 * do for the other three. The pacing pattern is identical to theirs:
 * `fakeClock()` only advances when the route sleeps, so a deadline test
 * spends no wall-clock time.
 */
import { describe, expect, test } from 'bun:test';
import { BosunBuildRoute } from '../../src/adapters/build/bosun.ts';
import type {
  BuildEvent,
  BuildResult,
  BuildSource,
  BuildSpec,
} from '../../src/adapters/build/contract.ts';
import { encodeBuildReport } from '../../src/adapters/build/report.ts';
import type { PollingOptions } from '../../src/adapters/build/route.ts';
import {
  FakeBosunOutbox,
  type FakeBosunOutboxOptions,
} from '../harness/fakes/bosun-outbox.ts';

const FRONTEND = 'registry.example.test/zero-config:pinned';
const BUILDER_ID = 'https://bosun.example.test/skiff';
const REQUEST_ID = 'fake-build-request';

function archiveSource(): BuildSource {
  return {
    bundleDigest: 'sha256:bundle',
    origin: { type: 'archive', location: 'staged://bundle', subpath: '.' },
  };
}

const spec: BuildSpec = {
  artifactType: 'image',
  kind: 'service',
  platform: { os: 'linux', arch: 'amd64' },
  destinations: ['registry.example.test/app'],
  tags: ['sha256-bundle', 'latest'],
  buildArgs: { EXAMPLE: 'value' },
  outputDirectory: null,
  registryAuth: [],
};

/** A clock that only moves when the route waits — see `build-routes.test.ts`. */
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

const PACING = { intervalMs: 1_000, timeoutMs: 60_000 } as const;

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

function route(
  outbox: FakeBosunOutbox,
  options: Partial<PollingOptions> = {},
): BosunBuildRoute {
  const clock = fakeClock();
  return new BosunBuildRoute({
    name: 'bosun',
    class: 'skiff-a',
    outbox,
    zeroConfigFrontend: FRONTEND,
    provenanceBuilderId: BUILDER_ID,
    ...PACING,
    now: clock.now,
    sleep: clock.sleep,
    ...options,
  });
}

function fakeOutbox(options: FakeBosunOutboxOptions = {}): FakeBosunOutbox {
  return new FakeBosunOutbox(options);
}

const digest = `sha256:${'a'.repeat(64)}`;
const report = {
  bundleDigest: 'sha256:bundle',
  digest,
  refs: [`registry.example.test/app@${digest}`],
  baseDigest: null,
};

describe('enqueueing', () => {
  test('enqueues under the configured class and names it in the log', async () => {
    const outbox = fakeOutbox({
      states: [
        {
          state: 'DONE',
          result: { status: 'SUCCEEDED', log: encodeBuildReport(report) },
        },
      ],
    });
    const { events } = await run(route(outbox).build(archiveSource(), spec));

    expect(outbox.enqueued).toHaveLength(1);
    expect(outbox.enqueued[0]?.class).toBe('skiff-a');
    expect(text(events)).toContain('skiff-a');
    expect(text(events)).toContain(REQUEST_ID);
  });

  test('the request carries the source verbatim and the pinned frontend', async () => {
    const outbox = fakeOutbox({
      states: [
        {
          state: 'DONE',
          result: { status: 'SUCCEEDED', log: encodeBuildReport(report) },
        },
      ],
    });
    await run(route(outbox).build(archiveSource(), spec));

    const request = outbox.enqueued[0]?.request as {
      source: BuildSource;
      spec: {
        destinations: readonly string[];
        zeroConfigFrontend: string;
        registryAuth: unknown;
      };
    };
    expect(request.source).toEqual(archiveSource());
    expect(request.spec.destinations).toEqual(spec.destinations);
    expect(request.spec.zeroConfigFrontend).toBe(FRONTEND);
    expect(request.spec.registryAuth).toEqual(spec.registryAuth);
  });
});

describe('a successful build', () => {
  test('the claim is announced, the log is read, and the digest is echoed', async () => {
    const outbox = fakeOutbox({
      states: [
        { state: 'CLAIMED', result: null },
        {
          state: 'DONE',
          result: {
            status: 'SUCCEEDED',
            log: `line one\n${encodeBuildReport(report)}`,
          },
        },
      ],
    });
    const { events, result } = await run(
      route(outbox).build(archiveSource(), spec),
    );

    expect(text(events)).toContain('claimed by the pool');
    expect(text(events)).toContain('line one');
    expect(result.status).toBe('SUCCEEDED');
    if (result.status === 'SUCCEEDED') {
      // §16's join: the route echoes the digest it was given.
      expect(result.provenance.bundleDigest).toBe('sha256:bundle');
      expect(result.artifact.digest).toBe(digest);
      expect(result.provenance.claimedLevel).toBe(2);
    }
  });

  test('a green result with no report is INTERNAL', async () => {
    const outbox = fakeOutbox({
      states: [
        {
          state: 'DONE',
          result: { status: 'SUCCEEDED', log: 'no marker here' },
        },
      ],
    });
    const { result } = await run(route(outbox).build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('INTERNAL');
  });
});

describe('a failed build', () => {
  test('a FAILED status becomes BUILD_FAILED, carrying the detail', async () => {
    const outbox = fakeOutbox({
      states: [
        {
          state: 'DONE',
          result: { status: 'FAILED', log: 'boom', detail: 'exit code 1' },
        },
      ],
    });
    const { events, result } = await run(
      route(outbox).build(archiveSource(), spec),
    );

    expect(text(events)).toContain('boom');
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('BUILD_FAILED');
      expect(result.detail).toBe('exit code 1');
    }
  });

  test('a cancelled row — DONE with no result — is INTERNAL', async () => {
    const outbox = fakeOutbox({ states: [{ state: 'DONE', result: null }] });
    const { result } = await run(route(outbox).build(archiveSource(), spec));

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('INTERNAL');
  });
});

describe('the deadline', () => {
  test('never claimed: cancels and reports TARGET_UNREACHABLE', async () => {
    const outbox = fakeOutbox(); // defaults to PENDING forever
    const { result } = await run(
      route(outbox, { timeoutMs: 3_000 }).build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toBe('TARGET_UNREACHABLE');
    }
    expect(outbox.cancelled).toEqual([REQUEST_ID]);
  });

  test('claimed but never finished: cancels and reports TIMEOUT', async () => {
    const outbox = fakeOutbox({ states: [{ state: 'CLAIMED', result: null }] });
    const { result } = await run(
      route(outbox, { timeoutMs: 3_000 }).build(archiveSource(), spec),
    );

    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toBe('TIMEOUT');
    expect(outbox.cancelled).toEqual([REQUEST_ID]);
  });
});

describe('the route’s declared profile', () => {
  test('carries the configured builder id, the class properties, and an empty self-authorized set', () => {
    const built = route(fakeOutbox());
    expect(built.logFidelity).toBe('ON_COMPLETION');
    expect(built.buildLevel).toBe(2);
    expect(built.provenanceBuilderId).toBe(BUILDER_ID);
    expect(built.carriesRegistryCredential).toBe(true);
    expect(built.selfAuthorizedRegistries).toEqual([]);
  });
});
