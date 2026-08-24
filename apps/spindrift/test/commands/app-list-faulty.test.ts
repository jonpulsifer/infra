/**
 * The App list and a faulty release (§6).
 *
 * The soak leaves a faulty release `LIVE` — the rollout landed — and stamps
 * `faulty_at` beside it. A list that read the phase alone printed that App
 * green and counted nothing failing, which is the one state a triage scan
 * exists to not miss. So the row ranks a faulty Component with a red one,
 * says so, and does not call its address live.
 */
import { describe, expect, test } from 'bun:test';
import { listApps } from '../../src/commands/apps/list.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  builds,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-08-24T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('the App list reached the supply chain');
  },
};

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

/** One App with two placed services; `web` is live, `worker` is as asked. */
async function seedApp(
  ctx: CommandContext,
  worker: { readonly faultyAt: Date | null },
) {
  const name = `soak-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    { name, sourceKind: 'repo', repoUrl: 'https://vcs.example/acme/soak.git' },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);
  const vessel = await insertVessel(ctx.db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
    .returning();

  for (const [component, faultyAt] of [
    ['web', null],
    ['worker', worker.faultyAt],
  ] as const) {
    const created = await createComponent(
      {
        appId: app.value.appId,
        name: component,
        kind: 'service',
        expose: true,
        reach: 'private',
        auth: 'proxy',
      },
      ctx,
    );
    if (!created.ok) throw new Error(created.failure.message);
    await ctx.db.insert(componentTargetDesired).values({
      componentId: created.value.componentId,
      targetId: target!.id,
    });
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: created.value.componentId,
        commit: crypto.randomUUID().slice(0, 7),
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        status: 'SUCCEEDED',
      })
      .returning();
    await ctx.db.insert(deploys).values({
      componentId: created.value.componentId,
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
      url: `https://${name}-${component}.apps.example.test`,
      faultyAt,
      ...(faultyAt === null
        ? {}
        : { reason: 'STARTUP_FAILED', blame: 'developer' }),
    });
  }
  return app.value.appId;
}

describe('the App list and a faulty release', () => {
  test('a faulty Component is the row, is said to be faulty, and counts as failing', async () => {
    const ctx = context();
    const appId = await seedApp(ctx, { faultyAt: FROZEN });

    const listed = await listApps({}, ctx);
    if (!listed.ok) throw new Error(listed.failure.message);
    const row = listed.value.apps.find((app) => app.id === appId);
    expect(row).toMatchObject({
      phase: 'LIVE',
      faulty: true,
      urlLive: false,
      failing: 1,
      componentCount: 2,
    });
    // The row is about the faulty Component, not whichever came back first.
    expect(row?.url).toContain('-worker.');
  });

  test('two live Components are live', async () => {
    const ctx = context();
    const appId = await seedApp(ctx, { faultyAt: null });

    const listed = await listApps({}, ctx);
    if (!listed.ok) throw new Error(listed.failure.message);
    expect(listed.value.apps.find((app) => app.id === appId)).toMatchObject({
      phase: 'LIVE',
      faulty: false,
      urlLive: true,
      failing: 0,
    });
  });
});
