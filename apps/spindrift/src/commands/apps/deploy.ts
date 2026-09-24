/**
 * `deployApp`: deploys an App's newest artifact through {@link createDeploy},
 * or starts the Build it needs. A refused deploy is returned unchanged and never
 * falls back to a Build. This command writes no `deploys` row itself.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { targetAdapterSchema } from '../../config/manifest.schema.ts';
import {
  type apps,
  builds,
  components,
  componentTargetDesired,
  repositories,
  targets,
  vessels,
} from '../../db/schema.ts';
import { artifactTypeFor, placementTargetOf } from '../../domain/placement.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import type { CommitHeadline } from '../../domain/source-bundle.ts';
import {
  isEphemeralBundleLocation,
  isFetchableBundleLocation,
} from '../../storage/archives.ts';
import { DISPATCH_LEASE_TIMEOUT_MS } from '../builds/dispatch.ts';
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
    /** Build again even when a succeeded artifact exists. */
    rebuild: z.boolean().optional(),
    /**
     * The commit a push adopted. The newest Build must be of it to deploy;
     * otherwise a Build of this commit starts.
     */
    commit: z.string().trim().min(1).optional(),
    /** The Component's name or id; absent means the App's oldest Component. */
    component: z.string().trim().min(1).optional(),
    /**
     * The Target for a first deploy: its id, or `<vessel>/<adapter>`. One that
     * disagrees with the placement is refused; moves go through `placeComponent`.
     */
    target: z.string().trim().min(1).optional(),
  })
  .strict();

export type DeployAppInput = z.infer<typeof deployAppInput>;

/**
 * The HTTP schema omits `commit`, and `.strict()` refuses a request carrying
 * one, so a browser cannot stage and place an arbitrary ref.
 */
export const deployAppRequestInput = deployAppInput.omit({ commit: true });

export interface DeployAppResult {
  /** The written intent, or `null` when only a Build started. */
  readonly deployId: number | null;
  /** The Build being deployed, or the one started. */
  readonly buildId: number;
  /**
   * `UNCHANGED`: the named commit is already desired on this pair and nothing
   * was written. Only a caller that names a commit gets it.
   */
  readonly phase: 'PENDING' | 'BUILDING' | 'UNCHANGED';
}

interface RerunSource {
  /** Without the rerun suffix. */
  readonly commit: string;
  readonly bundleDigest: string | null;
  readonly bundleLocation: string | null;
  readonly headline: CommitHeadline | null;
}

/**
 * Stages the bundle the new Build dispatches from. Staging happens here, once
 * per Build, because dispatch can run several times for one Build. A bundle is
 * reused only while it is fetchable, durable and of the wanted commit.
 */
