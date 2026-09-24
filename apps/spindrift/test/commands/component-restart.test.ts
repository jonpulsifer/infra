// A restart bounces the LIVE placement through its stored ref and writes no
// Deploy row, only a checkpoint on the current release.
import { describe, expect, test } from 'bun:test';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { restartComponent } from '../../src/commands/components/restart.ts';
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

const NOW = new Date('2026-08-23T12:00:00.000Z');
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

type Phase = 'PENDING' | 'APPLYING' | 'WAITING' | 'LIVE' | 'FAILED';

// One App with one Component, placed on a fresh Target. The workload is on the
// fake far side too, since the adapter refuses a ref with nothing behind it.
async function scaffold(
  ctx: CommandContext,
  backend: FakeDeployAdapter,
  options: { kind?: 'job' | 'service'; phase?: Phase } = {},
) {
  const pair = await unplaced(ctx, options);
  const placement = await place(ctx, backend, pair.componentId, options);
  return { ...pair, ...placement };
}

/** One App with one Component and nothing placed — no Target, no Deploy. */
async function unplaced(
  ctx: CommandContext,
  options: { kind?: 'job' | 'service' } = {},
) {
  const name = `restart-${crypto.randomUUID().slice(0, 8)}`;
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
    options.kind === 'job'
      ? {
          appId: app.value.appId,
          name: 'nightly',
          kind: 'job',
          reach: 'none',
          auth: 'none',
        }
      : {
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
  return { appName: name, componentId: component.value.componentId };
}

/** One more (Target, Deploy) pair for a Component that already has one. */
async function place(
  ctx: CommandContext,
  backend: FakeDeployAdapter,
  componentId: string,
  options: { phase?: Phase } = {},
) {
  // A Vessel carries one Target per adapter, so each placement gets its own.
  const vessel = await insertVessel(ctx.db, 'kubernetes');
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
    .returning();
  const targetId = target?.id as string;
  await ctx.db.insert(componentTargetDesired).values({ componentId, targetId });

  const ref = `fake-${targetId}`;
  const [placed] = await ctx.db
    .insert(deploys)
    .values({
      componentId,
      desired: aDesiredDocument(),
      targetId,
      buildId: await buildFor(ctx, componentId),
      phase: options.phase ?? 'LIVE',
      ref,
    })
    .returning();
  backend.place(ref, {
    ref,
    phase: 'LIVE',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
  });
  return { targetId, deployId: placed?.id as number, ref };
}

/** A green Build, because a Deploy row references one. */
async function buildFor(
  ctx: CommandContext,
  componentId: string,
): Promise<number> {
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId,
      // One Build per commit and shape, so each placement gets its own commit.
      commit: crypto.randomUUID().slice(0, 7),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      status: 'SUCCEEDED',
      runner: 'hosted runner',
    })
    .returning();
  return build?.id as number;
}

/** Every event on one Deploy's leg of the attempt log, oldest first. */
async function eventsOf(ctx: CommandContext, deployId: number) {
  return ctx.db.query.attemptEvents.findMany({
    where: (events, { eq }) => eq(events.deployId, deployId),
    orderBy: (events, { asc }) => [asc(events.id)],
  });
}

describe('restartComponent', () => {
  test('bounces the LIVE placement through the ref the Deploy stored, and the timeline says so', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { appName, componentId, deployId, ref } = await scaffold(
      ctx,
      backend,
    );

    // No `targetId`: with one placement there is nothing to choose.
    const restarted = await restartComponent({ componentId }, ctx);

    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.value.deployId).toBe(deployId);
    expect(restarted.value.detail).toContain('restart 1 of');
    // The stored ref, handed back as is.
    expect(backend.restarted).toEqual([ref]);

    // No new Deploy: the desired row did not change.
    const rows = await ctx.db.query.deploys.findMany({
      where: (d, { eq }) => eq(d.componentId, componentId),
    });
    expect(rows).toHaveLength(1);

    const events = await eventsOf(ctx, deployId);
    expect(events.map((event) => event.eventType)).toEqual(['log', 'status']);
    expect(events[0]?.line).toContain('restart asked for by Operator');
    expect(events[0]?.line).toContain('restart 1 of');
    expect(events[1]?.phase).toBe('RESTARTED');
    expect(events[1]?.resource).toBeNull();

    const workspace = await getAppWorkspace({ name: appName }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    const [latest] = workspace.value.workspace.activity;
    expect(latest?.title).toBe(`Deploy ${deployId} restarted`);
    expect(latest?.deployId).toBe(deployId);
    expect(latest?.status).toBe('info');
  });

  test('refuses a job, and never reaches the backend', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId } = await scaffold(ctx, backend, {
      kind: 'job',
    });

    const refused = await restartComponent({ componentId, targetId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RESTARTABLE');
    expect(refused.failure.message).toContain('has runs rather than a process');
    expect(backend.restarted).toEqual([]);
  });

  test('refuses a service nothing has placed yet', async () => {
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId } = await unplaced(ctx);

    const refused = await restartComponent({ componentId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RESTARTABLE');
    expect(refused.failure.message).toContain('nothing to restart');
  });

  test('refuses when the newest release on the Target is not LIVE', async () => {
    // A FAILED release needs a deploy, not a restart, and a restart would only
    // race an intent in flight.
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId, targetId, deployId } = await scaffold(ctx, backend, {
      phase: 'FAILED',
    });

    const refused = await restartComponent({ componentId, targetId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RESTARTABLE');
    expect(refused.failure.message).toContain('is FAILED, not LIVE');
    expect(backend.restarted).toEqual([]);
    expect(await eventsOf(ctx, deployId)).toEqual([]);
  });

  test('two placements need a name', async () => {
    // Mid-move a Component serves on two Targets, so a restart must name one.
    const backend = new FakeDeployAdapter();
    const ctx = context(backend);
    const { componentId } = await scaffold(ctx, backend);
    const second = await place(ctx, backend, componentId);

    const unnamed = await restartComponent({ componentId }, ctx);
    expect(unnamed.ok).toBe(false);
    if (unnamed.ok) return;
    expect(unnamed.failure.code).toBe('NOT_RESTARTABLE');
    expect(unnamed.failure.message).toContain('say which one');
    expect(backend.restarted).toEqual([]);

    const named = await restartComponent(
      { componentId, targetId: second.targetId },
      ctx,
    );
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.value.deployId).toBe(second.deployId);
    expect(backend.restarted).toEqual([second.ref]);
  });

  test('a backend with no process refuses in its own words, and writes nothing', async () => {
    const because = 'Static files are served by the Target.';
    const backend = new FakeDeployAdapter({ noRuns: because });
    const ctx = context(backend);
    const { componentId, deployId } = await scaffold(ctx, backend);

    const refused = await restartComponent({ componentId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RESTARTABLE');
    expect(refused.failure.message).toBe(because);
    // A refusal is not a checkpoint.
    expect(await eventsOf(ctx, deployId)).toEqual([]);
  });

  test('a far side that fails is a refusal with its sentence, not a crash', async () => {
    const backend = new FakeDeployAdapter({
      restartThrows: 'the API server answered 409',
    });
    const ctx = context(backend);
    const { componentId, deployId } = await scaffold(ctx, backend);

    const refused = await restartComponent({ componentId }, ctx);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe('NOT_RESTARTABLE');
    expect(refused.failure.message).toBe('the API server answered 409');
    expect(await eventsOf(ctx, deployId)).toEqual([]);
  });
});
