import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  creationDrafts,
  type Repository,
  repositories,
  targets,
} from '../../db/schema.ts';
import {
  type Blocker,
  blockersFor,
  type CreationDraftView,
  creationDraftSchema,
  initialCreationDraft,
  storedDraft,
} from '../../domain/creation-draft.ts';
import type { ArtifactType } from '../../domain/desired-state.ts';
import {
  artifactTypeFor,
  DEFAULT_PLATFORM,
  placementTargetOf,
  resolvePlacement,
} from '../../domain/placement.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { SUPPLIED_ARTIFACT_TYPE } from '../../domain/source.ts';
import type {
  CommitHeadline,
  StagedSourceBundle,
} from '../../domain/source-bundle.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { dispatchAutoDeploys } from '../../reconciler/auto-deploy.ts';
import {
  type RepositoryReconciliation,
  reconcileRepository,
} from '../../reconciler/repo-loop.ts';
import { logWarn } from '../../telemetry/index.ts';
import { routeForTarget } from '../builds/route.ts';
import type { CreateAppResult } from '../create-app.ts';
import { connectRepository } from '../repositories/connect.ts';
import {
  type Command,
  type CommandContext,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

const identity = z.object({ id: z.uuid() }).strict();
const versionedIdentity = z
  .object({ id: z.uuid(), revision: z.number().int().nonnegative() })
  .strict();

export const startCreationDraftInput = z
  .object({ id: z.uuid().optional() })
  .strict();
export const getCreationDraftInput = identity;
export const saveCreationDraftInput = z
  .object({
    id: z.uuid(),
    revision: z.number().int().nonnegative(),
    draft: creationDraftSchema,
  })
  .strict();
export const completeCreationDraftInput = versionedIdentity;

export type StartCreationDraftInput = z.infer<typeof startCreationDraftInput>;
export type GetCreationDraftInput = z.infer<typeof getCreationDraftInput>;
export type SaveCreationDraftInput = z.infer<typeof saveCreationDraftInput>;
export type CompleteCreationDraftInput = z.infer<
  typeof completeCreationDraftInput
>;

export interface CompleteCreationDraftResult {
  readonly draft: CreationDraftView;
  readonly app: CompletedCreation | null;
}

export interface CompletedCreation extends CreateAppResult {
  readonly componentId: string;
  readonly componentName: string;
  readonly targetId: string;
  readonly buildId: number;
  readonly buildStatus: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  /**
   * The configuration pull request this creation opened. Read from the
   * repository row, so a reload of a completed draft still names it.
   */
  readonly configPullRequest: number | null;
  /** Why no pull request was opened. Null whenever one was, or none was due. */
  readonly configPullRequestError: string | null;
  /** `owner/name`, so the number can be made into a link. */
  readonly configRepository: string | null;
}

const preparations = new Map<
  string,
  Promise<CommandResult<PreparedCreation>>
>();

export const startCreationDraft: Command<
  StartCreationDraftInput,
  CreationDraftView
> = async (input, context) => {
  const [target] = await context.db
    .select({ id: targets.id })
    .from(targets)
    .where(and(eq(targets.status, 'connected'), eq(targets.health, 'healthy')))
    .orderBy(asc(targets.rank))
    .limit(1);

  const now = context.clock.now();
  const id = input.id ?? crypto.randomUUID();
  const [inserted] = await context.db
    .insert(creationDrafts)
    .values({
      id,
      userId: context.principal.id,
      draft: initialCreationDraft({
        targetId: target?.id ?? null,
        // By name: a project is only one shape of a vessel's address.
        vessel: context.manifest.installation.homeVessel,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: creationDrafts.id })
    .returning();
  const row = inserted ?? (await owned(id, context));
  if (!row) {
    throw new Error('creation draft id belongs to another operator');
  }

  return ok(await viewOf(row, context));
};

export const getCreationDraft: Command<
  GetCreationDraftInput,
  CreationDraftView
> = async (input, context) => {
  const row = await owned(input.id, context);
  if (!row) {
    return failed(
      'NOT_FOUND',
      `there is no creation draft with id ${input.id}`,
    );
  }
  return ok(await viewOf(row, context));
};

export const saveCreationDraft: Command<
  SaveCreationDraftInput,
  CreationDraftView
> = async (input, context) => {
  const [row] = await context.db
    .update(creationDrafts)
    .set({
      draft: input.draft,
      revision: sql`${creationDrafts.revision} + 1`,
      updatedAt: context.clock.now(),
    })
    .where(
      and(
        eq(creationDrafts.id, input.id),
        eq(creationDrafts.userId, context.principal.id),
        eq(creationDrafts.revision, input.revision),
      ),
    )
    .returning();

  if (!row) return conflictOrMissing(input.id, input.revision, context);
  return ok(await viewOf(row, context));
};

/**
 * Revalidate and create as one locked database act. The same draft revision
 * can be retried after a lost response and returns the App it already made.
 */
export const completeCreationDraft: Command<
  CompleteCreationDraftInput,
  CompleteCreationDraftResult
> = async (input, context) => {
  const before = await owned(input.id, context);
  if (!before) {
    return failed(
      'NOT_FOUND',
      `there is no creation draft with id ${input.id}`,
    );
  }
  if (before.revision !== input.revision) {
    return stale<CompleteCreationDraftResult>();
  }

  // A completed draft is a receipt for an act that already happened. Replaying
  // it must not be re-blocked by source access or Target health changing later.
  let prepared: CommandResult<PreparedCreation> | null = null;
  if (before.completedAppId === null) {
    const beforeView = await viewOf(before, context);
    if (!beforeView.ready) return ok({ draft: beforeView, app: null });

    // Staged first: immutable storage makes a retry harmless, and a failure
    // leaves the draft resumable with no half-created App.
    prepared = await prepareOnce(before.id, before.revision, () =>
      prepareCreation(before.draft, context),
    );
  }
  if (prepared !== null && !prepared.ok) return prepared;

  const durable = await context.db.transaction(
    async (
      transaction,
    ): Promise<CommandResult<CompleteCreationDraftResult>> => {
      const txContext = {
        ...context,
        db: transaction as unknown as CommandContext['db'],
      };
      const [row] = await transaction
        .select()
        .from(creationDrafts)
        .where(
          and(
            eq(creationDrafts.id, input.id),
            eq(creationDrafts.userId, context.principal.id),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        return failed(
          'NOT_FOUND',
          `there is no creation draft with id ${input.id}`,
        );
      }
      if (row.revision !== input.revision) {
        return stale<CompleteCreationDraftResult>();
      }

      if (row.completedAppId !== null) {
        return completedCreation(row, txContext);
      }

      const draft = await viewOf(row, txContext);
      if (!draft.ready) return ok({ draft, app: null });
      if (prepared === null || !prepared.ok) {
        throw new Error('a ready creation draft has no prepared source');
      }

      const now = context.clock.now();
      const [created] = await transaction
        .insert(apps)
        .values({
          name: row.draft.appName,
          sourceKind: row.draft.source.kind,
          sourceRepoUrl:
            row.draft.source.kind === 'repo' ? row.draft.source.url : null,
          sourceRepoSubpath:
            row.draft.source.kind === 'repo' ? row.draft.source.subpath : null,
          sourceArchiveDigest:
            row.draft.source.kind === 'archive'
              ? row.draft.source.digest
              : null,
          repositoryId: prepared.value.repositoryId,
          // No vessel column: the draft's vessel only gates creation.
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const app: CreateAppResult = {
        appId: created!.id,
        name: created!.name,
        createdAt: created!.createdAt,
      };
      const [component] = await transaction
        .insert(components)
        .values({
          appId: app.appId,
          name: row.draft.componentName,
          kind: row.draft.kind,
          expose: row.draft.kind === 'job' ? null : true,
          reach: row.draft.reach,
          auth: row.draft.auth,
          // The draft's Target is this Component's first placement of record.
          placedTargetId: row.draft.targetId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await transaction.insert(componentTargetDesired).values({
        componentId: component!.id,
        targetId: row.draft.targetId,
        updatedAt: now,
      });
      const [build] = await transaction
        .insert(builds)
        .values({
          componentId: component!.id,
          commit: prepared.value.commit,
          targetShape: prepared.value.artifactType,
          artifactType: prepared.value.artifactType,
          artifactDigest: prepared.value.supplied
            ? prepared.value.bundleDigest
            : null,
          artifactRefs: prepared.value.supplied
            ? [prepared.value.bundleLocation]
            : null,
          bundleDigest: prepared.value.bundleDigest,
          bundleLocation: prepared.value.bundleLocation,
          bundleSubpath: prepared.value.subpath,
          commitMessage: prepared.value.headline?.message ?? null,
          commitAuthor: prepared.value.headline?.author ?? null,
          commitAuthoredAt: prepared.value.headline?.authoredAt ?? null,
          status: prepared.value.supplied ? 'SUCCEEDED' : 'PENDING',
          createdAt: now,
        })
        .returning();
      await transaction
        .update(creationDrafts)
        .set({
          completedAppId: app.appId,
          updatedAt: now,
        })
        .where(eq(creationDrafts.id, row.id));
      return ok({
        draft,
        app: {
          ...app,
          componentId: component!.id,
          componentName: component!.name,
          targetId: row.draft.targetId,
          buildId: build!.id,
          buildStatus: build!.status,
          configPullRequest: prepared.value.configPullRequest,
          configPullRequestError: prepared.value.configPullRequestError,
          configRepository:
            row.draft.source.kind === 'repo' ? row.draft.source.repo : null,
        },
      });
    },
  );
  return durable;
};

interface PreparedCreation {
  readonly repositoryId: string | null;
  readonly commit: string;
  readonly artifactType: ArtifactType;
  readonly bundleDigest: string;
  readonly bundleLocation: string;
  readonly subpath: string;
  readonly supplied: boolean;
  /** What staging knew of the commit beyond its sha; null for an archive. */
  readonly headline: CommitHeadline | null;
  /**
   * The configuration pull request this creation opened. Merging it is what
   * connects the repository, so its number must reach the screen.
   */
  readonly configPullRequest: number | null;
  /** Why there is no number, when there is none. Null on every other path. */
  readonly configPullRequestError: string | null;
}

async function prepareOnce(
  draftId: string,
  revision: number,
  prepare: () => Promise<CommandResult<PreparedCreation>>,
): Promise<CommandResult<PreparedCreation>> {
  const key = `${draftId}:${revision}`;
  const existing = preparations.get(key);
  if (existing !== undefined) return existing;
  const pending = prepare();
  preparations.set(key, pending);
  try {
    return await pending;
  } finally {
    if (preparations.get(key) === pending) preparations.delete(key);
  }
}

async function prepareCreation(
  draft: typeof creationDraftSchema._output,
  context: CommandContext,
) {
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, draft.targetId),
    with: { vessel: true },
  });
  if (!target) {
    return failed<PreparedCreation>(
      'NOT_FOUND',
      `there is no Target with id ${draft.targetId}`,
    );
  }
  const placementArtifactType = artifactTypeFor(
    draft.kind,
    placementTargetOf(target, {
      artifactTypes:
        context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
      manifest: context.manifest,
    }),
  );

  if (draft.source.kind === 'archive') {
    const location = draft.source.location;
    if (!location) {
      return failed<PreparedCreation>(
        'NOT_BUILDABLE',
        `${draft.source.filename} has not been staged`,
      );
    }
    const supplied = draft.source.contents === 'artifact';
    if (
      supplied &&
      !(context.adapters.deploy(target.adapter)?.artifactTypes ?? []).includes(
        SUPPLIED_ARTIFACT_TYPE,
      )
    ) {
      return failed<PreparedCreation>(
        'NOT_DEPLOYABLE',
        `${targetRowLabel(target)} cannot take uploaded finished files`,
      );
    }
    const route = supplied ? null : await routeForTarget(target.id, context);
    if (!supplied && route === null)
      return noBuildRoute(targetRowLabel(target));
    return ok({
      repositoryId: null,
      commit: draft.source.digest,
      artifactType: supplied ? SUPPLIED_ARTIFACT_TYPE : placementArtifactType,
      bundleDigest: draft.source.digest,
      bundleLocation: location,
      subpath: draft.source.subpath ?? '.',
      supplied,
      headline: null,
      configPullRequest: null,
      configPullRequestError: null,
    });
  }

  let repository = await repositoryRow(context, draft.source.repo);
  let configPullRequest: number | null = null;
  let configPullRequestError: string | null = null;
  if (
    draft.source.connect === true &&
    (repository?.access !== 'active' || repository.authoritativeCommit === null)
  ) {
    const connected = await connectAndAdopt(
      draft.source.repo,
      draft.source.subpath,
      context,
    );
    if (!connected.ok) return connected;
    repository = connected.value.repository;
    configPullRequest = connected.value.pullRequest;
    configPullRequestError = connected.value.pullRequestError;
  } else if (
    repository !== undefined &&
    repository.access === 'active' &&
    repository.authoritativeCommit === null
  ) {
    // A connected row no repo-loop tick has adopted has no commit to stage.
    // Adopt now, and dispatch what that adopts, as any adopting writer must.
    const host = context.adapters.repository?.() ?? null;
    if (host !== null) {
      const pass = await reconcileRepository(
        { db: context.db, clock: context.clock, host },
        repository,
      );
      await dispatchAdopted(pass, context);
      repository =
        (await repositoryRow(context, draft.source.repo)) ?? repository;
    }
  }
  if (
    repository?.access !== 'active' ||
    repository.authoritativeCommit === null
  ) {
    return failed<PreparedCreation>(
      'NOT_BUILDABLE',
      `${draft.source.repo} has no authoritative commit ready to stage`,
    );
  }
  const stager = context.adapters.source?.() ?? null;
  if (stager === null) {
    return failed<PreparedCreation>(
      'NOT_BUILDABLE',
      'this installation has no repository source depot configured',
    );
  }
  const route = await routeForTarget(target.id, context);
  if (route === null) return noBuildRoute(targetRowLabel(target));
  let staged: StagedSourceBundle;
  try {
    staged = await stager.stageRepository({
      ref: repositoryRefOf(repository),
      repository: repository.fullName,
      commit: repository.authoritativeCommit,
      stagedAt: context.clock.now(),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed<PreparedCreation>(
      'NOT_BUILDABLE',
      `could not stage ${repository.fullName}: ${detail}`,
    );
  }
  return ok({
    repositoryId: repository.id,
    commit: repository.authoritativeCommit,
    artifactType: placementArtifactType,
    bundleDigest: staged.digest,
    bundleLocation: staged.location,
    subpath: draft.source.subpath,
    supplied: false,
    headline: staged.commit ?? null,
    configPullRequest,
    configPullRequestError,
  });
}

function noBuildRoute(target: string) {
  return failed<PreparedCreation>(
    'NOT_BUILDABLE',
    `this installation has no eligible build route for ${target}`,
  );
}

/**
 * Dispatches an adopted pass, as any adopting writer must. A failure is logged,
 * not thrown: those Apps belong to others, and the loop retries the commit.
 */
async function dispatchAdopted(
  pass: RepositoryReconciliation,
  context: CommandContext,
): Promise<void> {
  try {
    await dispatchAutoDeploys(
      {
        db: context.db,
        clock: context.clock,
        adapters: context.adapters,
        manifest: context.manifest,
      },
      [pass],
    );
  } catch (cause) {
    logWarn('an adopted commit could not be dispatched during App creation', {
      'spindrift.repository': pass.fullName,
      'spindrift.error': cause instanceof Error ? cause.message : String(cause),
    });
  }
}

async function repositoryRow(context: CommandContext, fullName: string) {
  const [row] = await context.db
    .select()
    .from(repositories)
    .where(eq(repositories.fullName, fullName))
    .limit(1);
  return row;
}

/**
 * Connects the draft's repository, scoped to its directory, then adopts and
 * dispatches the default branch so creation need not wait for a repo-loop tick.
 */
async function connectAndAdopt(
  fullName: string,
  subpath: string,
  context: CommandContext,
): Promise<
  CommandResult<{
    readonly repository: Repository;
    readonly pullRequest: number | null;
    readonly pullRequestError: string | null;
  }>
> {
  const connected = await connectRepository(
    { fullName, scopes: [subpath] },
    context,
  );
  if (!connected.ok) return connected;
  const { pullRequest, pullRequestError } = connected.value;

  const row = await repositoryRow(context, fullName);
  if (row === undefined) {
    throw new Error(`connecting ${fullName} wrote no repository row`);
  }
  const host = context.adapters.repository?.() ?? null;
  if (host === null) {
    return ok({ repository: row, pullRequest, pullRequestError });
  }
  const pass = await reconcileRepository(
    { db: context.db, clock: context.clock, host },
    row,
  );
  await dispatchAdopted(pass, context);
  return ok({
    repository: (await repositoryRow(context, fullName)) ?? row,
    pullRequest,
    pullRequestError,
  });
}

async function completedCreation(
  row: typeof creationDrafts.$inferSelect,
  context: CommandContext,
): Promise<CommandResult<CompleteCreationDraftResult>> {
  const completed = await context.db.query.apps.findFirst({
    where: (apps, { eq }) => eq(apps.id, row.completedAppId!),
  });
  const [component] =
    completed === undefined
      ? []
      : await context.db
          .select()
          .from(components)
          .where(
            and(
              eq(components.appId, completed.id),
              eq(components.name, row.draft.componentName),
            ),
          )
          .limit(1);
  const [build] =
    component === undefined
      ? []
      : await context.db
          .select()
          .from(builds)
          .where(eq(builds.componentId, component.id))
          .orderBy(asc(builds.id))
          .limit(1);
  const [placement] =
    component === undefined
      ? []
      : await context.db
          .select({ targetId: componentTargetDesired.targetId })
          .from(componentTargetDesired)
          .where(eq(componentTargetDesired.componentId, component.id))
          .limit(1);
  if (!completed || !component || !build || !placement) {
    throw new Error('creation draft points at an incomplete App intent');
  }
  // From the row: the connect's response is gone after a reload.
  const repository =
    completed.repositoryId === null
      ? undefined
      : await context.db.query.repositories.findFirst({
          where: (repositories, { eq }) =>
            eq(repositories.id, completed.repositoryId!),
        });
  return ok({
    draft: {
      id: row.id,
      revision: row.revision,
      draft: storedDraft(row.draft),
      blockers: [],
      ready: true,
    },
    app: {
      appId: completed.id,
      name: completed.name,
      createdAt: completed.createdAt,
      componentId: component.id,
      componentName: component.name,
      targetId: placement.targetId,
      buildId: build.id,
      buildStatus: build.status,
      configPullRequest: repository?.configPullRequest ?? null,
      configPullRequestError: null,
      configRepository: repository?.fullName ?? null,
    },
  });
}

async function conflictOrMissing(
  id: string,
  _revision: number,
  context: CommandContext,
) {
  const row = await owned(id, context);
  return row
    ? stale<CreationDraftView>()
    : failed<CreationDraftView>(
        'NOT_FOUND',
        `there is no creation draft with id ${id}`,
      );
}

function stale<Output>() {
  return failed<Output>(
    'STALE_EDIT',
    'this creation draft changed in another browser; reload it before saving',
  );
}

async function owned(id: string, context: CommandContext) {
  const [row] = await context.db
    .select()
    .from(creationDrafts)
    .where(
      and(
        eq(creationDrafts.id, id),
        eq(creationDrafts.userId, context.principal.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function viewOf(
  row: typeof creationDrafts.$inferSelect,
  context: CommandContext,
): Promise<CreationDraftView> {
  // Through storedDraft, so a row holding a retired key hands the browser only
  // keys the strict save schema accepts.
  const draft = storedDraft(row.draft);
  const blockers = await revalidate(draft, context);
  return {
    id: row.id,
    revision: row.revision,
    draft,
    blockers,
    ready: blockers.length === 0,
  };
}

async function revalidate(
  draft: typeof creationDraftSchema._output,
  context: CommandContext,
): Promise<readonly Blocker[]> {
  const connected = await context.db.query.targets.findMany({
    where: (targets, { eq }) => eq(targets.status, 'connected'),
    with: { vessel: true },
  });
  const placement = resolvePlacement(
    connected.map((target) =>
      placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      }),
    ),
    {
      kind: draft.kind,
      reach: draft.reach,
      auth: draft.auth,
      platform: DEFAULT_PLATFORM,
      registries: context.manifest.supplyChain.registry,
      resources: {},
      gpu: false,
      persistence: false,
      datastores: [],
      secretStore: context.manifest.secretStore.adapter,
    },
  );
  const candidateIds = placement.candidates
    .filter((candidate) => candidate.target.healthy)
    .map((candidate) => candidate.target.id);
  const blockers = [...blockersFor(draft, candidateIds)];

  if (draft.source.kind === 'repo' && draft.source.repo !== '') {
    const [repository] = await context.db
      .select({
        access: repositories.access,
        authoritativeCommit: repositories.authoritativeCommit,
      })
      .from(repositories)
      .where(eq(repositories.fullName, draft.source.repo))
      .limit(1);
    // A granted repository with no row is connected by completion itself, so
    // its absence is no blocker.
    const connectsOnDeploy =
      repository === undefined && draft.source.connect === true;
    if (!connectsOnDeploy) {
      if (repository?.access !== 'active') {
        blockers.push({
          code: 'REPOSITORY_UNAVAILABLE',
          title: `The repository ${draft.source.repo} is no longer available.`,
          remediation:
            'Restore the GitHub App installation access or choose another repository. The draft is kept.',
        });
      } else if (repository.authoritativeCommit === null) {
        blockers.push({
          code: 'SOURCE_UNAVAILABLE',
          title: `The repository ${draft.source.repo} has no authoritative commit ready.`,
          remediation:
            'Wait for default-branch reconciliation, then review this draft again.',
        });
      }
    }
  }

  const selectedTarget = connected.find(
    (target) => target.id === draft.targetId,
  );
  if (
    draft.source.kind === 'archive' &&
    draft.source.contents === 'artifact' &&
    selectedTarget !== undefined &&
    !(
      context.adapters.deploy(selectedTarget.adapter)?.artifactTypes ?? []
    ).includes(SUPPLIED_ARTIFACT_TYPE) &&
    !blockers.some((blocker) => blocker.code === 'TARGET_UNAVAILABLE')
  ) {
    blockers.push({
      code: 'TARGET_UNAVAILABLE',
      title: `${targetRowLabel(selectedTarget)} cannot take uploaded finished files.`,
      remediation:
        'Choose a static Target for this supplied artifact, or upload source that Spindrift can build for this Target.',
    });
  }
  const needsBuilder =
    draft.source.kind === 'repo' || draft.source.contents !== 'artifact';
  if (
    needsBuilder &&
    selectedTarget !== undefined &&
    (await routeForTarget(selectedTarget.id, context)) === null
  ) {
    blockers.push({
      code: 'BUILD_ROUTE_UNAVAILABLE',
      title: `No eligible build route can build for ${targetRowLabel(selectedTarget)}.`,
      // Build routes are not on this screen, so this names where they are.
      remediation:
        'Configure a route that clears this Target’s minimum Build Level under Settings → Build routes, then come back to this draft — it is kept.',
    });
  }

  return blockers;
}
