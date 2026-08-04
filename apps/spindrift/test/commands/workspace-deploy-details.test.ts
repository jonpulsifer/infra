import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/commands/create-app.ts';
import {
  createComponent,
  deployApp,
  getAppWorkspace,
  getBuildDetail,
  getDeployDetail,
  listDeploys,
  uploadArchive,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  attemptEvents,
  builds,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { defaultVesselId, withIsolatedDatabase } from '../harness/db.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
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

/**
 * One App, one Component, one placed Target — the shape every screen below
 * reads. Written once because none of these tests is about authoring.
 */
async function scaffold(
  ctx: CommandContext,
  options: {
    readonly prefix: string;
    readonly kind?: 'service' | 'website';
    readonly adapter?: 'kubernetes' | 'static';
    readonly sourceKind?: 'repo' | 'archive';
  },
) {
  const name = `${options.prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    options.sourceKind === 'archive'
      ? {
          name,
          sourceKind: 'archive',
          archiveDigest: `sha256:${'e'.repeat(64)}`,
          vesselRef: 'driftwood',
        }
      : {
          name,
          sourceKind: 'repo',
          repoUrl: 'https://vcs.example/acme/thing.git',
          vesselRef: 'driftwood',
        },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const component = await createComponent(
    options.kind === 'website'
      ? {
          appId: app.value.appId,
          name: 'web',
          kind: 'website',
          reach: 'public',
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

  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: options.adapter ?? 'kubernetes' }))
    .returning();

  await ctx.db.insert(componentTargetDesired).values({
    componentId: component.value.componentId,
    targetId: target!.id,
  });

  return {
    appName: name,
    appId: app.value.appId,
    componentId: component.value.componentId,
    target: target!,
  };
}

describe('getBuildDetail command', () => {
  test('projects a Build with no Deploy as an attempt with a null id', async () => {
    // §4: pressing Deploy with nothing deployable "writes a PENDING Build for
    // the build loop to dispatch, and that is the whole act". The press still
    // has to land somewhere, and this is what it lands on.
    const ctx = context();
    const { componentId, target, appName } = await scaffold(ctx, {
      prefix: 'queued',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'aaa1111',
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
        runner: 'hosted runner',
      })
      .returning();

    const result = await getBuildDetail({ id: build!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { attempt, deployId } = result.value;
    expect(attempt.id).toBeNull();
    expect(deployId).toBeNull();
    expect(attempt.buildId).toBe(build!.id);
    expect(attempt.app).toBe(appName);
    // The desired row is what says where a Component belongs before any intent
    // has named a Target.
    expect(attempt.target).toBe(target.name);
    expect(attempt.headline).toContain('Building on hosted runner');
    // No intent means nothing was placed and nothing can be rolled back to.
    expect(attempt.resources).toEqual([]);
    expect(attempt.rollbackable).toBe(false);
  });

  test('reports a related Deploy without changing the Build identity', async () => {
    // Build and Deploy remain independently inspectable after placement.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, { prefix: 'handover' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'bbb2222',
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
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    const result = await getBuildDetail({ id: build!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deployId).toBe(deploy!.id);
  });

  test('an uploaded artifact has a source and no build', async () => {
    // §4: "An archive of *finished output* is a supplied artifact, digested
    // over the uploaded bundle" — recorded, never built. `uploadArchive` writes
    // that row with a null runner because "saying so is more useful than naming
    // a runner that never ran", and the projection has to carry that through.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, {
      prefix: 'extracted',
      kind: 'website',
      adapter: 'static',
      sourceKind: 'archive',
    });

    const digest = `sha256:${'b'.repeat(64)}`;
    const uploaded = await uploadArchive(
      {
        componentId,
        targetId: target.id,
        bundleDigest: digest,
        location: 'gs://bundles.example/site.tar.zst',
        contents: 'artifact',
        subpath: '.',
      },
      ctx,
    );
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) return;
    expect(uploaded.value.status).toBe('SUCCEEDED');

    const result = await getBuildDetail({ id: uploaded.value.buildId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { attempt } = result.value;
    expect(attempt.build).toBeNull();
    expect(attempt.source.kind).toBe('archive');
    if (attempt.source.kind === 'archive') {
      expect(attempt.source.extracted).toBe(true);
      expect(attempt.source.digest).toBe(digest);
      expect(attempt.source.location).toBe('gs://bundles.example/site.tar.zst');
    }
    expect(attempt.headline).toContain('Uploaded output recorded as-is');
  });

  test('returns NOT_FOUND for an unknown build id', async () => {
    const result = await getBuildDetail({ id: 999999 }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

describe('listDeploys command', () => {
  test('lists releases newest first and marks the current one', async () => {
    // §2: "one Build → many Deploys — this is what makes rollback-without-
    // rebuild possible." `current` is the desired row's answer, not the phase's:
    // a LIVE Deploy a newer intent superseded is still LIVE.
    const ctx = context();
    const { appName, componentId, target } = await scaffold(ctx, {
      prefix: 'releases',
    });

    const written = [];
    for (const commit of ['c111', 'c222', 'c333']) {
      const [build] = await ctx.db
        .insert(builds)
        .values({
          componentId,
          commit,
          targetShape: 'image',
          artifactType: 'image',
          artifactDigest: `sha256:${commit.repeat(16)}`,
          status: 'SUCCEEDED',
          runner: 'hosted runner',
        })
        .returning();
      const [deploy] = await ctx.db
        .insert(deploys)
        .values({
          componentId,
          targetId: target.id,
          buildId: build!.id,
          phase: 'LIVE',
          configVersion: `sha256:${'f'.repeat(64)}`,
        })
        .returning();
      written.push({ build: build!, deploy: deploy! });
    }

    // The middle release is what is desired — a rollback, which is exactly the
    // state that makes `current` disagree with `phase` on the newest row.
    const desired = written[1]!;
    await ctx.db
      .update(componentTargetDesired)
      .set({
        desiredBuildId: desired.build.id,
        desiredDeployId: desired.deploy.id,
      })
      .where(eq(componentTargetDesired.componentId, componentId));

    const result = await listDeploys({ app: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deploys: releases } = result.value;
    expect(releases.map((release) => release.id)).toEqual([
      written[2]!.deploy.id,
      written[1]!.deploy.id,
      written[0]!.deploy.id,
    ]);
    expect(releases.filter((release) => release.current)).toHaveLength(1);
    expect(releases.find((release) => release.current)?.id).toBe(
      desired.deploy.id,
    );
    expect(releases[0]?.configVersion).toBeTruthy();
    expect(releases[0]?.commit).toBe('c333');
  });

  test('offers rollback only for a release older than what is desired', async () => {
    // §6 refuses a "rollback" to a Build that is not older — a roll-forward
    // somebody typed the wrong word for. The list makes the same comparison so
    // the affordance appears only where the act would be accepted.
    const ctx = context();
    const { appName, componentId, target } = await scaffold(ctx, {
      prefix: 'rollbackable',
    });

    const written = [];
    for (const commit of ['d111', 'd222']) {
      const [build] = await ctx.db
        .insert(builds)
        .values({
          componentId,
          commit,
          targetShape: 'image',
          artifactType: 'image',
          artifactDigest: `sha256:${commit.repeat(16)}`,
          status: 'SUCCEEDED',
        })
        .returning();
      const [deploy] = await ctx.db
        .insert(deploys)
        .values({
          componentId,
          targetId: target.id,
          buildId: build!.id,
          phase: 'LIVE',
        })
        .returning();
      written.push({ build: build!, deploy: deploy! });
    }

    const newest = written[1]!;
    await ctx.db
      .update(componentTargetDesired)
      .set({
        desiredBuildId: newest.build.id,
        desiredDeployId: newest.deploy.id,
      })
      .where(eq(componentTargetDesired.componentId, componentId));

    const result = await listDeploys({ app: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(
      result.value.deploys.map((release) => [release.id, release]),
    );
    expect(byId.get(newest.deploy.id)?.rollbackable).toBe(false);
    expect(byId.get(written[0]!.deploy.id)?.rollbackable).toBe(true);
  });

  test('returns NOT_FOUND for an unknown app', async () => {
    const result = await listDeploys({ app: 'no-such-app' }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
  });
});

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
        reach: 'private',
        auth: 'proxy',
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
        reach: 'public',
        auth: 'none',
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
        reach: 'public',
        auth: 'none',
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

describe('the workspace as a way into the system', () => {
  test('caps at three checkpoints and gives each one an attempt to open', async () => {
    // `attempt_events` constrains every row to exactly one attempt, so every
    // entry has somewhere to go. An entry that led nowhere would be the one
    // thing on the screen a reader could not act on.
    const ctx = context();
    const { appName, appId, componentId, target } = await scaffold(ctx, {
      prefix: 'navigable',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'e111222',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();
    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    await ctx.db.insert(attemptEvents).values([
      {
        appId,
        componentId,
        attemptKind: 'build',
        buildId: build!.id,
        eventType: 'log',
        line: 'exporting to image',
      },
      {
        appId,
        componentId,
        attemptKind: 'build',
        buildId: build!.id,
        eventType: 'status',
        phase: 'RUNNING',
      },
      {
        appId,
        componentId,
        attemptKind: 'build',
        buildId: build!.id,
        eventType: 'status',
        phase: 'SUCCEEDED',
      },
      {
        appId,
        componentId,
        attemptKind: 'deploy',
        deployId: deploy!.id,
        eventType: 'status',
        phase: 'APPLYING',
      },
      {
        appId,
        componentId,
        attemptKind: 'deploy',
        deployId: deploy!.id,
        eventType: 'status',
        phase: 'LIVE',
      },
    ]);

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    // Three checkpoints, not the log or the fourth status. Every log line an
    // adapter emits lands in the same table, and reading it raw made the
    // timeline the last twenty lines of whatever ran most recently — the
    // transcript belongs on the attempt screen each entry links to, not here.
    expect(workspace.activity.length).toBe(3);
    expect(workspace.activity.map((entry) => entry.title)).toEqual([
      `Deploy ${deploy!.id} live`,
      `Deploy ${deploy!.id} applying`,
      `Build ${build!.id} succeeded`,
    ]);
    for (const entry of workspace.activity) {
      expect(entry.deployId ?? entry.buildId).not.toBeNull();
      // The stage a checkpoint belongs to is on the entry: Build and Deploy are
      // two stages, and a timeline that could not say which one a red row came
      // from cannot say whether the image or its placement is the problem.
      expect(entry.kind).toBe(entry.deployId === null ? 'build' : 'deploy');
      // The clock is frozen at the same instant the rows were written, so the
      // relative time is a real one rather than a "recently" placeholder.
      expect(entry.when).not.toBe('recently');
    }
  });
});

describe('getDeployDetail command', () => {
  test('carries the source, the pinned config, and whether it is current', async () => {
    // A Deploy row is written once and never edited into a different release:
    // its Build, its source, and the config document it pinned (§10) are what
    // it delivered, which is what makes "roll back to this" reproducible.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, { prefix: 'atomic' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'f7a9b2c',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'d'.repeat(64)}`,
        bundleDigest: `sha256:${'9'.repeat(64)}`,
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();
    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
        configVersion: `sha256:${'7'.repeat(64)}`,
      })
      .returning();
    await ctx.db
      .update(componentTargetDesired)
      .set({ desiredBuildId: build!.id, desiredDeployId: deploy!.id })
      .where(eq(componentTargetDesired.componentId, componentId));

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deploy: view } = result.value;
    expect(view.source.kind).toBe('repo');
    if (view.source.kind === 'repo') {
      expect(view.source.commit).toBe('f7a9b2c');
      expect(view.source.repo).toContain('acme/thing');
    }
    // A repo App builds, so there is a build to show — the other half of §4.
    expect(view.build).not.toBeNull();
    expect(view.build?.runner).toBe('hosted runner');
    expect(view.configVersion).toBe(`sha256:${'7'.repeat(64)}`);
    expect(view.artifactDigest).toBe(`sha256:${'d'.repeat(64)}`);
    expect(view.current).toBe(true);
    // Nothing to roll back to: this release is what is desired.
    expect(view.rollbackable).toBe(false);
    expect(view.previousDeployId).toBeNull();
  });

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
        reach: 'private',
        auth: 'proxy',
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
        vesselId: defaultVesselId('cluster'),
        health: 'healthy',
        rank: 1,
        connection: {
          adapter: 'kubernetes',
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
        targetShape: 'image',
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
        reach: 'private',
        auth: 'proxy',
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
        vesselId: defaultVesselId('cluster'),
        health: 'healthy',
        rank: 1,
        connection: {
          adapter: 'kubernetes',
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
        targetShape: 'image',
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
        targetShape: 'image',
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
    // The recorded payload is the evidence, and with no `log` event to show it
    // is what the deploy-log card falls back to. That fallback is the reason
    // the null case below matters: it only reads as evidence when there is any.
    expect(deploy.diagnosis?.evidence).toBe('{"exitCode":1}');
    expect(deploy.deployLog).toEqual([
      { text: '{"exitCode":1}', tone: 'error' },
    ]);
  });

  test('a failed deploy that recorded nothing shows nothing', async () => {
    // The shape every failed Deploy on a real installation has. Core decides an
    // `INTERNAL` failure by itself — it never reaches a platform that could
    // hand back events to persist — so `debug` stays null. `?? {}` turned that
    // absence into `"{}"`, which is truthy, which the deploy-log fallback then
    // adopted as a log line. The result was one red line reading `{}` on every
    // red screen, attributed to a runner that never emitted it.
    const ctx = context();
    const { componentId, appId, target } = await scaffold(ctx, {
      prefix: 'silent',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'ccc3333',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
      })
      .returning();

    const [failed] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
        reason: 'INTERNAL',
        blame: 'platform',
        detail: 'the artifact carries no address to pull it by',
        // `debug` is deliberately unset. Seeding a payload here is what let
        // this reach production.
      })
      .returning();

    // Status rows and nothing else, as the reconciler wrote them: no `log`
    // event exists, so the deploy log is empty before the fallback runs.
    await ctx.db.insert(attemptEvents).values([
      {
        appId,
        componentId,
        attemptKind: 'deploy',
        deployId: failed!.id,
        eventType: 'status',
        phase: 'FAILED',
        reason: 'INTERNAL',
      },
      {
        appId,
        componentId,
        attemptKind: 'deploy',
        deployId: failed!.id,
        eventType: 'status',
        phase: 'FAILED',
        reason: 'INTERNAL',
      },
    ]);

    const result = await getDeployDetail({ id: failed!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { deploy } = result.value;
    // The diagnosis is still made — the reason, the blame and the sentence are
    // all there. It is only the evidence that is absent, and it says so.
    expect(deploy.diagnosis).not.toBeNull();
    expect(deploy.diagnosis?.reason).toBe('INTERNAL');
    expect(deploy.diagnosis?.blame).toBe('platform');
    expect(deploy.diagnosis?.detail).toBe(
      'the artifact carries no address to pull it by',
    );
    expect(deploy.diagnosis?.evidence).toBeNull();

    // And nothing was manufactured from it: `null` is what the deploy-log card
    // reads to render its own LIVE_STATUS notice.
    expect(deploy.deployLog).toBeNull();
  });

  test('blames the deploy, not the build, when the build produced an image', async () => {
    // The pairing supply-chain admission produces: the runner pushed an image
    // and the artifact was refused, so the Build row is FAILED while the Deploy
    // over it went red for a reason of its own. Reading the Build first meant
    // that reason lost, and the screen said "Build failed" about a build that
    // had already done its job.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, {
      prefix: 'misblamed',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'ddd4444',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'d'.repeat(64)}`,
        status: 'FAILED',
        runner: 'hosted runner',
      })
      .returning();

    const [failed] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
        reason: 'ARTIFACT_UNAVAILABLE',
        blame: 'platform',
        detail: "the cluster can't pull the image",
      })
      .returning();

    const result = await getDeployDetail({ id: failed!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.phaseWord).toBe('Deploy failed');
  });

  test('still says Build failed when nothing after the build spoke', async () => {
    // The other side of the same rule. A Deploy that recorded no reason of its
    // own never got an answer from the platform, and the Build row is the only
    // thing that knows anything.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, { prefix: 'redbuild' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'eee5555',
        targetShape: 'image',
        artifactType: 'image',
        status: 'FAILED',
        runner: 'hosted runner',
      })
      .returning();

    const [failed] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
      })
      .returning();

    const result = await getDeployDetail({ id: failed!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.phaseWord).toBe('Build failed');
  });

  test('folds a step’s events into one checkpoint with a duration', async () => {
    // A route reports `RUNNING` and then a verdict for the same step name, with
    // log lines under it in between. Projecting each row as its own checklist
    // line marked everything done because it had been mentioned; folding by
    // name is what makes the list say what each step is *doing*, and gives it
    // the duration a reader scans the column for.
    const ctx = context();
    const { componentId, appId, target } = await scaffold(ctx, {
      prefix: 'folded',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'fff6666',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'f'.repeat(64)}`,
        status: 'FAILED',
        runner: 'hosted runner',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
      })
      .returning();

    const at = (offsetSeconds: number) =>
      new Date(FROZEN.getTime() + offsetSeconds * 1000);
    const step = (phase: string, seconds: number, reason?: 'BUILD_FAILED') => ({
      appId,
      componentId,
      attemptKind: 'build' as const,
      buildId: build!.id,
      eventType: 'status' as const,
      resource: 'build / run build',
      phase,
      ...(reason ? { reason } : {}),
      createdAt: at(seconds),
    });

    await ctx.db
      .insert(attemptEvents)
      .values([step('RUNNING', 0), step('FAILED', 3, 'BUILD_FAILED')]);

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.build?.steps).toEqual([
      { name: 'build / run build', status: 'failed', detail: '3.0s' },
    ]);
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
        reach: 'private',
        auth: 'proxy',
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
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest:
          'sha256:1111222233334444555566667777888899990000111122223333444455556666',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(
          'sha256:1111222233334444555566667777888899990000111122223333444455556666',
          FROZEN.toISOString(),
        ),
      })
      .returning();

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deployId).toBeGreaterThan(0);
    expect(result.value.phase).toBe('PENDING');
    // The existing artifact is what gets deployed. A second Build here would
    // mean the intent path refused and something built instead of saying so.
    expect(result.value.buildId).toBe(buildRow!.id);
    const buildRows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, createdComp.value.componentId));
    expect(buildRows).toHaveLength(1);
  });

  test('surfaces the refusal and writes nothing when the Target is disconnected', async () => {
    // The whole point of the button going through `createDeploy`: a refusal is
    // a sentence the operator has to read, not a cue to build something else.
    const ctx = context();
    const appName = `refused-${crypto.randomUUID().slice(0, 8)}`;
    const createdApp = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/refused.git',
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
        reach: 'private',
        auth: 'proxy',
      },
      ctx,
    );
    expect(createdComp.ok).toBe(true);
    if (!createdComp.ok) return;

    const [targetRow] = await ctx.db
      .insert(targets)
      .values(targetValues({ adapter: 'kubernetes', status: 'disconnected' }))
      .returning();

    await ctx.db.insert(componentTargetDesired).values({
      componentId: createdComp.value.componentId,
      targetId: targetRow!.id,
    });

    const [buildRow] = await ctx.db
      .insert(builds)
      .values({
        componentId: createdComp.value.componentId,
        commit: 'refused-commit',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest:
          'sha256:1111222233334444555566667777888899990000111122223333444455556666',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(
          'sha256:1111222233334444555566667777888899990000111122223333444455556666',
          FROZEN.toISOString(),
        ),
      })
      .returning();

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain(targetRow!.name);
    expect(result.failure.message).toContain('disconnected');

    // Nothing was written behind the refusal: no second Build, no intent.
    const buildRows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, createdComp.value.componentId));
    expect(buildRows).toHaveLength(1);
    expect(buildRows[0]!.id).toBe(buildRow!.id);

    const deployRows = await ctx.db
      .select()
      .from(deploys)
      .where(eq(deploys.componentId, createdComp.value.componentId));
    expect(deployRows).toHaveLength(0);
  });

  test('refuses a name two Apps answer to rather than deploying an arbitrary one', async () => {
    // `apps` has no unique constraint on `name`, so this is a live shape:
    // offsite currently holds two Apps called `infra`.
    const ctx = context();
    const appName = `twinned-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/first.git',
      },
      ctx,
    );
    const second = await createApp(
      {
        name: appName,
        sourceKind: 'repo',
        repoUrl: 'https://github.com/acme/second.git',
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toContain(first.value.appId);
    expect(result.failure.message).toContain(second.value.appId);

    // The id resolves the ambiguity the name cannot.
    const byId = await deployApp({ name: first.value.appId }, ctx);
    expect(byId.ok).toBe(false);
    if (byId.ok) return;
    expect(byId.failure.code).toBe('NOT_FOUND');
    expect(byId.failure.message).toContain('no components');
  });

  test('starts a Build and writes no intent when the last build failed', async () => {
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
        reach: 'private',
        auth: 'proxy',
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
      targetShape: 'image',
      artifactType: 'image',
      status: 'FAILED',
    });

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A Build, and only a Build. An intent naming a PENDING Build would name an
    // artifact that does not exist, and could not pass `checkDeployable`.
    expect(result.value.deployId).toBeNull();
    expect(result.value.phase).toBe('BUILDING');
    expect(result.value.buildId).toBeGreaterThan(0);

    const pending = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.id, result.value.buildId));
    expect(pending[0]!.status).toBe('PENDING');

    const deployRows = await ctx.db
      .select()
      .from(deploys)
      .where(eq(deploys.componentId, createdComp.value.componentId));
    expect(deployRows).toHaveLength(0);
  });
});
