/**
 * Connecting and disconnecting Targets. Connect always leaves a Target, healthy
 * or not; disconnect orphans live Deploys and destroys nothing; reconnect
 * re-adopts what the adapter's `observe` still sees.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { connectTarget } from '../../src/commands/targets/connect.ts';
import { disconnectTarget } from '../../src/commands/targets/disconnect.ts';
import { listTargets } from '../../src/commands/targets/list.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  type AuthoredManifest,
  type InstallationManifest,
  sharedServicesOf,
  type TargetAdapter,
  toAuthoredManifest,
} from '../../src/config/manifest.schema.ts';
import {
  loadStoredManifest,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
  vessels,
} from '../../src/db/schema.ts';
import { zoneFor } from '../../src/domain/naming.ts';
import { deployState } from '../../src/domain/target.ts';
import {
  surfacesToProbe,
  vesselPrerequisitesFor,
} from '../../src/domain/vessel.ts';
import { restoreDeclaredTargetConnections } from '../../src/reconciler/target-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  FakeDeployAdapter,
  type FakeDeployAdapterOptions,
} from '../harness/fakes/deploy-adapter.ts';
import {
  CLOUD_ENDPOINTS,
  CLOUDFLARE_ENDPOINT,
  cloudflareInput,
  cloudInput,
  clusterInput,
  connectionFor,
  fixtureManifest,
  insertVessel,
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
      // `null` means the installation ships no such adapter.
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
    principal: {
      id: crypto.randomUUID(),
      displayName: 'Operator',
      kind: 'human',
    },
    clock,
    db: database().db,
    adapters: registry,
    manifest,
  };
}

async function targetRow(
  vessel: string,
  adapter: TargetAdapter = 'kubernetes',
) {
  const rows = await database()
    .db.select()
    .from(targets)
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(and(eq(vessels.name, vessel), eq(targets.adapter, adapter)));
  return rows[0]?.targets;
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

/** Writes the stored manifest, then loads it the way boot does. */
async function seedStoredManifest(
  document: AuthoredManifest,
): Promise<InstallationManifest> {
  await writeStoredManifest(database().db, document);
  return loadStoredManifest(database().db);
}

