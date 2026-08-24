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
import {
  PREREQUISITES,
  prerequisitesFor,
} from '../../src/domain/capabilities.ts';
import type {
  ArtifactType,
  DesiredState,
} from '../../src/domain/desired-state.ts';
import { deployTargetFor } from '../harness/installation.ts';

/** Names the suite has been run over, collected as the suites declare them. */
const enrolled = {
  deploy: new Set<string>(),
  build: new Set<string>(),
  store: new Set<string>(),
};

/** Where a `files` artifact is fetched from, as a depot addresses one. */
export const BUNDLE_DEPOT = 'https://artifacts.example.test';

/** A `DesiredState` of the given artifact type — the neutral one, not a mock. */
export function desiredState(
  artifactType: ArtifactType,
  digest = 'sha256:conformance',
): DesiredState {
  return {
    deploy: 'conformance-deploy',
    app: 'conformance',
    component: 'web',
    target: 'target',
    // Every shape that is not an image is a bundle a static backend serves,
    // and the platform's own build output is one of those — so the branch is
    // "is this an image", which is the distinction the addresses below and the
    // reach further down are both really about. Asking `=== 'files'` made a
    // third shape silently take the image arm and get refused for a reach its
    // backend does not serve.
    kind: artifactType === 'image' ? 'service' : 'website',
    // A real address, because an adapter that has to pull one cannot place
    // anything without it — and "the artifact carries no address" is a core
    // bug, not a shape the contract's own suite should exercise. The two shapes
    // are addressed differently because they are: an image is pulled from a
    // registry, and a bundle of files is fetched from the depot that staged it.
    artifact: {
      type: artifactType,
      digest,
      refs: [
        artifactType === 'image'
          ? `registry.example.test/conformance@${digest}`
          : `${BUNDLE_DEPOT}/bundles/${digest}`,
      ],
    },
    // Reach follows the shape rather than being fixed, because §9 ties the
    // two: a `files` artifact only ever lands on static hosting, which serves
    // `Public` only — so a private one is a state no Target accepts, and a
    // suite that asked for one would be asserting against a placement core
    // would never make.
    reach: artifactType === 'image' ? 'private' : 'public',
    auth: artifactType === 'image' ? 'proxy' : 'none',
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

/** What one enrolment stands up: the adapter, and its far side made countable. */
export interface EnrolledDeployAdapter {
  readonly adapter: DeployAdapter;
  /**
   * How many placements the fake far side holds right now.
   *
   * What a placement *is* belongs to the backend — a Vercel deployment, a
   * Pages deployment, a hosting site, a Cloud Run Service, a HelmRelease —
   * so each enrolment counts its own noun and the suite only asserts the
   * number. Revisions of one placement (a hosting version, a release) are not
   * placements and must not be counted.
   */
  readonly placements: () => number;
  /**
   * The far side's evidence of the latest restart, or `null` while nothing
   * has been asked to restart.
   *
   * What the evidence *is* belongs to the backend — a pod-template stamp on a
   * HelmRelease's values, a revision template's annotation, a count on the
   * fake — so each enrolment reads its own and the suite asserts only that it
   * appears and then moves. Absent for a backend whose `restart` refuses: a
   * file tree has no process, and the suite holds that backend to the
   * refusal instead.
   */
  readonly restartMark?: () => string | null;
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
  make: () => EnrolledDeployAdapter,
  foreign: ArtifactType,
): void {
  enrolled.deploy.add(label);

  describe(`deploy contract: ${label}`, () => {
    const kind = make().adapter.adapter;
    const target: DeployTarget = deployTargetFor(kind, 'target');

    test('declares at least one artifact type it accepts', () => {
      expect(make().adapter.artifactTypes.length).toBeGreaterThan(0);
    });

    test('apply reaches a terminal verdict', async () => {
      const { adapter } = make();
      const accepted = adapter.artifactTypes[0];
      expect(accepted).toBeDefined();
      const { verdict } = await drain(
        adapter.apply(target, desiredState(accepted as ArtifactType)),
      );
      expect(['LIVE', 'FAILED']).toContain(verdict.phase);
    });

    test('observe reports what apply placed', async () => {
      const { adapter } = make();
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
      expect(await make().adapter.observe(target, 'never-placed')).toBeNull();
    });

    test('a second apply of one DesiredState leaves one placement', async () => {
      // The contract's convergence clause, asserted rather than claimed:
      // every mechanism that re-runs an attempt — a lease reclaim, a crashed
      // reconciler, a rollout — re-applies from the top, so a backend that
      // minted a sibling per apply would turn each of those into another
      // production deployment. This shipped on two backends before anything
      // here would have caught it.
      const { adapter, placements } = make();
      const desired = desiredState(adapter.artifactTypes[0] as ArtifactType);
      const first = await drain(adapter.apply(target, desired));
      if (first.verdict.phase !== 'LIVE') {
        throw new Error('adapter did not place anything to re-apply');
      }
      const again = await drain(adapter.apply(target, desired));
      expect(again.verdict.phase).toBe('LIVE');
      if (again.verdict.phase === 'LIVE') {
        expect(again.verdict.ref).toBe(first.verdict.ref);
      }
      expect(placements()).toBe(1);
    });

    test('destroy is idempotent', async () => {
      const { adapter } = make();
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

    test('inspect answers the whole checklist, exactly once each', async () => {
      const made = make().adapter;
      const inspection = await made.inspect(target);
      // §13 merges health and capability refresh into one loop, which only
      // works if one pass answers every item — a partial checklist would leave
      // core deciding what an absent item means, and `deriveHealth` treats an
      // unanswered row as unmet.
      //
      // The checklist compared against is this adapter type's, not the whole
      // vocabulary: a Cloud Run Target has no delivery operator to assess, and
      // a suite that demanded one would force every cloud adapter to report a
      // row that can only ever be a lie in one direction or the other.
      expect(inspection.prerequisites.map((item) => item.name).sort()).toEqual(
        [...prerequisitesFor(made.adapter)].sort(),
      );
      // Comparing against the adapter's own list is a weaker pin than comparing
      // against one global list, so the teeth it gives up are put back here:
      // an adapter cannot shrink its checklist to nothing and be trivially
      // healthy, and every row it does answer has to be from the one
      // vocabulary. `test/domain/capabilities.test.ts` holds the other half —
      // that no cloud Target is asked a chart question, and that a checklist
      // answered against the wrong adapter's list reads unhealthy.
      expect(inspection.prerequisites.length).toBeGreaterThan(0);
      for (const item of inspection.prerequisites) {
        expect(PREREQUISITES).toContain(item.name);
      }
    });

    test('inspect says whether the boundary carries this surface', async () => {
      // The question `connectTarget` acts on: a surface the probe establishes
      // is not there gets no Target at all. Every adapter answers it, because
      // core holds a `DeployAdapter` without knowing which backend is behind
      // it — and it answers `carried` here, since the far side these suites
      // stand up is one that answers.
      const { surface } = await make().adapter.inspect(target);
      expect(surface).toEqual({ kind: 'carried' });
    });

    test('inspect reports observations, not judgements', async () => {
      const { discovery } = await make().adapter.inspect(target);
      // `verifiedDeploy` and `offlineDeploy` are core's conclusions (§32, §33).
      // An adapter reporting either directly would let two adapters disagree
      // about how the conclusion is drawn.
      expect(discovery).not.toHaveProperty('verifiedDeploy');
      expect(discovery).not.toHaveProperty('offlineDeploy');
      expect(typeof discovery.logHistorySeconds).toBe('number');
      expect(Array.isArray(discovery.arch)).toBe(true);
    });

    test('answers both run verbs about a ref it never placed', async () => {
      // §17's run verbs are part of what every adapter answers, and "throws" is
      // not an answer this contract accepts: core holds a `DeployAdapter`
      // without knowing which backend is behind it, so a caller that reached
      // for a run on a website would crash rather than read a sentence. Every
      // backend has this case — the ref names nothing, or names something that
      // is not a job — and every backend has to have words for it.
      const { adapter } = make();
      const answers = [
        await adapter.run(target, 'never-placed'),
        // With parameters too: a backend that runs nothing has nothing to put
        // them on, and the answer is the same sentence rather than a crash.
        await adapter.run(target, 'never-placed', { env: { SNAPSHOT: 'x' } }),
        await adapter.executions(target, 'never-placed'),
      ];
      for (const answer of answers) {
        expect(answer.kind).toBe('none');
        if (answer.kind !== 'none') continue;
        expect(answer.because.length).toBeGreaterThan(0);
      }
    });

    test('answers restart about a ref it never placed', async () => {
      // The same rule the run verbs are held to: a ref naming nothing is an
      // answer in a sentence, never a throw, because core holds a
      // `DeployAdapter` without knowing which backend is behind it.
      const answer = await make().adapter.restart(target, 'never-placed');
      expect(answer.kind).toBe('none');
      if (answer.kind === 'none') {
        expect(answer.because.length).toBeGreaterThan(0);
      }
    });

    // Whether a backend has a process to bounce is the one thing the
    // enrolments genuinely differ on, so it is asserted per backend rather
    // than skipped for the ones that cannot. Both arms are positive claims.
    if (make().restartMark !== undefined) {
      test('a restart marks the far side and leaves the placement as it was', async () => {
        const { adapter, placements, restartMark } = make();
        if (restartMark === undefined)
          throw new Error('enrolment lost its mark');
        const digest = 'sha256:restarted';
        const { verdict } = await drain(
          adapter.apply(
            target,
            desiredState(adapter.artifactTypes[0] as ArtifactType, digest),
          ),
        );
        if (verdict.phase !== 'LIVE') {
          throw new Error('adapter did not place anything to restart');
        }
        expect(restartMark()).toBeNull();

        const first = await adapter.restart(target, verdict.ref);
        expect(first.kind).toBe('restarted');
        const mark = restartMark();
        expect(mark).not.toBeNull();

        // A second press is a second rollout. Every platform here rolls on a
        // template *change*, so a mark that stayed equal would be a press
        // that did nothing while reporting that it did.
        const second = await adapter.restart(target, verdict.ref);
        expect(second.kind).toBe('restarted');
        expect(restartMark()).not.toBe(mark);

        // What is placed is what was placed: the same ref, the same digest,
        // one placement. A restart that minted a sibling or moved the digest
        // would be a deploy wearing the wrong name.
        const observed = await adapter.observe(target, verdict.ref);
        expect(observed?.artifactDigest).toBe(digest);
        expect(placements()).toBe(1);
      });
    } else {
      test('restart refuses what it has no process for, in a sentence', async () => {
        const { adapter } = make();
        const { verdict } = await drain(
          adapter.apply(
            target,
            desiredState(adapter.artifactTypes[0] as ArtifactType),
          ),
        );
        if (verdict.phase !== 'LIVE') {
          throw new Error('adapter did not place anything to refuse');
        }
        const answer = await adapter.restart(target, verdict.ref);
        expect(answer.kind).toBe('none');
        if (answer.kind === 'none') {
          expect(answer.because.length).toBeGreaterThan(0);
        }
      });
    }

    test('refuses an artifact type it did not declare', async () => {
      const { adapter } = make();
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
      destinations: ['registry.example.test/app'],
      tags: ['sha256-bundle', 'latest'],
      buildArgs: {},
      outputDirectory: null,
      vercelFramework: null,
      registryAuth: [],
      buildSecrets: [],
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
      // True of every strategy, and the whole of what §10 means by pinned: a
      // reference that stayed equal across two values would be a floating
      // latest, and a Deploy carrying it would silently change what it
      // delivers.
      expect(second).not.toEqual(first);
    });

    // What happens to the version that was superseded is the one thing the
    // strategies genuinely disagree about, so it is asserted per strategy
    // rather than skipped for the one that cannot. Both arms are positive
    // claims: a store that quietly changed its mind fails whichever it
    // declared.
    if (make().pinning === 'CURRENT_ONLY') {
      test('the superseded version stops resolving, and says so', async () => {
        const store = make();
        const first = await store.put(scope, 'TOKEN', 'one');
        await store.put(scope, 'TOKEN', 'two');
        // The name is the runtime's own, so there is nowhere for the old value
        // to live. `placeIntent` is what turns this into a refusal instead of
        // a Component that comes up without its config.
        expect(await store.describe(first)).toBeNull();
      });

      test('lists the one version there can be', async () => {
        const store = make();
        await store.put(scope, 'TOKEN', 'one');
        const second = await store.put(scope, 'TOKEN', 'two');
        const versions = await store.versions(scope, 'TOKEN');
        expect(versions.map((v) => v.reference)).toEqual([second]);
      });
    } else {
      test('the older pin still resolves', async () => {
        const store = make();
        const first = await store.put(scope, 'TOKEN', 'one');
        await store.put(scope, 'TOKEN', 'two');
        // That is what makes a Deploy pinned to it still deployable (§10).
        expect(await store.describe(first)).not.toBeNull();
      });

      test('lists every version of a key, newest first', async () => {
        const store = make();
        const first = await store.put(scope, 'TOKEN', 'one');
        const second = await store.put(scope, 'TOKEN', 'two');
        const versions = await store.versions(scope, 'TOKEN');
        expect(versions.map((v) => v.reference)).toEqual([second, first]);
      });
    }

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
  deploy: [
    'fake',
    'kubernetes',
    'cloudrun',
    'static',
    'vercel',
    'cloudflare-pages',
  ],
  build: ['fake', 'github-actions', 'cloud-build', 'in-cluster', 'bosun'],
  // The two fakes name the real store whose reference shape each one produces,
  // because a suite comparing two shapes no store can hold would prove §10's
  // "nothing above the seam can tell which strategy produced it" of nothing.
  store: [
    'fake native, standing for gcp-secret-manager',
    'fake immutable item per version, standing for onepassword',
    'onepassword',
    'gcp-secret-manager',
  ],
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
