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
  name: 'offsite',
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
    chartContract: '2',
  },
};

const CLOUD_RUN: OnboardingTargetRow = {
  name: 'bluenose-cloudrun',
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
  name: 'bluenose-static',
  adapter: 'static',
  health: 'healthy',
  vessel: BLUENOSE_VESSEL,
  connection: {
    adapter: 'static',
    endpoint: 'https://firebasehosting.googleapis.example',
  },
};

function unconfigured(
  name: string,
  adapter: OnboardingTargetRow['adapter'],
  vessel: OnboardingTargetRow['vessel'] = adapter === 'kubernetes'
    ? OFFSITE_VESSEL
    : BLUENOSE_VESSEL,
): OnboardingTargetRow {
  return { name, adapter, health: 'unhealthy', connection: null, vessel };
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
      unconfigured('bluenose-cloudrun', 'cloudrun'),
      unconfigured('bluenose-static', 'static'),
    ]);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'gcp-project',
      name: 'bluenose',
      targets: ['bluenose-cloudrun', 'bluenose-static'],
    });
  });

  test('half a cloud project still names both Targets the act would write', () => {
    const pending = pendingConnections([
      CLOUD_RUN,
      unconfigured('bluenose-static', 'static'),
    ]);

    // Connecting re-registers the pair. Listing only the unconfigured half
    // would under-report what the button is about to touch.
    expect(pending[0]?.targets).toEqual([
      'bluenose-cloudrun',
      'bluenose-static',
    ]);
  });

  test('a Target whose name carries no adapter suffix is still offered', () => {
    // This used to be dropped: the act's name was recovered by slicing the
    // adapter suffix off the row's, so a row that carried none was
    // unconnectable — a Target the screen listed nowhere and no button could
    // reach. The boundary is a row now, so the name is read rather than
    // reconstructed and the convention binds nothing.
    expect(
      pendingConnections([unconfigured('anything-at-all', 'cloudrun')]),
    ).toEqual([
      {
        kind: 'gcp-project',
        name: BLUENOSE_VESSEL.name,
        targets: [
          `${BLUENOSE_VESSEL.name}-cloudrun`,
          `${BLUENOSE_VESSEL.name}-static`,
        ],
        proposal: { carriedFrom: null },
      },
    ]);
  });

  test('a cluster is one act named for the vessel it sits on', () => {
    expect(pendingConnections([unconfigured('folly', 'kubernetes')])).toEqual([
      {
        kind: 'cluster',
        name: OFFSITE_VESSEL.name,
        // One surface, so it takes the vessel's name unchanged: the suffix
        // exists to tell siblings apart and there are none.
        targets: [OFFSITE_VESSEL.name],
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
      carriedFrom: 'offsite',
      namespace: 'spindrift-apps',
      deliveryFlavour: 'flux-helmrelease',
      sourceRef: { name: 'infra', namespace: 'flux-system' },
      chartContract: '2',
    });
    // The one field that names a particular cluster.
    expect(proposal).not.toHaveProperty('apiServer');
  });

  test('a cloud project carries its endpoints and region, never its project id', () => {
    const proposal = connectionProposal(
      [CLOUD_RUN, CLOUD_STATIC],
      'gcp-project',
    );

    expect(proposal).toEqual({
      carriedFrom: 'bluenose-cloudrun',
      region: 'northamerica-northeast1',
      runEndpoint: 'https://run.googleapis.example',
      policyEndpoint: 'https://binaryauthorization.googleapis.example',
      hostingEndpoint: 'https://firebasehosting.googleapis.example',
    });
    expect(proposal).not.toHaveProperty('project');
  });

  test('it prefers a healthy Target to copy from', () => {
    const broken: OnboardingTargetRow = {
      ...CLUSTER,
      name: 'broken',
      health: 'unhealthy',
    };

    // Copying a Target that does not work forward is the fastest way to turn
    // one broken Target into two.
    expect(connectionProposal([broken, CLUSTER], 'cluster')).toMatchObject({
      carriedFrom: 'offsite',
    });
  });

  test('it falls back to an unhealthy Target rather than proposing nothing', () => {
    const broken: OnboardingTargetRow = { ...CLUSTER, health: 'unhealthy' };
    expect(connectionProposal([broken], 'cluster')).toMatchObject({
      carriedFrom: 'offsite',
    });
  });
});
