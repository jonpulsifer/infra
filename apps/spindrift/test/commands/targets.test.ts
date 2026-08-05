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
import {
  type InstallationManifest,
  type TargetAdapter,
  toAuthoredManifest,
} from '../../src/config/manifest.schema.ts';
import { MANIFEST_INLINE_VAR } from '../../src/config/manifest.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { deployState } from '../../src/domain/target.ts';
import { restoreDeclaredTargetConnections } from '../../src/reconciler/target-loop.ts';
import { defaultVesselId, withIsolatedDatabase } from '../harness/db.ts';
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
import { aDesiredDocument } from '../harness/release.ts';

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
      desired: aDesiredDocument(),
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
    // act asked for both, and neither Target carries the other's. The runtime
    // identity splits the same way — only this surface runs anything.
    expect((await targetRow('vessel-cloudrun'))?.connection).toEqual({
      adapter: 'cloudrun',
      region: 'here',
      endpoint: CLOUD_ENDPOINTS.run,
      serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
    });
    expect((await targetRow('vessel-static'))?.connection).toEqual({
      adapter: 'static',
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

  test('a reconnect updates what the operator asserted about reach', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'cluster' }), context(registry));
    expect((await targetRow('cluster'))?.reaches).toBeNull();

    // The connect screen derives both of these — `reaches` from the gateway's
    // private address and the tunnel hostname, `authReaches` from the
    // ExternalAuth backend — and posts them with every submission. The update
    // branch used to set connection, health, prerequisites, discovery,
    // inspectedAt, status and updatedAt and nothing else, so an operator
    // correcting a Target that already existed had their assertion silently
    // discarded and no way to see why.
    await connectTarget(
      clusterInput({
        name: 'cluster',
        reaches: ['none', 'private', 'public'],
        authReaches: ['private'],
      }),
      context(registry),
    );

    const row = await targetRow('cluster');
    expect(row?.reaches).toEqual(['none', 'private', 'public']);
    expect(row?.authReaches).toEqual(['private']);
  });

  test('connect fills a manifest-seeded Target without changing its rank', async () => {
    const { registry } = fakes();
    const [seed] = await database()
      .db.insert(targets)
      .values({
        name: 'cluster',
        adapter: 'kubernetes',
        vesselId: defaultVesselId('cluster'),
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
          vesselId: defaultVesselId('gcp-project'),
          rank: 2,
          status: 'disconnected',
          connection: null,
          health: 'unhealthy',
        },
        {
          name: 'vessel-static',
          adapter: 'static',
          vesselId: defaultVesselId('gcp-project'),
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

/**
 * 52: the correction an operator makes through the product, and the restart.
 *
 * `connectTarget` has always written the row. What made it useless on a
 * manifest-declared Target is that `loadStoredManifest` writes the stored
 * document back on every boot, and reconciliation used to re-assert the
 * document's copy of the connection over the row — so an operator who fixed a
 * gateway here got it reverted by the next rollout, silently, with the screen
 * that accepted the edit then showing the old values and no reason why.
 *
 * The precedence is now the one this module already applies to a mounted
 * declaration, one noun down: **the row wins and the divergence is reported.**
 */
describe('an operator’s Target correction outlives the next boot', () => {
  /** The manifest as Git declares it, naming whichever gateway it still names. */
  function declaredWithGateway(gateway: { name: string; namespace: string }) {
    const input = clusterInput({ name: 'cluster' });
    const platform = input.chartValues?.platform as Record<string, unknown>;
    return {
      ...toAuthoredManifest(manifest),
      vessels: [
        {
          name: 'cluster',
          kind: 'cluster' as const,
          location: { apiServer: input.apiServer },
        },
      ],
      targets: [
        {
          name: 'cluster',
          vessel: 'cluster',
          adapter: 'kubernetes' as const,
          connection: {
            namespace: input.namespace,
            delivery: input.delivery,
            chartValues: { platform: { ...platform, gateway } },
          },
        },
      ],
    };
  }

  test('the row still holds what was connected, and the manifest entry it now disagrees with is named', async () => {
    const { registry } = fakes();
    const declared = declaredWithGateway({
      name: 'gateway-that-moved',
      namespace: 'gateway-that-moved',
    });
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(declared),
    });
    expect((await targetRow('cluster'))?.connection).toMatchObject({
      chartValues: {
        platform: {
          gateway: { name: 'gateway-that-moved' },
        },
      },
    });

    // The correction, through the only act there is for it.
    const connected = await connectTarget(
      clusterInput({ name: 'cluster' }),
      context(registry),
    );
    expect(connected.ok).toBe(true);

    // The restart. Both pods do this; the reconciler and the web process each
    // call `loadStoredManifest` once at startup.
    const booted = await loadStoredManifest(database().db, {});

    const row = await targetRow('cluster');
    expect(row?.connection).toEqual(connectionFor('kubernetes'));
    // Not reset to awaiting-inspection either: nothing was declared, so there
    // is nothing about this Target's assessment for a boot to invalidate.
    expect(row?.health).toBe('healthy');
    expect(row?.inspectedAt).not.toBeNull();

    // And the disagreement is on the Target rather than in a pod log: Settings
    // still writes the whole document, so the operator has to be able to see
    // which paths saving it would take back — paths, never values.
    const listed = await listTargets(
      {},
      { ...context(registry), manifest: booted },
    );
    if (!listed.ok) throw new Error('listTargets refused');
    const cluster = listed.value.targets.find((t) => t.name === 'cluster');
    expect(cluster?.connectionDivergence).toEqual([
      'connection.chartValues.platform.gateway.name',
      'connection.chartValues.platform.gateway.namespace',
    ]);
    expect(JSON.stringify(cluster?.connectionDivergence)).not.toContain(
      'gateway-that-moved',
    );

    // The screen that made the correction possible: the edit opens on this
    // Target's own address, which is the one field a fresh connect refuses to
    // propose and the one field an edit must not make the operator retype.
    expect(cluster?.edit?.apiServer).toBe(clusterInput().apiServer);
    expect(cluster?.edit?.proposal.carriedFrom).toBe('cluster');
  });

  test('a Target whose row matches its manifest entry reports no divergence', async () => {
    const { registry } = fakes();
    // Exactly what `clusterInput` connects, so the two agree.
    const declared = declaredWithGateway({
      name: 'cluster-gateway',
      namespace: 'gateway',
    });
    const booted = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(declared),
    });
    await connectTarget(clusterInput({ name: 'cluster' }), context(registry));

    const listed = await listTargets(
      {},
      { ...context(registry), manifest: booted },
    );
    if (!listed.ok) throw new Error('listTargets refused');
    expect(
      listed.value.targets.find((t) => t.name === 'cluster')
        ?.connectionDivergence,
    ).toEqual([]);
  });
});

