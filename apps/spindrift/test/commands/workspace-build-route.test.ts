/**
 * The App workspace states which routes it can build on (§4, §16).
 *
 * `getAppWorkspace` used to say nothing about `apps.buildRoute` at all — the
 * picker had no read to draw from. This pins the two facts the read has to
 * get right: every configured route comes back judged against the placed
 * Target's minimum level alone, and choosing one narrows what `routeForTarget`
 * picks at dispatch without narrowing what this list still offers to switch
 * to — the read calls `buildRouteFor` with no App id, deliberately, for
 * exactly that reason (`commands/apps/workspace.ts`).
 *
 * The fixture installation ranks `hosted` (github-actions, L2) first, then
 * `managed` (cloud-build, L3), then `local` (in-cluster, L1).
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppBuildRoute } from '../../src/commands/apps/build-route.ts';
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

/** One App, one `service` Component, placed on a Target of its own. */
async function placedApp(
  ctx: CommandContext,
  minBuildLevel: number | null,
): Promise<{ appId: string; appName: string; targetId: string }> {
  const name = `builder-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    { name, sourceKind: 'repo', repoUrl: 'https://vcs.example/acme/thing.git' },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const web = await createComponent(
    {
      appId: app.value.appId,
      name: 'web',
      kind: 'service',
      expose: true,
      reach: 'private',
      auth: 'proxy',
    },
    ctx,
  );
  if (!web.ok) throw new Error(web.failure.message);

  const vessel = await insertVessel(ctx.db, 'kubernetes');
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, minBuildLevel }))
    .returning();
  const targetId = target?.id as string;

  await ctx.db
    .insert(componentTargetDesired)
    .values({ componentId: web.value.componentId, targetId });
  await ctx.db
    .update(components)
    .set({ placedTargetId: targetId })
    .where(eq(components.id, web.value.componentId));

  return { appId: app.value.appId, appName: name, targetId };
}

describe('the workspace read on build routes', () => {
  test('offers every configured route, judged against the placed Target’s minimum level', async () => {
    const ctx = context();
    const app = await placedApp(ctx, null); // unset, so §16's default L2 applies

    const result = await getAppWorkspace({ name: app.appName }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.buildRoute).toBeNull();
    expect(result.value.workspace.buildRouteOptions).toEqual([
      {
        name: 'hosted',
        adapter: 'github-actions',
        level: 2,
        eligible: true,
        reason: '',
      },
      {
        name: 'managed',
        adapter: 'cloud-build',
        level: 3,
        eligible: true,
        reason: '',
      },
      {
        name: 'local',
        adapter: 'in-cluster',
        level: 1,
        eligible: false,
        reason:
          'this route guarantees SLSA Build Level 1 and this Target requires at least L2',
      },
    ]);
  });

  test('states the App’s own choice without narrowing what the picker offers to switch to', async () => {
    const ctx = context();
    const app = await placedApp(ctx, null);

    const chosen = await setAppBuildRoute(
      { appId: app.appId, route: 'managed' },
      ctx,
    );
    expect(chosen.ok).toBe(true);

    const result = await getAppWorkspace({ name: app.appName }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.buildRoute).toBe('managed');
    // Every route is still offered on its own merits — an App that has chosen
    // `managed` can still see `hosted` as an eligible route to switch to,
    // which `buildRouteFor` would instead refuse as "not-admitted" had this
    // read passed the App's id and let its own choice narrow the candidates
    // the way dispatch does.
    expect(
      result.value.workspace.buildRouteOptions.map((option) => option.name),
    ).toEqual(['hosted', 'managed', 'local']);
    expect(
      result.value.workspace.buildRouteOptions.find(
        (option) => option.name === 'hosted',
      )?.eligible,
    ).toBe(true);
  });

  test('is empty for an App with no Target placed yet', async () => {
    const ctx = context();
    const name = `unplaced-${crypto.randomUUID().slice(0, 8)}`;
    const app = await createApp(
      {
        name,
        sourceKind: 'repo',
        repoUrl: 'https://vcs.example/acme/thing.git',
      },
      ctx,
    );
    if (!app.ok) throw new Error(app.failure.message);
    const web = await createComponent(
      {
        appId: app.value.appId,
        name: 'web',
        kind: 'service',
        expose: true,
        reach: 'private',
        auth: 'proxy',
      },
      ctx,
    );
    if (!web.ok) throw new Error(web.failure.message);

    const result = await getAppWorkspace({ name }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.buildRouteOptions).toEqual([]);
  });
});
