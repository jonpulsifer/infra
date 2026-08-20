/**
 * The datastore adapters (§11).
 *
 * The same shape every other adapter test takes (§ Seam 2): the real adapter
 * against a fake of the cluster's HTTP API, asserting what a cluster would have
 * been sent and what the adapter concluded from what it was told.
 *
 * The claims worth stating up front:
 *
 * - **The kind written is the kind discovered.** The deploy adapter's capability
 *   probe and this adapter's provisioning read one table, so a cluster cannot
 *   report the cache engine as served by an operator nothing then writes to.
 * - **A connection reference is confirmed, never assumed.** Both engines answer
 *   `null` until the object the reference names is actually there.
 * - **Phases come from the operator.** The adapter polls; it never decides a
 *   database is ready.
 * - The cloud adapter refuses, and **names what is missing** — the point of it
 *   is the sentence, not the stub.
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
      // Where this Target's Datastores go, which is no App's namespace: a
      // Datastore outlives every App attached to it.
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
    // A server-side apply, not a merge patch: re-provisioning has to converge on
    // the object rather than create a second one.
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
    // Persistence is set rather than left to the operator's ephemeral default:
    // a Datastore that empties on a reschedule is a cache with the wrong name.
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

    // Every field `restricted` demands, asserted as the standard states them
    // rather than as one blob: the operator supplies none of these, so a
    // regression here is not a wrong value but an object admission refuses —
    // and the refusal lands on a StatefulSet the adapter never reads.
    const spec = fake.get('valkeyclusters/spindrift-datastores/sessions')
      ?.spec as Record<string, any>;
    expect(spec.podSecurityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    // Not redundant beside `runAsNonRoot`: the valkey image has no `USER` and
    // drops from root itself, so without an explicit non-root uid the kubelet
    // refuses it as root-by-image.
    expect(spec.podSecurityContext.runAsUser).toBeGreaterThan(0);
    // The volume has to be writable by whatever that uid is.
    expect(spec.podSecurityContext.fsGroup).toBe(
      spec.podSecurityContext.runAsGroup,
    );
    // Container-only fields, so they cannot be satisfied by the pod block
    // above. The name is the operator's own container — a patch naming
    // anything else is silently a second container.
    const hardened = {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    };
    expect(spec.containers).toEqual([
      { name: 'server', securityContext: hardened },
    ]);
    // The sidecar the operator adds unasked is switched off, and the assertion
    // is on the switch rather than on the absence of a container: admission
    // fails the whole pod on whichever container lacks the fields above, so a
    // sidecar that came back without them would take the datastore with it.
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
    // Nothing was written: a refusal that had already applied half an object
    // would leave a cluster holding a datastore core does not know about.
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
    // No reference while it is coming up, even though the object exists.
    expect(first?.connection).toBeNull();
  });

  // Nothing is placed at `secrets/spindrift-datastores/orders-app`, deliberately: a
  // Ready CloudNativePG cluster is the statement that its `-app` Secret exists,
  // so the reference is named without reading it and this adapter needs no
  // grant on Secrets at all.
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
    // §11: a reference, never the credential.
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
    // `valkey-`, the prefix the operator gives everything it creates. A
    // Service placed under the bare name is the cluster as it is *not*.
    fake.place('services/spindrift-datastores/valkey-sessions', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'valkey-sessions', namespace: 'spindrift-datastores' },
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-datastores/sessions',
    );
    // No credential to reference: the operator authenticates nobody unless an
    // ACL user is declared, so the address is the whole of it. `redis://`
    // because this lands in `REDIS_URL` and no mainstream client parses a
    // `valkey://` scheme.
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
 * The read on red, for a datastore.
 *
 * The shape every test here is built to reproduce is the one that cost two
 * debugging sessions live: the custom resource says the operator is working,
 * and the sentence that matters is on an object the status read never touches.
 * A fake that only proved the plumbing would seed an event and assert it comes
 * back; what these assert instead is that the *operator's own cheerful line*
 * loses to it, and that nothing else changes.
 */
describe('a refusal underneath a stuck datastore', () => {
  /** What a StatefulSet reported while its pods were inadmissible. */
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
      // The operator's verdict about its own reconcile: nothing is wrong, it is
      // merely busy — which is what it will say forever.
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
    // The whole point of the issue: `WAITING` is still correct. A pod refused
    // admission comes up on the next apply once the manifest is fixed, so this
    // adds a sentence and never a verdict.
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
      // A cluster is never quiet. None of this is a refusal, and none of it is
      // allowed to displace the operator's own account of why it is waiting.
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
            // Written through `events.k8s.io`, which stamps `eventTime` and no
            // `lastTimestamp` — both orderings have to work or the newest event
            // loses to an older one carrying the other field.
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
      // The Role was never bound, or was bound without this rule. A diagnosis
      // that could not be loaded is not a reason to lose the operator's own
      // account as well.
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
    // Idempotent (§6): the second call is not an error.
    await adapter.destroy(target, ref);
  });
});

/**
 * The ingress exception around one Datastore (§127).
 *
 * The floor under it is Flux's — a default-deny plus the platform allow, in
 * `clusters/base/platform/spindrift-target/networkpolicy.yaml` — and this is
 * the half only Spindrift can write, because which App is attached is a row in
 * its database. What the assertions here pin is the part a live cluster
 * decides: the two operators' pod labels, and the direction.
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
      // CloudNativePG's own label on every instance pod, measured on a live
      // cluster rather than read off an API guarantee it does not make.
      podSelector: { matchLabels: { 'cnpg.io/cluster': 'orders' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
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
    // The one assertion that has to outlive whoever reads this next: an egress
    // policy on a datastore pod takes away CloudNativePG's instance manager
    // and both operators' DNS. Ingress is the only direction here, ever.
    expect(policy?.spec).not.toHaveProperty('egress');
    // A vanilla policy, not a `CiliumNetworkPolicy`: the chart reaches for the
    // Cilium kind only to name a gateway's identity, and no gateway fronts a
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
    // The engine with no credential behind the boundary: the network is the
    // authentication, so this is the case the whole story is about.
    expect(policy?.spec).toMatchObject({ policyTypes: ['Ingress'] });
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
    // Idempotent, like every other write here: revoking what is already
    // revoked is not an error, and the loop calls this on a schedule.
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

    // Nothing owns the policy — it selects the datastore's pods rather than
    // being the custom resource's child — so nothing else would collect it.
    expect(
      fake.get('networkpolicies/spindrift-datastores/spindrift-orders'),
    ).toBeUndefined();
  });

  test('a Datastore in the legacy namespace is left alone', async () => {
    const { fake, adapter, target } = adapterOn();
    const before = fake.requests.length;

    await adapter.permit(target, 'postgres/spindrift-apps/orders', [
      'app-storefront',
    ]);

    // `spindrift-apps` has no deny floor for an exception to sit on, and this
    // identity's Role there is read-and-remove only. A policy written into it
    // would protect nothing and could not be applied anyway.
    expect(fake.requests.slice(before)).toEqual([]);
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

    // The sentence is the deliverable: an operator reading it learns that the
    // gap is an unwritten provisioning path, not that "cloud datastores do
    // not work" — the vessel's network fact exists, this adapter's verbs
    // against Cloud SQL and Memorystore do not.
    await expect(
      adapter.provision(target, {
        name: 'orders',
        engine: 'postgres',
        storageGiB: 10,
      }),
    ).rejects.toThrow(UNIMPLEMENTED);
    // Observing sweeps past rather than throwing: nothing was ever provisioned.
    expect(await adapter.observe(target, 'anything')).toBe(null);
  });
});