describe('disconnect strands rather than stops', () => {
  test('an impact review names Deploys without changing state', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'cluster' }), context(registry));
    const target = (await targetRow('cluster'))!;
    const { app, component } = await seedLiveDeploy(target.id, 'preview-ref');

    const result = await disconnectTarget(
      { name: 'cluster', confirm: false },
      context(registry),
    );
    if (!result.ok) throw new Error('disconnect review refused');

    expect(result.value).toMatchObject({
      disconnected: false,
      stranded: [{ app: app.name, component: component.name }],
    });
    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.targetId, target.id));
    expect(row?.orphanedAt).toBeNull();
    expect((await targetRow('cluster'))?.status).toBe('connected');
  });

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
    expect(result.value.disconnected).toBe(true);
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

  test('a declarative reconnect waits for adapters, then re-adopts', async () => {
    const { registry, of } = fakes();
    const input = clusterInput({ name: 'cluster' });
    await connectTarget(input, context(registry));
    const target = (await targetRow('cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget({ name: 'cluster' }, context(registry));
    of('kubernetes').place('ref-1', {
      ref: 'ref-1',
      phase: 'LIVE',
      artifactDigest: 'sha256:beef',
    });
    const declared = {
      ...manifest,
      vessels: [
        {
          name: input.name,
          kind: 'cluster',
          location: { apiServer: input.apiServer },
        },
      ],
      targets: [
        {
          name: input.name,
          vessel: input.name,
          adapter: 'kubernetes',
          connection: {
            namespace: input.namespace,
            delivery: input.delivery,
          },
        },
      ],
    } satisfies InstallationManifest;

    await loadStoredManifest(database().db, {
      // Declared as an operator writes it: the federation `declared` carries
      // is the deployment's, and the schema refuses a document restating it.
      [MANIFEST_INLINE_VAR]: JSON.stringify(toAuthoredManifest(declared)),
    });
    expect((await targetRow('cluster'))?.status).toBe('disconnected');

    const readopted = await restoreDeclaredTargetConnections(
      context(registry),
      declared,
    );
    expect(readopted).toHaveLength(1);
    expect((await targetRow('cluster'))?.status).toBe('connected');
    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.targetId, target.id));
    expect(row?.orphanedAt).toBeNull();
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

    const result = await listTargets(
      { kind: 'service', reach: 'private', auth: 'proxy' },
      context(registry),
    );
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

  test('resolves placement against the requirements it was given, not a default', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'folly-k8s' }), context(registry));
    await connectTarget(
      cloudInput({ name: 'cloudrun-app' }),
      context(registry),
    );

    // The static Target serves `website` and nothing else, so it is a candidate
    // for one of these two calls and a non-candidate for the other. Resolving
    // both against the same hardcoded workload is the defect this pins.
    const asWebsite = await listTargets(
      { kind: 'website', reach: 'public', auth: 'none' },
      context(registry),
    );
    const asJob = await listTargets(
      { kind: 'job', reach: 'none', auth: 'none' },
      context(registry),
    );
    expect(asWebsite.ok && asJob.ok).toBe(true);
    if (!asWebsite.ok || !asJob.ok) return;

    const staticAsWebsite = asWebsite.value.options.find(
      (o) => o.adapter === 'static',
    );
    const staticAsJob = asJob.value.options.find((o) => o.adapter === 'static');
    expect(staticAsWebsite?.candidate).toBe(true);
    expect(staticAsJob?.candidate).toBe(false);
    expect(staticAsJob?.reasons).toContain('KIND_UNSUPPORTED');
  });

  test('says nothing about placement when it is not told what is being placed', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'folly-k8s' }), context(registry));

    // A partial triple is not a partial answer: placement needs all three, and
    // filling the gaps with plausible values is what made this command answer
    // for a workload the caller was not creating.
    const result = await listTargets({ kind: 'website' }, context(registry));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets.length).toBeGreaterThan(0);
      expect(result.value.options).toHaveLength(0);
    }
  });

  test('states the real naming boundary, never a fabricated domain', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'folly-k8s' }), context(registry));
    await connectTarget(cloudInput({ name: 'vessel' }), context(registry));

    const result = await listTargets(
      { kind: 'website', reach: 'public', auth: 'none' },
      context(registry),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // §9: core mints only where the platform will not, and `kubernetes` is
    // the one Target here that mints. The boundary is the fixture's real
    // zones — never `*.<target>.apps.internal`, a domain that appeared
    // nowhere in the repo, which is the defect this pins.
    const k8s = result.value.targets.find((t) => t.adapter === 'kubernetes');
    expect(k8s?.canonical).toBe(
      `*.${manifest.dns.zones.private} (private) · *.${manifest.dns.zones.public} (public)`,
    );
    expect(k8s?.canonical).not.toContain('apps.internal');

    // `cloudrun` and `static` name their own workloads (`coreMintsCanonical`
    // is false for both) — core mints nothing, so the screen must say that
    // rather than show a suffix no Deploy on either Target will ever use.
    const cloudrun = result.value.targets.find((t) => t.adapter === 'cloudrun');
    const staticTarget = result.value.targets.find(
      (t) => t.adapter === 'static',
    );
    expect(cloudrun?.canonical).toBeNull();
    expect(staticTarget?.canonical).toBeNull();

    // The same fact carries onto the Place step's options: a caller placing a
    // Component is told the same boundary about the same Target.
    const cloudrunOption = result.value.options.find(
      (o) => o.adapter === 'cloudrun',
    );
    expect(cloudrunOption?.canonical).toBeNull();
  });

  test('collapses the boundary to one zone when private and public agree', async () => {
    // The common, and live, shape (§9's `DnsZones`): an installation may
    // point both reaches at the same zone. Two identical clauses joined by
    // " · " would be true but unreadable, so this pins the collapse.
    const { registry } = fakes();
    await connectTarget(clusterInput({ name: 'folly-k8s' }), context(registry));

    const oneZoneManifest = {
      ...manifest,
      dns: {
        zones: { private: 'apps.example.test', public: 'apps.example.test' },
      },
    };
    const result = await listTargets(
      {},
      { ...context(registry), manifest: oneZoneManifest },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const k8s = result.value.targets.find((t) => t.adapter === 'kubernetes');
    expect(k8s?.canonical).toBe('*.apps.example.test');
  });
});
