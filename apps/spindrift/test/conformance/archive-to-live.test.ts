/**
 * Upload, build, deploy and observe on a clean database, asserting the rows
 * each step writes. Only the cloud, the builder and the cluster are fakes.
 */

import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { asc, eq } from 'drizzle-orm';
import { deployApp } from '../../src/commands/apps/deploy.ts';
import {
  completeCreationDraft,
  getCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from '../../src/commands/creation-drafts/lifecycle.ts';
import type {
  AdapterRegistry,
  CommandContext,
  Principal,
} from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  componentTargetDesired,
  deploys,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import {
  type DeployLoopContext,
  observeConverged,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { handleUpload } from '../../src/web/upload.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const baseManifest = await fixtureManifest();

const FROZEN = new Date('2026-08-03T12:00:00.000Z');

/** Gzip bytes are enough: the upload boundary never opens the tar. */
const ARCHIVE = new Uint8Array(
  gzipSync(new TextEncoder().encode('a tarball, as far as the boundary reads')),
);

/**
 * STS answers `access_token` and `generateAccessToken` answers `accessToken`.
 * Answering both keys everywhere would hide a wrong pairing.
 */
function fakeCloud(): {
  fetch: (request: Request) => Promise<Response>;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    async fetch(request: Request): Promise<Response> {
      if (request.url.includes(':signBlob')) {
        return Response.json({ signedBlob: btoa('\x01\x02') });
      }
      if (request.url.includes(':generateAccessToken')) {
        return Response.json({
          accessToken: 'impersonated',
          expireTime: '2026-08-03T13:00:00.000Z',
        });
      }
      if (request.url.includes('/upload/storage/v1/b/')) {
        writes.push(request.url);
        return Response.json({ name: 'stored' });
      }
      return Response.json({ access_token: 'federated', expires_in: 3600 });
    },
  };
}

async function installation(options: { sourceCommit?: string } = {}) {
  const db = database().db;
  const cloud = fakeCloud();

  const [operator] = await db
    .insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const principal: Principal = {
    id: operator!.id,
    displayName: operator!.displayName,
  };

  // Capable and healthy, so no placement exclusion rule applies.
  const offsiteVessel = await insertVessel(db, 'kubernetes', {
    name: 'offsite',
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        vesselId: offsiteVessel.id,
        rank: 0,
        reaches: ['none', 'private', 'public'],
        discovery: CAPABLE_DISCOVERY,
      }),
    )
    .returning();

  const [repository] =
    options.sourceCommit === undefined
      ? []
      : await db
          .insert(repositories)
          .values({
            fullName: 'example/app',
            installationId: '1',
            defaultBranch: 'main',
            authoritativeCommit: options.sourceCommit,
            access: 'active',
          })
          .returning();

  const builder = new FakeBuildAdapter({ name: 'hosted' });
  const cluster = new FakeDeployAdapter({ adapter: 'kubernetes' });
  const supplyChain = new SupplyChainHarness();

  const adapters: AdapterRegistry = {
    deploy: (adapter) => (adapter === cluster.adapter ? cluster : null),
    build: (route) => (route === builder.name ? builder : null),
    store: () => null,
    repository: () => null,
    source: () => ({
      // The same depot and address shape as an upload, so dispatch signs both
      // the same way.
      async stageRepository(input) {
        return {
          digest: `sha256:${'b'.repeat(64)}`,
          location: `gs://example-source-bucket/${input.commit}.tgz`,
          retention: 'ephemeral' as const,
        };
      },
    }),
    supplyChain: () => supplyChain,
  };

  const manifest = {
    ...baseManifest,
    cloud: {
      ...baseManifest.cloud,
      federation: {
        audience: '//iam.googleapis.com/projects/1/locations/global/x/y',
        tokenUrl: 'https://sts.googleapis.test/v1/token',
        tokenPath: '/var/run/secrets/spindrift/gcp-token',
        impersonationUrl:
          'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/controller@vessel.iam.gserviceaccount.com:generateAccessToken',
        fetch: cloud.fetch,
        readToken: async () => 'projected-jwt',
      },
    },
  } as CommandContext['manifest'];

  const context: CommandContext = {
    principal,
    clock: { now: () => FROZEN },
    db,
    adapters,
    manifest,
  };

  const loop: DeployLoopContext = {
    db,
    adapters,
    clock: context.clock,
    manifest,
  };

  return {
    context,
    loop,
    cloud,
    builder,
    cluster,
    supplyChain,
    target: target!,
    repository,
  };
}

