/**
 * `listSources` — every immutable source this installation has staged (§4, §15).
 *
 * A Source is a noun, not a screen section. §15 stages **one immutable bundle**
 * per source before any route sees it, and §16 joins the source receipt and the
 * provenance document on its digest — so the staged digest is the identity the
 * whole supply chain hangs from, and it is the left-hand term of
 * *Source + Build = Artifact*.
 *
 * **One row per digest, not per Build.** The same staged bytes are dispatched
 * once per target shape, so a per-Build listing reported the same source twice
 * and called each half a bundle. Grouping on the digest is what makes the row
 * mean the thing it is named after; `builds` counts how many Builds were
 * dispatched from it.
 *
 * **A Source is derived rather than stored.** `builds.bundle_digest` and its
 * siblings are where staging already writes, and that column is also the
 * `externalParameters.bundleDigest` a SLSA provenance document is verified
 * against — the wire name stays as it is, and the operator-facing noun does
 * not. `source_bundles` is not that table: it is the commit → bundle index
 * `src/storage/bundle-cache.ts` reads, a hint about what the depot holds that
 * carries no App, no Component and no Build, and is allowed to be wrong. The
 * ledger below is still what was actually built, derived from the Builds that
 * were dispatched.
 *
 * `supplied` is derived from what happened rather than from what was declared:
 * a Build that reached `SUCCEEDED` with no `runner` is a Build no route ran,
 * which is exactly §4's supplied artifact — an archive of finished output. That
 * is the one Source that is also an Artifact, and reading the App's declared
 * archive contents instead would report it on the strength of a claim made
 * before anything was staged.
 *
 * Retention follows the source kind, per `source-bundle.ts`: an upload is
 * durable and a repository fetch is ephemeral. It is the fact that decides
 * whether the location on a row still resolves. Nothing here fetches it — a
 * listing that asked Cloud Storage per row would be a screen slow in proportion
 * to how much has ever been staged.
 */
import { desc, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { builds } from '../../db/schema.ts';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { type Command, ok } from '../types.ts';

/** How many Sources a listing answers with before it is a data-export problem. */
export const SOURCE_PAGE = 50;

export const listSourcesInput = z
  .object({
    limit: z.number().int().positive().max(SOURCE_PAGE).optional(),
  })
  .strict();

export type ListSourcesInput = z.infer<typeof listSourcesInput>;

/** Whether a Source survives the Build it was staged for. */
export type SourceRetention = 'durable' | 'ephemeral';

/** One staged source, as the Sources ledger reads it. */
export interface SourceView {
  /** §16's join: the digest over the exact staged bytes. */
  readonly digest: string;
  readonly origin: 'repo' | 'upload';
  /** The repository it was fetched from, or `null` for an upload. */
  readonly repository: string | null;
  /** The exact commit staged, or `null` for an upload. */
  readonly commit: string | null;
  /** Where it is fetched from, or `null` for a Build that recorded none. */
  readonly location: string | null;
  /** Whether any build route could actually be handed that location. */
  readonly fetchable: boolean;
  readonly retention: SourceRetention;
  readonly app: string;
  readonly component: string;
  /** How many Builds were dispatched from these exact bytes. */
  readonly builds: number;
  /** The newest of them, which is where a reader goes next. */
  readonly latestBuildId: number;
  /**
   * §4's supplied artifact: finished output recorded with no builder, and so
   * the one Source that is also an Artifact.
   */
  readonly supplied: boolean;
  readonly at: string;
}

export interface ListSourcesResult {
  readonly sources: readonly SourceView[];
  /** What the page is capped at, so a full page reads as one rather than as all. */
  readonly limit: number;
}

export const listSources: Command<ListSourcesInput, ListSourcesResult> = async (
  input,
  context,
) => {
  const limit = input.limit ?? SOURCE_PAGE;

  // Grouped first, then the rows: the page has to be a page of *digests*, and
  // taking the newest N Builds and collapsing them afterwards would answer with
  // fewer Sources than were asked for whenever one was built twice.
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
          // Non-null by the predicate above; the column is nullable for Builds
          // that have staged nothing, and those are precisely what is filtered.
          digest: group.digest ?? '',
          origin: isRepo ? ('repo' as const) : ('upload' as const),
          repository: app.sourceRepoUrl,
          commit: isRepo ? row.commit : null,
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
