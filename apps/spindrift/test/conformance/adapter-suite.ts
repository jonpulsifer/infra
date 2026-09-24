/**
 * Contract suites run against every deploy adapter, build route and store.
 * They assert contract behaviour only, with no backend's own semantics.
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

const enrolled = {
  deploy: new Set<string>(),
  build: new Set<string>(),
  store: new Set<string>(),
};

export const BUNDLE_DEPOT = 'https://artifacts.example.test';

export function desiredState(
  artifactType: ArtifactType,
  digest = 'sha256:conformance',
): DesiredState {
  return {
    deploy: 'conformance-deploy',
    app: 'conformance',
    component: 'web',
    target: 'target',
    // Every artifact type but an image is a bundle a static backend serves.
    kind: artifactType === 'image' ? 'service' : 'website',
    // An adapter that pulls the artifact cannot place it without an address.
    artifact: {
      type: artifactType,
      digest,
      refs: [
        artifactType === 'image'
          ? `registry.example.test/conformance@${digest}`
          : `${BUNDLE_DEPOT}/bundles/${digest}`,
      ],
    },
    // Bundles deploy only to backends that serve public reach alone.
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

export interface EnrolledDeployAdapter {
  readonly adapter: DeployAdapter;
  /**
   * Placements the fake far side holds now. Revisions of one placement, such
   * as a hosting version or a release, do not count.
   */
  readonly placements: () => number;
  /**
   * The far side's evidence of the latest restart, or `null` before any.
   * Absent for a backend whose `restart` refuses.
   */
  readonly restartMark?: () => string | null;
}

/** `foreign` is an artifact type the adapter must refuse. */
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
      // Lease reclaims, crashed reconcilers and rollouts all re-apply from the
      // top, so a sibling per apply would be another production deployment.
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
      // Destroying what is already gone succeeds.
      await adapter.destroy(target, ref);
      expect(await adapter.observe(target, ref)).toBeNull();
    });

    test('inspect answers the whole checklist, exactly once each', async () => {
      const made = make().adapter;
      const inspection = await made.inspect(target);
      // `deriveHealth` reads an unanswered item as unmet.
      expect(inspection.prerequisites.map((item) => item.name).sort()).toEqual(
        [...prerequisitesFor(made.adapter)].sort(),
      );
      // An empty checklist would be trivially healthy.
      expect(inspection.prerequisites.length).toBeGreaterThan(0);
      for (const item of inspection.prerequisites) {
        expect(PREREQUISITES).toContain(item.name);
      }
    });

    test('inspect says whether the boundary carries this surface', async () => {
      // The far side these suites stand up always answers the probe.
      const { surface } = await make().adapter.inspect(target);
      expect(surface).toEqual({ kind: 'carried' });
    });

    test('inspect reports observations, not judgements', async () => {
      const { discovery } = await make().adapter.inspect(target);
      // Core draws `verifiedDeploy` and `offlineDeploy`; an adapter must not.
      expect(discovery).not.toHaveProperty('verifiedDeploy');
      expect(discovery).not.toHaveProperty('offlineDeploy');
      expect(typeof discovery.logHistorySeconds).toBe('number');
      expect(Array.isArray(discovery.arch)).toBe(true);
    });

    test('answers both run verbs about a ref it never placed', async () => {
      // Core does not know the backend behind a `DeployAdapter`, so an unknown
      // ref must get a reason, never a throw.
      const { adapter } = make();
      const answers = [
        await adapter.run(target, 'never-placed'),
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
      const answer = await make().adapter.restart(target, 'never-placed');
      expect(answer.kind).toBe('none');
      if (answer.kind === 'none') {
        expect(answer.because.length).toBeGreaterThan(0);
      }
    });

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

        // Every platform here rolls only when the template changes.
        const second = await adapter.restart(target, verdict.ref);
        expect(second.kind).toBe('restarted');
        expect(restartMark()).not.toBe(mark);

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
      // Refuse with a verdict: a thrown error carries no reason to blame.
      expect(verdict.phase).toBe('FAILED');
      if (verdict.phase === 'FAILED') expect(verdict.reason).toBe('INTERNAL');
    });
  });
}

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
      // Provenance is correlated with its source through this digest.
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
      // An unchanged reference would silently change what a pinned Deploy
      // delivers.
      expect(second).not.toEqual(first);
    });

    if (make().pinning === 'CURRENT_ONLY') {
      test('the superseded version stops resolving, and says so', async () => {
        const store = make();
        const first = await store.put(scope, 'TOKEN', 'one');
        await store.put(scope, 'TOKEN', 'two');
        // The runtime owns the name, so the old value has nowhere to live.
        // `placeIntent` refuses a Deploy pinned to it.
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
        // A Deploy pinned to it stays deployable.
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
 * Every adapter that exists, by contract. An entry that never ran a suite
 * fails {@link assertEveryAdapterEnrolled}.
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
  // Each fake names the real store whose reference shape it produces.
  store: [
    'fake native, standing for gcp-secret-manager',
    'fake immutable item per version, standing for onepassword',
    'onepassword',
    'gcp-secret-manager',
  ],
} as const;

/** Call after every suite is declared. */
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
