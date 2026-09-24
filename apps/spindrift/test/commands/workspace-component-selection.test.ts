/**
 * The App workspace on an App whose second Component is a job. A named
 * Component selects the runtime, placement, config keys and Deploy target.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { runComponent } from '../../src/commands/components/run.ts';
import { createApp } from '../../src/commands/create-app.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  builds,
  components,
  componentTargetDesired,
  configItems,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { defaultVesselName, withIsolatedDatabase } from '../harness/db.ts';
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
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const NOW = new Date('2026-08-06T12:00:00.000Z');
const clock: Clock = { now: () => NOW };
const supplyChain = new SupplyChainHarness();

function context(deploy: FakeDeployAdapter): CommandContext {
  const adapters: AdapterRegistry = {
    deploy: () => deploy,
    build: () => null,
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

/** A Component, placed on a Target of its own and deployed there. */
async function placed(
  ctx: CommandContext,
  backend: FakeDeployAdapter,
  componentId: string,
  ref: string,
  vesselId?: string,
): Promise<{ targetId: string; deployId: number }> {
  const [target] = await ctx.db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        ...(vesselId === undefined ? {} : { vesselId }),
      }),
    )
    .returning();
  const targetId = target?.id as string;

  await ctx.db.insert(componentTargetDesired).values({ componentId, targetId });
  await ctx.db
    .update(components)
    .set({ placedTargetId: targetId })
    .where(eq(components.id, componentId));

  const artifactDigest = `sha256:${'a'.repeat(64)}`;
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId,
      commit: 'abc1234',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest,
      status: 'SUCCEEDED',
      runner: 'hosted runner',
      // Provenance and a signature, so the deploy gate admits this Build.
      verifiedBuildLevel: 2,
      signature: testSignature(artifactDigest),
    })
    .returning();

  const [deploy] = await ctx.db
    .insert(deploys)
    .values({
      componentId,
      desired: aDesiredDocument(),
      targetId,
      buildId: build?.id as number,
      phase: 'LIVE',
      ref,
    })
    .returning();

  // The fake refuses a run against a ref with nothing behind it.
  backend.place(ref, {
    ref,
    phase: 'LIVE',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
  });

  return { targetId, deployId: deploy?.id as number };
}

/**
 * One App, a `service` first and a `job` second, each on its own Target. The
 * job's vessel differs, so the stated placement shows which Component was read.
 */
async function serviceThenJob(ctx: CommandContext, backend: FakeDeployAdapter) {
  const name = `two-${crypto.randomUUID().slice(0, 8)}`;
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

  const nightly = await createComponent(
    {
      appId: app.value.appId,
      name: 'nightly',
      kind: 'job',
      reach: 'none',
      auth: 'none',
    },
    ctx,
  );
  if (!nightly.ok) throw new Error(nightly.failure.message);

  const service = await placed(
    ctx,
    backend,
    web.value.componentId,
    'fake-deploy-web',
  );
  const jobVessel = await insertVessel(ctx.db, 'kubernetes');
  const job = await placed(
    ctx,
    backend,
    nightly.value.componentId,
    'fake-deploy-nightly',
    jobVessel.id,
  );

  await ctx.db.insert(configItems).values([
    {
      componentId: web.value.componentId,
      targetId: service.targetId,
      key: 'PORT',
      storeRef: 'store/port',
      storeVersion: '1',
    },
    {
      componentId: nightly.value.componentId,
      targetId: job.targetId,
      key: 'BUCKET',
      storeRef: 'store/bucket',
      storeVersion: '1',
    },
  ]);

  return {
    appName: name,
    web: { componentId: web.value.componentId, ...service },
    nightly: {
      componentId: nightly.value.componentId,
      ...job,
      vessel: jobVessel.name,
    },
  };
}

/** A backend holding one scheduled run of the job. */
function withARun(): FakeDeployAdapter {
  const backend = new FakeDeployAdapter();
  backend.ran('fake-deploy-nightly', {
    name: 'nightly-scheduled',
    outcome: 'passed',
    startedAt: new Date('2026-08-06T11:00:00.000Z'),
    detail: '1,284 objects copied',
  });
  return backend;
}

