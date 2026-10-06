import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import { uploadArchive } from '../../src/commands/apps/upload-archive.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { getBuildDetail } from '../../src/commands/builds/get-detail.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
import { getDeployDetail } from '../../src/commands/deploys/get-detail.ts';
import { listDeploys } from '../../src/commands/deploys/list.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  attemptEvents,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { targetLabel } from '../../src/domain/target.ts';
import { defaultVesselName, withIsolatedDatabase } from '../harness/db.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  fixtureVesselKind,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

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
  // Build creation stages a repo Component's first bundle, so deploys need a
  // depot.
  source: () => ({
    stageRepository: async () => ({
      digest: `sha256:${'d'.repeat(64)}`,
      location: `gs://depot.example.test/${'d'.repeat(64)}.tgz`,
      retention: 'ephemeral' as const,
    }),
  }),
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

/** One App, one Component, one placed Target. */
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
        }
      : {
          name,
          sourceKind: 'repo',
          repoUrl: 'https://vcs.example/acme/thing.git',
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

  const adapter = options.adapter ?? 'kubernetes';
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter }))
    .returning();

  await ctx.db.insert(componentTargetDesired).values({
    componentId: component.value.componentId,
    targetId: target!.id,
  });
  await ctx.db
    .update(components)
    .set({ placedTargetId: target!.id })
    .where(eq(components.id, component.value.componentId));

  return {
    appName: name,
    appId: app.value.appId,
    componentId: component.value.componentId,
    target: target!,
    // `targetValues` puts the Target on the harness's shared vessel for its
    // kind.
    label: targetLabel({
      vessel: defaultVesselName(fixtureVesselKind(adapter)),
      adapter,
    }),
  };
}

