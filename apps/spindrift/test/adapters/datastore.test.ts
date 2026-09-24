/**
 * The datastore adapters against a fake cluster API. Phases come from the
 * operator, and a connection stays `null` until the operator confirms it.
 */
import { describe, expect, test } from 'bun:test';
import {
  CloudDatastoreAdapter,
  UNIMPLEMENTED,
} from '../../src/adapters/datastore/gcp.ts';
import {
  DatastoreRequestError,
  ENGINE_KINDS,
  KubernetesDatastoreAdapter,
} from '../../src/adapters/datastore/kubernetes.ts';
import type { DeployTarget } from '../../src/adapters/deploy/contract.ts';
import {
  FakeKubernetes,
  type FakeKubernetesOptions,
} from '../harness/fakes/kubernetes-api.ts';

function targetOn(fake: FakeKubernetes): DeployTarget {
  return {
    vessel: 'metal',
    adapter: 'kubernetes',
    connection: {
      adapter: 'kubernetes',
      apiServer: fake.apiServer,
      namespace: 'spindrift-apps',
      // A Datastore outlives its Apps, so it lives in no App's namespace.
      datastoreNamespace: 'spindrift-datastores',
      delivery: {
        flavour: 'flux-helmrelease',
        namespace: 'delivery',
        sourceRef: { name: 'charts', namespace: 'delivery' },
      },
    },
  };
}

function adapterOn(options: FakeKubernetesOptions = {}): {
  fake: FakeKubernetes;
  adapter: KubernetesDatastoreAdapter;
  target: DeployTarget;
} {
  const fake = new FakeKubernetes(options);
  return {
    fake,
    adapter: new KubernetesDatastoreAdapter({
      token: fake.token,
      fetch: fake.fetch,
    }),
    target: targetOn(fake),
  };
}

describe('provision', () => {
  test('writes a CloudNativePG Cluster into the Target namespace', async () => {
    const { fake, adapter, target } = adapterOn();

    const ref = await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 4,
    });

    expect(ref).toBe('postgres/spindrift-datastores/orders');
    const object = fake.get('clusters/spindrift-datastores/orders');
    expect(object?.apiVersion).toBe(ENGINE_KINDS.postgres.apiVersion);
    expect(object?.kind).toBe('Cluster');
    expect(object?.spec).toMatchObject({
      instances: 1,
      storage: { size: '4Gi' },
      bootstrap: { initdb: { database: 'orders', owner: 'orders' } },
    });
    // Server-side apply, so re-provisioning converges on one object.
    expect(fake.requests.at(-1)?.contentType).toBe(
      'application/apply-patch+yaml',
    );
  });

  test('writes a ValkeyCluster with durable storage for valkey', async () => {
    const { fake, adapter, target } = adapterOn();

    const ref = await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    expect(ref).toBe('valkey/spindrift-datastores/sessions');
    const object = fake.get('valkeyclusters/spindrift-datastores/sessions');
    expect(object?.apiVersion).toBe('valkey.io/v1alpha1');
    // The operator's default storage is ephemeral.
    expect(object?.spec).toMatchObject({
      shards: 1,
      persistence: { size: '1Gi' },
    });
  });

  test('writes a ValkeyCluster the restricted standard will admit', async () => {
    const { fake, adapter, target } = adapterOn();

    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    // The operator sets none of these, and admission records its refusal on a
    // StatefulSet the adapter never reads.
    const spec = fake.get('valkeyclusters/spindrift-datastores/sessions')
      ?.spec as Record<string, any>;
    expect(spec.podSecurityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    // The valkey image has no `USER` and drops from root itself, so the kubelet
    // refuses it as root unless a non-root uid is explicit.
    expect(spec.podSecurityContext.runAsUser).toBeGreaterThan(0);
    // The volume has to be writable by whatever that uid is.
    expect(spec.podSecurityContext.fsGroup).toBe(
      spec.podSecurityContext.runAsGroup,
    );
    // `server` is the operator's own container; any other name adds a second.
    const hardened = {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    };
    expect(spec.containers).toEqual([
      { name: 'server', securityContext: hardened },
    ]);
    // The operator adds an exporter sidecar unasked, and admission would fail
    // the whole pod on it.
    expect(spec.exporter).toEqual({ enabled: false });
  });

  test('a hyphenated name becomes a typeable SQL identifier', async () => {
    const { fake, adapter, target } = adapterOn();

    await adapter.provision(target, {
      name: 'order-history',
      engine: 'postgres',
      storageGiB: 1,
    });

    const spec = fake.get('clusters/spindrift-datastores/order-history')
      ?.spec as {
      bootstrap: { initdb: { database: string; owner: string } };
    };
    expect(spec.bootstrap.initdb).toEqual({
      database: 'order_history',
      owner: 'order_history',
    });
  });

  test('refuses a name the backend cannot carry rather than truncating it', async () => {
    const { fake, adapter, target } = adapterOn();

    await expect(
      adapter.provision(target, {
        name: 'a'.repeat(64),
        engine: 'postgres',
        storageGiB: 1,
      }),
    ).rejects.toBeInstanceOf(DatastoreRequestError);
    expect(fake.pathsOf('PATCH')).toEqual([]);
  });
});

