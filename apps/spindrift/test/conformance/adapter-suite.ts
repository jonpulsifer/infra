/**
 * The adapter conformance suite (Task 12, § Seam 2).
 *
 * One suite, run against **every** implementation of each contract, so the
 * deploy adapters, the build routes, and the stores cannot drift apart in what
 * they mean. It asserts contract behaviour and nothing else: no backend's own
 * semantics appear here, because a suite that knew one backend's rendering
 * would be the coupling §6's seam exists to break.
 *
 * What it asserts, per the task:
 *
 * - `apply` reaches a terminal verdict
 * - `observe` reports what `apply` placed
 * - `destroy` is idempotent
 * - declared artifact types are honoured, and a foreign one is refused
 * - a store round-trips a pinned version reference
 *
 * **Enrolment is the other half.** A suite you can forget to run is not a
 * contract, so {@link assertEveryAdapterEnrolled} compares what the suite was
 * run over against the registry of adapters that exist, and names the gap.
 */
import { describe, expect, test } from 'bun:test';
import type { BuildAdapter } from '../../src/adapters/build/contract.ts';
import type {
  DeployAdapter,
  DeployTarget,
} from '../../src/adapters/deploy/contract.ts';
import type { SecretStore } from '../../src/adapters/store/contract.ts';
import type {
  ArtifactType,
  DesiredState,
} from '../../src/domain/desired-state.ts';

/** Names the suite has been run over, collected as the suites declare them. */
const enrolled = {
  deploy: new Set<string>(),
  build: new Set<string>(),
  store: new Set<string>(),
};

/** A `DesiredState` of the given artifact type — the neutral one, not a mock. */
export function desiredState(
  artifactType: ArtifactType,
  digest = 'sha256:conformance',
): DesiredState {
  return {
    app: 'conformance',
    component: 'web',
    target: 'target',
    kind: artifactType === 'files' ? 'website' : 'service',
    artifact: { type: artifactType, digest, refs: [] },
    exposure: 'private',
    config: [],
    requirements: {
      platform: { os: 'linux', arch: 'amd64' },
      resources: {},
    },
    hostname: { canonical: 'app.example.test' },
  };
}

/** Drive a generator to its return value, collecting what it yielded. */
async function drain<Event, Verdict>(
  stream: AsyncGenerator<Event, Verdict, void>,
): Promise<{ events: Event[]; verdict: Verdict }> {
  const events: Event[] = [];
  let step = await stream.next();
  while (!step.done) {
    events.push(step.value);
    step = await stream.next();
  }
  return { events, verdict: step.value };
}

/**
 * Run the deploy contract's suite against one adapter.
 *
 * The artifact type it does not accept is required rather than guessed: a
 * `static` adapter's foreign type is an image, a `kubernetes` adapter's is
 * files, and the suite must not decide that for a backend it does not know.
 */
export function deployAdapterSuite(
  label: string,
  make: () => DeployAdapter,
  foreign: ArtifactType,
): void {
  enrolled.deploy.add(label);

  describe(`deploy contract: ${label}`, () => {
    const target: DeployTarget = { name: 'target', adapter: make().adapter };

    test('declares at least one artifact type it accepts', () => {
      expect(make().artifactTypes.length).toBeGreaterThan(0);
    });

    test('apply reaches a terminal verdict', async () => {
      const adapter = make();
      const accepted = adapter.artifactTypes[0];
      expect(accepted).toBeDefined();
      const { verdict } = await drain(
        adapter.apply(target, desiredState(accepted as ArtifactType)),
      );
      expect(['LIVE', 'FAILED']).toContain(verdict.phase);
    });

    test('observe reports what apply placed', async () => {
      const adapter = make();
      const digest = 'sha256:observed';
      const { verdict } = await drain(
        adapter.apply(
          target,
          desiredState(adapter.artifactTypes[0] as ArtifactType, digest),
        ),
      );
      if (verdict.phase !== 'LIVE') {
        throw new Error('adapter did not place anything to observe');
      }
      const observed = await adapter.observe(target, verdict.ref);
      expect(observed).not.toBeNull();
      expect(observed?.ref).toBe(verdict.ref);
      expect(observed?.artifactDigest).toBe(digest);
    });

    test('observe reports null for a ref it never placed', async () => {
      expect(await make().observe(target, 'never-placed')).toBeNull();
    });

    test('destroy is idempotent', async () => {
      const adapter = make();
      const { verdict } = await drain(
        adapter.apply(
          target,
          desiredState(adapter.artifactTypes[0] as ArtifactType),
        ),
      );
      const ref = verdict.phase === 'LIVE' ? verdict.ref : 'absent';
      await adapter.destroy(target, ref);
      // The second destroy is the assertion: destroying what is already gone
      // succeeds (§6), so this must not throw and must leave nothing behind.
      await adapter.destroy(target, ref);
      expect(await adapter.observe(target, ref)).toBeNull();
    });

    test('refuses an artifact type it did not declare', async () => {
      const adapter = make();
      expect(adapter.artifactTypes).not.toContain(foreign);
      const { verdict } = await drain(
        adapter.apply(target, desiredState(foreign)),
      );
      // Refusal is a verdict, not an exception: a thrown error has no reason
      // and therefore no blame (§6).
      expect(verdict.phase).toBe('FAILED');
      if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('INTERNAL');
    });
  });
}

