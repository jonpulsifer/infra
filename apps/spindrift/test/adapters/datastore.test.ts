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
    name: 'metal',
    adapter: 'kubernetes',
    connection: {
      adapter: 'kubernetes',
      apiServer: fake.apiServer,
      namespace: 'spindrift-apps',
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

    expect(ref).toBe('postgres/spindrift-apps/orders');
    const object = fake.get('clusters/spindrift-apps/orders');
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

    expect(ref).toBe('valkey/spindrift-apps/sessions');
    const object = fake.get('valkeyclusters/spindrift-apps/sessions');
    expect(object?.apiVersion).toBe('valkey.io/v1alpha1');
    // Persistence is set rather than left to the operator's ephemeral default:
    // a Datastore that empties on a reschedule is a cache with the wrong name.
    expect(object?.spec).toMatchObject({
      shards: 1,
      persistence: { size: '1Gi' },
    });
  });

  test('a hyphenated name becomes a typeable SQL identifier', async () => {
    const { fake, adapter, target } = adapterOn();

    await adapter.provision(target, {
      name: 'order-history',
      engine: 'postgres',
      storageGiB: 1,
    });

    const spec = fake.get('clusters/spindrift-apps/order-history')?.spec as {
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
      'postgres/spindrift-apps/orders',
    );
    expect(first?.phase).toBe('WAITING');
    // No reference while it is coming up, even though the object exists.
    expect(first?.connection).toBeNull();
  });

  test('reports the CloudNativePG credential once the Secret exists', async () => {
    const { fake, adapter, target } = adapterOn();
    await adapter.provision(target, {
      name: 'orders',
      engine: 'postgres',
      storageGiB: 1,
    });
    fake.place('secrets/spindrift-apps/orders-app', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'orders-app', namespace: 'spindrift-apps' },
    });

    const state = await adapter.observe(
      target,
      'postgres/spindrift-apps/orders',
    );
    expect(state?.phase).toBe('LIVE');
    // §11: a reference, never the credential.
    expect(state?.connection).toBe('secret://spindrift-apps/orders-app');
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
      'valkey/spindrift-apps/sessions',
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
    fake.place('services/spindrift-apps/sessions', {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'sessions', namespace: 'spindrift-apps' },
    });

    const state = await adapter.observe(
      target,
      'valkey/spindrift-apps/sessions',
    );
    // No credential to reference: the operator authenticates nobody unless an
    // ACL user is declared, so the address is the whole of it.
    expect(state?.connection).toBe('valkey://sessions.spindrift-apps.svc:6379');
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
      'valkey/spindrift-apps/sessions',
    );
    expect(state?.phase).toBe('FAILED');
    expect(state?.reason).toBe('UNHEALTHY');
    expect(state?.detail).toBe('shard 0 has no primary');
  });

  test('is null for a datastore that is not there', async () => {
    const { adapter, target } = adapterOn();
    expect(await adapter.observe(target, 'postgres/spindrift-apps/gone')).toBe(
      null,
    );
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
    expect(fake.get('clusters/spindrift-apps/orders')).toBeUndefined();
    // Idempotent (§6): the second call is not an error.
    await adapter.destroy(target, ref);
  });
});

describe('the cloud adapter', () => {
  test('refuses to provision and names the fact it is missing', async () => {
    const adapter = new CloudDatastoreAdapter();
    const target: DeployTarget = {
      name: 'bluenose',
      adapter: 'cloudrun',
      connection: {
        adapter: 'cloudrun',
        region: 'northamerica-northeast2',
        endpoint: 'https://run.googleapis.com',
        project: 'bluenose',
      },
    };

    // The sentence is the deliverable: an operator reading it learns that the
    // gap is the vessel's network, not that "cloud datastores do not work".
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
