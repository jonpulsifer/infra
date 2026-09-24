/**
 * `listDeploys` lists one App's releases, newest first. A Deploy row is never
 * edited, so each row says what was live then; only `current` comes from the
 * desired row.
 */
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { principalLabels } from '../principals.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import type { DeployLedgerItem, DeployPhase } from '../views.ts';

/** The most releases one page returns; past that is a data export. */
export const RELEASE_PAGE = 25;

export const listDeploysInput = z
  .object({
    /** The App's id, or its name where that names exactly one App. */
    app: z.string().trim().min(1),
    limit: z.number().int().positive().max(RELEASE_PAGE).optional(),
    /** Return Deploys older than this id. */
    before: z.number().int().positive().optional(),
  })
  .strict();

export type ListDeploysInput = z.infer<typeof listDeploysInput>;

export interface ListDeploysResult {
  readonly deploys: readonly DeployLedgerItem[];
  readonly nextBefore: number | null;
}

export const listDeploys: Command<ListDeploysInput, ListDeploysResult> = async (
  input,
  context,
) => {
  const isUuid = z.uuid().safeParse(input.app).success;
  const app = await context.db.query.apps.findFirst({
    where: (apps, { eq, or }) =>
      isUuid
        ? or(eq(apps.name, input.app), eq(apps.id, input.app))
        : eq(apps.name, input.app),
    with: { components: true },
  });

  if (!app) return failed('NOT_FOUND', `App '${input.app}' not found`);

  const page = await releasesOf(
    context,
    app.components.map((component) => component.id),
    input.limit ?? RELEASE_PAGE,
    input.before,
  );
  return ok(page);
};

export interface ReleasePage {
  readonly deploys: readonly DeployLedgerItem[];
  readonly nextBefore: number | null;
}

/**
 * One cursor page of releases, shared by the App and global ledgers. `null`
 * lists every Component.
 */
export async function releasesOf(
  context: CommandContext,
  componentIds: readonly string[] | null,
  limit: number = RELEASE_PAGE,
  before?: number,
): Promise<ReleasePage> {
  if (componentIds?.length === 0) {
    return { deploys: [], nextBefore: null };
  }
  const selectedComponentIds = componentIds === null ? null : [...componentIds];

  const rows = await context.db.query.deploys.findMany({
    where:
      selectedComponentIds === null
        ? before === undefined
          ? undefined
          : (deploys, { lt }) => lt(deploys.id, before)
        : before === undefined
          ? (deploys) => inArray(deploys.componentId, selectedComponentIds)
          : (deploys, { and, lt }) =>
              and(
                inArray(deploys.componentId, selectedComponentIds),
                lt(deploys.id, before),
              ),
    orderBy: (deploys, { desc }) => [desc(deploys.id)],
    limit: limit + 1,
    with: {
      component: { with: { app: true } },
      target: { with: { vessel: true } },
      build: true,
    },
  });

  if (rows.length === 0) return { deploys: [], nextBefore: null };
  const page = rows.slice(0, limit);

  // One read of the desired rows for the whole page, not one per release.
  const listedComponentIds = [...new Set(page.map((row) => row.componentId))];
  const desiredRows = await context.db.query.componentTargetDesired.findMany({
    where: (rowsTable) => inArray(rowsTable.componentId, listedComponentIds),
  });
  const desired = new Map(
    desiredRows.map((row) => [`${row.componentId}@${row.targetId}`, row]),
  );

  const now = context.clock.now();
  const requestedBy = await principalLabels(
    context.db,
    page.map((row) => row.requestedBy),
  );

  const deploys = page.map((row) => {
    const here = desired.get(`${row.componentId}@${row.targetId}`);
    const current = here?.desiredDeployId === row.id;
    const by = requestedBy(row.requestedBy);
    return {
      id: row.id,
      appId: row.component.app.id,
      app: row.component.app.name,
      buildId: row.buildId,
      componentId: row.componentId,
      targetId: row.targetId,
      component: row.component.name,
      target: targetRowLabel(row.target),
      commit: row.build.commit,
      commitMessage: row.build.commitMessage,
      phase: row.phase as DeployPhase,
      when: elapsedSince(row.createdAt, now),
      at: row.createdAt.toISOString(),
      current,
      configVersion: row.configVersion,
      ...(by === undefined ? {} : { requestedBy: by }),
      // The comparison rollbackDeploy makes under the lock. Its other refusals,
      // such as a disconnected Target, reach the operator as its sentence.
      rollbackable:
        !current &&
        here?.desiredBuildId != null &&
        row.buildId < here.desiredBuildId &&
        row.build.artifactDigest !== null,
      faulty: row.faultyAt !== null,
    };
  });

  return {
    deploys,
    nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
