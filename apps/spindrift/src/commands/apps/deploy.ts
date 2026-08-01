/**
 * `deployApp` — deploy an App's newest artifact, or start the Build it needs
 * (§2, §4, §6).
 *
 * The workspace has one button, so this command decides which of two acts the
 * operator meant. What it may never do is quietly substitute one for the other.
 *
 * - **There is a succeeded Build with an artifact.** The intent goes through
 *   {@link createDeploy}, the one path that takes §6's locking read on the
 *   desired row behind `checkDeployable`'s gates — Target connected, artifact
 *   present, signature re-verified against the recorded digest, verified Build
 *   Level at or above the Target's policy, artifact shape matched, config
 *   migration satisfied. **Its refusal is returned unchanged.** A refusal is a
 *   fact about the world carrying the sentence the operator has to read —
 *   "Build 4 signature did not verify", "that Target is disconnected, so
 *   nothing new can be placed on it" — and rebuilding instead would answer a
 *   question nobody asked while hiding the one that was.
 * - **There is nothing deployable yet** — no Build at all, the last one failed,
 *   or it succeeded without an artifact. A PENDING Build is written for the
 *   build loop to dispatch, and that is the whole act. It is written with a
 *   bundle staged *for it* rather than the previous Build's, which is
 *   {@link sourceForRerun}'s subject and §15's "stage an immutable source
 *   bundle" read as being about a Build rather than about an App.
 *
 * **This command writes no `deploys` row of its own**, on either branch. That
 * is the point rather than an omission: §6's check-and-set is only a
 * correctness argument if every intent is written through the one pair that
 * implements it — `checkDeployable` then `placeIntent` — which is what
 * `createDeploy` composes and what `rollbackDeploy` and `setConfig` call
 * directly, and is why all of them refuse identically. A Build that has not
 * succeeded could not pass `checkDeployable` anyway, so an intent written for
 * one here would name an artifact that does not exist (§4: "a build records an
 * artifact rather than deploying one").
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  type apps,
  builds,
  componentTargetDesired,
  repositories,
} from '../../db/schema.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { createDeploy } from '../deploys/create.ts';
import {
  type Command,
  type CommandContext,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

export const deployAppInput = z
  .object({
    /** The App's id, or its name where that names exactly one App. */
    name: z.string().trim().min(1),
  })
  .strict();

export type DeployAppInput = z.infer<typeof deployAppInput>;

export interface DeployAppResult {
  /**
   * The intent that was written, or `null` when a Build had to start first.
   *
   * `null` is not a failure — it is the difference between "this is going live"
   * and "this is being built", and the screen sends the operator somewhere
   * different for each.
   */
  readonly deployId: number | null;
  /** The Build this act is about: the one being deployed, or the one started. */
  readonly buildId: number;
  /** `PENDING` for a written intent, `BUILDING` when only a Build was started. */
  readonly phase: 'PENDING' | 'BUILDING';
}

/** What a rerun's new Build records about the source it will be built from. */
interface RerunSource {
  /** The commit the Build names, before the rerun suffix is appended. */
  readonly commit: string;
  readonly bundleDigest: string | null;
  readonly bundleLocation: string | null;
}

/**
 * Stage the bundle the new Build will be dispatched from (§15).
 *
 * **A Build inherits a bundle only while that bundle is still fetchable.**
 * Copying the previous Build's `bundleLocation` forward unconditionally would
 * carry an unfetchable handle — an `upload://` from an installation with no
 * depot — into a Build that then dies at `curl` naming a download rather than
 * the staging that never happened.
 *
 * **Why here and not at dispatch.** §15 has Spindrift "fetch the exact commit
 * *once* and stage an immutable source bundle for either builder", and the
 * thing a bundle is staged *for* is a Build. Dispatch runs more than once per
 * Build — a lease expires, a route is retried — so staging there would fetch
 * per attempt rather than per Build, and would let a Build's own identity, the
 * bundle digest §16 joins provenance on, change underneath a run in flight.
 * Creating the Build is the one moment that happens once, which is why
 * `completeCreationDraft` already stages there and why this path is the
 * anomaly rather than the precedent.
 *
 * Re-staging is cheap to repeat: the depot is content-addressed, so the same
 * commit yields the same bytes, the same digest, and the same object.
 *
 * The refusals are refusals rather than a Build written anyway, because a Build
 * with a bundle nothing can fetch is a dispatch, a runner, and a CI log spent
 * to tell the operator something that was knowable before the button was
 * pressed.
 */
