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
}

export const listSourceBuckets: Command<
  ListSourceBucketsInput,
  ListSourceBucketsResult
> = async (_input, context) => {
  const { buckets, defaultBucket } = context.manifest.sources;
  return ok({
    buckets,
    defaultBucket: defaultBucket ?? buckets[0] ?? '',
  });
};
