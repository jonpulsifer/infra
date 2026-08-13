/**
 * An App gaining a second Component, from the screen that already lists them
 * (ticket 118, §2).
 *
 * §2's "one App to many Components" had exactly one door — the create flow —
 * so every claim below was reachable only by posting to the command endpoint by
 * hand. The Components card can now do it, and what that press has to be true
 * of is three facts nothing else in this suite states together:
 *
 * - the new Component is a row **beside** the sibling, not a replacement of it,
 *   and its `job` half carries the schedule a `service` cannot;
 * - it is created **unplaced**, because `deployApp` is what writes a placement
 *   (`src/commands/apps/deploy.ts:529-534`) and a form that placed as well
 *   would be a second answer to which Target this Component lives on;
 * - its first Deploy therefore has to be told a Target, which is the one
 *   conditional the screen adds (`src/web/app.tsx`'s `handleDeploy`), and the
 *   Build that press starts is the new Component's own.
 */
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

/** Stages whatever it is handed; the depot itself is not what is under test. */
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

/**
 * A repo App with one placed `service`, which is the state the Components card
 * is looked at in: something is already running, and the second Component is
 * being added beside it.
 */
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
  // `createApp` records the URL; the connection is a separate fact, and
  // `sourceForRerun` stages from the connected repository rather than from the
  // string — so a fixture that skipped this would be testing the refusal.
  await ctx.db
    .update(apps)
    .set({ repositoryId: repository!.id })
    .where(eq(apps.id, app.value.appId));

  const web = await createComponent(
    // Through the schema, the way the dispatcher hands input to a command: the
    // claim under test is that a caller saying nothing about `reach`, `auth` or
    // `expose` gets the command's own defaults, and a call that names them to
    // satisfy the output type could not state it.
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

    // Exactly what the form posts for a scheduled job: no `reach`, no `auth`,
    // and no `expose` — the three the command defaults (`create.ts:64-65`,
    // `:154-163`) rather than the form restating them.
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
    // A job does not serve, so it has no answer to `expose` (§2, §7).
    expect(nightly?.expose).toBeNull();
    // The whole of the "do not place from the form" rule: the first Deploy
    // writes this, and nothing else does.
    expect(nightly?.placedTargetId).toBeNull();

    // The sibling is untouched — added, not replaced.
    const web = rows.find((row) => row.id === app.webId);
    expect(web?.kind).toBe('service');
    expect(web?.placedTargetId).toBe(app.target.id);
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

    // The press the workspace makes for an unplaced Component: the Target
    // spelled the way a Component's row states it, which is what `deployApp`
    // resolves at `src/commands/apps/deploy.ts:352-362`.
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
    // A Component with no artifact yet is the Build-starting act, not the
    // deploy one — §4 keeps those two apart and so does the screen.
    expect(pressed.value.phase).toBe('BUILDING');
    expect(pressed.value.deployId).toBeNull();

    const [started] = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, pressed.value.buildId));
    // Its own row, keyed on its own Component, staged from the App's source.
    expect(started?.componentId).toBe(added.value.componentId);
    expect(started?.bundleLocation).toBe(BUNDLE_LOCATION);
    expect(started?.status).toBe('PENDING');

    // The sibling produced nothing: a press on one Component is one Component's
    // Build, which is the fact a shared `components[0]` used to hide.
    const siblingBuilds = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, app.webId));
    expect(siblingBuilds).toHaveLength(0);

    // First deploy is what writes the placement (`deploy.ts:529-534`), and the
    // desired row it names is this Component's.
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

    // That Build succeeding is what the Component is then released from: the
    // artifact it produced itself, deployed to the placement its first press
    // wrote — no Target named this time, because there is one to read back now.
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
