/**
 * The App workspace states the App's own address, and whether it is published
 * (§9).
 *
 * §9's vanity name lives on the App and the reconciler will not guess which
 * Component it means, so an App with two network-serving Components publishes
 * no vanity record at all (`deploy-loop.ts`, `soleServingComponent`). The
 * screen that offers the name is the one place that rule can be said before
 * somebody trips it — and until this read carried it, the workspace printed
 * the name as the App's address whatever the reconciler had decided.
 *
 * Both halves are asserted from the same rows, because the defect was exactly
 * that the two counted differently.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppVanity } from '../../src/commands/apps/vanity.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  components,
  componentTargetDesired,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();
const supplyChain = new SupplyChainHarness();
const clock: Clock = { now: () => new Date('2026-08-12T12:00:00.000Z') };

function context(): CommandContext {
  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: () => new FakeBuildAdapter(),
    store: () => null,
    repository: () => null,
    supplyChain: () => supplyChain,
  };
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** One App with `serving` exposed Components, each placed on its own Target. */
async function appServing(
  ctx: CommandContext,
  names: readonly string[],
): Promise<{ appId: string; appName: string }> {
  const appName = `domain-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    {
      name: appName,
      sourceKind: 'repo',
      repoUrl: 'https://vcs.example/acme/thing.git',
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  for (const name of names) {
    const created = await createComponent(
      {
        appId: app.value.appId,
        name,
        kind: 'service',
        expose: true,
        reach: 'public',
        auth: 'none',
      },
      ctx,
    );
    if (!created.ok) throw new Error(created.failure.message);

    const vessel = await insertVessel(ctx.db, 'kubernetes');
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id }))
      .returning();
    const targetId = target?.id as string;
    await ctx.db
      .insert(componentTargetDesired)
      .values({ componentId: created.value.componentId, targetId });
    await ctx.db
      .update(components)
      .set({ placedTargetId: targetId })
      .where(eq(components.id, created.value.componentId));
  }

  return { appId: app.value.appId, appName };
}

describe('the workspace read on the App’s own address', () => {
  test('a sole serving Component carries the name, and the screen says which', async () => {
    const ctx = context();
    const app = await appServing(ctx, ['web']);
    const named = await setAppVanity({ appId: app.appId, label: '@' }, ctx);
    expect(named.ok).toBe(true);

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const domain = result.value.workspace.domain;
    expect(domain?.label).toBe('@');
    expect(domain?.ambiguous).toBe(false);
    expect(domain?.servedBy).toBe('web');
    // The apex is the zone itself rather than a label under it, so the name
    // published is a bare zone from the installation's list.
    const zones = manifest.dns.zones.map((zone) => zone.name);
    const apex = domain?.hostnames.find((name) => zones.includes(name));
    expect(apex).toBeString();
    // And it is the App's address as a *hostname*. `@` is a spelling of "the
    // zone itself", not an address — the hero used to render it as one.
    expect(result.value.workspace.url).toBe(apex as string);
  });

  test('two serving Components publish nothing, and the screen stops claiming one', async () => {
    // The defect this pins: `deploy-loop.ts` drops the vanity name when more
    // than one Component serves, and the workspace printed it anyway — an
    // address on the hero that nothing anywhere would ever resolve.
    const ctx = context();
    const app = await appServing(ctx, ['web', 'admin']);
    const named = await setAppVanity({ appId: app.appId, label: '@' }, ctx);
    expect(named.ok).toBe(true);

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const domain = result.value.workspace.domain;
    // The choice is still the operator's — it is not cleared behind their back.
    expect(domain?.label).toBe('@');
    // But nothing is published under it, and both halves say so.
    expect(domain?.ambiguous).toBe(true);
    expect(domain?.servedBy).toBeNull();
    // The canonical each Component still answers on is here; the shared name
    // is not, because nothing will publish it.
    const zones = manifest.dns.zones.map((zone) => zone.name);
    expect(domain?.hostnames.some((name) => zones.includes(name))).toBe(false);
    expect(result.value.workspace.url).toBe('');
  });

  test('an App that named nothing offers the zones it could name in', async () => {
    const ctx = context();
    const app = await appServing(ctx, ['web']);

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const domain = result.value.workspace.domain;
    expect(domain?.label).toBeNull();
    expect(domain?.zones.length).toBeGreaterThan(0);
    // Every zone states what it answers on, which is what makes one that
    // cannot serve a placed Component's reach readable rather than absent.
    for (const zone of domain?.zones ?? []) {
      expect(zone.reaches.length).toBeGreaterThan(0);
    }
  });
});
