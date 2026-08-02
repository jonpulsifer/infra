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
  ASSERTED_REACHES_BY_ADAPTER,
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
  images: ['registry.cluster.test/artifacts'],
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
    reaches?: readonly ('none' | 'private' | 'public')[] | null;
    authReaches?: readonly ('none' | 'private' | 'public')[] | null;
    routesAttachTo?: boolean;
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
    routesAttachTo: overrides.routesAttachTo ?? true,
    ...(overrides.quotaExhausted === undefined
      ? {}
      : { quotaExhausted: overrides.quotaExhausted }),
    capabilities: resolveCapabilities(
      { ...CAPABLE_DISCOVERY, servedHosts: [], ...overrides.discovery },
      {
        adapter,
        artifactTypes: ARTIFACT_TYPES[adapter],
        // Defaulted to what the adapter serves unasserted, so a test that
        // says nothing about reach gets the honest floor rather than every cell.
        reaches: overrides.reaches ?? ASSERTED_REACHES_BY_ADAPTER[adapter],
        authReaches: overrides.authReaches ?? ['none', 'private', 'public'],
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
    reach: 'private',
    auth: 'proxy',
    platform: DEFAULT_PLATFORM,
    resources: {},
    gpu: false,
    persistence: false,
    datastores: [],
    registries: ['registry.example.test'],
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
      // A reach both serve: rank is what this test is about, and a Target
      // filtered out on reach would make it pass for the wrong reason.
      requirements({ reach: 'none', auth: 'none' }),
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
        target({ reaches: ['none', 'private'] }),
        requirements({ reach: 'public', auth: 'none' }),
      ),
    ).toEqual(['REACH_UNSUPPORTED']);
  });

  test('a non-public workload cannot land on the public-only Target', () => {
    // The static Target asserts `public` and nothing else, so this falls out of
    // the ordinary join rather than a special case about which Target it is.
    for (const reach of ['none', 'private'] as const) {
      expect(
        exclusionsFor(
          target({ adapter: 'static' }),
          requirements({ kind: 'website', reach, auth: 'none' }),
        ),
      ).toContain('REACH_UNSUPPORTED');
    }
  });

  test('a public website reaches the static Target, as files', () => {
    const cdn = target({ adapter: 'static' });
    const wanted = requirements({
      kind: 'website',
      reach: 'public',
      auth: 'none',
    });
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
      requirements({ reach: 'none', auth: 'none', datastores: [clusterLocal] }),
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

/**
 * Ticket 39's third criterion — a Target that can reach none of the registries
 * an artifact is pushed to is a non-candidate **before the build**, rather than
 * a failed revision after it.
 */
describe('registry reachability at Place', () => {
  test('a Target reaching none of them is excluded, with a reason', () => {
    const excluded = exclusionsFor(
      target({ discovery: { reachableRegistries: ['registry.internal'] } }),
      requirements({ registries: ['registry.example.test/ns'] }),
    );
    expect(excluded).toEqual(['REGISTRY_UNREACHABLE']);
  });

  test('a Target reaching any one of them is a candidate', () => {
    // Any, not all: an artifact is pulled once, from one registry.
    expect(
      exclusionsFor(
        target({ discovery: { reachableRegistries: ['ghcr.io'] } }),
        requirements({
          registries: ['ghcr.io/ns', 'registry.internal/ns'],
        }),
      ),
    ).toEqual([]);
  });

  test('declaring nothing is no restriction, not "reaches nothing"', () => {
    // Every Target on this installation, until an operator says otherwise —
    // reading an empty list as a refusal would exclude all of them.
    expect(
      exclusionsFor(
        target({ discovery: { reachableRegistries: [] } }),
        requirements({ registries: ['registry.example.test/ns'] }),
      ),
    ).toEqual([]);
  });

  test('a static Target is not asked the question', () => {
    // It serves `files`, fetched from the depot, and its discovery reports
    // `reachableRegistries: []` for that reason rather than as a refusal.
    expect(
      exclusionsFor(
        target({ adapter: 'static', discovery: { reachableRegistries: [] } }),
        requirements({ kind: 'website', reach: 'public', auth: 'none' }),
      ),
    ).toEqual([]);
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
        requirements({ kind: 'job', reach: 'public', auth: 'none' }),
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

describe('§9: a Private website takes the server-image rendering', () => {
  test('the whole resolution routes it away from static hosting', () => {
    // §9: "a rendering that leaves an unauthenticated alternate origin is
    // disqualified rather than shipped with a caveat — which is why the static
    // hosting product serves `Public` only, and why a Private website takes
    // the server-image rendering."
    const placement = resolvePlacement(
      [
        target({ id: 'cdn', name: 'hosting', adapter: 'static', rank: 0 }),
        target({ id: 'cluster', name: 'cluster', rank: 1 }),
      ],
      requirements({ kind: 'website', reach: 'private', auth: 'proxy' }),
    );

    // Static outranks the cluster and is still not what is suggested.
    expect(placement.suggested?.target.id).toBe('cluster');
    expect(placement.suggested?.artifactType).toBe('image');
    expect(placement.candidates.map((one) => one.target.id)).toEqual([
      'cluster',
    ]);
    // And the one that lost says why, rather than simply not appearing (§3).
    const excluded = placement.nonCandidates.find(
      (one) => one.target.id === 'cdn',
    );
    expect(excluded?.reasons).toContain('REACH_UNSUPPORTED');
    expect(excluded?.detail.join(' ')).toContain(
      'no address on your own network',
    );
  });

  test('the same website going public reaches static hosting as files', () => {
    const placement = resolvePlacement(
      [
        target({ id: 'cdn', name: 'hosting', adapter: 'static', rank: 0 }),
        target({ id: 'cluster', name: 'cluster', rank: 1 }),
      ],
      requirements({ kind: 'website', reach: 'public', auth: 'none' }),
    );
    expect(placement.suggested?.target.id).toBe('cdn');
    expect(placement.suggested?.artifactType).toBe('files');
  });
});

describe('§10: the reach rule does not bind a website', () => {
  test('a Target that reaches no store still holds a website', () => {
    // §10's one exception makes a website's configuration build arguments
    // derived from its kind, so there is nothing at run time for a store to
    // deliver. Static hosting reaches no store precisely because it has no
    // runtime — and applying the rule anyway would exclude it from the one
    // kind it exists to run.
    const cdn = target({
      adapter: 'static',
      discovery: { reachableSecretStores: [] },
    });
    expect(
      exclusionsFor(
        cdn,
        requirements({ kind: 'website', reach: 'public', auth: 'none' }),
      ),
    ).toEqual([]);
  });

  test('a service on the same Target is still bound by it', () => {
    // The exemption is the kind's, not the Target's: a Component with a
    // runtime that reads configuration needs somewhere to read it from.
    const unreachable = target({
      discovery: { reachableSecretStores: [] },
    });
    expect(exclusionsFor(unreachable, requirements())).toContain(
      'STORE_UNREACHABLE',
    );
  });
});

describe('§3: a kind an adapter does not render is refused at Place', () => {
  test('a job is a non-candidate on the cloud runtime, with the reason', () => {
    // `KINDS_BY_ADAPTER` is "a property of the code": the Cloud Run adapter
    // renders Services, and a job there is Task 33's work. Until it exists the
    // honest answer is a non-candidate with a stated reason, which fails at
    // Place rather than at apply.
    const cloud = target({ adapter: 'cloudrun' });
    const reasons = exclusionsFor(cloud, requirements({ kind: 'job' }));
    expect(reasons).toContain('KIND_UNSUPPORTED');
  });

  test('a service and a website are both rendered there', () => {
    const cloud = target({ adapter: 'cloudrun' });
    const served = { reach: 'public', auth: 'none' } as const;
    expect(
      exclusionsFor(cloud, requirements({ ...served, kind: 'service' })),
    ).toEqual([]);
    expect(
      exclusionsFor(cloud, requirements({ ...served, kind: 'website' })),
    ).toEqual([]);
  });
});

describe('§9: reach and auth join as two independent facts', () => {
  /** Offsite, as it declares itself: every reach, auth for `private` only. */
  const offsite = () =>
    target({
      reaches: ['none', 'private', 'public'],
      authReaches: ['private'],
    });

  test('the four routed cells, three met and one unmet', () => {
    // The grid the old three-state exposure could not express. Two of these
    // cells had no name at all before: an unauthenticated address on your own
    // network, and an authenticated public one.
    const met: [ReturnType<typeof requirements>['reach'], 'none' | 'proxy'][] =
      [
        ['private', 'none'],
        ['private', 'proxy'],
        ['public', 'none'],
      ];
    for (const [reach, auth] of met) {
      expect(exclusionsFor(offsite(), requirements({ reach, auth }))).toEqual(
        [],
      );
    }

    // Expressible and unmet, which is the point: the Target has the mechanism
    // and cannot assert an audience wider than one GitHub user. It lights up
    // the day it can, with no Spindrift change.
    expect(
      exclusionsFor(
        offsite(),
        requirements({ reach: 'public', auth: 'proxy' }),
      ),
    ).toEqual(['AUTH_UNSUPPORTED']);
  });

  test('the unroutable cell is refused before it can be placed', () => {
    // A filter needs a route to sit on. Refused at validation, so placement
    // never sees it — but if it did, auth would still find nothing to attach to.
    expect(
      exclusionsFor(offsite(), requirements({ reach: 'none', auth: 'proxy' })),
    ).toContain('AUTH_UNSUPPORTED');
  });

  test('a Component with no reach needs neither a gateway nor an edge', () => {
    expect(
      exclusionsFor(
        target({ reaches: ['none'], authReaches: [], routesAttachTo: false }),
        requirements({ reach: 'none', auth: 'none' }),
      ),
    ).toEqual([]);
  });
});

describe('§3: a Target is refused on each fact it asserts', () => {
  test('a reach it does not serve', () => {
    // Folly is `private`-only on purpose — it is on Starlink, so it should be
    // pulling and not pushing. That is a fact about the site, not a limitation.
    const folly = target({ reaches: ['none', 'private'] });
    expect(
      exclusionsFor(folly, requirements({ reach: 'public', auth: 'none' })),
    ).toContain('REACH_UNSUPPORTED');
    expect(
      exclusionsFor(folly, requirements({ reach: 'private', auth: 'none' })),
    ).toEqual([]);
  });

  test('an auth it cannot honestly offer', () => {
    expect(
      exclusionsFor(
        target({ reaches: ['none', 'private'], authReaches: [] }),
        requirements({ reach: 'private', auth: 'proxy' }),
      ),
    ).toContain('AUTH_UNSUPPORTED');
  });

  test('a gateway it never named', () => {
    // §3's grammar over the failure that produced this ticket: a green Deploy
    // whose `parentRefs` named the empty string, and a URL nothing answered.
    expect(
      exclusionsFor(
        target({ routesAttachTo: false }),
        requirements({ reach: 'private', auth: 'proxy' }),
      ),
    ).toContain('NO_GATEWAY');
  });

  test('and a backend that routes its own workloads never fails that way', () => {
    expect(
      exclusionsFor(
        target({ adapter: 'cloudrun' }),
        requirements({ kind: 'service', reach: 'public', auth: 'none' }),
      ),
    ).not.toContain('NO_GATEWAY');
  });
});
