/**
 * `deleteComponent` (§2, §9, §13).
 *
 * The same claims `delete-app.test.ts` makes, over one Component instead of
 * every Component an App has:
 *
 * - **The review writes nothing.** The first call is the confirmation's
 *   source of truth.
 * - **Deletion cascades to what is only the Component's own.** Builds and
 *   Deploys go; the App and its other Components are untouched.
 * - **A live placement is named, and then torn down.** Confirming calls
 *   `DeployAdapter.destroy` on the ref, and withdraws whatever vanity record
 *   that placement earned.
 * - **The `restrict` foreign keys do not block it**, for the identical reason
 *   `delete-app.test.ts` states one: `deploys.build_id` and
 *   `component_target_desired.desired_*` are `restrict`, and Postgres
 *   enforces one the moment its referenced row is deleted.
 * - **This is what makes §9's sole-serving rule mean something.** An App with
 *   two serving Components gets no vanity name for either; deleting the dead
 *   one is what lets the survivor claim it.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deleteComponent } from '../../src/commands/components/delete.ts';
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
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { zoneFor } from '../../src/domain/naming.ts';
import {
  type DeployLoopContext,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
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
  options: { destroyThrows?: string; dns?: FakeDnsPublisher } = {},
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
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('deleteComponent reached the supply chain');
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

async function seedApp(name: string) {
  const [app] = await database()
    .db.insert(apps)
    .values({ name, sourceKind: 'repo' })
    .returning();
  return app!;
}

/**
 * One Component under an already-seeded App, and — where a Target is given —
 * a Build, a live Deploy, and the desired row whose `restrict` references are
 * the interesting part.
 */
async function seedComponent(
  appId: string,
  name: string,
  options: {
    targetId?: string;
    phase?: 'LIVE' | 'FAILED';
    kind?: 'service' | 'job';
    schedule?: string | null;
    expose?: boolean;
  } = {},
) {
  const db = database().db;
  const [component] = await db
    .insert(components)
    .values({
      appId,
      name,
      kind: options.kind ?? 'service',
      expose: options.expose ?? true,
      reach: 'private',
      auth: 'proxy',
      schedule: options.schedule ?? null,
    })
    .returning();

  if (options.targetId === undefined) {
    return { component: component!, build: null, deploy: null };
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
      ref: `apps/${name}`,
      url: `${name}.example.test`,
    })
    .returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: options.targetId,
    desiredBuildId: build!.id,
    desiredDeployId: deploy!.id,
  });

  return { component: component!, build: build!, deploy: deploy! };
}

describe('the review writes nothing', () => {
  test('it names what would go, and everything is still there', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', { targetId: target.id });
    const { registry } = fakes();

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deleted).toBe(false);
    expect(result.value.componentId).toBe(seeded.component.id);
    expect(result.value.component).toBe('web');
    expect(result.value.builds).toBe(1);
    expect(result.value.deploys).toBe(1);

    const rows = await database()
      .db.select()
      .from(components)
      .where(eq(components.id, seeded.component.id));
    expect(rows).toHaveLength(1);
  });

  test('a Component never placed reviews as an empty act', async () => {
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web');
    const { registry } = fakes();

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stranded).toEqual([]);
    expect(result.value.builds).toBe(0);
    expect(result.value.deploys).toBe(0);
  });
});

