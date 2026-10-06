/**
 * Starting a job run, and the App workspace listing runs read from the deploy
 * backend, including runs the schedule started.
 */
import { describe, expect, test } from 'bun:test';
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
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

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
 * One App with one job Component, placed and deployed. The fake backend holds
 * the workload too, since it refuses a run against a ref with nothing behind
 * it.
 */
async function scaffold(
  ctx: CommandContext,
  backend: FakeDeployAdapter,
  options: {
    kind?: 'job' | 'service';
    ref?: string | null;
    /** Variable names the placed release already delivers as config. */
    delivering?: readonly string[];
  } = {},
) {
  const name = `runs-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: 'https://vcs.example/acme/thing.git',
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
          // Nothing routes to a job, so it takes the no-route pair.
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
      desired: aDesiredDocument({
        config: (options.delivering ?? []).map((name) => ({
          name,
          secret: { key: `${name}-item`, version: '1' },
        })),
      }),
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

  test("carries this run's parameters to the backend, and nowhere else", async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend);

    const started = await runComponent(
      {
        componentId,
        targetId,
        env: { SNAPSHOT: 'nightly-2026-08-03', SINCE: '2026-08-01' },
      },
      ctx,
    );

    expect(started.ok).toBe(true);
    expect(backend.runsStartedWith).toEqual([
      { SNAPSHOT: 'nightly-2026-08-03', SINCE: '2026-08-01' },
    ]);
  });

  test('a press without parameters sends none', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend);

    await runComponent({ componentId, targetId, env: {} }, ctx);

    expect(backend.runsStartedWith).toEqual([{}]);
  });

  test('a parameter that is not a variable name is refused in a sentence, and never reaches the backend', async () => {
    // Config keys follow the same rule, since both end up in one environment.
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend);

    const refused = await runComponent(
      { componentId, targetId, env: { 'not a name': 'x', SNAPSHOT: 'y' } },
      ctx,
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('INVALID_INPUT');
    expect(refused.failure.message).toBe(
      'not a name must be an environment variable name',
    );
    expect(backend.runsStarted).toEqual([]);
  });

  test('a parameter that would shadow delivered config is refused, and never reaches the backend', async () => {
    // Config is a sealed reference. An inline override would put the value in
    // a Job spec that anyone who can read Jobs can read.
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend, {
      delivering: ['DATABASE_URL', 'RETENTION_DAYS'],
    });

    const refused = await runComponent(
      {
        componentId,
        targetId,
        env: { DATABASE_URL: 'postgres://elsewhere', SNAPSHOT: 'x' },
      },
      ctx,
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('INVALID_INPUT');
    expect(refused.failure.message).toBe(
      "DATABASE_URL is already delivered to nightly as config; a run's parameters add to that and never override it",
    );
    expect(backend.runsStarted).toEqual([]);
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
    // A run the schedule started, which core never recorded.
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
    // Without these ids the card can offer no Run button and open no log.
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

  test('a run started with parameters says which, and never their values', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { appName, componentId, targetId } = await scaffold(ctx, backend);

    await runComponent(
      {
        componentId,
        targetId,
        env: { SNAPSHOT: 'nightly-2026-08-03', SINCE: '2026-08-01' },
      },
      ctx,
    );
    const workspace = await getAppWorkspace({ name: appName }, ctx);

    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    const runtime = workspace.value.workspace.runtime;
    expect(runtime.kind).toBe('executions');
    if (runtime.kind !== 'executions') return;
    expect(runtime.executions[0]?.detail).toBe('ran with SNAPSHOT, SINCE');
    expect(JSON.stringify(workspace.value)).not.toContain('nightly-2026-08-03');
    expect(JSON.stringify(workspace.value)).not.toContain('2026-08-01');
  });

  test('a backend that will not answer is one empty card, not a failed screen', async () => {
    // The runs card must not take down the phase, URL and timeline beside it.
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
    // A Role without `list` on jobs makes the read 403 while runs still start.
    // The placing Deploy makes it runnable, so the ids keep the Run now button.
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
