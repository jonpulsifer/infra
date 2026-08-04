/**
 * The two capabilities core refuses to take an adapter's word for (§32, §33).
 *
 * Both are derivations, and both exist because the obvious reading is wrong in a
 * way that produces a green result:
 *
 * - A policy engine that is installed but auditing lets every deploy pass while
 *   verifying nothing, so `verifiedDeploy` has to discover **enforcing**.
 * - A deploy path whose chart lives off-Target is not an offline deploy, however
 *   healthy the Target looks, so `offlineDeploy` is checked over all three
 *   references rather than assumed from one.
 */
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

/** Read once: nothing here asserts on the manifest, only through it. */
const MANIFEST = await fixtureManifest();

/** A deploy path served entirely by the Target itself. */
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
    // §32: "under an audit-only policy a green deploy proves nothing."
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
    // The chart is the reference most easily left pointing at the internet,
    // and §33 counts all three precisely so one of them cannot be forgotten.
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
    // The claim is that a deploy needs nothing off-Target. A reference nobody
    // can read is not evidence for that claim.
    expect(deriveOfflineDeploy({ ...LOCAL_PATH, images: [''] }, SERVED)).toBe(
      false,
    );
  });
});

describe('the provenances that are not discovered', () => {
  test('kinds come from the adapter type, not from the Target', () => {
    // §13: splitting the cloud Targets is what makes picking the static one
    // *mean* public — and it only means that because it runs websites alone.
    expect(KINDS_BY_ADAPTER.static).toEqual(['website']);
    expect(
      resolveCapabilities(discovery(), context({ adapter: 'static' })).kinds,
    ).toEqual(['website']);
  });

  test('an unasserted reach falls back to what the adapter serves', () => {
    // Nobody having asserted a tunnel is not the same as there being one — but
    // it is also not the same as the cluster having no address at all. The
    // floor is what the backend does by construction, and `public` is not on it.
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
    // The direction that fails closed: claiming auth nobody wired would put a
    // Component behind a filter that is not there.
    expect(resolveCapabilities(discovery(), context()).authReaches).toEqual([]);
  });

  test('firing a schedule takes the adapter and the Target both', () => {
    // §3's grammar: a refusal a Target's own configuration already decides
    // belongs at Place rather than after a build. A Cloud Scheduler job
    // authenticates the `jobs.run` call it makes, so a Cloud Run Target naming
    // no runtime identity has nothing for a schedule to fire *as* — and the
    // adapter refuses it at apply, which is the after-the-build refusal this
    // row exists to avoid.
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
    // And it subtracts only: a cluster connection has nothing that could
    // withdraw the cadence its adapter keeps.
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
    // An item nobody answered is an item nobody checked. Reading absence as
    // success is how a Target ends up green on a prerequisite it never met.
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
    // §13's list is written in a cluster's terms because a cluster is what it
    // was written about. A Cloud Run Target has no operator to run and no chart
    // to pin, and a row that can never fail teaches a reader that something was
    // checked when nothing was.
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
    // The rows it answered are all met; they are simply not the rows a Cloud
    // Run Target is asked, so health must not read them as an answer.
    const cluster = prerequisitesFor('kubernetes').map((name) => ({
      name,
      met: true,
    }));
    expect(deriveHealth(cluster, 'cloudrun')).toBe('unhealthy');
  });
});
