/**
 * Changing a Component's reach (54, §9).
 *
 * Three claims, and the middle one is the reason this file exists rather than a
 * pair of assertions on a row:
 *
 * - **The grid rule holds on the edit.** `reach: none` with `auth: proxy` was
 *   unsayable at creation and sayable nowhere else, because nowhere else could
 *   say it. It has to stay unsayable now that an edit can.
 * - **A Component edited between an intent and its attempt does not
 *   retroactively change what that attempt places.** `deploys.reach` and
 *   `deploys.auth` were written for this and have never had an edit path to
 *   defend against; a pin nobody has watched hold is not one.
 * - **The next release renders the new answer.** Asserted through `appValues` —
 *   the App chart's own values — because "the edit changed something" is only
 *   true if the thing it changed is what the chart is applied with.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { appValues } from '../../src/adapters/deploy/kubernetes/values.ts';
import { createDeploy, setComponentReach } from '../../src/commands/index.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { AUTH_NEEDS_A_ROUTE } from '../../src/domain/desired-state.ts';
import {
  type DeployLoopContext,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function registryOf(deployAdapter: FakeDeployAdapter): AdapterRegistry {
  const chain = new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: () => {
      throw new Error('a reach edit must not reach a builder');
    },
    store: () => {
      throw new Error('a reach edit must not reach the secret store');
    },
    repository: () => null,
    supplyChain: () => chain,
  };
}

function context(adapters: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

function loopContext(adapter: FakeDeployAdapter): DeployLoopContext {
  return {
    db: database().db,
    adapters: { deploy: (name) => (name === adapter.adapter ? adapter : null) },
    clock,
    manifest,
  };
}

/** An App with one serving Component, a cluster Target, and a Build to place. */
async function fixture(
  reach: 'none' | 'private' | 'public' = 'private',
  auth: 'none' | 'proxy' = 'proxy',
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: 'service',
      expose: true,
      reach,
      auth,
    })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cluster-${crypto.randomUUID()}`,
        adapter: 'kubernetes',
        discovery: null,
      }),
    )
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: DIGEST,
      bundleDigest: DIGEST,
      bundleLocation: 'https://depot.example.test/bundles/1.zip',
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(DIGEST, FROZEN.toISOString()),
    })
    .returning();
  return { app: app!, component: component!, target: target!, build: build! };
}

async function componentRow(id: string) {
  const [row] = await database()
    .db.select()
    .from(components)
    .where(eq(components.id, id));
  return row;
}

describe('the grid an edit may express is the grid a creation may (§9)', () => {
  test('a Component with no route has nothing to authenticate in front of', async () => {
    const { component } = await fixture();

    // Through `dispatch`, because the refusal is the schema's rather than the
    // handler's: it has to be reachable from the surface a browser calls, and
    // it has to name the field an operator would go and change.
    const refused = await dispatch(
      'setComponentReach',
      { componentId: component.id, reach: 'none', auth: 'proxy' },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('INVALID_INPUT');
    expect(refused.failure.issues?.[0]).toEqual({
      path: 'auth',
      message: AUTH_NEEDS_A_ROUTE,
    });
    // Nothing was written on the way to being refused.
    const row = await componentRow(component.id);
    expect(row?.reach).toBe('private');
    expect(row?.auth).toBe('proxy');
  });

  test('an unknown Component is a refusal with an identity', async () => {
    const missing = crypto.randomUUID();
    const result = await setComponentReach(
      { componentId: missing, reach: 'public', auth: 'none' },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain(missing);
  });
});

describe('the edit writes a Component and leaves a Deploy to be pressed', () => {
  test('a Component that has never been placed has nothing serving the old answer', async () => {
    const { component } = await fixture();

    const result = await setComponentReach(
      { componentId: component.id, reach: 'public', auth: 'none' },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingRelease).toEqual([]);
    const row = await componentRow(component.id);
    expect(row?.reach).toBe('public');
    expect(row?.auth).toBe('none');
    expect(row?.updatedAt).toEqual(FROZEN);
  });

  test('a Target still placing the previous answer is named, and nothing is deployed', async () => {
    const { component, target, build } = await fixture();
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    await runDeployPass(loopContext(adapter));
    expect(adapter.applied).toHaveLength(1);

    const result = await setComponentReach(
      { componentId: component.id, reach: 'public', auth: 'none' },
      context(adapters),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pendingRelease).toEqual([target.name]);
    // §9 keeps exposure out of the mutable-in-place category: the act wrote a
    // row and asked the platform for nothing. A second `apply` here would be
    // this command deciding to re-place a live release nobody pressed Deploy
    // for — which is the whole difference between a settings toggle and this.
    expect(adapter.applied).toHaveLength(1);
    const written = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id));
    expect(written).toHaveLength(1);
  });
});

describe('a Component edited mid-attempt does not change what is being placed', () => {
  test('the attempt renders its own pin, and the next release renders the edit', async () => {
    const { component, target, build } = await fixture('private', 'proxy');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    // The intent, pinned at `private` + `proxy` — and then the edit, before
    // the loop has claimed it. This is the window `deploys.reach` exists for.
    const first = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    expect(first.ok).toBe(true);
    const edited = await setComponentReach(
      { componentId: component.id, reach: 'public', auth: 'none' },
      context(adapters),
    );
    expect(edited.ok).toBe(true);

    await runDeployPass(loopContext(adapter));
    expect(adapter.applied).toHaveLength(1);
    const placing = appValues(
      adapter.applied[0]!.desired,
      'ghcr.io/x@sha256:1',
    );
    expect(placing.reach).toBe('private');
    expect(placing.auth).toBe('proxy');
    // The name too, not only the two fields: §9 mints the canonical name into
    // the zone chosen *per reach*, so an attempt whose reach moved under it
    // would place a route for a hostname in the wrong zone.
    expect(placing.hostnames).toContain(
      `shop-web.${manifest.dns.zones.private}`,
    );

    // Now press Deploy. The same Build, the same Target, and a release that
    // renders something else — which is the whole of what "a reach change is a
    // deploy" means.
    const second = await createDeploy(
      { componentId: component.id, targetId: target.id, buildId: build.id },
      context(adapters),
    );
    expect(second.ok).toBe(true);
    await runDeployPass(loopContext(adapter));

    expect(adapter.applied).toHaveLength(2);
    const placed = appValues(adapter.applied[1]!.desired, 'ghcr.io/x@sha256:1');
    expect(placed.reach).toBe('public');
    expect(placed.auth).toBe('none');
    expect(placed.hostnames).toContain(`shop-web.${manifest.dns.zones.public}`);

    // And the pin is on the row, so a rollback to the first release comes back
    // up as private rather than as whatever the Component says today.
    const rows = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, component.id))
      .orderBy(deploys.id);
    expect(rows.map(({ reach, auth }) => ({ reach, auth }))).toEqual([
      { reach: 'private', auth: 'proxy' },
      { reach: 'public', auth: 'none' },
    ]);
  });
});
