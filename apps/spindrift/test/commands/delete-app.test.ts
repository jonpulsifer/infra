/**
 * `deleteApp` (§2, §11, §13).
 *
 * Every test here is an assertion about a promise the command makes that a
 * straightforward `DELETE FROM apps` would break:
 *
 * - **The review writes nothing.** The first call is the confirmation's source
 *   of truth, so an App is still there afterwards with every row it had.
 * - **Deletion cascades to what is only the App's, and detaches what is not.**
 *   Components, Builds and Deploys go (§2); a Datastore survives with
 *   `app_id = null` (§11), because reattachment to a different App is the whole
 *   reason it is a top-level noun.
 * - **A live workload is named and left running** (§13). No `destroy` is ever
 *   called, and the confirmation names what keeps running — after the rows are
 *   gone, that list is the only record they exist.
 * - **The `restrict` foreign keys do not block it.** `deploys.build_id` and
 *   `component_target_desired.desired_*` are `restrict`, and Postgres enforces
 *   one the moment its referenced row is deleted. A delete that leaned on the
 *   cascade would fail here, which is why the command deletes in order.
 *
 * Rows are what is asserted, not return values: a command that reported a
 * deletion it did not perform would pass a test of its own output.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deleteApp } from '../../src/commands/index.ts';
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
function fakes() {
  const made = new Map<string, FakeDeployAdapter>();
  const registry: AdapterRegistry = {
    deploy(adapter) {
      let fake = made.get(adapter);
      if (!fake) {
        fake = new FakeDeployAdapter({ adapter });
        made.set(adapter, fake);
      }
      return fake;
    },
    build: () => null,
    // Reaching a store would mean this delete tried to reap config it was never
    // given; the throw is the assertion.
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('deleteApp reached the supply chain');
    },
  };
  return {
    registry,
    of(adapter: string): FakeDeployAdapter {
      const fake = made.get(adapter);
      if (fake === undefined)
        throw new Error(`no ${adapter} adapter was built`);
      return fake;
    },
    built: () => made,
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

/**
 * An App with one Component, and — where a Target is given — a Build, a live
 * Deploy, and the desired row whose `restrict` references are the interesting
 * part.
 */
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
    // Without the ordered deletes this is the test that fails, and it fails as
    // a foreign-key violation from Postgres rather than as a wrong row count.
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

describe('a live workload is named and left running', () => {
  test('the review names it, and confirming never calls destroy', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const seeded = await seedApp('is-live', { targetId: target.id });
    const { registry, built } = fakes();

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
    // Named again after the fact: the rows are gone, so this is the only record
    // that the workload is still there.
    expect(result.value.stranded).toHaveLength(1);
    // §13's rule, verbatim: no adapter was ever constructed, so nothing was
    // torn down.
    expect(built().size).toBe(0);
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
    // The point of this box: a stranded schedule is not merely sitting there
    // like a stranded service — it bills on every tick, so the review has to
    // say so before the rows that name it are gone.
    expect(review.value.stranded).toHaveLength(1);
    expect(review.value.stranded[0]?.firing).toBe(true);
  });

  test('a workload on static hosting is named as one whose name is spent', async () => {
    // A site id is global and permanent — "the `SITE_ID` cannot be reactivated
    // by you or anyone else" — so the hand clean-up this review sends the
    // operator to do costs that address forever. The review has to say so
    // before the confirmation, because it is the one consequence of deleting
    // an App that going back and undoing it does not answer.
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
        targetId: target.id,
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
