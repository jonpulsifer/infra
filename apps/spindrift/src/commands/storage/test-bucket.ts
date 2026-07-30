/**
 * `testBucketPermissions` — verify credential-less WIF permissions to a Cloud Storage bucket (§13).
 */
import { z } from 'zod';
import { testGcsBucketPermissions } from '../../storage/cloud.ts';
import { type Command, failed, ok } from '../types.ts';

export const testBucketPermissionsInput = z
  .object({
    bucketName: z.string().trim().min(1, 'bucket name is required'),
  })
  .strict();

export type TestBucketPermissionsInput = z.infer<
  typeof testBucketPermissionsInput
>;

export interface TestBucketPermissionsResult {
  readonly bucketName: string;
  readonly accessible: boolean;
  readonly location: string;
  readonly permissions: readonly string[];
}

export const testBucketPermissions: Command<
  TestBucketPermissionsInput,
  TestBucketPermissionsResult
> = async (input, context) => {
  const federation = context.manifest.cloud.federation;
  if (!federation) {
    return failed(
      'NOT_DEPLOYABLE',
      'Workload Identity Federation (WIF) is not configured in the installation manifest',
    );
  }

  try {
    const result = await testGcsBucketPermissions({
      bucketName: input.bucketName,
      federation,
    });
    return ok(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : 'Cloud Storage permission check failed';
    return failed('NOT_DEPLOYABLE', message);
  }
};
