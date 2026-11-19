/**
 * Each Component's own names on the workspace, as the deploy loop mints them.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { setComponentVanity } from '../../src/commands/components/vanity.ts';
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

/** One App with an exposed Component per name, each on its own Target. */
async function appServing(
  ctx: CommandContext,
  names: readonly string[],
): Promise<{
  appId: string;
  appName: string;
  componentIds: Record<string, string>;
}> {
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

  const componentIds: Record<string, string> = {};
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
    componentIds[name] = created.value.componentId;

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

  return { appId: app.value.appId, appName, componentIds };
}

describe('the workspace read on each Component’s own names', () => {
  test('the apex label reads as the bare zone, and becomes the URL before a deploy', async () => {
    const ctx = context();
    const app = await appServing(ctx, ['web']);
    const named = await setComponentVanity(
      { componentId: app.componentIds.web!, label: '@' },
      ctx,
    );
    expect(named.ok).toBe(true);

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [web] = result.value.workspace.domain?.components ?? [];
    expect(web?.component).toBe('web');
    expect(web?.label).toBe('@');
    // `@` is the apex, so the published name is a bare zone.
    const zones = manifest.dns.zones.map((zone) => zone.name);
    expect(zones).toContain(web?.vanity as string);
    expect(web?.hostnames).toContain(web?.vanity as string);
    // The URL is the hostname, never the `@` label.
    expect(result.value.workspace.url).toBe(web?.vanity as string);
  });

  test('two serving Components each publish their own vanity name beside their canonical', async () => {
    const ctx = context();
    const app = await appServing(ctx, ['web', 'admin']);
    for (const [component, label] of [
      ['web', 'shop'],
      ['admin', 'admin'],
    ] as const) {
      const named = await setComponentVanity(
        { componentId: app.componentIds[component]!, label },
        ctx,
      );
      expect(named.ok).toBe(true);
    }

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zone = manifest.dns.zones.find((one) =>
      one.reaches.includes('public'),
    )?.name;
    const byName = Object.fromEntries(
      (result.value.workspace.domain?.components ?? []).map((one) => [
        one.component,
        one,
      ]),
    );
    expect(byName.web?.canonical).toBe(`${app.appName}-web.${zone}`);
    expect(byName.web?.vanity).toBe(`shop.${zone}`);
    expect(byName.web?.hostnames).toEqual([
      `${app.appName}-web.${zone}`,
      `shop.${zone}`,
    ]);
    expect(byName.admin?.vanity).toBe(`admin.${zone}`);
    expect(byName.admin?.hostnames).toEqual([
      `${app.appName}-admin.${zone}`,
      `admin.${zone}`,
    ]);
  });

  test('a Component that named nothing offers the zones serving its reach', async () => {
    const ctx = context();
    const app = await appServing(ctx, ['web']);

    const result = await getAppWorkspace({ name: app.appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const domain = result.value.workspace.domain;
    const [web] = domain?.components ?? [];
    expect(web?.label).toBeNull();
    expect(web?.vanity).toBeNull();
    expect(web?.zoneFits).toBe(true);
    expect(web?.servingZones).toEqual(
      manifest.dns.zones
        .filter((zone) => zone.reaches.includes('public'))
        .map((zone) => zone.name),
    );
    // Each zone states its reaches, so one that cannot serve the Component
    // still shows.
    expect(domain?.zones.length).toBe(manifest.dns.zones.length);
    for (const zone of domain?.zones ?? []) {
      expect(zone.reaches.length).toBeGreaterThan(0);
    }
  });
});