async function sourceForRerun(
  app: Pick<
    typeof apps.$inferSelect,
    'name' | 'sourceKind' | 'sourceArchiveDigest' | 'repositoryId'
  >,
  componentName: string,
  previous: Pick<
    typeof builds.$inferSelect,
    | 'commit'
    | 'bundleDigest'
    | 'bundleLocation'
    | 'commitMessage'
    | 'commitAuthor'
    | 'commitAuthoredAt'
  > | null,
  /** The commit the Build must be of; `null` asks the repository. */
  requested: string | null,
  context: Pick<CommandContext, 'db' | 'adapters' | 'clock'>,
): Promise<CommandResult<RerunSource>> {
  // The `#<millis>` rerun suffix keeps the Build key unique and is stripped
  // before staging.
  const baseCommit = (previous?.commit ?? 'HEAD').split('#')[0] || 'HEAD';
  const inheritedDigest =
    previous?.bundleDigest ?? app.sourceArchiveDigest ?? null;
  const inherited = previous?.bundleLocation ?? null;

  // A repo App builds its repository's adopted commit, which keeps source and
  // config on one commit. The previous Build's commit is the fallback.
  const [repository] =
    app.sourceKind === 'repo' && app.repositoryId !== null
      ? await context.db
          .select()
          .from(repositories)
          .where(eq(repositories.id, app.repositoryId))
          .limit(1)
      : [];
  const wanted =
    requested ??
    (repository?.access === 'active'
      ? (repository.authoritativeCommit ?? baseCommit)
      : baseCommit);

  if (
    wanted === baseCommit &&
    inherited !== null &&
    isFetchableBundleLocation(inherited) &&
    // An ephemeral bundle may have expired, so it is staged again. The depot is
    // content-addressed, and the overwrite resets the object's lifecycle clock.
    !isEphemeralBundleLocation(inherited)
  ) {
    // A durable bundle is immutable, so the same commit reuses it.
    return ok({
      commit: baseCommit,
      bundleDigest: inheritedDigest,
      bundleLocation: inherited,
      headline:
        previous === null
          ? null
          : {
              message: previous.commitMessage,
              author: previous.commitAuthor,
              authoredAt: previous.commitAuthoredAt,
            },
    });
  }

  if (app.sourceKind !== 'repo') {
    // An archive exists only as uploaded, so a missing or unfetchable bundle
    // cannot be staged again.
    return failed(
      'NOT_BUILDABLE',
      inherited === null
        ? `${app.name} is deployed from an uploaded archive and '${componentName}' has no bundle of its own, so there is nothing to build for it — upload an archive for this Component, or adopt the artifact a sibling Component already built`
        : `${app.name}'s uploaded archive was staged at ${inherited}, which no build route can fetch, and an archive cannot be staged again from anything Spindrift holds — upload it again to stage it in the depot`,
    );
  }

  const was =
    wanted !== baseCommit
      ? `staged at ${baseCommit}, which ${wanted} has moved past`
      : inherited === null
        ? 'never staged for this Component'
        : `staged at ${inherited}, which no build route can fetch`;

  const stager = context.adapters.source?.() ?? null;
  if (stager === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and this installation configures no source depot to stage a fresh one into`,
    );
  }

  if (repository === undefined) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${app.name} has no connected repository to stage a fresh one from — connect its repository to make it buildable`,
    );
  }
  if (repository.access !== 'active') {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${repository.fullName} is ${repository.access}, so no fresh bundle can be staged: ${repository.frozenReason ?? 'access to it was lost'}`,
    );
  }

  // `HEAD` is this command's placeholder for no previous commit.
  const commit = wanted === 'HEAD' ? repository.authoritativeCommit : wanted;
  if (commit === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${repository.fullName} has no authoritative commit ready to stage a fresh one from`,
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
      headline: staged.commit ?? null,
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
  // `apps.name` has no unique constraint, so an ambiguous name is refused.
  const isUuid = z.uuid().safeParse(input.name).success;
  const matches = await context.db.query.apps.findMany({
    where: (appsTable, { eq: eqOp, or: orOp }) =>
      isUuid
        ? orOp(eqOp(appsTable.name, input.name), eqOp(appsTable.id, input.name))
        : eqOp(appsTable.name, input.name),
    with: {
      components: {
        // Oldest first, as `getAppWorkspace` reads them, so a deploy naming no
        // Component acts on the one the screen shows.
        orderBy: (componentsTable, { asc }) => [asc(componentsTable.createdAt)],
        with: {
          builds: {
            // `id` breaks ties: `createdAt` comes from the command's clock, so
            // two Builds can share one.
            orderBy: (buildsTable, { desc }) => [
              desc(buildsTable.createdAt),
              desc(buildsTable.id),
            ],
            limit: 1,
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

  let component = primaryComponent;
  if (input.component !== undefined) {
    const named = app.components.find(
      (candidate) =>
        candidate.id === input.component || candidate.name === input.component,
    );
    if (!named) {
      const names = app.components
        .map((candidate) => candidate.name)
        .join(', ');
      return failed(
        'NOT_FOUND',
        `App '${app.name}' has no Component '${input.component}' — it has: ${names}`,
      );
    }
    component = named;
  }

  // Placement is `placedTargetId` alone; desired rows and deploy history
  // do not count.
  const placedTargetId = component.placedTargetId ?? undefined;

  let targetId = placedTargetId;
  if (input.target !== undefined) {
    // An id, or `<vessel>/<adapter>`; anything else names no Target.
    const [vessel, surface] = input.target.split('/');
    const adapter = targetAdapterSchema.safeParse(surface);
    const identifies = z.uuid().safeParse(input.target).success
      ? eq(targets.id, input.target)
      : vessel !== undefined && adapter.success
        ? and(eq(vessels.name, vessel), eq(targets.adapter, adapter.data))
        : null;
    const [named] =
      identifies === null
        ? []
        : await context.db
            .select({ id: targets.id })
            .from(targets)
            .innerJoin(vessels, eq(targets.vesselId, vessels.id))
            .where(identifies);
    if (named === undefined) {
      return failed('NOT_FOUND', `there is no Target '${input.target}'`);
    }
    // Naming a different Target is a move, which goes through `placeComponent`.
    if (placedTargetId !== undefined && placedTargetId !== named.id) {
      return failed(
        'INVALID_INPUT',
        `Component '${component.name}' is placed elsewhere — deploy without ` +
          'naming a Target, or move it first',
        [{ path: 'target', message: 'disagrees with the existing placement' }],
      );
    }
    targetId = named.id;
  }

  if (!targetId) {
    return failed(
      'NOT_FOUND',
      `Component '${component.name}' has no target placement — name one: ` +
        'a first deploy is what writes it',
    );
  }

  const latestBuild = component.builds[0];

  // A rerun's commit is `<commit>#<millis>`; comparisons strip the suffix.
  const builtCommit =
    latestBuild === undefined
      ? null
      : (latestBuild.commit.split('#')[0] ?? latestBuild.commit);
  const isRequestedCommit =
    input.commit === undefined || builtCommit === input.commit;

  if (
    !input.rebuild &&
    // For a caller naming a commit, the newest Build must be of it, or a push
    // would deploy the previous commit's artifact.
    isRequestedCommit &&
    latestBuild &&
    latestBuild.status === 'SUCCEEDED' &&
    latestBuild.artifactDigest !== null
  ) {
    if (input.commit !== undefined) {
      // Already desired on this pair: skip a re-apply of an identical
      // artifact, which on Vercel is another production deployment.
      const [desired] = await context.db
        .select({
          desiredBuildId: componentTargetDesired.desiredBuildId,
          desiredDeployId: componentTargetDesired.desiredDeployId,
        })
        .from(componentTargetDesired)
        .where(
          and(
            eq(componentTargetDesired.componentId, component.id),
            eq(componentTargetDesired.targetId, targetId),
          ),
        )
        .limit(1);
      if (desired?.desiredBuildId === latestBuild.id) {
        return ok({
          deployId: desired.desiredDeployId,
          buildId: latestBuild.id,
          phase: 'UNCHANGED' as const,
        });
      }
    }

    const deployAttempt = await createDeploy(
      {
        componentId: component.id,
        targetId,
        buildId: latestBuild.id,
      },
      context,
    );

    // `createDeploy` is the only admission policy, so its refusal goes out as is.
    if (!deployAttempt.ok) return deployAttempt;

    return ok({
      deployId: deployAttempt.value.deployId,
      buildId: latestBuild.id,
      phase: 'PENDING' as const,
    });
  }

  const now = context.clock.now();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);
  let buildToRun = latestBuild;

  // `RUNNING` past its lease is a dead runner. `runBuildPass` picks only
  // `PENDING` rows, so the reset below is what requeues it.
  const inFlight =
    buildToRun !== undefined &&
    (buildToRun.status === 'PENDING' ||
      (buildToRun.status === 'RUNNING' &&
        buildToRun.leasedAt !== null &&
        buildToRun.leasedAt >= leaseCutoff));

  // A Build of this commit is in flight. Falling through would reset it and,
  // where it is `RUNNING`, revoke a live lease.
  if (input.commit !== undefined && isRequestedCommit && inFlight) {
    return ok({
      deployId: null,
      buildId: buildToRun!.id,
      phase: 'BUILDING' as const,
    });
  }

  if (
    !buildToRun ||
    buildToRun.status === 'FAILED' ||
    buildToRun.status === 'SUCCEEDED' ||
    // The reset arm below would rebuild the old row's commit, so a named
    // commit that is not built needs a new Build.
    !isRequestedCommit
  ) {
    // Shape comes from the placed Target, as `createDeploy` admits it. The
    // predecessor's shape would never satisfy a cross-shape refusal.
    const placedOn = targetId;
    const target = await context.db.query.targets.findFirst({
      where: (targetsTable, { eq: eqOp }) => eqOp(targetsTable.id, placedOn),
      with: { vessel: true },
    });
    if (target === undefined) {
      return failed('NOT_FOUND', `there is no Target with id ${targetId}`);
    }
    const shape = artifactTypeFor(
      component.kind,
      placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      }),
    );

    // Staged before the insert, so the row records this Build's own source.
    const rerun = await sourceForRerun(
      app,
      component.name,
      buildToRun ?? null,
      input.commit ?? null,
      context,
    );
    if (!rerun.ok) return rerun;

    // A rerun of the same commit would collide on the Build key, so the row is
    // keyed by request time.
    const commitRef = `${rerun.value.commit}#${now.getTime()}`;

    const [newBuild] = await context.db
      .insert(builds)
      .values({
        componentId: component.id,
        commit: commitRef,
        targetShape: shape,
        artifactType: shape,
        bundleDigest: rerun.value.bundleDigest,
        bundleLocation: rerun.value.bundleLocation,
        commitMessage: rerun.value.headline?.message ?? null,
        commitAuthor: rerun.value.headline?.author ?? null,
        commitAuthoredAt: rerun.value.headline?.authoredAt ?? null,
        // A repo Build takes the App's declared subpath; a predecessor may hold
        // a stale '.'. An archive keeps its uploaded bundle's own subpath.
        bundleSubpath:
          app.sourceKind === 'repo'
            ? (app.sourceRepoSubpath ?? '.')
            : (buildToRun?.bundleSubpath ?? '.'),
        status: 'PENDING',
        createdAt: now,
        // The build loop reads this when the Build finishes, after this caller
        // has returned.
        deployOnSuccess: input.commit !== undefined,
      })
      .returning();

    buildToRun = newBuild;
  } else {
    // A `RUNNING` Build under a live lease is refused: clearing the lease would
    // dispatch a second generator into its log. Stopping it is `cancelBuild`'s.
    const rearmed = await context.db
      .update(builds)
      .set({
        status: 'PENDING',
        runner: null,
        logFidelity: null,
        dispatchId: null,
        leasedAt: null,
        // A fresh press resets the dispatch backoff.
        dispatchAttempts: 0,
        nextDispatchAt: null,
        // `deployOnSuccess` stays set, so a Rebuild press never cancels the
        // deploy a push asked for.
      })
      // Guarded in the WHERE: `dispatchBuild` claims rows concurrently, and
      // zero rows matched is the refusal.
      .where(
        and(
          eq(builds.id, buildToRun.id),
          or(
            eq(builds.status, 'PENDING'),
            and(
              eq(builds.status, 'RUNNING'),
              or(isNull(builds.leasedAt), lt(builds.leasedAt, leaseCutoff)),
            ),
          ),
        ),
      )
      .returning({ id: builds.id });

    if (rearmed.length === 0) {
      return failed(
        'NOT_BUILDABLE',
        `Build ${buildToRun.id} for '${component.name}' is already running — ` +
          'wait for it to finish, or for its lease to expire, before starting ' +
          'another',
      );
    }
  }

  // Dispatch needs a desired row. Its desired ids stay untouched: only an
  // intent written under the lock sets them.
  await context.db
    .insert(componentTargetDesired)
    .values({
      componentId: component.id,
      targetId,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // A first deploy sets the placement. Conditional on NULL, so an already
  // placed Component never moves.
  await context.db
    .update(components)
    .set({ placedTargetId: targetId })
    .where(
      and(eq(components.id, component.id), isNull(components.placedTargetId)),
    );

  return ok({
    deployId: null,
    buildId: buildToRun!.id,
    phase: 'BUILDING' as const,
  });
};
