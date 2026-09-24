import { describe, expect, test } from 'bun:test';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  ASSERTED_REACHES_BY_ADAPTER,
  type CapabilityContext,
  resolveCapabilities,
} from '../../src/domain/capabilities.ts';
import type { ArtifactType } from '../../src/domain/desired-state.ts';
import {
  artifactTypeFor,
  DEFAULT_PLATFORM,
  type DerivedRequirements,
  exclusionsFor,
  type PlacementTarget,
  resolvePlacement,
  takesShape,
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
  vercel: ['vercel-output', 'files'],
  'cloudflare-pages': ['files'],
} as const satisfies Record<TargetAdapter, readonly ArtifactType[]>;

/** One Target, capable of everything except what a test says otherwise. */
function target(
  overrides: {
    id?: string;
    vessel?: string;
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
    vessel: overrides.vessel ?? adapter,
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
        // A test that says nothing about reach gets what the adapter serves.
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
        target({ id: 'second', vessel: 'cloud', adapter: 'cloudrun', rank: 5 }),
        target({ id: 'first', vessel: 'cluster', rank: 1 }),
      ],
      // A reach both serve, so neither Target is filtered out.
      requirements({ reach: 'none', auth: 'none' }),
    );
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
    // The default reach is private, which the public-only static Target lacks.
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
    expect(
      exclusionsFor(target({ quotaExhausted: true }), requirements()),
    ).toEqual(['QUOTA_EXHAUSTED']);
  });

  test('an unhealthy Target is a non-candidate with a stated reason', () => {
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
  test('a shape the destination has no rendering of forces a rebuild', () => {
    // A Build's key includes its target shape.
    expect(takesShape('website', 'image', target({ adapter: 'static' }))).toBe(
      false,
    );
    expect(
      takesShape('website', 'vercel-output', target({ adapter: 'static' })),
    ).toBe(false);
  });

  test('a same-shape move ships the artifact as is', () => {
    expect(
      takesShape('service', 'image', target({ adapter: 'kubernetes' })),
    ).toBe(true);
  });

  test('an accepted non-preferred shape ships as is too', () => {
    const vercel = target({ adapter: 'vercel' });
    expect(artifactTypeFor('website', vercel)).toBe('vercel-output');
    expect(takesShape('website', 'files', vercel)).toBe(true);
  });

  test('a Target with no adapter keeps taking what it always took', () => {
    // An empty accept list leaves only artifactTypeFor's answer.
    const bare = {
      capabilities: { artifactTypes: [] as readonly ArtifactType[] },
    };
    expect(takesShape('service', 'image', bare)).toBe(true);
    expect(takesShape('website', 'files', bare)).toBe(false);
  });
});

