// deleteApp's review writes nothing. Confirming tears down live refs, detaches
// Datastores, and deletes in order past the `restrict` foreign keys.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deleteApp } from '../../src/commands/apps/delete.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  datastores,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeDnsPublisher } from '../harness/fakes/dns-publisher.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/** One fake per adapter type, so a test can ask whether it was ever called. */
function fakes(
  options: {
    destroyThrows?: string;
    sweepThrows?: string;
    dns?: FakeDnsPublisher;
  } = {},
) {
  const made = new Map<string, FakeDeployAdapter>();
  const registry: AdapterRegistry = {
    deploy(adapter) {
      let fake = made.get(adapter);
      if (!fake) {
        fake = new FakeDeployAdapter({ adapter, ...options });
        made.set(adapter, fake);
      }
      return fake;
    },
    build: () => null,
    // Reaching a store would mean reaping config this delete was never given.
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('deleteApp reached the supply chain');
    },
    ...(options.dns === undefined ? {} : { dns: () => options.dns! }),
  };
  return {
    registry,
    of(adapter: string): FakeDeployAdapter {
      const fake = made.get(adapter);
      if (fake === undefined)
        throw new Error(`no ${adapter} adapter was built`);
      return fake;
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

/** A connected Target to hang Deploys off, on its own named vessel. */
async function seedTarget(name: string, adapter: 'kubernetes' | 'static') {
  const vessel = await insertVessel(database().db, adapter, { name });
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues({ vesselId: vessel.id, adapter, health: 'healthy' }))
    .returning();
  return target!;
}

// An App with one Component and, given a Target, a Build, a live Deploy and the
// desired row that references both.
async function seedApp(
  name: string,
  options: {
    targetId?: string;
    phase?: 'LIVE' | 'FAILED';
    kind?: 'service' | 'job';
    schedule?: string | null;
  } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name, sourceKind: 'repo' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: options.kind ?? 'service',
      schedule: options.schedule ?? null,
    })
    .returning();

  if (options.targetId === undefined) {
    return { app: app!, component: component!, build: null, deploy: null };
  }

  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
      status: 'SUCCEEDED',
      artifactDigest: 'sha256:abc',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      desired: aDesiredDocument(),
      targetId: options.targetId,
      buildId: build!.id,
      phase: options.phase ?? 'LIVE',
      ref: 'apps/web',
      url: 'web.example.test',
    })
    .returning();
  // The two `restrict` references, both pointed at rows this delete removes.
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: options.targetId,
    desiredBuildId: build!.id,
    desiredDeployId: deploy!.id,
  });

  return { app: app!, component: component!, build: build!, deploy: deploy! };
}

describe('the review writes nothing', () => {
  test('it names what would go, and everything is still there', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('review-me', { targetId: target.id });
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'review-me', confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deleted).toBe(false);
    expect(result.value.appId).toBe(seeded.app.id);
    expect(result.value.components).toEqual(['web']);
    expect(result.value.builds).toBe(1);
    expect(result.value.deploys).toBe(1);

    const rows = await database()
      .db.select()
      .from(apps)
      .where(eq(apps.id, seeded.app.id));
    expect(rows).toHaveLength(1);
  });

  test('an App with nothing deployed reviews as an empty act', async () => {
    await seedApp('never-deployed');
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'never-deployed', confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stranded).toEqual([]);
    expect(result.value.builds).toBe(0);
    expect(result.value.deploys).toBe(0);
    expect(result.value.detachedDatastores).toEqual([]);
  });
});

