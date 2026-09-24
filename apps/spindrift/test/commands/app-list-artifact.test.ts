// Apps with no config all share one configVersion, so `artifact` must come from
// the Build's digest to tell them apart.
import { describe, expect, test } from 'bun:test';
import { listApps } from '../../src/commands/apps/list.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
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
import { configVersionOf } from '../../src/domain/config-version.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-08-04T00:00:00.000Z');
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

/** One LIVE App on its own artifact, with no config. */
async function seedLiveApp(
  ctx: CommandContext,
  options: { readonly prefix: string; readonly artifactDigest: string },
) {
  const name = `${options.prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: `https://vcs.example/acme/${options.prefix}.git`,
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const component = await createComponent(
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
  if (!component.ok) throw new Error(component.failure.message);

  // A Target is unique per (vessel, adapter), and this runs twice in one test.
  const vessel = await insertVessel(ctx.db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
    .returning();
  await ctx.db.insert(componentTargetDesired).values({
    componentId: component.value.componentId,
    targetId: target!.id,
  });

  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: component.value.componentId,
      commit: crypto.randomUUID().slice(0, 7),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: options.artifactDigest,
      status: 'SUCCEEDED',
      runner: 'hosted runner',
    })
    .returning();

  // An empty config document still hashes, to the same value for every App.
  const emptyConfigVersion = await configVersionOf([]);

  const [deploy] = await ctx.db
    .insert(deploys)
    .values({
      componentId: component.value.componentId,
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
      configVersion: emptyConfigVersion,
    })
    .returning();

  return {
    appId: app.value.appId,
    name,
    configVersion: emptyConfigVersion,
    deployId: deploy!.id,
  };
}

describe('the App list names the artifact, not the config hash', () => {
  test('two Apps with distinct artifacts and identical (empty) config never share a value', async () => {
    const ctx = context();
    const a = await seedLiveApp(ctx, {
      prefix: 'sdd',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    const b = await seedLiveApp(ctx, {
      prefix: 'statty',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });

    expect(a.configVersion).toBe(b.configVersion);
    expect(a.configVersion).toBe(
      'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const rowA = listed.value.apps.find((app) => app.id === a.appId);
    const rowB = listed.value.apps.find((app) => app.id === b.appId);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    if (!rowA || !rowB) return;

    expect(rowA.artifact).not.toBe(rowB.artifact);

    expect(rowA.artifact).not.toBe(a.configVersion);
    expect(rowB.artifact).not.toBe(b.configVersion);

    expect(rowA.artifact).toBe(`image · sha256:${'a'.repeat(5)}`);
    expect(rowB.artifact).toBe(`image · sha256:${'b'.repeat(5)}`);
  });

  test('the list `artifact` and the workspace `release` name different things for the same Deploy', async () => {
    const ctx = context();
    const seeded = await seedLiveApp(ctx, {
      prefix: 'sdd-private',
      artifactDigest: `sha256:${'c'.repeat(64)}`,
    });

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.value.apps.find((app) => app.id === seeded.appId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.artifact).toBe(`image · sha256:${'c'.repeat(5)}`);

    const workspace = await getAppWorkspace({ name: seeded.appId }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.release).toBe(`Deploy ${seeded.deployId}`);

    expect(workspace.value.workspace.release).not.toBe(row.artifact);
  });
});
