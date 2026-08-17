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
import { cloneUrlFor, repositoryRefOf } from '../../domain/repository.ts';
import { SUPPLIED_ARTIFACT_TYPE } from '../../domain/source.ts';
import type { StagedSourceBundle } from '../../domain/source-bundle.ts';
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
   * The configuration pull request creating this App opened, if it opened one.
   *
   * Read back off the repository row rather than only forwarded from the
   * connect, so a reload of a completed draft still names the pull request
   * somebody has to merge — the number is the whole of what makes §15's
   * "merging it is what connects this repository" actionable.
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
  const [repository] = await context.db
    .select({ fullName: repositories.fullName })
    .from(repositories)
    .where(eq(repositories.access, 'active'))
    .orderBy(asc(repositories.fullName))
    .limit(1);
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
        repository:
          repository === undefined
            ? null
            : {
                fullName: repository.fullName,
                cloneUrl: cloneUrlFor(
                  context.manifest.github.webBaseUrl,
                  repository.fullName,
                ),
              },
        targetId: target?.id ?? null,
        // The vessel by name rather than by project id: the draft states which
        // boundary this installation's home is, and a project is one shape a
        // boundary's address happens to have.
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

    // External staging happens before durable product intent. Immutable storage
    // makes a retry harmless, while a failure here leaves the resumable draft
    // and no half-created App.
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
          // The draft's vessel is a preflight gate, not a field: an
          // unprovisioned home is a reason to refuse creation, and never a
          // value the App carries afterwards.
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
          // The draft's chosen Target is this Component's first placement of
          // record, written at birth rather than inferred later.
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
  /**
   * The configuration pull request this creation opened, if it opened one.
   *
   * Carried rather than discarded because Deploy is the *only* place a
   * grant-only repository gets connected, and §15 makes merging that pull
   * request the act that connects it. An App created without its number on
   * screen is an App whose repository has a branch on it nobody was told about
   * and a `spindrift.yaml` that will never reach the default branch.
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
  // With the boundary, because half of what names a Target lives there.
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
      // An archive has no repository, so there is nothing to connect and no
      // pull request to merge.
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
    // Connected, readable, and nothing adopted from it yet — so there is no
    // commit to stage and the guard below would refuse a repository that is
    // perfectly fine. Reached whenever the row was written by `connect` and no
    // repo-loop tick has run since: the wizard classifies it as connected and
    // therefore sends `connect: false`, so the arm above does not fire.
    //
    // Adopting here rather than waiting five minutes for the loop, and
    // dispatching what it adopts, which is what makes this a legal writer of
    // `authoritative_commit` at all (see `repo-loop.ts`'s header).
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
 * Hand an adopted pass to the dispatcher, without letting it fail the creation.
 *
 * Adopting outside the loop obliges this command to dispatch (`repo-loop.ts`:
 * only a writer of `authoritative_commit` that also dispatches keeps a push
 * self-healing). But the Apps dispatched here belong to *other* people — every
 * opted-in App already on this repository — and `deployApp` is not, unlike
 * `reconcileRepository`, documented never to throw. Somebody else's staging
 * failure is not a reason to 500 this operator's App creation, and the poll
 * loop reconciles the same commit on its next tick, so the worst case of
 * swallowing is the latency the loop was always allowed to take.
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
 * Connect the repository this draft deploys from, as part of creating the App.
 *
 * The wizard lets an operator read any repository the GitHub grant offers, and
 * reading writes nothing — so a repository Spindrift holds no row for arrives
 * here, at the one committing act, and is connected through §15's own command
 * rather than through a second way of connecting. The scope is the directory
 * the draft names, so the configuration pull request covers what is about to be
 * deployed and nothing else.
 *
 * The reconcile that follows is what makes the new row stageable: `connect`
 * adopts nothing by design (§15), and a row with no authoritative commit has no
 * source to build. Reading the default branch here is the same pass the repo
 * loop makes on its own schedule, taken now so that creation does not wait a
 * tick for a commit that is already there.
 *
 * **And therefore dispatched here too.** That pass adopts, and adopting is what
 * an opted-in App's push *is* — so dropping the pass on the floor would cancel
 * it for every other App already watching this repository, exactly as the
 * Repositories screen used to. This is the second of the two ways a caller may
 * stop disagreeing with the loop: `listRepositories` refreshes without
 * claiming, and this one claims and dispatches. The App being created is not
 * among them — it does not exist yet, and its own first Build is staged below.
 */
async function connectAndAdopt(
  fullName: string,
  subpath: string,
  context: CommandContext,
): Promise<
  CommandResult<{
    readonly repository: Repository;
    /** The pull request the connect opened, forwarded rather than dropped. */
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
  // The receipt has to survive a reload, and the connect that opened the pull
  // request happened once, on a response nobody kept. The row is where the
  // number lives, which is the only reason the column is written at all.
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
  // Read through `storedDraft`, so a row written before a key was retired
  // hands the browser only keys the save schema still names — the browser
  // returns whatever it was given, and a strict schema would refuse it.
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
    // A repository the GitHub grant offers and this installation holds no row
    // for is connected by completion itself (§15), so its absence is not a
    // prerequisite to clear beforehand: `connectRepository`'s own refusal is
    // what says it could not be. `blockersFor` still refuses a draft that names
    // no repository at all.
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
      // Names where, because build routes are not on this screen and the
      // banner carrying this sentence has nothing to press. The draft is a
      // durable row reachable by URL, which is the other half of the
      // instruction: leaving to fix it loses nothing.
      remediation:
        'Configure a route that clears this Target’s minimum Build Level under Settings → Build routes, then come back to this draft — it is kept.',
    });
  }

  return blockers;
}