describe('connect always succeeds', () => {
  test('a reachable cluster is registered healthy, at the end of the rank', async () => {
    const { registry, of } = fakes();
    const result = await connectTarget(
      clusterInput({ vessel: 'cluster' }),
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
      clusterInput({ vessel: 'cluster' }),
      context(registry),
    );

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
      clusterInput({ vessel: 'cluster' }),
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
      cloudInput({ vessel: 'vessel', region: 'here' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(result.value.targets.map((t) => t.adapter)).toEqual([
      'cloudrun',
      'static',
    ]);
    expect(result.value.targets.map((t) => t.rank)).toEqual([0, 1]);

    // Each Target keeps only its own adapter's endpoint, and only Cloud Run
    // carries the runtime identity.
    expect((await targetRow('vessel', 'cloudrun'))?.connection).toEqual({
      adapter: 'cloudrun',
      region: 'here',
      endpoint: CLOUD_ENDPOINTS.run,
      serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
    });
    expect((await targetRow('vessel', 'static'))?.connection).toEqual({
      adapter: 'static',
      endpoint: CLOUD_ENDPOINTS.hosting,
    });
  });

  test('connect is idempotent by name and keeps the rank', async () => {
    const { registry } = fakes();
    const input = clusterInput({ vessel: 'cluster' });

    await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p', region: 'r' }),
      context(registry),
    );
    const first = await connectTarget(input, context(registry));
    const again = await connectTarget(input, context(registry));

    if (!first.ok || !again.ok) throw new Error('connect refused');
    expect(again.value.targets[0]?.id).toBe(first.value.targets[0]!.id);
    // Rank is one global list, and a reconnect keeps the Target's place in it.
    expect(again.value.targets[0]?.rank).toBe(2);
    const rows = await database().db.select().from(targets);
    expect(rows).toHaveLength(3);
  });

  test('a reconnect updates what the operator asserted about reach', async () => {
    const { registry } = fakes();
    await connectTarget(clusterInput({ vessel: 'cluster' }), context(registry));
    expect((await targetRow('cluster'))?.reaches).toBeNull();

    // The connect screen derives `reaches` and `authReaches` and posts them
    // with every submission, so a reconnect must store them.
    await connectTarget(
      clusterInput({
        vessel: 'cluster',
        reaches: ['none', 'private', 'public'],
        authReaches: ['private'],
      }),
      context(registry),
    );

    const row = await targetRow('cluster');
    expect(row?.reaches).toEqual(['none', 'private', 'public']);
    expect(row?.authReaches).toEqual(['private']);
  });

  test('a reconnect keeps the network the manifest seeded', async () => {
    // `network` comes from the manifest, never the connect screen, and carries
    // the postgres and valkey capabilities.
    const { registry } = fakes();
    const input = cloudInput({ vessel: 'vessel', project: 'p', region: 'r' });
    await connectTarget(input, context(registry));

    const db = database().db;
    const [seeded] = await db
      .select()
      .from(vessels)
      .where(eq(vessels.name, 'vessel'));
    await db
      .update(vessels)
      .set({
        location: {
          kind: 'gcp-project',
          project: 'p',
          network: { name: 'spindrift-vessel', region: 'r' },
        },
      })
      .where(eq(vessels.id, seeded!.id));

    const again = await connectTarget(input, context(registry));
    expect(again.ok).toBe(true);

    const [after] = await db
      .select()
      .from(vessels)
      .where(eq(vessels.id, seeded!.id));
    expect(after?.location).toEqual({
      kind: 'gcp-project',
      project: 'p',
      network: { name: 'spindrift-vessel', region: 'r' },
    });
  });

  test('connect fills a manifest-seeded Target without changing its rank', async () => {
    const { registry } = fakes();
    // A manifest-seeded vessel, which connect must reuse by name.
    const vessel = await insertVessel(database().db, 'kubernetes', {
      name: 'cluster',
    });
    const [seed] = await database()
      .db.insert(targets)
      .values({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        rank: 4,
        status: 'disconnected',
        connection: null,
        health: 'unhealthy',
      })
      .returning();

    const result = await connectTarget(
      clusterInput({ vessel: 'cluster' }),
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

  test('and registers only the surfaces the probe found', async () => {
    const { registry } = fakes({
      cloudrun: { surfaceAbsent: 'the Cloud Run API is not enabled on p' },
    });
    const result = await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(result.value.targets.map((t) => t.adapter)).toEqual(['static']);
    expect(await targetRow('vessel', 'cloudrun')).toBeUndefined();
    expect(await targetRow('vessel', 'static')).toBeDefined();

    const [missing] = result.value.absent;
    expect(missing?.adapter).toBe('cloudrun');
    expect(missing?.vessel).toBe('vessel');
    expect(missing?.detail).toContain('not enabled');
    expect(missing?.prerequisites.every((item) => !item.met)).toBe(true);
  });

  test('but a surface it could not settle is registered, unhealthy', async () => {
    // A refused read proves no absence, and the row lets the loop re-check
    // once the grant exists.
    const { registry } = fakes({
      cloudrun: { unreachable: 'the federated identity may not act here' },
    });
    const result = await connectTarget(
      cloudInput({ vessel: 'vessel' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(result.value.absent).toEqual([]);
    expect(result.value.targets.map((t) => t.adapter)).toEqual([
      'cloudrun',
      'static',
    ]);
    const row = await targetRow('vessel', 'cloudrun');
    expect(row?.health).toBe('unhealthy');
    expect(row?.prerequisites?.[0]?.detail).toContain('may not act here');
  });

  test('the surfaces on a vessel are its rows, not its kind', async () => {
    // The probe list names both surfaces; the rows say which this project
    // carries.
    const { registry } = fakes({
      cloudrun: { surfaceAbsent: 'the Cloud Run API is not enabled on p' },
    });
    await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(registry),
    );

    const carried = await database()
      .db.select({ adapter: targets.adapter })
      .from(targets)
      .innerJoin(vessels, eq(targets.vesselId, vessels.id))
      .where(eq(vessels.name, 'vessel'));
    expect(carried.map((row) => row.adapter)).toEqual(['static']);
    expect(surfacesToProbe('gcp-project')).toEqual(['cloudrun', 'static']);
  });

  test('a surface found later joins the vessel, changing no Target that was there', async () => {
    const off = fakes({
      cloudrun: { surfaceAbsent: 'the Cloud Run API is not enabled on p' },
    });
    await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(off.registry),
    );
    const before = await targetRow('vessel', 'static');

    // The API is enabled and connect runs again.
    const on = fakes();
    const result = await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(on.registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(await targetRow('vessel', 'static')).toEqual(before);
    const added = await targetRow('vessel', 'cloudrun');
    expect(added?.health).toBe('healthy');
    // It joins the end of the global rank list.
    expect(added?.rank).toBe(1);
    expect(before?.rank).toBe(0);
  });

  test('a surface that stops answering keeps its Target rather than losing it', async () => {
    // An existing Target may carry placements, so a probe never deletes it; the
    // absence shows as an unmet checklist.
    await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(fakes().registry),
    );

    const { registry } = fakes({
      cloudrun: { surfaceAbsent: 'the Cloud Run API is not enabled on p' },
    });
    const result = await connectTarget(
      cloudInput({ vessel: 'vessel', project: 'p' }),
      context(registry),
    );

    if (!result.ok) throw new Error('connect refused');
    expect(result.value.absent).toEqual([]);
    const row = await targetRow('vessel', 'cloudrun');
    expect(row?.health).toBe('unhealthy');
    expect(row?.prerequisites?.[0]?.detail).toContain('not enabled');
  });

  test('and the screen keeps the act that asks again once it is switched on', async () => {
    // The absence is not stored, so the connected surface keeps an edit that
    // asks the vessel again.
    await connectTarget(
      cloudInput({ vessel: 'elsewhere', project: 'other' }),
      context(fakes().registry),
    );
    const off = fakes({
      cloudrun: { surfaceAbsent: 'the Cloud Run API is not enabled on p' },
    });
    await connectTarget(
      cloudInput({
        vessel: 'vessel',
        project: 'p',
        servedHosts: ['hosting.example.test'],
      }),
      context(off.registry),
    );

    const listed = await listTargets({}, context(off.registry));
    if (!listed.ok) throw new Error('listTargets refused');
    const edit = listed.value.targets.find(
      (target) => target.vessel === 'vessel' && target.adapter === 'static',
    )?.edit;
    if (edit?.kind !== 'gcp-project') {
      throw new Error('the surface that answered offers no edit');
    }
    // The edit carries the project id, which a fresh connect never proposes,
    // and the installation-wide region.
    expect(edit.project).toBe('p');
    expect(edit.proposal.region).toBe(cloudInput().region);
    // Values the form has no field for travel in `carried`, or the edit would
    // delete them.
    expect(edit.carried.servedHosts).toEqual(['hosting.example.test']);

    // Resubmit what the screen holds; each adapter applies its default
    // endpoint.
    const on = fakes();
    const again = await connectTarget(
      {
        kind: 'gcp-project',
        vessel: 'vessel',
        project: edit.project,
        region: edit.proposal.region!,
        ...edit.carried,
      },
      context(on.registry),
    );

    if (!again.ok) throw new Error('connect refused');
    expect(again.value.targets.map((target) => target.adapter)).toEqual([
      'cloudrun',
      'static',
    ]);
    const [boundary] = await database()
      .db.select({ servedHosts: vessels.servedHosts })
      .from(vessels)
      .where(eq(vessels.name, 'vessel'));
    expect(boundary?.servedHosts).toEqual(['hosting.example.test']);
  });

  test('one cloud connect fills its matched manifest-seeded pair', async () => {
    const { registry } = fakes();
    const vessel = await insertVessel(database().db, 'cloudrun', {
      name: 'vessel',
    });
    const seeds = await database()
      .db.insert(targets)
      .values([
        {
          adapter: 'cloudrun',
          vesselId: vessel.id,
          rank: 2,
          status: 'disconnected',
          connection: null,
          health: 'unhealthy',
        },
        {
          adapter: 'static',
          vesselId: vessel.id,
          rank: 3,
          status: 'disconnected',
          connection: null,
          health: 'unhealthy',
        },
      ])
      .returning();

    const result = await connectTarget(
      cloudInput({ vessel: 'vessel' }),
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
 * `loadStoredManifest` runs on every boot, and an operator's correction to a
 * declared Target survives it: the row wins and the divergence is reported.
 */
describe('an operator’s Target correction outlives the next boot', () => {
  /** The declared manifest, with this gateway on its one Target. */
  function declaredWithGateway(gateway: { name: string; namespace: string }) {
    const input = clusterInput({ vessel: 'cluster' });
    const platform = input.chartValues?.platform as Record<string, unknown>;
    return {
      ...toAuthoredManifest(manifest),
      // One vessel is both control plane and home, so it must carry `shared`.
      installation: {
        ...manifest.installation,
        controlPlaneVessel: 'cluster',
        homeVessel: 'cluster',
      },
      vessels: [
        {
          name: 'cluster',
          kind: 'cluster' as const,
          location: { apiServer: input.apiServer },
          shared: sharedServicesOf(manifest),
        },
      ],
      targets: [
        {
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
    await seedStoredManifest(declared);
    expect((await targetRow('cluster'))?.connection).toMatchObject({
      chartValues: {
        platform: {
          gateway: { name: 'gateway-that-moved' },
        },
      },
    });

    const connected = await connectTarget(
      clusterInput({ vessel: 'cluster' }),
      context(registry),
    );
    expect(connected.ok).toBe(true);

    // A restart: the reconciler and web process each load the manifest at
    // startup.
    const booted = await loadStoredManifest(database().db, {});

    const row = await targetRow('cluster');
    expect(row?.connection).toEqual(connectionFor('kubernetes'));
    // A boot declares nothing, so it keeps the Target's assessment.
    expect(row?.health).toBe('healthy');
    expect(row?.inspectedAt).not.toBeNull();

    // Saving Settings writes the full document back, so the Target lists the
    // paths that would revert, never their values.
    const listed = await listTargets(
      {},
      { ...context(registry), manifest: booted },
    );
    if (!listed.ok) throw new Error('listTargets refused');
    const cluster = listed.value.targets.find((t) => t.vessel === 'cluster');
    expect(cluster?.connectionDivergence).toEqual([
      'connection.chartValues.platform.gateway.name',
      'connection.chartValues.platform.gateway.namespace',
    ]);
    expect(JSON.stringify(cluster?.connectionDivergence)).not.toContain(
      'gateway-that-moved',
    );

    // The edit carries the API server, which a fresh connect never proposes.
    expect(cluster?.edit).toMatchObject({
      kind: 'cluster',
      apiServer: clusterInput().apiServer,
    });
    expect(cluster?.edit?.proposal.carriedFrom).toBe('cluster/kubernetes');
  });

  test('a Target whose row matches its manifest entry reports no divergence', async () => {
    const { registry } = fakes();
    // What `clusterInput` connects, so the two agree.
    const declared = declaredWithGateway({
      name: 'cluster-gateway',
      namespace: 'gateway',
    });
    const booted = await seedStoredManifest(declared);
    await connectTarget(clusterInput({ vessel: 'cluster' }), context(registry));

    const listed = await listTargets(
      {},
      { ...context(registry), manifest: booted },
    );
    if (!listed.ok) throw new Error('listTargets refused');
    expect(
      listed.value.targets.find((t) => t.vessel === 'cluster')
        ?.connectionDivergence,
    ).toEqual([]);
  });
});

describe('disconnect strands rather than stops', () => {
  test('an impact review names Deploys without changing state', async () => {
    const { registry } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'app-cluster' }),
      context(registry),
    );
    const target = (await targetRow('app-cluster'))!;
    const { app, component } = await seedLiveDeploy(target.id, 'preview-ref');

    const result = await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes', confirm: false },
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
    expect((await targetRow('app-cluster'))?.status).toBe('connected');
  });

  test('live Deploys go orphaned and are named, and nothing is destroyed', async () => {
    const { registry, of } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'app-cluster' }),
      context(registry),
    );
    const target = (await targetRow('app-cluster'))!;
    const { app, component } = await seedLiveDeploy(target.id, 'ref-1');

    const result = await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes' },
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
    // The phase keeps the platform's last report; the workload is only out of
    // sight.
    expect(row?.phase).toBe('LIVE');
    expect(
      deployState({
        phase: row!.phase,
        orphanedAt: row!.orphanedAt,
        faultyAt: row!.faultyAt,
      }),
    ).toBe('orphaned');
    expect((await targetRow('app-cluster'))?.status).toBe('disconnected');

    expect(of('kubernetes').destroyed).toEqual([]);
  });

  test('disconnecting a Target with nothing on it strands nothing', async () => {
    const { registry } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'app-cluster' }),
      context(registry),
    );
    const result = await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes' },
      context(registry),
    );
    if (!result.ok) throw new Error('disconnect refused');
    expect(result.value.stranded).toEqual([]);
  });

  test('a vessel the installation is built on cannot be disconnected', async () => {
    // Neither installation pointer is a foreign key, so only this guard stops
    // the control plane disconnecting the vessel it runs on.
    const { registry } = fakes();
    await connectTarget(clusterInput({ vessel: 'cluster' }), context(registry));

    for (const vessel of [
      manifest.installation.controlPlaneVessel,
      manifest.installation.homeVessel,
    ]) {
      const result = await disconnectTarget(
        { vessel, adapter: 'kubernetes' },
        context(registry),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('NOT_DEPLOYABLE');
      expect(result.failure.message).toContain('built on');
    }

    // Refused at review too, so the impact screen offers no dead button.
    const review = await disconnectTarget(
      { vessel: 'cluster', adapter: 'kubernetes', confirm: false },
      context(registry),
    );
    expect(review.ok).toBe(false);
    expect((await targetRow('cluster'))?.status).toBe('connected');
  });

  test('an unknown Target is a refusal with an identity', async () => {
    const { registry } = fakes();
    const result = await disconnectTarget(
      { vessel: 'nowhere', adapter: 'kubernetes' },
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
    const input = clusterInput({ vessel: 'app-cluster' });

    await connectTarget(input, context(registry));
    const target = (await targetRow('app-cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes' },
      context(registry),
    );

    // The adapter still sees the workload after the disconnect.
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
      deployState({
        phase: row!.phase,
        orphanedAt: row!.orphanedAt,
        faultyAt: row!.faultyAt,
      }),
    ).toBe('live');
  });

  test('a workload that is gone stays orphaned rather than resurrected', async () => {
    const { registry } = fakes();
    const input = clusterInput({ vessel: 'app-cluster' });

    await connectTarget(input, context(registry));
    const target = (await targetRow('app-cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes' },
      context(registry),
    );

    // The fake never placed `ref-1`, so `observe` reports nothing.
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
    const input = clusterInput({ vessel: 'app-cluster' });
    await connectTarget(input, context(registry));
    const target = (await targetRow('app-cluster'))!;
    await seedLiveDeploy(target.id, 'ref-1');
    await disconnectTarget(
      { vessel: 'app-cluster', adapter: 'kubernetes' },
      context(registry),
    );
    of('kubernetes').place('ref-1', {
      ref: 'ref-1',
      phase: 'LIVE',
      artifactDigest: 'sha256:beef',
    });
    const declared = {
      ...manifest,
      installation: {
        ...manifest.installation,
        controlPlaneVessel: input.vessel,
        homeVessel: input.vessel,
      },
      vessels: [
        {
          name: input.vessel,
          kind: 'cluster',
          location: { apiServer: input.apiServer },
          shared: sharedServicesOf(manifest),
        },
      ],
      targets: [
        {
          vessel: input.vessel,
          adapter: 'kubernetes',
          connection: {
            namespace: input.namespace,
            delivery: input.delivery,
          },
        },
      ],
    } satisfies InstallationManifest;

    await seedStoredManifest(toAuthoredManifest(declared));
    expect((await targetRow('app-cluster'))?.status).toBe('disconnected');

    const readopted = await restoreDeclaredTargetConnections(
      context(registry),
      declared,
    );
    expect(readopted).toHaveLength(1);
    expect((await targetRow('app-cluster'))?.status).toBe('connected');
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
    await connectTarget(
      clusterInput({ vessel: 'folly-k8s' }),
      context(registry),
    );
    await connectTarget(
      cloudInput({ vessel: 'cloudrun-app' }),
      context(registry),
    );

    const result = await listTargets(
      { kind: 'service', reach: 'private', auth: 'proxy' },
      context(registry),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets).toHaveLength(3); // 1 k8s + 2 cloud (cloudrun, static)
      expect(result.value.targets[0]?.vessel).toBe('folly-k8s');
      expect(result.value.targets[0]?.health).toBe('healthy');
      expect(result.value.options.length).toBeGreaterThan(0);
      const option = result.value.options.find((o) => o.vessel === 'folly-k8s');
      expect(option?.candidate).toBe(true);
    }
  });

  test('resolves placement against the requirements it was given, not a default', async () => {
    const { registry } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'folly-k8s' }),
      context(registry),
    );
    await connectTarget(
      cloudInput({ vessel: 'cloudrun-app' }),
      context(registry),
    );

    // The static Target serves only `website`, so one call makes it a
    // candidate.
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
    await connectTarget(
      clusterInput({ vessel: 'folly-k8s' }),
      context(registry),
    );

    // Placement needs kind, reach and auth, so a partial triple resolves
    // nothing.
    const result = await listTargets({ kind: 'website' }, context(registry));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targets.length).toBeGreaterThan(0);
      expect(result.value.options).toHaveLength(0);
    }
  });

  test('states the real naming boundary, never a fabricated domain', async () => {
    const { registry } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'folly-k8s' }),
      context(registry),
    );
    await connectTarget(cloudInput({ vessel: 'vessel' }), context(registry));

    const result = await listTargets(
      { kind: 'website', reach: 'public', auth: 'none' },
      context(registry),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Core mints names only on `kubernetes`, under the fixture's real zones.
    const k8s = result.value.targets.find((t) => t.adapter === 'kubernetes');
    expect(k8s?.canonical).toBe(
      `*.${zoneFor('private', manifest.dns.zones)} (private) · *.${zoneFor('public', manifest.dns.zones)} (public)`,
    );
    expect(k8s?.canonical).not.toContain('apps.internal');

    // `cloudrun` and `static` name their own workloads (`coreMintsCanonical` is
    // false).
    const cloudrun = result.value.targets.find((t) => t.adapter === 'cloudrun');
    const staticTarget = result.value.targets.find(
      (t) => t.adapter === 'static',
    );
    expect(cloudrun?.canonical).toBeNull();
    expect(staticTarget?.canonical).toBeNull();

    const cloudrunOption = result.value.options.find(
      (o) => o.adapter === 'cloudrun',
    );
    expect(cloudrunOption?.canonical).toBeNull();
  });

  test('collapses the boundary to one zone when private and public agree', async () => {
    // An installation may point both reaches at one zone.
    const { registry } = fakes();
    await connectTarget(
      clusterInput({ vessel: 'folly-k8s' }),
      context(registry),
    );

    const oneZoneManifest = {
      ...manifest,
      dns: {
        zones: [
          {
            name: 'apps.example.test',
            reaches: ['private' as const, 'public' as const],
          },
        ],
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

  test('answers the boundaries themselves, with the role each carries', async () => {
    const { registry } = fakes();
    await connectTarget(cloudInput({ vessel: 'cloud' }), context(registry));

    const result = await listTargets({}, context(registry));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const home = result.value.vessels.find((vessel) => vessel.name === 'cloud');
    expect(home?.roles).toEqual(['home']);
    expect(home?.inspectedAt).toBeNull();
  });

  test('a vessel’s health is derived from its rows, not read off one', async () => {
    // Health is derived, never stored: any unmet row makes the vessel
    // unhealthy.
    const { registry } = fakes();
    await connectTarget(cloudInput({ vessel: 'cloud' }), context(registry));

    const catalogue = vesselPrerequisitesFor('gcp-project', ['home']);
    expect(catalogue).toContain('SOURCE_BUCKET');

    await database()
      .db.update(vessels)
      .set({
        prerequisites: catalogue.map((name) => ({
          name,
          met: name !== 'SIGNER_KEY',
        })),
      })
      .where(eq(vessels.name, 'cloud'));
    const unhealthy = await listTargets({}, context(registry));
    expect(unhealthy.ok).toBe(true);
    if (!unhealthy.ok) return;
    expect(
      unhealthy.value.vessels.find((vessel) => vessel.name === 'cloud')?.health,
    ).toBe('unhealthy');

    await database()
      .db.update(vessels)
      .set({ prerequisites: catalogue.map((name) => ({ name, met: true })) })
      .where(eq(vessels.name, 'cloud'));
    const healthy = await listTargets({}, context(registry));
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    expect(
      healthy.value.vessels.find((vessel) => vessel.name === 'cloud')?.health,
    ).toBe('healthy');
  });
});

describe('a Cloudflare account is a connection, not a Pages connection', () => {
  test('connect stores what the account carries, not only that it answered', async () => {
    const { registry } = fakes();
    const input = cloudflareInput();
    const connected = await connectTarget(input, {
      ...context(registry),
      adapters: {
        ...registry,
        cloudflare: () => ({
          read: async (account: string) => ({
            kind: 'cloudflare-account' as const,
            zones: [{ name: 'example.test', id: 'zone-1', status: 'active' }],
            workersSubdomain: account,
            pagesProjects: ['site'],
          }),
        }),
      },
    });
    expect(connected.ok).toBe(true);

    const [vessel] = await database()
      .db.select()
      .from(vessels)
      .where(eq(vessels.name, input.vessel));

    // The account inventory lives once, on the vessel row.
    expect(vessel?.discovery).toEqual({
      kind: 'cloudflare-account',
      zones: [{ name: 'example.test', id: 'zone-1', status: 'active' }],
      workersSubdomain: 'example-account',
      pagesProjects: ['site'],
    });
    expect(vessel?.location).toEqual({
      kind: 'cloudflare-account',
      account: 'example-account',
      endpoint: CLOUDFLARE_ENDPOINT,
    });
  });

  test('an installation with no Cloudflare credential records that nobody looked', async () => {
    // With no reader, zones stay null, so the row never claims an empty
    // account.
    const { registry } = fakes();
    await connectTarget(
      cloudflareInput({ vessel: 'unread' }),
      context(registry),
    );

    const [vessel] = await database()
      .db.select()
      .from(vessels)
      .where(eq(vessels.name, 'unread'));

    expect(vessel?.discovery?.zones).toBeNull();
    expect(vessel?.discovery?.unreadable?.account).toContain(
      'no Cloudflare credential',
    );
  });
});
