/**
 * `useSourceBucket`: add a bucket that sources stage to, and optionally make it
 * the default. The bucket must prove writable before the manifest changes.
 */
import { z } from 'zod';
import {
  type AuthoredManifest,
  sharedServicesOf,
} from '../../config/manifest.schema.ts';
import { ManifestError, validateManifest } from '../../config/manifest.ts';
import {
  readStoredManifest,
  writeStoredManifest,
} from '../../config/manifest-store.ts';
import { testGcsBucketPermissions } from '../../storage/cloud.ts';
import { type Command, failed, ok } from '../types.ts';

export const useSourceBucketInput = z
  .object({
    /**
     * Validated here because Cloud Storage answers a malformed name with the
     * same 404 as a bucket owned by someone else.
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
    makeDefault: z.boolean().default(false),
  })
  .strict();

export type UseSourceBucketInput = z.infer<typeof useSourceBucketInput>;

export interface UseSourceBucketResult {
  readonly buckets: readonly string[];
  readonly defaultBucket: string;
  readonly location: string;
  /** What the controller's federated identity may do on the bucket. */
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
  // The default bucket is a setting on the home vessel.
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
    // Last write wins, since the stored manifest has no revision. Validating the
    // whole document keeps an already invalid one from being rewritten.
    updated = validateManifest(next, 'the updated manifest');
  } catch (cause) {
    if (cause instanceof ManifestError) {
      return failed('NOT_DEPLOYABLE', cause.message);
    }
    throw cause;
  }

  await writeStoredManifest(context.db, updated);

  return ok({
    buckets,
    defaultBucket: sourceBucket,
    location: verified.location,
    permissions: verified.permissions,
  });
};