describe('an App whose job sits behind its service', () => {
  test('shows the first Component with nothing selected', async () => {
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace({ name: app.appName }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.value.workspace;
    // With no Component named, the screen opens on the first one.
    expect(view.componentId).toBe(app.web.componentId);
    expect(view.runtime.kind).toBe('stream');
    expect(view.configKeys).toEqual(['PORT']);
    expect(view.vessel).toBe(defaultVesselName('cluster'));
  });

  test('shows the job when the job is the Component named', async () => {
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runtime = result.value.workspace.runtime;
    // `executions` renders the run list and the Run now control.
    expect(runtime.kind).toBe('executions');
    if (runtime.kind !== 'executions') return;
    expect(runtime.componentId).toBe(app.nightly.componentId);
    expect(runtime.targetId).toBe(app.nightly.targetId);
    expect(runtime.executions).toEqual([
      {
        name: 'nightly-scheduled',
        outcome: 'passed',
        detail: '1,284 objects copied',
        when: '1h ago',
      },
    ]);
  });

  test('lists every Component whichever one it is showing', async () => {
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.components.map((c) => c.name)).toEqual([
      'web',
      'nightly',
    ]);
    expect(result.value.workspace.app).toBe(app.appName);
  });

  test('scopes the config keys to the Component it is showing', async () => {
    // `Set variable` acts on the pair these keys belong to, so it must be the
    // selected one.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.configKeys).toEqual(['BUCKET']);
    expect(result.value.workspace.componentId).toBe(app.nightly.componentId);
    expect(result.value.workspace.targetId).toBe(app.nightly.targetId);
  });

  test('states the placement of the Component it is showing', async () => {
    // Components are placed, never the App, so the vessel follows the
    // selection.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.vessel).toBe(app.nightly.vessel);
    expect(result.value.workspace.latestDeployId).toBe(app.nightly.deployId);
  });

  test('hands the Run now control ids that start this job', async () => {
    // The Run now card presses with the ids the runtime carries.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runtime = result.value.workspace.runtime;
    if (runtime.kind !== 'executions') throw new Error('no runs to press');
    if (runtime.componentId === undefined || runtime.targetId === undefined) {
      throw new Error('the card would render no button');
    }

    const started = await runComponent(
      { componentId: runtime.componentId, targetId: runtime.targetId },
      ctx,
    );

    expect(started.ok).toBe(true);
    expect(backend.runsStarted).toEqual(['fake-deploy-nightly']);
  });

  test('deploys the Component it is showing, not the App’s first', async () => {
    // `deployApp` takes the App's first Component unless told which, so the
    // screen presses with the id it shows.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const view = await getAppWorkspace(
      { name: app.appName, component: 'nightly' },
      ctx,
    );
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const showing = view.value.workspace.componentId;
    if (showing === undefined) throw new Error('the screen shows no Component');

    const pressed = await deployApp(
      { name: app.appName, component: showing },
      ctx,
    );

    expect(pressed.ok).toBe(true);
    if (!pressed.ok) return;
    expect(pressed.value.deployId).not.toBeNull();
    const [written] = await ctx.db
      .select()
      .from(deploys)
      .where(eq(deploys.id, pressed.value.deployId as number));
    expect(written?.componentId).toBe(app.nightly.componentId);
    expect(written?.targetId).toBe(app.nightly.targetId);
  });

  test('names the same first Component a deploy that names none acts on', async () => {
    // Both commands pick the first Component by `createdAt`, and must agree.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const view = await getAppWorkspace({ name: app.appName }, ctx);
    const pressed = await deployApp({ name: app.appName }, ctx);

    expect(view.ok).toBe(true);
    expect(pressed.ok).toBe(true);
    if (!view.ok || !pressed.ok) return;
    const [written] = await ctx.db
      .select()
      .from(deploys)
      .where(eq(deploys.id, pressed.value.deployId as number));
    expect(view.value.workspace.componentId).toBe(app.web.componentId);
    expect(written?.componentId).toBe(app.web.componentId);
  });

  test('refuses a Component this App does not have', async () => {
    // An unknown name never falls back to the first Component.
    const backend = withARun();
    const ctx = context(backend);
    const app = await serviceThenJob(ctx, backend);

    const result = await getAppWorkspace(
      { name: app.appName, component: 'cloudcron' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('cloudcron');
  });
});