describe('confirm deletes', () => {
  test('an undeployed App and its Component are gone', async () => {
    const seeded = await seedApp('throwaway');
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'throwaway', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    const db = database().db;
    expect(
      await db.select().from(apps).where(eq(apps.id, seeded.app.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(components)
        .where(eq(components.id, seeded.component.id)),
    ).toHaveLength(0);
  });

  test('the restrict-referenced Build and Deploy go with it', async () => {
    // Without ordered deletes this fails as a foreign-key violation.
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('has-history', {
      targetId: target.id,
      phase: 'FAILED',
    });
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'has-history', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    const db = database().db;
    expect(
      await db.select().from(builds).where(eq(builds.id, seeded.build!.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(deploys).where(eq(deploys.id, seeded.deploy!.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(componentTargetDesired)
        .where(eq(componentTargetDesired.componentId, seeded.component.id)),
    ).toHaveLength(0);
    // The Target is not a casualty of deleting an App placed on it.
    expect(
      await db.select().from(targets).where(eq(targets.id, target.id)),
    ).toHaveLength(1);
  });
});

describe('a live workload is named and torn down', () => {
  test('the review names it, and confirming destroys the ref', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('is-live', { targetId: target.id });
    const { registry, of } = fakes();

    const review = await deleteApp(
      { name: 'is-live', confirm: false },
      context(registry),
    );
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.stranded).toEqual([
      {
        deployId: String(seeded.deploy!.id),
        component: 'web',
        target: 'folly/kubernetes',
        url: 'web.example.test',
        firing: false,
        nameSpent: false,
      },
    ]);

    const result = await deleteApp(
      { name: 'is-live', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(of('kubernetes').destroyed).toEqual(['apps/web']);
    expect(result.value.deleted && result.value.retainedWorkloads).toEqual([]);
  });

  test('a refused teardown is reported, and the App still goes', async () => {
    // An unreachable Target is named, not a veto, and `destroy` is idempotent.
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('wont-tear-down', { targetId: target.id });
    const { registry } = fakes({ destroyThrows: 'the cluster said no' });

    const result = await deleteApp(
      { name: 'wont-tear-down', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.deleted) return;
    expect(result.value.retainedWorkloads).toEqual([
      'web on folly/kubernetes — the cluster said no',
    ]);
    expect(
      await database().db.select().from(apps).where(eq(apps.id, seeded.app.id)),
    ).toHaveLength(0);
  });

  test('a FAILED Deploy that left a ref is still torn down', async () => {
    // `ref` survives a failed re-attempt, so its resource may still be up and
    // billing.
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('half-made', { targetId: target.id, phase: 'FAILED' });
    const { registry, of } = fakes();

    const review = await deleteApp(
      { name: 'half-made', confirm: false },
      context(registry),
    );
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.stranded).toEqual([]);

    const result = await deleteApp(
      { name: 'half-made', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    expect(of('kubernetes').destroyed).toEqual(['apps/web']);
  });

  test('a scheduled job is named as one that keeps firing', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('bills-forever', {
      targetId: target.id,
      kind: 'job',
      schedule: '0 3 * * *',
    });
    const { registry } = fakes();

    const review = await deleteApp(
      { name: 'bills-forever', confirm: false },
      context(registry),
    );

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    // A stranded schedule bills on every tick, so the review names it before
    // the rows go.
    expect(review.value.stranded).toHaveLength(1);
    expect(review.value.stranded[0]?.firing).toBe(true);
  });

  test('a workload on static hosting is named as one whose name is spent', async () => {
    // A static hosting site id can never be reactivated, so the review warns
    // that the address is spent before the confirmation.
    const target = await seedTarget('hosting', 'static');
    await seedApp('spends-its-name', { targetId: target.id });
    const { registry } = fakes();

    const review = await deleteApp(
      { name: 'spends-its-name', confirm: false },
      context(registry),
    );

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.stranded).toHaveLength(1);
    expect(review.value.stranded[0]?.nameSpent).toBe(true);
  });

  test('an unscheduled job is stranded but not firing', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('idle-job', { targetId: target.id, kind: 'job' });
    const { registry } = fakes();

    const review = await deleteApp(
      { name: 'idle-job', confirm: false },
      context(registry),
    );

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.value.stranded[0]?.firing).toBe(false);
  });
});

describe('§9: confirming withdraws the vanity record (ticket 137b)', () => {
  test('a torn-down placement withdraws its handle', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('is-live', { targetId: target.id });
    const dns = new FakeDnsPublisher();
    const { registry } = fakes({ dns });

    const result = await deleteApp(
      { name: 'is-live', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    // The handle is `<App>-<Component>`, withdrawn even for a cluster Target.
    expect(dns.withdrawn).toEqual(['is-live-web']);
  });

  test('a refused teardown never reaches the DNS publisher', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('wont-tear-down', { targetId: target.id });
    const dns = new FakeDnsPublisher();
    const { registry } = fakes({
      destroyThrows: 'the cluster said no',
      dns,
    });

    const result = await deleteApp(
      { name: 'wont-tear-down', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    expect(dns.withdrawn).toEqual([]);
  });
});

describe("the App's own container is swept after its placements", () => {
  test('the Target is swept once, by App name', async () => {
    // No ref names the App's namespace, so `destroy` alone leaves it behind.
    const target = await seedTarget('folly', 'kubernetes');
    await seedApp('sweep-me', { targetId: target.id });
    const { registry, of } = fakes();

    const result = await deleteApp(
      { name: 'sweep-me', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.deleted) return;
    expect(of('kubernetes').swept).toEqual(['sweep-me']);
    expect(result.value.retainedWorkloads).toEqual([]);
  });

  test('a refused sweep is reported, and the App still goes', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('wont-sweep', { targetId: target.id });
    const { registry } = fakes({ sweepThrows: 'the namespace is not ours' });

    const result = await deleteApp(
      { name: 'wont-sweep', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.deleted) return;
    expect(result.value.retainedWorkloads).toEqual([
      'wont-sweep on folly/kubernetes — the namespace is not ours',
    ]);
    expect(
      await database().db.select().from(apps).where(eq(apps.id, seeded.app.id)),
    ).toHaveLength(0);
  });

  test('a container two Apps share is left in place', async () => {
    // The container is named for the App, so another App of that name is in it
    // too.
    const target = await seedTarget('folly', 'kubernetes');
    const mine = await seedApp('twinned', { targetId: target.id });
    await seedApp('twinned', { targetId: target.id });
    const { registry, of } = fakes();

    const result = await deleteApp(
      { name: mine.app.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.deleted) return;
    expect(of('kubernetes').swept).toEqual([]);
    expect(result.value.retainedWorkloads).toEqual([
      "twinned on folly/kubernetes — 1 other App answers to 'twinned', so its container is shared and was left in place",
    ]);
  });
});

describe('a Datastore survives the App it was attached to', () => {
  test('it is detached, not deleted (§11)', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('has-a-database');
    const db = database().db;
    const [datastore] = await db
      .insert(datastores)
      .values({
        name: 'primary',
        engine: 'postgres',
        provenance: 'managed',
        appId: seeded.app.id,
        vesselId: target.vesselId,
      })
      .returning();
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'has-a-database', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detachedDatastores).toEqual(['primary']);

    const [survivor] = await db
      .select()
      .from(datastores)
      .where(eq(datastores.id, datastore!.id));
    expect(survivor).toBeDefined();
    expect(survivor?.appId).toBeNull();
  });
});

describe('what it refuses', () => {
  test('a name no App answers to', async () => {
    const { registry } = fakes();
    const result = await deleteApp(
      { name: 'nothing', confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('a name two Apps answer to, rather than guessing', async () => {
    const first = await seedApp('twice');
    const second = await seedApp('twice');
    const { registry } = fakes();

    const result = await deleteApp(
      { name: 'twice', confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toContain(first.app.id);
    expect(result.failure.message).toContain(second.app.id);
    // Neither was touched.
    expect(await database().db.select().from(apps)).toHaveLength(2);
  });

  test('by id, the ambiguity is resolvable', async () => {
    const first = await seedApp('twice');
    await seedApp('twice');
    const { registry } = fakes();

    const result = await deleteApp(
      { name: first.app.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    const remaining = await database().db.select().from(apps);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(first.app.id);
  });
});