describe('observe', () => {
  test('is WAITING until CloudNativePG writes its Ready condition', async () => {
    const { adapter, target } = adapterOn({
      status: (reads) =>
        reads < 2
          ? null
          : {
              conditions: [
                { type: 'Ready', status: 'True', message: 'Cluster is Ready' },
              ],
            },
    });
    await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });

    const first = await adapter.observe(
      target,
      'postgres/spindrift-datastores/orders',
    );
    expect(first?.phase).toBe('WAITING');
    expect(first?.connection).toBeNull();
  });

  // A Ready CloudNativePG cluster implies its `-app` Secret exists, so the
  // adapter needs no grant on Secrets.
  test('names the CloudNativePG credential without reading it', async () => {
    const { adapter, target } = adapterOn();
    await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'postgres/spindrift-datastores/orders',
    );
    expect(state?.phase).toBe('LIVE');
    expect(state?.connection).toBe('secret://spindrift-datastores/orders-app');
  });

  test('a live Valkey with no Service yet reports no connection', async () => {
    const { adapter, target } = adapterOn({
      status: () => ({ state: 'Ready' }),
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.phase).toBe('LIVE');
    expect(state?.connection).toBeNull();
  });

  test('a Valkey Service makes the address the reference', async () => {
    const { fake, adapter, target } = adapterOn({
      status: () => ({ state: 'Ready' }),
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });
    // The operator prefixes everything it creates with `valkey-`.
    fake.place('services/spindrift-datastores/valkey-sessions', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'valkey-sessions', namespace: 'spindrift-datastores' },
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    // The operator authenticates nobody without an ACL user, and `redis://`
    // because no mainstream client parses `valkey://`.
    expect(state?.connection).toBe(
      'redis://valkey-sessions.spindrift-datastores.svc:6379',
    );
  });

  test('a degraded Valkey is FAILED with §6s reason for readiness that never passed', async () => {
    const { adapter, target } = adapterOn({
      status: () => ({ state: 'Degraded', message: 'shard 0 has no primary' }),
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.phase).toBe('FAILED');
    expect(state?.reason).toBe('UNHEALTHY');
    expect(state?.detail).toBe('shard 0 has no primary');
  });

  test('is null for a datastore that is not there', async () => {
    const { adapter, target } = adapterOn();
    expect(
      await adapter.observe(target, 'postgres/spindrift-datastores/gone'),
    ).toBe(null);
  });
});

/**
 * While the operator's status says it is still working, a refusal on an object
 * the status read never touches is the sentence that matters.
 */
