import { describe, expect, test } from 'bun:test';
import {
  BUILD_LEDGER_PAGE,
  listBuilds,
} from '../../src/commands/builds/list.ts';
import { createApp } from '../../src/commands/create-app.ts';
import { RELEASE_PAGE } from '../../src/commands/deploys/list.ts';
import { listAllDeploys } from '../../src/commands/deploys/list-all.ts';
import { createComponent } from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import { builds, deploys, targets } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const NOW = new Date('2026-08-03T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => {
    throw new Error('an operation ledger reached the supply chain');
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

async function appComponent(ctx: CommandContext, name: string) {
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: 'https://github.com/acme/ledger.git',
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
  return { appId: app.value.appId, componentId: component.value.componentId };
}

describe('global operation ledgers', () => {
  test('Build cursor reaches past a full first page', async () => {
    const ctx = context();
    const owner = await appComponent(ctx, 'many-builds');
    await ctx.db.insert(builds).values(
      Array.from({ length: BUILD_LEDGER_PAGE + 1 }, (_, index) => ({
        componentId: owner.componentId,
        commit: `page-build-${index}`,
        targetShape: 'image' as const,
        artifactType: 'image' as const,
        status: 'SUCCEEDED' as const,
      })),
    );

    const first = await listBuilds({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.builds).toHaveLength(BUILD_LEDGER_PAGE);
    expect(first.value.nextBefore).not.toBeNull();

    const second = await listBuilds({ before: first.value.nextBefore! }, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.builds).toHaveLength(1);
    expect(second.value.nextBefore).toBeNull();
    expect(second.value.builds[0]?.id).toBeLessThan(
      first.value.builds.at(-1)!.id,
    );
  });

  test('Builds stay newest-first, bounded, and tied to App identity', async () => {
    const ctx = context();
    const first = await appComponent(ctx, 'same-name');
    const second = await appComponent(ctx, 'same-name');

    for (const [index, owner] of [first, second, first].entries()) {
      await ctx.db.insert(builds).values({
        componentId: owner.componentId,
        commit: `commit-${index}`,
        targetShape: 'image',
        artifactType: 'image',
        status: index === 2 ? 'RUNNING' : 'SUCCEEDED',
        runner: 'Cloud Build',
        createdAt: new Date(`2026-08-03T11:0${index}:00.000Z`),
      });
    }

    const listed = await listBuilds({ limit: 2 }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value.builds).toHaveLength(2);
    expect(listed.value.builds.map((build) => build.commit)).toEqual([
      'commit-2',
      'commit-1',
    ]);
    expect(listed.value.builds.map((build) => build.appId)).toEqual([
      first.appId,
      second.appId,
    ]);
    expect(listed.value.builds[0]).toMatchObject({
      app: 'same-name',
      component: 'web',
      status: 'RUNNING',
      when: '58m ago',
      deployId: null,
    });
  });

  test('Deploys stay separate from Builds and carry their owning App', async () => {
    const ctx = context();
    const first = await appComponent(ctx, 'alpha');
    const second = await appComponent(ctx, 'bravo');
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ name: 'Folly' }))
      .returning();

    const written: number[] = [];
    for (const [index, owner] of [first, second].entries()) {
      const [build] = await ctx.db
        .insert(builds)
        .values({
          componentId: owner.componentId,
          commit: `deploy-commit-${index}`,
          targetShape: 'image',
          artifactType: 'image',
          artifactDigest: `sha256:${String(index).repeat(64)}`,
          status: 'SUCCEEDED',
          createdAt: new Date(`2026-08-03T11:1${index}:00.000Z`),
        })
        .returning();
      const [deploy] = await ctx.db
        .insert(deploys)
        .values({
          componentId: owner.componentId,
          targetId: target!.id,
          buildId: build!.id,
          phase: index === 0 ? 'LIVE' : 'APPLYING',
          createdAt: new Date(`2026-08-03T11:2${index}:00.000Z`),
        })
        .returning();
      written.push(deploy!.id);
    }

    const listed = await listAllDeploys({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(listed.value.deploys.map((deploy) => deploy.id)).toEqual([
      written[1]!,
      written[0]!,
    ]);
    expect(listed.value.deploys.map((deploy) => deploy.app)).toEqual([
      'bravo',
      'alpha',
    ]);
    expect(listed.value.deploys[0]).toMatchObject({
      appId: second.appId,
      component: 'web',
      target: 'Folly',
      phase: 'APPLYING',
      buildId: expect.any(Number),
    });
  });

  test('Deploy cursor keeps older rollback entries reachable', async () => {
    const ctx = context();
    const owner = await appComponent(ctx, 'many-deploys');
    const [target] = await ctx.db
      .insert(targets)
      .values(targetValues({ name: 'Many' }))
      .returning();
    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId: owner.componentId,
        commit: 'many-deploys-commit',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        status: 'SUCCEEDED',
      })
      .returning();
    await ctx.db.insert(deploys).values(
      Array.from({ length: RELEASE_PAGE + 1 }, () => ({
        componentId: owner.componentId,
        targetId: target!.id,
        buildId: build!.id,
        phase: 'LIVE' as const,
      })),
    );

    const first = await listAllDeploys({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.deploys).toHaveLength(RELEASE_PAGE);
    expect(first.value.nextBefore).not.toBeNull();

    const second = await listAllDeploys(
      { before: first.value.nextBefore! },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.deploys).toHaveLength(1);
    expect(second.value.nextBefore).toBeNull();
  });
});
