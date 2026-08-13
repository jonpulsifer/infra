/**
 * What is left to connect, and what may honestly be proposed for it (§13).
 *
 * The two claims worth a test are the two that are easy to get subtly wrong:
 * a cloud project is **one** act and not two, and a proposal carries only the
 * values that are not per-instance. The second one is a correctness property,
 * not a nicety — a second cluster prefilled with the first one's in-cluster
 * API server reads as correct and points somewhere else.
 */
import { describe, expect, test } from 'bun:test';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  connectionProposal,
  type OnboardingTargetRow,
  pendingConnections,
} from '../../src/domain/target-onboarding.ts';

const OFFSITE_VESSEL = {
  id: 'vessel-offsite',
  name: 'offsite',
  kind: 'cluster',
} as const;
const BLUENOSE_VESSEL = {
  id: 'vessel-bluenose',
  name: 'bluenose',
  kind: 'gcp-project',
} as const;

const CLUSTER: OnboardingTargetRow = {
  adapter: 'kubernetes',
  health: 'healthy',
  vessel: OFFSITE_VESSEL,
  connection: {
    adapter: 'kubernetes',
    namespace: 'spindrift-apps',
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: 'spindrift-apps',
      sourceRef: { name: 'infra', namespace: 'flux-system' },
    },
  },
};

const CLOUD_RUN: OnboardingTargetRow = {
  adapter: 'cloudrun',
  health: 'healthy',
  vessel: BLUENOSE_VESSEL,
  connection: {
    adapter: 'cloudrun',
    region: 'northamerica-northeast1',
    endpoint: 'https://run.googleapis.example',
    policyEndpoint: 'https://binaryauthorization.googleapis.example',
  },
};

const CLOUD_STATIC: OnboardingTargetRow = {
  adapter: 'static',
  health: 'healthy',
  vessel: BLUENOSE_VESSEL,
  connection: {
    adapter: 'static',
    endpoint: 'https://firebasehosting.googleapis.example',
  },
};

function unconfigured(
  adapter: TargetAdapter,
  vessel: OnboardingTargetRow['vessel'] = adapter === 'kubernetes'
    ? OFFSITE_VESSEL
    : BLUENOSE_VESSEL,
): OnboardingTargetRow {
  return { adapter, health: 'unhealthy', connection: null, vessel };
}

describe('what is still waiting to be connected', () => {
  test('a fully configured installation is waiting on nothing', () => {
    expect(pendingConnections([CLUSTER, CLOUD_RUN, CLOUD_STATIC])).toEqual([]);
  });

  test('an unhealthy Target is not a pending connection', () => {
    // An unmet checklist item is something to fix on the Target. Offering a
    // connect form for it would be offering to re-supply facts that are
    // already right and are not what is broken.
    const broken = { ...CLUSTER, health: 'unhealthy' as const };
    expect(pendingConnections([broken])).toEqual([]);
  });

  test('a cloud project is one act naming both of its Targets', () => {
    const pending = pendingConnections([
      unconfigured('cloudrun'),
      unconfigured('static'),
    ]);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'gcp-project',
      vessel: 'bluenose',
      surfaces: ['cloudrun', 'static'],
    });
  });

  test('half a cloud project still names both Targets the act would write', () => {
    const pending = pendingConnections([CLOUD_RUN, unconfigured('static')]);

    // Connecting re-registers the pair. Listing only the unconfigured half
    // would under-report what the button is about to touch.
    expect(pending[0]?.surfaces).toEqual(['cloudrun', 'static']);
  });

  test('a cluster is one act named for the vessel it sits on', () => {
    expect(pendingConnections([unconfigured('kubernetes')])).toEqual([
      {
        kind: 'cluster',
        vessel: OFFSITE_VESSEL.name,
        // One surface, so it is the whole list §13 gives a cluster.
        surfaces: ['kubernetes'],
        proposal: { carriedFrom: null },
      },
    ]);
  });
});

describe('what a connect may be prefilled with', () => {
  test('nothing, when this installation has nothing to learn from', () => {
    expect(connectionProposal([], 'cluster')).toEqual({ carriedFrom: null });
    expect(connectionProposal([], 'gcp-project')).toEqual({
      carriedFrom: null,
    });
  });

  test('a cluster carries its delivery and namespace, never its API server', () => {
    const proposal = connectionProposal([CLUSTER], 'cluster');

    expect(proposal).toEqual({
      carriedFrom: 'offsite/kubernetes',
      namespace: 'spindrift-apps',
      deliveryFlavour: 'flux-helmrelease',
      sourceRef: { name: 'infra', namespace: 'flux-system' },
    });
    // The one field that names a particular cluster.
    expect(proposal).not.toHaveProperty('apiServer');
  });

  test('a cloud project carries its region and policy endpoint, never its project id or either API root', () => {
    const proposal = connectionProposal(
      [CLOUD_RUN, CLOUD_STATIC],
      'gcp-project',
    );

    // Neither `endpoint` is here: both are one hostname for every project, so
    // `cloudrun/index.ts` and `static/index.ts` each apply their own default
    // rather than this being a value a donor Target teaches. `policyEndpoint`
    // stays, because its presence is a real operator choice with no default —
    // see `CloudRunConnection.policyEndpoint`.
    expect(proposal).toEqual({
      carriedFrom: 'bluenose/cloudrun',
      region: 'northamerica-northeast1',
      policyEndpoint: 'https://binaryauthorization.googleapis.example',
    });
    expect(proposal).not.toHaveProperty('project');
  });

  test('it prefers a healthy Target to copy from', () => {
    const broken: OnboardingTargetRow = { ...CLUSTER, health: 'unhealthy' };

    // Copying a Target that does not work forward is the fastest way to turn
    // one broken Target into two.
    expect(connectionProposal([broken, CLUSTER], 'cluster')).toMatchObject({
      carriedFrom: 'offsite/kubernetes',
    });
  });

  test('it falls back to an unhealthy Target rather than proposing nothing', () => {
    const broken: OnboardingTargetRow = { ...CLUSTER, health: 'unhealthy' };
    expect(connectionProposal([broken], 'cluster')).toMatchObject({
      carriedFrom: 'offsite/kubernetes',
    });
  });
});
