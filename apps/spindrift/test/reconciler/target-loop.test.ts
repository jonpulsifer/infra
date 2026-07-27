/**
 * The Target loop (Task 14, §13 and §3).
 *
 * The claim under test is §3's reason for having a loop at all: "**a connect-
 * time snapshot rots**, and the symptom is a Target disabled long after it
 * stopped being incapable." So the load-bearing test here is the last one — a
 * capability changing on the far side changes what can be placed there on the
 * next pass, **without a reconnect**. If that only worked at connect time, every
 * other test in this file could still pass.
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
import { apps, components, targets } from '../../src/db/schema.ts';
import { PREREQUISITES } from '../../src/domain/capabilities.ts';
import {
  refreshAllTargets,
  refreshTarget,
  runTargetLoop,
} from '../../src/reconciler/target-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  clusterInput,
  fixtureManifest,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

/** A clock that moves, so `inspectedAt` can be told apart between passes. */
function ticking(): Clock & { advance(): void } {
  let at = new Date('2024-06-01T00:00:00.000Z');
  return {
    now: () => at,
    advance() {
      at = new Date(at.getTime() + 60_000);
    },
  };
}

function fakes() {
  const made = new Map<TargetAdapter, FakeDeployAdapter>();
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
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
  };
  return {
    registry,
    of: (adapter: TargetAdapter) =>
      registry.deploy(adapter) as FakeDeployAdapter,
  };
}

function context(registry: AdapterRegistry, clock: Clock): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: registry,
    manifest,
  };
}

async function targetRow(name: string) {
  const rows = await database()
    .db.select()
    .from(targets)
    .where(eq(targets.name, name));
  return rows[0]!;
}

describe('one pass over every connected Target', () => {
  test('writes the checklist, the discovery, and the derived health', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster' }));

    clock.advance();
    const [refresh] = await refreshAllTargets(context(registry, clock));

    expect(refresh?.health).toBe('healthy');
    const row = await targetRow('cluster');
    expect(row.discovery?.arch).toEqual(['amd64', 'arm64']);
    expect(row.prerequisites).toHaveLength(PREREQUISITES.length);
    expect(row.inspectedAt).toEqual(clock.now());
    expect(of('kubernetes').inspected.map((t) => t.name)).toEqual(['cluster']);
  });

  test('a disconnected Target is not polled', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'gone', status: 'disconnected' }));

    expect(await refreshAllTargets(context(registry, clock))).toEqual([]);
    // Continuing to poll a Target the operator removed would keep someone
    // else's control plane in the loop's hot path for as long as the row lives.
    expect(of('kubernetes').inspected).toEqual([]);
  });

  test('the loop never flips connected or disconnected', async () => {
    const { registry } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster', health: 'unhealthy' }));

    await refreshAllTargets(context(registry, clock));
    // Connected and disconnected are the operator's statement. A loop that
    // could set them would make a disconnect undo itself.
    expect((await targetRow('cluster')).status).toBe('connected');
    expect((await targetRow('cluster')).health).toBe('healthy');
  });

  test('health changing is reported, and health staying is not', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster', health: 'unhealthy' }));

    const [first] = await refreshAllTargets(context(registry, clock));
    expect(first?.healthChangedFrom).toBe('unhealthy');

    const [second] = await refreshAllTargets(context(registry, clock));
    expect(second?.healthChangedFrom).toBeUndefined();

    of('kubernetes').discover({});
    expect(second?.health).toBe('healthy');
  });

  test('a Target that stops answering goes unhealthy, and recovers', async () => {
    const { registry } = fakes();
    const clock = ticking();
    const unreachable = new FakeDeployAdapter({
      adapter: 'kubernetes',
      unreachable: 'the API server is not answering',
    });
    const [row] = await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster' }))
      .returning();

    const down: AdapterRegistry = { ...registry, deploy: () => unreachable };
    await refreshTarget(context(down, clock), row!);
    expect((await targetRow('cluster')).health).toBe('unhealthy');

    await refreshTarget(context(registry, clock), await targetRow('cluster'));
    expect((await targetRow('cluster')).health).toBe('healthy');
  });
});

describe('a capability flip changes candidacy on the next pass', () => {
  test('without a reconnect', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    const ctx = () => context(registry, clock);

    await connectTarget(clusterInput({ name: 'cluster' }), ctx());

    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'invoices', sourceKind: 'repo' })
      .returning();
    const [component] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'worker', kind: 'service' })
      .returning();

    const place = async () => {
      const result = await resolveComponentPlacement(
        { componentId: component!.id },
        ctx(),
      );
      if (!result.ok) throw new Error('placement refused');
      return result.value;
    };

    expect((await place()).suggestedTargetId).not.toBeNull();

    // The far side changes: the cluster loses its route to the secret store.
    // Nothing about the Target row changes until the loop looks again.
    of('kubernetes').discover({ reachableSecretStores: [] });
    expect((await place()).suggestedTargetId).not.toBeNull();

    clock.advance();
    await refreshAllTargets(ctx());

    // §3: "the symptom is a Target disabled long after it stopped being
    // incapable" — the loop is what stops that being true in both directions.
    const after = await place();
    expect(after.suggestedTargetId).toBeNull();
    expect(after.options[0]?.candidate).toBe(false);
    expect(after.options[0]?.reasons).toEqual(['STORE_UNREACHABLE']);

    // And back again, still with no reconnect.
    of('kubernetes').discover({
      reachableSecretStores: ['gcp-secret-manager'],
    });
    await refreshAllTargets(ctx());
    expect((await place()).suggestedTargetId).not.toBeNull();
  });
});

describe('the loop itself', () => {
  test('runs passes until aborted', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster' }));

    const controller = new AbortController();
    let passes = 0;
    const loop = runTargetLoop(context(registry, clock), {
      intervalMs: 1,
      signal: controller.signal,
      onPass: () => {
        passes += 1;
        if (passes === 3) controller.abort();
      },
    });

    await loop;
    expect(passes).toBe(3);
    expect(of('kubernetes').inspected).toHaveLength(3);
  });

  test('an already-aborted signal runs no pass at all', async () => {
    const { registry, of } = fakes();
    const clock = ticking();
    await database()
      .db.insert(targets)
      .values(targetValues({ name: 'cluster' }));

    await runTargetLoop(context(registry, clock), {
      intervalMs: 1,
      signal: AbortSignal.abort(),
    });
    expect(of('kubernetes').inspected).toEqual([]);
  });
});
