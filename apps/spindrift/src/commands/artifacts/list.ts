/**
 * `listArtifacts`: Builds that recorded an artifact digest, newest first, with
 * how many Deploys placed each. Uploaded finished output is marked `supplied`.
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

export interface ArtifactView {
  readonly digest: string;
  readonly type: string;
  /** Every registry address the same digest was pushed to. */
  readonly refs: readonly string[];
  readonly app: string;
  readonly component: string;
  readonly buildId: number;
  /** The source bundle's digest, or `null` where none was recorded. */
  readonly sourceDigest: string | null;
  readonly commit: string;
  /** The SLSA build level core verified, or `null` where it verified none. */
  readonly provenanceLevel: number | null;
  /** Whether core's own cosign signature is recorded. */
  readonly signed: boolean;
  /** Uploaded finished output that no builder ran over. */
  readonly supplied: boolean;
  readonly deploys: number;
  readonly at: string;
}

export interface ListArtifactsResult {
  readonly artifacts: readonly ArtifactView[];
  /** The cap, so a caller can tell a full page from the full list. */
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
