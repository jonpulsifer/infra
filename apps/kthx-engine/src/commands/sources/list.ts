/**
 * `listSources` lists every staged source bundle, one row per digest, derived
 * from the Builds dispatched from it. `source_bundles` is a cache index that is
 * allowed to be wrong, so it is not read.
 */
import { desc, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { builds } from '../../db/schema.ts';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { type Command, ok } from '../types.ts';

/** The most Sources one listing returns; past that is a data export. */
export const SOURCE_PAGE = 50;

export const listSourcesInput = z
  .object({
    limit: z.number().int().positive().max(SOURCE_PAGE).optional(),
  })
  .strict();

export type ListSourcesInput = z.infer<typeof listSourcesInput>;

/** Whether a Source survives the Build it was staged for. */
export type SourceRetention = 'durable' | 'ephemeral';

export interface SourceView {
  /** Over the exact staged bytes; provenance joins on it. */
  readonly digest: string;
  readonly origin: 'repo' | 'upload';
  /** The repository it was fetched from, or `null` for an upload. */
  readonly repository: string | null;
  /** The exact commit staged, or `null` for an upload. */
  readonly commit: string | null;
  /** The commit's headline, author and time, where the Build kept them. */
  readonly commitMessage: string | null;
  readonly commitAuthor: string | null;
  readonly commitAuthoredAt: string | null;
  /** Where it is fetched from, or `null` for a Build that recorded none. */
  readonly location: string | null;
  /** Whether any build route could actually be handed that location. */
  readonly fetchable: boolean;
  readonly retention: SourceRetention;
  readonly app: string;
  readonly component: string;
  /** How many Builds were dispatched from these exact bytes. */
  readonly builds: number;
  readonly latestBuildId: number;
  /**
   * Finished output recorded with no builder: the one Source that is also an
   * Artifact.
   */
  readonly supplied: boolean;
  readonly at: string;
}

export interface ListSourcesResult {
  readonly sources: readonly SourceView[];
  /** The page cap, so a full page does not read as everything. */
  readonly limit: number;
}

export const listSources: Command<ListSourcesInput, ListSourcesResult> = async (
  input,
  context,
) => {
  const limit = input.limit ?? SOURCE_PAGE;

  // Grouped before the limit: limiting Builds first would return fewer Sources
  // than asked whenever one digest was built twice.
  const grouped = await context.db
    .select({
      digest: builds.bundleDigest,
      latestBuildId: sql<number>`max(${builds.id})::int`,
      builds: sql<number>`count(*)::int`,
    })
    .from(builds)
    .where(isNotNull(builds.bundleDigest))
    .groupBy(builds.bundleDigest)
    .orderBy(desc(sql`max(${builds.id})`))
    .limit(limit);

  if (grouped.length === 0) return ok({ sources: [], limit });

  const rows = await context.db.query.builds.findMany({
    where: (build, { inArray }) =>
      inArray(
        build.id,
        grouped.map((one) => one.latestBuildId),
      ),
    with: { component: { with: { app: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ok({
    limit,
    sources: grouped.flatMap((group) => {
      const row = byId.get(group.latestBuildId);
      if (row === undefined) return [];
      const app = row.component.app;
      const isRepo = app.sourceKind === 'repo';
      return [
        {
          // Never null: the query filters null digests.
          digest: group.digest ?? '',
          origin: isRepo ? ('repo' as const) : ('upload' as const),
          repository: app.sourceRepoUrl,
          commit: isRepo ? row.commit : null,
          commitMessage: isRepo ? row.commitMessage : null,
          commitAuthor: isRepo ? row.commitAuthor : null,
          commitAuthoredAt: isRepo
            ? (row.commitAuthoredAt?.toISOString() ?? null)
            : null,
          location: row.bundleLocation,
          fetchable: isFetchableBundleLocation(row.bundleLocation),
          retention: isRepo ? ('ephemeral' as const) : ('durable' as const),
          app: app.name,
          component: row.component.name,
          builds: group.builds,
          latestBuildId: group.latestBuildId,
          supplied: row.status === 'SUCCEEDED' && row.runner === null,
          at: row.createdAt.toISOString(),
        },
      ];
    }),
  });
};
