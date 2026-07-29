import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
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
import {
  DEFAULT_PLATFORM,
  placementTargetOf,
  resolvePlacement,
} from '../../domain/placement.ts';
import type { CreateAppResult } from '../create-app.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

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
  readonly app: CreateAppResult | null;
}

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
> = async (input, context) =>
  context.db.transaction(async (transaction) => {
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
      const completed = await transaction.query.apps.findFirst({
        where: (apps, { eq }) => eq(apps.id, row.completedAppId!),
      });
      if (!completed) {
        throw new Error('creation draft points at an App that does not exist');
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
        },
      });
    }

    const draft = await viewOf(row, txContext);
    if (!draft.ready) return ok({ draft, app: null });

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
          row.draft.source.kind === 'archive' ? row.draft.source.digest : null,
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
    await transaction
      .update(creationDrafts)
      .set({
        completedAppId: app.appId,
        updatedAt: now,
      })
      .where(eq(creationDrafts.id, row.id));
    return ok({ draft, app });
  });

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
      .select({ access: repositories.access })
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
    }
  }

  return blockers;
}