describe('confirm deletes', () => {
  test('an undeployed Component is gone, and its App is untouched', async () => {
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web');
    const { registry } = fakes();

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    const db = database().db;
    expect(
      await db
        .select()
        .from(components)
        .where(eq(components.id, seeded.component.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(apps).where(eq(apps.id, app.id)),
    ).toHaveLength(1);
  });

  test('the restrict-referenced Build and Deploy go with it', async () => {
    // Without the ordered deletes this is the test that fails, and it fails as
    // a foreign-key violation from Postgres rather than as a wrong row count.
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', {
      targetId: target.id,
      phase: 'FAILED',
    });
    const { registry } = fakes();

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
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
    // The Target is not a casualty of deleting a Component placed on it.
    expect(
      await db.select().from(targets).where(eq(targets.id, target.id)),
    ).toHaveLength(1);
  });

  test('a sibling Component and its own history are untouched', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const gone = await seedComponent(app.id, 'demo', { targetId: target.id });
    const kept = await seedComponent(app.id, 'web', { targetId: target.id });
    const { registry } = fakes();

    const result = await deleteComponent(
      { componentId: gone.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    const db = database().db;
    expect(
      await db
        .select()
        .from(components)
        .where(eq(components.id, kept.component.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(deploys).where(eq(deploys.id, kept.deploy!.id)),
    ).toHaveLength(1);
  });
});

describe('a live placement is named and torn down', () => {
  test('the review names it, and confirming destroys the ref', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', { targetId: target.id });
    const { registry, of } = fakes();

    const review = await deleteComponent(
      { componentId: seeded.component.id, confirm: false },
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

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(of('kubernetes').destroyed).toEqual(['apps/web']);
    expect(result.value.deleted && result.value.retainedWorkloads).toEqual([]);
  });

  test('a refused teardown is reported, and the Component still goes', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', { targetId: target.id });
    const { registry } = fakes({ destroyThrows: 'the cluster said no' });

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.deleted) return;
    expect(result.value.retainedWorkloads).toEqual([
      'folly/kubernetes — the cluster said no',
    ]);
    expect(
      await database()
        .db.select()
        .from(components)
        .where(eq(components.id, seeded.component.id)),
    ).toHaveLength(0);
  });
});

describe('§9: confirming withdraws the vanity record (ticket 137b)', () => {
  test('a torn-down placement withdraws its handle', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', { targetId: target.id });
    const dns = new FakeDnsPublisher();
    const { registry } = fakes({ dns });

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    expect(dns.withdrawn).toEqual(['shop-web']);
  });

  test('a refused teardown never reaches the DNS publisher', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    const seeded = await seedComponent(app.id, 'web', { targetId: target.id });
    const dns = new FakeDnsPublisher();
    const { registry } = fakes({ destroyThrows: 'the cluster said no', dns });

    const result = await deleteComponent(
      { componentId: seeded.component.id, confirm: true },
      context(registry),
    );

    expect(result.ok).toBe(true);
    expect(dns.withdrawn).toEqual([]);
  });
});

describe('what it refuses', () => {
  test('an id no Component answers to', async () => {
    const { registry } = fakes();
    const result = await deleteComponent(
      { componentId: crypto.randomUUID(), confirm: false },
      context(registry),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

/**
 * §9: "a sole serving Component carries the App's vanity name" — the fact
 * `deleteComponent` exists to make reachable. Two serving Components contend
 * for one name and neither gets it (`deploy-loop.test.ts` proves that half);
 * this proves the other half — deleting one is what lets the survivor claim
 * it.
 */
describe('§9: the sole-serving rule sees one Component afterwards', () => {
  function loopContext(adapter: FakeDeployAdapter): DeployLoopContext {
    return {
      db: database().db,
      adapters: {
        deploy: (name) => (name === adapter.adapter ? adapter : null),
      },
      clock,
      manifest,
    };
  }

  test('deleting the second claimant frees the vanity name for the survivor', async () => {
    const target = await seedTarget('folly', 'kubernetes');
    const app = await seedApp('shop');
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));
    const survivor = await seedComponent(app.id, 'web', {
      targetId: target.id,
    });
    const demo = await seedComponent(app.id, 'demo', { targetId: target.id });

    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    // Two serving Components: neither is unambiguous, so core mints no
    // vanity name for either of them yet.
    await runDeployPass(loopContext(adapter));
    const contended = adapter.applied.find(
      (call) => call.desired.component === 'web',
    );
    expect(contended?.desired.hostname.vanity).toBeUndefined();

    const { registry } = fakes();
    const result = await deleteComponent(
      { componentId: demo.component.id, confirm: true },
      context(registry),
    );
    expect(result.ok).toBe(true);

    // The survivor is the App's only serving Component now — the next
    // convergence carries the vanity name.
    const redeployed = new FakeDeployAdapter({ adapter: 'kubernetes' });
    await database()
      .db.update(deploys)
      .set({ phase: 'PENDING' })
      .where(eq(deploys.id, survivor.deploy!.id));
    await runDeployPass(loopContext(redeployed));

    const zone = zoneFor('private', manifest.dns.zones);
    expect(redeployed.applied[0]?.desired.hostname.vanity).toBe(`shop.${zone}`);
  });
});
