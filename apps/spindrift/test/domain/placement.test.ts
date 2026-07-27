/**
 * Placement as a filter (§3).
 *
 * The assertions here are mostly about the *negative* half, because that is
 * where §3 puts the value: "non-candidates are listed, disabled, and annotated
 * with why... this makes 'nowhere fits' expressible, catches failures before
 * deploy, and needs no cost model because a human is the tie-break." A filter
 * that only returned what fits would satisfy the type and lose the feature.
 */
import { describe, expect, test } from 'bun:test';
import {
  type CapabilityContext,
  resolveCapabilities,
} from '../../src/domain/capabilities.ts';
import {
  artifactTypeFor,
  DEFAULT_PLATFORM,
  type DerivedRequirements,
  exclusionsFor,
  type PlacementTarget,
  requiresRebuild,
  resolvePlacement,
} from '../../src/domain/placement.ts';
import { CAPABLE_DISCOVERY } from '../harness/fakes/deploy-adapter.ts';

const DEPLOY_PATH = {
  chart: 'oci://registry.cluster.test/charts/app:1.0.0',
  image: 'registry.cluster.test/artifacts',
  verifier: 'https://verifier.cluster.test/keys',
};

const ARTIFACT_TYPES = {
  kubernetes: ['image'],
  cloudrun: ['image'],
  static: ['files'],
} as const;

/** One Target, capable of everything except what a test says otherwise. */
function target(
  overrides: {
    id?: string;
    name?: string;
    adapter?: CapabilityContext['adapter'];
    rank?: number;
    healthy?: boolean;
    publicExposure?: boolean | null;
    quotaExhausted?: boolean;
    discovery?: Partial<typeof CAPABLE_DISCOVERY>;
  } = {},
): PlacementTarget {
  const adapter = overrides.adapter ?? 'kubernetes';
  return {
    id: overrides.id ?? `target-${adapter}`,
    name: overrides.name ?? adapter,
    adapter,
    rank: overrides.rank ?? 0,
    healthy: overrides.healthy ?? true,
    ...(overrides.quotaExhausted === undefined
      ? {}
      : { quotaExhausted: overrides.quotaExhausted }),
    capabilities: resolveCapabilities(
      { ...CAPABLE_DISCOVERY, servedHosts: [], ...overrides.discovery },
      {
        adapter,
        artifactTypes: ARTIFACT_TYPES[adapter],
        publicExposure: overrides.publicExposure ?? true,
        deployPath: DEPLOY_PATH,
      },
    ),
  };
}

function requirements(
  overrides: Partial<DerivedRequirements> = {},
): DerivedRequirements {
  return {
    kind: 'service',
    exposure: 'private',
    platform: DEFAULT_PLATFORM,
    resources: {},
    gpu: false,
    persistence: false,
    datastores: [],
    secretStore: 'gcp-secret-manager',
    ...overrides,
  };
}

describe('the suggestion follows rank', () => {
  test('the first candidate by global rank is suggested', () => {
    const placement = resolvePlacement(
      [
        target({ id: 'second', name: 'cloud', adapter: 'cloudrun', rank: 5 }),
        target({ id: 'first', name: 'cluster', rank: 1 }),
      ],
      requirements(),
    );
    // §13: "Rank is one global ordered list." Not the best fit — there is no
    // fit score, and §3 declines to have a cost model.
    expect(placement.suggested?.target.id).toBe('first');
    expect(placement.candidates.map((c) => c.target.id)).toEqual([
      'first',
      'second',
    ]);
  });

  test('rank decides, not the order the caller happened to select rows in', () => {
    const placement = resolvePlacement(
      [target({ id: 'b', rank: 2 }), target({ id: 'a', rank: 1 })],
      requirements(),
    );
    expect(placement.suggested?.target.id).toBe('a');
  });

  test('a website suggests the metal cluster over the public CDN', () => {
    // §13 calls this out as reading like a miss and being the private-baseline
    // rule holding: a website is Private by default, and Private cannot live
    // on a Target whose only exposure is public.
    const placement = resolvePlacement(
      [
        target({ id: 'cluster', rank: 0 }),
        target({ id: 'cdn', adapter: 'static', rank: 1 }),
      ],
      requirements({ kind: 'website' }),
    );
    expect(placement.suggested?.target.id).toBe('cluster');
    expect(placement.suggested?.artifactType).toBe('image');
    expect(placement.nonCandidates.map((n) => n.target.id)).toEqual(['cdn']);
  });
});

