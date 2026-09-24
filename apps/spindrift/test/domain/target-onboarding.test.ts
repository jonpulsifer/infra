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
    // An unmet checklist item is fixed on the Target, not by reconnecting it.
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

    // Connecting re-registers both Targets.
    expect(pending[0]?.surfaces).toEqual(['cloudrun', 'static']);
  });

  test('a cluster is one act named for the vessel it sits on', () => {
    expect(pendingConnections([unconfigured('kubernetes')])).toEqual([
      {
        kind: 'cluster',
        vessel: OFFSITE_VESSEL.name,
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
    // A copied API server reads as correct and points at the other cluster.
    expect(proposal).not.toHaveProperty('apiServer');
  });

  test('a cloud project carries its region and policy endpoint, never its project id or either API root', () => {
    const proposal = connectionProposal(
      [CLOUD_RUN, CLOUD_STATIC],
      'gcp-project',
    );

    // Each endpoint is one hostname for every project, which its adapter
    // defaults. A policy endpoint has no default, so it is carried.
    expect(proposal).toEqual({
      carriedFrom: 'bluenose/cloudrun',
      region: 'northamerica-northeast1',
      policyEndpoint: 'https://binaryauthorization.googleapis.example',
    });
    expect(proposal).not.toHaveProperty('project');
  });

  test('it prefers a healthy Target to copy from', () => {
    const broken: OnboardingTargetRow = { ...CLUSTER, health: 'unhealthy' };

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
