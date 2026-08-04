/**
 * Running a job, and reading what it did (§7, §17).
 *
 * Seam 1: the command layer over a fake deploy backend. What is asserted here
 * is the half the adapter tests cannot see — that a press reaches the far side
 * with the ref core stored, and that the App screen's list of runs is the far
 * side's rather than a shape core made up.
 *
 * The claim worth stating up front, because it is what the placeholder it
 * replaces made easy to get wrong: **the workspace reads runs from the
 * platform**, so the list is the runs that happened, including the ones the
 * schedule started and nothing here asked for.
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
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const NOW = new Date('2026-08-04T12:00:00.000Z');
const clock: Clock = { now: () => NOW };
const supplyChain = new SupplyChainHarness();

function context(deploy: FakeDeployAdapter | null): CommandContext {
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

/**
 * One App with one job Component, placed and deployed.
 *
 * The workload is put on the fake far side too, because that is what a deploy
 * did: a ref on a row with nothing behind it is a Component whose workload has
 * been deleted, and every run verb refuses that on purpose.
 */
async function scaffold(
  ctx: CommandContext,
  backend: FakeDeployAdapter,
  options: { kind?: 'job' | 'service'; ref?: string | null } = {},
) {
  const name = `runs-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: 'https://vcs.example/acme/thing.git',
      vesselRef: 'driftwood',
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const component = await createComponent(
    options.kind === 'service'
      ? {
          appId: app.value.appId,
          name: 'web',
          kind: 'service',
          expose: true,
          reach: 'private',
          auth: 'proxy',
        }
      : {
          appId: app.value.appId,
          name: 'nightly',
          kind: 'job',
          // A job is reached by nobody: nothing routes to it, so §9's grid
          // leaves it the one pair that means "no route at all".
          reach: 'none',
          auth: 'none',
        },
    ctx,
  );
  if (!component.ok) throw new Error(component.failure.message);

  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes' }))
    .returning();
  await ctx.db.insert(componentTargetDesired).values({
    componentId: component.value.componentId,
    targetId: target?.id as string,
  });

  const [placed] = await ctx.db
    .insert(deploys)
    .values({
      componentId: component.value.componentId,
      targetId: target?.id as string,
      buildId: await buildFor(ctx, component.value.componentId),
      phase: 'LIVE',
      ref: options.ref === undefined ? 'fake-deploy-1' : options.ref,
    })
    .returning();

  if (placed?.ref != null) {
    backend.place(placed.ref, {
      ref: placed.ref,
      phase: 'LIVE',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
  }

  return {
    appName: name,
    componentId: component.value.componentId,
    targetId: target?.id as string,
    deployId: placed?.id as number,
  };
}

/** A green Build, because a Deploy row references one. */
async function buildFor(
  ctx: CommandContext,
  componentId: string,
): Promise<number> {
  const { builds } = await import('../../src/db/schema.ts');
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
  return build?.id as number;
}

describe('runComponent', () => {
  test('starts a run against the ref the Deploy stored', async () => {
    const backend = new FakeDeployAdapter();
    backend.ran('fake-deploy-1', {
      name: 'nightly-1',
      outcome: 'passed',
      startedAt: new Date('2026-08-03T00:00:00.000Z'),
    });
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend);

    const started = await runComponent({ componentId, targetId }, ctx);

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.execution.outcome).toBe('running');
    // §6's opaque handle, handed straight back: a run assembled from the rows
    // instead could start a workload the Component is no longer serving.
    expect(backend.runsStarted).toEqual(['fake-deploy-1']);
  });

  test('refuses a Component that is not a job, and never reaches the backend', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend, {
      kind: 'service',
    });

    const refused = await runComponent({ componentId, targetId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RUNNABLE');
    expect(refused.failure.message).toContain('only a job has runs');
    expect(backend.runsStarted).toEqual([]);
  });

  test('refuses a job nothing has placed yet', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend, {
      ref: null,
    });

    const refused = await runComponent({ componentId, targetId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RUNNABLE');
    expect(refused.failure.message).toContain('nothing to run');
  });

  test('a far side that fails is a refusal with its sentence, not a crash', async () => {
    const backend = new FakeDeployAdapter({
      runThrows: 'the API server answered 403',
    });
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend);

    const refused = await runComponent({ componentId, targetId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RUNNABLE');
    expect(refused.failure.message).toBe('the API server answered 403');
  });
});

describe('the App screen lists the runs that happened', () => {
  test('reads them from the platform, newest first, with when and outcome', async () => {
    const backend = new FakeDeployAdapter();
    // A run nothing here started — the schedule's. §17 keeps a job's history on
    // the backend precisely so this one appears without core knowing about it.
    backend.ran('fake-deploy-1', {
      name: 'nightly-scheduled',
      outcome: 'failed',
      startedAt: new Date('2026-08-04T11:00:00.000Z'),
      detail: 'the container exited 1',
    });
    const ctx = context(backend);
    const { appName, componentId, targetId } = await scaffold(ctx, backend);

    const workspace = await getAppWorkspace({ name: appName }, ctx);

    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    const runtime = workspace.value.workspace.runtime;
    expect(runtime.kind).toBe('executions');
    if (runtime.kind !== 'executions') return;
    expect(runtime.executions).toEqual([
      {
        name: 'nightly-scheduled',
        outcome: 'failed',
        detail: 'the container exited 1',
        when: '1h ago',
      },
    ]);
    // The two ids a run is acted on by. Without them the card can offer no
    // button and open no log, which is the state the empty placeholder left.
    expect(runtime.componentId).toBe(componentId);
    expect(runtime.targetId).toBe(targetId);
    expect(runtime.retained).toBe(10);
  });

  test('a run started here is on the list the next time the screen is read', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { appName, componentId, targetId } = await scaffold(ctx, backend);

    const before = await getAppWorkspace({ name: appName }, ctx);
    expect(before.ok).toBe(true);
    if (before.ok && before.value.workspace.runtime.kind === 'executions') {
      expect(before.value.workspace.runtime.executions).toEqual([]);
    }

    await runComponent({ componentId, targetId }, ctx);
    const after = await getAppWorkspace({ name: appName }, ctx);

    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const runtime = after.value.workspace.runtime;
    expect(runtime.kind).toBe('executions');
    if (runtime.kind !== 'executions') return;
    expect(runtime.executions).toHaveLength(1);
    expect(runtime.executions[0]?.outcome).toBe('running');
  });

  test('a backend that will not answer is one empty card, not a failed screen', async () => {
    // The workspace is the screen an operator opens *because* something is
    // wrong. Taking it down over a Target that is momentarily unreachable would
    // hide the phase, the URL and the timeline they came to read.
    const backend = new FakeDeployAdapter({
      noRuns: 'this backend keeps no runs',
    });
    const ctx = context(backend);
    const { appName } = await scaffold(ctx, backend);

    const workspace = await getAppWorkspace({ name: appName }, ctx);

    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.runtime).toEqual({
      kind: 'none',
      because: 'this backend keeps no runs',
    });
  });

  test('a read that failed still says the job can be run', async () => {
    // The state this feature's first day is in: the Role granting `list` on
    // batch jobs has not reconciled on the cluster yet, so the read `403`s
    // while starting a run would have worked. Collapsing that to `kind: 'none'`
    // takes the ids off the runtime, and the screen renders no Run now button —
    // the feature hiding itself in exactly the state where pressing it is the
    // diagnosis. Whether a job is runnable is a fact about the Deploy that
    // placed it, not about whether listing worked.
    const backend = new FakeDeployAdapter({
      executionsThrows: 'jobs.batch is forbidden: User cannot list jobs',
    });
    const ctx = context(backend);
    const { appName } = await scaffold(ctx, backend);

    const workspace = await getAppWorkspace({ name: appName }, ctx);

    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    const runtime = workspace.value.workspace.runtime;
    expect(runtime.kind).toBe('executions');
    if (runtime.kind !== 'executions') return;
    expect(runtime.executions).toHaveLength(0);
    expect(runtime.componentId).toBeDefined();
    expect(runtime.targetId).toBeDefined();
    expect(runtime.because).toContain('is forbidden');
  });
});