async function upload(
  context: CommandContext,
  filename: string,
  bytes: Uint8Array,
) {
  const response = await handleUpload(
    new Request('http://spindrift.example.test/internal/upload', {
      method: 'POST',
      headers: { 'x-filename': filename },
      body: bytes as unknown as BodyInit,
    }),
    {
      authenticate: async () => ({
        kind: 'authenticated' as const,
        principal: context.principal,
      }),
      context: () => context,
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      ok: boolean;
      value: { digest: string; location: string; size: number };
    },
  };
}

/** Edits go through `saveCreationDraft` so its guard and revalidation run. */
async function createThroughDraft(
  context: CommandContext,
  edit: (draft: Awaited<ReturnType<typeof startCreationDraft>>) => unknown,
) {
  const started = await startCreationDraft({}, context);
  if (!started.ok) throw new Error(started.failure.message);

  const saved = await saveCreationDraft(
    {
      id: started.value.id,
      revision: started.value.revision,
      draft: edit(started) as never,
    },
    context,
  );
  if (!saved.ok) throw new Error(saved.failure.message);

  const reviewed = await getCreationDraft({ id: saved.value.id }, context);
  if (!reviewed.ok) throw new Error(reviewed.failure.message);
  expect(reviewed.value.blockers).toEqual([]);
  expect(reviewed.value.ready).toBe(true);

  const completed = await completeCreationDraft(
    { id: saved.value.id, revision: saved.value.revision },
    context,
  );
  if (!completed.ok) throw new Error(completed.failure.message);
  if (completed.value.app === null) {
    throw new Error('a ready draft completed without creating an App');
  }
  return completed.value.app;
}

