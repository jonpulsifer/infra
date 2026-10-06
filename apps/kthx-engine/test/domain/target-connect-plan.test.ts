import { describe, expect, test } from 'bun:test';
import {
  targetSeedSchema,
  vesselSeedSchema,
} from '../../src/config/manifest.schema.ts';
import {
  type ClusterConnectChoices,
  clusterConnectPlan,
  targetSeedOf,
  vesselSeedOf,
} from '../../src/domain/target-onboarding.ts';

const BASE: ClusterConnectChoices = {
  vessel: 'metal',
  apiServer: 'https://cluster.invalid:6443',
  namespace: 'apps',
  delivery: {
    flavour: 'flux-helmrelease',
    namespace: 'apps',
    sourceRef: { name: 'charts', namespace: 'delivery' },
  },
  gateway: null,
  externalAuth: null,
  secretStore: null,
  tunnelHostname: null,
};

const BLENDED: ClusterConnectChoices = {
  ...BASE,
  gateway: { name: 'shared', namespace: 'edge', privateAddress: '10.0.0.9' },
  externalAuth: { name: 'proxy', namespace: 'auth', port: 80 },
  secretStore: 'store',
  tunnelHostname: 'tunnel.invalid',
};

describe('a cluster connect plan', () => {
  test('reaches only in-cluster when nothing was included', () => {
    const plan = clusterConnectPlan(BASE);

    expect(plan.reaches).toEqual(['none']);
    expect(plan.authReaches).toEqual([]);
  });

  test('a gateway with an address is what makes the private reach real', () => {
    const plan = clusterConnectPlan({ ...BASE, gateway: BLENDED.gateway });

    expect(plan.reaches).toEqual(['none', 'private']);
    expect(platformOf(plan).dns).toEqual({
      privateAddress: '10.0.0.9',
      tunnelHostname: '',
    });
  });

  test('a gateway that has no address yet claims no reach', () => {
    const plan = clusterConnectPlan({
      ...BASE,
      gateway: { name: 'shared', namespace: 'edge', privateAddress: null },
    });

    expect(plan.reaches).toEqual(['none']);
  });

  test('every included component opens the default-deny ingress', () => {
    const plan = clusterConnectPlan(BLENDED);

    expect(platformOf(plan).networkPolicy).toEqual({
      allowedNamespaces: ['edge', 'auth'],
    });
  });

  test('a gateway beside the workloads needs no entry of its own', () => {
    // The chart already admits pods from the workload namespace.
    const plan = clusterConnectPlan({
      ...BLENDED,
      gateway: { name: 'apps', namespace: 'apps', privateAddress: '10.0.0.9' },
    });

    expect(platformOf(plan).networkPolicy).toEqual({
      allowedNamespaces: ['auth'],
    });
  });

  test('a component left out opens nothing on its behalf', () => {
    const plan = clusterConnectPlan({ ...BASE, gateway: BLENDED.gateway });

    expect(platformOf(plan).networkPolicy).toEqual({
      allowedNamespaces: ['edge'],
    });
    expect(platformOf(plan).externalAuth).toBeUndefined();
  });

  test('an authenticated edge answers privately and never publicly', () => {
    const plan = clusterConnectPlan(BLENDED);

    expect(plan.reaches).toEqual(['none', 'private', 'public']);
    // The proxy fronts the public address too, but nobody vouched for it there.
    expect(plan.authReaches).toEqual(['private']);
  });

  test('an edge with no private reach behind it claims nothing', () => {
    const plan = clusterConnectPlan({
      ...BASE,
      externalAuth: BLENDED.externalAuth,
    });

    expect(plan.authReaches).toEqual([]);
  });

  test('writes only the operator’s value class', () => {
    const plan = clusterConnectPlan(BLENDED);

    // app and shared are rendered per deploy and would overwrite a saved value.
    expect(Object.keys(plan.chartValues)).toEqual(['platform']);
  });

  test('declares the same connection the manifest would', () => {
    const plan = clusterConnectPlan(BLENDED);
    const parsed = targetSeedSchema.safeParse(targetSeedOf(plan));

    if (!parsed.success) throw parsed.error;
    if (parsed.data.adapter !== 'kubernetes') {
      throw new Error(`declared a ${parsed.data.adapter} Target`);
    }
    expect(parsed.data.vessel).toBe('metal');
    expect(parsed.data.reaches).toEqual(plan.reaches);
    expect(parsed.data.connection?.chartValues).toEqual(plan.chartValues);
  });

  test('declares an Argo Target the manifest’s own way', () => {
    const plan = clusterConnectPlan({
      ...BLENDED,
      delivery: {
        flavour: 'argo-application',
        namespace: 'argocd',
        project: 'default',
        repoUrl: 'https://git.invalid/charts.git',
        revision: 'main',
        server: 'https://kubernetes.default.svc',
      },
    });
    const parsed = targetSeedSchema.safeParse(targetSeedOf(plan));

    if (!parsed.success) throw parsed.error;
    if (parsed.data.adapter !== 'kubernetes') {
      throw new Error(`declared a ${parsed.data.adapter} Target`);
    }
    expect(parsed.data.connection?.delivery).toEqual(plan.delivery);
    expect(plan.reaches).toEqual(['none', 'private', 'public']);
    expect(platformOf(plan).networkPolicy).toEqual({
      allowedNamespaces: ['edge', 'auth'],
    });
  });

  test('declares the boundary the same act connects', () => {
    const plan = clusterConnectPlan(BLENDED);
    const parsed = vesselSeedSchema.safeParse(vesselSeedOf(plan));

    if (!parsed.success) throw parsed.error;
    if (parsed.data.kind !== 'cluster') {
      throw new Error(`declared a ${parsed.data.kind} vessel`);
    }
    expect(parsed.data.name).toBe('metal');
    expect(parsed.data.location?.apiServer).toBe(BASE.apiServer);
  });
});

/** The operator's class, as the App chart reads it. */
function platformOf(plan: {
  chartValues: Record<string, unknown>;
}): Record<string, unknown> {
  return plan.chartValues.platform as Record<string, unknown>;
}
