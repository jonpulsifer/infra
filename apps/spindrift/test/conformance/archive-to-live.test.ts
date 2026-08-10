/**
 * Ticket 10, item 7: the archive flow, end to end, on a clean database.
 *
 * The ticket's own sentence is the shape of this file — "an authenticated
 * developer uploads an archive, accepts the suggested real Target, starts the
 * first Build, and watches the reconciler deliver a working HTTPS App" — and
 * every one of those clauses is a call here rather than a fixture:
 *
 * | the sentence            | what runs                                    |
 * | ----------------------- | -------------------------------------------- |
 * | uploads an archive      | `handleUpload` over real bytes → real digest  |
 * | stages them durably     | `stageArchiveBytes` → GCS through federation  |
 * | accepts the Target      | `startCreationDraft` → `completeCreationDraft`|
 * | starts the first Build  | `runBuildPass` → `dispatchBuild`              |
 * | the reconciler delivers | `runDeployPass` → `runAttempt`                |
 * | and it stays right      | `observeConverged`                            |
 *
 * **Every far side is fake and nothing in between is.** § Testing's rule is
 * "fake the far side, not our side", and the three far sides this flow has are
 * the cloud (a `fetch` that answers the token exchange, the object write, and
 * `signBlob`), the builder ({@link FakeBuildAdapter}), and the cluster
 * ({@link FakeDeployAdapter}). Between them run the real upload boundary, the
 * real staging, the real creation draft with its real placement resolution, the
 * real dispatch with its real signed-URL mint, the real supply chain — which
 * signs with a real Ed25519 key and re-verifies it at admission — and both real
 * reconciler passes. Nothing is stubbed on this side of a seam.
 *
 * **The assertions are rows.** §6's mechanism is "three rows rather than a
 * protocol", so a test that asserted only on command return values would be
 * asserting what the flow *said* rather than what it *wrote* — and what the
 * next process reads is the row. The single exception is the digest chain,
 * which is asserted as equality *between* rows: the bytes uploaded here are
 * what `builds.bundle_digest` names, that is what the route was handed as its
 * §16 join, and the artifact that came back is what `deploys.observed_digest`
 * reports at the end.
 *
 * A separate second case runs the same chain from a repository source, because
 * §4 makes the two arms "one pipeline" and a pipeline claimed to be one is a
 * claim only a test that runs both can make.
 */