describe('a refusal underneath a stuck datastore', () => {
  const INADMISSIBLE =
    'create Pod valkey-sessions-0 in StatefulSet valkey-sessions failed error: pods "valkey-sessions-0" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false';

  function event(fields: Record<string, unknown>): {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string };
    [key: string]: unknown;
  } {
    return {
      apiVersion: 'v1',
      kind: 'Event',
      metadata: { name: 'e', namespace: 'spindrift-datastores' },
      ...fields,
    };
  }

  test('outranks the operator saying it is still working', async () => {
    const { adapter, target } = adapterOn({
      // The operator reports this forever while its pods are refused.
      status: () => ({ state: 'Updating', message: 'Updating ValkeyNodes' }),
      lists: {
        events: [
          event({
            type: 'Warning',
            reason: 'FailedCreate',
            message: INADMISSIBLE,
            lastTimestamp: '2026-08-10T20:45:00Z',
            involvedObject: { name: 'valkey-sessions' },
          }),
        ],
      },
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.detail).toBe(INADMISSIBLE);
    // Still WAITING: a refused pod comes up once the manifest is fixed, so the
    // event changes the sentence and never the verdict.
    expect(state?.phase).toBe('WAITING');
    expect(state?.reason).toBeUndefined();
  });

  test('leaves an ordinary wait reporting what it reported before', async () => {
    const { adapter, target } = adapterOn({
      status: () => ({
        conditions: [
          {
            type: 'Ready',
            status: 'False',
            message: 'Waiting for the PVC to bind',
          },
        ],
      }),
      // None of these events is a refusal, so the operator's line stands.
      lists: {
        events: [
          event({
            type: 'Normal',
            reason: 'Provisioning',
            message: 'External provisioner is provisioning volume',
            lastTimestamp: '2026-08-10T20:45:00Z',
            involvedObject: { name: 'orders-1' },
          }),
          event({
            type: 'Warning',
            reason: 'ProvisioningFailed',
            message: 'storageclass.storage.k8s.io "fast" not found',
            lastTimestamp: '2026-08-10T20:46:00Z',
            involvedObject: { name: 'orders-1' },
          }),
        ],
      },
    });
    await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'postgres/spindrift-datastores/orders',
    );
    expect(state?.phase).toBe('WAITING');
    expect(state?.detail).toBe('Waiting for the PVC to bind');
  });

  test("does not read a neighbour's refusal into this datastore", async () => {
    const { adapter, target } = adapterOn({
      status: () => ({ state: 'Updating', message: 'Updating ValkeyNodes' }),
      lists: {
        events: [
          event({
            type: 'Warning',
            reason: 'FailedCreate',
            message: 'a different datastore in the same namespace is refused',
            lastTimestamp: '2026-08-10T20:45:00Z',
            involvedObject: { name: 'valkey-carts' },
          }),
        ],
      },
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.detail).toBe('Updating ValkeyNodes');
  });

  test('takes the newest of a refusal that repeated', async () => {
    const { adapter, target } = adapterOn({
      status: () => ({ state: 'Updating' }),
      lists: {
        events: [
          event({
            type: 'Warning',
            reason: 'FailedCreate',
            message: 'the first refusal, since fixed',
            lastTimestamp: '2026-08-10T20:45:00Z',
            involvedObject: { name: 'valkey-sessions' },
          }),
          event({
            type: 'Warning',
            reason: 'ExceededQuota',
            message: 'the one that is still true',
            // `events.k8s.io` sets `eventTime` and no `lastTimestamp`, so
            // both orderings must work.
            eventTime: '2026-08-10T21:05:00Z',
            involvedObject: { name: 'valkey-sessions' },
          }),
        ],
      },
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.detail).toBe('the one that is still true');
  });

  test('keeps the operator status line when events are refused', async () => {
    const { adapter, target } = adapterOn({
      status: () => ({ state: 'Updating', message: 'Updating ValkeyNodes' }),
      // Events are refused, as when the Role is unbound or lacks this rule.
      forbidden: ['events'],
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    expect(state?.phase).toBe('WAITING');
    expect(state?.detail).toBe('Updating ValkeyNodes');
  });

  test('costs a healthy datastore no read at all', async () => {
    const { fake, adapter, target } = adapterOn({
      status: () => ({ state: 'Ready' }),
    });
    await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });
    const before = fake.requests.length;

    await adapter.observe(target, 'valkey/spindrift-datastores/sessions');

    expect(
      fake.requests
        .slice(before)
        .some((request) => request.path.includes('/events')),
    ).toBe(false);
  });
});

describe('destroy', () => {
  test('removes the object and succeeds again when it is already gone', async () => {
    const { fake, adapter, target } = adapterOn();
    const ref = await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });

    await adapter.destroy(target, ref);
    expect(fake.get('clusters/spindrift-datastores/orders')).toBeUndefined();
    await adapter.destroy(target, ref);
  });
});

/**
 * The ingress exception around one Datastore. The default-deny floor under it
 * is in `clusters/base/platform/spindrift-target/networkpolicy.yaml`.
 */
