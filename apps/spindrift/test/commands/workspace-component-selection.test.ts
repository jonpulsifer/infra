/**
 * The App workspace, on an App with more than one Component (§17, §18).
 *
 * Every App that had ever exercised a job surface had exactly one Component,
 * and that is what kept this invisible: the screen read `components[0]` for the
 * runtime, the placement and the config keys while listing every Component, so
 * an App whose job sits behind its service had no surface for that job at all —
 * no run list, no Run now, no config. `runComponent` took the pair happily; the
 * only screen that could call it was bound to a Component that was not a job.
 *
 * So the fixture here is the shape that was never tested: `components[0]` is a
 * `service` and the second Component is a `job`, each placed on a Target of its
 * own, and every claim below is about the second one being reachable by name.
 */
import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/commands/create-app.ts';
import {
  createComponent,
  getAppWorkspace,
  runComponent,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  builds,
  componentTargetDesired,
  configItems,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { defaultVesselName, withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
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

  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId,
      commit: 'abc1234',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      status: 'SUCCEEDED',
      runner: 'hosted runner',
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

  // The workload the Deploy says is there. Every run verb refuses a ref with
  // nothing behind it, which is a different state from this one.
  backend.place(ref, {
    ref,
    phase: 'LIVE',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
  });

  return { targetId, deployId: deploy?.id as number };
}

/**
 * One App, a `service` first and a `job` second, each on its own Target.
 *
 * The job's Target sits on a vessel of its own, because the placement the
 * screen states is per Component: an App is not in a vessel, so a selection
 * that did not move the boundary would be reading the wrong Target's row.
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

/** A run nothing here started — the schedule's, read back off the platform. */
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
    // Unchanged for every caller that names no Component: the service is what
    // an App-first screen opens on, and it is a `stream` rather than a list.
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
    // `{kind: 'executions'}` is what renders the run list and the Run now
    // control, and it was unreachable for this Component at any URL.
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
    // The selection is a selection within one screen, not a screen per
    // Component: an App-first view that could only see the Component it was
    // showing would have nowhere to select the next one from.
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
    // `configKeys` is scoped to the pair a `Set variable` here would act on, so
    // it has to be the *selected* pair: the same list showing the service's
    // keys under the job would be one press away from writing them there.
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
    // An App is not in a vessel — its Components are placed — so the boundary
    // the screen names moves with the selection rather than staying on
    // whichever Component happens to be first.
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
    // The whole point of the surface: `runComponent` always accepted any
    // Component's pair, and until now no screen could hand it a job's. The ids
    // the card presses with are the ones the runtime carries.
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

  test('refuses a Component this App does not have', async () => {
    // A selection that names nothing is not the App's first Component: the
    // screen asked for something specific and there is no such thing.
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
