// A second Component is created beside its sibling and unplaced. Its first
// Deploy names a Target and starts its own Build.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import {
  createComponent,
  createComponentInput,
} from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
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
  repositories,
  targets,
} from '../../src/db/schema.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const NOW = new Date('2026-08-12T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

const COMMIT = 'c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11';
const BUNDLE_DIGEST = `sha256:${'1'.repeat(64)}`;
const BUNDLE_LOCATION = `gs://depot/${'1'.repeat(64)}.tgz`;
const ARTIFACT_DIGEST = `sha256:${'2'.repeat(64)}`;

/** Stages whatever it is handed. */
const stager: RepositorySourceStager = {
  async stageRepository(): Promise<StagedSourceBundle> {
    return {
      digest: BUNDLE_DIGEST,
      location: BUNDLE_LOCATION,
      retention: 'ephemeral',
    };
  },
};

function context(): CommandContext {
  const adapters: AdapterRegistry = {
    deploy: (adapter) =>
      adapter === 'kubernetes'
        ? new FakeDeployAdapter({ adapter: 'kubernetes' })
        : null,
    build: () => null,
    store: () => null,
    repository: () => null,
    supplyChain: () => new SupplyChainHarness(),
    source: () => stager,
  };
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  } as unknown as CommandContext;
}

/** A repo App with one placed `service`. */
async function appWithOneComponent(ctx: CommandContext) {
  const name = `sibling-${crypto.randomUUID().slice(0, 8)}`;
  const [repository] = await ctx.db
    .insert(repositories)
    .values({
      fullName: `jonpulsifer/${name}`,
      installationId: '4242',
      defaultBranch: 'main',
      authoritativeCommit: COMMIT,
    })
    .returning();
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: `https://github.com/jonpulsifer/${name}.git`,
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);
  // sourceForRerun stages from the connected repository, not from the URL
  // createApp records.
  await ctx.db
    .update(apps)
    .set({ repositoryId: repository!.id })
    .where(eq(apps.id, app.value.appId));

  const web = await createComponent(
    // Parsed through the schema, so unstated `reach`, `auth` and `expose` take
    // the command's defaults.
    createComponentInput.parse({
      appId: app.value.appId,
      name: 'web',
      kind: 'service',
    }),
    ctx,
  );
  if (!web.ok) throw new Error(web.failure.message);

  const vessel = await insertVessel(ctx.db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID().slice(0, 8)}`,
  });
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
    .returning();
  await ctx.db
    .update(components)
    .set({ placedTargetId: target!.id })
    .where(eq(components.id, web.value.componentId));

  return {
    appId: app.value.appId,
    appName: name,
    repositoryId: repository!.id,
    webId: web.value.componentId,
    target: target!,
    vesselName: vessel.name,
  };
}

describe('a Component added to an App that already has one', () => {
  test('lands beside its sibling, scheduled, and placed nowhere', async () => {
    const ctx = context();
    const app = await appWithOneComponent(ctx);

    // What the form posts for a scheduled job: no `reach`, `auth` or `expose`.
    const added = await createComponent(
      createComponentInput.parse({
        appId: app.appId,
        name: 'nightly',
        kind: 'job',
        schedule: '0 3 * * *',
      }),
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const rows = await ctx.db
      .select()
      .from(components)
      .where(eq(components.appId, app.appId));
    expect(rows.map((row) => row.name).sort()).toEqual(['nightly', 'web']);

    const nightly = rows.find((row) => row.id === added.value.componentId);
    expect(nightly?.kind).toBe('job');
    expect(nightly?.schedule).toBe('0 3 * * *');
    expect(nightly?.reach).toBe('private');
    expect(nightly?.auth).toBe('proxy');
    // A job does not serve, so it has no `expose`.
    expect(nightly?.expose).toBeNull();
    // Only the first Deploy writes the placement.
    expect(nightly?.placedTargetId).toBeNull();

    const web = rows.find((row) => row.id === app.webId);
    expect(web?.kind).toBe('service');
    expect(web?.placedTargetId).toBe(app.target.id);
  });

  test('states its own entrypoint, because the sibling it joins shares its image', async () => {
    const ctx = context();
    const app = await appWithOneComponent(ctx);

    // The Component builds its sibling's tree, so its entrypoint sets it apart.
    // Set at creation, it is never a duplicate row.
    const added = await createComponent(
      createComponentInput.parse({
        appId: app.appId,
        name: 'nightly',
        kind: 'job',
        command: ['node', 'job.js'],
      }),
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const rows = await ctx.db
      .select()
      .from(components)
      .where(eq(components.appId, app.appId));

    const nightly = rows.find((row) => row.id === added.value.componentId);
    expect(nightly?.command).toEqual(['node', 'job.js']);
    // Null means the image's own. At creation `command` and `args` are
    // independent; the edit takes both or neither.
    expect(nightly?.args).toBeNull();

    // An entrypoint on one Component is not one on the App.
    expect(rows.find((row) => row.id === app.webId)?.command).toBeNull();
  });

  test('its first Deploy names a Target, builds its own artifact, and places it', async () => {
    const ctx = context();
    const app = await appWithOneComponent(ctx);
    const added = await createComponent(
      createComponentInput.parse({
        appId: app.appId,
        name: 'nightly',
        kind: 'job',
      }),
      ctx,
    );
    if (!added.ok) throw new Error(added.failure.message);

    // The Target spelled as a Component's row states it, which deployApp
    // resolves.
    const pressed = await deployApp(
      {
        name: app.appId,
        component: added.value.componentId,
        target: `${app.vesselName}/kubernetes`,
      },
      ctx,
    );
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    // A Component with no artifact yet starts a Build and deploys nothing.
    expect(pressed.value.phase).toBe('BUILDING');
    expect(pressed.value.deployId).toBeNull();

    const [started] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, pressed.value.buildId));
    // Its own row, staged from the App's source.
    expect(started?.componentId).toBe(added.value.componentId);
    expect(started?.bundleLocation).toBe(BUNDLE_LOCATION);
    expect(started?.status).toBe('PENDING');

    // A press on one Component builds that Component only.
    const siblingBuilds = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, app.webId));
    expect(siblingBuilds).toHaveLength(0);

    // The first Deploy writes the placement and this Component's desired row.
    const [placed] = await ctx.db
      .select()
      .from(components)
      .where(eq(components.id, added.value.componentId));
    expect(placed?.placedTargetId).toBe(app.target.id);
    const [desired] = await ctx.db
      .select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, added.value.componentId));
    expect(desired?.targetId).toBe(app.target.id);

    // Once the Build succeeds, the next press reads the placement back and
    // names no Target.
    await ctx.db
      .update(builds)
      .set({
        status: 'SUCCEEDED',
        artifactDigest: ARTIFACT_DIGEST,
        verifiedBuildLevel: 2,
        signature: testSignature(ARTIFACT_DIGEST, NOW.toISOString()),
      })
      .where(eq(builds.id, pressed.value.buildId));

    const released = await deployApp(
      { name: app.appId, component: added.value.componentId },
      ctx,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.phase).toBe('PENDING');
    expect(released.value.buildId).toBe(pressed.value.buildId);

    const [deploy] = await ctx.db
      .select()
      .from(deploys)
      .where(eq(deploys.id, released.value.deployId!));
    expect(deploy?.componentId).toBe(added.value.componentId);
    expect(deploy?.buildId).toBe(pressed.value.buildId);
  });
});