describe('permit', () => {
  test('admits the App namespace and selects the datastore by its operator label', async () => {
    const { fake, adapter, target } = adapterOn();
    const ref = await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });

    await adapter.permit(target, ref, ['app-storefront']);

    const policy = fake.get(
      'networkpolicies/spindrift-datastores/spindrift-orders',
    );
    expect(policy?.apiVersion).toBe('networking.k8s.io/v1');
    expect(policy?.spec).toEqual({
      // CloudNativePG labels every instance pod this way, though no API
      // promises it.
      podSelector: { matchLabels: { 'cnpg.io/cluster': 'orders' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            { podSelector: { matchLabels: { 'cnpg.io/cluster': 'orders' } } },
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'app-storefront',
                },
              },
            },
          ],
        },
      ],
    });
    // An egress policy would cut off CloudNativePG's instance manager and both
    // operators' DNS.
    expect(policy?.spec).not.toHaveProperty('egress');
    // The Cilium kind is only needed to name a gateway, and none fronts a
    // datastore.
    expect(fake.all('ciliumnetworkpolicies')).toEqual([]);
  });

  test('selects a valkey datastore by the Valkey operator label', async () => {
    const { fake, adapter, target } = adapterOn();
    const ref = await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });

    await adapter.permit(target, ref, ['app-storefront']);

    const policy = fake.get(
      'networkpolicies/spindrift-datastores/spindrift-sessions',
    );
    expect(policy?.spec).toMatchObject({
      podSelector: { matchLabels: { 'valkey.io/cluster': 'sessions' } },
    });
    // Valkey authenticates nobody, so this policy is its only boundary.
    expect(policy?.spec).toMatchObject({ policyTypes: ['Ingress'] });
  });

  test('admits its own siblings and not the namespace they sit in', async () => {
    const { fake, adapter, target } = adapterOn();
    const mine = await adapter.provision(target, {
      name: 'sessions',
      engine: 'valkey',
      storageGiB: 1,
    });
    await adapter.provision(target, {
      name: 'other',
      engine: 'valkey',
      storageGiB: 1,
    });

    await adapter.permit(target, mine, ['app-storefront']);

    // A namespace-wide `podSelector: {}` would admit another App's Valkey; the
    // cluster label admits only replication and the cluster bus.
    const policy = fake.get(
      'networkpolicies/spindrift-datastores/spindrift-sessions',
    );
    const from = (policy!.spec as { ingress: { from: unknown[] }[] })
      .ingress[0]!.from;
    expect(from).toContainEqual({
      podSelector: { matchLabels: { 'valkey.io/cluster': 'sessions' } },
    });
    expect(from).not.toContainEqual({ podSelector: {} });
    // One policy per Datastore, so there is no shared one to widen.
    expect(
      fake.get('networkpolicies/spindrift-datastores/spindrift-other'),
    ).toBeUndefined();
  });

  test('an empty permitted set removes the object rather than emptying it', async () => {
    const { fake, adapter, target } = adapterOn();
    const ref = await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });
    await adapter.permit(target, ref, ['app-storefront']);

    await adapter.permit(target, ref, []);

    expect(
      fake.get('networkpolicies/spindrift-datastores/spindrift-orders'),
    ).toBeUndefined();
    // The loop calls this on a schedule, so revoking twice is not an error.
    await adapter.permit(target, ref, []);
  });

  test('destroying a Datastore takes its policy with it', async () => {
    const { fake, adapter, target } = adapterOn();
    const ref = await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });
    await adapter.permit(target, ref, ['app-storefront']);

    await adapter.destroy(target, ref);

    // Nothing owns the policy, so nothing else would collect it.
    expect(
      fake.get('networkpolicies/spindrift-datastores/spindrift-orders'),
    ).toBeUndefined();
  });

  test('a Datastore in the legacy namespace is left alone', async () => {
    const { fake, adapter, target } = adapterOn();
    const before = fake.requests.length;

    const written = await adapter.permit(
      target,
      'postgres/spindrift-apps/orders',
      ['app-storefront'],
    );

    // `spindrift-apps` has no deny floor, and this identity's Role there is
    // read-and-remove only.
    expect(fake.requests.slice(before)).toEqual([]);
    // False, so the caller records no permitted namespace.
    expect(written).toBe(false);
  });

  test('destroying a legacy Datastore does not reach for a policy', async () => {
    const { fake, adapter, target } = adapterOn({
      objects: {
        'clusters/spindrift-apps/orders': {
          apiVersion: 'postgresql.cnpg.io/v1',
          kind: 'Cluster',
          metadata: { name: 'orders', namespace: 'spindrift-apps' },
        },
      },
    });

    await adapter.destroy(target, 'postgres/spindrift-apps/orders');

    // The Role there grants no `networkpolicies`, and `delete` does not
    // swallow a `403`, so asking would leave the row undestroyable.
    expect(fake.get('clusters/spindrift-apps/orders')).toBeUndefined();
    expect(
      fake.requests.filter((request) =>
        request.path.includes('networkpolicies'),
      ),
    ).toEqual([]);
  });
});

describe('the cloud adapter', () => {
  test('refuses to provision and names the fact it is missing', async () => {
    const adapter = new CloudDatastoreAdapter();
    const target: DeployTarget = {
      vessel: 'bluenose',
      adapter: 'cloudrun',
      connection: {
        adapter: 'cloudrun',
        region: 'northamerica-northeast2',
        endpoint: 'https://run.googleapis.com',
        project: 'bluenose',
      },
    };

    await expect(
      adapter.provision(target, {
        name: 'orders',
        engine: 'postgres',
        storageGiB: 10,
      }),
    ).rejects.toThrow(UNIMPLEMENTED);
    expect(await adapter.observe(target, 'anything')).toBe(null);
  });
});
