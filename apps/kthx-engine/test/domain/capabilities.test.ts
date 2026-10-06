import { describe, expect, test } from 'bun:test';
import { targetAdapterSchema } from '../../src/config/manifest.schema.ts';
import {
  type CapabilityContext,
  capabilitiesOfRow,
  deriveHealth,
  deriveOfflineDeploy,
  deriveVerifiedDeploy,
  hostOf,
  KINDS_BY_ADAPTER,
  noCapabilities,
  PREREQUISITES,
  prerequisitesFor,
  resolveCapabilities,
  type TargetDiscovery,
} from '../../src/domain/capabilities.ts';
import { CAPABLE_DISCOVERY } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest } from '../harness/installation.ts';

const MANIFEST = await fixtureManifest();

const LOCAL_PATH = {
  chart: 'oci://registry.cluster.test/charts/app:1.0.0',
  images: ['registry.cluster.test/artifacts'],
  verifier: 'https://verifier.cluster.test/keys',
};

const SERVED = ['registry.cluster.test', 'verifier.cluster.test'];

function context(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return {
    adapter: 'kubernetes',
    artifactTypes: ['image'],
    reaches: null,
    authReaches: null,
    deployPath: LOCAL_PATH,
    ...overrides,
  };
}

function discovery(overrides: Partial<TargetDiscovery> = {}): TargetDiscovery {
  return { ...CAPABLE_DISCOVERY, servedHosts: SERVED, ...overrides };
}

describe('verifiedDeploy discovers enforcing, not installed', () => {
  test('an enforcing engine is capable of a verified deploy', () => {
    expect(deriveVerifiedDeploy({ installed: true, mode: 'ENFORCE' })).toBe(
      true,
    );
  });

  test('an audit-mode policy engine is not', () => {
    // An audit-only policy passes every deploy while verifying nothing.
    expect(deriveVerifiedDeploy({ installed: true, mode: 'AUDIT' })).toBe(
      false,
    );
  });

  test('and neither is one that is merely absent', () => {
    expect(deriveVerifiedDeploy({ installed: false, mode: null })).toBe(false);
  });

  test('the derivation reaches the resolved capabilities', () => {
    const audited = resolveCapabilities(
      discovery({ policyEngine: { installed: true, mode: 'AUDIT' } }),
      context(),
    );
    expect(audited.verifiedDeploy).toBe(false);
    expect(resolveCapabilities(discovery(), context()).verifiedDeploy).toBe(
      true,
    );
  });
});

describe('offlineDeploy is a static check over three references', () => {
  test('true when every host is one the Target serves', () => {
    expect(deriveOfflineDeploy(LOCAL_PATH, SERVED)).toBe(true);
  });

  test('false when the chart ref is off-cluster', () => {
    const offCluster = {
      ...LOCAL_PATH,
      chart: 'oci://charts.example.test/app:1.0.0',
    };
    expect(deriveOfflineDeploy(offCluster, SERVED)).toBe(false);
    expect(
      resolveCapabilities(discovery(), context({ deployPath: offCluster }))
        .offlineDeploy,
    ).toBe(false);
  });

  test('false when the Target serves nothing at all', () => {
    expect(deriveOfflineDeploy(LOCAL_PATH, [])).toBe(false);
  });

  test('the host is read without scheme, port, path, or tag', () => {
    expect(hostOf('oci://registry.cluster.test:5000/charts/app:1.0.0')).toBe(
      'registry.cluster.test',
    );
    expect(hostOf('registry.cluster.test/app@sha256:abc')).toBe(
      'registry.cluster.test',
    );
  });

  test('an unparseable reference fails closed', () => {
    expect(deriveOfflineDeploy({ ...LOCAL_PATH, images: [''] }, SERVED)).toBe(
      false,
    );
  });
});

