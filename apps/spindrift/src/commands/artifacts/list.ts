/**
 * `listArtifacts` — what the Builds produced, as its own noun (§4, §16).
 *
 * The right-hand term of *Source + Build = Artifact* and the left-hand term of
 * *Artifact + Config = Deploy*. A Build is the act and carries a status, a
 * runner and a log; an Artifact is the immutable thing that act left behind,
 * and it is what a Deploy actually places. One Build → one Artifact → many
 * Deploys (§2), which is what makes rollback-without-rebuild possible and what
 * makes this listing different from the Builds ledger rather than a second view
 * of it.
 *
 * **A row exists once there is a digest**, which is also how §4's supplied
 * artifact appears here: an uploaded archive of finished output is recorded
 * with the staged digest and no route ever ran, so it is an Artifact with no
 * Build behind it. `supplied` marks it rather than hiding it.
 *
 * `deploys` is the count of placements, because the question an Artifact
 * ledger is opened to answer is which of these is actually running somewhere.
 * It is one grouped query over the page rather than one per row.
 *
 * Provenance is reported as the normalized level core verified plus whether
 * core signed it — the full envelope lives on the Build, where the evidence
 * that produced it is.
 */
import { count, desc, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { deploys } from '../../db/schema.ts';
import { type Command, ok } from '../types.ts';

/** How many Artifacts a listing answers with before it is a data-export problem. */
export const ARTIFACT_PAGE = 50;

export const listArtifactsInput = z
  .object({
    limit: z.number().int().positive().max(ARTIFACT_PAGE).optional(),
  })
  .strict();

export type ListArtifactsInput = z.infer<typeof listArtifactsInput>;

/** One built artifact, as the Artifacts ledger reads it. */
export interface ArtifactView {
  readonly digest: string;
  readonly type: string;
  /** Every registry address the same digest was pushed to. */
  readonly refs: readonly string[];
  readonly app: string;
  readonly component: string;
  /** The Build that produced it — the act behind the noun. */
  readonly buildId: number;
  /** The Source it was built from, or `null` where none was recorded. */
  readonly sourceDigest: string | null;
  readonly commit: string;
  /** The concrete SLSA level core verified, or `null` where it verified none. */
  readonly provenanceLevel: number | null;
  /** Whether core's own cosign record exists (§16). */
  readonly signed: boolean;
  /** §4's supplied artifact: finished output no builder ran over. */
  readonly supplied: boolean;
  /** How many Deploys have placed it. */
  readonly deploys: number;
  readonly at: string;
}

export interface ListArtifactsResult {
  readonly artifacts: readonly ArtifactView[];
  /** What the page is capped at, so a full page reads as one rather than as all. */
  readonly limit: number;
}

export const listArtifacts: Command<
  ListArtifactsInput,
  ListArtifactsResult
> = async (input, context) => {
  const limit = input.limit ?? ARTIFACT_PAGE;
  const rows = await context.db.query.builds.findMany({
    where: (build) => isNotNull(build.artifactDigest),
    orderBy: (build, { desc: newestFirst }) => [newestFirst(build.id)],
    limit,
    with: { component: { with: { app: true } } },
  });

  if (rows.length === 0) return ok({ artifacts: [], limit });

  const placements = await context.db
    .select({ buildId: deploys.buildId, placements: count() })
    .from(deploys)
    .where(
      inArray(
        deploys.buildId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(deploys.buildId)
    .orderBy(desc(deploys.buildId));
  const placedBy = new Map(
    placements.map((one) => [one.buildId, one.placements]),
  );

  return ok({
    limit,
    artifacts: rows.map((row) => ({
      // Non-null by the predicate above.
      digest: row.artifactDigest ?? '',
      type: row.artifactType,
      refs: row.artifactRefs ?? [],
      app: row.component.app.name,
      component: row.component.name,
      buildId: row.id,
      sourceDigest: row.bundleDigest,
      commit: row.commit,
      provenanceLevel: row.verifiedBuildLevel,
      signed: row.signature !== null,
      supplied: row.status === 'SUCCEEDED' && row.runner === null,
      deploys: placedBy.get(row.id) ?? 0,
      at: row.createdAt.toISOString(),
    })),
  });
};
