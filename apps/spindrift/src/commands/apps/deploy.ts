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
 *   build loop to dispatch, and that is the whole act.
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
import { builds, componentTargetDesired } from '../../db/schema.ts';
import { createDeploy } from '../deploys/create.ts';
import { type Command, failed, ok } from '../types.ts';

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
    // `builds_component_commit_shape_unique` makes a rerun of the same commit
    // collide with the attempt it is rerunning, so it becomes a new row keyed by
    // when it was asked for.
    const baseCommit = buildToRun?.commit ?? 'HEAD';
    const commitRef = baseCommit.includes('#')
      ? `${baseCommit.split('#')[0]}#${now.getTime()}`
      : `${baseCommit}#${now.getTime()}`;

    const [newBuild] = await context.db
      .insert(builds)
      .values({
        componentId: primaryComponent.id,
        commit: commitRef,
        targetShape: buildToRun?.targetShape ?? 'image',
        artifactType: buildToRun?.artifactType ?? 'image',
        bundleDigest:
          buildToRun?.bundleDigest ?? app.sourceArchiveDigest ?? null,
        bundleLocation: buildToRun?.bundleLocation ?? null,
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
