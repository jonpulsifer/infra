/**
 * `listSourceBuckets` — list first-party GCS buckets for archive sources and artifacts.
 */
import { z } from 'zod';
import { type Command, ok } from '../types.ts';

export const listSourceBucketsInput = z.object({}).strict();

export type ListSourceBucketsInput = z.infer<typeof listSourceBucketsInput>;

export interface ListSourceBucketsResult {
  readonly buckets: readonly string[];
  readonly defaultBucket: string;
  /**
   * Whether this installation can reach a bucket to check one at all (§13).
   *
   * Stated rather than discovered by a failed check: without Workload Identity
   * Federation there is no identity to ask Cloud Storage about, so a Verify
   * button would be a button that can only ever report the same configuration
   * fact. The screen says it once, up front, instead.
   */
  readonly canVerify: boolean;
}

export const listSourceBuckets: Command<
  ListSourceBucketsInput,
  ListSourceBucketsResult
> = async (_input, context) => {
  const { buckets, defaultBucket } = context.manifest.sources;
  return ok({
    buckets,
    defaultBucket: defaultBucket ?? buckets[0] ?? '',
    canVerify: context.manifest.cloud.federation !== null,
  });
};