describe('nowhere fits is a returnable result', () => {
  test('with a reason and a sentence per excluded Target', () => {
    const placement = resolvePlacement(
      [
        target({ id: 'unhealthy', healthy: false, rank: 0 }),
        target({ id: 'cdn', adapter: 'static', rank: 1 }),
        target({ id: 'full', quotaExhausted: true, rank: 2 }),
      ],
      requirements(),
    );

    expect(placement.suggested).toBeNull();
    expect(placement.candidates).toEqual([]);
    expect(placement.nonCandidates).toHaveLength(3);
    for (const excluded of placement.nonCandidates) {
      expect(excluded.reasons.length).toBeGreaterThan(0);
      expect(excluded.detail).toHaveLength(excluded.reasons.length);
      for (const sentence of excluded.detail) {
        expect(sentence.length).toBeGreaterThan(0);
      }
    }
  });

  test('quota exhaustion surfaces here rather than as a failed deploy', () => {
    // §8: "Quota exhaustion needs no new failure reason (`REJECTED` covers it)
    // but surfaces at Place time as a non-candidate."
    expect(
      exclusionsFor(target({ quotaExhausted: true }), requirements()),
    ).toEqual(['QUOTA_EXHAUSTED']);
  });

  test('an unhealthy Target is a non-candidate with a stated reason', () => {
    // §13: an unmet prerequisite makes the Target a non-candidate — the same
    // grammar exposure, quotas, and offline capability all reuse.
    expect(exclusionsFor(target({ healthy: false }), requirements())).toEqual([
      'UNHEALTHY',
    ]);
  });
});

describe('exposure filters Targets and selects artifact shape', () => {
  test('public needs a Target that can serve a public address', () => {
    expect(
      exclusionsFor(
        target({ publicExposure: false }),
        requirements({ exposure: 'public' }),
      ),
    ).toEqual(['EXPOSURE_UNSUPPORTED']);
  });

  test('a private workload cannot land on the public-only Target', () => {
    // §9: "no non-public state may leave a bypassable origin."
    for (const exposure of ['internal', 'private'] as const) {
      expect(
        exclusionsFor(
          target({ adapter: 'static' }),
          requirements({ kind: 'website', exposure }),
        ),
      ).toContain('EXPOSURE_UNSUPPORTED');
    }
  });

  test('a public website reaches the static Target, as files', () => {
    const cdn = target({ adapter: 'static' });
    const wanted = requirements({ kind: 'website', exposure: 'public' });
    expect(exclusionsFor(cdn, wanted)).toEqual([]);
    expect(artifactTypeFor('website', cdn)).toBe('files');
  });

  test('a service never renders to files, wherever it lands', () => {
    expect(artifactTypeFor('service', target({ adapter: 'static' }))).toBe(
      'image',
    );
  });
});

describe('moving between placements', () => {
  test('a cross-shape move forces a rebuild', () => {
    // §3: a Build's key includes the target shape, so a website moving from a
    // cluster to the static Target has no artifact of the right shape.
    expect(requiresRebuild('image', 'files')).toBe(true);
  });

  test('a same-shape move does not', () => {
    // Which is what makes cluster-to-cloud, and cluster-to-cluster, free.
    expect(requiresRebuild('image', 'image')).toBe(false);
  });
});

