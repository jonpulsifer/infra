/**
 * `listBuilds` — the global artifact-production ledger, newest first.
 *
 * A Build is not a Deploy with an unfinished final step. It records one attempt
 * to turn source into an artifact, so this projection deliberately stops at the
 * newest Deploy id that later consumed it. Placement state stays on the Deploy
 * ledger and detail screen.
 */
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import type { BuildListItem } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const BUILD_LEDGER_PAGE = 50;

export const listBuildsInput = z
  .object({
    limit: z.number().int().positive().max(BUILD_LEDGER_PAGE).optional(),
    /** Return Builds older than this id. */
    before: z.number().int().positive().optional(),
  })
  .strict();

export type ListBuildsInput = z.infer<typeof listBuildsInput>;

export interface ListBuildsResult {
  readonly builds: readonly BuildListItem[];
  /** Cursor for the next older page, or null once the ledger is exhausted. */
  readonly nextBefore: number | null;
}

export const listBuilds: Command<ListBuildsInput, ListBuildsResult> = async (
  input,
  context,
) => {
  const limit = input.limit ?? BUILD_LEDGER_PAGE;
  const before = input.before;
  const rows = await context.db.query.builds.findMany({
    where:
      before === undefined
        ? undefined
        : (builds, { lt }) => lt(builds.id, before),
    orderBy: (builds, { desc }) => [desc(builds.id)],
    // The extra row answers whether an older page exists without a count query.
    limit: limit + 1,
    with: {
      component: { with: { app: true } },
      deploys: {
        orderBy: (deploys, { desc }) => [desc(deploys.id)],
        limit: 1,
      },
    },
  });
  const now = context.clock.now();
  const page = rows.slice(0, limit);

  return ok({
    builds: page.map(
      (row): BuildListItem => ({
        id: row.id,
        appId: row.component.app.id,
        app: row.component.app.name,
        componentId: row.component.id,
        component: row.component.name,
        commit: row.commit,
        targetShape: row.targetShape,
        artifactType: row.artifactType,
        artifactDigest: row.artifactDigest,
        status: row.status,
        runner: row.runner,
        when: elapsedSince(row.createdAt, now),
        at: row.createdAt.toISOString(),
        deployId: row.deploys[0]?.id ?? null,
      }),
    ),
    nextBefore: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  });
};