async function sourceForRerun(
  app: Pick<
    typeof apps.$inferSelect,
    'name' | 'sourceKind' | 'sourceArchiveDigest' | 'repositoryId'
  >,
  previous: Pick<
    typeof builds.$inferSelect,
    'commit' | 'bundleDigest' | 'bundleLocation'
  > | null,
  context: Pick<CommandContext, 'db' | 'adapters' | 'clock'>,
): Promise<CommandResult<RerunSource>> {
  // `builds_component_commit_shape_unique` makes a rerun collide with the
  // attempt it is rerunning, which is why the rows carry a `#<millis>` suffix.
  // It is a uniqueness device, not part of the commit, so it never travels into
  // staging.
  const baseCommit = (previous?.commit ?? 'HEAD').split('#')[0] || 'HEAD';
  const inheritedDigest =
    previous?.bundleDigest ?? app.sourceArchiveDigest ?? null;
  const inherited = previous?.bundleLocation ?? null;

  if (inherited === null || isFetchableBundleLocation(inherited)) {
    // Either there is a durable bundle to reuse — a `gs://` object is immutable
    // and shared, so the same commit wants the same one — or there was never a
    // bundle here to begin with, which is a Build dispatch already refuses for
    // its own reasons rather than a stale handle to retire.
    return ok({
      commit: baseCommit,
      bundleDigest: inheritedDigest,
      bundleLocation: inherited,
    });
  }

  if (app.sourceKind !== 'repo') {
    // §15: "repo bundles are ephemeral, archives durable." An archive's bytes
    // only ever existed as what a developer uploaded, so there is nothing to
    // fetch again and no honest way to produce this bundle a second time.
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s uploaded archive was staged at ${inherited}, which no build route can fetch, and an archive cannot be staged again from anything Spindrift holds — upload it again to stage it in the depot`,
    );
  }

  const stager = context.adapters.source?.() ?? null;
  if (stager === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was staged at ${inherited}, which no build route can fetch, and this installation configures no source depot to stage a fresh one into`,
    );
  }

  const [repository] =
    app.repositoryId === null
      ? []
      : await context.db
          .select()
          .from(repositories)
          .where(eq(repositories.id, app.repositoryId))
          .limit(1);
  if (repository === undefined) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was staged at ${inherited}, which no build route can fetch, and ${app.name} has no connected repository to stage a fresh one from — connect its repository to make it buildable`,
    );
  }
  if (repository.access !== 'active') {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was staged at ${inherited}, which no build route can fetch, and ${repository.fullName} is ${repository.access}, so no fresh bundle can be staged: ${repository.frozenReason ?? 'access to it was lost'}`,
    );
  }

  // `HEAD` is this command's own placeholder for "no previous Build named a
  // commit", and it is not a commit anyone can be asked to fetch exactly. The
  // repository's authoritative commit is (§15: only a default-branch merge push
  // becomes authoritative).
  const commit =
    baseCommit === 'HEAD' ? repository.authoritativeCommit : baseCommit;
  if (commit === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was staged at ${inherited}, which no build route can fetch, and ${repository.fullName} has no authoritative commit ready to stage a fresh one from`,
    );
  }

  try {
    const staged = await stager.stageRepository({
      ref: repositoryRefOf(repository),
      repository: repository.fullName,
      commit,
      stagedAt: context.clock.now(),
    });
    return ok({
      commit,
      bundleDigest: staged.digest,
      bundleLocation: staged.location,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed(
      'NOT_BUILDABLE',
      `could not stage ${repository.fullName} at ${commit} to replace ${app.name}'s unfetchable bundle: ${detail}`,
    );
  }
}