describe('an attached datastore constrains where its App can go', () => {
  const clusterLocal = {
    name: 'primary',
    engine: 'postgres' as const,
    clusterLocalTargetId: 'target-kubernetes',
  };

  test('at attach time, the cloud becomes a non-candidate', () => {
    // §11: "In-cluster datastores stay cluster-local in v1" — tunnelling a
    // database over a satellite uplink is the cloud-native path degraded. The
    // consequence lands at attach time, not at deploy time.
    const placement = resolvePlacement(
      [
        target({ id: 'target-kubernetes', rank: 0 }),
        target({ id: 'cloud', adapter: 'cloudrun', rank: 1 }),
      ],
      requirements({ datastores: [clusterLocal] }),
    );
    expect(placement.candidates.map((c) => c.target.id)).toEqual([
      'target-kubernetes',
    ]);
    expect(placement.nonCandidates[0]?.reasons).toEqual([
      'DATASTORE_IS_CLUSTER_LOCAL',
    ]);
  });

  test('a Target that cannot host the engine is excluded too', () => {
    expect(
      exclusionsFor(
        target({ discovery: { postgres: false } }),
        requirements({
          datastores: [
            { name: 'primary', engine: 'postgres', clusterLocalTargetId: null },
          ],
        }),
      ),
    ).toEqual(['DATASTORE_ENGINE_MISSING']);
  });

  test('two datastores missing one engine is one reason, not two', () => {
    const reasons = exclusionsFor(
      target({ discovery: { postgres: false } }),
      requirements({
        datastores: [
          { name: 'a', engine: 'postgres', clusterLocalTargetId: null },
          { name: 'b', engine: 'postgres', clusterLocalTargetId: null },
        ],
      }),
    );
    expect(reasons).toEqual(['DATASTORE_ENGINE_MISSING']);
  });
});

describe('the rest of the derived requirements', () => {
  test('a Target that cannot reach the store is excluded (§10 reach rule)', () => {
    expect(
      exclusionsFor(
        target({ discovery: { reachableSecretStores: ['onepassword'] } }),
        requirements(),
      ),
    ).toEqual(['STORE_UNREACHABLE']);
  });

  test('an architecture the Target does not run', () => {
    expect(
      exclusionsFor(
        target({ discovery: { arch: ['arm64'] } }),
        requirements({ platform: { os: 'linux', arch: 'amd64' } }),
      ),
    ).toEqual(['ARCH_UNSUPPORTED']);
  });

  test('a workload larger than the Target admits', () => {
    expect(
      exclusionsFor(
        target({ discovery: { resourceCeiling: { memory: '2Gi' } } }),
        requirements({ resources: { memory: '8Gi' } }),
      ),
    ).toEqual(['RESOURCES_EXCEED_CEILING']);
  });

  test('an unknown quantity excludes nothing', () => {
    // Core never invents a scheduler (§3). A unit it cannot read is not
    // grounds to disqualify a Target.
    expect(
      exclusionsFor(
        target({ discovery: { resourceCeiling: { memory: 'a lot' } } }),
        requirements({ resources: { memory: '8Gi' } }),
      ),
    ).toEqual([]);
  });

  test('a job on the static Target is excluded by kind', () => {
    expect(
      exclusionsFor(
        target({ adapter: 'static' }),
        requirements({ kind: 'job', exposure: 'public' }),
      ),
    ).toEqual(['KIND_UNSUPPORTED']);
  });

  test('every reason a Target fails is reported, not just the first', () => {
    const reasons = exclusionsFor(
      target({ healthy: false, discovery: { gpu: false, arch: ['arm64'] } }),
      requirements({ gpu: true, platform: { os: 'linux', arch: 'amd64' } }),
    );
    expect(reasons).toContain('UNHEALTHY');
    expect(reasons).toContain('ARCH_UNSUPPORTED');
    expect(reasons).toContain('NO_GPU');
  });
});
