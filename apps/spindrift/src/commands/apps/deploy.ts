/**
 * `deployApp` — trigger a deploy or kick off a build for an App (§2, §4, §6).
 *
 * If a succeeded Build with a verified artifact exists for the App's primary
 * Component and placement Target, this command creates a Deploy intent.
 * If the latest build failed, has no artifact, or a rebuild is needed, it
 * creates a new PENDING Build and Deploy intent, which the reconciler's
 * `build-loop` and `deploy-loop` pick up and run.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { builds, componentTargetDesired, deploys } from '../../db/schema.ts';
import { createDeploy } from '../deploys/create.ts';
import { type Command, failed, ok } from '../types.ts';

export const deployAppInput = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

export type DeployAppInput = z.infer<typeof deployAppInput>;

export interface DeployAppResult {
  readonly deployId: number;
  readonly buildId: number;
  readonly phase: string;
}

export const deployApp: Command<DeployAppInput, DeployAppResult> = async (
  input,
  context,
) => {
  const isUuid = z.string().uuid().safeParse(input.name).success;
  const app = await context.db.query.apps.findFirst({
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

  if (!app) {
    return failed('NOT_FOUND', `App '${input.name}' not found`);
  }

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

    if (deployAttempt.ok) {
      return ok({
        deployId: deployAttempt.value.deployId,
        buildId: latestBuild.id,
        phase: deployAttempt.value.phase,
      });
    }
  }

  const now = context.clock.now();
  let buildToRun = latestBuild;

  if (
    !buildToRun ||
    buildToRun.status === 'FAILED' ||
    buildToRun.status === 'SUCCEEDED'
  ) {
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

  await context.db
    .insert(componentTargetDesired)
    .values({
      componentId: primaryComponent.id,
      targetId,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const [desired] = await context.db
    .select()
    .from(componentTargetDesired)
    .where(
      and(
        eq(componentTargetDesired.componentId, primaryComponent.id),
        eq(componentTargetDesired.targetId, targetId),
      ),
    );

  const [deploy] = await context.db
    .insert(deploys)
    .values({
      componentId: primaryComponent.id,
      targetId,
      buildId: buildToRun!.id,
      phase: 'PENDING',
      exposure: primaryComponent.exposure,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (desired) {
    await context.db
      .update(componentTargetDesired)
      .set({
        desiredBuildId: buildToRun!.id,
        desiredDeployId: deploy!.id,
        updatedAt: now,
      })
      .where(eq(componentTargetDesired.id, desired.id));
  }

  return ok({
    deployId: deploy!.id,
    buildId: buildToRun!.id,
    phase: 'PENDING',
  });
};
