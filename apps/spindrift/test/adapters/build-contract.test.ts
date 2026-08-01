/**
 * The build contract's one non-negotiable term.
 *
 * §16: correlation joins on digest with no signer over-vouching, which forces
 * the bundle digest to be a build parameter on **every** route — otherwise the
 * source receipt Spindrift signs and the provenance document the backend
 * produces have no join. This file makes that a compile-time fact rather than a
 * convention: a route cannot be called without one, and cannot report a build
 * without echoing it.
 */
import { describe, expect, test } from 'bun:test';
import type {
  BuildAdapter,
  BuildEvent,
  BuildProvenance,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from '../../src/adapters/build/contract.ts';
import { digestSchema } from '../../src/domain/digest.ts';
import { digestPinnedRef } from '../../src/supply-chain/verify.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';

/** A type-level claim that fails to compile if `T` is not exactly `true`. */
type Assert<T extends true> = T;

const spec: BuildSpec = {
  artifactType: 'image',
  kind: 'service',
  platform: { os: 'linux', arch: 'arm64' },
  destination: 'registry.example.test/apps',
  tags: ['sha256-bundle', 'latest'],
  buildArgs: {},
};

const source: BuildSource = {
  bundleDigest: 'sha256:bundle',
  origin: {
    type: 'repo',
    repository: 'https://git.example.test/app',
    commit: 'c0ffee',
    subpath: '.',
    location: 'staged://bundle',
  },
};

/** A route that does the one thing every route must: echo what it was given. */
const route: BuildAdapter = {
  name: 'example',
  logFidelity: 'LIVE_TEXT',
  buildLevel: 2,
  provenanceBuilderId: 'https://spindrift.dev/builders/example',
  async *build(
    given: BuildSource,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    yield { type: 'step', at: new Date(), step: 'unpack', state: 'RUNNING' };
    return {
      status: 'SUCCEEDED',
      artifact: { type: 'image', digest: 'sha256:built', refs: [] },
      logs: { backend: 'example', fidelity: 'LIVE_TEXT' },
      provenance: {
        bundleDigest: given.bundleDigest,
        claimedLevel: 2,
        statement: null,
      },
      baseDigest: 'sha256:base',
      buildkitProvenanceRef: null,
      sbomRef: null,
    };
  },
};

describe('the bundle digest', () => {
  test('is a required field of every build source', () => {
    const required: Assert<
      Omit<BuildSource, 'bundleDigest'> extends BuildSource ? false : true
    > = true;
    expect(required).toBe(true);
  });

  test('is a parameter no adapter can decline to accept', () => {
    type RouteTakes = Parameters<BuildAdapter['build']>[0];
    const accepted: Assert<
      RouteTakes extends { bundleDigest: string } ? true : false
    > = true;
    expect(accepted).toBe(true);
  });

  test('cannot be omitted at the call site', () => {
    const withoutIt = {
      origin: source.origin,
    };
    // @ts-expect-error — a source without a bundle digest is not a BuildSource
    const built = route.build(withoutIt, spec);
    expect(built).toBeDefined();
  });

  test('cannot be omitted from a provenance', () => {
    // @ts-expect-error — §16: the document must carry the digest it was given
    const incomplete: BuildProvenance = { claimedLevel: 2, statement: null };
    expect(incomplete.claimedLevel).toBe(2);
  });

  test('comes back on the provenance the route returns', async () => {
    const stream = route.build(source, spec);
    let step = await stream.next();
    const events: BuildEvent[] = [];
    while (!step.done) {
      events.push(step.value);
      step = await stream.next();
    }
    const result = step.value;

    expect(events).toHaveLength(1);
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') throw new Error('unreachable');
    expect(result.provenance.bundleDigest).toBe(source.bundleDigest);
    expect(result.artifact.digest).toBe('sha256:built');
    expect(result.baseDigest).toBe('sha256:base');
  });
});

describe('a red build', () => {
  test('carries a reason from the shared vocabulary and no provenance', () => {
    const failed: BuildResult = {
      status: 'FAILED',
      artifact: null,
      logs: { backend: 'example', fidelity: 'ON_COMPLETION' },
      provenance: null,
      baseDigest: null,
      buildkitProvenanceRef: null,
      sbomRef: null,
      reason: 'BUILD_FAILED',
      detail: 'step 3 exited 1',
    };
    expect(failed.status).toBe('FAILED');
    if (failed.status !== 'FAILED') throw new Error('unreachable');
    expect(failed.reason).toBe('BUILD_FAILED');
  });
});

describe('log fidelity', () => {
  test('is declared by the route, because it varies by runner', () => {
    const fidelities: LogFidelity[] = [
      'LIVE_TEXT',
      'LIVE_STATUS',
      'ON_COMPLETION',
    ];
    expect(fidelities).toContain(route.logFidelity);
  });
});

/**
 * The same term, applied to the fake route (Task 18).
 *
 * A fake that reports something the product would refuse is a fake that lets
 * every downstream assertion pass against an artifact the real system cannot
 * produce. `sha256:fake-0` and `<destination>@fake` were exactly that: the
 * digest fails the product's own definition in `src/domain/digest.ts`, and the
 * ref fails `digestPinnedRef` — the gate the real verifier applies before it
 * spawns anything.
 */
describe('the fake route reports what the product would accept', () => {
  async function built(adapter: FakeBuildAdapter) {
    const stream = adapter.build(source, spec);
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    return step.value;
  }

  test('its digest is a digest, and its ref pins that digest', async () => {
    const result = await built(new FakeBuildAdapter());

    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED' || result.artifact === null) return;
    expect(digestSchema.safeParse(result.artifact.digest).success).toBe(true);
    expect(digestPinnedRef(result.artifact)).toBe(
      result.artifact.refs[0] ?? null,
    );
  });

  test('a scripted digest is pinned by the ref too', async () => {
    const digest = `sha256:${'7'.repeat(64)}`;
    const result = await built(
      new FakeBuildAdapter({
        script: [{ result: { status: 'SUCCEEDED', digest } }],
      }),
    );

    if (result.status !== 'SUCCEEDED' || result.artifact === null) return;
    expect(result.artifact.digest).toBe(digest);
    expect(digestPinnedRef(result.artifact)).toBe(
      `${spec.destination}@${digest}`,
    );
  });

  test('successive builds report different digests', async () => {
    // One digest for every build would make "the deploy moved to the new
    // artifact" unfalsifiable.
    const adapter = new FakeBuildAdapter();
    const first = await built(adapter);
    const second = await built(adapter);
    if (first.status !== 'SUCCEEDED' || second.status !== 'SUCCEEDED') return;
    expect(first.artifact?.digest).not.toBe(second.artifact?.digest);
  });
});
