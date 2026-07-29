/**
 * The connect and disconnect acts (Task 13, §13).
 *
 * Every test here is an assertion about a promise §13 makes that a normal
 * connect flow would break:
 *
 * - **Connect always succeeds.** Unreachable, no adapter at all — a Target still
 *   exists afterwards, unhealthy, with the reason stated. There is no input that
 *   makes this command return a failure.
 * - **Disconnect always works, and strands rather than stops.** No `destroy` is
 *   ever called, the workloads stay where they are, and the confirmation names
 *   them.
 * - **Reconnect re-adopts via `observe`** — the adapter is the authority on what
 *   is still running, not core's memory of what it last placed.
 *
 * Rows are what is asserted, not return values: a command that reported a Target
 * it never wrote would pass a test of its own output.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import {
  connectTarget,
  disconnectTarget,
  listTargets,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { deployState } from '../../src/domain/target.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  FakeDeployAdapter,
  type FakeDeployAdapterOptions,
} from '../harness/fakes/deploy-adapter.ts';
import {
  CLOUD_ENDPOINTS,
  cloudInput,
  clusterInput,
  connectionFor,
  fixtureManifest,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** One fake per adapter type, so a test can reach the one it connected. */
function fakes(
  options: Partial<Record<TargetAdapter, FakeDeployAdapterOptions | null>> = {},
) {
  const made = new Map<TargetAdapter, FakeDeployAdapter>();
  const registry: AdapterRegistry = {
    deploy(adapter) {
      // `null` is a configuration fact, not an error: an installation is
      // allowed not to ship an adapter, and connect has to survive that.
      if (options[adapter] === null) return null;
      let fake = made.get(adapter);
      if (!fake) {
        fake = new FakeDeployAdapter({ adapter, ...options[adapter] });
        made.set(adapter, fake);
      }
      return fake;
    },
    build: () => null,
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('Target command reached the supply chain');
    },
  };
  return {
    registry,
    of(adapter: TargetAdapter): FakeDeployAdapter {
      const fake = registry.deploy(adapter);
      if (fake === null) throw new Error(`no ${adapter} adapter in this test`);
      return fake as FakeDeployAdapter;
    },
  };
}

function context(registry: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: registry,
    manifest,
  };
}

/** The Target row as the database holds it. */
async function targetRow(name: string) {
  const rows = await database()
    .db.select()
    .from(targets)
    .where(eq(targets.name, name));
  return rows[0];
}

/** An App -> Component -> Build -> Deploy chain, live on one Target. */
async function seedLiveDeploy(targetId: string, ref: string) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'repo' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      targetId,
      buildId: build!.id,
      phase: 'LIVE',
      ref,
      url: 'https://web.example.test',
    })
    .returning();
  return { app: app!, component: component!, deploy: deploy! };
}

describe('connect always succeeds', () => {
  test('a reachable cluster is registered healthy, at the end of the rank', async () => {
    const { registry, of } = fakes();
    const result = await connectTarget(
      clusterInput({ name: 'cluster' }),
      context(registry),
    );

    expect(result.ok).toBe(true);
    const row = await targetRow('cluster');
    expect(row?.health).toBe('healthy');
    expect(row?.rank).toBe(0);
    expect(row?.status).toBe('connected');
    expect(row?.inspectedAt).toEqual(FROZEN);
    expect(row?.connection).toEqual(connectionFor('kubernetes'));
    expect(of('kubernetes').inspected).toHaveLength(1);
  });

  test('an unreachable endpoint still creates the Target, unhealthy', async () => {
    const { registry } = fakes({
      kubernetes: { unreachable: 'dial tcp: no route to host' },
    });
    const result = await connectTarget(
      clusterInput({ name: 'cluster' }),
      context(registry),
    );

    // §13: an unmet item makes the Target a non-candidate with a stated
    // reason. A connect that failed would leave nothing to state it about.
    expect(result.ok).toBe(true);
    const row = await targetRow('cluster');
    expect(row?.health).toBe('unhealthy');
    expect(row?.discovery).toBeNull();
    expect(row?.prerequisites?.every((item) => !item.met)).toBe(true);
    expect(row?.prerequisites?.[0]?.detail).toContain('no route to host');
  });

  test('a Target whose adapter this installation does not ship', async () => {
    const { registry } = fakes({ kubernetes: null });
    const result = await connectTarget(
      clusterInput({ name: 'cluster' }),
      context(registry),
    );

    expect(result.ok).toBe(true);
    const row = await targetRow('cluster');
    expect(row?.health).toBe('unhealthy');
    expect(row?.prerequisites?.[0]?.detail).toContain('no kubernetes adapter');
  });
});