/** Run the build contract's suite against one route. */
export function buildAdapterSuite(
  label: string,
  make: () => BuildAdapter,
): void {
  enrolled.build.add(label);

  describe(`build contract: ${label}`, () => {
    const source = {
      bundleDigest: 'sha256:bundle',
      origin: {
        type: 'archive',
        location: 'staged://bundle',
        subpath: '.',
      },
    } as const;
    const spec = {
      artifactType: 'image',
      kind: 'service',
      platform: { os: 'linux', arch: 'amd64' },
      destination: 'registry.example.test/app',
      buildArgs: {},
    } as const;

    test('declares a fidelity and a level', () => {
      const adapter = make();
      expect(['LIVE_TEXT', 'LIVE_STATUS', 'ON_COMPLETION']).toContain(
        adapter.logFidelity,
      );
      expect([1, 2, 3]).toContain(adapter.buildLevel);
    });

    test('build reaches a terminal result', async () => {
      const { verdict } = await drain(make().build(source, spec));
      expect(['SUCCEEDED', 'FAILED']).toContain(verdict.status);
    });

    test('a green build echoes the bundle digest it was handed', async () => {
      const { verdict } = await drain(make().build(source, spec));
      if (verdict.status !== 'SUCCEEDED') {
        throw new Error('adapter did not produce a green build');
      }
      // §16's join: a route that cannot report the digest it was given cannot
      // produce a provenance anything can be correlated against.
      expect(verdict.provenance.bundleDigest).toBe(source.bundleDigest);
      expect(verdict.artifact.type).toBe(spec.artifactType);
    });

    test('reports the route that ran and at what fidelity', async () => {
      const adapter = make();
      const { verdict } = await drain(adapter.build(source, spec));
      expect(verdict.logs.backend).toBe(adapter.name);
      expect(verdict.logs.fidelity).toBe(adapter.logFidelity);
    });
  });
}

/** Run the store contract's suite against one store. */
export function storeAdapterSuite(
  label: string,
  make: () => SecretStore,
): void {
  enrolled.store.add(label);

  describe(`store contract: ${label}`, () => {
    const scope = { app: 'app', component: 'web', target: 'target' };

    test('round-trips a pinned version reference', async () => {
      const store = make();
      const reference = await store.put(scope, 'TOKEN', 'value');
      const described = await store.describe(reference);
      expect(described).not.toBeNull();
      expect(described?.reference).toEqual(reference);
      expect(described?.key).toBe('TOKEN');
    });

    test('a put is a new version, never an edit of one', async () => {
      const store = make();
      const first = await store.put(scope, 'TOKEN', 'one');
      const second = await store.put(scope, 'TOKEN', 'two');
      expect(second).not.toEqual(first);
      // The older pin still resolves — that is what makes a Deploy pinned to it
      // still deployable (§10).
      expect(await store.describe(first)).not.toBeNull();
    });

    test('lists every version of a key, newest first', async () => {
      const store = make();
      const first = await store.put(scope, 'TOKEN', 'one');
      const second = await store.put(scope, 'TOKEN', 'two');
      const versions = await store.versions(scope, 'TOKEN');
      expect(versions.map((v) => v.reference)).toEqual([second, first]);
    });

    test('describe reports null for a reference that is gone', async () => {
      const store = make();
      const reference = await store.put(scope, 'TOKEN', 'value');
      await store.destroy(reference);
      expect(await store.describe(reference)).toBeNull();
    });

    test('destroy is idempotent', async () => {
      const store = make();
      const reference = await store.put(scope, 'TOKEN', 'value');
      await store.destroy(reference);
      await store.destroy(reference);
      expect(await store.describe(reference)).toBeNull();
    });
  });
}

/**
 * Every adapter that exists, by contract. **This is the enrolment registry**:
 * an implementation added here without a suite call above fails the check
 * below, and an implementation added *nowhere* is the case a human review has
 * to catch — which is why this list lives next to the suite rather than being
 * inferred from a directory listing that would silently agree with itself.
 */
export const ADAPTERS = {
  deploy: ['fake'],
  build: ['fake'],
  store: ['fake native', 'fake immutable item per version'],
} as const;

/**
 * Fail if any registered adapter was never run through the suite.
 *
 * Called from the file that runs the suites, after they are declared. The
 * failure names the gap rather than only counting it, so the fix is obvious
 * from the output alone.
 */
export function assertEveryAdapterEnrolled(): void {
  describe('every adapter is enrolled in the conformance suite', () => {
    for (const contract of ['deploy', 'build', 'store'] as const) {
      test(`${contract} adapters`, () => {
        const missing = ADAPTERS[contract].filter(
          (name) => !enrolled[contract].has(name),
        );
        expect(missing).toEqual([]);
      });
    }
  });
}