describe('the provenances that are not discovered', () => {
  test('kinds come from the adapter type, not from the Target', () => {
    expect(KINDS_BY_ADAPTER.static).toEqual(['website']);
    expect(
      resolveCapabilities(discovery(), context({ adapter: 'static' })).kinds,
    ).toEqual(['website']);
  });

  test('an unasserted reach falls back to what the adapter serves', () => {
    expect(
      resolveCapabilities(discovery(), context({ adapter: 'kubernetes' }))
        .reaches,
    ).toEqual(['none', 'private']);
    expect(
      resolveCapabilities(discovery(), context({ reaches: ['public'] }))
        .reaches,
    ).toEqual(['public']);
  });

  test('an unasserted authenticated edge is no edge', () => {
    // Claiming an edge nobody wired would promise a filter that is not there.
    expect(resolveCapabilities(discovery(), context()).authReaches).toEqual([]);
  });

  test('firing a schedule takes the adapter and the Target both', () => {
    // Cloud Scheduler authenticates its jobs.run call, so a Cloud Run Target
    // with no runtime identity has nothing to fire a schedule as.
    const cloud = { adapter: 'cloudrun', project: 'vessel' } as const;
    const capable = capabilitiesOfRow(
      {
        adapter: 'cloudrun',
        discovery: discovery(),
        reaches: null,
        authReaches: null,
        connection: { ...cloud, serviceAccount: 'runtime@vessel.test' },
      },
      { artifactTypes: ['image'], manifest: MANIFEST },
    );
    expect(capable.firesSchedules).toBe(true);

    const anonymous = capabilitiesOfRow(
      {
        adapter: 'cloudrun',
        discovery: discovery(),
        reaches: null,
        authReaches: null,
        connection: cloud,
      },
      { artifactTypes: ['image'], manifest: MANIFEST },
    );
    expect(anonymous.firesSchedules).toBe(false);
    // A connection can only subtract from what the adapter fires.
    expect(
      capabilitiesOfRow(
        {
          adapter: 'kubernetes',
          discovery: discovery(),
          reaches: null,
          authReaches: null,
          connection: { adapter: 'kubernetes' },
        },
        { artifactTypes: ['image'], manifest: MANIFEST },
      ).firesSchedules,
    ).toBe(true);
  });

  test('a Target nothing could be discovered about is capable of nothing', () => {
    const none = noCapabilities(context({ artifactTypes: [] }));
    expect(none.artifactTypes).toEqual([]);
    expect(none.verifiedDeploy).toBe(false);
    expect(none.offlineDeploy).toBe(false);
    expect(none.logHistorySeconds).toBe(0);
  });
});

describe('health is the whole checklist', () => {
  test('healthy is every item met', () => {
    expect(
      deriveHealth(
        prerequisitesFor('kubernetes').map((name) => ({ name, met: true })),
        'kubernetes',
      ),
    ).toBe('healthy');
  });

  test('one unmet item is unhealthy', () => {
    const checklist = prerequisitesFor('kubernetes').map((name) => ({
      name,
      met: name !== 'OIDC_FEDERATION',
    }));
    expect(deriveHealth(checklist, 'kubernetes')).toBe('unhealthy');
  });

  test('a partial checklist is unhealthy, never healthy by omission', () => {
    expect(deriveHealth([{ name: 'VESSEL', met: true }], 'kubernetes')).toBe(
      'unhealthy',
    );
  });
});

describe('the checklist is the adapter type\u2019s, not one list for all three', () => {
  test('every adapter type is assessed against a non-empty checklist', () => {
    for (const adapter of targetAdapterSchema.options) {
      expect(prerequisitesFor(adapter).length).toBeGreaterThan(0);
    }
  });

  test('a cloud Target is never asked about a chart or a delivery operator', () => {
    for (const adapter of ['cloudrun', 'static'] as const) {
      expect(prerequisitesFor(adapter)).not.toContain('DELIVERY_OPERATOR');
      expect(prerequisitesFor(adapter)).not.toContain('CHART_SOURCE');
      expect(prerequisitesFor(adapter)).not.toContain('CHART_CONTRACT');
    }
  });

  test('every checklist is drawn from the one vocabulary', () => {
    for (const adapter of targetAdapterSchema.options) {
      for (const name of prerequisitesFor(adapter)) {
        expect(PREREQUISITES).toContain(name);
      }
    }
  });

  test('a cloud Target answering a cluster checklist is unhealthy', () => {
    // Every row is met, but none is a row a Cloud Run Target is asked.
    const cluster = prerequisitesFor('kubernetes').map((name) => ({
      name,
      met: true,
    }));
    expect(deriveHealth(cluster, 'cloudrun')).toBe('unhealthy');
  });
});