describe('an attached datastore constrains where its App can go', () => {
  const clusterLocal = {
    name: 'primary',
    engine: 'postgres' as const,
    clusterLocalTargetId: 'target-kubernetes',
  };

  test('at attach time, the cloud becomes a non-candidate', () => {
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

describe('registry reachability at Place', () => {
  test('a Target reaching none of them is excluded, with a reason', () => {
    const excluded = exclusionsFor(
      target({ discovery: { reachableRegistries: ['registry.internal'] } }),
      requirements({ registries: ['registry.example.test/ns'] }),
    );
    expect(excluded).toEqual(['REGISTRY_UNREACHABLE']);
  });

  test('a Target reaching any one of them is a candidate', () => {
    // Any, not all: an artifact is pulled from one registry.
    expect(
      exclusionsFor(
        target({ discovery: { reachableRegistries: ['ghcr.io'] } }),
        requirements({
          registries: ['ghcr.io/ns', 'registry.internal/ns'],
        }),
      ),
    ).toEqual([]);
  });

  test('a Target declaring host/namespace is a candidate for that same registry', () => {
    // Both this and artifactAddress match through pullableFrom.
    expect(
      exclusionsFor(
        target({ discovery: { reachableRegistries: ['ghcr.io/jonpulsifer'] } }),
        requirements({ registries: ['ghcr.io/jonpulsifer'] }),
      ),
    ).toEqual([]);
  });

  test('declaring nothing is no restriction, not "reaches nothing"', () => {
    expect(
      exclusionsFor(
        target({ discovery: { reachableRegistries: [] } }),
        requirements({ registries: ['registry.example.test/ns'] }),
      ),
    ).toEqual([]);
  });

  test('a static Target is not asked the question', () => {
    // A website there is files from the depot, so no image is pulled.
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
    // Static hosting leaves an unauthenticated origin, so it is public only.
    const placement = resolvePlacement(
      [
        target({ id: 'cdn', vessel: 'hosting', adapter: 'static', rank: 0 }),
        target({ id: 'cluster', vessel: 'cluster', rank: 1 }),
      ],
      requirements({ kind: 'website', reach: 'private', auth: 'proxy' }),
    );

    expect(placement.suggested?.target.id).toBe('cluster');
    expect(placement.suggested?.artifactType).toBe('image');
    expect(placement.candidates.map((one) => one.target.id)).toEqual([
      'cluster',
    ]);
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
        target({ id: 'cdn', vessel: 'hosting', adapter: 'static', rank: 0 }),
        target({ id: 'cluster', vessel: 'cluster', rank: 1 }),
      ],
      requirements({ kind: 'website', reach: 'public', auth: 'none' }),
    );
    expect(placement.suggested?.target.id).toBe('cdn');
    expect(placement.suggested?.artifactType).toBe('files');
  });
});

describe('§10: the reach rule does not bind a website', () => {
  test('a Target that reaches no store still holds a website', () => {
    // A website's config is build arguments; nothing reads a store at runtime.
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
    const unreachable = target({
      discovery: { reachableSecretStores: [] },
    });
    expect(exclusionsFor(unreachable, requirements())).toContain(
      'STORE_UNREACHABLE',
    );
  });
});

describe('§3: a kind an adapter does not render is refused at Place', () => {
  test('a job is a candidate on the cloud runtime', () => {
    // A job reaches none because nothing routes to one.
    const cloud = target({ adapter: 'cloudrun' });
    expect(
      exclusionsFor(
        cloud,
        requirements({ kind: 'job', reach: 'none', auth: 'none' }),
      ),
    ).toEqual([]);
  });

  test('both backends that render a job also fire one', () => {
    // A cluster fires the chart's CronJob; Cloud Run uses Cloud Scheduler.
    const scheduled = requirements({
      kind: 'job',
      reach: 'none',
      auth: 'none',
      schedule: '0 3 * * *',
    });
    expect(exclusionsFor(target({ adapter: 'cloudrun' }), scheduled)).toEqual(
      [],
    );
    expect(exclusionsFor(target({ adapter: 'kubernetes' }), scheduled)).toEqual(
      [],
    );
  });

  test('a schedule nothing fires is still refused at Place, and only a schedule', () => {
    // Every adapter that renders a job fires one, so this Target is hand-built.
    const capable = target({ adapter: 'kubernetes' });
    const cadenceless: PlacementTarget = {
      ...capable,
      capabilities: { ...capable.capabilities, firesSchedules: false },
    };
    const unscheduled = requirements({
      kind: 'job',
      reach: 'none',
      auth: 'none',
    });
    const scheduled = { ...unscheduled, schedule: '0 3 * * *' };

    expect(exclusionsFor(cadenceless, scheduled)).toEqual(['NO_SCHEDULER']);
    expect(exclusionsFor(cadenceless, unscheduled)).toEqual([]);
    // NO_SCHEDULER's sentence grants that the Target runs a job, so it never
    // joins KIND_UNSUPPORTED. Static is public only, hence REACH_UNSUPPORTED.
    expect(exclusionsFor(target({ adapter: 'static' }), scheduled)).toEqual([
      'KIND_UNSUPPORTED',
      'REACH_UNSUPPORTED',
    ]);
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
  const offsite = () =>
    target({
      reaches: ['none', 'private', 'public'],
      authReaches: ['private'],
    });

  test('the four routed cells, three met and one unmet', () => {
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

    expect(
      exclusionsFor(
        offsite(),
        requirements({ reach: 'public', auth: 'proxy' }),
      ),
    ).toEqual(['AUTH_UNSUPPORTED']);
  });

  test('the unroutable cell is refused before it can be placed', () => {
    // Validation refuses this cell first; auth needs a route to attach to.
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
    // Without one, parentRefs name an empty Gateway and nothing answers.
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
