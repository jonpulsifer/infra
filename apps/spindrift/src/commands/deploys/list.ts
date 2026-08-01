/**
 * `listDeploys` — the releases of one App, newest first (§2, §6).
 *
 * §2 makes "one Build → many Deploys" the thing that "makes rollback-without-
 * rebuild possible", and §6 makes a rollback "an ordinary deploy — a newer
 * intent row pointing at an older Build". Both sentences are about a *set* of
 * releases, and neither is reachable from a screen that shows only the newest
 * one: choosing the older Build means reading the release that named it.
 *
 * Each row is atomic in the sense that matters here — a Deploy row is written
 * once and never edited into a different release. Its Build, its commit, and
 * the config document it pinned (§10) are what it delivered, so a row is a
 * durable answer to "what was live then" rather than a view of what is live
 * now. `current` is the one field that is *not* on the row: which release
 * should be running is the desired row's answer (§6), and a LIVE Deploy that a
 * newer intent superseded is still LIVE.
 */
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import type { DeployListItem, DeployPhase } from '../../web/model.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

/** How many releases a list answers with before it is a data-export problem. */
export const RELEASE_PAGE = 25;

export const listDeploysInput = z
  .object({
    /** The App's id, or its name where that names exactly one App. */
    app: z.string().trim().min(1),
    limit: z.number().int().positive().max(RELEASE_PAGE).optional(),
  })
  .strict();

export type ListDeploysInput = z.infer<typeof listDeploysInput>;

export interface ListDeploysResult {
  readonly deploys: readonly DeployListItem[];
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

  return ok({
    deploys: await releasesOf(
      context,
      app.components.map((component) => component.id),
      input.limit ?? RELEASE_PAGE,
    ),
  });
};

/**
 * The releases across a set of Components, newest first.
 *
 * Exported because the workspace shows the same list without a second round
 * trip, and two projections of one concept is how the two screens start
 * disagreeing about which release is current.
 */
export async function releasesOf(
  context: CommandContext,
  componentIds: readonly string[],
  limit: number = RELEASE_PAGE,
): Promise<readonly DeployListItem[]> {
  if (componentIds.length === 0) return [];

  const rows = await context.db.query.deploys.findMany({
    where: (deploys) => inArray(deploys.componentId, [...componentIds]),
    orderBy: (deploys, { desc }) => [desc(deploys.id)],
    limit,
    with: { component: true, target: true, build: true },
  });

  if (rows.length === 0) return [];

  // One read of every desired row these releases touch. `current` and
  // `rollbackable` are both questions about §6's check-and-set, and asking the
  // database once per release would be the same answer fetched N times.
  const desiredRows = await context.db.query.componentTargetDesired.findMany({
    where: (rowsTable) => inArray(rowsTable.componentId, [...componentIds]),
  });
  const desired = new Map(
    desiredRows.map((row) => [`${row.componentId}@${row.targetId}`, row]),
  );

  const now = context.clock.now();

  return rows.map((row) => {
    const here = desired.get(`${row.componentId}@${row.targetId}`);
    const current = here?.desiredDeployId === row.id;
    return {
      id: row.id,
      buildId: row.buildId,
      componentId: row.componentId,
      targetId: row.targetId,
      component: row.component.name,
      target: row.target.name,
      commit: row.build.commit,
      phase: row.phase as DeployPhase,
      when: elapsedSince(row.createdAt, now),
      at: row.createdAt.toISOString(),
      current,
      configVersion: row.configVersion,
      // The same comparison `rollbackDeploy` makes under the lock, so the
      // affordance appears only where the act would be accepted. It can still
      // refuse for a reason this list cannot see — a disconnected Target, a
      // signature that no longer verifies — and that refusal is a sentence the
      // operator reads, not something to pre-empt by hiding the button.
      rollbackable:
        !current &&
        here?.desiredBuildId != null &&
        row.buildId < here.desiredBuildId &&
        row.build.artifactDigest !== null,
    };
  });
}