describe('the act is credential-shaped though the noun is flat', () => {
  test('connecting a cloud project registers both of its Targets', async () => {
    const { registry } = fakes();
    const result = await connectTarget(
      cloudInput({ name: 'vessel', region: 'here' }),
      context(registry),
    );

    // §13: "one 'connect a cloud project' registers both project-specific
    // Targets, so a `Provider` noun earns nothing."
    if (!result.ok) throw new Error('connect refused');
    expect(result.value.targets.map((t) => t.adapter)).toEqual([
      'cloudrun',
      'static',
    ]);
    expect(result.value.targets.map((t) => t.rank)).toEqual([0, 1]);

    // Each Target keeps only the endpoint its own adapter drives: one connect
    // act asked for both, and neither Target carries the other's.
    expect((await targetRow('vessel-cloudrun'))?.connection).toEqual({
      adapter: 'cloudrun',
      project: 'example-vessel',
      region: 'here',
      endpoint: CLOUD_ENDPOINTS.run,
    });
    expect((await targetRow('vessel-static'))?.connection).toEqual({
      adapter: 'static',
      project: 'example-vessel',
      endpoint: CLOUD_ENDPOINTS.hosting,
    });
  });

  test('connect is idempotent by name and keeps the rank', async () => {
    const { registry } = fakes();
    const input = clusterInput({ name: 'cluster' });

    await connectTarget(
      cloudInput({ name: 'vessel', project: 'p', region: 'r' }),
      context(registry),
    );
    const first = await connectTarget(input, context(registry));
    const again = await connectTarget(input, context(registry));

    if (!first.ok || !again.ok) throw new Error('connect refused');
    expect(again.value.targets[0]?.id).toBe(first.value.targets[0]!.id);
    // Rank is one global ordered list (§13). Reconnecting must not reorder
    // what an operator already arranged.
    expect(again.value.targets[0]?.rank).toBe(2);
    const rows = await database().db.select().from(targets);
    expect(rows).toHaveLength(3);
  });

  test('connect fills a manifest-seeded Target without changing its rank', async () => {
    const { registry } = fakes();
    const [seed] = await database()
      .db.insert(targets)
      .values({
        name: 'cluster',
        adapter: 'kubernetes',
        rank: 4,
        status: 'disconnected',
        connection: null,
        health: 'unhealthy',
      })
      .returning();

    const result = await connectTarget(
      clusterInput({ name: 'cluster' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    const [connected] = result.value.targets;
    expect(connected?.id).toBe(seed?.id);
    expect(connected?.rank).toBe(4);
    expect((await targetRow('cluster'))?.connection).toEqual(
      connectionFor('kubernetes'),
    );
  });

  test('one cloud connect fills its matched manifest-seeded pair', async () => {
    const { registry } = fakes();
    const seeds = await database()
      .db.insert(targets)
      .values([
        {
          name: 'vessel-cloudrun',
          adapter: 'cloudrun',
          rank: 2,
          status: 'disconnected',
          connection: null,
          health: 'unhealthy',
        },
        {
          name: 'vessel-static',
          adapter: 'static',
          rank: 3,
          status: 'disconnected',
          connection: null,
          health: 'unhealthy',
        },
      ])
      .returning();

    const result = await connectTarget(
      cloudInput({ name: 'vessel' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(result.value.targets.map(({ id, rank }) => ({ id, rank }))).toEqual(
      seeds.map(({ id, rank }) => ({ id, rank })),
    );
    expect(await database().db.select().from(targets)).toHaveLength(2);
  });
});

describe('disconnect strands rather than stops', () => {
  test('live Deploys go orphaned and are named, and nothing is destroyed', async () => {
    const { registry, of } = fakes();
    await connectTarget(clusterInput({ name: 'cluster' }), context(registry));
    const target = (await targetRow('cluster'))!;
    const { app, component } = await seedLiveDeploy(target.id, 'ref-1');

    const result = await disconnectTarget(
      { name: 'cluster' },
      context(registry),
    );

    if (!result.ok) throw new Error('disconnect refused');
    expect(result.value.stranded).toEqual([
      {
        deployId: expect.any(String),
        app: app.name,
        component: component.name,
        url: 'https://web.example.test',
      },
    ]);

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.targetId, target.id));
    expect(row?.orphanedAt).toEqual(FROZEN);
    // The phase is untouched: the workload is still whatever the platform last
    // said it was. What changed is that Spindrift can no longer see it.
    expect(row?.phase).toBe('LIVE');
    expect(
      deployState({ phase: row!.phase, orphanedAt: row!.orphanedAt }),
    ).toBe('orphaned');
    expect((await targetRow('cluster'))?.status).toBe('disconnected');

    // A cluster being removed from the platform is exactly when tearing down
    // what runs on it would be the most destructive reading of the request.
    expect(of('kubernetes').destroyed).toEqual([]);
  });

  test('disconnecting a Target with nothing on it strands nothing', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'cluster' }), context(registry));
    const result = await disconnectTarget(
      { name: 'cluster' },
      context(registry),
    );
    if (!result.ok) throw new Error('disconnect refused');
    expect(result.value.stranded).toEqual([]);
  });

  test('an unknown Target is a refusal with an identity', async () => {
    const { registry } = fakes();
    const result = await disconnectTarget(
      { name: 'nowhere' },
      context(registry),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('reconnect re-adopts via observe', () => {
  test('a workload the adapter still sees is adopted back', async () => {
    const { registry, of } = fakes();
    const input = clusterInput({ name: 'cluster' });

    await connectTarget(input, context(registry));
    const target = (await targetRow('cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget({ name: 'cluster' }, context(registry));

    // The adapter is the authority on what is still running. Teach the fake
    // that the workload survived the disconnect.
    const adapter: DeployAdapter = of('kubernetes');
    (adapter as FakeDeployAdapter).place('ref-1', {
      ref: 'ref-1',
      phase: 'LIVE',
      artifactDigest: 'sha256:beef',
    });

    const result = await connectTarget(input, context(registry));
    if (!result.ok) throw new Error('connect refused');
    expect(result.value.readopted).toHaveLength(1);

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.targetId, target.id));
    expect(row?.orphanedAt).toBeNull();
    expect(
      deployState({ phase: row!.phase, orphanedAt: row!.orphanedAt }),
    ).toBe('live');
  });

  test('a workload that is gone stays orphaned rather than resurrected', async () => {
    const { registry } = fakes();
    const input = clusterInput({ name: 'cluster' });

    await connectTarget(input, context(registry));
    const target = (await targetRow('cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget({ name: 'cluster' }, context(registry));

    // The fake was never told about `ref-1`, so `observe` reports nothing —
    // which is the honest state, and core must not overwrite it with memory.
    const result = await connectTarget(input, context(registry));
    if (!result.ok) throw new Error('connect refused');
    expect(result.value.readopted).toEqual([]);

    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.targetId, target.id));
    expect(row?.orphanedAt).toEqual(FROZEN);
  });
});

describe('listTargets', () => {
  test('returns empty lists on an empty database', async () => {
    const { registry } = fakes();
    const result = await listTargets({}, context(registry));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets).toHaveLength(0);
      expect(result.value.options).toHaveLength(0);
    }
  });

  test('lists connected targets with rank, health, and candidate placement options', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'folly-k8s' }), context(registry));
    await connectTarget(
      cloudInput({ name: 'cloudrun-app' }),
      context(registry),
    );

    const result = await listTargets({}, context(registry));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets).toHaveLength(3); // 1 k8s + 2 cloud (cloudrun, static)
      expect(result.value.targets[0]?.name).toBe('folly-k8s');
      expect(result.value.targets[0]?.health).toBe('healthy');
      expect(result.value.options.length).toBeGreaterThan(0);
      const option = result.value.options.find((o) => o.name === 'folly-k8s');
      expect(option?.candidate).toBe(true);
    }
  });
});