describe('getBuildDetail command', () => {
  test('projects a Build with no Deploy as an attempt with a null id', async () => {
    // A Deploy press with nothing deployable writes a Build and no Deploy.
    const ctx = context();
    const { componentId, appName, label } = await scaffold(ctx, {
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
    // Before any intent, the desired row names the Target.
    expect(attempt.target).toBe(label);
    expect(attempt.headline).toContain('Building on hosted runner');
    // No intent means nothing was placed and nothing can be rolled back to.
    expect(attempt.resources).toEqual([]);
    expect(attempt.rollbackable).toBe(false);
  });

  test('reports a related Deploy without changing the Build identity', async () => {
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
        desired: aDesiredDocument(),
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
    // `uploadArchive` records finished output with a null runner, since nothing
    // built it.
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
    // `current` comes from the desired row, since a superseded Deploy is still
    // LIVE.
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
          desired: aDesiredDocument(),
          targetId: target.id,
          buildId: build!.id,
          phase: 'LIVE',
          configVersion: `sha256:${'f'.repeat(64)}`,
        })
        .returning();
      written.push({ build: build!, deploy: deploy! });
    }

    // Desire the middle release, as a rollback would.
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
    // Rollback refuses a Build that is not older, so the list offers it only
    // on older releases.
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
          desired: aDesiredDocument(),
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
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
    });
    // Seeding the Deploy directly skips the intent that writes the placement.
    await database()
      .db.update(components)
      .set({ placedTargetId: target!.id })
      .where(eq(components.id, createdComp.value.componentId));

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    expect(workspace.app).toBe(appName);
    // The vessel comes from the placed Target.
    expect(workspace.vessel).toBe(defaultVesselName('cluster'));
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
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
    });
    // Seeding the Deploy directly skips the intent that writes the placement.
    await database()
      .db.update(components)
      .set({ placedTargetId: target!.id })
      .where(eq(components.id, createdComp.value.componentId));

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
      .values(targetValues({ adapter: 'static' }))
      .returning();
    await database().db.insert(componentTargetDesired).values({
      componentId: createdComp.value.componentId,
      targetId: target!.id,
    });
    await database()
      .db.update(components)
      .set({ placedTargetId: target!.id })
      .where(eq(components.id, createdComp.value.componentId));
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
          target: 'static',
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
  test('carries ten checkpoints, which is what a whole sequence needs', async () => {
    // Ten fits a build, deploy and failure sequence. The view renders what it
    // is handed, so this query is the only bound.
    const ctx = context();
    const { appName, appId, componentId } = await scaffold(ctx, {
      prefix: 'decade',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'd101010',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();

    // Twelve, so ten is a bound.
    await ctx.db.insert(attemptEvents).values(
      Array.from({ length: 12 }, () => ({
        appId,
        componentId,
        attemptKind: 'build' as const,
        buildId: build!.id,
        eventType: 'status' as const,
        phase: 'RUNNING',
      })),
    );

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.activity.length).toBe(10);
  });

  test('one build’s step transitions do not evict every other checkpoint', async () => {
    // The Actions poller writes an event per job, step and state; one with a
    // `resource` is a step, which belongs on the Build and Deploy screens.
    const ctx = context();
    const { appName, appId, componentId, target } = await scaffold(ctx, {
      prefix: 'stepstorm',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'f202020',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'e'.repeat(64)}`,
        status: 'SUCCEEDED',
        runner: 'hosted runner',
      })
      .returning();
    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    const attempt = {
      appId,
      componentId,
      attemptKind: 'build' as const,
      buildId: build!.id,
      eventType: 'status' as const,
    };
    await ctx.db.insert(attemptEvents).values([
      { ...attempt, phase: 'SUCCEEDED' },
      ...Array.from({ length: 20 }, (_unused, index) => ({
        ...attempt,
        phase: index % 2 === 0 ? 'RUNNING' : 'SUCCEEDED',
        resource: `build / build / step ${index}`,
      })),
      {
        appId,
        componentId,
        attemptKind: 'deploy' as const,
        deployId: deploy!.id,
        eventType: 'status' as const,
        phase: 'LIVE',
      },
    ]);

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const activity = result.value.workspace.activity;
    expect(activity).toHaveLength(2);
    expect(activity.map((entry) => entry.title)).toEqual([
      `Deploy ${deploy!.id} live`,
      `Build ${build!.id} succeeded`,
    ]);
    // A succeeded Build is `ok`, like a LIVE Deploy.
    expect(activity.every((entry) => entry.status === 'ok')).toBe(true);
    expect(activity.some((entry) => entry.detail.includes('step'))).toBe(false);
  });

  test('carries status checkpoints only, each with an attempt to open', async () => {
    // `attempt_events` ties every row to one attempt, so each entry links
    // somewhere.
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
        desired: aDesiredDocument(),
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
    // Status checkpoints only: log lines belong on the attempt screen each
    // entry links to.
    expect(workspace.activity.length).toBe(4);
    expect(workspace.activity.map((entry) => entry.title)).toEqual([
      `Deploy ${deploy!.id} live`,
      `Deploy ${deploy!.id} applying`,
      `Build ${build!.id} succeeded`,
      `Build ${build!.id} running`,
    ]);
    for (const entry of workspace.activity) {
      expect(entry.deployId ?? entry.buildId).not.toBeNull();
      // The stage says whether a red row is the image or its placement.
      expect(entry.kind).toBe(entry.deployId === null ? 'build' : 'deploy');
      expect(entry.when).not.toBe('recently');
    }
  });

  test('states the first Build while it is still the whole attempt', async () => {
    // A new App has a running Build and no Deploy or checkpoint, so the
    // timeline falls back to the Build itself.
    const ctx = context();
    const { appName, componentId } = await scaffold(ctx, { prefix: 'fresh' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'f00dcaf',
        targetShape: 'image',
        artifactType: 'image',
        status: 'RUNNING',
      })
      .returning();

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    expect(workspace.latestBuildId).toBe(build!.id);
    expect(workspace.activity).toHaveLength(1);
    expect(workspace.activity[0]).toMatchObject({
      kind: 'build',
      title: `Build ${build!.id} running`,
      detail: 'f00dcaf',
      status: 'info',
      deployId: null,
      buildId: build!.id,
    });
  });
  test("a faulty release reads as failed, with the soak's diagnosis", async () => {
    const ctx = context();
    const { appName, componentId, target } = await scaffold(ctx, {
      prefix: 'faulty',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'bad1dea',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
      })
      .returning();
    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        targetId: target.id,
        buildId: build!.id,
        desired: aDesiredDocument(),
        phase: 'LIVE',
        url: 'https://faulty-web.apps.example.test',
        faultyAt: new Date(),
        driftedAt: new Date(),
        reason: 'STARTUP_FAILED',
        blame: 'developer',
        detail: 'crash-looping since readiness',
      })
      .returning();

    const result = await getAppWorkspace({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { workspace } = result.value;
    // `phase` stays the platform's verdict; `faulty` drives the hero.
    expect(workspace).toMatchObject({
      phase: 'LIVE',
      faulty: true,
      urlLive: false,
      url: 'https://faulty-web.apps.example.test',
    });
    expect(workspace.activity[0]).toMatchObject({
      kind: 'deploy',
      title: `Deploy ${deploy!.id} faulty`,
      status: 'failed',
      deployId: deploy!.id,
    });
    expect(workspace.diagnosis?.reason).toBe('STARTUP_FAILED');
    expect(workspace.diagnosis?.blame).toBe('developer');
  });
});

describe('getDeployDetail command', () => {
  test('carries the source, the pinned config, and whether it is current', async () => {
    // A Deploy row is never edited, so its Build, source and pinned config
    // reproduce it on rollback.
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
        desired: aDesiredDocument(),
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
    // A repo App builds, so there is a build to show.
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

    const metalVessel = await insertVessel(ctx.db, 'kubernetes', {
      name: `Metal-${crypto.randomUUID().slice(0, 6)}`,
    });
    const [targetRow] = await ctx.db
      .insert(targets)
      .values({
        adapter: 'kubernetes',
        vesselId: metalVessel.id,
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
        desired: aDesiredDocument(),
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
    expect(deploy.target).toBe(
      targetLabel({ vessel: metalVessel.name, adapter: 'kubernetes' }),
    );
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

    const metalVessel = await insertVessel(ctx.db, 'kubernetes', {
      name: `Metal-${crypto.randomUUID().slice(0, 6)}`,
    });
    const [targetRow] = await ctx.db
      .insert(targets)
      .values({
        adapter: 'kubernetes',
        vesselId: metalVessel.id,
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
        desired: aDesiredDocument(),
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
        desired: aDesiredDocument(),
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
    // With no `log` event, the deploy-log card falls back to the recorded
    // payload.
    expect(deploy.diagnosis?.evidence).toBe('{"exitCode":1}');
    expect(deploy.deployLog).toEqual([
      { text: '{"exitCode":1}', tone: 'error' },
    ]);
  });

  test('a failed deploy that recorded nothing shows nothing', async () => {
    // Core decides an INTERNAL failure without reaching a platform, so `debug`
    // stays null and there is no evidence to show.
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
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
        reason: 'INTERNAL',
        blame: 'platform',
        detail: 'the artifact carries no address to pull it by',
        // `debug` stays unset, as on a real INTERNAL failure.
      })
      .returning();

    // Status rows only, so the deploy log is empty before the fallback runs.
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
    expect(deploy.diagnosis).not.toBeNull();
    expect(deploy.diagnosis?.reason).toBe('INTERNAL');
    expect(deploy.diagnosis?.blame).toBe('platform');
    expect(deploy.diagnosis?.detail).toBe(
      'the artifact carries no address to pull it by',
    );
    expect(deploy.diagnosis?.evidence).toBeNull();

    // `null` makes the deploy-log card render its own notice.
    expect(deploy.deployLog).toBeNull();
  });

  test('blames the deploy, not the build, when the build produced an image', async () => {
    // Supply-chain admission can fail a Build that pushed an image, while the
    // Deploy fails for its own reason.
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
        desired: aDesiredDocument(),
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
    // A Deploy with no reason of its own defers to the Build.
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
        desired: aDesiredDocument(),
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
    // A route reports RUNNING, then a verdict, under one step name. Folding by
    // name gives each step one line and a duration.
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
        desired: aDesiredDocument(),
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

  test('a finished build leaves no checkpoint in progress', async () => {
    // A name folded from log lines alone starts `running` and no log line
    // changes it, so a finished run must resolve it.
    const ctx = context();
    const { componentId, appId, target } = await scaffold(ctx, {
      prefix: 'orphan',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'a420042',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        status: 'SUCCEEDED',
        runner: 'hosted',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    const attempt = {
      appId,
      componentId,
      attemptKind: 'build' as const,
      buildId: build!.id,
    };

    await ctx.db.insert(attemptEvents).values([
      // The one real step, with status events.
      {
        ...attempt,
        resource: 'build / build / Complete job',
        eventType: 'status',
        phase: 'RUNNING',
        createdAt: FROZEN,
      },
      {
        ...attempt,
        resource: 'build / build / Complete job',
        eventType: 'status',
        phase: 'SUCCEEDED',
        createdAt: new Date(FROZEN.getTime() + 2000),
      },
      // Three names that never get a status event. `build / build` is the
      // runner's job, with two path segments where the step above has three.
      {
        ...attempt,
        resource: 'dispatch',
        eventType: 'log',
        line: 'workflow accepted',
        createdAt: FROZEN,
      },
      {
        ...attempt,
        resource: 'build / build',
        eventType: 'log',
        line: 'Cleaning up orphan processes',
        createdAt: new Date(FROZEN.getTime() + 3000),
      },
      {
        ...attempt,
        resource: 'provenance',
        eventType: 'log',
        line: 'attestation written',
        createdAt: new Date(FROZEN.getTime() + 4000),
      },
    ]);

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const steps = result.value.deploy.build?.steps ?? [];
    expect(steps.length).toBe(4);
    expect(steps.filter((step) => step.status === 'running')).toEqual([]);
    // A log-only name keeps its last line as detail.
    expect(steps).toContainEqual({
      name: 'build / build',
      status: 'done',
      detail: 'Cleaning up orphan processes',
    });
    expect(steps).toContainEqual({
      name: 'dispatch',
      status: 'done',
      detail: 'workflow accepted',
    });
  });

  test('a step the runner never closed out takes the run’s verdict, and a log-only name does not', async () => {
    // A step left RUNNING was in flight when the build ended, so it takes the
    // build's verdict. A log-only name was never a step and has none to
    // inherit.
    const ctx = context();
    const { componentId, appId, target } = await scaffold(ctx, {
      prefix: 'killed',
    });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'b430043',
        targetShape: 'image',
        artifactType: 'image',
        status: 'FAILED',
        runner: 'hosted',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'FAILED',
      })
      .returning();

    await ctx.db.insert(attemptEvents).values([
      {
        appId,
        componentId,
        attemptKind: 'build' as const,
        buildId: build!.id,
        resource: 'build / run build',
        eventType: 'status' as const,
        phase: 'RUNNING',
        createdAt: FROZEN,
      },
      {
        appId,
        componentId,
        attemptKind: 'build' as const,
        buildId: build!.id,
        resource: 'dispatch',
        eventType: 'log' as const,
        line: 'workflow accepted',
        createdAt: FROZEN,
      },
    ]);

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.build?.steps).toEqual([
      { name: 'build / run build', status: 'failed' },
      { name: 'dispatch', status: 'done', detail: 'workflow accepted' },
    ]);
  });

  test('names the platform behind the route a build ran on', async () => {
    // A route name is the installation's own word. The platform comes from the
    // manifest's route table, which the browser does not have.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, { prefix: 'platform' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'c440044',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        // The fixture's `cloud-build` route, which a hard-coded
        // `github-actions` would miss.
        runner: 'managed',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.build?.runner).toBe('managed');
    expect(result.value.deploy.build?.runnerAdapter).toBe('cloud-build');
  });

  test('names no platform for a route this installation no longer has', async () => {
    // A retired route's Builds stay readable, with no platform to name.
    const ctx = context();
    const { componentId, target } = await scaffold(ctx, { prefix: 'retired' });

    const [build] = await ctx.db
      .insert(builds)
      .values({
        componentId,
        commit: 'e460046',
        targetShape: 'image',
        artifactType: 'image',
        status: 'SUCCEEDED',
        artifactDigest: `sha256:${'e'.repeat(64)}`,
        runner: 'a-route-that-was-retired',
      })
      .returning();

    const [deploy] = await ctx.db
      .insert(deploys)
      .values({
        componentId,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'LIVE',
      })
      .returning();

    const result = await getDeployDetail({ id: deploy!.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deploy.build?.runnerAdapter).toBeNull();
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
    await ctx.db
      .update(components)
      .set({ placedTargetId: targetRow!.id })
      .where(eq(components.id, createdComp.value.componentId));

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
    expect(result.value.buildId).toBe(buildRow!.id);
    const buildRows = await ctx.db
      .select()
      .from(builds)
      .where(eq(builds.componentId, createdComp.value.componentId));
    expect(buildRows).toHaveLength(1);
  });

  test('surfaces the refusal and writes nothing when the Target is disconnected', async () => {
    // The button goes through `createDeploy`, so a refusal is reported and
    // never answered with a Build.
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
    await ctx.db
      .update(components)
      .set({ placedTargetId: targetRow!.id })
      .where(eq(components.id, createdComp.value.componentId));

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
    expect(result.failure.message).toContain(
      targetLabel({
        vessel: defaultVesselName('cluster'),
        adapter: 'kubernetes',
      }),
    );
    expect(result.failure.message).toContain('disconnected');

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
    // `apps` has no unique constraint on `name`.
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
    await ctx.db
      .update(components)
      .set({ placedTargetId: targetRow!.id })
      .where(eq(components.id, createdComp.value.componentId));

    await ctx.db.insert(builds).values({
      componentId: createdComp.value.componentId,
      commit: 'failed-commit',
      targetShape: 'image',
      artifactType: 'image',
      status: 'FAILED',
      // Durable, so the rerun inherits it: this App has no repository to stage
      // from.
      bundleDigest: `sha256:${'e'.repeat(64)}`,
      bundleLocation: `gs://depot.example.test/${'e'.repeat(64)}.tgz`,
    });

    const result = await deployApp({ name: appName }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // An intent naming a PENDING Build names no artifact and fails
    // `checkDeployable`.
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
