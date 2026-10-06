/**
 * `resolveComponentPlacement` against a real Postgres. Requirements derive from
 * the Component's kind, reach and attached Datastores, and resolving writes
 * nothing.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { resolveComponentPlacement } from '../../src/commands/apps/resolve-placement.ts';
import { connectTarget } from '../../src/commands/targets/connect.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  apps,
  type Component,
  components,
  datastores,
  deploys,
  targets,
  vessels,
} from '../../src/db/schema.ts';
import type { ComponentKind } from '../../src/domain/desired-state.ts';
import { targetLabel } from '../../src/domain/target.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  cloudInput,
  clusterInput,
  fixtureManifest,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const clock: Clock = { now: () => new Date('2024-06-01T00:00:00.000Z') };

function fakes() {
  const made = new Map<TargetAdapter, FakeDeployAdapter>();
  const registry: AdapterRegistry = {
    deploy(adapter) {
      let fake = made.get(adapter);
      if (!fake) {
        fake = new FakeDeployAdapter({
          adapter,
          artifactTypes: adapter === 'static' ? ['files'] : ['image'],
        });
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
      throw new Error('placement reached the supply chain');
    },
  };
  return registry;
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

/** The cluster Target and the cloud vessel's two Targets, all healthy. */
async function connectEverything(registry: AdapterRegistry) {
  await connectTarget(clusterInput({ vessel: 'cluster' }), context(registry));
  await connectTarget(
    cloudInput({ vessel: 'vessel', region: 'here' }),
    context(registry),
  );
  const rows = await database().db.query.targets.findMany({
    with: { vessel: true },
  });
  return new Map(
    rows.map((row) => [
      targetLabel({ vessel: row.vessel.name, adapter: row.adapter }),
      row,
    ]),
  );
}

async function seedComponent(
  kind: ComponentKind = 'service',
  reach: Component['reach'] = 'private',
  auth: Component['auth'] = 'proxy',
  schedule: string | null = null,
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'invoices', sourceKind: 'repo' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind, reach, auth, schedule })
    .returning();
  return { app: app!, component: component! };
}

async function place(registry: AdapterRegistry, componentId: string) {
  const result = await resolveComponentPlacement(
    { componentId },
    context(registry),
  );
  if (!result.ok) throw new Error(`placement refused: ${result.failure.code}`);
  return result.value;
}