export const deployApp: Command<DeployAppInput, DeployAppResult> = async (
  input,
  context,
) => {
  // `apps` carries no unique constraint on `name` — `components` has
  // `unique(appId, name)` and `targets` has `unique(name)`, `apps` has neither —
  // so a name is not an identifier and `findFirst` on one silently picks a row.
  // Reading every match instead makes the ambiguity sayable: a name two Apps
  // answer to is refused with both ids rather than acted on, which is §3's
  // listed-and-annotated grammar rather than a coin flip on live infrastructure.
  const isUuid = z.uuid().safeParse(input.name).success;
  const matches = await context.db.query.apps.findMany({
    where: (appsTable, { eq: eqOp, or: orOp }) =>
      isUuid
        ? orOp(eqOp(appsTable.name, input.name), eqOp(appsTable.id, input.name))
        : eqOp(appsTable.name, input.name),
    with: {
      components: {
        with: {
          deploys: {
            orderBy: (deploysTable, { desc }) => [desc(deploysTable.createdAt)],
            limit: 1,
            with: {
              target: true,
              build: true,
            },
          },
          builds: {
            orderBy: (buildsTable, { desc }) => [desc(buildsTable.createdAt)],
            limit: 1,
          },
          desiredTargets: {
            limit: 1,
            with: {
              target: true,
            },
          },
        },
      },
    },
  });

  if (matches.length === 0) {
    return failed('NOT_FOUND', `App '${input.name}' not found`);
  }

  if (matches.length > 1) {
    return failed(
      'INVALID_INPUT',
      `${matches.length} Apps answer to '${input.name}', so this would deploy an arbitrary one — deploy by id: ${matches
        .map((candidate) => candidate.id)
        .join(', ')}`,
      [{ path: 'name', message: 'names more than one App' }],
    );
  }

  const app = matches[0]!;

  const primaryComponent = app.components[0];
  if (!primaryComponent) {
    return failed('NOT_FOUND', `App '${app.name}' has no components to deploy`);
  }

  const latestDeploy = primaryComponent.deploys[0];
  const targetId =
    latestDeploy?.targetId ?? primaryComponent.desiredTargets[0]?.targetId;

  if (!targetId) {
    return failed(
      'NOT_FOUND',
      `Component '${primaryComponent.name}' has no target placement`,
    );
  }

  const latestBuild = primaryComponent.builds[0];

  if (
    latestBuild &&
    latestBuild.status === 'SUCCEEDED' &&
    latestBuild.artifactDigest !== null
  ) {
    const deployAttempt = await createDeploy(
      {
        componentId: primaryComponent.id,
        targetId,
        buildId: latestBuild.id,
      },
      context,
    );

    // The refusal travels out exactly as `createDeploy` wrote it. Anything else
    // here would be a second admission policy, and there is only supposed to be
    // one.
    if (!deployAttempt.ok) return deployAttempt;

    return ok({
      deployId: deployAttempt.value.deployId,
      buildId: latestBuild.id,
      phase: 'PENDING' as const,
    });
  }

  const now = context.clock.now();
  let buildToRun = latestBuild;

  if (
    !buildToRun ||
    buildToRun.status === 'FAILED' ||
    buildToRun.status === 'SUCCEEDED'
  ) {
    // The bundle is staged before the row exists, so what the row records is
    // this Build's own source rather than the last one's. A refusal here is
    // returned unchanged, the same way `createDeploy`'s is: it names the App and
    // what would make it buildable, which is worth more than a Build nothing can
    // dispatch.
    const rerun = await sourceForRerun(app, buildToRun ?? null, context);
    if (!rerun.ok) return rerun;

    // `builds_component_commit_shape_unique` makes a rerun of the same commit
    // collide with the attempt it is rerunning, so it becomes a new row keyed by
    // when it was asked for.
    const commitRef = `${rerun.value.commit}#${now.getTime()}`;

    const [newBuild] = await context.db
      .insert(builds)
      .values({
        componentId: primaryComponent.id,
        commit: commitRef,
        targetShape: buildToRun?.targetShape ?? 'image',
        artifactType: buildToRun?.artifactType ?? 'image',
        bundleDigest: rerun.value.bundleDigest,
        bundleLocation: rerun.value.bundleLocation,
        bundleSubpath: buildToRun?.bundleSubpath ?? '.',
        status: 'PENDING',
        createdAt: now,
      })
      .returning();

    buildToRun = newBuild;
  } else {
    await context.db
      .update(builds)
      .set({
        status: 'PENDING',
        runner: null,
        logFidelity: null,
        dispatchId: null,
        leasedAt: null,
      })
      .where(eq(builds.id, buildToRun.id));
  }

  // The desired row, and nothing on it. `runBuildPass` joins Build → Component →
  // this row → Target to find the route to dispatch on, so a Build with no such
  // row is one no loop can see. `desiredBuildId` and `desiredDeployId` stay
  // untouched: those say what should be *live* here, and only an intent written
  // under §6's lock gets to answer that.
  await context.db
    .insert(componentTargetDesired)
    .values({
      componentId: primaryComponent.id,
      targetId,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return ok({
    deployId: null,
    buildId: buildToRun!.id,
    phase: 'BUILDING' as const,
  });
};
