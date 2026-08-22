/**
 * The commit → bundle index, and the one rule that makes it safe (§15).
 *
 * **The index is a hint; the depot is the truth.** Every hit is verified
 * against Cloud Storage before it is returned, and a miss — a row that was
 * never written, an object the bucket's `ephemeral/` lifecycle rule expired, a
 * depot that has since moved to another bucket, a far side having a bad
 * minute — falls through to the fetch that used to happen unconditionally.
 * That is the whole safety argument: the worst this can do is behave exactly
 * like the code it replaces.
 *
 * Which is why nothing here throws. A cache that can fail a deploy is a
 * liability, not an optimization, so the read swallows what it cannot answer
 * and the write is best-effort. `stageSourceBundle` is still the only thing
 * allowed to refuse a source.
 *
 * **No re-touch, deliberately.** A GCS `age` condition counts from the
 * generation's creation time, so keeping a hot bundle alive past 30 days would
 * mean rewriting the object on every hit — paying the write this exists to
 * avoid, to defer a re-fetch that costs exactly what today costs. The bundle
 * expires, the next stage writes it again, and the cache is cold for one
 * deploy. That is the retention policy working rather than a race against it.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { sourceBundles } from '../db/schema.ts';
import type { StagedSourceBundle } from '../domain/source-bundle.ts';
import type { SourceDepot } from './archives.ts';
import { gcsObjectExists } from './cloud.ts';

/** The `(bucket, object)` a `gs://` location names, or `null` if it names none. */
function gcsObject(
  location: string,
): { bucket: string; object: string } | null {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(location);
  if (match === null) return null;
  return { bucket: match[1] as string, object: match[2] as string };
}

/**
 * The bundle already staged for this commit, if the depot still holds it.
 *
 * The bucket on the row must be the depot's own. An installation that moved
 * `sources.buckets` has rows pointing at objects this process may not even be
 * able to read, and confirming one would hand a builder a location outside the
 * bucket the manifest says it stages to — §20's whole point.
 */
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

    const object = gcsObject(row.location);
    if (object === null || object.bucket !== depot.bucket) return null;

    const present = await gcsObjectExists({
      bucketName: object.bucket,
      objectName: object.object,
      federation: depot.federation,
    });
    if (!present) return null;

    return {
      digest: row.digest,
      location: row.location,
      // §15: a repository bundle is ephemeral whether it was fetched a second
      // ago or read back from here. The retention is a property of the object,
      // not of how this call found it.
      retention: 'ephemeral',
    };
  } catch {
    return null;
  }
}

/** Record what was staged, so the next commit that wants it can find it. */
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
      })
      // The same commit re-staged writes the same content-addressed object, so
      // the conflicting row is not stale — but `staged_at` is, and it is the
      // only thing here an operator reads to judge how fresh the copy is.
      .onConflictDoUpdate({
        target: [sourceBundles.repository, sourceBundles.commit],
        set: {
          digest: sql`excluded.digest`,
          location: sql`excluded.location`,
          stagedAt: sql`excluded.staged_at`,
        },
      });
  } catch {
    // A bundle that staged but did not index is a slow next deploy, not a
    // failed one. Losing the Build over a bookkeeping write would invert that.
  }
}
