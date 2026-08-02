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

const CLUSTER: OnboardingTargetRow = {
  name: 'offsite',
  adapter: 'kubernetes',
  health: 'healthy',
  connection: {
    adapter: 'kubernetes',
    apiServer: 'https://kubernetes.default.svc',
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
  connection: {
    adapter: 'cloudrun',
    project: 'bluenose',
    region: 'northamerica-northeast1',
    endpoint: 'https://run.googleapis.example',
    policyEndpoint: 'https://binaryauthorization.googleapis.example',
  },
};

const CLOUD_STATIC: OnboardingTargetRow = {
  name: 'bluenose-static',
  adapter: 'static',
  health: 'healthy',
  connection: {
    adapter: 'static',
    project: 'bluenose',
    endpoint: 'https://firebasehosting.googleapis.example',
  },
};

function unconfigured(
  name: string,
  adapter: OnboardingTargetRow['adapter'],
): OnboardingTargetRow {
  return { name, adapter, health: 'unhealthy', connection: null };
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
      kind: 'cloud',
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

  test('a cloud Target whose name carries no adapter suffix is not offered', () => {
    // `connectTarget` derives both names from one project name, so there is no
    // input that would produce this row. A button for it would register two
    // Targets, neither of them this one.
    expect(pendingConnections([unconfigured('bluenose', 'cloudrun')])).toEqual(
      [],
    );
  });

  test('a cluster is one act named exactly as the manifest seeded it', () => {
    expect(pendingConnections([unconfigured('folly', 'kubernetes')])).toEqual([
      {
        kind: 'kubernetes',
        name: 'folly',
        targets: ['folly'],
        proposal: { carriedFrom: null },
      },
    ]);
  });
});

describe('what a connect may be prefilled with', () => {
  test('nothing, when this installation has nothing to learn from', () => {
    expect(connectionProposal([], 'kubernetes')).toEqual({ carriedFrom: null });
    expect(connectionProposal([], 'cloud')).toEqual({ carriedFrom: null });
  });

  test('a cluster carries its delivery and namespace, never its API server', () => {
    const proposal = connectionProposal([CLUSTER], 'kubernetes');

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
    const proposal = connectionProposal([CLOUD_RUN, CLOUD_STATIC], 'cloud');

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
    expect(connectionProposal([broken, CLUSTER], 'kubernetes')).toMatchObject({
      carriedFrom: 'offsite',
    });
  });

  test('it falls back to an unhealthy Target rather than proposing nothing', () => {
    const broken: OnboardingTargetRow = { ...CLUSTER, health: 'unhealthy' };
    expect(connectionProposal([broken], 'kubernetes')).toMatchObject({
      carriedFrom: 'offsite',
    });
  });
});
