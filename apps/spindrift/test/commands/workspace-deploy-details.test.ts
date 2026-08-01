import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/commands/create-app.ts';
import {
  createComponent,
  deployApp,
  getAppWorkspace,
  getDeployDetail,
} from '../../src/commands/index.ts';
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
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-07-29T10:00:00.000Z');
const frozenClock: Clock = { now: () => FROZEN };

const supplyChainHarness = new SupplyChainHarness();

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => supplyChainHarness,
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
    if (!createdComp.ok) return;
    const [target] = await database()
      .db.insert(targets)
      .values(targetValues({ adapter: 'kubernetes' }))
      .returning();
    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: 'abc123',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
      })
      .returning();
    await database().db.insert(deploys).values({
      componentId: createdComp.value.componentId,
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
    });

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
    if (!createdComp.ok) return;
    const [target] = await database()
      .db.insert(targets)
      .values(targetValues({ adapter: 'static' }))
      .returning();
    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: 'def456',
        targetShape: 'files',
        artifactType: 'files',
        status: 'SUCCEEDED',
      })
      .returning();
    await database().db.insert(deploys).values({
      componentId: createdComp.value.componentId,
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
    });

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    expect(workspace.runtime.kind).toBe('none');
    if (workspace.runtime.kind === 'none') {
      expect(workspace.runtime.because).toContain('Static files are served');
    }
  });

  test('projects the locked Target and first Build before a Deploy exists', async () => {
    const ctx = context();
    const createdApp = await createApp(
      {
        name: `queued-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'archive',
        archiveDigest: `sha256:${'c'.repeat(64)}`,
        vesselRef: 'driftwood',
      },
      ctx,
    );
    if (!createdApp.ok) throw new Error(createdApp.failure.message);
    const createdComp = await createComponent(
      {
        appId: createdApp.value.appId,
        name: 'site',
        kind: 'website',
        exposure: 'public',
      },
      ctx,
    );
    if (!createdComp.ok) throw new Error(createdComp.failure.message);
    const [target] = await database()
      .db.insert(targets)
      .values(targetValues({ adapter: 'static', name: 'cdn' }))
      .returning();
    await database().db.insert(componentTargetDesired).values({
      componentId: createdComp.value.componentId,
      targetId: target!.id,
    });
    await database()
      .db.insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: `sha256:${'c'.repeat(64)}`,
        targetShape: 'files',
        artifactType: 'files',
        artifactDigest: `sha256:${'d'.repeat(64)}`,
        status: 'SUCCEEDED',
      });

    const result = await getAppWorkspace({ name: createdApp.value.appId }, ctx);

    expect(result).toMatchObject({
      ok: true,
      value: {
        workspace: {
          target: 'cdn',
          phase: 'WAITING',
          release: expect.stringMatching(/^Build /),
          components: [
            {
              phase: 'WAITING',
              artifact: expect.stringMatching(/^files · /),
            },
          ],
        },
      },
    });
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

describe('deployApp command', () => {
  test('returns NOT_FOUND for an unknown app name', async () => {
    const ctx = context();
    const result = await deployApp({ name: 'ghost-app' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('creates deploy intent for app with succeeded build', async () => {
    const ctx = context();
    const appName = `trigger-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/trigger.git',
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
      .values(targetValues({ adapter: 'kubernetes' }))
      .returning();

    await ctx.db.insert(componentTargetDesired).values({
      componentId: createdComp.value.componentId,
      targetId: targetRow!.id,
    });

    const [buildRow] = await ctx.db
      .insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: '1234567',
        targetShape: 'kubernetes',
        artifactType: 'image',
        artifactDigest:
          'sha256:1111222233334444555566667777888899990000111122223333444455556666',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: {
          artifactDigest:
            'sha256:1111222233334444555566667777888899990000111122223333444455556666',
          signer: 'gcpkms://test/signer',
          format: 'cosign',
          bundle: {
            mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          },
          signedAt: FROZEN.toISOString(),
        },
      })
      .returning();

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deployId).toBeGreaterThan(0);
    expect(result.value.buildId).toBe(buildRow!.id);
  });

  test('kicks off a new pending build and deploy when build failed', async () => {
    const ctx = context();
    const appName = `rebuild-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/rebuild.git',
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
      .values(targetValues({ adapter: 'kubernetes' }))
      .returning();

    await ctx.db.insert(componentTargetDesired).values({
      componentId: createdComp.value.componentId,
      targetId: targetRow!.id,
    });

    await ctx.db.insert(builds).values({
      componentId: createdComp.value.componentId,
      commit: 'failed-commit',
      targetShape: 'kubernetes',
      artifactType: 'image',
      status: 'FAILED',
    });

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deployId).toBeGreaterThan(0);
    expect(result.value.phase).toBe('PENDING');
  });
});
