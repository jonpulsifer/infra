/**
 * `listSourceBuckets` lists the manifest's source buckets and the default one.
 */
import { z } from 'zod';
import { sharedServicesOf } from '../../config/manifest.schema.ts';
import { type Command, ok } from '../types.ts';

export const listSourceBucketsInput = z.object({}).strict();

export type ListSourceBucketsInput = z.infer<typeof listSourceBucketsInput>;

export interface ListSourceBucketsResult {
  readonly buckets: readonly string[];
  /** The home vessel's `shared.sourceBucket`, which staging uses. */
  readonly defaultBucket: string;
  /** False without workload identity federation, which a bucket check needs. */
  readonly canVerify: boolean;
}

export const listSourceBuckets: Command<
  ListSourceBucketsInput,
  ListSourceBucketsResult
> = async (_input, context) => {
  return ok({
    buckets: context.manifest.sources.buckets,
    defaultBucket: sharedServicesOf(context.manifest).sourceBucket,
    canVerify: context.manifest.cloud.federation !== null,
  });
};