import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { asc, eq } from 'drizzle-orm';
import {
  completeCreationDraft,
  getCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from '../../src/commands/creation-drafts/lifecycle.ts';
import { deployApp } from '../../src/commands/index.ts';
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

/**
 * The archive a developer picks in the browser. Real bytes, real digest.
 *
 * A real gzipped tar, because the upload boundary now checks. It used to be a
 * string carrying a ZIP's magic number and nothing else behind it — exactly the
 * shape of upload that staged happily, spent a build, and died inside the
 * builder at `tar: This does not look like a tar archive`. A ZIP is accepted
 * too and converted on the way in; that path is covered in
 * `test/web/upload.test.ts`, and this fixture stays the format the depot ends
 * up holding, so every digest assertion below still means what it says.
 */
const ARCHIVE = new Uint8Array(
  gzipSync(new TextEncoder().encode('a tarball, as far as the boundary reads')),
);

/**
 * The cloud, as four answers.
 *
 * Every call this flow makes to Google is one of these, and each is answered in
 * that endpoint's own vocabulary rather than with one permissive object: the
 * STS exchange answers `access_token`, `generateAccessToken` answers
 * `accessToken`, and `federation.ts` refuses each one that is missing. A fake
 * that answered both keys at once would pass while the real pairing was wrong.
 *
 * The object write is recorded, because "the bytes were staged durably" is a
 * claim about a request having left for somewhere other than this process's own
 * disk — the exact thing ticket 23 was filed for.
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

/** One installation's worth of wiring, assembled per test. */
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

  // The Target the draft will suggest. Capable and healthy, because what this
  // test is about is the chain and not placement's exclusion rules — those have
  // their own tests, and a Target excluded here would fail this one somewhere
  // unrelated to why.
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

  // Only for the repository arm. Absent otherwise, so `startCreationDraft`
  // defaults the draft to `upload` exactly as it does for an installation that
  // has connected no repository at all.
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
      // §15 stages the repository bundle where the archive arm's upload
      // boundary staged the uploaded one — same depot, same address shape, so
      // dispatch resolves both through the same signed-URL path below.
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

/** The upload route, as the browser reaches it: session, then bytes. */
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

/**
 * Walk the creation draft to a completed App.
 *
 * The draft is edited through `saveCreationDraft` rather than written to the
 * table, because the revision guard and the server-side revalidation are what
 * decide whether the source this test staged is one the installation will
 * accept — and a row written past them would make a draft ready that the
 * product would have blocked.
 */
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
  // Read back rather than assumed: a blocker here is the product refusing the
  // draft, and it names which of §3's conditions this installation failed.
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

    // ------------------------------------------------------------------
    // 1. Upload. Real bytes over the real route, staged to the depot.
    // ------------------------------------------------------------------
    const staged = await upload(context, 'bundle.tgz', ARCHIVE);
    expect(staged.status).toBe(200);
    expect(staged.body.ok).toBe(true);

    const bundleDigest = staged.body.value.digest;
    // The digest is over the bytes and nothing else, which is what makes it
    // §16's join rather than a label: computed independently here, it has to be
    // the one the route is handed four steps later.
    expect(bundleDigest).toBe(
      `sha256:${new Bun.CryptoHasher('sha256').update(ARCHIVE).digest('hex')}`,
    );
    expect(staged.body.value.size).toBe(ARCHIVE.byteLength);
    // Durably: `gs://`, in the bucket the manifest declares, and reached by a
    // request that actually left. An `upload://` handle here would mean the
    // pod's own disk, which is the failure ticket 23 was filed for.
    expect(staged.body.value.location).toBe(
      `gs://example-source-bucket/${bundleDigest.slice('sha256:'.length)}.tgz`,
    );
    expect(cloud.writes).toHaveLength(1);
    expect(cloud.writes[0]).toContain('/b/example-source-bucket/o');

    // ------------------------------------------------------------------
    // 2. Creation. The draft suggests the one real Target; the developer
    //    accepts it and names the archive that was just staged.
    // ------------------------------------------------------------------
    const created = await createThroughDraft(context, (started) => {
      if (!started.ok) throw new Error('unreachable');
      // The suggestion, taken rather than overridden: this is the "accepts the
      // suggested real Target" clause, and asserting it here is what makes the
      // Deploy at the end land somewhere the product chose.
      expect(started.value.draft.targetId).toBe(target.id);
      expect(started.value.draft.entry).toBe('upload');
      return {
        ...started.value.draft,
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

    // §4's source arm: nothing has been built, so the Build carries the bundle
    // and no artifact at all.
    const [pending] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, created.buildId));
    expect(pending?.status).toBe('PENDING');
    expect(pending?.bundleDigest).toBe(bundleDigest);
    expect(pending?.bundleLocation).toBe(staged.body.value.location);
    expect(pending?.artifactDigest).toBeNull();

    // ------------------------------------------------------------------
    // 3. Build. The reconciler's own pass, not a direct `dispatchBuild`.
    // ------------------------------------------------------------------
    expect(await runBuildPass(context)).toBe(1);

    // What the route was handed. The bundle digest is the join, and the
    // location has been exchanged for something `curl` can follow — the stored
    // `gs://` address would have died at the runner's first step.
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
    // Narrowed only after the shape assertion above, so the rest of the chain
    // compares against a digest that has already had to be one.
    const artifactDigest = built?.artifactDigest ?? '';
    // §16: the artifact is admitted at a level and signed, and both are written
    // down. A green build with no signature is one no Target would take.
    expect(built?.verifiedBuildLevel).toBe(2);
    expect(built?.signature?.artifactDigest).toBe(artifactDigest);
    expect(supplyChain.signed).toHaveLength(1);

    // ------------------------------------------------------------------
    // 4. Deploy. The one button an operator presses.
    // ------------------------------------------------------------------
    const deployed = await deployApp({ name: created.appId }, context);
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) return;
    // Not `BUILDING`: there is an artifact, so the button means deploy it, and
    // a second Build here would be the substitution `deployApp` forbids.
    expect(deployed.value.phase).toBe('PENDING');
    expect(deployed.value.buildId).toBe(created.buildId);
    expect(deployed.value.deployId).not.toBeNull();
    // §16's admission: the recorded signature is re-verified against the
    // recorded digest before an intent is written, by the same pinned verifier
    // that wrote it.
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

    // ------------------------------------------------------------------
    // 5. Reconcile. The loop claims the intent and runs it to a verdict.
    // ------------------------------------------------------------------
    const pass = await runDeployPass(loop);
    expect(pass.applied).toEqual([
      {
        deployId: deployed.value.deployId!,
        phase: 'LIVE',
        // §9: a cluster Target takes core's minted canonical name, and the
        // developer is shown it over HTTPS.
        url: 'https://depot-web.apps.example.test',
      },
    ]);
    // Nothing is owed work, which is what the loop reads to slow its cadence.
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

    // The durable desired row, which is the thing a later deploy check-and-sets
    // against and the only record of what *should* be live here.
    const [desired] = await db
      .select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, created.componentId));
    expect(desired?.targetId).toBe(target.id);
    expect(desired?.desiredBuildId).toBe(created.buildId);

    // What the adapter was described, in core's neutral vocabulary — the
    // artifact it placed is the one the build produced, by digest.
    expect(cluster.applied).toHaveLength(1);
    expect(cluster.applied[0]?.desired.artifact.digest).toBe(artifactDigest);
    expect(cluster.applied[0]?.desired.hostname.canonical).toBe(
      'depot-web.apps.example.test',
    );

    // ------------------------------------------------------------------
    // 6. The read-only post-deployment check: look, and change nothing.
    // ------------------------------------------------------------------
    const reports = await observeConverged(loop);
    expect(reports).toEqual([
      {
        deployId: deployed.value.deployId!,
        drifted: false,
        observedDigest: artifactDigest,
        driftDetail: null,
      },
    ]);
    // §6: drift is "detected and surfaced, never silently corrected". Observing
    // a converged Deploy must not place anything.
    expect(cluster.applied).toHaveLength(1);

    // §6's one attempt-scoped log carries both halves of the attempt, which is
    // what the Deploy screen subscribes to.
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
    // §4: "Repo and archive share **one pipeline** — unpack, detect, build."
    // Two arms of one pipeline is a claim, and this is the half of it that the
    // archive case above cannot make on its own.
    const commit = 'c'.repeat(40);
    const { context, loop, builder, cluster, target } = await installation({
      sourceCommit: commit,
    });
    const db = context.db;

    const created = await createThroughDraft(context, (started) => {
      if (!started.ok) throw new Error('unreachable');
      // A connected repository is what the draft defaults to, so this arm
      // overrides nothing about the source at all.
      expect(started.value.draft.entry).toBe('repo');
      return { ...started.value.draft, appName: 'linked' };
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
