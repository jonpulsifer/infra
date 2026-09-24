/**
 * The commit to bundle index. A hit counts only once the depot confirms the
 * object, and nothing here throws: any miss falls through to a fresh fetch.
 * GCS `age` counts from object creation, so only a rewrite would extend a hot
 * bundle's life, and a hit does not rewrite.
 */

import { gcsObjectExists, parseGcsLocation } from '@repo/archive/gcs';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { sourceBundles } from '../db/schema.ts';
import type { StagedSourceBundle } from '../domain/source-bundle.ts';
import type { SourceDepot } from './archives.ts';

export async function cachedBundle(
  db: Database,
  depot: SourceDepot,
  repository: string,
  commit: string,
): Promise<StagedSourceBundle | null> {
  try {
    const [row] = await db
      .select({
        digest: sourceBundles.digest,
        location: sourceBundles.location,
        commitMessage: sourceBundles.commitMessage,
        commitAuthor: sourceBundles.commitAuthor,
        commitAuthoredAt: sourceBundles.commitAuthoredAt,
      })
      .from(sourceBundles)
      .where(
        and(
          eq(sourceBundles.repository, repository),
          eq(sourceBundles.commit, commit),
        ),
      )
      .limit(1);
    if (row === undefined) return null;

    const object = parseGcsLocation(row.location);
    // A row from a previous bucket is a miss: builders get the depot's own.
    if (object === null || object.bucket !== depot.bucket) return null;

    const present = await gcsObjectExists({
      bucketName: object.bucket,
      objectName: object.object,
      federation: depot.federation,
    });
    if (!present) return null;

    // All three null means the row never recorded a headline, not a blank one.
    const headline =
      row.commitMessage === null &&
      row.commitAuthor === null &&
      row.commitAuthoredAt === null
        ? {}
        : {
            commit: {
              message: row.commitMessage,
              author: row.commitAuthor,
              authoredAt: row.commitAuthoredAt,
            },
          };
    return {
      digest: row.digest,
      location: row.location,
      // Every repository bundle is ephemeral, cached or freshly fetched.
      retention: 'ephemeral',
      ...headline,
    };
  } catch {
    return null;
  }
}

export async function rememberBundle(
  db: Database,
  repository: string,
  commit: string,
  bundle: StagedSourceBundle,
  stagedAt: Date,
): Promise<void> {
  try {
    await db
      .insert(sourceBundles)
      .values({
        repository,
        commit,
        digest: bundle.digest,
        location: bundle.location,
        stagedAt,
        commitMessage: bundle.commit?.message ?? null,
        commitAuthor: bundle.commit?.author ?? null,
        commitAuthoredAt: bundle.commit?.authoredAt ?? null,
      })
      // Re-staging refreshes `staged_at`, which operators read as freshness.
      .onConflictDoUpdate({
        target: [sourceBundles.repository, sourceBundles.commit],
        set: {
          digest: sql`excluded.digest`,
          location: sql`excluded.location`,
          stagedAt: sql`excluded.staged_at`,
          commitMessage: sql`excluded.commit_message`,
          commitAuthor: sql`excluded.commit_author`,
          commitAuthoredAt: sql`excluded.commit_authored_at`,
        },
      });
  } catch {
    // Best-effort: an unindexed bundle only costs the next deploy a fetch.
  }
}
