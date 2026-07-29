import { describe, expect, test } from 'bun:test';
import {
  createApp,
  createComponent,
  getAppWorkspace,
  getDeployDetail,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import { builds, deploys, targets } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-07-29T10:00:00.000Z');
const frozenClock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('command reached supply chain');
  },
};

function context(clock: Clock = frozenClock): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

describe('getAppWorkspace command', () => {
  test('returns NOT_FOUND for an unknown app name', async () => {
    const ctx = context();
    const result = await getAppWorkspace({ name: 'nonexistent-app' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain('nonexistent-app');
  });

  test('returns projected WorkspaceView for a persisted app', async () => {
    const ctx = context();
    const appName = `beacon-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/beacon.git',
        vesselRef: 'driftwood',
        vanityDomain: 'beacon.example.com',
      },
      ctx,
    );
    expect(createdApp.ok).toBe(true);
    if (!createdApp.ok) return;

    const createdComp = await createComponent(
      {
        appId: createdApp.value.appId,
        name: 'web',
        kind: 'service',
        expose: true,
        exposure: 'private',
      },
      ctx,
    );
    expect(createdComp.ok).toBe(true);

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    expect(workspace.app).toBe(appName);
    expect(workspace.vessel).toBe('driftwood');
    expect(workspace.components.length).toBe(1);
    expect(workspace.components[0]?.name).toBe('web');
    expect(workspace.components[0]?.kind).toBe('service');
    expect(workspace.runtime.kind).toBe('stream');
  });

  test('returns runtime kind "none" for a website component', async () => {
    const ctx = context();
    const appName = `site-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/site.git',
      },
      ctx,
    );
    expect(createdApp.ok).toBe(true);
    if (!createdApp.ok) return;

    const createdComp = await createComponent(
      {
        appId: createdApp.value.appId,
        name: 'site',
        kind: 'website',
        exposure: 'public',
      },
      ctx,
    );
    expect(createdComp.ok).toBe(true);

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    expect(workspace.runtime.kind).toBe('none');
    if (workspace.runtime.kind === 'none') {
      expect(workspace.runtime.because).toContain('Static files are served');
    }
  });
});

describe('getDeployDetail command', () => {
  test('returns NOT_FOUND for an unknown deploy id', async () => {
    const ctx = context();
    const result = await getDeployDetail({ id: 999999 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('returns projected DeployView for a persisted deploy', async () => {
    const ctx = context();
    const appName = `almanac-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/almanac.git',
      },
      ctx,
    );
    expect(createdApp.ok).toBe(true);
    if (!createdApp.ok) return;

    const createdComp = await createComponent(
      {
        appId: createdApp.value.appId,
        name: 'web',
        kind: 'service',
        expose: true,
        exposure: 'private',
      },
      ctx,
    );
    expect(createdComp.ok).toBe(true);
    if (!createdComp.ok) return;

    const [targetRow] = await ctx.db
      .insert(targets)
      .values({
        name: `Metal-${crypto.randomUUID().slice(0, 6)}`,
        adapter: 'kubernetes',
        health: 'healthy',
        rank: 1,
        connection: {
          adapter: 'kubernetes',
          apiServer: 'https://10.0.0.1:6443',
          namespace: 'default',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'flux-system',
            sourceRef: { name: 'app', namespace: 'flux-system' },
          },
        },
      })
      .returning();
    expect(targetRow).toBeDefined();
    if (!targetRow) return;

    const [buildRow] = await ctx.db
      .insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: '7f3d2c1',
        targetShape: 'kubernetes',
        artifactType: 'image',
        artifactDigest: 'sha256:1234567890abcdef',
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();
    expect(buildRow).toBeDefined();
    if (!buildRow) return;

    const [deployRow] = await ctx.db
      .insert(deploys)
      .values({
        componentId: createdComp.value.componentId,
        targetId: targetRow.id,
        buildId: buildRow.id,
        phase: 'LIVE',
        url: `${appName}.example.com`,
      })
      .returning();
    expect(deployRow).toBeDefined();
    if (!deployRow) return;

    const result = await getDeployDetail({ id: deployRow.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deploy } = result.value;
    expect(deploy.app).toBe(appName);
    expect(deploy.component).toBe('web');
    expect(deploy.target).toBe(targetRow.name);
    expect(deploy.commit).toBe('7f3d2c1');
    expect(deploy.phase).toBe('LIVE');
    expect(deploy.urlLive).toBe(true);
    expect(deploy.previousReleaseServing).toBe(false);
  });

  test('returns diagnosis, blame, and previous release state for a failed deploy', async () => {
    const ctx = context();
    const appName = `failing-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/failing.git',
      },
      ctx,
    );
    expect(createdApp.ok).toBe(true);
    if (!createdApp.ok) return;

    const createdComp = await createComponent(
      {
        appId: createdApp.value.appId,
        name: 'web',
        kind: 'service',
        expose: true,
        exposure: 'private',
      },
      ctx,
    );
    expect(createdComp.ok).toBe(true);
    if (!createdComp.ok) return;

    const [targetRow] = await ctx.db
      .insert(targets)
      .values({
        name: `Metal-${crypto.randomUUID().slice(0, 6)}`,
        adapter: 'kubernetes',
        health: 'healthy',
        rank: 1,
        connection: {
          adapter: 'kubernetes',
          apiServer: 'https://10.0.0.1:6443',
          namespace: 'default',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'flux-system',
            sourceRef: { name: 'app', namespace: 'flux-system' },
          },
        },
      })
      .returning();

    const [build1] = await ctx.db
      .insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: '1111111',
        targetShape: 'kubernetes',
        artifactType: 'image',
        status: 'SUCCEEDED',
      })
      .returning();

    const [_deploy1] = await ctx.db
      .insert(deploys)
      .values({
        componentId: createdComp.value.componentId,
        targetId: targetRow!.id,
        buildId: build1!.id,
        phase: 'LIVE',
        url: `${appName}.example.com`,
      })
      .returning();

    const [build2] = await ctx.db
      .insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: '2222222',
        targetShape: 'kubernetes',
        artifactType: 'image',
        status: 'FAILED',
      })
      .returning();

    const [deploy2] = await ctx.db
      .insert(deploys)
      .values({
        componentId: createdComp.value.componentId,
        targetId: targetRow!.id,
        buildId: build2!.id,
        phase: 'FAILED',
        reason: 'BUILD_FAILED',
        blame: 'developer',
        detail:
          "Type error in app/page.tsx line 14 — 'sesion' should be 'session'.",
        debug: { exitCode: 1 },
        url: `${appName}.example.com`,
      })
      .returning();

    const result = await getDeployDetail({ id: deploy2!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deploy } = result.value;
    expect(deploy.phase).toBe('FAILED');
    expect(deploy.previousReleaseServing).toBe(true);
    expect(deploy.diagnosis).not.toBeNull();
    expect(deploy.diagnosis?.reason).toBe('BUILD_FAILED');
    expect(deploy.diagnosis?.blame).toBe('developer');
    expect(deploy.diagnosis?.detail).toContain('Type error');
  });
});