describe('resolution is derived, and it is a query', () => {
  test('a private service is suggested the highest-ranked cluster', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { component } = await seedComponent();

    const placement = await place(registry, component.id);
    expect(placement.suggestedTargetId).toBe(
      connected.get('cluster/kubernetes')!.id,
    );
    // Every Target appears in rank order, candidate or not.
    expect(placement.options.map((option) => option.name)).toEqual([
      'cluster/kubernetes',
      'vessel/cloudrun',
      'vessel/static',
    ]);
    // Neither cloud backend can publish a `private` address.
    expect(placement.options.map((option) => option.candidate)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test('the static Target is annotated, not omitted', async () => {
    const registry = fakes();
    await connectEverything(registry);
    const { component } = await seedComponent();

    const placement = await place(registry, component.id);
    const cdn = placement.options.find((o) => o.name === 'vessel/static')!;
    expect(cdn.candidate).toBe(false);
    expect(cdn.artifactType).toBeNull();
    expect(cdn.reasons).toContain('KIND_UNSUPPORTED');
    expect(cdn.detail.join(' ')).toContain('service');
  });

  test('a public website reaches the static Target, as files', async () => {
    const registry = fakes();
    await connectEverything(registry);
    // Discovery reports no reach, so the operator states it.
    const staticTarget = (
      await database()
        .db.select({ id: targets.id })
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(and(eq(vessels.name, 'vessel'), eq(targets.adapter, 'static')))
    )[0]!;
    await database()
      .db.update(targets)
      .set({ reaches: ['none', 'private', 'public'] })
      .where(eq(targets.id, staticTarget.id));
    const { component } = await seedComponent('website', 'public', 'none');

    const placement = await place(registry, component.id);
    const cdn = placement.options.find((o) => o.name === 'vessel/static')!;
    expect(cdn.candidate).toBe(true);
    expect(cdn.artifactType).toBe('files');
    // Cloud Run serves a public reach on its own URL, so both are candidates
    // and differ by artifact shape.
    const run = placement.options.find((o) => o.name === 'vessel/cloudrun')!;
    expect(run.candidate).toBe(true);
    expect(run.artifactType).toBe('image');
  });

  test("a job's schedule is derived, and both runtimes keep one", async () => {
    const registry = fakes();
    await connectEverything(registry);
    const { component } = await seedComponent(
      'job',
      'none',
      'none',
      '0 3 * * *',
    );

    // Kubernetes fires a CronJob and Cloud Run a Cloud Scheduler job, so only
    // the static Target, which renders no job, is excluded.
    const placement = await place(registry, component.id);
    const run = placement.options.find((o) => o.name === 'vessel/cloudrun')!;
    expect(run.candidate).toBe(true);
    expect(run.reasons).toEqual([]);
    const cluster = placement.options.find(
      (o) => o.name === 'cluster/kubernetes',
    )!;
    expect(cluster.candidate).toBe(true);
    // Rank breaks the tie, and the cluster ranks first.
    expect(placement.suggestedTargetId).toBe(cluster.targetId);
    const cdn = placement.options.find((o) => o.name === 'vessel/static')!;
    expect(cdn.candidate).toBe(false);
    expect(cdn.reasons).toContain('KIND_UNSUPPORTED');
    // NO_SCHEDULER's sentence assumes the Target runs jobs, so it never
    // appears beside KIND_UNSUPPORTED.
    expect(cdn.reasons).not.toContain('NO_SCHEDULER');
  });

  test('nowhere fits is returned, with a reason for every Target', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { app, component } = await seedComponent('service', 'public', 'none');

    // The cluster holds the Datastore but has no public reach, and the cloud
    // Targets have public reach but cannot reach a cluster-local Datastore.
    await database()
      .db.insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: app.id,
        vesselId: connected.get('cluster/kubernetes')!.vesselId,
      });

    const placement = await place(registry, component.id);
    expect(placement.suggestedTargetId).toBeNull();
    expect(placement.options.every((option) => !option.candidate)).toBe(true);
    for (const option of placement.options) {
      expect(option.detail.length).toBe(option.reasons.length);
      expect(option.reasons.length).toBeGreaterThan(0);
    }
  });

  test('asking the question writes nothing', async () => {
    const registry = fakes();
    await connectEverything(registry);
    const { component } = await seedComponent();

    const before = await database().db.select().from(targets);
    await place(registry, component.id);
    const after = await database().db.select().from(targets);

    expect(after).toEqual(before);
    expect(await database().db.select().from(deploys)).toEqual([]);
  });

  test('an unknown Component is a refusal with an identity', async () => {
    const registry = fakes();
    const result = await resolveComponentPlacement(
      { componentId: crypto.randomUUID() },
      context(registry),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('an attached cluster-local Datastore constrains the App', () => {
  // No route, so the attached Datastore is the only constraint.
  const unrouted = () => seedComponent('service', 'none', 'none');

  test('at attach time, the cloud stops being a candidate', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { app, component } = await unrouted();

    expect(
      (await place(registry, component.id)).options.filter((o) => o.candidate),
    ).toHaveLength(2);

    // An in-cluster Datastore is cluster-local from the moment it is attached.
    await database()
      .db.insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: app.id,
        vesselId: connected.get('cluster/kubernetes')!.vesselId,
      });

    const placement = await place(registry, component.id);
    expect(
      placement.options.filter((o) => o.candidate).map((o) => o.name),
    ).toEqual(['cluster/kubernetes']);
    const cloud = placement.options.find((o) => o.name === 'vessel/cloudrun')!;
    expect(cloud.reasons).toEqual(['DATASTORE_IS_CLUSTER_LOCAL']);
  });

  test('a Datastore detached from the App constrains nothing', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { component } = await unrouted();

    // Deleting an App detaches its Datastores, so an orphaned row constrains
    // nobody.
    await database()
      .db.insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: null,
        vesselId: connected.get('cluster/kubernetes')!.vesselId,
      });

    const placement = await place(registry, component.id);
    expect(placement.options.filter((o) => o.candidate)).toHaveLength(2);
  });
});
