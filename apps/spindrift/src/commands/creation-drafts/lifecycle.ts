import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  creationDrafts,
  repositories,
  targets,
} from '../../db/schema.ts';
import {
  type Blocker,
  blockersFor,
  type CreationDraftView,
  creationDraftSchema,
  initialCreationDraft,
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
import type { StagedSourceBundle } from '../../domain/source-bundle.ts';
import { routeForTarget } from '../builds/route.ts';
import type { CreateAppResult } from '../create-app.ts';
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
export const reviewCreationDraftInput = versionedIdentity;
export const completeCreationDraftInput = versionedIdentity;

export type StartCreationDraftInput = z.infer<typeof startCreationDraftInput>;
export type GetCreationDraftInput = z.infer<typeof getCreationDraftInput>;
export type SaveCreationDraftInput = z.infer<typeof saveCreationDraftInput>;
export type ReviewCreationDraftInput = z.infer<typeof reviewCreationDraftInput>;
export type CompleteCreationDraftInput = z.infer<
  typeof completeCreationDraftInput
>;

export interface ReviewCreationDraftResult extends CreationDraftView {}
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
        repository: repository?.fullName ?? null,
        targetId: target?.id ?? null,
        vessel: context.manifest.cloud.homeVesselProject,
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

export const reviewCreationDraft: Command<
  ReviewCreationDraftInput,
  ReviewCreationDraftResult
> = async (input, context) => {
  const row = await owned(input.id, context);
  if (!row) {
    return failed(
      'NOT_FOUND',
      `there is no creation draft with id ${input.id}`,
    );
  }
  if (row.revision !== input.revision) return stale();

  // Review is intentionally read-only. Issue 05 consumes a ready review and
  // atomically creates the Component, Build, and first dispatch.
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
          vesselRef: row.draft.vessel.name,
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
          exposure: row.draft.exposure,
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
  const [target] = await context.db
    .select()
    .from(targets)
    .where(eq(targets.id, draft.targetId))
    .limit(1);
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
        `${target.name} cannot take uploaded finished files`,
      );
    }
    const route = supplied ? null : await routeForTarget(target.id, context);
    if (!supplied && route === null) return noBuildRoute(target.name);
    return ok({
      repositoryId: null,
      commit: draft.source.digest,
      artifactType: supplied ? SUPPLIED_ARTIFACT_TYPE : placementArtifactType,
      bundleDigest: draft.source.digest,
      bundleLocation: location,
      subpath: draft.source.subpath ?? '.',
      supplied,
    });
  }

  const [repository] = await context.db
    .select()
    .from(repositories)
    .where(eq(repositories.fullName, draft.source.repo))
    .limit(1);
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
  if (route === null) return noBuildRoute(target.name);
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
  });
}

function noBuildRoute(target: string) {
  return failed<PreparedCreation>(
    'NOT_BUILDABLE',
    `this installation has no eligible build route for ${target}`,
  );
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
  return ok({
    draft: {
      id: row.id,
      revision: row.revision,
      draft: row.draft,
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
  const blockers = await revalidate(row.draft, context);
  return {
    id: row.id,
    revision: row.revision,
    draft: row.draft,
    blockers,
    ready: blockers.length === 0,
  };
}

async function revalidate(
  draft: typeof creationDraftSchema._output,
  context: CommandContext,
): Promise<readonly Blocker[]> {
  const connected = await context.db
    .select()
    .from(targets)
    .where(eq(targets.status, 'connected'));
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
      exposure: draft.exposure,
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

  if (draft.source.kind === 'repo') {
    const [repository] = await context.db
      .select({
        access: repositories.access,
        authoritativeCommit: repositories.authoritativeCommit,
      })
      .from(repositories)
      .where(eq(repositories.fullName, draft.source.repo))
      .limit(1);
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
      title: `${selectedTarget.name} cannot take uploaded finished files.`,
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
      title: `No eligible build route can build for ${selectedTarget.name}.`,
      remediation:
        'Configure a route that clears this Target’s minimum Build Level, then review the draft again.',
    });
  }

  return blockers;
}
