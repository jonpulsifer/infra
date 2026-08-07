/**
 * `useSourceBucket` — stage sources to this bucket, and optionally to it first.
 *
 * §4 stages an uploaded archive and a repository's source in a first-party
 * bucket before any builder can fetch it, and §20 puts the list of those
 * buckets in the installation manifest. Between those two facts there was no
 * act: the creation flow rendered `sources.buckets` as a `<select>` with a
 * "Custom bucket…" option, which let a developer type a bucket that was not
 * declared anywhere and stage a build into it. That is configuration entered
 * on a deploy form, which is the shape §20 exists to prevent.
 *
 * So adding a bucket is its own act, and it is one act rather than two:
 * *stage to this bucket*, and optionally *stage to it first*. Naming an
 * already-declared bucket with `makeDefault` is how the default moves, which
 * is why this is not called `addSourceBucket` — the add is idempotent and the
 * interesting half is often the other one.
 *
 * **It verifies before it writes.** A bucket the controller cannot write to is
 * not a configuration mistake that shows up in configuration; it is a build
 * that dies at staging, minutes later, with a message about a signed URL. The
 * check is the same `testBucketPermissions` runs, and refusing here costs the
 * operator one sentence instead of one failed deploy.
 *
 * **Named cost, inherited from `configureInstallation`:** the manifest has no
 * revision column, so this read-modify-write loses a concurrent edit whole.
 * That comment is not copied here to be waved at — it is the reason this
 * command changes exactly two keys and validates the whole document on the way
 * back out, so the edit it might lose is always somebody else's *other* key
 * rather than a document this act half-rewrote.
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  sharedServicesOf,
} from '../../config/manifest.schema.ts';
import { ManifestError, validateManifest } from '../../config/manifest.ts';
import {
  governedSliceRefusal,
  readStoredManifest,
  writeStoredManifest,
} from '../../config/manifest-store.ts';
import { testGcsBucketPermissions } from '../../storage/cloud.ts';
import { type Command, failed, ok } from '../types.ts';

export const useSourceBucketInput = z
  .object({
    /**
     * A Cloud Storage bucket name, in Cloud Storage's own terms.
     *
     * Checked here rather than left to the far side because the far side's
     * refusal for a malformed name is a `404` that reads identically to a
     * bucket somebody else owns, and those two want different sentences.
     */
    bucketName: z
      .string()
      .trim()
      .min(3)
      .max(222)
      .regex(
        /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/,
        'must be a Cloud Storage bucket name: lowercase letters, digits, dots, hyphens and underscores',
      ),
    /** Whether this becomes the bucket a new staging picks by default. */
    makeDefault: z.boolean().default(false),
  })
  .strict();

export type UseSourceBucketInput = z.infer<typeof useSourceBucketInput>;

export interface UseSourceBucketResult {
  readonly buckets: readonly string[];
  readonly defaultBucket: string;
  /** Where the bucket lives, as the far side reported it. */
  readonly location: string;
  /** What the controller's federated identity may do there. */
  readonly permissions: readonly string[];
}

export const useSourceBucket: Command<
  UseSourceBucketInput,
  UseSourceBucketResult
> = async (input, context) => {
  const federation = context.manifest.cloud.federation;
  if (!federation) {
    return failed(
      'NOT_DEPLOYABLE',
      'Workload Identity Federation is not configured for this installation, so Spindrift cannot reach a bucket to check it',
    );
  }

  let verified: Awaited<ReturnType<typeof testGcsBucketPermissions>>;
  try {
    verified = await testGcsBucketPermissions({
      bucketName: input.bucketName,
      federation,
    });
  } catch (cause) {
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift cannot stage sources to ${input.bucketName}: ${
        cause instanceof Error ? cause.message : 'the permission check failed'
      }`,
    );
  }

  if (!verified.accessible) {
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift reached ${input.bucketName} but cannot write to it. Grant the controller's federated identity object create and read on the bucket.`,
    );
  }

  const stored = await readStoredManifest(context.db);
  if (stored === null) {
    return failed(
      'NOT_FOUND',
      'this installation has no stored manifest to add a bucket to',
    );
  }

  const buckets = stored.sources.buckets.includes(input.bucketName)
    ? stored.sources.buckets
    : [...stored.sources.buckets, input.bucketName];
  // Which bucket a staging picks is a property of the home vessel, so making
  // one the default is a write to that vessel rather than to `sources`. The
  // list and the choice therefore move in one document, which is what keeps a
  // default that is not among the buckets unrepresentable.
  const shared = sharedServicesOf(stored);
  const sourceBucket = input.makeDefault
    ? input.bucketName
    : shared.sourceBucket;

  const next: AuthoredManifest = {
    ...stored,
    sources: { ...stored.sources, buckets },
    vessels: stored.vessels.map((vessel) =>
      vessel.name === stored.installation.homeVessel
        ? { ...vessel, shared: { ...shared, sourceBucket } }
        : vessel,
    ),
  };

  let updated: AuthoredManifest;
  try {
    // Validated on the way out even though only two keys moved: the document
    // that gets written is the one that has to be valid, and a stored manifest
    // that was already drifting from the schema must not be made durable again
    // by an act that never looked at the rest of it.
    updated = validateManifest(next, 'the updated manifest');
  } catch (cause) {
    if (cause instanceof ManifestError) {
      return failed('NOT_DEPLOYABLE', cause.message);
    }
    throw cause;
  }

  // Which bucket a staging picks is the home vessel's, and an installation that
  // mounts a declaration takes that vessel from it on every boot. Making a
  // default here would then leave the added bucket standing and the choice
  // reverted — an act half-applied, with nothing on screen saying which half.
  // Refused whole rather than half-applied: adding without choosing is the
  // other arm of this same command, and it is still open.
  const governed = governedSliceRefusal(updated, context.declaration);
  if (governed !== null) {
    return failed('NOT_DEPLOYABLE', governed);
  }

  await writeStoredManifest(context.db, updated);

  return ok({
    buckets,
    defaultBucket: sourceBucket,
    location: verified.location,
    permissions: verified.permissions,
  });
};
