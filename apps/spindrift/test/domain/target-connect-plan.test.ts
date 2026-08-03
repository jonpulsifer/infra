/**
 * Connecting a cluster, component by component (§13, §3, §7).
 *
 * The screen's whole job is turning "include this, leave that out" into one
 * `connectTarget` act, and three of the values it produces are **derived from
 * what was included** rather than typed. Each one is a wrong-by-default trap if
 * it is not derived, so each gets a test:
 *
 * - A Target that serves a gateway reaches `private`; one that does not reaches
 *   only `none`. Claiming a reach with no address behind it is how a Component
 *   gets a DNS record pointing nowhere.
 * - The chart's ingress is default-deny, so a route attached to a gateway whose
 *   namespace is not in `allowedNamespaces` renders correctly and reaches
 *   nothing — the failure that looks like a working deploy.
 * - `authReaches` never claims `public`, whatever edge was included.
 *
 * And the fourth claim, which is the point of the whole screen: **what the UI
 * writes and what the manifest declares are one shape.** `targetSeedOf` renders
 * the same act as the document that would perform it, so the test asserts the
 * declaration round-trips through the manifest's own schema rather than merely
 * looking plausible.
 */
import { describe, expect, test } from 'bun:test';
import { targetSeedSchema } from '../../src/config/manifest.schema.ts';
import {
  type ClusterConnectChoices,
  clusterConnectPlan,
  targetSeedOf,
} from '../../src/domain/target-onboarding.ts';

const BASE: ClusterConnectChoices = {
  name: 'metal',
  apiServer: 'https://cluster.invalid:6443',
  namespace: 'apps',
  deliveryNamespace: 'apps',
  sourceRef: { name: 'charts', namespace: 'delivery' },
  gateway: null,
  externalAuth: null,
  secretStore: null,
  tunnelHostname: null,
};

/** Everything a fully blended cluster offers, as the probe would report it. */
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
    // The chart admits same-namespace siblings unconditionally, so naming the
    // workload namespace here would be a line that means nothing — and the
    // installation's own manifest says so in the same words.
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
    // The proxy fronts the public address just as well; whether its policy is
    // honest there is a claim nobody made, so the plan does not make it.
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

    // §7: `app` and `shared` are rendered per deploy. Saving either here would
    // be storing a value the next deploy overwrites.
    expect(Object.keys(plan.chartValues)).toEqual(['platform']);
  });

  test('declares the same connection the manifest would', () => {
    const plan = clusterConnectPlan(BLENDED);
    const parsed = targetSeedSchema.safeParse(targetSeedOf(plan));

    if (!parsed.success) throw parsed.error;
    // The discriminant survives, which is what makes this the manifest's own
    // cluster arm rather than something that merely parsed.
    if (parsed.data.adapter !== 'kubernetes') {
      throw new Error(`declared a ${parsed.data.adapter} Target`);
    }
    expect(parsed.data.name).toBe('metal');
    expect(parsed.data.reaches).toEqual(plan.reaches);
    expect(parsed.data.connection?.apiServer).toBe(BASE.apiServer);
    expect(parsed.data.connection?.chartValues).toEqual(plan.chartValues);
  });
});

/** The operator's class, as the App chart reads it. */
function platformOf(plan: {
  chartValues: Record<string, unknown>;
}): Record<string, unknown> {
  return plan.chartValues.platform as Record<string, unknown>;
}
