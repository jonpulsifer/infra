/**
 * `resolveComponentPlacement` against a real Postgres (Task 15, §3).
 *
 * `test/domain/placement.test.ts` covers the filter itself. What is asserted
 * here is the half the filter cannot see: that the requirements handed to it are
 * genuinely **derived** — from the Component's kind, its exposure, and the
 * Datastores attached to its App — and that nothing is written when they are.
 *
 * Resolution is a query. §3 puts it before the build so "nowhere fits" is a
 * returnable answer rather than a deploy that fails later, and an act that
 * recorded a placement would make asking the question change the App.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  connectTarget,
  resolveComponentPlacement,
} from '../../src/commands/index.ts';
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
} from '../../src/db/schema.ts';
import type { ComponentKind } from '../../src/domain/desired-state.ts';
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
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: registry,
    manifest,
  };
}

/** The cluster and the two cloud Targets, in rank order, all healthy. */
async function connectEverything(registry: AdapterRegistry) {
  await connectTarget(clusterInput({ name: 'cluster' }), context(registry));
  await connectTarget(
    cloudInput({ name: 'vessel', region: 'here' }),
    context(registry),
  );
  const rows = await database().db.select().from(targets);
  return new Map(rows.map((row) => [row.name, row]));
}

async function seedComponent(
  kind: ComponentKind = 'service',
  reach: Component['reach'] = 'private',
  auth: Component['auth'] = 'proxy',
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'invoices', sourceKind: 'repo' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind, reach, auth })
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
    expect(placement.suggestedTargetId).toBe(connected.get('cluster')!.id);
    // Every Target appears, candidate or not, in one rank-ordered list — §3's
    // grammar of listed-and-annotated rather than quietly filtered away.
    expect(placement.options.map((option) => option.name)).toEqual([
      'cluster',
      'vessel-cloudrun',
      'vessel-static',
    ]);
    // Only the cluster. A `private` reach is an address on the operator's own
    // network, and neither cloud backend has one to publish — which is a
    // sharper answer than the old three-state exposure could give.
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
    const cdn = placement.options.find((o) => o.name === 'vessel-static')!;
    expect(cdn.candidate).toBe(false);
    expect(cdn.artifactType).toBeNull();
    expect(cdn.reasons).toContain('KIND_UNSUPPORTED');
    expect(cdn.detail.join(' ')).toContain('service');
  });

  test('a public website reaches the static Target, as files', async () => {
    const registry = fakes();
    await connectEverything(registry);
    // A reach the operator states, because §3 says nothing reports one (§13).
    await database()
      .db.update(targets)
      .set({ reaches: ['none', 'private', 'public'] })
      .where(eq(targets.name, 'vessel-static'));
    const { component } = await seedComponent('website', 'public', 'none');

    const placement = await place(registry, component.id);
    const cdn = placement.options.find((o) => o.name === 'vessel-static')!;
    expect(cdn.candidate).toBe(true);
    expect(cdn.artifactType).toBe('files');
    // The cloud runtime serves a public reach too — its own URL, no tunnel
    // needed — so what separates the two here is artifact shape rather than
    // candidacy, and rank is the tie-break §3 leaves to a human.
    const run = placement.options.find((o) => o.name === 'vessel-cloudrun')!;
    expect(run.candidate).toBe(true);
    expect(run.artifactType).toBe('image');
  });

  test('nowhere fits is returned, with a reason for every Target', async () => {
    const registry = fakes();
    await connectEverything(registry);
    const { component } = await seedComponent('job', 'public', 'none');

    // A public job: the cluster runs jobs and has no public reach, and neither
    // cloud backend runs a job at all. Every row has a reason.
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
  // A Component with no route, so both the cluster and the cloud runtime can
  // hold it and the Datastore is the only thing that narrows the field.
  const unrouted = () => seedComponent('service', 'none', 'none');

  test('at attach time, the cloud stops being a candidate', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { app, component } = await unrouted();

    expect(
      (await place(registry, component.id)).options.filter((o) => o.candidate),
    ).toHaveLength(2);

    // §11: "In-cluster datastores stay cluster-local in v1." Attaching is the
    // act that makes this true — not the deploy that comes later.
    await database()
      .db.insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: app.id,
        targetId: connected.get('cluster')!.id,
      });

    const placement = await place(registry, component.id);
    expect(
      placement.options.filter((o) => o.candidate).map((o) => o.name),
    ).toEqual(['cluster']);
    const cloud = placement.options.find((o) => o.name === 'vessel-cloudrun')!;
    expect(cloud.reasons).toEqual(['DATASTORE_IS_CLUSTER_LOCAL']);
  });

  test('a Datastore detached from the App constrains nothing', async () => {
    const registry = fakes();
    const connected = await connectEverything(registry);
    const { component } = await unrouted();

    // §2, §11: deleting an App detaches its Datastores and never cascades, so
    // an orphaned Datastore row must not keep constraining anybody.
    await database()
      .db.insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: null,
        targetId: connected.get('cluster')!.id,
      });

    const placement = await place(registry, component.id);
    expect(placement.options.filter((o) => o.candidate)).toHaveLength(2);
  });
});