describe('Ticket 10 — an archive reaches a live HTTPS App on a clean database', () => {
  test('upload, build, deploy, and observe, asserting the rows each one wrote', async () => {
    const { context, loop, cloud, builder, cluster, supplyChain, target } =
      await installation();
    const db = context.db;

    const staged = await upload(context, 'bundle.tgz', ARCHIVE);
    expect(staged.status).toBe(200);
    expect(staged.body.ok).toBe(true);

    const bundleDigest = staged.body.value.digest;
    expect(bundleDigest).toBe(
      `sha256:${new Bun.CryptoHasher('sha256').update(ARCHIVE).digest('hex')}`,
    );
    expect(staged.body.value.size).toBe(ARCHIVE.byteLength);
    // An `upload://` handle would mean the pod's own disk.
    expect(staged.body.value.location).toBe(
      `gs://example-source-bucket/${bundleDigest.slice('sha256:'.length)}.tgz`,
    );
    expect(cloud.writes).toHaveLength(1);
    expect(cloud.writes[0]).toContain('/b/example-source-bucket/o');

    const created = await createThroughDraft(context, (started) => {
      if (!started.ok) throw new Error('unreachable');
      // Keeping the suggested Target deploys where placement chose.
      expect(started.value.draft.targetId).toBe(target.id);
      expect(started.value.draft.source).toMatchObject({ repo: '' });
      return {
        ...started.value.draft,
        entry: 'upload',
        appName: 'depot',
        source: {
          kind: 'archive',
          filename: 'bundle.tgz',
          digest: bundleDigest,
          location: staged.body.value.location,
          contents: 'source',
          subpath: '.',
        },
      };
    });
    expect(created.buildStatus).toBe('PENDING');
    expect(created.targetId).toBe(target.id);

    const [appRow] = await db
      .select()
      .from(apps)
      .where(eq(apps.id, created.appId));
    expect(appRow?.sourceKind).toBe('archive');
    expect(appRow?.sourceArchiveDigest).toBe(bundleDigest);

    const [pending] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, created.buildId));
    expect(pending?.status).toBe('PENDING');
    expect(pending?.bundleDigest).toBe(bundleDigest);
    expect(pending?.bundleLocation).toBe(staged.body.value.location);
    expect(pending?.artifactDigest).toBeNull();

    expect(await runBuildPass(context)).toBe(1);

    // The runner cannot fetch a `gs://` address, so dispatch hands it a signed
    // HTTPS URL.
    expect(builder.built).toHaveLength(1);
    expect(builder.built[0]?.source.bundleDigest).toBe(bundleDigest);
    expect(builder.built[0]?.source.origin.type).toBe('archive');
    expect(
      builder.built[0]?.source.origin.location.startsWith(
        'https://storage.googleapis.com/',
      ),
    ).toBe(true);

    const [built] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, created.buildId));
    expect(built?.status).toBe('SUCCEEDED');
    expect(built?.runner).toBe('hosted');
    expect(built?.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built?.artifactRefs?.length).toBeGreaterThan(0);
    const artifactDigest = built?.artifactDigest ?? '';
    expect(built?.verifiedBuildLevel).toBe(2);
    expect(built?.signature?.artifactDigest).toBe(artifactDigest);
    expect(supplyChain.signed).toHaveLength(1);

    const deployed = await deployApp({ name: created.appId }, context);
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) return;
    // The Build has an artifact, so deploying must not start a second Build.
    expect(deployed.value.phase).toBe('PENDING');
    expect(deployed.value.buildId).toBe(created.buildId);
    expect(deployed.value.deployId).not.toBeNull();
    // Admission re-verifies the recorded signature before writing the intent.
    expect(supplyChain.signatureChecks.admissions).toHaveLength(1);
    expect(supplyChain.signatureChecks.admissions[0]?.artifactDigest).toBe(
      artifactDigest,
    );

    const [intent] = await db
      .select()
      .from(deploys)
      .where(eq(deploys.id, deployed.value.deployId!));
    expect(intent?.phase).toBe('PENDING');
    expect(builder.built).toHaveLength(1);

    const pass = await runDeployPass(loop);
    expect(pass.applied).toEqual([
      {
        deployId: deployed.value.deployId!,
        phase: 'LIVE',
        // Core mints the canonical name for a cluster Target.
        url: 'https://depot-web.apps.example.test',
      },
    ]);
    // The loop slows its cadence when nothing is unsettled.
    expect(pass.unsettled).toEqual([]);

    const [live] = await db
      .select()
      .from(deploys)
      .where(eq(deploys.id, deployed.value.deployId!));
    expect(live?.phase).toBe('LIVE');
    expect(live?.url).toBe('https://depot-web.apps.example.test');
    expect(live?.buildId).toBe(created.buildId);
    expect(live?.targetId).toBe(target.id);
    expect(live?.observedDigest).toBe(artifactDigest);
    expect(live?.reason).toBeNull();
    expect(live?.driftedAt).toBeNull();

    // A later deploy check-and-sets against this row.
    const [desired] = await db
      .select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, created.componentId));
    expect(desired?.targetId).toBe(target.id);
    expect(desired?.desiredBuildId).toBe(created.buildId);

    expect(cluster.applied).toHaveLength(1);
    expect(cluster.applied[0]?.desired.artifact.digest).toBe(artifactDigest);
    expect(cluster.applied[0]?.desired.hostname.canonical).toBe(
      'depot-web.apps.example.test',
    );

    const reports = await observeConverged(loop);
    expect(reports).toEqual([
      {
        deployId: deployed.value.deployId!,
        drifted: false,
        observedDigest: artifactDigest,
        driftDetail: null,
      },
    ]);
    // Observing reports drift and never places anything.
    expect(cluster.applied).toHaveLength(1);

    // One attempt-scoped log carries both the build and the deploy events.
    const events = await db
      .select()
      .from(attemptEvents)
      .orderBy(asc(attemptEvents.id));
    expect(events.some((event) => event.buildId === created.buildId)).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.deployId === deployed.value.deployId &&
          event.eventType === 'status' &&
          event.phase === 'LIVE',
      ),
    ).toBe(true);
  });

  test('a repository source walks the identical pipeline to the identical rows', async () => {
    const commit = 'c'.repeat(40);
    const { context, loop, builder, cluster, target } = await installation({
      sourceCommit: commit,
    });
    const db = context.db;

    const created = await createThroughDraft(context, (started) => {
      if (!started.ok) throw new Error('unreachable');
      expect(started.value.draft.source).toMatchObject({ repo: '' });
      return {
        ...started.value.draft,
        appName: 'linked',
        source: {
          kind: 'repo',
          repo: 'example/app',
          url: 'https://git.example.test/example/app.git',
          subpath: '.',
        },
      };
    });

    expect(await runBuildPass(context)).toBe(1);
    expect(builder.built[0]?.source.origin.type).toBe('repo');
    expect(builder.built[0]?.source.bundleDigest).toBe(
      `sha256:${'b'.repeat(64)}`,
    );

    const [built] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, created.buildId));
    expect(built?.status).toBe('SUCCEEDED');
    expect(built?.commit).toBe(commit);
    expect(built?.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const artifactDigest = built?.artifactDigest ?? '';
    expect(built?.signature?.artifactDigest).toBe(artifactDigest);

    const deployed = await deployApp({ name: created.appId }, context);
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) return;

    await runDeployPass(loop);
    const [live] = await db
      .select()
      .from(deploys)
      .where(eq(deploys.id, deployed.value.deployId!));
    expect(live?.phase).toBe('LIVE');
    expect(live?.url).toBe('https://linked-web.apps.example.test');
    expect(live?.observedDigest).toBe(artifactDigest);
    expect(cluster.applied).toHaveLength(1);

    const [component] = await db
      .select()
      .from(components)
      .where(eq(components.id, created.componentId));
    expect(component?.appId).toBe(created.appId);
    expect(created.targetId).toBe(target.id);
  });
});
